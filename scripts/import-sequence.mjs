#!/usr/bin/env node
// Loads a folder of HTML emails into a MailCheap sequence through the REST API, one step per call.
//
//   MAILCHEAP_URL=https://mail.example.com MAILCHEAP_API_KEY=... \
//     node scripts/import-sequence.mjs ./welcome/varianten --name "Welcome series" --newsletter my-newsletter
//
// Files are named <anything>-<step>-<variant>.html: welcome-02-scorpio.html is step 2's variant for contacts whose
// sun_sign (--field) is scorpio, and welcome-02-default.html its fallback for everyone else. Each file's subject,
// preview text and day come from a comment in it ("Subject: …", "Preview text: …", "Send: day 1"), or from --days.
// --dry-run reads and checks the folder without calling the API. See docs/sequences.md.
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const FILE_PATTERN = /^(?:.*-)?(\d{1,2})-([a-z0-9_]+)\.html$/i;
const FALLBACK_NAMES = new Set(["default", "fallback", "all"]);
// Gmail clips emails over 100 KB; the send adds tracking, so this leaves room.
const WARN_BYTES = 90_000;
const USAGE = `Usage: node scripts/import-sequence.mjs <folder> --name <name> [options]

  --name <name>          The sequence's name (required unless --sequence)
  --newsletter <slug>    The newsletter's slug or ID. Default: the account's first
  --sequence <id>        Replace the steps of this sequence instead of creating one
  --field <name>         The contact field variant names match. Default: sun_sign
  --days <list>          Day offsets per step, e.g. 0,1,3,6,9. Default: each file's "Send: day N"
  --keep-comments        Keep the comment with the subject and notes in the email
  --activate             Make the sequence active once loaded: new subscribers start getting it
  --dry-run              Read and check the folder, print the plan, call nothing

Environment: MAILCHEAP_URL (default http://localhost:3000) and MAILCHEAP_API_KEY (a full access key).`;

function fail(message) {
	console.error(message);
	process.exit(1);
}

function readOptions() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			name: { type: "string" },
			newsletter: { type: "string" },
			sequence: { type: "string" },
			field: { type: "string", default: "sun_sign" },
			days: { type: "string" },
			"keep-comments": { type: "boolean", default: false },
			activate: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help || positionals.length !== 1) fail(USAGE);
	if (!values.name && !values.sequence) fail("--name is required to create a sequence\n\n" + USAGE);
	if (!/^[a-z][a-z0-9_]{0,39}$/.test(values.field)) fail("--field: lowercase letters, digits and underscores");
	const days = values.days?.split(",").map((day) => Number(day.trim()));
	if (days?.some((day) => !Number.isFinite(day) || day < 0)) fail("--days: numbers of days, e.g. 0,1,3,6,9");
	return { ...values, days, folder: resolve(positionals[0]) };
}

// The notes a draft carries in a comment: its subject, preview text and day.
export function readMeta(html) {
	const comment = [...html.matchAll(/<!--([\s\S]*?)-->/g)].map(([, text]) => text).find((text) => /Subject:/i.test(text)) ?? "";
	const pick = (pattern) => pattern.exec(comment)?.[1]?.trim() ?? "";
	const day = pick(/Send:\s*day\s+(\d+(?:\.\d+)?)/i);
	return {
		subject: pick(/Subject:\s*(.+?)\s*$/im),
		previewText: pick(/Preview text:\s*(.+?)\s*$/im),
		dayOffset: day === "" ? null : Number(day),
	};
}

// The comment holding the subject and notes is for whoever writes the email, not its readers.
export function stripMetaComment(html) {
	return html.replace(/<!--(?:(?!-->)[\s\S])*?Subject:[\s\S]*?-->\s*/i, "");
}

