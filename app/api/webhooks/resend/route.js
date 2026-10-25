import { handleResendRequest } from "@/lib/resend-webhook";

// Deliveries, bounces, complaints and suppressions from every account's Resend sends.
export function POST(request) {
	return handleResendRequest(request);
}
