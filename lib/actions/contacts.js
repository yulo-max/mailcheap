import "server-only";
import { after } from "next/server";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { ERROR_CODES, hasActiveSubscription } from "@/lib/account-state";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import {
	FieldsOutput,
	afterCursor,
	dateOutput,
	encodeCursor,
	fieldsInput,
	findNewsletter,
	newsletterFilterInput,
	newsletterInput,
	readFieldFilter,
	toIso,
} from "@/lib/actions/shared";
import { sendAlert } from "@/lib/alerts";
import { withEngagement } from "@/lib/cleanup";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { FIELD_KEY_PATTERN, MAX_FIELD_VALUE_LENGTH, normalizeFields, readFields, toFieldQuery, toFieldsUpdate } from "@/lib/contact-fields";
import { importContacts as importContactRows } from "@/lib/contact-import";
import { contactSearchFilter, countContactsByStatus, getSignupProblem, removeContact, upsertContact } from "@/lib/contacts";
import { MAX_IMPORT_ROWS_PER_REQUEST, STATUS_RANK } from "@/lib/csv-import";
import { createExportToken } from "@/lib/export-token";
import { formatNumber, formatWindow } from "@/lib/format";
import { CONSENT_TEXT, DROP_REASONS } from "@/lib/import-checks";
import { getInbox } from "@/lib/inbox-links";
import { isRateLimited } from "@/lib/rate-limit";
import { queueConfirmationEmail, queueWelcomeEmail } from "@/lib/sending";
import { startSequences } from "@/lib/sequences";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import Contact, { CONTACT_STATUSES } from "@/models/Contact";

const GROUP = "Contacts";
// Each signup can send a welcome email, so a leaked key or a form without its own limit must not be
// able to flood the list. Sites that pass their visitor's IP get the archive form's per-visitor limit.
const SIGNUPS_PER_KEY = { name: "api-contacts-key", limit: 600, window: "1 h" };
const SIGNUPS_PER_VISITOR = { name: "api-contacts-ip", limit: 5, window: "10 m" };
// And an account gets a key's signups across all its keys, connected apps and contacts added by hand, who get the
// welcome email too.
const SIGNUPS_PER_ACCOUNT = { ...SIGNUPS_PER_KEY, name: "account-signups" };
// Enough to add yourself and try the dashboard without a plan, not enough to build a list for free.
const TRIAL_CONTACTS = { name: "contact-trial", limit: 3, window: "1 d" };
const IP_PATTERN = /^[0-9a-f.:]{3,45}$/i;
const SORT = { subscribedAt: -1, _id: -1 };

const contactReference = z.string().trim().min(1).max(320).describe("The contact's ID or email address");
const contactNewsletterInput = newsletterFilterInput.describe(
	"The newsletter's ID or slug, needed for an email address that is a contact of several newsletters"
);
const searchInput = z.string().trim().toLowerCase().max(254).optional().describe("Contacts whose email starts with this");
const statusInput = z.enum(CONTACT_STATUSES).optional().describe("Only contacts with this status");

const ContactSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	email: z.string(),
	status: z
		.enum(CONTACT_STATUSES)
		.describe(
			"active: gets issues. pending: hasn't confirmed yet. dormant: stopped by the list cleanup, back if they sign up again. unsubscribed, bounced, complained: final. bounced also covers a contact a send skipped because MailCheap knows the address can't receive email."
		),
	source: z.string().nullable(),
	fields: FieldsOutput,
	subscribedAt: dateOutput,
	confirmedAt: dateOutput,
	unsubscribedAt: dateOutput,
	lastSentAt: dateOutput,
	lastOpenAt: dateOutput,
	lastClickAt: dateOutput,
	stats: z.object({ sent: z.number().int(), opens: z.number().int(), clicks: z.number().int() }),
	createdAt: dateOutput,
});

