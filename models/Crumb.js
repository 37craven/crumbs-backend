const mongoose = require("mongoose");

const { imageSchema, imagePathFor } = require("./Image");

const CAPTION_MAX = 60;

// One uploaded photo on a user's Crumbs page. The picture lives inside the document
// (see models/Image.js), so a crumb and its photo are always restored together.
//
// A crumb is separate from a collection's image widgets on purpose: the Crumbs page
// is a personal photo timeline, and collections are shared and edited by several
// people. An upload may copy itself into a collection (see services/crumbs.js), and
// then one picture is held by two records.
const crumbSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    image: { type: imageSchema, required: true },
    caption: { type: String, trim: true, maxlength: CAPTION_MAX, default: "" },
    // The collection this crumb was also filed into, if any. Only a record of
    // where it went: the crumb itself is never edited or deleted through it.
    collectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Collection",
      default: null,
    },
    createdAt: { type: Date, default: Date.now },

    // ---- LEGACY, read-only -------------------------------------------------
    // Crumbs written before pictures moved onto disk kept the image INSIDE the
    // document as a Buffer under `imageData`, and were served from
    // GET /api/crumbs/:id/image. They have no `image` subdocument yet.
    // Nothing writes these fields any more; they exist so old photos keep
    // showing. `scripts/migrate-legacy-crumbs.js` folds them into `image` and
    // these can then go.
    imageData: { type: Buffer, select: false },
    contentType: { type: String },
  },
  { timestamps: { createdAt: false, updatedAt: false } },
);

// Newest first, and only ever for one user.
crumbSchema.index({ user: 1, createdAt: -1 });

// True for a crumb still stored the old way, with the bytes loose in the document.
crumbSchema.methods.isLegacy = function isLegacy() {
  return !this.image?.data && Boolean(this.imageData);
};

// The bytes to serve, whichever way this crumb happens to store them.
crumbSchema.methods.picture = function picture() {
  if (this.image?.data) return this.image;
  if (this.isLegacy()) {
    return {
      _id: this._id,
      mimeType: this.contentType,
      uploadedAt: this.createdAt,
      data: this.imageData,
    };
  }
  return null;
};

crumbSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    userId: this.user.toString(),
    imageUrl: imagePathFor("crumbs", this._id),
    caption: this.caption,
    collectionId: this.collectionId ? this.collectionId.toString() : null,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model("Crumb", crumbSchema);
module.exports.CAPTION_MAX = CAPTION_MAX;
