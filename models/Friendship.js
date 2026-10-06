const mongoose = require("mongoose");

const { Schema } = mongoose;
const FRIENDSHIP_STATUSES = ["pending", "accepted"];

// "idA_idB" with the smaller id first. A->B and B->A produce the SAME key, and
// the key is unique, so two people can only ever share ONE friendship record.
function pairKeyFor(a, b) {
  return [String(a), String(b)].sort().join("_");
}

const friendshipSchema = new Schema(
  {
    requester: { type: Schema.Types.ObjectId, ref: "User", required: true },
    recipient: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      validate: {
        // `this` is the document being validated.
        validator(value) {
          return String(value) !== String(this.requester);
        },
        message: "You cannot send a friend request to yourself",
      },
    },
    status: { type: String, enum: FRIENDSHIP_STATUSES, default: "pending" },
    pairKey: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);

friendshipSchema.pre("validate", function setPairKey() {
  if (this.requester && this.recipient) {
    this.pairKey = pairKeyFor(this.requester, this.recipient);
  }
});

friendshipSchema.index({ requester: 1, status: 1 });
friendshipSchema.index({ recipient: 1, status: 1 });

module.exports = mongoose.model("Friendship", friendshipSchema);
module.exports.pairKeyFor = pairKeyFor;
module.exports.FRIENDSHIP_STATUSES = FRIENDSHIP_STATUSES;
