import "server-only";
import { getAccountSendProblem } from "@/lib/account-state";
import { getSendVolumes } from "@/lib/campaign-queries";
import { isSendingEnabled } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { mailboxProvider } from "@/lib/providers";
import { getPace, getPaceRoom } from "@/lib/send-spread";
import { getStepDueAt, isQuietTime, isStepExpired, isStepStale, pickVariant } from "@/lib/sequence-rules";
import { publishBatchRetry, publishMessages, sendMessageBatch } from "@/lib/sending";
import { MAX_BATCH_MESSAGES, chunk } from "@/lib/sending-rules";
import Account from "@/models/Account";
import Contact from "@/models/Contact";
import Message from "@/models/Message";
import Sequence from "@/models/Sequence";
import SequenceEnrollment from "@/models/SequenceEnrollment";

// Each run takes the steps due longest first, across accounts; the rest wait for the next run.
const DUE_PER_RUN = 2000;
const STEP_FIELDS = {
	newsletterId: 1,
	status: 1,
	minHoursBetweenSteps: 1,
	"steps._id": 1,
	"steps.dayOffset": 1,
	"steps.lateLimitHours": 1,
	"steps.skipAfterField": 1,
	"steps.variants._id": 1,
	"steps.variants.match": 1,
};

function isDuplicateKey(error) {
	return error?.code === 11000;
}

// One record per contact and step, whichever run gets there first: the second finds the first's.
async function claimStepMessage({ enrollment, sequence, step, variant, contact }) {
	const filter = {
		accountId: enrollment.accountId,
		kind: "sequence",
		sequenceId: sequence._id,
		stepId: step._id,
		contactId: contact._id,
	};
	const insert = {
		$setOnInsert: {
			newsletterId: sequence.newsletterId,
			variantId: variant._id,
			email: contact.email,
			provider: mailboxProvider(contact.email),
			status: "queued",
		},
	};
	try {
		return await Message.findOneAndUpdate(filter, insert, { upsert: true, returnDocument: "after" }).select({ status: 1 }).lean();
	} catch (error) {
		if (!isDuplicateKey(error)) throw error;
		return Message.findOne(filter).select({ status: 1 }).lean();
	}
}

// The enrollment moves on only from the step it was read at.
function moveEnrollment(enrollment, update) {
	return SequenceEnrollment.updateOne({ accountId: enrollment.accountId, _id: enrollment._id, status: "active", step: enrollment.step }, update);
}

function hasStepMessage({ enrollment, sequence, step }) {
	return Message.exists({
		accountId: enrollment.accountId,
		kind: "sequence",
		sequenceId: sequence._id,
		stepId: step._id,
		contactId: enrollment.contactId,
	});
}

function endEnrollment(enrollment, status, set = {}, update = {}) {
	return moveEnrollment(enrollment, { $set: { status, endedAt: new Date(), ...set }, $unset: { nextAt: 1 }, ...update });
}

// The enrollment's due step: its record, then the enrollment moves on. A run that stopped in between finds the record
// again and sends it if it's still queued: sends claim each message once.
async function queueDueStep({ enrollment, sequence, contact, now }) {
	if (!contact || contact.status !== "active") {
		await endEnrollment(enrollment, "stopped", { stoppedReason: contact?.status ?? "deleted" });
		return { stopped: true };
	}
	const { steps } = sequence;
	const spacing = { startedAt: enrollment.startedAt, steps, minHoursBetweenSteps: sequence.minHoursBetweenSteps };
	// Steps reached too late or past the contact's own time are skipped, and the ones after them already due are looked
	// at in the same run: a backlog comes down to the first step that can still go, and at most that one goes. The
	// enrollment's own step isn't skipped once it has a record: a run stopped after making it, and it still goes.
	let index = enrollment.step;
	let dueAt = enrollment.nextAt;
	let skipped = 0;
	while (steps[index] && dueAt <= now && (isStepStale(steps[index], dueAt, now) || isStepExpired(steps[index], contact, now))) {
		if (index === enrollment.step && (await hasStepMessage({ enrollment, sequence, step: steps[index] }))) break;
		skipped++;
		index++;
		dueAt = getStepDueAt({ ...spacing, index, lastQueuedAt: enrollment.lastQueuedAt });
	}
	const counted = skipped > 0 ? { $inc: { skippedSteps: skipped } } : {};
	const step = steps[index];
	if (!step) {
		await endEnrollment(enrollment, "completed", { step: index }, counted);
		return { completed: true, skipped };
	}
	if (dueAt > now) {
		await moveEnrollment(enrollment, { $set: { step: index, nextAt: dueAt }, ...counted });
		return { skipped };
	}
	const variant = pickVariant(step, contact);
	const message = variant ? await claimStepMessage({ enrollment, sequence, step, variant, contact }) : null;
	const next = index + 1;
	const isLast = next >= steps.length;
	const nextAt = isLast ? null : getStepDueAt({ ...spacing, index: next, lastQueuedAt: now });
	await moveEnrollment(
		enrollment,
		isLast
			? { $set: { step: next, status: "completed", lastQueuedAt: now, endedAt: now }, $unset: { nextAt: 1 }, ...counted }
			: { $set: { step: next, nextAt, lastQueuedAt: now }, ...counted }
	);
	return { messageId: message?.status === "queued" ? message._id : null, noVariant: !variant, skipped };
}

