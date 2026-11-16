import "server-only";
import mongoose from "mongoose";
import { connectDb } from "@/lib/db";
import { readFields } from "@/lib/contact-fields";
import { findGloballySuppressed } from "@/lib/global-suppressions";
import { getStepDueAt, readFieldTime } from "@/lib/sequence-rules";
import Contact from "@/models/Contact";
import Message from "@/models/Message";
import Sequence from "@/models/Sequence";
import SequenceEnrollment from "@/models/SequenceEnrollment";
import Suppression from "@/models/Suppression";

// A one-off repair after an outage (16 Nov 2026): enrollments that ended because their steps with a skipAfterField
// came due while the cron was down, and the contact's time had passed by the time it ran. Once the contact has a new
// time (the app that owns the field sets it), the enrollment goes back to the first of those steps it has no message
// for, due at the time the caller gives it. A dry run lists them; nothing is sent here, the cron sends as always, and a
// step that already has a message is never picked (claimStepMessage stays the guard). Ids only, never an address.
const MAX_REOPEN = 200;
const DAY_MS = 86_400_000;
const isObjectId = (value) => typeof value === "string" && mongoose.isValidObjectId(value) && /^[a-f0-9]{24}$/i.test(value);

function parseDate(value) {
	const date = new Date(value);
	return value && !Number.isNaN(date.getTime()) ? date : null;
}

async function planEnrollment({ enrollment, sequence, contact, firstIndex, outageFrom, sentSteps, suppressed }) {
	const row = { enrollmentId: String(enrollment._id), contactId: String(enrollment.contactId), endedAt: enrollment.endedAt, skippedSteps: enrollment.skippedSteps };
	if (!contact) return { ...row, eligible: false, reason: "contact_deleted" };
	if (contact.status !== "active") return { ...row, eligible: false, reason: `contact_${contact.status}` };
	if (suppressed) return { ...row, eligible: false, reason: suppressed };
	const fields = readFields(contact);
	if (fields.purchased === "yes") return { ...row, eligible: false, reason: "purchased" };
	const { steps } = sequence;
	let index = firstIndex;
	while (index < steps.length && sentSteps.has(String(steps[index]._id))) index++;
	if (index >= steps.length) return { ...row, eligible: false, reason: "nothing_missing" };
	if (steps.slice(index + 1).some((step) => sentSteps.has(String(step._id)))) return { ...row, eligible: false, reason: "later_step_sent" };
	const step = steps[index];
	// When the step came due before the run that skipped it: a contact whose time had passed before the outage isn't one.
	const dueAt = getStepDueAt({ startedAt: enrollment.startedAt, steps, index, lastQueuedAt: enrollment.lastQueuedAt, minHoursBetweenSteps: sequence.minHoursBetweenSteps });
	const time = step.skipAfterField ? readFieldTime(fields[step.skipAfterField]) : null;
	const plan = { ...row, resumeStep: index, resumePosition: index + 1, resumeDayOffset: step.dayOffset, dueAt, fieldTime: time ? new Date(time) : null };
	if (dueAt < outageFrom) return { ...plan, eligible: false, reason: "due_before_outage" };
	if (time !== null && time < outageFrom.getTime()) return { ...plan, eligible: false, reason: "time_passed_before_outage" };
	return { ...plan, eligible: true };
}

