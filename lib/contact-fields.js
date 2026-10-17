import { escapeHtml } from "./render-email.js";

// Custom fields on a contact (first_name, sun_sign…): set through the API, MCP and CSV imports, printed in emails with
// {{name}} or {{name|fallback}}, and matched by campaign audiences and sequence variants.
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_FIELDS = 30;
export const MAX_FIELD_VALUE_LENGTH = 200;
export const MAX_FILTER_VALUES = 50;
export const ZODIAC_SIGNS = [
	"aries",
	"taurus",
	"gemini",
	"cancer",
	"leo",
	"virgo",
	"libra",
	"scorpio",
	"sagittarius",
	"capricorn",
	"aquarius",
	"pisces",
];
export const LIFE_PATH_NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "11", "22", "33"];
// MailCheap's own placeholders, and what a contact already has outside its fields.
const RESERVED_KEYS = new Set(["unsubscribe_url", "confirm_url", "keep_url", "subject", "preview_text", "email", "source", "status"]);
// What a merge tag reads besides the fields: {{email}} and {{source}}.
const CONTACT_TAGS = ["email", "source"];
const SYSTEM_TAGS = new Set(["unsubscribe_url", "confirm_url", "keep_url", "subject", "preview_text"]);
// {{name}} or {{name|fallback}}, written tight: {{ name }} with spaces is left as written, as templates and code samples
// in an issue are. The fallback can't hold braces, so a tag never runs into the next one.
const TAG_PATTERN = /\{\{([a-z][a-z0-9_]{0,39})(?:\|([^{}]*))?\}\}/g;

// Known fields are checked so audiences and sequence variants can match them: one spelling per value.
const NORMALIZERS = {
	first_name: (value) => (value.length > 100 ? { problem: "first_name: 100 characters at most" } : { value }),
	sun_sign: (value) => {
		const sign = value.toLowerCase();
		return ZODIAC_SIGNS.includes(sign) ? { value: sign } : { problem: `sun_sign: one of ${ZODIAC_SIGNS.join(", ")}` };
	},
	life_path: (value) =>
		LIFE_PATH_NUMBERS.includes(value) ? { value } : { problem: `life_path: one of ${LIFE_PATH_NUMBERS.join(", ")}` },
};

export function isFieldKey(key) {
	return typeof key === "string" && FIELD_KEY_PATTERN.test(key) && !RESERVED_KEYS.has(key);
}

// One value as it's stored: trimmed text without control characters. { value } or { problem }.
export function normalizeFieldValue(key, raw) {
	if (typeof raw !== "string" && !(typeof raw === "number" && Number.isFinite(raw))) {
		return { problem: `${key}: a text or a number` };
	}
	// Control characters would end up in subject lines; spaces stay single.
	const value = String(raw)
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (value.length > MAX_FIELD_VALUE_LENGTH) return { problem: `${key}: ${MAX_FIELD_VALUE_LENGTH} characters at most` };
	if (!value) return { value: "" };
	return NORMALIZERS[key]?.(value) ?? { value };
}

// Fields to write: { set, unset, problem }. null or "" removes a field.
export function normalizeFields(input) {
	const set = {};
	const unset = [];
	if (input === undefined || input === null) return { set, unset, problem: null };
	if (typeof input !== "object" || Array.isArray(input)) return { set, unset, problem: "fields: an object of names and values" };
	for (const [key, raw] of Object.entries(input)) {
		if (!isFieldKey(key)) {
			return { set, unset, problem: `fields: ${key} isn't a field name. Use lowercase letters, digits and underscores, starting with a letter.` };
		}
		if (raw === null) {
			unset.push(key);
			continue;
		}
		const { value, problem } = normalizeFieldValue(key, raw);
		if (problem) return { set, unset, problem };
		if (value) set[key] = value;
		else unset.push(key);
	}
	if (Object.keys(set).length > MAX_FIELDS) return { set, unset, problem: `fields: ${MAX_FIELDS} at most` };
	return { set, unset, problem: null };
}

