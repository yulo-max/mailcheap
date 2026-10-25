import "server-only";

// Every call to Resend lives in this file, like lib/ses.js holds every AWS call. Tests answer them with a
// mocked fetch. MailCheap's own emails (lib/platform-email.js) call the emails endpoint themselves; this
// client is readers' emails and their domains.
const API_URL = "https://api.resend.com";
const TIMEOUT_MS = 10_000;
// A send waits for Resend to accept the message. The idempotency key makes a retry of a timed-out send safe.
const SEND_TIMEOUT_MS = 20_000;

function getApiKey() {
	const key = String(process.env.RESEND_API_KEY ?? "").trim();
	if (!key) {
		throw Object.assign(new Error("Resend is not configured (RESEND_API_KEY)"), {
			name: "ResendError",
			status: null,
			providerCode: "missing_api_key",
			detail: "",
			retryAfter: null,
			isTimeout: false,
		});
	}
	return key;
}

function readRetryAfter(headers) {
	const seconds = Number.parseInt(headers?.get("retry-after") ?? "", 10);
	return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}

function describe(body) {
	if (typeof body === "string") return body.slice(0, 200);
	return typeof body?.message === "string" ? body.message.slice(0, 200) : "";
}

function resendError({ label, status = null, body = null, headers, cause }) {
	const providerCode = typeof body?.name === "string" ? body.name : null;
	const detail = describe(body);
	const answer = status ? `${status}${providerCode ? ` ${providerCode}` : ""}` : cause?.name === "TimeoutError" ? "timed out" : "no answer";
	return Object.assign(new Error(`Resend ${label}: ${answer}${detail ? ` (${detail})` : ""}`), {
		name: "ResendError",
		status,
		providerCode,
		detail,
		retryAfter: readRetryAfter(headers),
		isTimeout: cause?.name === "TimeoutError",
		cause,
	});
}

async function readBody(response) {
	if (response.status === 204) return null;
	const text = await response.text().catch(() => "");
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return text;
	}
}

async function call(path, { method = "GET", body, headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
	const label = `${method} ${path.split("?")[0]}`;
	let response;
	try {
		response = await fetch(`${API_URL}${path}`, {
			method,
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${getApiKey()}`,
				...(body !== undefined && { "Content-Type": "application/json" }),
				...headers,
			},
			...(body !== undefined && { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (cause) {
		throw resendError({ label, cause });
	}
	const data = await readBody(response);
	if (!response.ok) throw resendError({ label, status: response.status, body: data, headers: response.headers });
	return data;
}

export function createDomain({ name, returnPath }) {
	return call("/domains", {
		method: "POST",
		body: {
			name,
			custom_return_path: returnPath,
			// MailCheap counts opens and clicks itself. Resend's tracking would count them again.
			open_tracking: false,
			click_tracking: false,
			capabilities: { sending: "enabled", receiving: "disabled" },
		},
	});
}

export function listDomains(query) {
	const suffix = query?.toString() ? `?${query}` : "";
	return call(`/domains${suffix}`);
}

export function getDomain(id) {
	return call(`/domains/${encodeURIComponent(id)}`);
}

export function verifyDomain(id) {
	return call(`/domains/${encodeURIComponent(id)}/verify`, { method: "POST" });
}

export async function deleteDomain(id) {
	try {
		await call(`/domains/${encodeURIComponent(id)}`, { method: "DELETE" });
	} catch (error) {
		if (error.status !== 404) throw error;
	}
}

// Idempotency-Key is the message id: a retry of the same email, including one whose first answer never
// arrived, returns the first id and does not send it again (Resend keeps the key for 24 hours).
export function sendResendEmail({ email, idempotencyKey }) {
	return call("/emails", {
		method: "POST",
		body: email,
		timeoutMs: SEND_TIMEOUT_MS,
		...(idempotencyKey && { headers: { "Idempotency-Key": idempotencyKey } }),
	});
}