function toContact(contact) {
	return {
		id: String(contact._id),
		newsletterId: String(contact.newsletterId),
		email: contact.email,
		status: contact.status,
		source: contact.source ?? null,
		fields: readFields(contact),
		subscribedAt: toIso(contact.subscribedAt),
		confirmedAt: toIso(contact.confirmedAt),
		unsubscribedAt: toIso(contact.unsubscribedAt),
		lastSentAt: toIso(contact.lastSentAt),
		lastOpenAt: toIso(contact.lastOpenAt),
		lastClickAt: toIso(contact.lastClickAt),
		stats: { sent: contact.stats?.sent ?? 0, opens: contact.stats?.opens ?? 0, clicks: contact.stats?.clicks ?? 0 },
		createdAt: toIso(contact.createdAt),
	};
}

// By ID or by address; an address in several newsletters needs the newsletter.
async function findContact(account, reference, newsletterReference) {
	const value = reference.toLowerCase();
	const newsletter = newsletterReference ? await findNewsletter(account, newsletterReference, { _id: 1 }) : null;
	const filter = isObjectIdString(value) ? { _id: value } : { email: normalizeEmail(value) ?? value };
	const [contact, other] = await Contact.find(scoped(account, { ...filter, ...(newsletter && { newsletterId: newsletter._id }) }))
		.sort({ createdAt: 1 })
		.limit(2)
		.lean();
	if (!contact) throw actionError("not_found", "Contact not found");
	if (other) throw actionError("validation_failed", "newsletter is required: this address is a contact of several newsletters");
	return contact;
}

function readFieldsInput(input) {
	const fields = normalizeFields(input);
	if (fields.problem) throw actionError("validation_failed", fields.problem);
	return fields;
}

// list_contacts takes one field and value: query strings carry no objects.
function readFieldQuery(input) {
	if (!input.field) {
		if (input.value !== undefined) throw actionError("validation_failed", "value: send field with it");
		return {};
	}
	return toFieldQuery(readFieldFilter({ [input.field]: input.value ?? null }, "field"));
}

// The key's and the visitor's limits first: a flood they stop doesn't use up the account's signups.
async function signupLimitProblem({ account, apiKey, connection, ip, via }) {
	const caller = apiKey ? String(apiKey._id) : connection && `oauth-${connection.id}`;
	if (apiKey && (await isRateLimited({ ...SIGNUPS_PER_KEY, key: caller }))) {
		await sendAlert({
			accountId: account._id,
			key: `api-signup-flood:${caller}`,
			title: "API signups paused",
			detail: `The "${apiKey.name}" key sent over ${SIGNUPS_PER_KEY.limit} signups in an hour. New ones are refused until it slows down. If that isn't your site, revoke the key.`,
			path: "/api-keys",
		});
		return "Too many signups, try again later";
	}
	if (caller && ip && (await isRateLimited({ ...SIGNUPS_PER_VISITOR, key: `${caller}:${ip}` }))) {
		return "Too many signups from this visitor, try again later";
	}
	if (!(await isRateLimited({ ...SIGNUPS_PER_ACCOUNT, key: String(account._id) }))) return null;
	if (via === "dashboard") return `You can add ${formatNumber(SIGNUPS_PER_ACCOUNT.limit)} contacts ${formatWindow(SIGNUPS_PER_ACCOUNT.window)}. Try again later.`;
	await sendAlert({
		accountId: account._id,
		key: "account-signup-flood",
		title: "Signups paused",
		detail: `Your API keys, connected apps and the dashboard added over ${SIGNUPS_PER_ACCOUNT.limit} contacts in an hour. New signups are refused until it slows down. If that isn't you, revoke the key or app on the API keys page.`,
		path: "/api-keys",
	});
	return "Too many signups on this account, try again later";
}

