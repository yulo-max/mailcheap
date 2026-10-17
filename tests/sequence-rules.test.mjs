import assert from "node:assert/strict";
import { test } from "node:test";
import { getStepDueAt, getStepProblem, isQuietTime, outOfQuietHours, pickVariant } from "../lib/sequence-rules.js";

const DAY_MS = 86_400_000;

test("nothing is due between 03:00 and 06:00 in Amsterdam, summer or winter: it moves to 06:00", () => {
	// Summer time (UTC+2): 03:00 Amsterdam is 01:00 UTC.
	assert.equal(isQuietTime(new Date("2026-07-01T00:59:59Z")), false);
	assert.equal(isQuietTime(new Date("2026-07-01T01:00:00Z")), true);
	assert.equal(isQuietTime(new Date("2026-07-01T03:59:59Z")), true);
	assert.equal(isQuietTime(new Date("2026-07-01T04:00:00Z")), false);
	assert.equal(outOfQuietHours(new Date("2026-07-01T02:30:00Z")).toISOString(), "2026-07-01T04:00:00.000Z");
	// Winter time (UTC+1).
	assert.equal(outOfQuietHours(new Date("2026-12-10T02:00:00Z")).toISOString(), "2026-12-10T05:00:00.000Z");
	assert.equal(outOfQuietHours(new Date("2026-12-10T05:00:00Z")).toISOString(), "2026-12-10T05:00:00.000Z", "06:00 itself is fine");
	assert.equal(outOfQuietHours(new Date("2026-12-10T01:59:00Z")).toISOString(), "2026-12-10T01:59:00.000Z", "02:59 is fine");
	// The nights the clocks change: 02:00 jumps to 03:00 (29 March), 03:00 falls back to 02:00 (25 October).
	assert.equal(outOfQuietHours(new Date("2026-03-29T01:30:00Z")).toISOString(), "2026-03-29T04:00:00.000Z");
	assert.equal(isQuietTime(new Date("2026-10-25T01:30:00Z")), false, "02:30 the second time round");
	assert.equal(outOfQuietHours(new Date("2026-10-25T02:30:00Z")).toISOString(), "2026-10-25T05:00:00.000Z");
});

test("steps are due their days after joining, keep their distance when late, and stay out of the quiet hours", () => {
	const steps = [{ dayOffset: 0 }, { dayOffset: 1 }, { dayOffset: 3 }];
	const startedAt = new Date("2026-10-19T12:00:00Z");
	assert.equal(getStepDueAt({ startedAt, steps, index: 0 }).toISOString(), "2026-10-19T12:00:00.000Z");
	assert.equal(getStepDueAt({ startedAt, steps, index: 1, lastQueuedAt: startedAt }).toISOString(), "2026-10-20T12:00:00.000Z");
	// Step 2 queued two days late: step 3 waits its two days after it, not a few minutes.
	const late = new Date(startedAt.getTime() + 3 * DAY_MS);
	assert.equal(getStepDueAt({ startedAt, steps, index: 2, lastQueuedAt: late }).toISOString(), "2026-10-24T12:00:00.000Z");
	// Joined at 02:30 Amsterdam (summer): every step lands at 06:00 instead.
	const night = new Date("2026-07-01T01:30:00Z");
	assert.equal(getStepDueAt({ startedAt: night, steps, index: 0 }).toISOString(), "2026-07-01T04:00:00.000Z");
	assert.equal(getStepDueAt({ startedAt: night, steps, index: 1, lastQueuedAt: night }).toISOString(), "2026-07-02T04:00:00.000Z");
	assert.equal(getStepDueAt({ startedAt, steps, index: 3 }), null);
});

test("a contact gets the variant that matches its fields, else the fallback, else none", () => {
	const scorpio = { _id: "a", match: { sun_sign: ["scorpio"] } };
	const fire = { _id: "b", match: { sun_sign: ["leo", "aries", "sagittarius"] } };
	const fallback = { _id: "c" };
	const step = { variants: [scorpio, fire, fallback] };
	assert.equal(pickVariant(step, { fields: { sun_sign: "scorpio" } }), scorpio);
	assert.equal(pickVariant(step, { fields: { sun_sign: "leo" } }), fire);
	assert.equal(pickVariant(step, { fields: { sun_sign: "virgo" } }), fallback);
	assert.equal(pickVariant(step, {}), fallback);
	assert.equal(pickVariant({ variants: [scorpio] }, { fields: { sun_sign: "virgo" } }), null);
	assert.equal(pickVariant({ variants: [fallback, scorpio] }, { fields: { sun_sign: "scorpio" } }), scorpio, "a match wins over a fallback listed first");

	assert.equal(getStepProblem(step, 1), null);
	assert.equal(getStepProblem({ variants: [] }, 2), "Step 2: add at least one variant");
	assert.equal(getStepProblem({ variants: [fallback, { _id: "d" }] }, 3), "Step 3: one fallback variant at most");
});
