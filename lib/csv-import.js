import { isFieldKey, normalizeFieldValue } from "./contact-fields.js";
import { normalizeAddress } from "./validation.js";

// Headers are compared without case, spaces or punctuation. Besides common names, these read the exports of
// Beehiiv, Substack, Mailchimp, Kit, MailerLite, Buttondown, Ghost and EmailOctopus as they are.
const COLUMN_ALIASES = {
	email: ["email", "emailaddress", "subscriberemail", "subscriber"],
	// Buttondown: subscriber_type.
	status: ["status", "subscriptionstatus", "subscriberstatus", "subscribertype"],
	subscribedAt: [
		"createdat",
		"created",
		"subscribedat",
		"subscribedate",
		"subscriptiondate",
		"datesubscribed",
		"signupdate",
		// Substack's subscribers page, Buttondown, Mailchimp.
		"startdate",
		"creationdate",
		"optintime",
		"confirmtime",
	],
	emailsReceived: ["emailsreceived", "totalemailsreceived", "received"],
	openRate: ["openrate", "uniqueopenrate", "totalopenrate"],
	clickRate: ["clickrate", "clickthroughrate", "uniqueclickrate", "ctr"],
	// Columns some platforms use instead of a status. A date here means the person left: Beehiiv's
	// unsubscribed_at, the UNSUB_TIME of Mailchimp's unsubscribed file, Buttondown's unsubscription_date.
	unsubscribedAt: ["unsubscribedat", "unsubtime", "unsubscriptiondate", "canceledat", "cancelledat"],
	// Mailchimp's cleaned file: addresses that bounced.
	cleanedAt: ["cleantime"],
	// Ghost: false for members who get no newsletter.
	subscribedToEmails: ["subscribedtoemails"],
	// Substack: true for readers whose emails are off.
	emailDisabled: ["emaildisabled"],
};

// Custom fields (lib/contact-fields.js) a file can carry: these by their usual names, any other as fields.<name>, the
// way exports write them. Other columns are skipped, so a platform's dozens of columns don't become fields.
export const FIELD_COLUMN_PREFIX = "fields.";
const FIELD_ALIASES = {
	first_name: ["firstname", "fname", "givenname"],
	sun_sign: ["sunsign", "zodiacsign", "zodiac", "starsign"],
	life_path: ["lifepath", "lifepathnumber"],
};
const SOURCE_ALIASES = ["source", "signupsource"];
const MAX_SOURCE_LENGTH = 100;

const STATUS_ALIASES = {
	active: "active",
	subscribed: "active",
	// Kit: cold readers are confirmed ones who stopped opening.
	confirmed: "active",
	cold: "active",
	// Buttondown's types for readers who get emails, paying or not.
	regular: "active",
	premium: "active",
	gifted: "active",
	trialed: "active",
	churning: "active",
	churned: "active",
	pastdue: "active",
	inactive: "unsubscribed",
	unsubscribed: "unsubscribed",
	cancelled: "unsubscribed",
	canceled: "unsubscribed",
	// Taken off the list by the writer (Buttondown, Kit).
	removed: "unsubscribed",
	blocked: "unsubscribed",
	bounced: "bounced",
	invalid: "bounced",
	hardbounce: "bounced",
	cleaned: "bounced",
	undeliverable: "bounced",
	complained: "complained",
	spam: "complained",
	spamreport: "complained",
	junk: "complained",
	pending: "dormant",
	unconfirmed: "dormant",
	unactivated: "dormant",
	validating: "dormant",
	needsattention: "dormant",
	dormant: "dormant",
};

// An import can only move a contact to a stricter status, never back to active.
export const STATUS_RANK = { active: 0, dormant: 1, unsubscribed: 2, bounced: 3, complained: 4 };

export const MAX_IMPORT_ROWS_PER_REQUEST = 1000;

