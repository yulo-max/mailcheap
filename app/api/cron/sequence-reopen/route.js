import { withCronSecret } from "@/lib/cron";
import { reopenSkippedEnrollments } from "@/lib/sequence-reopen";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Not scheduled: a one-off repair, with CRON_SECRET (lib/sequence-reopen.js). Without "execute": true a dry run.
export const POST = withCronSecret(async (request) => reopenSkippedEnrollments(await request.json().catch(() => ({}))));