export async function readSequenceFolder(folder, { field = "sun_sign", days, keepComments = false } = {}) {
	const files = (await readdir(folder)).filter((file) => FILE_PATTERN.test(file)).sort();
	if (files.length === 0) throw new Error(`No <name>-<step>-<variant>.html files in ${folder}`);
	const steps = new Map();
	const warnings = [];
	for (const file of files) {
		const [, number, name] = FILE_PATTERN.exec(file);
		const html = await readFile(join(folder, file), "utf8");
		const meta = readMeta(html);
		const position = Number(number);
		if (!meta.subject) throw new Error(`${file}: no "Subject:" line in a comment`);
		if (/\[\[[^\]]+\]\]|PLACEHOLDER/.test(html)) warnings.push(`${file}: has a placeholder left to fill ([[…]] or PLACEHOLDER)`);
		if (!html.includes("{{unsubscribe_url}}")) warnings.push(`${file}: no {{unsubscribe_url}}, so MailCheap adds its own footer`);
		const content = keepComments ? html : stripMetaComment(html);
		if (Buffer.byteLength(content) > WARN_BYTES) warnings.push(`${file}: ${Math.round(Buffer.byteLength(content) / 1000)} KB, close to Gmail's 100 KB clip`);
		const isFallback = FALLBACK_NAMES.has(name.toLowerCase());
		const step = steps.get(position) ?? { position, dayOffsets: new Set(), variants: [] };
		if (meta.dayOffset !== null) step.dayOffsets.add(meta.dayOffset);
		step.variants.push({
			file,
			...(!isFallback && { match: { [field]: name.toLowerCase() } }),
			subject: meta.subject,
			...(meta.previewText && { previewText: meta.previewText }),
			format: "html",
			content,
		});
		steps.set(position, step);
	}
	const positions = [...steps.keys()].sort((a, b) => a - b);
	if (positions.some((position, index) => position !== index + 1)) throw new Error(`Steps have to be numbered 1, 2, 3…; found ${positions.join(", ")}`);
	if (days && days.length !== positions.length) throw new Error(`--days has ${days.length} offsets for ${positions.length} steps`);
	return {
		warnings,
		steps: positions.map((position, index) => {
			const step = steps.get(position);
			const fromFiles = [...step.dayOffsets];
			if (!days && fromFiles.length !== 1) {
				throw new Error(`Step ${position}: ${fromFiles.length ? `files disagree on the day (${fromFiles.join(", ")})` : 'no "Send: day N"'}; pass --days`);
			}
			const fallbacks = step.variants.filter((variant) => !variant.match).length;
			if (fallbacks > 1) throw new Error(`Step ${position}: one fallback file at most`);
			if (fallbacks === 0) warnings.push(`Step ${position}: no fallback (…-${String(position).padStart(2, "0")}-default.html), so contacts without a matching ${field} skip it`);
			return { position, dayOffset: days ? days[index] : fromFiles[0], variants: step.variants };
		}),
	};
}

async function call(baseUrl, key, method, path, body) {
	const response = await fetch(`${baseUrl}/api/v1${path}`, {
		method,
		headers: { authorization: `Bearer ${key}`, ...(body && { "content-type": "application/json" }) },
		...(body && { body: JSON.stringify(body) }),
	});
	const answer = await response.json().catch(() => null);
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${answer?.error?.code ?? ""} ${answer?.error?.message ?? ""}`.trim());
	return answer;
}

async function main() {
	const options = readOptions();
	const plan = await readSequenceFolder(options.folder, { field: options.field, days: options.days, keepComments: options["keep-comments"] });
	for (const step of plan.steps) {
		const kinds = step.variants.map((variant) => (variant.match ? variant.match[options.field] : "fallback"));
		console.log(`Step ${step.position}, day ${step.dayOffset}: ${step.variants.length} variants (${kinds.join(", ")}). "${step.variants[0].subject}"`);
	}
	for (const warning of plan.warnings) console.warn(`Warning: ${warning}`);
	if (options["dry-run"]) {
		console.log(`Dry run: nothing sent to MailCheap. ${plan.steps.length} steps from ${basename(options.folder)}.`);
		return;
	}

	const key = process.env.MAILCHEAP_API_KEY;
	if (!key) fail("Set MAILCHEAP_API_KEY to a full access key");
	const baseUrl = (process.env.MAILCHEAP_URL || "http://localhost:3000").replace(/\/+$/, "");
	const sequence = options.sequence
		? await call(baseUrl, key, "GET", `/sequences/${encodeURIComponent(options.sequence)}`)
		: await call(baseUrl, key, "POST", "/sequences", { name: options.name, ...(options.newsletter && { newsletter: options.newsletter }) });
	console.log(`${options.sequence ? "Updating" : "Created"} sequence ${sequence.id} (${sequence.status})`);
	for (const step of plan.steps) {
		const variants = step.variants.map(({ file, ...variant }) => variant);
		// A replaced step loses the settings it isn't sent: the late limit and deadline field set through the API stay.
		const previous = sequence.steps?.[step.position - 1];
		const settings = {
			...(previous?.lateLimitHours && { lateLimitHours: previous.lateLimitHours }),
			...(previous?.skipAfterField && { skipAfterField: previous.skipAfterField }),
		};
		await call(baseUrl, key, "POST", `/sequences/${sequence.id}/steps`, { position: step.position, dayOffset: step.dayOffset, ...settings, variants });
		console.log(`Step ${step.position} saved`);
	}
	if (sequence.steps?.length > plan.steps.length) {
		console.warn(`Warning: the sequence has ${sequence.steps.length} steps; steps after ${plan.steps.length} were left as they are`);
	}
	if (options.activate) {
		await call(baseUrl, key, "PATCH", `/sequences/${sequence.id}`, { status: "active" });
		console.log("Active: new subscribers start getting it");
	} else {
		console.log(`Still a ${sequence.status === "draft" ? "draft" : sequence.status}: run again with --activate, or PATCH /api/v1/sequences/${sequence.id} {"status":"active"}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => fail(error.message));
}