// The steps a run can queue for an account. MailCheap Cloud keeps sequences to the pace its warm-up allows a send
// (lib/send-spread.js): what fits at full speed next to the account's recent emails, one batch at least.
async function getRoom(account) {
	const pace = getPace(account, await getSendVolumes(account));
	return pace ? getPaceRoom(pace) : Infinity;
}

// Signups send their first step from the request itself, like a welcome email; runs publish send batches.
async function sendQueued(accountId, messageIds, { isSignup }) {
	if (messageIds.length === 0) return;
	if (!isSignup) {
		await publishMessages({ accountId, messageIds });
		return;
	}
	for (const ids of chunk(messageIds.map(String), MAX_BATCH_MESSAGES)) {
		const job = { accountId: String(accountId), messageIds: ids };
		const result = await sendMessageBatch(job);
		if (result.retry) await publishBatchRetry(job, result.retryAfter);
	}
}

async function runAccountSteps({ accountId, enrollments, now, isSignup = false }) {
	const result = { queued: 0, stopped: 0, completed: 0, noVariant: 0, skipped: 0, waiting: 0 };
	const account = await Account.findById(accountId).lean();
	// A blocked account or one without a plan sends nothing: its steps wait until it can.
	if (!account || getAccountSendProblem(account)) {
		result.waiting = enrollments.length;
		return result;
	}
	const room = await getRoom(account);
	const taken = enrollments.slice(0, room);
	result.waiting = enrollments.length - taken.length;
	const sequenceIds = [...new Set(taken.map(({ sequenceId }) => String(sequenceId)))];
	const [sequences, contacts] = await Promise.all([
		Sequence.find({ accountId, _id: { $in: sequenceIds } }).select(STEP_FIELDS).lean(),
		Contact.find({ accountId, _id: { $in: taken.map(({ contactId }) => contactId) } }).select({ email: 1, status: 1, fields: 1 }).lean(),
	]);
	const sequencesById = new Map(sequences.map((sequence) => [String(sequence._id), sequence]));
	const contactsById = new Map(contacts.map((contact) => [String(contact._id), contact]));

	const messageIds = [];
	for (const enrollment of taken) {
		const sequence = sequencesById.get(String(enrollment.sequenceId));
		if (sequence?.status !== "active") {
			result.waiting++;
			continue;
		}
		const outcome = await queueDueStep({ enrollment, sequence, contact: contactsById.get(String(enrollment.contactId)), now });
		if (outcome.messageId) {
			messageIds.push(outcome.messageId);
			result.queued++;
		}
		if (outcome.stopped) result.stopped++;
		if (outcome.completed) result.completed++;
		if (outcome.noVariant) result.noVariant++;
		result.skipped += outcome.skipped ?? 0;
	}
	await sendQueued(accountId, messageIds, { isSignup });
	return result;
}

function addUp(total, part) {
	for (const [key, value] of Object.entries(part)) total[key] = (total[key] ?? 0) + value;
	return total;
}