function normalizeKey(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

export function mapColumns(headers) {
	const normalized = headers.map((header) => [header, normalizeKey(header)]);
	return Object.fromEntries(
		Object.entries(COLUMN_ALIASES).map(([field, aliases]) => [
			field,
			normalized.find(([, key]) => aliases.includes(key))?.[0] ?? null,
		])
	);
}

// The headers the import reads as custom fields: [header, field name] pairs.
export function mapFieldColumns(headers) {
	const pairs = [];
	for (const header of headers) {
		const text = String(header ?? "").trim();
		const key = text.toLowerCase().startsWith(FIELD_COLUMN_PREFIX)
			? text.slice(FIELD_COLUMN_PREFIX.length).trim().toLowerCase()
			: Object.entries(FIELD_ALIASES).find(([name, aliases]) => name === text.toLowerCase() || aliases.includes(normalizeKey(text)))?.[0];
		if (isFieldKey(key) && !pairs.some(([, name]) => name === key)) pairs.push([header, key]);
	}
	return pairs;
}

// The header a field gets in an export, which the import reads back.
export function getFieldColumn(key) {
	return Object.hasOwn(FIELD_ALIASES, key) ? key : `${FIELD_COLUMN_PREFIX}${key}`;
}

export function mapSourceColumn(headers) {
	return headers.find((header) => SOURCE_ALIASES.includes(normalizeKey(header))) ?? null;
}

// What the import reads each header as (a field of COLUMN_ALIASES), or null for a column it skips.
export function getColumnFields(headers) {
	const mapped = Object.entries(mapColumns(headers));
	return headers.map((column) => ({ column, field: mapped.find(([, header]) => header === column)?.[0] ?? null }));
}

// The same syntax as every other address in MailCheap (lib/validation.js).
export function normalizeEmail(value) {
	return normalizeAddress(String(value ?? ""));
}

export function normalizeStatus(value) {
	if (value === undefined || value === null || String(value).trim() === "") return "active";
	return STATUS_ALIASES[normalizeKey(value)] ?? "dormant";
}

export function normalizeRate(value) {
	const text = String(value ?? "").trim();
	if (!text) return undefined;
	const number = Number.parseFloat(text.replace("%", ""));
	if (!Number.isFinite(number) || number < 0) return undefined;
	const rate = text.includes("%") || number > 1 ? number / 100 : number;
	return Math.min(rate, 1);
}

function normalizeCount(value) {
	const number = Number.parseInt(String(value ?? "").replace(/[^\d]/g, ""), 10);
	return Number.isFinite(number) ? number : undefined;
}

// "2023-03-24 10:23:10 UTC" (Beehiiv), "2024-03-13 00:03:09.183465+00:00" (Buttondown), "2018-02-12 10:54:27"
// (Mailchimp): browsers disagree on dates with a space, so these are rewritten as ISO 8601 first.
const SPACED_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?\s*(z|utc|gmt|[+-]\d{2}:?\d{2})?$/i;

function toIsoOffset(zone) {
	if (!zone || /^(z|utc|gmt)$/i.test(zone)) return "Z";
	return zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
}

export function normalizeDate(value) {
	const text = String(value ?? "").trim();
	if (!text) return undefined;
	// Unix time, in seconds or milliseconds.
	if (/^\d{9,13}$/.test(text)) return new Date(Number(text) * (text.length <= 10 ? 1000 : 1)).toISOString();
	const spaced = SPACED_DATE_PATTERN.exec(text);
	const time = Date.parse(spaced ? `${spaced[1]}T${spaced[2]}${(spaced[3] ?? "").slice(0, 4)}${toIsoOffset(spaced[4])}` : text);
	return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function readBoolean(value) {
	const key = normalizeKey(value);
	if (["true", "yes", "1"].includes(key)) return true;
	if (["false", "no", "0"].includes(key)) return false;
	return null;
}

function stricterStatus(statuses) {
	return statuses.reduce((strictest, status) => (STATUS_RANK[status] > STATUS_RANK[strictest] ? status : strictest));
}

// The status column, then the columns that say someone left without one: the strictest of them wins.
function readFileStatus(row, columns) {
	const statuses = [columns.status ? normalizeStatus(row[columns.status]) : "active"];
	if (columns.unsubscribedAt && String(row[columns.unsubscribedAt] ?? "").trim()) statuses.push("unsubscribed");
	if (columns.cleanedAt && String(row[columns.cleanedAt] ?? "").trim()) statuses.push("bounced");
	if (columns.subscribedToEmails && readBoolean(row[columns.subscribedToEmails]) === false) statuses.push("unsubscribed");
	if (columns.emailDisabled && readBoolean(row[columns.emailDisabled]) === true) statuses.push("unsubscribed");
	return stricterStatus(statuses);
}

// A row's custom fields, valid values only: a bad value leaves the field out, not the contact.
function readRowFields(row, fieldColumns = []) {
	const fields = {};
	for (const [header, key] of fieldColumns) {
		const { value } = normalizeFieldValue(key, String(row[header] ?? ""));
		if (value) fields[key] = value;
	}
	return fields;
}

function readSource(value) {
	const source = String(value ?? "").trim().slice(0, MAX_SOURCE_LENGTH);
	return source || undefined;
}

// fieldColumns and sourceColumn: from mapFieldColumns and mapSourceColumn, when the file has them.
export function normalizeImportRow(row, columns, { status: statusOverride, fieldColumns, sourceColumn } = {}) {
	const email = normalizeEmail(row[columns.email]);
	if (!email) return null;

	const fileStatus = readFileStatus(row, columns);
	const status =
		statusOverride && STATUS_RANK[statusOverride] > STATUS_RANK[fileStatus] ? statusOverride : fileStatus;

	const fields = readRowFields(row, fieldColumns);
	const source = sourceColumn ? readSource(row[sourceColumn]) : undefined;
	return {
		email,
		status,
		subscribedAt: columns.subscribedAt ? normalizeDate(row[columns.subscribedAt]) : undefined,
		emailsReceived: columns.emailsReceived ? normalizeCount(row[columns.emailsReceived]) : undefined,
		openRate: columns.openRate ? normalizeRate(row[columns.openRate]) : undefined,
		clickRate: columns.clickRate ? normalizeRate(row[columns.clickRate]) : undefined,
		...(Object.keys(fields).length > 0 && { fields }),
		...(source && { source }),
	};
}

// Fields from the browser or the API: valid names and values only.
function sanitizeRowFields(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const fields = {};
	for (const [key, raw] of Object.entries(input)) {
		if (!isFieldKey(key)) continue;
		const { value } = normalizeFieldValue(key, raw);
		if (value) fields[key] = value;
	}
	return Object.keys(fields).length > 0 ? fields : undefined;
}

function optionalNumber(value, max) {
	const number = Number(value);
	return value === undefined || value === null || !Number.isFinite(number) || number < 0
		? undefined
		: Math.min(number, max);
}

// Server side: rows come from the browser, so every field is checked again.
export function sanitizeImportRow(row) {
	const email = normalizeEmail(row?.email);
	if (!email || !Object.hasOwn(STATUS_RANK, row?.status)) return null;
	const subscribedAt = row.subscribedAt ? new Date(row.subscribedAt) : undefined;
	const fields = sanitizeRowFields(row.fields);
	const source = typeof row.source === "string" ? readSource(row.source) : undefined;

	return {
		email,
		status: row.status,
		subscribedAt: subscribedAt && Number.isFinite(subscribedAt.getTime()) ? subscribedAt : undefined,
		emailsReceived: optionalNumber(row.emailsReceived, 1_000_000),
		openRate: optionalNumber(row.openRate, 1),
		clickRate: optionalNumber(row.clickRate, 1),
		...(fields && { fields }),
		...(source && { source }),
	};
}
