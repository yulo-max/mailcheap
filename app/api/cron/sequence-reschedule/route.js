import { withCronSecret } from "@/lib/cron";
import { rescheduleEnrollments } from "@/lib/sequence-reschedule";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Not scheduled: a one-off repair, with CRON_SECRET (lib/sequence-reschedule.js). Without "execute": true a dry run.
export const POST = withCronSecret(async (request) => rescheduleEnrollments(await request.json().catch(() => ({}))));