async function runDue(filter, { now, isSignup = false }) {
	const due = await SequenceEnrollment.find({ ...filter, status: "active", nextAt: { $lte: now } }, null, { crossAccount: true })
		.sort({ nextAt: 1, _id: 1 })
		.limit(DUE_PER_RUN)
		.lean();
	const byAccount = Map.groupBy(due, ({ accountId }) => String(accountId));
	const total = { accounts: byAccount.size, queued: 0, stopped: 0, completed: 0, noVariant: 0, skipped: 0, waiting: 0 };
	for (const [accountId, enrollments] of byAccount) {
		try {
			addUp(total, await runAccountSteps({ accountId, enrollments, now, isSignup }));
		} catch (error) {
			// One account's failure doesn't hold up the others; its steps are still due on the next run.
			console.error(`[sequences] Account ${accountId}: ${error.message}`);
			total.failedAccounts = (total.failedAccounts ?? 0) + 1;
		}
	}
	return total;
}

// Active contacts who missed joining (sequence activated later, or startSequences failed) get an enrollment dated
// from when they became active, so dayOffset math matches signup. Idempotent: existing enrollments stay put.
async function backfillMissingEnrollments({ now = new Date() } = {}) {
	const sequences = await Sequence.find({ status: "active" }, null, { crossAccount: true }).select({ ...STEP_FIELDS, accountId: 1, newsletterId: 1 }).lean();
	let inserted = 0;
	for (const sequence of sequences) {
		if (!sequence.steps?.length) continue;
		const contacts = await Contact.find(
			{ accountId: sequence.accountId, newsletterId: sequence.newsletterId, status: "active" },
			{ _id: 1, createdAt: 1, confirmedAt: 1 },
			{ lean: true }
		);
		for (const contact of contacts) {
			const startedAt = contact.confirmedAt ?? contact.createdAt ?? now;
			const nextAt = getStepDueAt({
				startedAt,
				steps: sequence.steps,
				index: 0,
				minHoursBetweenSteps: sequence.minHoursBetweenSteps,
			});
			try {
				const { upsertedId } = await SequenceEnrollment.updateOne(
					{ accountId: sequence.accountId, sequenceId: sequence._id, contactId: contact._id },
					{
						$setOnInsert: {
							newsletterId: sequence.newsletterId,
							status: "active",
							startedAt,
							step: 0,
							nextAt,
						},
					},
					{ upsert: true }
				);
				if (upsertedId) inserted++;
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
			}
		}
	}
	return { inserted };
}

// Enrollments whose nextAt drifted past a step that is already due from startedAt+dayOffset get pulled back so the
// cron can queue them (e.g. after lateLimit was cleared, or a missed cron window).
async function repairOverdueNextAt({ now = new Date() } = {}) {
	const sequences = await Sequence.find({ status: "active" }, null, { crossAccount: true }).select({ ...STEP_FIELDS, accountId: 1, newsletterId: 1 }).lean();
	const byId = new Map(sequences.map((s) => [String(s._id), s]));
	const enrollments = await SequenceEnrollment.find(
		{ status: "active", nextAt: { $gt: now } },
		null,
		{ crossAccount: true }
	).lean();
	let repaired = 0;
	for (const enrollment of enrollments) {
		const sequence = byId.get(String(enrollment.sequenceId));
		if (!sequence?.steps?.length) continue;
		const index = enrollment.step ?? 0;
		if (!sequence.steps[index]) continue;
		const dueAt = getStepDueAt({
			startedAt: enrollment.startedAt,
			steps: sequence.steps,
			index,
			lastQueuedAt: enrollment.lastQueuedAt,
			minHoursBetweenSteps: sequence.minHoursBetweenSteps,
		});
		if (!dueAt || dueAt > now) continue;
		const { modifiedCount } = await SequenceEnrollment.updateOne(
			{ accountId: enrollment.accountId, _id: enrollment._id, status: "active", step: enrollment.step, nextAt: enrollment.nextAt },
			{ $set: { nextAt: dueAt } }
		);
		if (modifiedCount) repaired++;
	}
	return { repaired };
}

