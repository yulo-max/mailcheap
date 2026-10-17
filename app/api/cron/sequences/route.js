import { withCronSecret } from "@/lib/cron";
import { runDueSequenceSteps } from "@/lib/sequences";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Every 15 minutes: the sequence steps that came due, queued as send batches (lib/sequences.js).
export const GET = withCronSecret(async () => {
	const result = await runDueSequenceSteps();
	console.info(`[sequences] ${JSON.stringify(result)}`);
	return result;
});
