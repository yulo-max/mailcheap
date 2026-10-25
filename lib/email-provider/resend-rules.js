import { SEND_OUTCOMES, providerError } from "./outcomes.js";

// Resend's default return path is send.<domain>. MailCheap asks for bounce.<domain>, the same prefix SES uses,
// so the archive page already refuses it. A domain that already existed at Resend keeps the path it was given.
export const RETURN_PATH_PREFIX = "bounce";

const RECORD_STATUSES = {
	verified: "SUCCESS",
	failed: "FAILED",
	failure: "FAILED",
	temporary_failure: "TEMPORARY_FAILURE",
	not_started: "NOT_STARTED",
	pending: "PENDING",
};

const TAG = /^[\w-]{1,256}$/;

const KEY_PROBLEMS = new Set(["missing_api_key", "restricted_api_key", "suspended_api_key", "invalid_api_key"]);

function recordStatus(status) {
	return RECORD_STATUSES[String(status ?? "").toLowerCase()] ?? "PENDING";
}

// FAILED wins, then a retry, then anything still waiting. All found, or all not started, say so.
function combinedStatus(statuses) {
	if (statuses.length === 0) return "PENDING";
	if (statuses.includes("FAILED")) return "FAILED";
	if (statuses.includes("TEMPORARY_FAILURE")) return "TEMPORARY_FAILURE";
	if (statuses.every((status) => status === "SUCCESS")) return "SUCCESS";
	if (statuses.every((status) => status === "NOT_STARTED")) return "NOT_STARTED";
	return "PENDING";
}

function hostName(recordName, domain) {
	const host = String(recordName ?? "")
		.trim()
		.replace(/\.$/, "")
		.toLowerCase();
	if (!host || host === "@") return domain;
	if (host === domain || host.endsWith(`.${domain}`)) return host;
	return `${host}.${domain}`;
}

// SPF records are the return path: the one MailCheap asked for, Resend's default, or the name whose r-prefixed
// sibling is the other record (Resend's CNAME pair).
function mailFromHost(records, domain) {
	const hosts = [...new Set(records.filter((record) => record.record === "SPF").map((record) => hostName(record.name, domain)))];
	if (hosts.length === 0) return null;
	const preferred = hosts.find((host) => host === `${RETURN_PATH_PREFIX}.${domain}`) ?? hosts.find((host) => host === `send.${domain}`);
	if (preferred) return preferred;
	const labels = hosts.map((host) => host.slice(0, -(domain.length + 1)));
	const label = labels.find((item) => labels.includes(`r${item}`)) ?? labels.find((item) => !item.startsWith("r")) ?? labels[0];
	return `${label}.${domain}`;
}

function recordValue(record) {
	const value = String(record.value ?? "").trim();
	if (!value) return null;
	if (String(record.type).toUpperCase() === "MX" && Number.isInteger(record.priority) && !/^\d+\s/.test(value)) return `${record.priority} ${value}`;
	return value;
}

// A Resend domain in the shape lib/domains.js stores: statuses in the SES words the Domains page already knows.
// Tracking records are left out: MailCheap's own links count clicks.
export function toDomainStatus(domain, name) {
	const source = Array.isArray(domain?.records) ? domain.records : [];
	const records = [];
	for (const record of source) {
		const purpose = record.record === "DKIM" ? "dkim" : record.record === "SPF" ? "mail-from" : null;
		const value = recordValue(record);
		if (!purpose || !value) continue;
		records.push({ purpose, type: String(record.type ?? "").toUpperCase(), name: hostName(record.name, name), value, status: recordStatus(record.status) });
	}
	const mailFromDomain = mailFromHost(source, name);
	return {
		verified: String(domain?.status ?? "").toLowerCase() === "verified",
		dkimStatus: combinedStatus(records.filter(({ purpose }) => purpose === "dkim").map(({ status }) => status)),
		mailFromStatus: combinedStatus(records.filter(({ purpose }) => purpose === "mail-from").map(({ status }) => status)),
		records: records.map(({ purpose, type, name: recordName, value }) => ({ purpose, type, name: recordName, value })),
		...(mailFromDomain && { mailFromDomain }),
	};
}

