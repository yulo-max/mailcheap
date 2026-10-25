import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { getEventPlan } from "../lib/email-event-rules.js";
import { normalizeResendEvent, verifyResendSignature } from "../lib/email-provider/resend-events.js";
import { startTestApp } from "./helpers/app.mjs";

const KEY = crypto.randomBytes(24);
const SECRET = `whsec_${KEY.toString("base64")}`;
const ACCOUNT_ID = "64f1a2b3c4d5e6f7a8b9c0d1";
const MESSAGE_ID = "74f1a2b3c4d5e6f7a8b9c0d2";

function sign(body, { id = `msg_${crypto.randomUUID()}`, timestamp = Math.floor(Date.now() / 1000), key = KEY } = {}) {
	const signature = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest("base64");
	return { id, timestamp: String(timestamp), signature: `v1,${signature}` };
}

function resendEvent(type, data = {}, fields = {}) {
	return {
		type,
		created_at: "2026-10-25T12:00:00.000Z",
		data: {
			email_id: crypto.randomUUID(),
			from: "Letters <hi@letters.example>",
			to: ["Reader@Example.org"],
			subject: "Issue",
			tags: { account_id: ACCOUNT_ID, message_id: MESSAGE_ID, kind: "campaign" },
			...data,
		},
		...fields,
	};
}

test("a signature is v1 and the base64 HMAC of the id, timestamp and exact body, at most 5 minutes old", () => {
	const body = JSON.stringify(resendEvent("email.delivered"));
	const now = Date.now();
	const { id, timestamp, signature } = sign(body, { timestamp: Math.floor(now / 1000) });
	const check = (overrides = {}) => verifyResendSignature({ body, id, timestamp, signature, secret: SECRET, now, ...overrides });
	assert.equal(check(), true);
	assert.equal(check({ body: Buffer.from(body) }), true, "raw bytes too");
	assert.equal(check({ signature: `v1,${"a".repeat(20)} ${signature}` }), true, "one good signature among several");
	assert.equal(check({ secret: `whsec_${crypto.randomBytes(24).toString("base64")}` }), false, "bad secret");
	assert.equal(check({ secret: "" }), false, "no secret, no trust");
	assert.equal(check({ body: body.replace("delivered", "bounced") }), false, "changed body");
	assert.equal(check({ signature: signature.slice(3) }), false, "no version");
	assert.equal(check({ id: "msg_other" }), false, "the id is signed");
	assert.equal(check({ timestamp: String(Number(timestamp) + 1) }), false, "the timestamp is signed");
	assert.equal(check({ id: "" }), false);
	assert.equal(check({ timestamp: null }), false);

	const stale = sign(body, { timestamp: Math.floor(now / 1000) - 301 });
	assert.equal(verifyResendSignature({ body, ...stale, secret: SECRET, now }), false, "stale");
	const future = sign(body, { timestamp: Math.floor(now / 1000) + 301 });
	assert.equal(verifyResendSignature({ body, ...future, secret: SECRET, now }), false, "from the future");
	const recent = sign(body, { timestamp: Math.floor(now / 1000) - 299 });
	assert.equal(verifyResendSignature({ body, ...recent, secret: SECRET, now }), true);
});

