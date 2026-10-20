import assert from "node:assert/strict";
import { test } from "node:test";
import { getStepDueAt, getStepProblem, isQuietTime, isStepExpired, isStepStale, outOfQuietHours, pickVariant, readFieldTime } from "../lib/sequence-rules.js";

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

test("minHoursBetweenSteps keeps a contact's steps apart, out of the quiet hours too", () => {
	const steps = [{ dayOffset: 0 }, { dayOffset: 0 }, { dayOffset: 3 }];
	const startedAt = new Date("2026-10-19T12:00:00Z");
	assert.equal(getStepDueAt({ startedAt, steps, index: 1, lastQueuedAt: startedAt }).toISOString(), startedAt.toISOString(), "no minimum by default");
	assert.equal(getStepDueAt({ startedAt, steps, index: 1, lastQueuedAt: startedAt, minHoursBetweenSteps: 24 }).toISOString(), "2026-10-20T12:00:00.000Z");
	// Offsets further apart than the minimum keep their own spacing.
	assert.equal(getStepDueAt({ startedAt, steps, index: 2, lastQueuedAt: startedAt, minHoursBetweenSteps: 24 }).toISOString(), "2026-10-22T12:00:00.000Z");
	assert.equal(getStepDueAt({ startedAt, steps, index: 0, minHoursBetweenSteps: 24 }).toISOString(), startedAt.toISOString(), "the first step has nothing to wait for");
	// Queued at 01:30 Amsterdam (winter): 2 hours later is 03:30, so it waits until 06:00.
	const night = new Date("2026-12-10T00:30:00Z");
	assert.equal(getStepDueAt({ startedAt: night, steps, index: 1, lastQueuedAt: night, minHoursBetweenSteps: 2 }).toISOString(), "2026-12-10T05:00:00.000Z");
});

test("a step is stale past its lateLimitHours, and expired once the contact's time in skipAfterField has passed", () => {
	const dueAt = new Date("2026-10-19T12:00:00Z");
	const hours = (count) => new Date(dueAt.getTime() + count * 3_600_000);
	assert.equal(isStepStale({ dayOffset: 1 }, dueAt, hours(1000)), false, "no limit: never stale");
	assert.equal(isStepStale({ lateLimitHours: 24 }, dueAt, hours(24)), false, "24 hours late is still in time");
	assert.equal(isStepStale({ lateLimitHours: 24 }, dueAt, hours(24.01)), true);
	assert.equal(isStepStale({ lateLimitHours: 24 }, dueAt, hours(-1)), false);

	const step = { skipAfterField: "offer_expires_ts" };
	const now = new Date("2026-10-19T12:00:00Z");
	const seconds = now.getTime() / 1000;
	const contact = (value) => ({ fields: { offer_expires_ts: value } });
	assert.equal(isStepExpired(step, contact(String(seconds - 60)), now), true);
	assert.equal(isStepExpired(step, contact(String(seconds + 60)), now), false);
	assert.equal(isStepExpired(step, contact(seconds - 60), now), true, "a number");
	assert.equal(isStepExpired(step, contact("2026-10-19T11:00:00Z"), now), true);
	assert.equal(isStepExpired(step, contact("2026-10-20"), now), false);
	assert.equal(isStepExpired(step, contact("next friday"), now), false, "a value that isn't a time: the step goes");
	assert.equal(isStepExpired(step, {}, now), false, "no field: the step goes");
	assert.equal(isStepExpired({ dayOffset: 1 }, contact(String(seconds - 60)), now), false, "no skipAfterField");
	assert.equal(isStepExpired(step, { fields: new Map([["offer_expires_ts", String(seconds - 1)]]) }, now), true, "a Mongoose Map");
});

test("field times read unix seconds and ISO 8601 dates, and nothing else", () => {
	assert.equal(readFieldTime(1798761600), 1798761600000);
	assert.equal(readFieldTime("1798761600"), 1798761600000);
	assert.equal(readFieldTime(" 1798761600.5 "), 1798761600500);
	assert.equal(readFieldTime("2026-12-31T23:00:00Z"), Date.parse("2026-12-31T23:00:00Z"));
	assert.equal(readFieldTime("2026-12-31T23:00:00+01:00"), Date.parse("2026-12-31T22:00:00Z"));
	assert.equal(readFieldTime("2026-12-31"), Date.parse("2026-12-31"));
	for (const garbage of ["", "soon", "12/31/2026", "2026-13-45", "1e12", "-5", Number.NaN, Infinity, null, undefined, {}, true]) {
		assert.equal(readFieldTime(garbage), null, String(garbage));
	}
});
