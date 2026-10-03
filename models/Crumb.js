const mongoose = require("mongoose");

const crumbSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  imageData: { type: Buffer, required: true, select: false },
  contentType: { type: String, required: true },
  caption: { type: String, trim: true, maxlength: 60, default: "" },
  createdAt: { type: Date, default: Date.now },
});

crumbSchema.index({ user: 1, createdAt: -1 });

crumbSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    imageUrl: `/api/crumbs/${this._id}/image`,
    caption: this.caption,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model("Crumb", crumbSchema);