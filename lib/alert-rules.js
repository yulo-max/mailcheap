// Admin alerts (sendAlert without an account, to ADMIN_EMAILS) by kind: their key up to the first ":". "telegram":
// something is broken or waits for an admin, so it reaches Telegram too when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
// are set. "email": a record, by email only. An account's own alerts go to its owner and never to Telegram.
export const ADMIN_ALERTS = {
	"account-blocked": "telegram",
	"account-blocked-by-admin": "email",
	"deleted-email-signup": "email",
	"dns-helper-cap": "telegram",
	"dns-helper-down": "telegram",
	"gmail-spam-rate": "telegram",
	"inbound-cap": "telegram",
	"job-failing": "telegram",
	"platform-email-failed": "telegram",
	"postmaster-refused": "telegram",
	"postshiba-cap": "telegram",
	"postshiba-kyc": "telegram",
	"postshiba-status-refused": "telegram",
	"postshiba-suspended": "telegram",
	"purge-postponed": "telegram",
	"qstash-refused": "telegram",
	"rate-limit-unavailable": "telegram",
	"send-refused": "telegram",
	"sequences-backfill": "telegram",
	"shared-sender-failed": "telegram",
	"shared-sender-left": "telegram",
	"shared-sender-waiting": "email",
	"stripe-webhook-failed": "telegram",
	"tenant": "email",
	"tenant-failed": "email",
	"tenant-hold": "telegram",
	"tenant-resume-failed": "telegram",
	"tenant-suspend-failed": "telegram",
	"webhook-failing": "telegram",
};

export function getAlertKind(key) {
	return String(key ?? "").split(":")[0];
}

export function isTelegramAlert({ accountId, key }) {
	return !accountId && ADMIN_ALERTS[getAlertKind(key)] === "telegram";
}
