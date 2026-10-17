import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import Papa from "papaparse";
import { createConfirmToken } from "../lib/confirmation.js";
import { mapFieldColumns } from "../lib/csv-import.js";
import { isQuietTime } from "../lib/sequence-rules.js";
import { readMeta, readSequenceFolder, stripMetaComment } from "../scripts/import-sequence.mjs";
import { activate, anonymous, as, callApi, catchRedirect, form, jsonRequest, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// Custom contact fields, merge tags, campaign audiences and sequences, through the REST API, MCP, the dashboard's import
// and the signup paths, with every send going through the real send batches. Readers are made up.
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
let app;
let m;
let processed = 0;
let nextId = 0;

async function api(key, method, path, body) {
	const response = await callApi(method, `/api/v1${path}`, { key, body });
	if (response.status < 300) {
		const segments = new URL(path, "http://x").pathname.split("/").filter(Boolean).map(decodeURIComponent);
		const { action } = m.rest.matchRoute(method, segments);
		const checked = action.output.safeParse(response.body);
		assert.ok(checked.success, `${action.name} answered outside its schema: ${checked.error?.message}`);
	}
	return response;
}

async function ok(promise, status = 200) {
	const response = await promise;
	assert.equal(response.status, status, JSON.stringify(response.body));
	return response.body;
}

function assertError(response, status, code) {
	assert.equal(response.status, status, JSON.stringify(response.body));
	assert.equal(response.body.error.code, code, response.body.error.message);
	return response.body.error.message;
}

async function callTool(key, name, args = {}) {
	const request = new Request("http://localhost:3000/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
			authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } }),
	});
	const text = await (await anonymous(() => m.mcpRoute.POST(request))).text();
	const { result } = JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6));
	assert.ok(!result.isError, JSON.stringify(result));
	return result.structuredContent;
}

async function runJobs() {
	while (processed < published.length) {
		const { url, body } = published[processed++];
		if (url.endsWith("/api/jobs/send-batch")) await m.sendBatchRoute.POST(jsonRequest(url, { method: "POST", body }));
	}
}

// A run of the cron some days from now, out of the quiet hours: each later day's run comes a little later, so it's past
// the steps the run before queued.
function runAt(days) {
	let time = new Date(Date.now() + days * DAY_MS + (days + 1) * 60_000);
	while (isQuietTime(time)) time = new Date(time.getTime() + HOUR_MS);
	return time;
}

async function runDue(days) {
	const result = await m.sequences.runDueSequenceSteps({ now: runAt(days) });
	await runJobs();
	return result;
}

async function customer(email, { requireConfirmation = false, ...plan } = {}) {
	const user = await signIn(email);
	await activate(user, plan);
	const slug = email.split("@")[0];
	const url = await as(user, () =>
		catchRedirect(
			m.newsletters.saveNewsletter(
				null,
				form({
					name: `${slug} news`,
					slug,
					fromEmail: `hello@${slug}.mailcheapmail.com`,
					postalAddress: "1 Main St, Paris",
					archiveEnabled: "on",
					...(requireConfirmation && { requireConfirmation: "on" }),
				})
			)
		)
	);
	user.newsletterId = url.split("/").at(-1);
	user.slug = slug;
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	return user;
}

function signUp(user, email, fields) {
	return ok(api(user.key, "POST", "/contacts", { email, ...(fields && { fields }) }), 201);
}

const emailsTo = (address) => sesEmails.filter(({ to }) => to === address);
const page = (text) => `<html><body><p>${text}</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p></body></html>`;
const variant = (subject, text, match) => ({ ...(match && { match }), subject, content: page(text) });

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		archive: await import("../app/archive/actions.js"),
		confirm: await import("../app/confirm/actions.js"),
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		cronRoute: await import("../app/api/cron/sequences/route.js"),
		exportRoute: await import("../app/api/v1/contacts/export.csv/route.js"),
		mcpRoute: await import("../app/mcp/route.js"),
		rest: await import("../lib/api/rest.js"),
		sequences: await import("../lib/sequences.js"),
		Account: (await import("../models/Account.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Message: (await import("../models/Message.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		Sequence: (await import("../models/Sequence.js")).default,
		SequenceEnrollment: (await import("../models/SequenceEnrollment.js")).default,
	};
});