export async function reopenSkippedEnrollments(body = {}) {
	const { sequenceId, execute = false, schedule = {} } = body;
	const endedFrom = parseDate(body.endedFrom);
	const endedTo = parseDate(body.endedTo);
	const outageFrom = parseDate(body.outageFrom);
	if (!isObjectId(sequenceId) || !endedFrom || !endedTo || !outageFrom || endedTo <= endedFrom || endedTo - endedFrom > 7 * DAY_MS) {
		return { error: "sequenceId, endedFrom, endedTo (at most 7 days apart) and outageFrom are required" };
	}
	if (execute && (typeof schedule !== "object" || Object.keys(schedule).length === 0)) return { error: "execute needs a schedule" };
	await connectDb();
	const sequence = await Sequence.findOne({ _id: sequenceId }, null, { crossAccount: true }).lean();
	if (!sequence) return { error: "no such sequence" };
	if (sequence.status !== "active") return { error: `sequence is ${sequence.status}` };
	const { accountId, steps } = sequence;
	const firstIndex = steps.findIndex((step) => step.skipAfterField);
	if (firstIndex < 0) return { error: "the sequence has no step with a skipAfterField" };

	const enrollments = await SequenceEnrollment.find({
		accountId,
		sequenceId: sequence._id,
		status: "completed",
		skippedSteps: { $gt: 0 },
		endedAt: { $gte: endedFrom, $lt: endedTo },
	})
		.sort({ endedAt: 1, _id: 1 })
		.limit(MAX_REOPEN + 1)
		.lean();
	if (enrollments.length > MAX_REOPEN) return { error: `more than ${MAX_REOPEN} enrollments in the window` };
	const contactIds = enrollments.map(({ contactId }) => contactId);
	const [contacts, messages] = await Promise.all([
		Contact.find({ accountId, _id: { $in: contactIds } }).select({ email: 1, status: 1, fields: 1 }).lean(),
		Message.find({ accountId, kind: "sequence", sequenceId: sequence._id, contactId: { $in: contactIds } }).select({ contactId: 1, stepId: 1 }).lean(),
	]);
	const contactsById = new Map(contacts.map((contact) => [String(contact._id), contact]));
	const sentByContact = new Map();
	for (const { contactId, stepId } of messages) {
		const key = String(contactId);
		if (!sentByContact.has(key)) sentByContact.set(key, new Set());
		sentByContact.get(key).add(String(stepId));
	}
	const emails = contacts.map(({ email }) => email);
	const [accountSuppressed, globallySuppressed] = await Promise.all([
		Suppression.distinct("email", { accountId, email: { $in: emails } }).then((list) => new Set(list)),
		findGloballySuppressed(emails),
	]);

	const now = new Date();
	const results = [];
	for (const enrollment of enrollments) {
		const contact = contactsById.get(String(enrollment.contactId));
		const suppressed = !contact ? null : accountSuppressed.has(contact.email) ? "suppressed" : globallySuppressed.has(contact.email) ? "suppressed_global" : null;
		const plan = await planEnrollment({ enrollment, sequence, contact, firstIndex, outageFrom, sentSteps: sentByContact.get(String(enrollment.contactId)) ?? new Set(), suppressed });
		if (!execute || !plan.eligible) {
			results.push(plan);
			continue;
		}
		const nextAt = parseDate(schedule[plan.enrollmentId]);
		if (!nextAt) {
			results.push({ ...plan, reopened: false, reason: "not_in_schedule" });
			continue;
		}
		// The contact needs its new time first: else the run that picks the step up skips it again.
		const step = steps[plan.resumeStep];
		const fields = readFields(contact);
		const time = step.skipAfterField ? readFieldTime(fields[step.skipAfterField]) : null;
		if (nextAt < now || (step.skipAfterField && (time === null || time < nextAt.getTime() + 3_600_000))) {
			results.push({ ...plan, reopened: false, reason: nextAt < now ? "next_at_past" : "time_not_refreshed" });
			continue;
		}
		const { modifiedCount } = await SequenceEnrollment.updateOne(
			{ accountId, _id: enrollment._id, status: "completed", step: enrollment.step },
			{ $set: { status: "active", step: plan.resumeStep, nextAt }, $unset: { endedAt: 1 } }
		);
		results.push({ ...plan, reopened: modifiedCount === 1, nextAt, ...(modifiedCount === 1 ? {} : { reason: "changed_meanwhile" }) });
	}
	const counts = {};
	for (const row of results) {
		const key = row.reopened ? "reopened" : row.eligible ? (execute ? `not_reopened:${row.reason}` : "eligible") : `skipped:${row.reason}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	console.info(`[sequence-reopen] ${execute ? "execute" : "dry run"} ${JSON.stringify(counts)}`);
	return { dryRun: !execute, found: enrollments.length, counts, results };
}
