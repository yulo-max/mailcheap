import { hasFieldFilter, matchesFieldFilter, readFields } from "./contact-fields.js";
import { atHourOfDateKey, hourIn, toDateKey } from "./time-zone.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// No sequence email goes out in the small hours of Amsterdam's night: a step due then waits until it ends.
export const QUIET_HOURS = { timeZone: "Europe/Amsterdam", start: 3, end: 6 };
export const MAX_STEPS = 20;
export const MAX_VARIANTS = 30;
export const MAX_DAY_OFFSET = 365;

export function isQuietTime(date, quiet = QUIET_HOURS) {
	const hour = hourIn(date, quiet.timeZone);
	return hour >= quiet.start && hour < quiet.end;
}

// The time itself, or the end of the quiet hours it falls in.
export function outOfQuietHours(date, quiet = QUIET_HOURS) {
	if (!isQuietTime(date, quiet)) return date;
	return atHourOfDateKey(toDateKey(date, quiet.timeZone), quiet.end, quiet.timeZone);
}

// When a step is due: dayOffset days after the contact joined, and never closer to the step before than their offsets
// are apart, so steps that run late (a paused sequence, a blocked account) don't all land at once.
export function getStepDueAt({ startedAt, steps, index, lastQueuedAt }) {
	const step = steps[index];
	if (!step) return null;
	let due = new Date(startedAt).getTime() + step.dayOffset * DAY_MS;
	const previous = steps[index - 1];
	if (previous && lastQueuedAt) {
		due = Math.max(due, new Date(lastQueuedAt).getTime() + Math.max(0, step.dayOffset - previous.dayOffset) * DAY_MS);
	}
	return outOfQuietHours(new Date(due));
}

// The variant for a contact: the first whose match fits its fields, else the step's fallback, else none.
export function pickVariant(step, contact) {
	const fields = readFields(contact);
	const variants = step?.variants ?? [];
	return (
		variants.find((variant) => hasFieldFilter(variant.match) && matchesFieldFilter(fields, variant.match)) ??
		variants.find((variant) => !hasFieldFilter(variant.match)) ??
		null
	);
}

// What a step's variants can't be: a step needs at least one, and at most one fallback.
export function getStepProblem(step, position) {
	const label = `Step ${position}`;
	if (!step.variants?.length) return `${label}: add at least one variant`;
	if (step.variants.filter((variant) => !hasFieldFilter(variant.match)).length > 1) return `${label}: one fallback variant at most`;
	return null;
}

// The content a variant sends, in the shape lib/sending-rules.js renders.
export function getVariantContent(variant) {
	if (!variant) return null;
	return {
		format: variant.format,
		subject: variant.subject ?? "",
		previewText: variant.previewText ?? "",
		markdown: variant.markdown ?? "",
		html: variant.html ?? "",
	};
}
