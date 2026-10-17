import mongoose from "mongoose";
import { accountScoped } from "../lib/account-scope.js";

// active: waiting for its next step. paused: its sequence is paused. completed: every step went. stopped: the contact
// left (stoppedReason).
export const ENROLLMENT_STATUSES = ["active", "paused", "completed", "stopped"];

// One contact going through one sequence: step is the index of the next step, due at nextAt.
const enrollmentSchema = new mongoose.Schema(
	{
		sequenceId: { type: mongoose.Schema.Types.ObjectId, ref: "Sequence", required: true },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
		status: { type: String, enum: ENROLLMENT_STATUSES, default: "active" },
		startedAt: { type: Date, required: true },
		step: { type: Number, default: 0 },
		nextAt: { type: Date },
		// When the last step was queued: a late step keeps its distance to the next.
		lastQueuedAt: { type: Date },
		stoppedReason: { type: String },
		endedAt: { type: Date },
	},
	{ timestamps: true }
);

enrollmentSchema.plugin(accountScoped);
// A contact joins a sequence once.
enrollmentSchema.index({ sequenceId: 1, contactId: 1 }, { unique: true });
// The run that sends due steps reads every account's (lib/sequences.js).
enrollmentSchema.index({ nextAt: 1 }, { partialFilterExpression: { status: "active" } });
enrollmentSchema.index({ accountId: 1, sequenceId: 1, status: 1 });

export default mongoose.models.SequenceEnrollment || mongoose.model("SequenceEnrollment", enrollmentSchema);
