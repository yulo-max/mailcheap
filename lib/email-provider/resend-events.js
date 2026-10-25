import crypto from "node:crypto";
import { isObjectIdString, isPlainObject, normalizeAddress } from "../validation.js";

// Resend signs each delivery the Svix way: base64 HMAC-SHA256 of "{id}.{timestamp}.{body}", keyed with the
// webhook secret (whsec_ plus the base64 key). The header can carry more than one v1 signature. An old
// timestamp is a replay; Resend retries a delivery with the same svix-id.
export const MAX_SIGNATURE_AGE_SECONDS = 300;

const UNDELIVERABLE_SUBTYPES = new Set(["noemail", "suppressed"]);

const EVENT_TYPES = {
	"email.sent": "sent",
	"email.delivered": "delivered",
	"email.delivery_delayed": "deferred",
	"email.bounced": "bounce",
	"email.complained": "complaint",
	"email.opened": "open",
	"email.clicked": "click",
	"email.failed": "dropped",
	"email.suppressed": "dropped",
};

function decodeSecret(secret) {
	const encoded = String(secret).trim().replace(/^whsec_/, "");
	if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
	const key = Buffer.from(encoded, "base64");
	return key.length > 0 ? key : null;
}

export function verifyResendSignature({ body, id, timestamp, signature, secret, now = Date.now() }) {
	if (!secret || typeof id !== "string" || !id || typeof timestamp !== "string" || !/^\d{1,12}$/.test(timestamp)) return false;
	if (typeof signature !== "string" || !signature.includes(",")) return false;
	if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > MAX_SIGNATURE_AGE_SECONDS) return false;
	const key = decodeSecret(secret);
	if (!key) return false;
	const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest();
	return signature.split(" ").some((part) => {
		const separator = part.indexOf(",");
		if (separator < 1) return false;
		const version = part.slice(0, separator);
		const value = part.slice(separator + 1);
		if (version !== "v1" || !value) return false;
		const given = Buffer.from(value, "base64");
		return given.length === expected.length && crypto.timingSafeEqual(given, expected);
	});
}

function readText(value) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null;
}

function readTag(tags, name) {
	if (!isPlainObject(tags) || typeof tags[name] !== "string") return null;
	return isObjectIdString(tags[name]) ? tags[name].toLowerCase() : null;
}

function readEmails(value) {
	const list = Array.isArray(value) ? value : [value];
	return [...new Set(list.map((item) => normalizeAddress(item)).filter(Boolean))];
}

function toDate(value) {
	const date = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
	return date && Number.isFinite(date.getTime()) ? date : null;
}

function readDiagnostics(value) {
	const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	return list.map((item) => readText(item)).filter(Boolean).join("; ") || null;
}

// email.bounced is a permanent rejection only when bounce.type says Permanent. Temporary is a delay that
// still arrived as a bounce, and it isn't the address's fault for good.
function applyBounce(event, bounce) {
	const type = readText(bounce.type) ?? "";
	const isHard = type.toLowerCase() === "permanent";
	const subType = readText(bounce.subType);
	const diagnostic = readDiagnostics(bounce.diagnosticCode);
	const reason = [subType, readText(bounce.message), diagnostic].filter(Boolean).join(", ");
	Object.assign(event, {
		bounce: isHard ? "hard" : "soft",
		undeliverable: isHard && UNDELIVERABLE_SUBTYPES.has(String(subType ?? "").toLowerCase()),
		reason: reason || null,
		detail: `${type || "bounce"}/${subType ?? "General"}`,
	});
}

// A failure after Resend accepted the email. A quota or a domain problem isn't the address. An address
// Resend already suppresses, or one the recipient server says doesn't exist, is.
function applyFailure(event, data) {
	const suppressed = isPlainObject(data.suppressed) ? data.suppressed : null;
	if (suppressed) {
		event.error = `Dropped by Resend: ${readText(suppressed.message) ?? readText(suppressed.type) ?? "suppressed"}`;
		event.suppressed = true;
		return;
	}
	const reason = readText(data.failed?.reason) ?? "unknown";
	if (/suppress/i.test(reason)) {
		event.error = `Dropped by Resend: ${reason}`;
		event.suppressed = true;
		return;
	}
	if (/invalid|does not exist|user unknown|mailbox unavailable|no such user/i.test(reason) && !/quota|not verified|domain/i.test(reason)) {
		event.type = "bounce";
		event.bounce = "hard";
		event.undeliverable = true;
		event.reason = reason;
		event.detail = `failed/${reason}`;
		return;
	}
	event.error = `Dropped by Resend: ${reason}`;
}

// Pure: one Resend webhook in the shape every provider's events take (lib/email-event-rules.js). The account
// and message come from the tags every send carries. eventId is the svix-id header, which a retry repeats.
export function normalizeResendEvent(payload, { eventId } = {}) {
	if (!isPlainObject(payload) || !Object.hasOwn(EVENT_TYPES, payload.type)) return null;
	const data = isPlainObject(payload.data) ? payload.data : {};
	const emails = readEmails(data.to);
	const event = {
		type: EVENT_TYPES[payload.type],
		recordAs: payload.type,
		accountId: readTag(data.tags, "account_id"),
		messageId: readTag(data.tags, "message_id"),
		providerMessageId: readText(data.email_id),
		providerEventId: readText(eventId),
		email: emails[0] ?? null,
		emails,
		occurredAt: (payload.type === "email.clicked" && toDate(data.click?.timestamp)) || toDate(payload.created_at) || toDate(data.created_at) || new Date(),
		data: payload,
	};
	if (payload.type === "email.bounced") applyBounce(event, isPlainObject(data.bounce) ? data.bounce : {});
	if (payload.type === "email.complained") event.detail = "abuse";
	if (payload.type === "email.clicked" && typeof data.click?.link === "string") event.link = data.click.link;
	if (payload.type === "email.failed" || payload.type === "email.suppressed") applyFailure(event, data);
	return event;
}