after(() => app?.stop());

describe("custom fields", () => {
	test("the REST API and MCP set, read, filter and remove them", async () => {
		const user = await customer("fields@example.com");
		const created = await ok(
			api(user.key, "POST", "/contacts", { email: "mira@example.com", source: "quiz", fields: { first_name: "Mira", sun_sign: "Scorpio", life_path: 7 } }),
			201
		);
		const mira = await ok(api(user.key, "GET", `/contacts/${created.id}`));
		assert.deepEqual(mira.fields, { first_name: "Mira", sun_sign: "scorpio", life_path: "7" });
		assert.equal(mira.source, "quiz");

		assert.match(assertError(await api(user.key, "POST", "/contacts", { email: "noor@example.com", fields: { sun_sign: "dragon" } }), 400, "validation_failed"), /sun_sign/);
		assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, email: "noor@example.com" }), 0, "nothing saved");

		const noor = await callTool(user.key, "add_contact", { email: "noor@example.com", fields: { first_name: "Noor", sun_sign: "leo", life_path: 3 } });
		const updated = await callTool(user.key, "update_contact_fields", { id: noor.id, fields: { life_path: null, city: "Utrecht" } });
		assert.deepEqual(updated.fields, { first_name: "Noor", sun_sign: "leo", city: "Utrecht" });

		// A website form's signups only key can send fields, and signing up again fills them in.
		const signups = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site", level: "signups" })))).key;
		const again = await ok(api(signups, "POST", "/contacts", { email: "mira@example.com", fields: { first_name: "Mira V" } }));
		assert.equal(again.created, false);
		const removed = await ok(api(user.key, "PATCH", `/contacts/${created.id}/fields`, { fields: { sun_sign: null } }));
		assert.deepEqual(removed.fields, { first_name: "Mira V", life_path: "7" });

		const leos = await ok(api(user.key, "GET", "/contacts?field=sun_sign&value=leo"));
		assert.deepEqual(leos.contacts.map(({ email }) => email), ["noor@example.com"]);
		const withoutSign = await ok(api(user.key, "GET", "/contacts?field=sun_sign"));
		assert.deepEqual(withoutSign.contacts.map(({ email }) => email), ["mira@example.com"]);
		assertError(await api(user.key, "PATCH", `/contacts/${created.id}/fields`, { fields: { "Bad Name": "x" } }), 400, "validation_failed");
	});

	test("CSV imports bring them in, also for existing contacts, and exports take them out", async () => {
		const user = await customer("fields-csv@example.com");
		await signUp(user, "ines@example.com", { first_name: "Ines" });
		// What the import dialog sends for a file with First Name, Zodiac Sign and Source columns.
		const imported = await as(user, () =>
			m.contacts.importContacts({
				newsletterId: user.newsletterId,
				consent: true,
				rows: [
					{ email: "ines@example.com", status: "active", fields: { sun_sign: "pisces" } },
					{ email: "tomas@example.com", status: "active", fields: { first_name: "Tomas", sun_sign: "virgo" }, source: "quiz" },
				],
			})
		);
		assert.equal(imported.created, 1, JSON.stringify(imported));
		await ok(
			api(user.key, "POST", "/contacts/import", {
				consent: true,
				contacts: [{ email: "lena@example.com", fields: { first_name: "Lena", sun_sign: "Aries", life_path: 99 } }],
			})
		);
		const contacts = await m.Contact.find({ accountId: user.accountId }).sort({ email: 1 }).lean();
		assert.deepEqual(
			contacts.map(({ email, fields, source }) => [email, fields, source]),
			[
				["ines@example.com", { first_name: "Ines", sun_sign: "pisces" }, "api"],
				["lena@example.com", { first_name: "Lena", sun_sign: "aries" }, "import"],
				["tomas@example.com", { first_name: "Tomas", sun_sign: "virgo" }, "quiz"],
			]
		);

		const { url } = await ok(api(user.key, "GET", "/contacts/export"));
		const csv = await (await m.exportRoute.GET(new Request(url))).text();
		const { data, meta } = Papa.parse(csv.trim(), { header: true });
		assert.deepEqual(meta.fields.slice(-2), ["first_name", "sun_sign"]);
		assert.deepEqual(mapFieldColumns(meta.fields), [
			["first_name", "first_name"],
			["sun_sign", "sun_sign"],
		]);
		assert.equal(data.find(({ email }) => email === "tomas@example.com").sun_sign, "virgo");
	});
});