// The cron's run (app/api/cron/sequences): every step due, in no account's quiet hours.
export async function runDueSequenceSteps({ now = new Date() } = {}) {
	if (!isSendingEnabled()) return { skipped: "sending is off" };
	if (isQuietTime(now)) return { skipped: "quiet hours" };
	await connectDb();
	const backfill = await backfillMissingEnrollments({ now });
	const repair = await repairOverdueNextAt({ now });
	return { ...backfill, ...repair, ...(await runDue({}, { now })) };
}

// A contact who just became active (signed up, or confirmed when the newsletter asks to) joins its newsletter's active
// sequences once, and gets what's due right away.
export async function startSequences({ newsletter, contact, now = new Date() }) {
	if (contact?.status !== "active") return { skipped: "contact is not active" };
	await connectDb();
	const { accountId } = newsletter;
	const sequences = await Sequence.find({ accountId, newsletterId: newsletter._id, status: "active" }).select(STEP_FIELDS).lean();
	const joined = [];
	for (const sequence of sequences) {
		if (sequence.steps.length === 0) continue;
		const nextAt = getStepDueAt({ startedAt: now, steps: sequence.steps, index: 0 });
		try {
			const { upsertedId } = await SequenceEnrollment.updateOne(
				{ accountId, sequenceId: sequence._id, contactId: contact._id },
				{ $setOnInsert: { newsletterId: newsletter._id, status: "active", startedAt: now, step: 0, nextAt } },
				{ upsert: true }
			);
			if (upsertedId) joined.push(upsertedId);
		} catch (error) {
			if (!isDuplicateKey(error)) throw error;
		}
	}
	if (joined.length === 0 || !isSendingEnabled() || isQuietTime(now)) return { joined: joined.length };
	return { joined: joined.length, ...(await runDue({ accountId, _id: { $in: joined } }, { now, isSignup: true })) };
}

// Pausing holds every contact in the sequence where it is; going on again picks up the steps due since, spaced out.
export async function setEnrollmentsPaused(account, sequenceId, isPaused) {
	const [from, to] = isPaused ? ["active", "paused"] : ["paused", "active"];
	await SequenceEnrollment.updateMany({ accountId: account._id, sequenceId, status: from }, { $set: { status: to } });
}

// A deleted sequence takes its contacts' places with it; its emails not sent yet never go.
export async function removeSequenceData(account, sequenceId) {
	await SequenceEnrollment.deleteMany({ accountId: account._id, sequenceId });
	await Message.updateMany(
		{ accountId: account._id, kind: "sequence", sequenceId, status: "queued" },
		{ $set: { status: "skipped", error: "The sequence was deleted" } }
	);
}

// Per step: contacts it was queued for, sent, opened, clicked, and those still in the sequence.
export async function getSequenceStats(account, sequence) {
	const [messages, enrollments] = await Promise.all([
		Message.aggregate([
			{ $match: { accountId: account._id, kind: "sequence", sequenceId: sequence._id } },
			{
				$group: {
					_id: "$stepId",
					queued: { $sum: 1 },
					sent: { $sum: { $cond: [{ $ifNull: ["$sentAt", false] }, 1, 0] } },
					opened: { $sum: { $cond: [{ $ifNull: ["$openedAt", false] }, 1, 0] } },
					clicked: { $sum: { $cond: [{ $ifNull: ["$clickedAt", false] }, 1, 0] } },
					bounced: { $sum: { $cond: [{ $ifNull: ["$bouncedAt", false] }, 1, 0] } },
				},
			},
		]),
		SequenceEnrollment.aggregate([
			{ $match: { accountId: account._id, sequenceId: sequence._id } },
			{ $group: { _id: "$status", count: { $sum: 1 } } },
		]),
	]);
	const byStep = new Map(messages.map(({ _id, ...counts }) => [String(_id), counts]));
	const contacts = Object.fromEntries(enrollments.map(({ _id, count }) => [_id, count]));
	return {
		steps: sequence.steps.map(({ _id }) => ({ queued: 0, sent: 0, opened: 0, clicked: 0, bounced: 0, ...byStep.get(String(_id)) })),
		contacts: { active: contacts.active ?? 0, paused: contacts.paused ?? 0, completed: contacts.completed ?? 0, stopped: contacts.stopped ?? 0 },
	};
}
