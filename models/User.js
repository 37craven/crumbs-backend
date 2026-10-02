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
  name: { type: String, trim: true, maxlength: 50, default: "" },
  password: { type: String, required: true, select: false },
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

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    username: this.username,
    name: this.name ?? "",
    avatarUrl: this.avatarUpdatedAt
      ? `/api/auth/avatar/${this._id}?v=${this.avatarUpdatedAt.getTime()}`
      : null,
    email: this.email,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model("User", userSchema);