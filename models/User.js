const mongoose = require("mongoose");

const { Schema } = mongoose;

// One uploaded profile photo, stored on disk like collection pictures (see
// config/uploads.js). `filename` is never sent to clients; they get `url`.
const avatarSchema = new Schema(
  {
    filename: { type: String, required: true },
    url: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, min: 0, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
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
  avatar: { type: avatarSchema, default: null },
  password: { type: String, required: true, select: false },
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
    avatarUrl: this.avatar ? this.avatar.url : null,
  };
};

// The signed-in user's own record, which adds their email.
// `friendsCount` is passed in rather than looked up here: toPublic() is
// synchronous, and counting friends needs a query (see routes/auth.js).
userSchema.methods.toPublic = function toPublic(extra = {}) {
  return {
    ...this.toSummary(),
    email: this.email,
    createdAt: this.createdAt,
    ...extra,
  };
};

module.exports = mongoose.model("User", userSchema);
