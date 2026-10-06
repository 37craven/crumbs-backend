const mongoose = require("mongoose");

// "new" = a blank collection the user just opened. It becomes "draft" as soon as
// anything is added, and blank ones are deleted (see routes/collections.js).
const COLLECTION_STATUSES = ["new", "draft", "planned", "done", "archived"];
const MAX_TAGS = 8;
const MAX_COLLABORATORS = 20;
const MAX_ROWS = 20;

const linkSummarySchema = new mongoose.Schema(
  { url: String, title: String, image: String, siteName: String },
  { _id: false },
);

// A small snapshot of the collection's widgets, stored on the collection itself.
//
// The Collections grid and the Search page need a thumbnail, a date and a
// progress count for every collection. Reading those from the widgets would mean an
// extra query per collection, so we copy them here whenever a widget changes (see
// services/collectionSummary.js). The widgets stay the source of truth.
// A row groups widgets on the collection page. Rows are listed in display order.
// Widgets point at a row by its _id (see models/Widget.js).
const rowSchema = new mongoose.Schema({
  name: {
    type: String,
    trim: true,
    maxlength: [40, "Row names must be at most 40 characters"],
    default: "",
  },
});

// A small snapshot of the collection's widgets, stored on the collection itself.
//
// The Collections grid and the Search page need a cover picture, a date and a
// text preview for every collection. Reading those from the widgets would mean an
// extra query per collection, so we copy them here whenever a widget changes (see
// services/collectionSummary.js). The widgets stay the source of truth.
const summarySchema = new mongoose.Schema(
  {
    // A collection can have several date widgets. `collectionDate` is the EARLIEST one
    // (used for the card, sorting, upcoming and overdue); `collectionDates` holds
    // them all so a date-range search finds any of them. "YYYY-MM-DD" text.
    collectionDate: { type: String, default: null },
    collectionDates: { type: [String], default: [] },
    // What the Collections card shows (see services/collectionTiles.js).
    noteExcerpts: { type: [String], default: [] }, // up to 3 notes widgets
    openChecklistItems: { type: Number, default: 0, min: 0 }, // for the "done" rule
    imageCount: { type: Number, default: 0, min: 0 }, // the "memories" count
    imageUrls: { type: [String], default: [] }, // the first 4 pictures
    linkCount: { type: Number, default: 0, min: 0 },
    links: { type: [linkSummarySchema], default: [] }, // the first 4 links
  },
  { _id: false },
);

const collectionSchema = new mongoose.Schema(
  {
    // The creator. Only the creator can delete the collection or manage its people.
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Friends the creator shared the collection with. They can edit everything
    // except deleting the collection or changing who is part of it, and the collection
    // shows up in their Collections too.
    collaborators: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
      validate: {
        validator: (list) => list.length <= MAX_COLLABORATORS,
        message: `A collection can be shared with at most ${MAX_COLLABORATORS} people`,
      },
    },
    // Empty while the collection is brand new; the API requires one when it is edited.
    title: {
      type: String,
      trim: true,
      maxlength: [80, "Title must be at most 80 characters"],
      default: "",
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, "Description must be at most 500 characters"],
      default: "",
    },
    tags: {
      type: [{ type: String, trim: true, lowercase: true, maxlength: 24 }],
      default: [],
      validate: {
        validator: (tags) => tags.length <= MAX_TAGS,
        message: `A collection can have at most ${MAX_TAGS} tags`,
      },
    },
    status: {
      type: String,
      enum: {
        values: COLLECTION_STATUSES,
        message: `Status must be one of: ${COLLECTION_STATUSES.join(", ")}`,
      },
      default: "draft",
    },
    // Rows of widgets, in display order. A new collection starts with one empty row.
    rows: {
      type: [rowSchema],
      default: [],
      validate: {
        validator: (rows) => rows.length <= MAX_ROWS,
        message: `A collection can have at most ${MAX_ROWS} rows`,
      },
    },
    summary: { type: summarySchema, default: () => ({}) },
    // Everything searchable, lowercased, in one string (see collectionSummary.js).
    // select:false keeps it out of normal query results.
    searchText: { type: String, default: "", select: false },
  },
  { timestamps: true },
);

// The Collections grid: "my collections, most recently edited first".
collectionSchema.index({ owner: 1, updatedAt: -1 });
collectionSchema.index({ collaborators: 1, updatedAt: -1 });
collectionSchema.index({ owner: 1, status: 1 });
collectionSchema.index({ owner: 1, "summary.collectionDate": 1 });

module.exports = mongoose.model("Collection", collectionSchema);
module.exports.COLLECTION_STATUSES = COLLECTION_STATUSES;
module.exports.MAX_TAGS = MAX_TAGS;
module.exports.MAX_COLLABORATORS = MAX_COLLABORATORS;
module.exports.MAX_ROWS = MAX_ROWS;
