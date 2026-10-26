import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import {
	FieldFilterOutput,
	dateOutput,
	fieldFilterInput,
	findNewsletter,
	idInput,
	newsletterFilterInput,
	newsletterInput,
	readFieldFilter,
	toFieldFilterOutput,
	toIso,
} from "@/lib/actions/shared";
import { FIELD_KEY_PATTERN, hasFieldFilter, isFieldKey } from "@/lib/contact-fields";
import { loadSender } from "@/lib/sender";
import {
	MAX_DAY_OFFSET,
	MAX_HOURS_BETWEEN_STEPS,
	MAX_LATE_LIMIT_HOURS,
	MAX_STEPS,
	MAX_VARIANTS,
	QUIET_HOURS,
	getStepProblem,
	getVariantContent,
} from "@/lib/sequence-rules";
import { getSequenceStats, removeSequenceData, setEnrollmentsPaused } from "@/lib/sequences";
import { getSendProblem } from "@/lib/sending-rules";
import { MAX_BODY_BYTES, isObjectIdString } from "@/lib/validation";
import Newsletter from "@/models/Newsletter";
import Sequence, { SEQUENCE_FORMATS, SEQUENCE_STATUSES } from "@/models/Sequence";

const GROUP = "Sequences";
// Every step and variant lives in one document, which MongoDB caps at 16 MB.
const MAX_SEQUENCE_BYTES = 12_000_000;
const SUMMARY_FIELDS = { "steps.variants.html": 0, "steps.variants.markdown": 0 };
const QUIET = `Nothing goes out between ${String(QUIET_HOURS.start).padStart(2, "0")}:00 and ${String(QUIET_HOURS.end).padStart(2, "0")}:00 ${QUIET_HOURS.timeZone} time: a step due then waits until ${String(QUIET_HOURS.end).padStart(2, "0")}:00.`;
const HOW_IT_RUNS = `A contact joins every active sequence of its newsletter when it becomes active: at signup, or when it confirms if the newsletter asks new subscribers to confirm. Active contacts already there or imported join on the next cron run, from when they subscribed. Each step goes dayOffset days after joining, once per contact, in the variant whose match fits the contact's custom fields, or the step's fallback variant (no match); without either, the contact skips the step. Unsubscribing, bouncing or complaining stops the sequence for that contact. A step that goes late (sending off, a blocked account, a pause) still goes, and the next keeps its spacing after it; a step with lateLimitHours is skipped by contacts it reaches later than that, and one with skipAfterField by contacts whose time in that field has passed. Skipped steps send nothing: the contact goes on to the next step, and steps already due after it are looked at in the same run, one email at most per run. minHoursBetweenSteps keeps a contact's steps that many hours apart at least. ${QUIET} Steps take room in the plan's emails like welcome emails, are skipped once the month's emails are used up, and on MailCheap Cloud keep to the account's warm-up pace.`;

const sequenceId = idInput("sequence");
const nameInput = z.string().trim().min(1).max(100).describe("A name to find it by, 100 characters at most");
const variantInput = z.object({
	match: fieldFilterInput
		.optional()
		.describe(
			'The contacts this variant is for, by custom fields, e.g. { "sun_sign": "scorpio" } or { "sun_sign": ["leo", "aries"] }. Leave it out for the step\'s fallback, sent to contacts no other variant matches; one fallback per step.'
		),
	subject: z.string().trim().min(1).max(200).describe("Subject line, 200 characters at most. Merge tags like {{first_name|there}} work here too."),
	previewText: z.string().trim().max(300).optional().describe("Text inbox apps show after the subject, 300 characters at most"),
	format: z
		.enum(SEQUENCE_FORMATS)
		.optional()
		.describe("html (the default): a complete HTML email sent as is, with the footer added unless it contains {{unsubscribe_url}}. markdown or rich, as in create_campaign."),
	content: z.string().min(1).max(MAX_BODY_BYTES).describe("The body in that format, 500 KB at most"),
});
const stepInput = z.object({
	id: z.string().max(100).optional().describe("The step's ID, to keep it: contacts who got it don't get it again"),
	dayOffset: z.number().min(0).max(MAX_DAY_OFFSET).describe("Days after the contact joined, e.g. 0 right away, 1 a day later. Steps go in order, so offsets can't go down."),
	lateLimitHours: z
		.number()
		.int()
		.min(1)
		.max(MAX_LATE_LIMIT_HOURS)
		.optional()
		.describe(
			`For a time-limited email: a contact the step reaches more than this many hours after it was due (sending was off, the account was blocked, the sequence was paused) skips it and goes on to the next step. 1 to ${MAX_LATE_LIMIT_HOURS}. Leave it out to send late steps anyway.`
		),
	skipAfterField: z
		.string()
		.regex(FIELD_KEY_PATTERN, "Lowercase letters, digits and underscores, starting with a letter")
		.optional()
		.describe(
			'A custom field holding the contact\'s own deadline, e.g. "offer_expires_ts": unix seconds or an ISO 8601 date. A contact whose time has passed when the step is due skips it. Without the field, or with a value that isn\'t a time, the step goes.'
		),
	variants: z.array(variantInput).min(1).max(MAX_VARIANTS).describe(`Versions of the step's email, ${MAX_VARIANTS} at most`),
});
const stepsInput = z.array(stepInput).max(MAX_STEPS).describe(`The steps in order, ${MAX_STEPS} at most`);
const minHoursInput = z
	.number()
	.int()
	.min(0)
	.max(MAX_HOURS_BETWEEN_STEPS)
	.describe(
		`Hours a contact waits at least between two of its steps, even when their dayOffsets are closer or a step went late. 0 to ${MAX_HOURS_BETWEEN_STEPS}, 0 (the default) for no minimum.`
	);
