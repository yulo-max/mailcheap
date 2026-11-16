import "server-only";
import mongoose from "mongoose";
import { connectDb } from "@/lib/db";
import { readFields } from "@/lib/contact-fields";
import { findGloballySuppressed } from "@/lib/global-suppressions";
import { pickVariant, readFieldTime } from "@/lib/sequence-rules";
import Contact from "@/models/Contact";
import Message from "@/models/Message";
import Sequence from "@/models/Sequence";
import SequenceEnrollment from "@/models/SequenceEnrollment";
import Suppression from "@/models/Suppression";

// A one-off repair: active enrollments waiting on one step, with a nextAt in a window, get the nextAt the caller gives
// each, pinned so the run doesn't pull it back to when the step was due. Spreads a crowd of sends due at once. A dry run
// lists them; nothing is sent here, the cron sends as always, and claimStepMessage stays the guard. Ids only, never an
// address.
const MAX_RESCHEDULE = 400;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const isObjectId = (value) => typeof value === "string" && mongoose.isValidObjectId(value) && /^[a-f0-9]{24}$/i.test(value);

function parseDate(value) {
	const date = new Date(value);
	return value && !Number.isNaN(date.getTime()) ? date : null;
}

function planEnrollment({ enrollment, step, contact, suppressed, stepSent, lastSentAt, now }) {
	const row = {
		enrollmentId: String(enrollment._id),
		contactId: String(enrollment.contactId),
		nextAt: enrollment.nextAt,
		lastQueuedAt: enrollment.lastQueuedAt ?? null,
		nextAtPinned: enrollment.nextAtPinned === true,
		lastSentAt,
	};
	if (!contact) return { ...row, fieldTime: null, eligible: false, reason: "contact_deleted" };
	const fields = readFields(contact);
	const time = step.skipAfterField ? readFieldTime(fields[step.skipAfterField]) : null;
	const plan = { ...row, fieldTime: time === null ? null : new Date(time) };
	if (contact.status !== "active") return { ...plan, eligible: false, reason: `contact_${contact.status}` };
	if (suppressed) return { ...plan, eligible: false, reason: suppressed };
	if (fields.purchased === "yes") return { ...plan, eligible: false, reason: "purchased" };
	if (stepSent) return { ...plan, eligible: false, reason: "step_sent" };
	// No variant fits the contact (the step isn't meant for them): the run would end it without an email.
	if (!pickVariant(step, contact)) return { ...plan, eligible: false, reason: "no_variant" };
	if (time !== null && time < now.getTime()) return { ...plan, eligible: false, reason: "time_passed" };
	return { ...plan, eligible: true };
}

export async function rescheduleEnrollments(body = {}) {
	const { sequenceId, step: index, execute = false, schedule = {} } = body;
	const nextAtFrom = parseDate(body.nextAtFrom);
	const nextAtTo = parseDate(body.nextAtTo);
	if (!isObjectId(sequenceId) || !Number.isInteger(index) || index < 0 || !nextAtFrom || !nextAtTo || nextAtTo <= nextAtFrom || nextAtTo - nextAtFrom > 2 * DAY_MS) {
		return { error: "sequenceId, step, nextAtFrom and nextAtTo (at most 2 days apart) are required" };
	}
	if (execute && (typeof schedule !== "object" || schedule === null || Object.keys(schedule).length === 0)) return { error: "execute needs a schedule" };
	await connectDb();
	const sequence = await Sequence.findOne({ _id: sequenceId }, null, { crossAccount: true }).lean();
	if (!sequence) return { error: "no such sequence" };
	if (sequence.status !== "active") return { error: `sequence is ${sequence.status}` };
	const { accountId } = sequence;
	const step = sequence.steps[index];
	if (!step) return { error: "no such step" };

	const enrollments = await SequenceEnrollment.find({
		accountId,
		sequenceId: sequence._id,
		status: "active",
		step: index,
		nextAt: { $gte: nextAtFrom, $lt: nextAtTo },
	})
		.sort({ nextAt: 1, _id: 1 })
		.limit(MAX_RESCHEDULE + 1)
		.lean();
	if (enrollments.length > MAX_RESCHEDULE) return { error: `more than ${MAX_RESCHEDULE} enrollments in the window` };
	const contactIds = enrollments.map(({ contactId }) => contactId);
	const [contacts, messages] = await Promise.all([
		Contact.find({ accountId, _id: { $in: contactIds } }).select({ email: 1, status: 1, fields: 1 }).lean(),
		Message.find({ accountId, kind: "sequence", sequenceId: sequence._id, contactId: { $in: contactIds } }).select({ contactId: 1, stepId: 1, createdAt: 1 }).lean(),
	]);
	const contactsById = new Map(contacts.map((contact) => [String(contact._id), contact]));
	const stepSent = new Set();
	const lastSentByContact = new Map();
	for (const { contactId, stepId, createdAt } of messages) {
		const key = String(contactId);
		if (String(stepId) === String(step._id)) stepSent.add(key);
		const last = lastSentByContact.get(key);
		if (createdAt && (!last || createdAt > last)) lastSentByContact.set(key, createdAt);
	}
	const emails = contacts.map(({ email }) => email);
	const [accountSuppressed, globallySuppressed] = await Promise.all([
		Suppression.distinct("email", { accountId, email: { $in: emails } }).then((list) => new Set(list)),
		findGloballySuppressed(emails),
	]);

	const now = new Date();
	const results = [];
	for (const enrollment of enrollments) {
		const key = String(enrollment.contactId);
		const contact = contactsById.get(key);
		const suppressed = !contact ? null : accountSuppressed.has(contact.email) ? "suppressed" : globallySuppressed.has(contact.email) ? "suppressed_global" : null;
		const plan = planEnrollment({ enrollment, step, contact, suppressed, stepSent: stepSent.has(key), lastSentAt: lastSentByContact.get(key) ?? null, now });
		if (!execute || !plan.eligible) {
			results.push(plan);
			continue;
		}
		const nextAt = parseDate(schedule[plan.enrollmentId]);
		if (!nextAt) {
			results.push({ ...plan, rescheduled: false, reason: "not_in_schedule" });
			continue;
		}
		// The contact's time has to outlast the new nextAt: else the run that picks the step up skips it.
		if (nextAt < now) {
			results.push({ ...plan, rescheduled: false, reason: "next_at_past" });
			continue;
		}
		if (plan.fieldTime && plan.fieldTime.getTime() < nextAt.getTime() + HOUR_MS) {
			results.push({ ...plan, rescheduled: false, reason: "time_too_close" });
			continue;
		}
		const { modifiedCount } = await SequenceEnrollment.updateOne(
			{ accountId, _id: enrollment._id, status: "active", step: enrollment.step, nextAt: enrollment.nextAt },
			{ $set: { nextAt, nextAtPinned: true } }
		);
		results.push({ ...plan, rescheduled: modifiedCount === 1, newNextAt: nextAt, ...(modifiedCount === 1 ? {} : { reason: "changed_meanwhile" }) });
	}
	const counts = {};
	for (const row of results) {
		const key = row.rescheduled ? "rescheduled" : row.eligible ? (execute ? `not_rescheduled:${row.reason}` : "eligible") : `skipped:${row.reason}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	console.info(`[sequence-reschedule] ${execute ? "execute" : "dry run"} ${JSON.stringify(counts)}`);
	return { dryRun: !execute, found: enrollments.length, counts, results };
}