// The update for a contact's fields, or null when there's nothing to change.
export function toFieldsUpdate({ set, unset }) {
	const update = {};
	if (Object.keys(set).length > 0) update.$set = Object.fromEntries(Object.entries(set).map(([key, value]) => [`fields.${key}`, value]));
	if (unset.length > 0) update.$unset = Object.fromEntries(unset.map((key) => [`fields.${key}`, 1]));
	return Object.keys(update).length > 0 ? update : null;
}

// A contact's fields as a plain object, from a lean document or a Mongoose Map.
export function readFields(contact) {
	const fields = contact?.fields;
	if (!fields) return {};
	return fields instanceof Map ? Object.fromEntries(fields) : { ...fields };
}

// A filter on fields, as campaigns and sequence variants store it: each name to the values it accepts, null for a
// contact without the field. { filter, problem }: names in order, each value spelled as the field stores it.
export function normalizeFieldFilter(input) {
	if (input === undefined || input === null) return { filter: {}, problem: null };
	if (typeof input !== "object" || Array.isArray(input)) return { filter: {}, problem: "An object of field names and values" };
	const filter = {};
	for (const [key, raw] of Object.entries(input)) {
		if (!isFieldKey(key)) return { filter: {}, problem: `${key} isn't a field name` };
		const list = Array.isArray(raw) ? raw : [raw];
		if (list.length === 0 || list.length > MAX_FILTER_VALUES) return { filter: {}, problem: `${key}: 1 to ${MAX_FILTER_VALUES} values` };
		const values = [];
		for (const item of list) {
			if (item === null || item === "") {
				values.push(null);
				continue;
			}
			const { value, problem } = normalizeFieldValue(key, item);
			if (problem) return { filter: {}, problem };
			values.push(value || null);
		}
		filter[key] = [...new Set(values)];
	}
	if (Object.keys(filter).length > MAX_FIELDS) return { filter: {}, problem: `${MAX_FIELDS} fields at most` };
	return { filter, problem: null };
}

export function hasFieldFilter(filter) {
	return Object.keys(readFields({ fields: filter })).length > 0;
}

// The MongoDB conditions for a filter: every field has to match one of its values, and null matches a missing field.
export function toFieldQuery(filter) {
	return Object.fromEntries(Object.entries(readFields({ fields: filter })).map(([key, values]) => [`fields.${key}`, { $in: values }]));
}

export function matchesFieldFilter(fields, filter) {
	return Object.entries(readFields({ fields: filter })).every(([key, values]) => values.includes(fields?.[key] ?? null));
}

// What tags read for one contact: its fields, its address and where it signed up.
export function getMergeValues(contact) {
	const values = readFields(contact);
	for (const key of CONTACT_TAGS) if (contact?.[key]) values[key] = String(contact[key]);
	return values;
}

// Fills {{name}} and {{name|fallback}} with a contact's values: escaped for HTML, the fallback as written. A tag without
// a value or a fallback prints nothing. MailCheap's own placeholders stay for the steps after.
export function mergeTags(body, values = {}, { isHtml = true } = {}) {
	return String(body ?? "").replace(TAG_PATTERN, (tag, name, fallback) => {
		if (SYSTEM_TAGS.has(name)) return tag;
		const value = Object.hasOwn(values, name) ? values[name] : "";
		if (value) return isHtml ? escapeHtml(value) : value;
		return fallback?.trim() ?? "";
	});
}

// A subject line: no line breaks, whatever a value holds.
export function mergeSubject(subject, values) {
	return mergeTags(subject, values, { isHtml: false }).replace(/[\r\n]+/g, " ").trim();
}

// The names of the merge tags in a body, for the docs and checks.
export function findMergeTags(body) {
	return [...new Set([...String(body ?? "").matchAll(TAG_PATTERN)].map(([, name]) => name).filter((name) => !SYSTEM_TAGS.has(name)))];
}
