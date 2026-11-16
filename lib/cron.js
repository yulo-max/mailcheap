import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

// Vercel Cron sends CRON_SECRET as a bearer token; any other scheduler can too.
function isAuthorized(request, secret) {
	const expected = Buffer.from(`Bearer ${secret}`);
	const given = Buffer.from(request.headers.get("authorization") ?? "");
	return given.length === expected.length && timingSafeEqual(given, expected);
}

// A scheduled route (app/api/cron): never open without CRON_SECRET, and only for a request that carries it.
export function withCronSecret(run) {
	return async function GET(request) {
		const secret = process.env.CRON_SECRET;
		if (!secret) return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 503 });
		if (!isAuthorized(request, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		return NextResponse.json(await run(request));
	};
}
