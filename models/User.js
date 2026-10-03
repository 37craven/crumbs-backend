const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true, maxlength: 20 },
  usernameLower: { type: String, required: true, unique: true, index: true },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  firstName: { type: String, trim: true, maxlength: 50, default: "" },
  lastName: { type: String, trim: true, maxlength: 50, default: "" },
  // Legacy full name. Read as a fallback, cleared the next time the user saves their profile.
  name: { type: String, trim: true, maxlength: 50 },
  password: { type: String, required: true, select: false },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  avatarData: { type: Buffer, select: false },
  avatarContentType: { type: String },
  avatarUpdatedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

userSchema.pre("validate", function syncUsernameLower() {
  if (this.username) {
    this.usernameLower = this.username.toLowerCase();
  }
});

userSchema.methods.toSummary = function toSummary() {
  return {
    id: this._id.toString(),
    username: this.username,
    firstName: this.firstName || (this.name ?? "").trim().split(/\s+/)[0] || "",
    lastName:
      this.lastName || (this.name ?? "").trim().split(/\s+/).slice(1).join(" "),
    avatarUrl: this.avatarUpdatedAt
      ? `/api/auth/avatar/${this._id}?v=${this.avatarUpdatedAt.getTime()}`
      : null,
  };
};

userSchema.methods.toPublic = function toPublic() {
  return {
    ...this.toSummary(),
    email: this.email,
    createdAt: this.createdAt,
    friendsCount: this.friends.length,
  };
};

module.exports = mongoose.model("User", userSchema);