import { isValidObjectId } from "mongoose";
import { findDeletedStatuses } from "@/lib/contacts";
import { findGloballySuppressed } from "@/lib/global-suppressions";
import { findDomainsWithoutMail } from "@/lib/mail-domains";
import Contact from "../models/Contact.js";
import ContactImport from "../models/ContactImport.js";
import Newsletter from "../models/Newsletter.js";
import Suppression from "../models/Suppression.js";
import { scoped } from "./account-scope.js";
import { MAX_IMPORT_ROWS_PER_REQUEST, STATUS_RANK, sanitizeImportRow } from "./csv-import.js";
import { CONSENT_TEXT, emptyDropped, getDropReason } from "./import-checks.js";

const SUPPRESSION_REASONS = { bounced: "bounce", complained: "complaint" };

// Rows that only record a past unsubscribe, bounce or complaint get no emails, so they skip the checks.
function getsEmails({ status }) {
	return STATUS_RANK[status] <= STATUS_RANK.dormant;
}

function domainOf(email) {
	return email.split("@")[1];
}

function weakerStatuses(status) {
	return Object.keys(STATUS_RANK).filter((key) => STATUS_RANK[key] < STATUS_RANK[status]);
}

// One upsert per contact: new contacts take the file's status, existing ones keep theirs.
// A row's custom fields fill in existing contacts too; fields a row leaves out stay as they are.
export function getContactWrites({ accountId, newsletterId, contacts, source, importId }) {
	return contacts.map(({ email, status, subscribedAt, emailsReceived, openRate, clickRate, fields, source: rowSource }) => {
		const imported = Object.entries({ emailsReceived, openRate, clickRate }).filter(
			([, value]) => value !== undefined
		);
		const set = [
			...imported.map(([key, value]) => [`imported.${key}`, value]),
			...Object.entries(fields ?? {}).map(([key, value]) => [`fields.${key}`, value]),
		];
		return {
			updateOne: {
				filter: { accountId, newsletterId, email },
				update: {
					$setOnInsert: {
						status,
						source: rowSource ?? source,
						...(importId && { importId }),
						subscribedAt: subscribedAt ?? new Date(),
						...(status === "unsubscribed" && { unsubscribedAt: new Date() }),
					},
					...(set.length > 0 && { $set: Object.fromEntries(set) }),
				},
				upsert: true,
			},
		};
	});
}

// Each status the rows move existing contacts to, with the weaker statuses it replaces. Nothing moves a
// contact to active, and pending has no rank, so a contact waiting to confirm stays as it is.
export function getStatusChanges(contacts) {
	return Object.entries(Object.groupBy(contacts, ({ status }) => status))
		.filter(([status]) => status !== "active")
		.map(([status, group]) => ({
			status,
			emails: group.map(({ email }) => email),
			replaces: weakerStatuses(status),
		}));
}

// Rows that would get emails are checked; rows that only record a past unsubscribe, bounce or complaint
// always go in, so those people stay out.
export function checkImportRows(rows) {
	const dropped = emptyDropped();
	const byEmail = new Map();
	for (const row of rows) {
		const contact = sanitizeImportRow(row);
		if (!contact) dropped.invalid++;
		else if (byEmail.has(contact.email)) dropped.duplicate++;
		else byEmail.set(contact.email, contact);
	}
	const contacts = [];
	for (const contact of byEmail.values()) {
		const reason = getsEmails(contact) && getDropReason(contact.email);
		if (reason) dropped[reason]++;
		else contacts.push(contact);
	}
	return { contacts, dropped };
}