const statusInput = z
	.enum(["active", "paused"])
	.describe("active: new contacts join and steps go out, after checks on every variant. paused: nobody joins and the contacts in it wait.");

const StepStatsSchema = z.object({
	queued: z.number().int().describe("Contacts it was queued for"),
	sent: z.number().int(),
	opened: z.number().int(),
	clicked: z.number().int(),
	bounced: z.number().int(),
});
const VariantSchema = z.object({
	id: z.string(),
	match: FieldFilterOutput.describe("The custom fields it's for, or null for the step's fallback"),
	subject: z.string(),
	previewText: z.string(),
	format: z.enum(SEQUENCE_FORMATS),
	bytes: z.number().int().describe("The content's size"),
	content: z.string().optional().describe("With includeContent"),
});
const StepSchema = z.object({
	id: z.string(),
	position: z.number().int().describe("1 for the first step"),
	dayOffset: z.number(),
	lateLimitHours: z.number().int().nullable().describe("Hours late after which contacts skip the step, or null to send it however late"),
	skipAfterField: z.string().nullable().describe("The custom field whose time, once past, makes contacts skip the step, or null"),
	variants: z.array(VariantSchema),
	stats: StepStatsSchema.optional().describe("get_sequence only"),
});
const SequenceSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	name: z.string(),
	status: z.enum(SEQUENCE_STATUSES).describe("draft: being written, nobody joins. active: contacts join and get its steps. paused: nobody joins, contacts in it wait."),
	minHoursBetweenSteps: z.number().int().describe("Hours a contact waits at least between two of its steps, 0 for no minimum"),
	steps: z.array(StepSchema),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});
const SequenceDetailSchema = SequenceSchema.extend({
	contacts: z
		.object({ active: z.number().int(), paused: z.number().int(), completed: z.number().int(), stopped: z.number().int() })
		.describe("Contacts in it: waiting for a step, held by a pause, through every step, or stopped because they left"),
});

function getContent(variant) {
	return (variant.format === "markdown" ? variant.markdown : variant.html) ?? "";
}

function toVariant(variant, includeContent) {
	const content = getContent(variant);
	return {
		id: String(variant._id),
		match: toFieldFilterOutput(variant.match),
		subject: variant.subject ?? "",
		previewText: variant.previewText ?? "",
		format: variant.format ?? "html",
		bytes: variant.bytes ?? Buffer.byteLength(content, "utf8"),
		...(includeContent && { content }),
	};
}

function toSequence(sequence, { includeContent = false, stats = null } = {}) {
	return {
		id: String(sequence._id),
		newsletterId: String(sequence.newsletterId),
		name: sequence.name,
		status: sequence.status,
		minHoursBetweenSteps: sequence.minHoursBetweenSteps ?? 0,
		steps: (sequence.steps ?? []).map((step, index) => ({
			id: String(step._id),
			position: index + 1,
			dayOffset: step.dayOffset,
			lateLimitHours: step.lateLimitHours ?? null,
			skipAfterField: step.skipAfterField ?? null,
			variants: (step.variants ?? []).map((variant) => toVariant(variant, includeContent)),
			...(stats && { stats: stats.steps[index] }),
		})),
		createdAt: toIso(sequence.createdAt),
		updatedAt: toIso(sequence.updatedAt),
	};
}