describe("campaign audiences", () => {
	test("a campaign goes only to contacts whose fields match, each with their own values", async () => {
		const user = await customer("audience@example.com");
		await signUp(user, "mira@audience.example.org", { first_name: "Mira", sun_sign: "scorpio" });
		await signUp(user, "vera@audience.example.org", { first_name: "<Vera>", sun_sign: "scorpio" });
		await signUp(user, "noor@audience.example.org", { first_name: "Noor", sun_sign: "leo" });
		await signUp(user, "jonas@audience.example.org");

		assertError(await api(user.key, "POST", "/campaigns", { subject: "Bad", audience: { sun_sign: "dragon" } }), 400, "validation_failed");
		const draft = await ok(
			api(user.key, "POST", "/campaigns", {
				subject: "{{sun_sign|Your sign}}: this week",
				format: "html",
				content: page("Hi {{first_name|there}}, {{sun_sign|every sign}} first."),
				audience: { sun_sign: "Scorpio" },
			}),
			201
		);
		assert.deepEqual(draft.audience, { sun_sign: ["scorpio"] });
		assert.equal(draft.activeContacts, 4);
		assert.equal(draft.audienceContacts, 2);

		await ok(api(user.key, "POST", `/campaigns/${draft.id}/send`));
		await runJobs();
		assert.equal(emailsTo("noor@audience.example.org").length + emailsTo("jonas@audience.example.org").length, 0);
		const [mira] = emailsTo("mira@audience.example.org");
		assert.equal(mira.subject, "scorpio: this week");
		assert.match(mira.html, /Hi Mira, scorpio first\./);
		assert.match(mira.text, /Hi Mira, scorpio first\./);
		const [vera] = emailsTo("vera@audience.example.org");
		assert.match(vera.html, /Hi &lt;Vera&gt;, scorpio first\./, "values are escaped");
		const report = await ok(api(user.key, "GET", `/campaigns/${draft.id}`));
		assert.equal(report.stats.recipients, 2);

		// Every sign but scorpio, and contacts without one.
		const rest = await ok(api(user.key, "POST", "/campaigns", { subject: "The rest", content: "Hello {{first_name|there}}" }), 201);
		assert.equal(rest.audience, null);
		const others = await ok(api(user.key, "PATCH", `/campaigns/${rest.id}`, { audience: { sun_sign: ["leo", null] } }));
		assert.deepEqual(others.audience, { sun_sign: ["leo", null] });
		await ok(api(user.key, "POST", `/campaigns/${rest.id}/send`));
		await runJobs();
		assert.match(emailsTo("noor@audience.example.org")[0].text, /Hello Noor/);
		assert.match(emailsTo("jonas@audience.example.org")[0].text, /Hello there/);
		assert.equal(emailsTo("mira@audience.example.org").length, 1);

		const cleared = await ok(api(user.key, "POST", "/campaigns", { subject: "All", content: "Hi", audience: { sun_sign: "leo" } }), 201);
		assert.equal((await ok(api(user.key, "PATCH", `/campaigns/${cleared.id}`, { audience: null }))).audience, null);
	});
});

