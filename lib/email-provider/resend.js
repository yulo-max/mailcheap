import "server-only";
import { isSendingEnabled } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { RETURN_PATH_PREFIX, buildResendEmail, getMailFromDomain, getResendSendError, getResendTags, toDomainStatus } from "@/lib/email-provider/resend-rules";
import { createDomain, deleteDomain, getDomain, listDomains, sendResendEmail, verifyDomain } from "@/lib/resend";
import Account from "@/models/Account";

// The free plan allows about 2 requests a second. RESEND_SEND_RATE_PER_SECOND raises it once Resend does
// (1 to 100). A 429 still retries the batch.
function readSendRate() {
	const rate = Number.parseInt(process.env.RESEND_SEND_RATE_PER_SECOND ?? "", 10);
	return Number.isInteger(rate) && rate >= 1 && rate <= 100 ? rate : 2;
}

function getTenant(account) {
	return account?.resend?.provisionedAt ? account.resend : null;
}

// Resend has one account for the whole server, not a tenant per customer. This only marks the MailCheap
// account ready. Two checkouts can mark it at once: the one that finds it already marked keeps that.
async function provisionTenant(accountId) {
	await connectDb();
	const existing = await Account.findById(accountId).select({ resend: 1 }).lean();
	if (!existing) throw new Error("Account not found");
	if (existing.resend?.provisionedAt) return existing.resend;

	const now = new Date();
	const updated = await Account.findOneAndUpdate(
		{ _id: accountId, "resend.provisionedAt": null },
		{ $set: { "resend.provisionedAt": now, "resend.tenantStatus": "active", "resend.tenantStatusAt": now } },
		{ returnDocument: "after" }
	)
		.select({ resend: 1 })
		.lean();
	if (updated?.resend?.provisionedAt) return updated.resend;
	const account = await Account.findById(accountId).select({ resend: 1 }).lean();
	return account.resend;
}

async function ensureTenant(account) {
	return getTenant(account) ?? provisionTenant(account._id);
}

// Nothing to suspend at Resend. MailCheap's own block stops the account's sends.
async function suspendTenant() {}

async function resumeTenant() {
	return false;
}

function describeTenant(account) {
	const state = getTenant(account);
	return state ? { id: `mc-${account._id}`, status: state.tenantStatus ?? null, detail: null } : null;
}

// Domains are removed on their own. There is no tenant at Resend to delete.
async function removeTenant() {}

// A name Resend already has is a domain an earlier attempt, or MailCheap's own mail, created. The list is
// paged; a repeated page stops the walk.
async function listAllDomains() {
	const found = new Map();
	let after = "";
	for (let page = 0; page < 20; page++) {
		const query = new URLSearchParams({ limit: "100" });
		if (after) query.set("after", after);
		const body = await listDomains(query);
		const data = Array.isArray(body?.data) ? body.data : [];
		const before = found.size;
		for (const domain of data) if (domain?.id) found.set(domain.id, domain);
		if (!body?.has_more || data.length === 0 || found.size === before) break;
		after = data.at(-1).id;
	}
	return [...found.values()];
}

function isAlreadyRegistered(error) {
	return error.status === 403 && /has been registered already|already been registered|already exists/i.test(`${error.detail ?? ""} ${error.message ?? ""}`);
}

async function addDomain({ account, domain }) {
	await ensureTenant(account);
	try {
		const created = await createDomain({ name: domain, returnPath: RETURN_PATH_PREFIX });
		return { providerDomainId: created.id, status: toDomainStatus(created, domain) };
	} catch (error) {
		if (!isAlreadyRegistered(error)) throw error;
		const existing = (await listAllDomains()).find((item) => item.name?.toLowerCase() === domain.toLowerCase());
		if (!existing?.id) throw new Error(`${domain} is already registered in this Resend account, and it wasn't in the domains MailCheap could list`);
		return { providerDomainId: existing.id };
	}
}

async function readDomain({ domain, verify = false }) {
	if (!domain.providerDomainId) return { missing: true };
	try {
		if (verify) {
			try {
				await verifyDomain(domain.providerDomainId);
			} catch (error) {
				if (error.status === 404) return { missing: true };
				if (error.status !== 429) return { error: error.message };
			}
		}
		const found = await getDomain(domain.providerDomainId);
		return toDomainStatus(found, domain.domain);
	} catch (error) {
		if (error.status === 404) return { missing: true };
		return { error: error.message };
	}
}

function removeDomain({ domain }) {
	return domain.providerDomainId ? deleteDomain(domain.providerDomainId) : null;
}

function getSendLane() {
	return { name: "resend", rate: readSendRate() };
}

async function sendEmail({ tenant, message, email, feedbackId }) {
	if (!isSendingEnabled()) throw new Error("Sending is off (SENDING_ENABLED is not true)");
	if (!tenant?.provisionedAt) throw new Error("Resend isn't set up for this account yet");
	let result;
	try {
		result = await sendResendEmail({
			email: buildResendEmail({ email, tags: getResendTags(message), feedbackId }),
			idempotencyKey: String(message._id),
		});
	} catch (error) {
		if (error.name !== "ResendError") throw error;
		throw getResendSendError(error);
	}
	if (!result?.id || typeof result.id !== "string") throw new Error("Resend didn't return an email id");
	return { providerMessageId: result.id };
}

// Used when a self-hosted server's own emails go through the provider. With RESEND_API_KEY set, lib/platform-email.js
// sends them itself and doesn't reach this. Sign-in codes don't wait for SENDING_ENABLED.
async function sendPlatformEmail(email) {
	const result = await sendResendEmail({ email: buildResendEmail({ email, tags: [{ name: "kind", value: "platform" }] }) });
	if (!result?.id) throw new Error("Resend didn't return an email id");
}

function isConfigured() {
	return Boolean(String(process.env.RESEND_API_KEY ?? "").trim());
}

export const resendProvider = Object.freeze({
	id: "resend",
	name: "Resend",
	returnPathPrefix: RETURN_PATH_PREFIX,
	isConfigured,
	sendPlatformEmail,
	getTenant,
	provisionTenant,
	ensureTenant,
	suspendTenant,
	resumeTenant,
	describeTenant,
	removeTenant,
	getMailFromDomain,
	addDomain,
	readDomain,
	removeDomain,
	getSendLane,
	sendEmail,
});
