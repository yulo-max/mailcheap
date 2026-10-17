import { matchesFieldFilter, readFields, toFieldQuery } from "./contact-fields.js";

// Most engaged first, so warm-up sends capped by audienceLimit reach likely openers.
export const AUDIENCE_SORT = {
	lastClickAt: -1,
	lastOpenAt: -1,
	"imported.clickRate": -1,
	"imported.openRate": -1,
	createdAt: 1,
	_id: 1,
};

function normalizeLimit(audienceLimit) {
	const limit = Number(audienceLimit);
	return Number.isInteger(limit) && limit > 0 ? limit : null;
}

// audienceFields: only contacts whose fields match (lib/contact-fields.js).
export function buildAudienceQuery({ accountId, newsletterId, suppressedEmails = [], audienceLimit, audienceFields }) {
	const filter = { accountId, newsletterId, status: "active", ...toFieldQuery(audienceFields) };
	if (suppressedEmails.length > 0) filter.email = { $nin: suppressedEmails };
	return { filter, sort: AUDIENCE_SORT, limit: normalizeLimit(audienceLimit) };
}

function readPath(document, path) {
	return path.split(".").reduce((value, key) => value?.[key], document);
}

function toComparable(value) {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "object") return String(value);
	return value;
}

// Same order as MongoDB: a missing value is the lowest, so it sorts last when descending.
function compareValues(left, right, direction) {
	const isLeftMissing = left == null;
	const isRightMissing = right == null;
	if (isLeftMissing || isRightMissing) {
		if (isLeftMissing && isRightMissing) return 0;
		return (isLeftMissing ? -1 : 1) * direction;
	}
	const a = toComparable(left);
	const b = toComparable(right);
	if (a === b) return 0;
	return (a < b ? -1 : 1) * direction;
}

export function compareByEngagement(left, right) {
	for (const [path, direction] of Object.entries(AUDIENCE_SORT)) {
		const result = compareValues(readPath(left, path), readPath(right, path), direction);
		if (result !== 0) return result;
	}
	return 0;
}

export function selectAudience(contacts, { suppressedEmails = [], audienceLimit, audienceFields } = {}) {
	const suppressed = new Set(suppressedEmails);
	const limit = normalizeLimit(audienceLimit);
	const audience = contacts
		.filter((contact) => contact.status === "active" && !suppressed.has(contact.email) && matchesFieldFilter(readFields(contact), audienceFields))
		.toSorted(compareByEngagement);
	return limit ? audience.slice(0, limit) : audience;
}