describe("sequences", () => {
	test("a series goes out on its days, once a step, in the variant that matches each contact", async () => {
		const user = await customer("series@example.com");
		const sequence = await ok(
			api(user.key, "POST", "/sequences", {
				name: "Welcome series",
				steps: [{ dayOffset: 0, variants: [variant("Welcome, {{first_name|friend}}", "Your result is saved, {{first_name|friend}}.")] }],
			}),
			201
		);
		assert.equal(sequence.status, "draft");
		await callTool(user.key, "set_sequence_step", {
			id: sequence.id,
			position: 2,
			dayOffset: 1,
			variants: [
				variant("Scorpio: what your Sun sign describes", "Scorpio, {{first_name|there}}.", { sun_sign: "scorpio" }),
				variant("Leo: what your Sun sign describes", "Leo, {{first_name|there}}.", { sun_sign: ["leo"] }),
				variant("What your Sun sign describes", "Every sign, {{first_name|there}}."),
			],
		});
		const full = await ok(
			api(user.key, "POST", `/sequences/${sequence.id}/steps`, {
				position: 3,
				dayOffset: 3,
				variants: [variant("Scorpio only", "Just for scorpios.", { sun_sign: "scorpio" })],
			})
		);
		assert.deepEqual(
			full.steps.map(({ position, dayOffset, variants }) => [position, dayOffset, variants.map(({ match }) => match)]),
			[
				[1, 0, [null]],
				[2, 1, [{ sun_sign: ["scorpio"] }, { sun_sign: ["leo"] }, null]],
				[3, 3, [{ sun_sign: ["scorpio"] }]],
			]
		);
		assertError(
			await api(user.key, "POST", `/sequences/${sequence.id}/steps`, { position: 4, dayOffset: 2, variants: [variant("Back in time", "No.")] }),
			400,
			"validation_failed"
		);
		assertError(
			await api(user.key, "POST", `/sequences/${sequence.id}/steps`, { position: 4, dayOffset: 5, variants: [variant("A", "a"), variant("B", "b")] }),
			400,
			"validation_failed"
		);

		// A draft takes nobody in.
		await signUp(user, "early@series.example.org", { sun_sign: "scorpio" });
		await flushAfter();
		assert.equal(await m.SequenceEnrollment.countDocuments({ accountId: user.accountId }), 0);

		assert.equal((await ok(api(user.key, "PATCH", `/sequences/${sequence.id}`, { status: "active" }))).status, "active");
		await signUp(user, "mira@series.example.org", { first_name: "Mira", sun_sign: "scorpio" });
		await signUp(user, "noor@series.example.org", { first_name: "Noor", sun_sign: "leo" });
		await signUp(user, "jonas@series.example.org");
		await flushAfter();
		// The first step goes from the signup itself, no run needed, unless it came in the quiet hours.
		const sentAtSignup = emailsTo("mira@series.example.org").length;
		assert.equal(sentAtSignup, isQuietTime(new Date()) ? 0 : 1);
		await runDue(0);
		for (const [address, subject] of [
			["mira@series.example.org", "Welcome, Mira"],
			["noor@series.example.org", "Welcome, Noor"],
			["jonas@series.example.org", "Welcome, friend"],
		]) {
			assert.deepEqual(
				emailsTo(address).map((email) => email.subject),
				[subject],
				address
			);
		}
		assert.equal(emailsTo("early@series.example.org").length, 0);

		await runDue(1);
		assert.deepEqual(emailsTo("mira@series.example.org").map(({ subject }) => subject).at(-1), "Scorpio: what your Sun sign describes");
		assert.match(emailsTo("mira@series.example.org").at(-1).html, /Scorpio, Mira\./);
		assert.deepEqual(emailsTo("noor@series.example.org").map(({ subject }) => subject).at(-1), "Leo: what your Sun sign describes");
		assert.deepEqual(emailsTo("jonas@series.example.org").map(({ subject }) => subject).at(-1), "What your Sun sign describes");
		assert.match(emailsTo("jonas@series.example.org").at(-1).html, /Every sign, there\./);

		// The same run again finds nothing new.
		await runDue(1);
		assert.equal(emailsTo("mira@series.example.org").length, 2);

		await runDue(3);
		assert.equal(emailsTo("mira@series.example.org").at(-1).subject, "Scorpio only");
		assert.equal(emailsTo("noor@series.example.org").length, 2, "no variant for noor in step 3");
		assert.equal(emailsTo("jonas@series.example.org").length, 2, "nor for jonas");

		const report = await ok(api(user.key, "GET", `/sequences/${sequence.id}`));
		assert.deepEqual(
			report.steps.map(({ stats }) => [stats.queued, stats.sent]),
			[
				[3, 3],
				[3, 3],
				[1, 1],
			]
		);
		assert.deepEqual(report.contacts, { active: 0, paused: 0, completed: 3, stopped: 0 });
		const messages = await m.Message.find({ accountId: user.accountId, kind: "sequence" }).lean();
		assert.equal(messages.length, 7);
		assert.ok(messages.every(({ status, sequenceId }) => status === "sent" && String(sequenceId) === sequence.id));

		const listed = await callTool(user.key, "list_sequences");
		assert.equal(listed.sequences[0].steps[1].variants[0].content, undefined, "lists leave the content out");
		assert.ok(listed.sequences[0].steps[1].variants[0].bytes > 0);
		const withContent = await ok(api(user.key, "GET", `/sequences/${sequence.id}?includeContent=true`));
		assert.match(withContent.steps[0].variants[0].content, /Your result is saved/);
	});

	test("runs at the same time queue and send each step once", async () => {
		const user = await customer("concurrent@example.com");
		const sequence = await ok(
			api(user.key, "POST", "/sequences", { name: "Day one", steps: [{ dayOffset: 1, variants: [variant("Day one", "Hello.")] }] }),
			201
		);
		await ok(api(user.key, "PATCH", `/sequences/${sequence.id}`, { status: "active" }));
		const addresses = ["ada@concurrent.example.org", "ben@concurrent.example.org", "cas@concurrent.example.org"];
		for (const address of addresses) await signUp(user, address);
		await flushAfter();

		const now = runAt(1);
		const results = await Promise.all([
			m.sequences.runDueSequenceSteps({ now }),
			m.sequences.runDueSequenceSteps({ now }),
			m.sequences.runDueSequenceSteps({ now }),
		]);
		assert.ok(results.reduce((sum, { queued }) => sum + queued, 0) >= 3);
		await runJobs();
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, kind: "sequence" }), 3);
		for (const address of addresses) assert.equal(emailsTo(address).length, 1, address);

		const [message] = await m.Message.find({ accountId: user.accountId, kind: "sequence" }).lean();
		const { _id, createdAt, updatedAt, ...copy } = message;
		await assert.rejects(m.Message.create({ ...copy, status: "queued" }), { code: 11000 }, "the database refuses a second record");
	});

	test("unsubscribing stops the sequence, and a step queued before goes nowhere", async () => {
		const user = await customer("leaving@example.com");
		const sequence = await ok(
			api(user.key, "POST", "/sequences", {
				name: "Three days",
				steps: [0, 1, 2].map((dayOffset) => ({ dayOffset, variants: [variant(`Day ${dayOffset}`, "Hello.")] })),
			}),
			201
		);
		await ok(api(user.key, "PATCH", `/sequences/${sequence.id}`, { status: "active" }));
		const lena = await signUp(user, "lena@leaving.example.org");
		const sam = await signUp(user, "sam@leaving.example.org");
		await flushAfter();
		await runDue(0);
		assert.equal(emailsTo("lena@leaving.example.org").length, 1);

		await ok(api(user.key, "PATCH", `/contacts/${lena.id}`, { status: "unsubscribed" }));
		await m.sequences.runDueSequenceSteps({ now: runAt(1) });
		const enrollment = await m.SequenceEnrollment.findOne({ accountId: user.accountId, contactId: lena.id }).lean();
		assert.equal(enrollment.status, "stopped");
		assert.equal(enrollment.stoppedReason, "unsubscribed");

		// Sam's day-1 step is queued; he leaves before its batch runs.
		await ok(api(user.key, "PATCH", `/contacts/${sam.id}`, { status: "unsubscribed" }));
		await runJobs();
		assert.equal(emailsTo("sam@leaving.example.org").length, 1);
		const queued = await m.Message.findOne({ accountId: user.accountId, kind: "sequence", contactId: sam.id, status: { $ne: "sent" } }).lean();
		assert.equal(queued.status, "suppressed");
		await runDue(2);
		assert.equal(emailsTo("lena@leaving.example.org").length, 1);
		assert.equal(emailsTo("sam@leaving.example.org").length, 1);
	});

	test("with confirmation on, contacts join when they confirm, not when they sign up", async () => {
		const user = await customer("confirming@example.com", { requireConfirmation: true });
		const sequence = await ok(
			api(user.key, "POST", "/sequences", { name: "Hello", steps: [{ dayOffset: 0, variants: [variant("Hello {{first_name|you}}", "Thanks.")] }] }),
			201
		);
		await ok(api(user.key, "PATCH", `/sequences/${sequence.id}`, { status: "active" }));
		const pending = await signUp(user, "mira@confirming.example.org", { first_name: "Mira" });
		assert.equal(pending.status, "pending");
		// The form on the archive too.
		await anonymous(() => m.archive.subscribe(null, form({ newsletter: user.slug, email: "noor@confirming.example.org" })));
		await flushAfter();
		assert.equal(await m.SequenceEnrollment.countDocuments({ accountId: user.accountId }), 0);
		assert.deepEqual(emailsTo("mira@confirming.example.org").map(({ subject }) => subject), ["Confirm your subscription to confirming news"]);

		const token = createConfirmToken({ contactId: pending.id, newsletterId: user.newsletterId });
		assert.deepEqual(await anonymous(() => m.confirm.confirmSubscription(token)), { ok: true });
		await flushAfter();
		assert.equal(await m.SequenceEnrollment.countDocuments({ accountId: user.accountId, contactId: pending.id }), 1);
		await runDue(0);
		assert.equal(emailsTo("mira@confirming.example.org").at(-1).subject, "Hello Mira");
		// Confirming twice doesn't start it again.
		await anonymous(() => m.confirm.confirmSubscription(token));
		await flushAfter();
		await runDue(0);
		assert.equal(emailsTo("mira@confirming.example.org").length, 2);
	});

	test("the archive form starts sequences for newsletters without confirmation", async () => {
		const user = await customer("archive-form@example.com");
		const sequence = await ok(
			api(user.key, "POST", "/sequences", { name: "Hello", steps: [{ dayOffset: 0, variants: [variant("Hello from the form", "Thanks.")] }] }),
			201
		);
		await ok(api(user.key, "PATCH", `/sequences/${sequence.id}`, { status: "active" }));
		await anonymous(() => m.archive.subscribe(null, form({ newsletter: user.slug, email: "ines@archive-form.example.org" })));
		await flushAfter();
		await runDue(0);
		assert.deepEqual(emailsTo("ines@archive-form.example.org").map(({ subject }) => subject), ["Hello from the form"]);
	});

	test("nothing goes out in the quiet hours: a run then does nothing and a signup's first step waits until 06:00", async () => {
		assert.deepEqual(await m.sequences.runDueSequenceSteps({ now: new Date("2026-07-01T02:00:00Z") }), { skipped: "quiet hours" });

		const user = await customer("night@example.com");
		const sequence = await ok(
			api(user.key, "POST", "/sequences", { name: "Night", steps: [{ dayOffset: 0, variants: [variant("Hello", "Hi.")] }, { dayOffset: 1, variants: [variant("Day one", "Hi.")] }] }),
			201
		);
		await ok(api(user.key, "PATCH", `/sequences/${sequence.id}`, { status: "active" }));
		const contact = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "owl@night.example.org" });
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		// 04:30 in Amsterdam, summer time.
		const result = await m.sequences.startSequences({ newsletter, contact: contact.toObject(), now: new Date("2026-07-01T02:30:00Z") });
		assert.deepEqual(result, { joined: 1 });
		const enrollment = await m.SequenceEnrollment.findOne({ accountId: user.accountId, contactId: contact._id }).lean();
		assert.equal(enrollment.nextAt.toISOString(), "2026-07-01T04:00:00.000Z");
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, kind: "sequence" }), 0);
	});

	test("steps keep to the warm-up's pace, wait while the account can't send, and are skipped without room in the month", async () => {
		const user = await customer("pace@example.com");
		const sequence = await ok(api(user.key, "POST", "/sequences", { name: "Paced", steps: [{ dayOffset: 0, variants: [variant("Paced", "Hi.")] }] }), 201);
		await ok(api(user.key, "PATCH", `/sequences/${sequence.id}`, { status: "active" }));
		const stored = await m.Sequence.findOne({ accountId: user.accountId, _id: sequence.id }).lean();
		// Day 1 of the warm-up, nothing proven, and 200 emails in the last day: one batch of 50 goes per run.
		await m.Account.updateOne({ _id: user.accountId }, { $set: { spreadUntil: new Date(Date.now() + 29.5 * DAY_MS) } });
		await m.Message.insertMany(
			Array.from({ length: 200 }, (_, index) => ({
				kind: "sequence",
				accountId: user.accountId,
				newsletterId: user.newsletterId,
				sequenceId: new mongoose.Types.ObjectId(),
				stepId: new mongoose.Types.ObjectId(),
				contactId: new mongoose.Types.ObjectId(),
				email: `earlier${index}@pace.example.org`,
				status: "sent",
				sentAt: new Date(Date.now() - HOUR_MS),
			}))
		);
		const contacts = await m.Contact.insertMany(
			Array.from({ length: 60 }, (_, index) => ({ accountId: user.accountId, newsletterId: user.newsletterId, email: `reader${index}@pace.example.org` }))
		);
		const joinedAt = new Date(Date.now() - HOUR_MS);
		await m.SequenceEnrollment.insertMany(
			contacts.map(({ _id }) => ({ accountId: user.accountId, sequenceId: stored._id, newsletterId: user.newsletterId, contactId: _id, startedAt: joinedAt, nextAt: joinedAt }))
		);

		// Blocked: everything waits.
		await m.Account.updateOne({ _id: user.accountId }, { $set: { status: "paused" } });
		const queuedSteps = () => m.Message.countDocuments({ accountId: user.accountId, kind: "sequence", status: "queued" });
		const waiting = () => m.SequenceEnrollment.countDocuments({ accountId: user.accountId, status: "active" });
		await m.sequences.runDueSequenceSteps({ now: runAt(0) });
		assert.equal(await queuedSteps(), 0);
		assert.equal(await waiting(), 60);
		await m.Account.updateOne({ _id: user.accountId }, { $set: { status: "active" } });

		await m.sequences.runDueSequenceSteps({ now: runAt(0) });
		assert.equal(await queuedSteps(), 50);
		assert.equal(await waiting(), 10, "the rest wait for the next run");

		// The month's emails used up: the batch skips them, like welcome emails.
		await m.Account.updateOne({ _id: user.accountId }, { $set: { limitOverrides: { emailsPerMonth: 1 }, "usage.emailsSent": 1 } });
		await runJobs();
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, kind: "sequence", status: "skipped" }), 50);
		assert.equal(emailsTo("reader0@pace.example.org").length, 0);
	});

	test("pausing holds contacts where they are, and deleting drops what's queued", async () => {
		const user = await customer("pausing@example.com");
		const sequence = await ok(
			api(user.key, "POST", "/sequences", { name: "Pause me", steps: [0, 1].map((dayOffset) => ({ dayOffset, variants: [variant(`Day ${dayOffset}`, "Hi.")] })) }),
			201
		);
		await ok(api(user.key, "PATCH", `/sequences/${sequence.id}`, { status: "active" }));
		await signUp(user, "kai@pausing.example.org");
		await flushAfter();
		await runDue(0);
		assert.equal(emailsTo("kai@pausing.example.org").length, 1);

		await callTool(user.key, "update_sequence", { id: sequence.id, status: "paused" });
		await m.sequences.runDueSequenceSteps({ now: runAt(1) });
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, kind: "sequence" }), 1);
		assert.equal(await m.SequenceEnrollment.countDocuments({ accountId: user.accountId, status: "paused" }), 1);
		// New signups don't join a paused sequence.
		await signUp(user, "lou@pausing.example.org");
		await flushAfter();
		assert.equal(await m.SequenceEnrollment.countDocuments({ accountId: user.accountId }), 1);

		await callTool(user.key, "update_sequence", { id: sequence.id, status: "active" });
		await m.sequences.runDueSequenceSteps({ now: runAt(1) });
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, kind: "sequence", status: "queued" }), 1);
		await ok(api(user.key, "DELETE", `/sequences/${sequence.id}`));
		await runJobs();
		assert.equal(emailsTo("kai@pausing.example.org").length, 1);
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, kind: "sequence", status: "skipped" }), 1);
		assert.equal(await m.SequenceEnrollment.countDocuments({ accountId: user.accountId }), 0);
		assertError(await api(user.key, "GET", `/sequences/${sequence.id}`), 404, "not_found");
	});

	test("making a sequence active checks it like a send", async () => {
		const user = await customer("checks@example.com");
		const empty = await ok(api(user.key, "POST", "/sequences", { name: "Empty" }), 201);
		assert.match(assertError(await api(user.key, "PATCH", `/sequences/${empty.id}`, { status: "active" }), 400, "validation_failed"), /Add a step/);
		const big = await ok(
			api(user.key, "POST", "/sequences", { name: "Big", steps: [{ dayOffset: 0, variants: [variant("Big", "x".repeat(120_000))] }] }),
			201
		);
		assert.match(assertError(await api(user.key, "PATCH", `/sequences/${big.id}`, { status: "active" }), 422, "send_check_failed"), /Step 1, variant 1: The email is \d+ KB/);
		assert.equal((await ok(api(user.key, "GET", `/sequences/${big.id}`))).status, "draft");
	});

	test("scripts/import-sequence.mjs reads a folder of variants into steps the API loads", async () => {
		const draft = (day, subject) => `<!DOCTYPE html>
<html><head><title>{{subject}}</title>
<!-- Welcome mail, DRAFT ONLY.
     Send: day ${day} after opt-in. Subject: ${subject}
     Preview text: A short note for {{first_name|you}}. -->
</head><body><p>Hello {{first_name|there}}, ${subject}</p><a href="{{unsubscribe_url}}">Unsubscribe</a></body></html>`;
		assert.deepEqual(readMeta(draft(3, "Scorpio: day three")), { subject: "Scorpio: day three", previewText: "A short note for {{first_name|you}}.", dayOffset: 3 });
		assert.ok(!stripMetaComment(draft(3, "x")).includes("DRAFT ONLY"), "the notes stay out of the email");

		const folder = await mkdtemp(join(tmpdir(), "mailcheap-sequence-"));
		try {
			for (const sign of ["scorpio", "leo"]) {
				await writeFile(join(folder, `welcome-01-${sign}.html`), draft(0, "Your result, saved"));
				await writeFile(join(folder, `welcome-02-${sign}.html`), draft(1, `${sign}: what your sign describes`));
			}
			await writeFile(join(folder, "welcome-02-default.html"), draft(1, "What your sign describes"));
			await writeFile(join(folder, "notes.md"), "Not an email.");
			const plan = await readSequenceFolder(folder);
			assert.deepEqual(
				plan.steps.map(({ position, dayOffset, variants }) => [position, dayOffset, variants.map(({ match }) => match?.sun_sign ?? "fallback")]),
				[
					[1, 0, ["leo", "scorpio"]],
					[2, 1, ["fallback", "leo", "scorpio"]],
				]
			);
			assert.deepEqual(plan.warnings, ["Step 1: no fallback (…-01-default.html), so contacts without a matching sun_sign skip it"]);
			await assert.rejects(readSequenceFolder(folder, { days: [0] }), /--days has 1 offsets for 2 steps/);

			// What the script sends, one call per step.
			const user = await customer("import-script@example.com");
			const sequence = await ok(api(user.key, "POST", "/sequences", { name: "Imported" }), 201);
			for (const step of plan.steps) {
				const variants = step.variants.map(({ file, ...rest }) => rest);
				await ok(api(user.key, "POST", `/sequences/${sequence.id}/steps`, { position: step.position, dayOffset: step.dayOffset, variants }));
			}
			await ok(api(user.key, "PATCH", `/sequences/${sequence.id}`, { status: "active" }));
			await signUp(user, "mira@import-script.example.org", { first_name: "Mira", sun_sign: "scorpio" });
			await flushAfter();
			await runDue(0);
			await runDue(1);
			const received = emailsTo("mira@import-script.example.org");
			assert.deepEqual(received.map(({ subject }) => subject), ["Your result, saved", "scorpio: what your sign describes"]);
			assert.match(received[1].html, /Hello Mira, scorpio/);
			assert.ok(!received[1].html.includes("DRAFT ONLY"));
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	});

	test("the cron route runs only with CRON_SECRET", async () => {
		await withEnv({ CRON_SECRET: "cron-test-secret" }, async () => {
			const denied = await m.cronRoute.GET(new Request("http://localhost:3000/api/cron/sequences"));
			assert.equal(denied.status, 401);
			const allowed = await m.cronRoute.GET(
				new Request("http://localhost:3000/api/cron/sequences", { headers: { authorization: "Bearer cron-test-secret" } })
			);
			assert.equal(allowed.status, 200);
			const body = await allowed.json();
			assert.ok("queued" in body || body.skipped === "quiet hours", JSON.stringify(body));
		});
	});
});
