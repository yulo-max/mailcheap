import mongoose from "mongoose";
import { accountScoped } from "../lib/account-scope.js";

// pending: signed up to a newsletter that asks new subscribers to confirm, and hasn't yet.
export const CONTACT_STATUSES = ["active", "pending", "unsubscribed", "bounced", "complained", "dormant"];

const contactSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		email: { type: String, required: true, lowercase: true, trim: true },
		status: { type: String, enum: CONTACT_STATUSES, default: "active" },
		source: { type: String, trim: true },
		// Custom fields (lib/contact-fields.js): first_name, sun_sign… for merge tags, audiences and sequence variants.
		fields: { type: Map, of: String, default: undefined },
		importId: { type: mongoose.Schema.Types.ObjectId, ref: "ContactImport" },
		// Added by hand on the dashboard: the user who said this person agreed to get the newsletter, and when.
		consent: {
			userId: { type: mongoose.Schema.Types.ObjectId },
			at: { type: Date },
		},
		subscribedAt: { type: Date, default: Date.now },
		confirmedAt: { type: Date },
		unsubscribedAt: { type: Date },
		lastSentAt: { type: Date },
		lastOpenAt: { type: Date },
		lastClickAt: { type: Date },
		// List cleanup (lib/cleanup.js): issues received since the last sign of life (open, click,
		// confirmation, signup, "keep sending it" click), when that was, and when the last-chance email went out.
		ignoredIssues: { type: Number },
		lastEngagedAt: { type: Date },
		lastChanceAt: { type: Date },
		// Bounced without a send of this account: a send skipped it, on the never-email list (lib/global-suppressions.js).
		undeliverableAt: { type: Date },
		stats: {
			sent: { type: Number, default: 0 },
			opens: { type: Number, default: 0 },
			clicks: { type: Number, default: 0 },
		},
		// From a CSV import: engagement on the previous platform, so sends reach the most engaged first.
		imported: {
			emailsReceived: { type: Number },
			openRate: { type: Number },
			clickRate: { type: Number },
		},
	},
	{ timestamps: true }
);

contactSchema.plugin(accountScoped);
contactSchema.index({ newsletterId: 1, email: 1 }, { unique: true });
contactSchema.index({ newsletterId: 1, status: 1, createdAt: -1 });
// Bounces and complaints change every contact with the address in the account.
contactSchema.index({ accountId: 1, email: 1 });
// The contacts list shows the newest subscribers first, with or without newsletter and status filters.
// It breaks ties by _id, which the index needs too: without it MongoDB sorts the whole list on every page.
contactSchema.index({ accountId: 1, subscribedAt: -1, _id: -1 });
contactSchema.index({ accountId: 1, status: 1, subscribedAt: -1, _id: -1 });
contactSchema.index({ newsletterId: 1, subscribedAt: -1, _id: -1 });
contactSchema.index({ newsletterId: 1, status: 1, subscribedAt: -1, _id: -1 });
// The list cleanup totals in newsletter settings.
contactSchema.index({ newsletterId: 1, lastChanceAt: 1 }, { partialFilterExpression: { lastChanceAt: { $exists: true } } });
// An admin taking an address off the never-email list finds the contacts it stopped, in every account.
contactSchema.index({ email: 1 }, { partialFilterExpression: { undeliverableAt: { $exists: true } } });

export default mongoose.models.Contact || mongoose.model("Contact", contactSchema);