test("Resend's events take the one event shape, with the account and message from tags", () => {
	const deliveredPayload = resendEvent("email.delivered");
	const delivered = normalizeResendEvent(deliveredPayload, { eventId: "msg_delivered" });
	assert.equal(delivered.type, "delivered");
	assert.equal(delivered.recordAs, "email.delivered");
	assert.equal(delivered.accountId, ACCOUNT_ID);
	assert.equal(delivered.messageId, MESSAGE_ID);
	assert.equal(delivered.providerMessageId, deliveredPayload.data.email_id);
	assert.equal(delivered.providerEventId, "msg_delivered");
	assert.equal(delivered.email, "reader@example.org");
	assert.deepEqual(delivered.occurredAt, new Date("2026-10-25T12:00:00.000Z"));
	assert.deepEqual(getEventPlan(delivered).status, { to: "delivered", from: ["queued", "sent", "failed"] });

	const hard = getEventPlan(
		normalizeResendEvent(
			resendEvent("email.bounced", {
				bounce: { type: "Permanent", subType: "NoEmail", message: "550 5.1.1 user unknown", diagnosticCode: ["smtp; 550 5.1.1 user unknown"] },
			})
		)
	);
	assert.equal(hard.error, "Hard bounce: NoEmail, 550 5.1.1 user unknown, smtp; 550 5.1.1 user unknown");
	assert.equal(hard.suppression.reason, "bounce");
	assert.equal(hard.suppression.detail, "Permanent/NoEmail");
	assert.equal(hard.globalSuppression.reason, "bounce");
	assert.deepEqual(hard.suppression.emails, ["reader@example.org"]);

	const suppressedBounce = getEventPlan(normalizeResendEvent(resendEvent("email.bounced", { bounce: { type: "Permanent", subType: "Suppressed", message: "on the suppression list" } })));
	assert.equal(suppressedBounce.globalSuppression.reason, "bounce");
	const general = getEventPlan(normalizeResendEvent(resendEvent("email.bounced", { bounce: { type: "Permanent", subType: "General", message: "552 mailbox full" } })));
	assert.equal(general.suppression.reason, "bounce");
	assert.equal(general.globalSuppression, null, "a general hard bounce stays with the account");

	const temporary = getEventPlan(normalizeResendEvent(resendEvent("email.bounced", { bounce: { type: "Temporary", subType: "MailboxFull", message: "452 mailbox full" } })));
	assert.deepEqual([temporary.suppression, temporary.error], [null, "Soft bounce: MailboxFull, 452 mailbox full"]);
	assert.equal(getEventPlan(normalizeResendEvent(resendEvent("email.bounced", {}))).suppression, null, "no type isn't treated as permanent");

	const complaint = getEventPlan(normalizeResendEvent(resendEvent("email.complained")));
	assert.deepEqual([complaint.suppression.reason, complaint.suppression.detail, complaint.status.to], ["complaint", "abuse", "complained"]);

	const delayed = getEventPlan(normalizeResendEvent(resendEvent("email.delivery_delayed")));
	assert.deepEqual([delayed.status, delayed.isRecorded, delayed.type], [null, true, "email.delivery_delayed"]);

	const dropped = getEventPlan(normalizeResendEvent(resendEvent("email.suppressed", { suppressed: { type: "OnAccountSuppressionList", message: "Resend has suppressed sending to this address" } })));
	assert.equal(dropped.error, "Dropped by Resend: Resend has suppressed sending to this address");
	assert.equal(dropped.suppression.reason, "provider");
	const quota = getEventPlan(normalizeResendEvent(resendEvent("email.failed", { failed: { reason: "reached_daily_quota" } })));
	assert.equal(quota.suppression, null, "a quota failure isn't the address");
	assert.equal(quota.error, "Dropped by Resend: reached_daily_quota");
	const invalid = getEventPlan(normalizeResendEvent(resendEvent("email.failed", { failed: { reason: "invalid recipient" } })));
	assert.equal(invalid.suppression.reason, "bounce");
	assert.equal(invalid.globalSuppression.reason, "bounce");

	const click = normalizeResendEvent(
		resendEvent("email.clicked", { click: { link: "https://letters.example/issue", timestamp: "2026-10-25T12:05:00.000Z", ipAddress: "203.0.113.5" } })
	);
	assert.equal(click.type, "click");
	assert.equal(click.link, "https://letters.example/issue");
	assert.deepEqual(click.occurredAt, new Date("2026-10-25T12:05:00.000Z"));
	assert.equal(normalizeResendEvent(resendEvent("email.opened")).type, "open");
	assert.equal(normalizeResendEvent(resendEvent("email.sent")).type, "sent");

	for (const value of [null, [], "email.bounced", { type: "email.received" }, { type: "domain.created" }, { type: "constructor" }, { type: "__proto__" }]) {
		assert.equal(normalizeResendEvent(value), null, JSON.stringify(value));
	}
	const spoofed = normalizeResendEvent(resendEvent("email.delivered", { tags: { account_id: { $ne: null }, message_id: "../x" } }));
	assert.deepEqual([spoofed.accountId, spoofed.messageId], [null, null]);
});

