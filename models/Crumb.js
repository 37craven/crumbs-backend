const mongoose = require("mongoose");

const CAPTION_MAX = 60;

// One uploaded photo on a user's Crumbs page. The picture is stored on disk
// like collection pictures (see config/uploads.js); `filename` is never sent
// to clients, they get `url`.
//
// A crumb is separate from a collection's image widgets on purpose: the Crumbs
// page is a personal photo timeline, and collections are shared and edited by
// several people. An upload may copy itself into a collection (see
// services/crumbs.js), and then one file on disk backs two records.
const crumbSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    filename: { type: String, required: true },
    originalName: { type: String, trim: true, maxlength: 255, default: "" },
    url: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, min: 0, default: 0 },
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
    // document as a Buffer. They have no `url` and are served instead from
    // GET /api/crumbs/:id/image. Nothing writes these fields any more; they
    // exist so old photos keep showing. `scripts/migrate-legacy-crumbs.js`
    // moves them onto disk and these can go.
    imageData: { type: Buffer, select: false },
    contentType: { type: String },
  },
  { timestamps: { createdAt: false, updatedAt: false } },
);

// Newest first, and only ever for one user.
crumbSchema.index({ user: 1, createdAt: -1 });

// True for a crumb whose picture is still a Buffer in the document.
crumbSchema.methods.isLegacy = function isLegacy() {
  return !this.url && Boolean(this.imageData);
};

crumbSchema.methods.toPublic = function toPublic() {
  const id = this._id.toString();

  return {
    id,
    // A legacy crumb has no file on disk, so it is served from its own route.
    imageUrl: this.url ?? `/api/crumbs/${id}/image`,
    caption: this.caption,
    collectionId: this.collectionId ? this.collectionId.toString() : null,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model("Crumb", crumbSchema);
module.exports.CAPTION_MAX = CAPTION_MAX;