export function getMailFromDomain(domain) {
	return `${RETURN_PATH_PREFIX}.${domain}`;
}

// Tags come back on every webhook. Names and values are letters, digits, _ and - only.
export function getResendTags(message) {
	const tags = [
		{ name: "message_id", value: String(message._id) },
		{ name: "account_id", value: String(message.accountId) },
		{ name: "kind", value: String(message.kind ?? "") },
	];
	if (message.campaignId) tags.push({ name: "campaign_id", value: String(message.campaignId) });
	return tags.filter(({ name, value }) => TAG.test(name) && TAG.test(value));
}

export function buildResendEmail({ email, tags = [], feedbackId }) {
	const headers = { ...(email.headers ?? {}) };
	if (feedbackId) headers["Feedback-ID"] = feedbackId;
	const kept = Object.fromEntries(Object.entries(headers).filter(([, value]) => typeof value === "string" && value));
	return {
		from: email.from,
		to: [email.to],
		subject: email.subject,
		html: email.html,
		text: email.text,
		...(email.replyTo && { reply_to: email.replyTo }),
		...(Object.keys(kept).length > 0 && { headers: kept }),
		...(tags.length > 0 && { tags }),
	};
}

function textOf(error) {
	return `${error.providerCode ?? ""} ${error.detail ?? ""} ${error.message ?? ""}`;
}

function isUnverified(text) {
	return /not verified|verify a domain|verify your domain|only send testing emails/i.test(text);
}

// A failed send, as an outcome lib/sending-rules.js can retry, skip or pause on. A timed-out send is retried:
// its idempotency key means Resend won't send it twice.
export function getResendSendError(error) {
	const code = error.providerCode ?? "";
	const text = textOf(error);
	const fields = { providerCode: code || null };
	if (KEY_PROBLEMS.has(code) || error.status === 401) {
		return providerError(SEND_OUTCOMES.misconfigured, "Resend refused MailCheap's API key", fields);
	}
	if (!error.status) {
		const outcome = SEND_OUTCOMES.unavailable;
		const message = error.isTimeout ? "Resend didn't answer in time. The same email is sent again with its idempotency key" : error.message || "Resend didn't answer";
		return providerError(outcome, message, fields);
	}
	if (code === "daily_quota_exceeded" || /daily email sending quota/i.test(text)) {
		return providerError(SEND_OUTCOMES.throttled, "Resend's daily sending quota is used up. It resets at midnight UTC", { ...fields, retryAfter: 3600 });
	}
	if (code === "monthly_quota_exceeded" || /monthly email sending quota/i.test(text)) {
		return providerError(SEND_OUTCOMES.throttled, "Resend's monthly sending quota is used up", { ...fields, retryAfter: 3600 });
	}
	if (code === "rate_limit_exceeded" || error.status === 429) {
		return providerError(SEND_OUTCOMES.throttled, "Resend is limiting requests for now", { ...fields, retryAfter: error.retryAfter ?? 60 });
	}
	if (code === "concurrent_idempotent_requests") {
		return providerError(SEND_OUTCOMES.throttled, "Resend is still sending this email", { ...fields, retryAfter: 15 });
	}
	if (code === "invalid_idempotent_request") {
		return providerError(SEND_OUTCOMES.failed, "Resend already used this email's id for a different request", fields);
	}
	if (isUnverified(text)) return providerError(SEND_OUTCOMES.domainUnverified, "Resend hasn't verified the from domain yet", fields);
	if (/suppress/i.test(text)) return providerError(SEND_OUTCOMES.suppressed, "Resend suppresses this address", fields);
	if (error.status === 404) return providerError(SEND_OUTCOMES.misconfigured, "Resend couldn't find what MailCheap asked for", fields);
	if (error.status >= 500) return providerError(SEND_OUTCOMES.unavailable, "Resend couldn't take the email", fields);
	return providerError(SEND_OUTCOMES.failed, error.detail ? `Resend refused this email: ${error.detail}` : error.message, fields);
}
