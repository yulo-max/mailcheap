import crypto from "node:crypto";
import { Types } from "mongoose";
import { scoped } from "@/lib/account-scope";
import { withEngagement } from "@/lib/cleanup";
import { getAppSecret } from "@/lib/config";
import { toFieldsUpdate } from "@/lib/contact-fields";
import { UNDELIVERABLE_MESSAGE, findGloballySuppressed } from "@/lib/global-suppressions";
import { getSignupEmailProblem } from "@/lib/import-checks";
import { findDomainsWithoutMail } from "@/lib/mail-domains";
import Contact, { CONTACT_STATUSES } from "@/models/Contact";
import DeletedContact from "@/models/DeletedContact";
import Newsletter from "@/models/Newsletter";
import Suppression from "@/models/Suppression";

export const CONTACTS_PAGE_SIZE = 50;
const FINAL_STATUSES = ["unsubscribed", "bounced", "complained"];

// Signup forms, add_contact and MCP, for one normalized address: what to tell the person typing it, or null. A listed
// address gets the same words whichever account's email listed it, its own included.
export async function getSignupProblem(email) {
	const problem = getSignupEmailProblem(email);
	if (problem) return problem;
	if ((await findGloballySuppressed([email])).size > 0) return UNDELIVERABLE_MESSAGE;
	const withoutMail = await findDomainsWithoutMail([email.split("@")[1]]);
	return withoutMail.size > 0 ? "This email's domain can't receive email" : null;
}

// An account's newsletters in creation order with their active contacts, counted from the index in the
// same round trip.
export function listNewslettersWithActiveCounts(account, fields) {
	return Newsletter.aggregate([
		{ $match: scoped(account) },
		{ $sort: { createdAt: 1, _id: 1 } },
		...(fields ? [{ $project: Object.fromEntries(fields.split(" ").map((field) => [field, 1])) }] : []),
		{
			$lookup: {
				from: Contact.collection.collectionName,
				localField: "_id",
				foreignField: "newsletterId",
				pipeline: [{ $match: { status: "active" } }, { $count: "count" }],
				as: "active",
			},
		},
		{ $set: { activeCount: { $ifNull: [{ $first: "$active.count" }, 0] } } },
		{ $unset: "active" },
	]);
}

function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The contacts list's filters: a newsletter and the start of an email address.
export function contactSearchFilter(account, { newsletterId, query }) {
	return scoped(account, {
		...(newsletterId && { newsletterId: new Types.ObjectId(String(newsletterId)) }),
		...(query && { email: { $regex: `^${escapeRegex(query)}` } }),
	});
}

export function countContactsByStatus(baseFilter) {
	return Promise.all(CONTACT_STATUSES.map((key) => Contact.countDocuments({ ...baseFilter, status: key }))).then((counts) =>
		Object.fromEntries(CONTACT_STATUSES.map((key, index) => [key, counts[index]]))
	);
}

// One page of the contacts list, newest first. One count per status reads only the status indexes;
// grouping the contacts would read every one.
export async function findContactsPage(account, { newsletterId, status, query, page = 1 }) {
	const baseFilter = contactSearchFilter(account, { newsletterId, query });
	const filter = { ...baseFilter, ...(status && { status }) };
	const [statusCounts, contacts] = await Promise.all([
		Promise.all(CONTACT_STATUSES.map((key) => Contact.countDocuments({ ...baseFilter, status: key }))),
		Contact.find(filter)
			.sort({ subscribedAt: -1, _id: -1 })
			.skip((page - 1) * CONTACTS_PAGE_SIZE)
			.limit(CONTACTS_PAGE_SIZE)
			.lean(),
	]);
	const counts = Object.fromEntries(CONTACT_STATUSES.map((key, index) => [key, statusCounts[index]]));
	const totalAll = statusCounts.reduce((sum, count) => sum + count, 0);
	return { contacts, counts, totalAll, total: status ? counts[status] || 0 : totalAll };
}

// Keyed like lib/deletion-records.js, since a plain hash of an email is easy to reverse with a list of emails, and
// salted with the newsletter, so one person's hashes don't match across newsletters.
function getDeletedEmailKey() {
	return Buffer.from(crypto.hkdfSync("sha256", getAppSecret(), "", "mailcheap-deleted-contact-v1", 32));
}

function hashDeletedEmail(key, newsletterId, email) {
	return crypto.createHmac("sha256", key).update(`${newsletterId}:${email}`).digest("base64url");
}

// The status each address had when it was deleted from the newsletter, for those deleted after they left.
export async function findDeletedStatuses({ accountId, newsletterId, emails }) {
	if (emails.length === 0) return new Map();
	const key = getDeletedEmailKey();
	const emailsByHash = new Map(emails.map((email) => [hashDeletedEmail(key, newsletterId, email), email]));
	const deleted = await DeletedContact.find({ accountId, newsletterId, emailHash: { $in: [...emailsByHash.keys()] } })
		.select({ emailHash: 1, status: 1 })
		.lean();
	return new Map(deleted.map(({ emailHash, status }) => [emailsByHash.get(emailHash), status]));
}