describe("the Resend webhook", () => {
	let app;
	let m;
	let alice;
	let bob;

	async function customer(slug) {
		const account = await m.Account.create({ ownerId: new mongoose.Types.ObjectId() });
		const newsletter = await m.Newsletter.create({
			accountId: account._id,
			name: slug,
			slug,
			fromEmail: `hi@${slug}.example`,
		});
		return { accountId: account._id, newsletterId: newsletter._id };
	}

	async function sentMessage(user, email) {
		const contact = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email, status: "active" });
		const campaign = await m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Issue", status: "sent", startedAt: new Date() });
		const message = await m.Message.create({
			kind: "campaign",
			accountId: user.accountId,
			newsletterId: user.newsletterId,
			campaignId: campaign._id,
			contactId: contact._id,
			email,
			status: "sent",
			sentAt: new Date(),
		});
		return { message, contact, campaign };
	}

	function post(payload, { key = KEY, id, timestamp, body = JSON.stringify(payload), headers } = {}) {
		const signed = sign(body, { key, ...(id && { id }), ...(timestamp && { timestamp }) });
		return m.route.POST(
			new Request("http://localhost:3000/api/webhooks/resend", {
				method: "POST",
				headers: headers ?? {
					"content-type": "application/json",
					"svix-id": signed.id,
					"svix-timestamp": signed.timestamp,
					"svix-signature": signed.signature,
				},
				body,
			})
		);
	}

	before(async () => {
		app = await startTestApp({ RESEND_WEBHOOK_SECRET: SECRET });
		m = {
			route: await import("../app/api/webhooks/resend/route.js"),
			Account: (await import("../models/Account.js")).default,
			Campaign: (await import("../models/Campaign.js")).default,
			Contact: (await import("../models/Contact.js")).default,
			Event: (await import("../models/Event.js")).default,
			Message: (await import("../models/Message.js")).default,
			Newsletter: (await import("../models/Newsletter.js")).default,
			Suppression: (await import("../models/Suppression.js")).default,
		};
		alice = await customer("alice-rs");
		bob = await customer("bob-rs");
	});

	after(() => app?.stop());

	test("only signed, fresh requests are read", async () => {
		const { message } = await sentMessage(alice, "signed-rs@example.org");
		const payload = resendEvent("email.delivered", { tags: { account_id: String(alice.accountId), message_id: String(message._id), kind: "campaign" } });
		assert.equal((await post(payload, { key: crypto.randomBytes(24) })).status, 401);
		assert.equal((await post(payload, { timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 401, "stale");
		assert.equal((await post(payload, { headers: { "content-type": "application/json" } })).status, 401, "unsigned");
		assert.equal((await m.Message.findOne({ accountId: alice.accountId, _id: message._id }).lean()).status, "sent", "nothing changed");
		assert.equal((await post([payload])).status, 400, "an array of events");

		const response = await post(payload);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, handled: 1 });
		const delivered = await m.Message.findOne({ accountId: alice.accountId, _id: message._id }).lean();
		assert.equal(delivered.status, "delivered");
		assert.equal(delivered.providerMessageId, payload.data.email_id, "matched from then on by Resend's id");

		const ignored = await post({ type: "email.received", data: { email_id: "inbound" } });
		assert.equal(ignored.status, 200);
		assert.deepEqual(await ignored.json(), { ok: true, handled: 0 });

		const secret = process.env.RESEND_WEBHOOK_SECRET;
		delete process.env.RESEND_WEBHOOK_SECRET;
		try {
			assert.equal((await post(payload)).status, 503);
		} finally {
			process.env.RESEND_WEBHOOK_SECRET = secret;
		}
	});

	test("a hard bounce lands in its account only, and a temporary one does not suppress", async () => {
		const { message, contact, campaign } = await sentMessage(alice, "shared-reader-rs@example.org");
		const bobContact = await m.Contact.create({ accountId: bob.accountId, newsletterId: bob.newsletterId, email: "shared-reader-rs@example.org", status: "active" });
		const bounce = resendEvent("email.bounced", {
			tags: { account_id: String(alice.accountId), message_id: String(message._id), kind: "campaign" },
			to: ["shared-reader-rs@example.org"],
			bounce: { type: "Permanent", subType: "NoEmail", message: "550 5.1.1 unknown user" },
		});
		const first = await post(bounce, { id: "msg_bounce_once" });
		assert.equal(first.status, 200);
		assert.equal((await post(bounce, { id: "msg_bounce_once" })).status, 200, "redelivered");

		assert.equal((await m.Message.findOne({ accountId: alice.accountId, _id: message._id }).lean()).status, "bounced");
		assert.equal((await m.Contact.findOne({ accountId: alice.accountId, _id: contact._id }).lean()).status, "bounced");
		assert.ok(await m.Suppression.exists({ accountId: alice.accountId, email: "shared-reader-rs@example.org", reason: "bounce" }));
		assert.equal((await m.Campaign.findOne({ accountId: alice.accountId, _id: campaign._id }).lean()).stats.bounced, 1);
		assert.equal(await m.Event.countDocuments({ accountId: alice.accountId, providerEventId: "msg_bounce_once" }), 1, "recorded once");
		assert.ok((await m.Account.findById(alice.accountId).lean()).health.checkedAt, "the 7-day check ran");

		assert.equal((await m.Contact.findOne({ accountId: bob.accountId, _id: bobContact._id }).lean()).status, "active", "Bob's contact with the same address stays");
		assert.equal(await m.Suppression.countDocuments({ accountId: bob.accountId }), 0);

		const { message: delayed } = await sentMessage(alice, "later-rs@example.org");
		const soft = resendEvent("email.bounced", {
			tags: { account_id: String(alice.accountId), message_id: String(delayed._id), kind: "campaign" },
			to: ["later-rs@example.org"],
			bounce: { type: "Temporary", subType: "MailboxFull", message: "452 try later" },
		});
		assert.equal((await post(soft)).status, 200);
		const kept = await m.Message.findOne({ accountId: alice.accountId, _id: delayed._id }).lean();
		assert.equal(kept.status, "sent");
		assert.match(kept.error, /Soft bounce/);
		assert.equal(await m.Suppression.countDocuments({ accountId: alice.accountId, email: "later-rs@example.org" }), 0);
	});

	test("a complaint suppresses, a provider suppression drops the email, and another account's message id does not", async () => {
		const { message, contact } = await sentMessage(alice, "complained-rs@example.org");
		const complaint = resendEvent("email.complained", {
			tags: { account_id: String(alice.accountId), message_id: String(message._id), kind: "campaign" },
			to: ["complained-rs@example.org"],
		});
		assert.equal((await post(complaint)).status, 200);
		assert.equal((await m.Message.findOne({ accountId: alice.accountId, _id: message._id }).lean()).status, "complained");
		assert.equal((await m.Contact.findOne({ accountId: alice.accountId, _id: contact._id }).lean()).status, "complained");
		assert.equal((await m.Suppression.findOne({ accountId: alice.accountId, email: "complained-rs@example.org" }).lean()).reason, "complaint");

		const { message: dropped } = await sentMessage(alice, "dropped-rs@example.org");
		const suppressed = resendEvent("email.suppressed", {
			tags: { account_id: String(alice.accountId), message_id: String(dropped._id), kind: "campaign" },
			to: ["dropped-rs@example.org"],
			suppressed: { message: "On the account suppression list", type: "OnAccountSuppressionList" },
		});
		assert.equal((await post(suppressed)).status, 200);
		const failed = await m.Message.findOne({ accountId: alice.accountId, _id: dropped._id }).lean();
		assert.equal(failed.status, "failed");
		assert.match(failed.error, /Dropped by Resend/);
		assert.equal((await m.Suppression.findOne({ accountId: alice.accountId, email: "dropped-rs@example.org" }).lean()).reason, "provider");

		const { message: bobMessage } = await sentMessage(bob, "bob-only-rs@example.org");
		const crossed = resendEvent("email.bounced", {
			tags: { account_id: String(alice.accountId), message_id: String(bobMessage._id), kind: "campaign" },
			to: ["bob-only-rs@example.org"],
			bounce: { type: "Permanent", subType: "General", message: "550 no" },
		});
		assert.equal((await post(crossed)).status, 200);
		assert.equal((await m.Message.findOne({ accountId: bob.accountId, _id: bobMessage._id }).lean()).status, "sent", "Bob's message isn't in Alice's account");
		assert.equal(await m.Suppression.countDocuments({ accountId: bob.accountId, email: "bob-only-rs@example.org" }), 0);
	});
});