// Never deletes and never moves a contact back to a weaker status: an unsubscribe, bounce or
// complaint always wins.
async function writeContacts({ accountId, newsletterId, contacts, source, importId }) {
	if (contacts.length === 0) return { created: 0, existing: 0 };
	const result = await Contact.bulkWrite(getContactWrites({ accountId, newsletterId, contacts, source, importId }), {
		ordered: false,
	});

	const changes = getStatusChanges(contacts);
	for (const { status, emails, replaces } of changes) {
		await Contact.updateMany(
			{ accountId, newsletterId, email: { $in: emails }, status: { $in: replaces } },
			{ $set: { status, ...(status === "unsubscribed" && { unsubscribedAt: new Date() }) } }
		);
	}

	const suppressed = changes.filter(({ status }) => SUPPRESSION_REASONS[status]);
	if (suppressed.length > 0) {
		await Suppression.bulkWrite(
			suppressed.flatMap(({ status, emails }) =>
				emails.map((email) => ({
					updateOne: {
						filter: { accountId, email },
						update: { $setOnInsert: { reason: SUPPRESSION_REASONS[status], detail: source } },
						upsert: true,
					},
				}))
			),
			{ ordered: false }
		);
	}

	return { created: result.upsertedCount, existing: result.matchedCount };
}

// One call per chunk of a file: the first creates the import, later ones pass its importId. The dashboard
// counts duplicates across the whole file and sends them with the first chunk. Same checks for every source.
export async function importContacts({ account, userId, apiKeyId, newsletterId, rows, consent, importId, duplicates = 0, source = "dashboard" }) {
	if (!isValidObjectId(newsletterId)) return { error: "Newsletter not found" };
	if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS_PER_REQUEST) return { error: "Too many rows" };
	const newsletter = await Newsletter.findOne(scoped(account, { _id: newsletterId })).select({ _id: 1 }).lean();
	if (!newsletter) return { error: "Newsletter not found" };
	if (consent !== true) return { error: "Confirm that these people agreed to receive your emails" };

	let contactImport;
	if (importId) {
		contactImport = isValidObjectId(importId)
			? await ContactImport.findOne(scoped(account, { _id: importId, newsletterId: newsletter._id })).select({ _id: 1 }).lean()
			: null;
		if (!contactImport) return { error: "Import not found" };
	} else {
		contactImport = await ContactImport.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			userId,
			apiKeyId,
			source,
			consent: true,
			consentText: CONSENT_TEXT,
			consentAt: new Date(),
		});
	}

	const checked = checkImportRows(rows);
	const dropped = { ...checked.dropped, duplicate: checked.dropped.duplicate + Math.max(0, Math.floor(Number(duplicates) || 0)) };
	const emailsToCheck = checked.contacts.filter(getsEmails).map(({ email }) => email);
	const [suppressed, deleted, undeliverable] = await Promise.all([
		Suppression.distinct("email", { accountId: account._id, email: { $in: emailsToCheck } }),
		findDeletedStatuses({ accountId: account._id, newsletterId: newsletter._id, emails: emailsToCheck }),
		findGloballySuppressed(emailsToCheck),
	]);
	const suppressedEmails = new Set([...suppressed, ...deleted.keys()]);
	const unsuppressed = checked.contacts.filter((contact) => !getsEmails(contact) || !suppressedEmails.has(contact.email));
	dropped.suppressed += checked.contacts.length - unsuppressed.length;
	const deliverable = unsuppressed.filter((contact) => !getsEmails(contact) || !undeliverable.has(contact.email));
	dropped.undeliverable += unsuppressed.length - deliverable.length;
	// Every email to a domain without a mail server bounces, and bounces count against the account.
	const domainsWithoutMail = await findDomainsWithoutMail(deliverable.filter(getsEmails).map(({ email }) => domainOf(email)));
	const contacts = deliverable.filter((contact) => !getsEmails(contact) || !domainsWithoutMail.has(domainOf(contact.email)));
	dropped.noMail += deliverable.length - contacts.length;

	const written = await writeContacts({ accountId: account._id, newsletterId: newsletter._id, contacts, source: "import", importId: contactImport._id });
	await ContactImport.updateOne(scoped(account, { _id: contactImport._id }), {
		$inc: {
			rows: rows.length,
			created: written.created,
			existing: written.existing,
			...Object.fromEntries(Object.entries(dropped).map(([reason, count]) => [`dropped.${reason}`, count])),
		},
	});
	return { importId: String(contactImport._id), ...written, dropped };
}