// A contact who unsubscribed, bounced or complained leaves its status behind, so its address added again is never
// emailed; any other can sign up again like anyone. False when the contact changed since it was read.
export async function removeContact(account, contact) {
	if (FINAL_STATUSES.includes(contact.status)) {
		const emailHash = hashDeletedEmail(getDeletedEmailKey(), contact.newsletterId, contact.email);
		await DeletedContact.updateOne(
			scoped(account, { newsletterId: contact.newsletterId, emailHash }),
			{ $set: { status: contact.status } },
			{ upsert: true }
		);
	}
	// Only as it was read: an unsubscribe landing in between would leave nothing behind.
	const { deletedCount } = await Contact.deleteOne(scoped(account, { _id: contact._id, status: contact.status }));
	return deletedCount === 1;
}

// Only an explicit resubscribe reverses an opt-out; bounces, complaints and a deleted contact's status never reverse.
const REACTIVATABLE_STATUSES = ["unsubscribed", "dormant"];
const SUPPRESSED_STATUSES = { bounce: "bounced", complaint: "complained", manual: "unsubscribed" };

// consent: a dashboard user's word that the person agreed, which stands in for the confirmation email. fields: custom
// fields to write ({ set, unset } from lib/contact-fields.js), on a new contact or one signing up again.
export async function upsertContact({ newsletter, email, source, resubscribe, consent, fields }) {
	const { accountId } = newsletter;
	const joinStatus = newsletter.requireConfirmation && !consent ? "pending" : "active";
	const [suppression, deletedStatuses] = await Promise.all([
		Suppression.findOne({ accountId, email }).select({ reason: 1 }).lean(),
		findDeletedStatuses({ accountId, newsletterId: newsletter._id, emails: [email] }),
	]);
	const deletedStatus = deletedStatuses.get(email);
	const status = suppression ? (SUPPRESSED_STATUSES[suppression.reason] ?? "unsubscribed") : (deletedStatus ?? joinStatus);
	const now = new Date();
	const fieldsUpdate = fields ? toFieldsUpdate(fields) : null;
	const result = await Contact.findOneAndUpdate(
		{ accountId, newsletterId: newsletter._id, email },
		{ $setOnInsert: { status, source, subscribedAt: now, ...(consent && { consent }) }, ...fieldsUpdate },
		{ upsert: true, returnDocument: "after", includeResultMetadata: true }
	).lean();
	const created = !result.lastErrorObject?.updatedExisting;
	const contact = result.value;

	if (created || !resubscribe || suppression || deletedStatus) return { contact, created };
	// Signing up again is a sign of life, and brings back a contact who left or went dormant.
	if (contact.status === "active") {
		await Contact.updateOne({ accountId, _id: contact._id }, withEngagement());
		return { contact, created };
	}
	if (!REACTIVATABLE_STATUSES.includes(contact.status)) return { contact, created };
	const reactivated = await Contact.findOneAndUpdate(
		{ accountId, _id: contact._id, status: { $in: REACTIVATABLE_STATUSES } },
		withEngagement({ $set: { status: joinStatus, subscribedAt: new Date() }, $unset: { unsubscribedAt: 1 } }),
		{ returnDocument: "after" }
	).lean();
	return { contact: reactivated ?? contact, created };
}

// The click on the confirmation link. A contact that already confirmed stays as it is.
export async function confirmContact({ accountId, contactId, newsletterId }) {
	const confirmed = await Contact.findOneAndUpdate(
		{ accountId, _id: contactId, newsletterId, status: "pending" },
		withEngagement({ $set: { status: "active", confirmedAt: new Date() } }),
		{ returnDocument: "after" }
	).lean();
	if (confirmed) return { contact: confirmed, confirmed: true };
	const contact = await Contact.findOne({ accountId, _id: contactId, newsletterId }).lean();
	return { contact, confirmed: false };
}

// The "Yes, keep sending it" click in the last-chance email. It also brings back a contact who went
// dormant; unsubscribes, bounces and complaints stay as they are.
export async function keepContact({ accountId, contactId, newsletterId }) {
	const contact = await Contact.findOne({ accountId, _id: contactId, newsletterId })
		.select({ email: 1, status: 1 })
		.lean();
	if (!contact || !["active", "dormant"].includes(contact.status)) return null;
	if (contact.status === "dormant" && (await Suppression.exists({ accountId, email: contact.email }))) return null;
	return Contact.findOneAndUpdate(
		{ accountId, _id: contact._id, status: { $in: ["active", "dormant"] } },
		withEngagement({ $set: { status: "active" } }),
		{ returnDocument: "after" }
	).lean();
}
