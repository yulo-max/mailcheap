import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIssueBody } from "../lib/archive-content.js";
import { selectAudience } from "../lib/audience.js";
import {
	findMergeTags,
	getMergeValues,
	matchesFieldFilter,
	mergeSubject,
	mergeTags,
	normalizeFieldFilter,
	normalizeFields,
	toFieldQuery,
	toFieldsUpdate,
} from "../lib/contact-fields.js";
import { getCsvHeader, toCsvRow } from "../lib/contacts-csv.js";
import { mapColumns, mapFieldColumns, mapSourceColumn, normalizeImportRow, sanitizeImportRow } from "../lib/csv-import.js";
import { buildRecipientEmail } from "../lib/sending-rules.js";

process.env.BETTER_AUTH_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.APP_URL = "https://mail.example.com";

// Fictional readers only.
const newsletter = {
	_id: "74f1a2b3c4d5e6f7a8b9c0d2",
	name: "Stellar notes",
	fromName: "Notes",
	fromEmail: "hello@example.net",
	postalAddress: "1 Main St, Paris",
};
const mira = { _id: "64f1a2b3c4d5e6f7a8b9c0d1", email: "mira@example.com", source: "quiz", fields: { first_name: "Mira", sun_sign: "scorpio", life_path: "7" } };

