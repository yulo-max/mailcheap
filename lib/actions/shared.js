import "server-only";
import { Types } from "mongoose";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { findOwnerEmail } from "@/lib/accounts";
import { actionError } from "@/lib/actions/errors";
import { isSendingEnabled } from "@/lib/config";
import { FIELD_KEY_PATTERN, MAX_FIELD_VALUE_LENGTH, MAX_FIELDS, MAX_FILTER_VALUES, normalizeFieldFilter } from "@/lib/contact-fields";
import { getUsage } from "@/lib/usage";
import { isObjectIdString } from "@/lib/validation";
import Newsletter from "@/models/Newsletter";

export const idInput = (thing) => z.string().trim().min(1).max(100).describe(`The ${thing}'s ID`);
const newsletterReference = z.string().trim().min(1).max(100).optional();
export const newsletterInput = newsletterReference.describe(
	"The newsletter's ID or slug. Default: the account's first newsletter, the one it has had longest."
);
export const newsletterFilterInput = newsletterReference.describe("Only this newsletter's: its ID or slug. Default: every newsletter.");

export const dateOutput = z.string().nullable();

// Custom contact fields (lib/contact-fields.js).
const fieldKey = z.string().regex(FIELD_KEY_PATTERN, "Lowercase letters, digits and underscores, starting with a letter");
const fieldValue = z.union([z.string().max(MAX_FIELD_VALUE_LENGTH), z.number()]);
export const fieldsInput = z
	.record(fieldKey, fieldValue.nullable())
	.describe(
		`Custom fields, e.g. { "first_name": "Mira", "sun_sign": "scorpio", "life_path": 7 }: ${MAX_FIELDS} at most, ${MAX_FIELD_VALUE_LENGTH} characters each, printed in emails with {{first_name}} or {{first_name|there}}. sun_sign is one of the 12 signs in English, life_path 1 to 9, 11, 22 or 33. null removes a field.`
	);
export const fieldFilterInput = z
	.record(fieldKey, z.union([fieldValue, z.array(fieldValue.nullable()).min(1).max(MAX_FILTER_VALUES)]).nullable())
	.describe(
		'Contacts whose custom fields match: each field to one value or a list, e.g. { "sun_sign": "scorpio" } or { "sun_sign": ["leo", "aries"], "life_path": 7 }. null in a list matches contacts without the field. Every field has to match.'
	);
export const FieldsOutput = z.record(z.string(), z.string()).describe("Custom fields");
export const FieldFilterOutput = z.record(z.string(), z.array(z.string().nullable())).nullable();

// A field filter from the API, as campaigns and sequences store it; empty is no filter.
export function readFieldFilter(input, label) {
	const { filter, problem } = normalizeFieldFilter(input);
	if (problem) throw actionError("validation_failed", `${label}: ${problem}`);
	return filter;
}

export function toFieldFilterOutput(filter) {
	return filter && Object.keys(filter).length > 0 ? filter : null;
}
const NO_LIMIT = "null on a self-hosted server without billing: no limit";
export const UsageSchema = z.object({
	emailsSent: z.number().int().describe("Emails sent this month, every kind counted"),
	emailsLimit: z.number().int().nullable().describe(NO_LIMIT),
	emailsLeft: z.number().int().nullable().describe(NO_LIMIT),
	subscribers: z.number().int().describe("Active contacts"),
	subscribersLimit: z.number().int().nullable().describe(NO_LIMIT),
	periodStart: dateOutput,
	periodEnd: dateOutput.describe("When the email count starts over"),
	welcomeEmailsPaused: z
		.boolean()
		.describe(
			"This month's emails are used up: new subscribers get no welcome email until the count starts over or the plan grows, and don't get it later. Confirmation emails still go out."
		),
});

export function toIso(value) {
	return value ? new Date(value).toISOString() : null;
}

export function toId(value) {
	return value ? String(value) : null;
}

// The position of a page's last item, in lists sorted newest first with ties broken by ID.
export function encodeCursor(date, id) {
	return Buffer.from(JSON.stringify([date.toISOString(), String(id)])).toString("base64url");
}

// The items after a cursor's position, on the date field the list is sorted by.
export function afterCursor(cursor, field) {
	const { date, id } = decodeCursor(cursor);
	return { $or: [{ [field]: { $lt: date } }, { [field]: date, _id: { $lt: id } }] };
}

function decodeCursor(cursor) {
	try {
		const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		const date = new Date(at);
		if (Number.isFinite(date.getTime()) && isObjectIdString(id)) return { date, id: new Types.ObjectId(id) };
	} catch {
		// Falls through to the error below.
	}
	throw actionError("validation_failed", "cursor: use the nextCursor of the previous page");
}

export async function getUsageOutput(account) {
	const usage = await getUsage(account);
	return {
		...usage,
		emailsLeft: usage.emailsLimit === null ? null : Math.max(0, usage.emailsLimit - usage.emailsSent),
		periodStart: toIso(usage.periodStart),
		periodEnd: toIso(usage.periodEnd),
	};
}

export function findFirstNewsletter(account, select) {
	const query = Newsletter.findOne(scoped(account)).sort({ createdAt: 1, _id: 1 });
	return (select ? query.select(select) : query).lean();
}

// By ID or slug. Without one, the account's first newsletter: a site's signup form or an agent set up while the
// account had one keeps reaching that one once there are more.
export async function findNewsletter(account, reference, select) {
	const value = reference?.trim().toLowerCase();
	if (!value) {
		const first = await findFirstNewsletter(account, select);
		if (!first) throw actionError("not_found", "Create a newsletter first");
		return first;
	}
	const query = Newsletter.findOne(scoped(account, isObjectIdString(value) ? { $or: [{ _id: value }, { slug: value }] } : { slug: value }));
	const found = await (select ? query.select(select) : query).lean();
	if (!found) throw actionError("not_found", "Newsletter not found");
	return found;
}

// Test emails go to the signed-in user, or to the account's owner when an API key asks.
export async function findTestRecipient({ account, user }) {
	return user?.email ?? (await findOwnerEmail(account._id));
}

export function assertSendingEnabled() {
	if (!isSendingEnabled()) throw actionError("sending_disabled", "Sending is off");
}

export function readPositiveInteger(value) {
	return Number.isInteger(value) && value > 0 ? value : undefined;
}
