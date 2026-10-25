import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { SEND_OUTCOMES } from "../lib/email-provider/outcomes.js";
import { buildResendEmail, getResendSendError, getResendTags, toDomainStatus } from "../lib/email-provider/resend-rules.js";
import { startTestApp, withEnv } from "./helpers/app.mjs";

const API = "https://api.resend.com";
const KEY = "re_test_provider";

test("a Resend domain becomes the DNS records the Domains page already shows", () => {
	const status = toDomainStatus(
		{
			status: "pending",
			records: [
				{ record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=abc", status: "not_started" },
				{ record: "SPF", name: "bounce", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10, status: "pending" },
				{ record: "SPF", name: "bounce", type: "TXT", value: "v=spf1 include:amazonses.com ~all", status: "temporary_failure" },
				{ record: "Tracking", name: "links", type: "CNAME", value: "links1.resend-dns.com", status: "not_started" },
			],
		},
		"letters.dev"
	);
	assert.equal(status.verified, false);
	assert.equal(status.dkimStatus, "NOT_STARTED");
	assert.equal(status.mailFromStatus, "TEMPORARY_FAILURE");
	assert.equal(status.mailFromDomain, "bounce.letters.dev");
	assert.deepEqual(
		status.records.map(({ purpose, type, name, value }) => ({ purpose, type, name, value })),
		[
			{ purpose: "dkim", type: "TXT", name: "resend._domainkey.letters.dev", value: "p=abc" },
			{ purpose: "mail-from", type: "MX", name: "bounce.letters.dev", value: "10 feedback-smtp.us-east-1.amazonses.com" },
			{ purpose: "mail-from", type: "TXT", name: "bounce.letters.dev", value: "v=spf1 include:amazonses.com ~all" },
		]
	);

	const reused = toDomainStatus(
		{
			status: "verified",
			records: [
				{ record: "DKIM", name: "resend._domainkey.letters.dev", type: "TXT", value: "p=abc", status: "verified" },
				{ record: "SPF", name: "outbound", type: "CNAME", value: "send.resend.test", status: "verified" },
				{ record: "SPF", name: "routbound", type: "CNAME", value: "track.resend.test", status: "failed" },
			],
		},
		"letters.dev"
	);
	assert.equal(reused.verified, true);
	assert.equal(reused.dkimStatus, "SUCCESS");
	assert.equal(reused.mailFromStatus, "FAILED", "one missing return-path record fails the pair");
	assert.equal(reused.mailFromDomain, "outbound.letters.dev", "the r-prefixed sibling is not the return path");
	assert.equal(toDomainStatus({ status: "partially_verified", records: [] }, "letters.dev").verified, false);
});

test("send errors become the same outcomes as the other providers, and a timeout can be retried", () => {
	const error = (fields) => Object.assign(new Error("Resend POST /emails"), { name: "ResendError", status: 400, detail: "", providerCode: null, ...fields });
	assert.equal(getResendSendError(error({ status: null, isTimeout: true })).outcome, SEND_OUTCOMES.unavailable);
	assert.match(getResendSendError(error({ status: null, isTimeout: true })).message, /idempotency key/);
	assert.equal(getResendSendError(error({ status: null, message: "Resend POST /emails: no answer" })).outcome, SEND_OUTCOMES.unavailable);
	const daily = getResendSendError(error({ status: 429, providerCode: "daily_quota_exceeded", detail: "You have exceeded your daily email sending quota." }));
	assert.deepEqual([daily.outcome, daily.retryAfter], [SEND_OUTCOMES.throttled, 3600]);
	assert.match(daily.message, /midnight UTC/);
	assert.equal(getResendSendError(error({ status: 429, providerCode: "monthly_quota_exceeded" })).outcome, SEND_OUTCOMES.throttled);
	assert.equal(getResendSendError(error({ status: 429, providerCode: "rate_limit_exceeded", retryAfter: 2 })).retryAfter, 2);
	assert.equal(getResendSendError(error({ status: 409, providerCode: "concurrent_idempotent_requests" })).outcome, SEND_OUTCOMES.throttled);
	assert.equal(getResendSendError(error({ status: 409, providerCode: "invalid_idempotent_request" })).outcome, SEND_OUTCOMES.failed);
	assert.equal(getResendSendError(error({ status: 403, providerCode: "validation_error", detail: "The letters.dev domain is not verified." })).outcome, SEND_OUTCOMES.domainUnverified);
	assert.equal(
		getResendSendError(error({ status: 403, providerCode: "validation_error", detail: "You can only send testing emails to your own email address." })).outcome,
		SEND_OUTCOMES.domainUnverified
	);
	assert.equal(getResendSendError(error({ status: 422, providerCode: "validation_error", detail: "This address is suppressed" })).outcome, SEND_OUTCOMES.suppressed);
	assert.equal(getResendSendError(error({ status: 401, providerCode: "missing_api_key" })).outcome, SEND_OUTCOMES.misconfigured);
	assert.equal(getResendSendError(error({ status: 403, providerCode: "suspended_api_key" })).outcome, SEND_OUTCOMES.misconfigured);
	assert.equal(getResendSendError(error({ status: 500, providerCode: "application_error" })).outcome, SEND_OUTCOMES.unavailable);
	assert.equal(getResendSendError(error({ status: 422, providerCode: "validation_error", detail: "Invalid `to` field." })).outcome, SEND_OUTCOMES.failed);
});

test("tags keep the account and the message, and drop a value Resend would refuse", () => {
	const message = { _id: "74f1a2b3c4d5e6f7a8b9c0d2", accountId: "64f1a2b3c4d5e6f7a8b9c0d1", kind: "last-chance", campaignId: "84f1a2b3c4d5e6f7a8b9c0d3" };
	assert.deepEqual(getResendTags(message), [
		{ name: "message_id", value: message._id },
		{ name: "account_id", value: message.accountId },
		{ name: "kind", value: "last-chance" },
		{ name: "campaign_id", value: message.campaignId },
	]);
	assert.deepEqual(getResendTags({ ...message, kind: "has a space" }).map(({ name }) => name), ["message_id", "account_id", "campaign_id"]);
	const body = buildResendEmail({
		email: { from: "Letters <hi@letters.dev>", to: "reader@example.com", subject: "Issue", html: "<p>Hi</p>", text: "Hi", replyTo: "hi@letters.dev", headers: { "List-Unsubscribe": "<https://letters.dev/unsub>" } },
		tags: getResendTags(message),
		feedbackId: "camp:mc-x:campaign:mailcheap",
	});
	assert.equal(body.headers["Feedback-ID"], "camp:mc-x:campaign:mailcheap");
	assert.equal(body.headers["List-Unsubscribe"], "<https://letters.dev/unsub>");
	assert.deepEqual(body.to, ["reader@example.com"]);
	assert.equal(body.reply_to, "hi@letters.dev");
});

describe("the Resend provider", () => {
	let app;
	let provider;
	let domainsApi;
	let Account;
	let account;
	const remote = new Map();
	const calls = [];
	let verifyStatus = 200;

	function stored(name) {
		return [...remote.values()].find((domain) => domain.name === name);
	}

	function installFake() {
		globalThis.fetch = async (input, init = {}) => {
			const url = new URL(String(input?.url ?? input));
			const method = init.method ?? "GET";
			assert.equal(url.origin, API);
			assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
			calls.push({ method, path: url.pathname, search: url.search, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
			if (method === "POST" && url.pathname === "/emails") {
				const to = init.body && JSON.parse(init.body).to?.[0];
				if (to === "quota@example.com") {
					return Response.json({ name: "daily_quota_exceeded", message: "You have exceeded your daily email sending quota.", statusCode: 429 }, { status: 429, headers: { "retry-after": "30" } });
				}
				if (to === "timeout@example.com") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
				if (to === "unverified@example.com") {
					return Response.json({ name: "validation_error", message: "The letters.dev domain is not verified.", statusCode: 403 }, { status: 403 });
				}
				return Response.json({ id: `email_${calls.length}` });
			}
			if (method === "POST" && url.pathname === "/domains") {
				const body = JSON.parse(init.body);
				if (stored(body.name)) {
					return Response.json({ name: "validation_error", message: `The ${body.name} domain has been registered already.`, statusCode: 403 }, { status: 403 });
				}
				const domain = {
					id: crypto.randomUUID(),
					name: body.name,
					status: "not_started",
					records: [
						{ record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=test-key", status: "not_started" },
						{ record: "SPF", name: body.custom_return_path, type: "MX", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10, status: "not_started" },
						{ record: "SPF", name: body.custom_return_path, type: "TXT", value: "v=spf1 include:amazonses.com ~all", status: "not_started" },
						{ record: "Tracking", name: "links", type: "CNAME", value: "links1.resend-dns.com", status: "not_started" },
					],
				};
				remote.set(domain.id, domain);
				return Response.json(domain, { status: 201 });
			}
			if (method === "GET" && url.pathname === "/domains") {
				const after = url.searchParams.get("after");
				const all = [...remote.values()];
				const data = after ? all.filter((domain) => domain.name === "taken.dev") : all.filter((domain) => domain.name !== "taken.dev");
				return Response.json({ data, has_more: !after && all.some((domain) => domain.name === "taken.dev") });
			}
			const verify = /^\/domains\/([^/]+)\/verify$/.exec(url.pathname);
			if (method === "POST" && verify) {
				if (verifyStatus === 429) return Response.json({ name: "rate_limit_exceeded", message: "Too many requests." }, { status: 429 });
				const domain = remote.get(decodeURIComponent(verify[1]));
				if (!domain) return Response.json({ name: "not_found", message: "Domain not found" }, { status: 404 });
				domain.status = "verified";
				for (const record of domain.records) record.status = "verified";
				return Response.json({ object: "domain", id: domain.id });
			}
			const one = /^\/domains\/([^/]+)$/.exec(url.pathname);
			if (one && method === "GET") {
				const domain = remote.get(decodeURIComponent(one[1]));
				return domain ? Response.json(domain) : Response.json({ name: "not_found", message: "Domain not found" }, { status: 404 });
			}
			if (one && method === "DELETE") {
				if (!remote.delete(decodeURIComponent(one[1]))) return Response.json({ name: "not_found", message: "Domain not found" }, { status: 404 });
				return Response.json({ object: "domain", deleted: true });
			}
			return Response.json({ name: "not_found", message: `${method} ${url.pathname}` }, { status: 404 });
		};
	}

	before(async () => {
		app = await startTestApp({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: KEY, SENDING_ENABLED: "true" });
		installFake();
		provider = (await import("../lib/email-provider/index.js")).getEmailProvider();
		domainsApi = await import("../lib/domains.js");
		Account = (await import("../models/Account.js")).default;
		account = await Account.create({ ownerId: new mongoose.Types.ObjectId() });
		remote.set("existing", {
			id: "existing",
			name: "taken.dev",
			status: "verified",
			records: [
				{ record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=already", status: "verified" },
				{ record: "SPF", name: "send", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10, status: "verified" },
				{ record: "SPF", name: "send", type: "TXT", value: "v=spf1 include:amazonses.com ~all", status: "verified" },
			],
		});
	});

	after(() => app?.stop());

	test("the account is marked ready once, and the lane stays at the free plan's rate", async () => {
		assert.equal(provider.id, "resend");
		assert.equal(provider.isConfigured(), true);
		assert.equal(provider.getMailFromDomain("letters.dev"), "bounce.letters.dev");
		const first = await provider.provisionTenant(account._id);
		const second = await provider.provisionTenant(account._id);
		assert.ok(first.provisionedAt);
		assert.equal(String(second.provisionedAt), String(first.provisionedAt));
		assert.deepEqual(provider.describeTenant(await Account.findById(account._id).lean()), { id: `mc-${account._id}`, status: "active", detail: null });
		await provider.suspendTenant(account._id);
		assert.equal(await provider.resumeTenant(account._id), false);
		await provider.removeTenant(await Account.findById(account._id).lean());
		assert.deepEqual(provider.getSendLane("campaign"), { name: "resend", rate: 2 });
		await withEnv({ RESEND_SEND_RATE_PER_SECOND: "5" }, () => {
			assert.equal(provider.getSendLane().rate, 5);
		});
	});

	test("a new domain is created with the bounce return path, and one Resend already has is reused", async () => {
		const added = await domainsApi.addDomain({ account, domain: "letters.dev" });
		const created = calls.find((call) => call.method === "POST" && call.path === "/domains");
		assert.equal(created.body.custom_return_path, "bounce");
		assert.equal(created.body.open_tracking, false);
		assert.equal(created.body.click_tracking, false);
		assert.deepEqual(created.body.capabilities, { sending: "enabled", receiving: "disabled" });
		assert.equal(added.provider, "resend");
		assert.equal(added.mailFromDomain, "bounce.letters.dev");
		assert.equal(added.dkimStatus, "NOT_STARTED");
		assert.equal(added.records.some((record) => record.name.includes("links")), false, "Resend's tracking record isn't asked for");
		assert.equal(added.records.find((record) => record.type === "MX").value, "10 feedback-smtp.us-east-1.amazonses.com");

		verifyStatus = 429;
		const unread = await provider.readDomain({ domain: added, verify: true });
		assert.equal(unread.dkimStatus, "NOT_STARTED", "a rate limit falls back to the status Resend already has");
		verifyStatus = 200;
		const checked = await domainsApi.checkDomain({ account, domainId: added._id, verify: true });
		assert.equal(checked.verified, true);
		assert.equal(checked.dkimStatus, "SUCCESS");
		assert.equal(checked.mailFromStatus, "SUCCESS");
		assert.ok(calls.some((call) => call.method === "POST" && call.path.endsWith("/verify")));

		const taken = await domainsApi.addDomain({ account, domain: "taken.dev" });
		assert.equal(taken.providerDomainId, "existing");
		assert.equal(taken.mailFromDomain, "send.taken.dev", "an existing domain keeps its return path");
		assert.equal(taken.verified, true);
		assert.equal(calls.filter((call) => call.path === "/domains" && call.method === "GET").at(-1).search.includes("after="), true);

		await provider.removeDomain({ domain: added });
		assert.equal(remote.has(added.providerDomainId), false);
		await provider.removeDomain({ domain: { providerDomainId: "missing" } });
	});

	test("a campaign email goes out with the message id as its idempotency key, and Resend's refusals keep their outcomes", async () => {
		const tenant = await provider.ensureTenant(account);
		const message = { _id: new mongoose.Types.ObjectId(), accountId: account._id, kind: "campaign", campaignId: new mongoose.Types.ObjectId() };
		const email = {
			from: "Letters <hi@letters.dev>",
			to: "reader@example.com",
			subject: "Issue 1",
			html: "<p>Hi</p>",
			text: "Hi",
			replyTo: "hi@letters.dev",
			headers: { "List-Unsubscribe": "<https://letters.dev/unsub>" },
		};
		const before = calls.length;
		const sent = await provider.sendEmail({ tenant, message, email, feedbackId: `x:mc-${account._id}:campaign:mailcheap` });
		const call = calls[before];
		assert.equal(sent.providerMessageId, `email_${before + 1}`);
		assert.equal(call.headers["Idempotency-Key"], String(message._id));
		assert.equal(call.body.headers["Feedback-ID"], `x:mc-${account._id}:campaign:mailcheap`);
		assert.deepEqual(call.body.tags, getResendTags(message));
		assert.equal(call.body.reply_to, "hi@letters.dev");

		const quota = provider.sendEmail({ tenant, message, email: { ...email, to: "quota@example.com" }, feedbackId: null });
		await assert.rejects(quota, (error) => error.outcome === SEND_OUTCOMES.throttled && error.retryAfter === 3600);
		const unverified = provider.sendEmail({ tenant, message, email: { ...email, to: "unverified@example.com" }, feedbackId: null });
		await assert.rejects(unverified, (error) => error.outcome === SEND_OUTCOMES.domainUnverified);
		const timedOut = provider.sendEmail({ tenant, message, email: { ...email, to: "timeout@example.com" }, feedbackId: null });
		await assert.rejects(timedOut, (error) => error.outcome === SEND_OUTCOMES.unavailable && /idempotency key/.test(error.message));

		await withEnv({ SENDING_ENABLED: "false" }, async () => {
			const count = calls.length;
			await assert.rejects(provider.sendEmail({ tenant, message, email, feedbackId: null }), /SENDING_ENABLED is not true/);
			assert.equal(calls.length, count, "nothing is sent while sending is off");
		});
	});
});
