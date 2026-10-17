import mongoose from "mongoose";
import { accountScoped } from "../lib/account-scope.js";

// draft: being written, nobody joins. active: new subscribers join and get its steps. paused: nobody joins, and the
// contacts in it wait until it's active again.
export const SEQUENCE_STATUSES = ["draft", "active", "paused"];
export const SEQUENCE_FORMATS = ["markdown", "rich", "html"];

// One version of a step's email. match: the contacts it's for, each field name to the values it accepts
// (lib/contact-fields.js); without one, it's the step's fallback for contacts no other variant matches.
const variantSchema = new mongoose.Schema({
	match: { type: mongoose.Schema.Types.Mixed, default: undefined },
	subject: { type: String, trim: true, default: "" },
	previewText: { type: String, trim: true, default: "" },
	format: { type: String, enum: SEQUENCE_FORMATS, default: "html" },
	markdown: { type: String, default: "" },
	html: { type: String, default: "" },
});

// dayOffset: days after the contact joined (signup, or confirmation when the newsletter asks for one).
const stepSchema = new mongoose.Schema({
	dayOffset: { type: Number, min: 0, required: true },
	variants: { type: [variantSchema], default: [] },
});

const sequenceSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, trim: true, required: true },
		status: { type: String, enum: SEQUENCE_STATUSES, default: "draft" },
		steps: { type: [stepSchema], default: [] },
	},
	{ timestamps: true }
);

sequenceSchema.plugin(accountScoped);
sequenceSchema.index({ accountId: 1, newsletterId: 1, createdAt: 1 });

export default mongoose.models.Sequence || mongoose.model("Sequence", sequenceSchema);