const listContacts = defineAction({
	name: "list_contacts",
	tryWithoutPlan: true,
	title: "List contacts",
	group: GROUP,
	description:
		"Lists contacts, newest signups first, 50 a page. Filter by newsletter, status, the start of the email address or a custom field's value; pass nextCursor back as cursor for the next page. counts has every status for the same filters.",
	http: { method: "GET", path: "/contacts" },
	readOnly: true,
	example: { status: "active", search: "jane" },
	input: z.object({
		newsletter: newsletterFilterInput,
		status: statusInput,
		search: searchInput,
		field: z.string().regex(FIELD_KEY_PATTERN).optional().describe("Only contacts with this custom field, e.g. sun_sign"),
		value: z
			.string()
			.max(MAX_FIELD_VALUE_LENGTH)
			.optional()
			.describe("With field: only contacts whose field has this value, e.g. scorpio. Without it, contacts that don't have the field."),
		limit: z.number().int().min(1).max(100).optional().describe("Contacts per page, 50 by default, 100 at most"),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({
		contacts: z.array(ContactSchema),
		nextCursor: z.string().nullable().describe("null on the last page"),
		counts: z.object(Object.fromEntries(CONTACT_STATUSES.map((status) => [status, z.number().int()]))),
	}),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const limit = input.limit ?? 50;
		const baseFilter = { ...contactSearchFilter(account, { newsletterId: newsletter?._id, query: input.search }), ...readFieldQuery(input) };
		const filter = {
			...baseFilter,
			...(input.status && { status: input.status }),
			...(input.cursor && afterCursor(input.cursor, "subscribedAt")),
		};
		const [contacts, counts] = await Promise.all([
			Contact.find(filter).sort(SORT).limit(limit + 1).lean(),
			countContactsByStatus(baseFilter),
		]);
		const page = contacts.slice(0, limit);
		const last = page.at(-1);
		return {
			contacts: page.map(toContact),
			nextCursor: contacts.length > limit ? encodeCursor(last.subscribedAt, last._id) : null,
			counts,
		};
	},
});

const getContact = defineAction({
	name: "get_contact",
	tryWithoutPlan: true,
	title: "Get a contact",
	group: GROUP,
	description: "Gets one contact by ID or email address, with its status, dates and engagement.",
	http: { method: "GET", path: "/contacts/{id}" },
	readOnly: true,
	input: z.object({ id: contactReference, newsletter: contactNewsletterInput }),
	output: ContactSchema,
	handler: async ({ account, input }) => toContact(await findContact(account, input.id, input.newsletter)),
});

const addContact = defineAction({
	name: "add_contact",
	tryWithoutPlan: true,
	title: "Add a contact",
	group: GROUP,
	description:
		"Signs someone up, like the archive's form: they get the welcome email, or the confirmation email when the newsletter asks new subscribers to confirm, and join the newsletter's active sequences once they're active. Custom fields (fields) are saved on new contacts and update existing ones. Signing up again keeps the contact's status as it is unless resubscribe is true. Works with signups only keys, for website forms. Signups and confirmation emails keep coming in over the plan's limits; welcome emails count toward the month's emails and are skipped once they're used up, never sent later (get_billing's usage.welcomeEmailsPaused). A misspelled domain (gmial.com) answers validation_failed with the address it was likely meant to be; spam trap addresses, domains that can't receive email, and addresses MailCheap knows can't receive email (they hard bounced or hit a spam trap, from any sender on MailCheap) answer validation_failed too.",
	http: { method: "POST", path: "/contacts", status: (output) => (output.created ? 201 : 200) },
	permission: "signups",
	openWorld: true,
	example: { email: "jane@example.com", source: "website", fields: { first_name: "Jane", sun_sign: "scorpio" } },
	input: z.object({
		newsletter: newsletterInput,
		email: z.string().trim().max(320).describe("The subscriber's email address"),
		source: z.string().trim().max(100).optional().describe("Where they signed up, e.g. website. Default: api."),
		fields: fieldsInput.optional(),
		resubscribe: z
			.boolean()
			.optional()
			.describe(
				"Bring back a contact who unsubscribed or went dormant. Bounced and complained addresses never come back, nor does a contact deleted after it unsubscribed."
			),
		ip: z.string().trim().max(45).optional().describe("The visitor's IP address: one visitor gets 5 signups in 10 minutes"),
	}),
	// Add contact's "This person agreed to get my emails" box: added by hand, they skip the confirmation email.
	dashboardInput: z.object({ consent: z.boolean().optional() }),
	output: z.object({
		id: z.string(),
		email: z.string(),
		newsletterId: z.string(),
		status: z.enum(CONTACT_STATUSES),
		created: z.boolean().describe("False when the address was already a contact"),
		inbox: z
			.object({ name: z.string(), url: z.string() })
			.nullable()
			.describe("For pending contacts on a known webmail: a link for a \"check your inbox\" button"),
	}),
	handler: async ({ account, user, apiKey, connection, input, via }) => {
		const isByHand = via === "dashboard";
		if (isByHand && input.consent !== true) throw actionError("validation_failed", "Check that this person agreed to get your emails");
		const email = normalizeEmail(input.email);
		if (!email) throw actionError("validation_failed", "email is invalid");
		const fields = readFieldsInput(input.fields);
		const ip = input.ip && IP_PATTERN.test(input.ip) ? input.ip : null;
		const limitProblem = await signupLimitProblem({ account, apiKey, connection, ip, via });
		if (limitProblem) throw actionError("rate_limited", limitProblem);
		const emailProblem = await getSignupProblem(email);
		if (emailProblem) throw actionError("validation_failed", emailProblem);

		const newsletter = await findNewsletter(account, input.newsletter);
		if (!hasActiveSubscription(account) && (await isRateLimited({ ...TRIAL_CONTACTS, key: String(account._id) }))) {
			throw actionError(ERROR_CODES.subscriptionRequired, "Pick a plan to add more contacts");
		}
		const { contact, created } = await upsertContact({
			newsletter,
			email,
			source: isByHand ? "dashboard" : input.source || "api",
			resubscribe: input.resubscribe === true,
			consent: isByHand ? { userId: user.id, at: new Date() } : null,
			fields,
		});
		// A pending contact who signs up again gets the confirmation again (throttled per address), unless it's
		// someone added by hand.
		const isPending = contact.status === "pending";
		const needsConfirmation = isPending && !isByHand;
		if (isSendingEnabled() && (needsConfirmation || (created && contact.status === "active"))) {
			const queue = needsConfirmation ? queueConfirmationEmail : queueWelcomeEmail;
			after(() =>
				queue({ newsletter, contact }).catch((error) => console.error(`[contacts] Signup email for ${contact._id} failed:`, error.message))
			);
		}
		if (created && contact.status === "active") {
			after(() =>
				startSequences({ newsletter, contact }).catch((error) => console.error(`[contacts] Sequences for ${contact._id} failed:`, error.message))
			);
		}
		return {
			id: String(contact._id),
			email: contact.email,
			newsletterId: String(newsletter._id),
			status: contact.status,
			created,
			inbox: isPending ? getInbox({ email: contact.email, fromEmail: newsletter.fromEmail }) : null,
		};
	},
});

const updateContactStatus = defineAction({
	name: "update_contact_status",
	tryWithoutPlan: true,
	title: "Unsubscribe or reactivate a contact",
	group: GROUP,
	description:
		"unsubscribed stops all emails to the contact, for good: only the person signing up again brings them back. active brings back a dormant contact; unsubscribes, bounces and complaints are final.",
	http: { method: "PATCH", path: "/contacts/{id}" },
	destructive: true,
	idempotent: true,
	example: { status: "unsubscribed" },
	input: z.object({
		id: contactReference,
		newsletter: contactNewsletterInput,
		status: z.enum(["active", "unsubscribed"]).describe("active (dormant contacts only) or unsubscribed"),
	}),
	output: ContactSchema,
	handler: async ({ account, input }) => {
		const contact = await findContact(account, input.id, input.newsletter);
		if (contact.status === input.status) return toContact(contact);
		// Reactivation starts the list cleanup over, or the next send would make them dormant again.
		const isReactivation = input.status === "active";
		const { modifiedCount } = await Contact.updateOne(
			scoped(account, { _id: contact._id, status: isReactivation ? "dormant" : { $in: ["active", "dormant", "pending"] } }),
			isReactivation ? withEngagement({ $set: { status: "active" } }) : { $set: { status: "unsubscribed", unsubscribedAt: new Date() } }
		);
		if (!modifiedCount) {
			throw actionError("conflict", isReactivation ? "Only dormant contacts can be reactivated" : "Status cannot change");
		}
		return toContact(await Contact.findOne(scoped(account, { _id: contact._id })).lean());
	},
});

const updateContactFields = defineAction({
	name: "update_contact_fields",
	tryWithoutPlan: true,
	title: "Update a contact's fields",
	group: GROUP,
	description:
		"Sets or removes a contact's custom fields, like first_name or sun_sign. Fields left out stay as they are; null removes one. Emails print them with {{name}} or {{name|fallback}}, and campaign audiences and sequence variants match them.",
	http: { method: "PATCH", path: "/contacts/{id}/fields" },
	idempotent: true,
	example: { fields: { first_name: "Mira", sun_sign: "scorpio", life_path: 7 } },
	input: z.object({ id: contactReference, newsletter: contactNewsletterInput, fields: fieldsInput }),
	output: ContactSchema,
	handler: async ({ account, input }) => {
		const contact = await findContact(account, input.id, input.newsletter);
		const update = toFieldsUpdate(readFieldsInput(input.fields));
		if (update) await Contact.updateOne(scoped(account, { _id: contact._id }), update);
		return toContact(await Contact.findOne(scoped(account, { _id: contact._id })).lean());
	},
});

const deleteContact = defineAction({
	name: "delete_contact",
	tryWithoutPlan: true,
	title: "Delete a contact",
	group: GROUP,
	description:
		"Deletes a contact from its newsletter, with its dates and engagement. It can't be undone. For a contact who unsubscribed, bounced or complained, MailCheap keeps a hash of the address so the newsletter never emails it again: import_contacts leaves it out, and add_contact or a signup form adds it back with that status. Any other contact can be added again like a new one.",
	http: { method: "DELETE", path: "/contacts/{id}" },
	destructive: true,
	idempotent: true,
	rateLimit: { limit: 120, window: "1 h" },
	input: z.object({ id: contactReference, newsletter: contactNewsletterInput }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const contact = await findContact(account, input.id, input.newsletter);
		if (!(await removeContact(account, contact))) throw actionError("conflict", "This contact just changed, try again");
		return { id: String(contact._id), deleted: true };
	},
});

const importContacts = defineAction({
	name: "import_contacts",
	title: "Import contacts",
	group: GROUP,
	description: `Adds up to ${MAX_IMPORT_ROWS_PER_REQUEST} contacts per call, with the same checks as the dashboard's CSV import: invalid, misspelled (gmial.com…), spam trap, role (info@, support@…), throwaway, duplicate and suppressed addresses, undeliverable ones (MailCheap knows they can't receive email: they hard bounced or hit a spam trap, from any sender on MailCheap), and addresses on domains that can't receive email, are left out and counted. consent must be true: "${CONSENT_TEXT}". Existing contacts keep their status unless a row gives a stricter one (unsubscribed, bounced, complained), which is final. No welcome emails go out and nobody joins a sequence. A row's fields fill in existing contacts' fields too. For more rows, send the next chunk with the importId of the first.`,
	http: { method: "POST", path: "/contacts/import" },
	destructive: true,
	idempotent: true,
	rateLimit: { limit: 120, window: "1 h" },
	// A file is one import: the dashboard sends it in chunks, and only the first counts.
	limitDashboard: (input) => !input.importId,
	example: {
		consent: true,
		contacts: [
			{ email: "jane@example.com", subscribedAt: "2025-03-01T00:00:00Z", fields: { first_name: "Jane", sun_sign: "leo" } },
			{ email: "sam@example.com", status: "unsubscribed" },
		],
	},
	input: z.object({
		newsletter: newsletterInput,
		consent: z.boolean().describe(`Must be true: ${CONSENT_TEXT}. Bought or scraped lists aren't allowed.`),
		contacts: z
			.array(
				z.object({
					email: z.string().max(1000).describe("Invalid addresses are left out and counted"),
					status: z
						.enum(Object.keys(STATUS_RANK))
						.optional()
						.describe("active (default), dormant, unsubscribed, bounced or complained"),
					subscribedAt: z.string().max(40).optional().describe("When they signed up, ISO 8601"),
					emailsReceived: z.number().min(0).optional().describe("Emails they got on the previous platform"),
					openRate: z.number().min(0).optional().describe("0 to 1, from the previous platform: sends reach the most engaged first"),
					clickRate: z.number().min(0).optional().describe("0 to 1, from the previous platform"),
					source: z.string().max(100).optional().describe("Where they signed up, for new contacts. Default: import."),
					fields: fieldsInput.optional().describe("Custom fields, as in add_contact. Values that don't fit a field are left out."),
				})
			)
			.max(MAX_IMPORT_ROWS_PER_REQUEST)
			.describe(`The rows, ${MAX_IMPORT_ROWS_PER_REQUEST} at most`),
		importId: z.string().max(100).optional().describe("The importId of the first chunk, to add rows to the same import"),
		duplicates: z.number().int().min(0).optional().describe("Duplicates you removed before sending, counted in the import's report"),
	}),
	output: z.object({
		importId: z.string(),
		created: z.number().int(),
		existing: z.number().int().describe("Already contacts: their status stays unless a row gave a stricter one"),
		dropped: z.object(Object.fromEntries(Object.keys(DROP_REASONS).map((reason) => [reason, z.number().int()]))),
	}),
	handler: async ({ account, user, apiKey, input, via }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const result = await importContactRows({
			account,
			userId: user?.id,
			apiKeyId: apiKey?._id,
			newsletterId: String(newsletter._id),
			rows: input.contacts.map((row) => ({ ...row, status: row.status ?? "active" })),
			consent: input.consent,
			importId: input.importId,
			duplicates: input.duplicates,
			source: via === "dashboard" ? "dashboard" : "api",
		});
		if (result.error) {
			throw actionError(result.error === "Import not found" ? "not_found" : "validation_failed", result.error);
		}
		return result;
	},
});

const exportContacts = defineAction({
	name: "export_contacts",
	title: "Export contacts",
	group: GROUP,
	description:
		"Makes a CSV download link for the contacts matching the filters, valid for an hour, no API key needed to open it. The columns go back in through the import as they are.",
	http: { method: "GET", path: "/contacts/export" },
	readOnly: true,
	rateLimit: { limit: 30, window: "1 h" },
	example: { status: "active" },
	input: z.object({ newsletter: newsletterFilterInput, status: statusInput, search: searchInput }),
	output: z.object({
		url: z.string().describe("The CSV file. Anyone with the link can download it until it expires."),
		expiresAt: z.string(),
		count: z.number().int().describe("Contacts in the file"),
	}),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const filters = { newsletterId: newsletter?._id, status: input.status, query: input.search };
		const count = await Contact.countDocuments({
			...contactSearchFilter(account, filters),
			...(input.status && { status: input.status }),
		});
		const { token, expiresAt } = createExportToken({ accountId: account._id, ...filters });
		return { url: `${getAppUrl()}/api/v1/contacts/export.csv?token=${token}`, expiresAt: expiresAt.toISOString(), count };
	},
});

export const contactActions = [
	listContacts,
	getContact,
	addContact,
	updateContactStatus,
	updateContactFields,
	deleteContact,
	importContacts,
	exportContacts,
];
