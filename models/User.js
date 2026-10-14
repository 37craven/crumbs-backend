const mongoose = require("mongoose");

const { Schema } = mongoose;

const { imageSchema, avatarPathFor } = require("./Image");

// One uploaded profile photo, held inside the user document (see models/Image.js).
// A profile photo is replaced by assigning a new subdocument; the old bytes go with
// the old one, so there is no file left behind to clean up.

// A single-use token from an email link. Only the hash is stored, so reading
// the database does not let anyone verify an address or reset a password.
// See services/tokens.js.
const tokenSchema = new Schema(
  {
    hash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

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
  // Legacy full name. Read as a fallback by toSummary(), and cleared the next
  // time the user saves their profile.
  name: { type: String, trim: true, maxlength: 50 },
    avatar: { type: imageSchema, default: null },
  password: { type: String, required: true, select: false },

  // ---- Email verification --------------------------------------------------
  // There is deliberately NO default: an account with no value is one that
  // predates verification, which scripts/verify-existing-accounts.js resolves.
  emailVerified: { type: Boolean },
  emailVerifiedAt: { type: Date },
  // Never returned by any query that does not ask for it.
  emailVerifyToken: { type: tokenSchema, select: false },
  passwordResetToken: { type: tokenSchema, select: false },

  createdAt: { type: Date, default: Date.now },
});

userSchema.pre("validate", function syncUsernameLower() {
  if (this.username) {
    this.usernameLower = this.username.toLowerCase();
  }
});

userSchema.pre("validate", function clearLegacyName() {
  // Once the name is split into two fields, the old one has served its purpose.
  if (this.isModified("firstName") || this.isModified("lastName")) {
    this.name = undefined;
  }
});

// What anyone may see about a person: their id, username, names and photo.
// Never the email. Friends and collection collaborators are shown this way.
userSchema.methods.toSummary = function toSummary() {
  const legacy = (this.name ?? "").trim().split(/\s+/).filter(Boolean);

  return {
    id: this._id.toString(),
    username: this.username,
    firstName: this.firstName || legacy[0] || "",
    lastName: this.lastName || legacy.slice(1).join(" "),
    avatarUrl: this.avatar ? avatarPathFor(this._id) : null,
  };
};

// The signed-in user's own record, which adds their email.
// `friendsCount` is passed in rather than looked up here: toPublic() is
// synchronous, and counting friends needs a query (see routes/auth.js).
userSchema.methods.toPublic = function toPublic(extra = {}) {
  return {
    ...this.toSummary(),
    email: this.email,
    // Only ever true or false here: an account with no recorded value predates
    // verification and is treated as verified (see the schema comment).
    emailVerified: this.emailVerified === true,
    createdAt: this.createdAt,
    ...extra,
  };
};

module.exports = mongoose.model("User", userSchema);