test("fields are checked and stored in one spelling per value", () => {
	assert.deepEqual(normalizeFields({ first_name: "  Mira  Vos ", sun_sign: "Scorpio", life_path: 7, city: null, note: "" }), {
		set: { first_name: "Mira Vos", sun_sign: "scorpio", life_path: "7" },
		unset: ["city", "note"],
		problem: null,
	});
	assert.match(normalizeFields({ sun_sign: "ophiuchus" }).problem, /^sun_sign: one of aries/);
	assert.match(normalizeFields({ life_path: 10 }).problem, /^life_path: one of 1, 2/);
	assert.match(normalizeFields({ "First Name": "Mira" }).problem, /isn't a field name/);
	assert.match(normalizeFields({ unsubscribe_url: "x" }).problem, /isn't a field name/, "MailCheap's own placeholders stay its own");
	assert.match(normalizeFields({ email: "x" }).problem, /isn't a field name/);
	assert.match(normalizeFields({ note: "x".repeat(201) }).problem, /200 characters at most/);
	assert.match(normalizeFields({ note: { nested: true } }).problem, /a text or a number/);
	assert.match(normalizeFields(["x"]).problem, /an object/);
	assert.deepEqual(normalizeFields({ note: "line\r\nbreak" }).set, { note: "line break" }, "no line breaks reach a subject");
	assert.deepEqual(toFieldsUpdate(normalizeFields({ sun_sign: "leo", city: null })), {
		$set: { "fields.sun_sign": "leo" },
		$unset: { "fields.city": 1 },
	});
	assert.equal(toFieldsUpdate(normalizeFields({})), null);
});

test("merge tags print a contact's values escaped, or the fallback, and leave MailCheap's placeholders", () => {
	const values = getMergeValues({ ...mira, fields: { first_name: 'Mira <b>"V"</b>', sun_sign: "scorpio" } });
	assert.equal(
		mergeTags("<p>Hello {{first_name|there}}, {{sun_sign}} ({{life_path|?}}) from {{source}}. {{city}}!</p>", values),
		"<p>Hello Mira &lt;b&gt;&quot;V&quot;&lt;/b&gt;, scorpio (?) from quiz. !</p>"
	);
	assert.equal(mergeTags("{{first_name|there}}", {}), "there");
	assert.equal(mergeTags("{{first_name|dear reader}}", {}), "dear reader");
	assert.equal(mergeTags("{{unsubscribe_url}} {{subject}} {{confirm_url}}", values), "{{unsubscribe_url}} {{subject}} {{confirm_url}}");
	assert.equal(mergeTags("Hello {{ name }}", values), "Hello {{ name }}", "spaced braces are templates or code, not tags");
	assert.equal(mergeTags("{{first_name}}", values, { isHtml: false }), 'Mira <b>"V"</b>', "text parts aren't HTML");
	assert.equal(mergeSubject("{{first_name|Friend}}: your week", { first_name: "Noor\nX" }), "Noor X: your week");
	assert.deepEqual(findMergeTags("{{first_name|there}} {{sun_sign}} {{unsubscribe_url}} {{first_name}}"), ["first_name", "sun_sign"]);
});

test("each recipient's email carries their own values, in the subject, the HTML, the text and tracked links", () => {
	const campaign = {
		format: "html",
		subject: "{{sun_sign|Your sign}}: a week for second looks",
		previewText: "For you, {{first_name|reader}}",
		html: '<html><body><p>Hello {{first_name|there}},</p><a href="https://example.org/w?utm_term={{sun_sign|all}}">Read</a><a href="{{unsubscribe_url}}">Unsubscribe</a></body></html>',
	};
	const email = buildRecipientEmail({ campaign, newsletter, contact: mira, messageId: "6650f1c2e9b1d4a012345679" });
	assert.equal(email.subject, "scorpio: a week for second looks");
	assert.match(email.html, /Hello Mira,/);
	assert.match(email.html, /For you, Mira/, "the preview text too");
	assert.ok(!email.html.includes("utm_term={{"), "the link is filled before it's tracked");
	assert.match(email.html, /href="https:\/\/mail\.example\.com\/c\//);
	assert.match(email.text, /Hello Mira,/);
	assert.ok(email.html.includes(email.unsubscribeUrl));

	const stranger = buildRecipientEmail({ campaign, newsletter, contact: { _id: "64f1a2b3c4d5e6f7a8b9c0d3", email: "jonas@example.com" } });
	assert.equal(stranger.subject, "Your sign: a week for second looks");
	assert.match(stranger.html, /Hello there,/);
	assert.match(stranger.html, /utm_term=all/);
});

test("the archive page has no reader, so tags print their fallbacks", () => {
	assert.match(renderIssueBody({ format: "rich", html: "<p>Hello {{first_name|there}}</p>" }).html, /Hello there/);
	assert.match(renderIssueBody({ format: "markdown", markdown: "Hello {{first_name|there}}" }).html, /Hello there/);
	assert.match(renderIssueBody({ format: "html", html: "<html><body>Hi {{first_name|friend}}</body></html>" }).html, /Hi friend/);
});

test("audience filters match a field's values, null matching contacts without it", () => {
	const { filter } = normalizeFieldFilter({ sun_sign: ["Scorpio", "leo"], life_path: 7 });
	assert.deepEqual(filter, { sun_sign: ["scorpio", "leo"], life_path: ["7"] });
	assert.deepEqual(toFieldQuery(filter), { "fields.sun_sign": { $in: ["scorpio", "leo"] }, "fields.life_path": { $in: ["7"] } });
	assert.equal(matchesFieldFilter(mira.fields, filter), true);
	assert.equal(matchesFieldFilter({ sun_sign: "scorpio" }, filter), false, "every field has to match");
	assert.equal(matchesFieldFilter({}, normalizeFieldFilter({ sun_sign: null }).filter), true);
	assert.equal(matchesFieldFilter({}, {}), true, "no filter lets everyone in");
	assert.match(normalizeFieldFilter({ sun_sign: "dragon" }).problem, /sun_sign/);
	assert.match(normalizeFieldFilter({ sun_sign: [] }).problem, /1 to 50 values/);

	const contacts = [
		{ _id: 1, email: "mira@example.com", status: "active", fields: { sun_sign: "scorpio" } },
		{ _id: 2, email: "noor@example.com", status: "active", fields: { sun_sign: "leo" } },
		{ _id: 3, email: "jonas@example.com", status: "active" },
	];
	assert.deepEqual(
		selectAudience(contacts, { audienceFields: { sun_sign: ["scorpio"] } }).map(({ email }) => email),
		["mira@example.com"]
	);
	assert.equal(selectAudience(contacts).length, 3);
});

test("CSV files bring custom fields by their usual names or as fields.<name>, and a source", () => {
	const headers = ["Email", "First Name", "Zodiac Sign", "life_path", "fields.city", "MEMBER_RATING", "Source"];
	const fieldColumns = mapFieldColumns(headers);
	assert.deepEqual(fieldColumns, [
		["First Name", "first_name"],
		["Zodiac Sign", "sun_sign"],
		["life_path", "life_path"],
		["fields.city", "city"],
	]);
	const sourceColumn = mapSourceColumn(headers);
	const columns = mapColumns(headers);
	const row = normalizeImportRow(
		{ Email: "Mira@Example.com", "First Name": "Mira", "Zodiac Sign": "Scorpio", life_path: "11", "fields.city": "Utrecht", MEMBER_RATING: "4", Source: "quiz" },
		columns,
		{ fieldColumns, sourceColumn }
	);
	assert.deepEqual(row.fields, { first_name: "Mira", sun_sign: "scorpio", life_path: "11", city: "Utrecht" });
	assert.equal(row.source, "quiz");
	const badSign = normalizeImportRow({ Email: "noor@example.com", "Zodiac Sign": "dragon" }, columns, { fieldColumns });
	assert.equal(badSign.email, "noor@example.com", "a bad value leaves the field out, not the contact");
	assert.equal(badSign.fields, undefined);

	assert.deepEqual(sanitizeImportRow({ email: "mira@example.com", status: "active", fields: { sun_sign: "Leo", "bad key": "x", life_path: 99 }, source: "quiz" }), {
		email: "mira@example.com",
		status: "active",
		subscribedAt: undefined,
		emailsReceived: undefined,
		openRate: undefined,
		clickRate: undefined,
		fields: { sun_sign: "leo" },
		source: "quiz",
	});
});

test("exports write custom fields in columns the import reads back", () => {
	const header = getCsvHeader(["city", "sun_sign"]).trim().split(",");
	assert.deepEqual(header.slice(-2), ["fields.city", "sun_sign"]);
	assert.deepEqual(
		mapFieldColumns(header).map(([, key]) => key),
		["city", "sun_sign"]
	);
	const row = toCsvRow({ email: "mira@example.com", status: "active", fields: { sun_sign: "scorpio" } }, new Map(), ["city", "sun_sign"]);
	assert.ok(row.trim().endsWith(",,scorpio"));
});