// Lists leave the content out, with each variant's size worked out by the database.
function findSummaries(filter) {
	return Sequence.aggregate([
		{ $match: filter },
		{ $sort: { createdAt: 1, _id: 1 } },
		{
			$set: {
				steps: {
					$map: {
						input: "$steps",
						as: "step",
						in: {
							_id: "$$step._id",
							dayOffset: "$$step.dayOffset",
							lateLimitHours: "$$step.lateLimitHours",
							skipAfterField: "$$step.skipAfterField",
							variants: {
								$map: {
									input: "$$step.variants",
									as: "variant",
									in: {
										_id: "$$variant._id",
										match: "$$variant.match",
										subject: "$$variant.subject",
										previewText: "$$variant.previewText",
										format: "$$variant.format",
										bytes: {
											$strLenBytes: {
												$ifNull: [{ $cond: [{ $eq: ["$$variant.format", "markdown"] }, "$$variant.markdown", "$$variant.html"] }, ""],
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	]);
}

async function findSequence(account, id, { withContent = true } = {}) {
	const query = isObjectIdString(id) ? Sequence.findOne(scoped(account, { _id: id })) : null;
	const sequence = query ? await (withContent ? query : query.select(SUMMARY_FIELDS)).lean() : null;
	if (!sequence) throw actionError("not_found", "Sequence not found");
	return sequence;
}

// A variant as stored: the same match keeps its ID, so messages queued for it still find their content.
function toStoredVariant(input, previous, position) {
	const match = readFieldFilter(input.match, `Step ${position}: match`);
	const format = input.format ?? "html";
	const kept = previous?.variants?.find((variant) => JSON.stringify(toFieldFilterOutput(variant.match)) === JSON.stringify(toFieldFilterOutput(match)));
	return {
		...(kept && { _id: kept._id }),
		...(hasFieldFilter(match) && { match }),
		subject: input.subject,
		previewText: input.previewText ?? "",
		format,
		[format === "markdown" ? "markdown" : "html"]: input.content,
	};
}

function toStoredStep(input, previous, position) {
	if (input.skipAfterField !== undefined && !isFieldKey(input.skipAfterField)) {
		throw actionError("validation_failed", `Step ${position}: skipAfterField: ${input.skipAfterField} isn't a field name`);
	}
	const step = {
		...(previous && { _id: previous._id }),
		dayOffset: input.dayOffset,
		...(input.lateLimitHours !== undefined && { lateLimitHours: input.lateLimitHours }),
		...(input.skipAfterField !== undefined && { skipAfterField: input.skipAfterField }),
		variants: input.variants.map((variant) => toStoredVariant(variant, previous, position)),
	};
	const problem = getStepProblem(step, position);
	if (problem) throw actionError("validation_failed", problem);
	return step;
}

// Steps from update_sequence: one with the ID of an existing step keeps it.
function toStoredSteps(inputs, existing = []) {
	return inputs.map((input, index) => {
		const previous = input.id ? existing.find(({ _id }) => String(_id) === input.id) : null;
		if (input.id && !previous) throw actionError("validation_failed", `Step ${index + 1}: no step has the ID ${input.id}`);
		return toStoredStep(input, previous, index + 1);
	});
}

function assertSteps(steps) {
	for (const [index, step] of steps.entries()) {
		if (index > 0 && step.dayOffset < steps[index - 1].dayOffset) {
			throw actionError("validation_failed", `Step ${index + 1}: its dayOffset can't be before step ${index}'s`);
		}
	}
	const bytes = steps.reduce((sum, step) => sum + step.variants.reduce((total, variant) => total + Buffer.byteLength(getContent(variant), "utf8"), 0), 0);
	if (bytes > MAX_SEQUENCE_BYTES) {
		throw actionError("validation_failed", `The sequence's content is ${Math.ceil(bytes / 1_000_000)} MB. The limit is ${MAX_SEQUENCE_BYTES / 1_000_000} MB.`);
	}
}

// What a send would refuse in any variant: the newsletter's from and postal addresses, subjects, content and size.
async function assertCanActivate(account, sequence) {
	if (sequence.steps.length === 0) throw actionError("validation_failed", "Add a step first");
	const newsletter = await Newsletter.findOne(scoped(account, { _id: sequence.newsletterId })).lean();
	const sender = newsletter ? await loadSender(account, newsletter) : null;
	for (const [index, step] of sequence.steps.entries()) {
		const stepProblem = getStepProblem(step, index + 1);
		if (stepProblem) throw actionError("validation_failed", stepProblem);
		for (const [variantIndex, variant] of step.variants.entries()) {
			const problem = getSendProblem({ campaign: getVariantContent(variant), newsletter, sender });
			if (!problem) continue;
			const code = problem === sender?.problem ? "sender_not_allowed" : "send_check_failed";
			throw actionError(code, `Step ${index + 1}, variant ${variantIndex + 1}: ${problem}`);
		}
	}
}

async function saveSequence(account, sequence, set) {
	const updated = await Sequence.findOneAndUpdate(scoped(account, { _id: sequence._id }), { $set: set }, { returnDocument: "after", runValidators: true }).lean();
	if (!updated) throw actionError("not_found", "Sequence not found");
	return updated;
}

const listSequences = defineAction({
	name: "list_sequences",
	tryWithoutPlan: true,
	title: "List sequences",
	group: GROUP,
	description: "Lists the account's sequences, oldest first: automated emails new subscribers get on a schedule, like a welcome series. Content is left out; get_sequence has it.",
	http: { method: "GET", path: "/sequences" },
	readOnly: true,
	input: z.object({ newsletter: newsletterFilterInput }),
	output: z.object({ sequences: z.array(SequenceSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const sequences = await findSummaries(scoped(account, newsletter ? { newsletterId: newsletter._id } : {}));
		return { sequences: sequences.map((sequence) => toSequence(sequence)) };
	},
});

const getSequence = defineAction({
	name: "get_sequence",
	tryWithoutPlan: true,
	title: "Get a sequence",
	group: GROUP,
	description: "Gets a sequence with its steps and variants, each step's emails queued, sent, opened and clicked, and how many contacts are in it.",
	http: { method: "GET", path: "/sequences/{id}" },
	readOnly: true,
	input: z.object({ id: sequenceId, includeContent: z.boolean().optional().describe("Include each variant's content") }),
	output: SequenceDetailSchema,
	handler: async ({ account, input }) => {
		const sequence = await findSequence(account, input.id);
		const stats = await getSequenceStats(account, sequence);
		return { ...toSequence(sequence, { includeContent: input.includeContent === true, stats }), contacts: stats.contacts };
	},
});

const createSequence = defineAction({
	name: "create_sequence",
	tryWithoutPlan: true,
	title: "Create a sequence",
	group: GROUP,
	description: `Creates a draft sequence: emails each new subscriber gets on a schedule, like a 5-step welcome series with a variant per sun sign. Nothing is sent until update_sequence makes it active. Steps can come now or one at a time with set_sequence_step. ${HOW_IT_RUNS}`,
	http: { method: "POST", path: "/sequences", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	example: {
		name: "Welcome series",
		steps: [
			{ dayOffset: 0, variants: [{ subject: "Welcome, {{first_name|friend}}", format: "markdown", content: "Thanks for joining." }] },
			{
				dayOffset: 1,
				variants: [
					{ match: { sun_sign: "scorpio" }, subject: "Scorpio: what your sign describes", content: "<p>…</p>" },
					{ subject: "What your sign describes", content: "<p>…</p>" },
				],
			},
		],
	},
	input: z.object({ newsletter: newsletterInput, name: nameInput, minHoursBetweenSteps: minHoursInput.optional(), steps: stepsInput.optional() }),
	output: SequenceSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const steps = toStoredSteps(input.steps ?? []);
		assertSteps(steps);
		const sequence = await Sequence.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			name: input.name,
			minHoursBetweenSteps: input.minHoursBetweenSteps ?? 0,
			steps,
		});
		return toSequence(sequence.toObject());
	},
});

const updateSequence = defineAction({
	name: "update_sequence",
	tryWithoutPlan: true,
	title: "Update a sequence",
	group: GROUP,
	description: `Renames a sequence, replaces its steps, or makes it active or paused. Send only what changes. Making it active checks every variant like a send would (from address, postal address, subject, content, size), and from then on new subscribers join it. Steps sent with their id keep it, so contacts who got a step don't get it again; contacts in the sequence go on from the step they're at. ${QUIET}`,
	http: { method: "PATCH", path: "/sequences/{id}" },
	idempotent: true,
	whileBlocked: true,
	example: { status: "active" },
	input: z.object({
		id: sequenceId,
		name: nameInput.optional(),
		status: statusInput.optional(),
		minHoursBetweenSteps: minHoursInput.optional(),
		steps: stepsInput.optional(),
	}),
	output: SequenceSchema,
	handler: async ({ account, input }) => {
		const sequence = await findSequence(account, input.id);
		const steps = input.steps ? toStoredSteps(input.steps, sequence.steps) : sequence.steps;
		if (input.steps) assertSteps(steps);
		const status = input.status ?? sequence.status;
		if (status === "active" && (input.status === "active" || input.steps)) await assertCanActivate(account, { ...sequence, steps });
		const updated = await saveSequence(account, sequence, {
			...(input.name !== undefined && { name: input.name }),
			...(input.minHoursBetweenSteps !== undefined && { minHoursBetweenSteps: input.minHoursBetweenSteps }),
			...(input.steps && { steps }),
			status,
		});
		if (status !== sequence.status && sequence.status !== "draft") await setEnrollmentsPaused(account, sequence._id, status === "paused");
		return toSequence(updated);
	},
});

const setSequenceStep = defineAction({
	name: "set_sequence_step",
	tryWithoutPlan: true,
	title: "Set a sequence step",
	group: GROUP,
	description:
		"Adds a step at the end of a sequence, or replaces the step at a position with new variants: one call per step keeps each request small, e.g. 12 sun-sign variants at a time. A replaced step keeps its ID, so contacts who got it don't get it again, and takes the settings sent: lateLimitHours or skipAfterField left out are removed. An active sequence checks the step like a send would.",
	http: { method: "POST", path: "/sequences/{id}/steps" },
	idempotent: true,
	rateLimit: { limit: 300, window: "1 h" },
	example: {
		position: 2,
		dayOffset: 1,
		variants: [
			{ match: { sun_sign: "scorpio" }, subject: "Scorpio: what your sign describes", content: "<p>…</p>" },
			{ subject: "What your sign describes", content: "<p>…</p>" },
		],
	},
	input: z.object({
		id: sequenceId,
		position: z.number().int().min(1).max(MAX_STEPS).describe("1 for the first step; one past the last adds a step"),
		dayOffset: stepInput.shape.dayOffset,
		lateLimitHours: stepInput.shape.lateLimitHours,
		skipAfterField: stepInput.shape.skipAfterField,
		variants: stepInput.shape.variants,
	}),
	output: SequenceSchema,
	handler: async ({ account, input }) => {
		const sequence = await findSequence(account, input.id);
		const index = input.position - 1;
		if (index > sequence.steps.length) throw actionError("validation_failed", `position: ${sequence.steps.length + 1} at most`);
		const step = toStoredStep(input, sequence.steps[index] ?? null, input.position);
		const steps = sequence.steps.toSpliced(index, 1, step);
		assertSteps(steps);
		if (sequence.status === "active") await assertCanActivate(account, { ...sequence, steps });
		return toSequence(await saveSequence(account, sequence, { steps }));
	},
});

const deleteSequence = defineAction({
	name: "delete_sequence",
	tryWithoutPlan: true,
	title: "Delete a sequence",
	group: GROUP,
	description: "Deletes a sequence and who's in it: no more of its steps go out, including those queued and not sent yet. It can't be undone; pausing it with update_sequence keeps everyone's place.",
	http: { method: "DELETE", path: "/sequences/{id}" },
	destructive: true,
	idempotent: true,
	whileBlocked: true,
	input: z.object({ id: sequenceId }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const sequence = await findSequence(account, input.id, { withContent: false });
		await Sequence.deleteOne(scoped(account, { _id: sequence._id }));
		await removeSequenceData(account, sequence._id);
		return { id: String(sequence._id), deleted: true };
	},
});

export const sequenceActions = [listSequences, getSequence, createSequence, updateSequence, setSequenceStep, deleteSequence];
