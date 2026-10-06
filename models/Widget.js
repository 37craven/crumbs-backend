const mongoose = require("mongoose");
const { isValidDateString } = require("../utils/dates");

const { Schema } = mongoose;

// The four kinds of widget. Any of them can be placed in any row, any number of
// times. To add a new kind later: add its name here, define a discriminator
// below, and register it in `widgetModels`.
const WIDGET_TYPES = ["notes", "date", "image", "link"];

const MAX_WIDGETS_PER_ROW = 30;
const MAX_CHECKLIST_ITEMS = 50;

// ---- Base widget: fields every widget shares ------------------------------
// All widgets live in ONE collection ("widgets"). The `type` field tells them
// apart, and Mongoose "discriminators" give each type its own extra fields and
// validation. Querying the base model returns the right kind of document.
const widgetSchema = new Schema(
  {
    event: { type: Schema.Types.ObjectId, ref: "Event", required: true },
    // The _id of one of the event's rows (event.rows).
    row: { type: Schema.Types.ObjectId, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Position inside the row: 0 is the leftmost widget.
    order: { type: Number, default: 0 },
  },
  { discriminatorKey: "type", timestamps: true },
);

widgetSchema.index({ event: 1, row: 1, order: 1 });

const Widget = mongoose.model("Widget", widgetSchema);

// ---- Notes: text AND a checklist, together ----------------------------------
const checklistItemSchema = new Schema({
  text: {
    type: String,
    required: [true, "Checklist items cannot be empty"],
    trim: true,
    maxlength: [200, "Checklist items must be at most 200 characters"],
  },
  done: { type: Boolean, default: false },
});

const NotesWidget = Widget.discriminator(
  "NotesWidget",
  new Schema({
    body: {
      type: String,
      default: "",
      maxlength: [5000, "Notes can be at most 5000 characters"],
    },
    checklist: {
      type: [checklistItemSchema],
      default: [],
      validate: {
        validator: (items) => items.length <= MAX_CHECKLIST_ITEMS,
        message: `A checklist can have at most ${MAX_CHECKLIST_ITEMS} items`,
      },
    },
  }),
  { value: "notes" },
);

// ---- Image: exactly one picture (or empty until one is uploaded) -----------
const imageSchema = new Schema(
  {
    filename: { type: String, required: true }, // name on disk, never shown to clients
    originalName: { type: String, trim: true, maxlength: 255, default: "" },
    url: { type: String, required: true }, // e.g. /uploads/<uuid>.png
    mimeType: { type: String, required: true },
    size: { type: Number, min: 0, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ImageWidget = Widget.discriminator(
  "ImageWidget",
  new Schema({ image: { type: imageSchema, default: null } }),
  { value: "image" },
);

// ---- Date: one calendar date with an optional label ------------------------
const DateWidget = Widget.discriminator(
  "DateWidget",
  new Schema({
    date: {
      type: String,
      default: null,
      validate: {
        validator: (value) => value == null || isValidDateString(value),
        message: "Date must be a real date in YYYY-MM-DD format",
      },
    },
    label: {
      type: String,
      trim: true,
      maxlength: [60, "Label must be at most 60 characters"],
      default: "",
    },
  }),
  { value: "date" },
);

// ---- Link: a URL plus details fetched from that page ----------------------
const previewSchema = new Schema(
  {
    status: { type: String, enum: ["ok", "unavailable"], default: "ok" },
    title: { type: String, default: null },
    description: { type: String, default: null },
    image: { type: String, default: null },
    siteName: { type: String, default: null },
    favicon: { type: String, default: null },
    fetchedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const LinkWidget = Widget.discriminator(
  "LinkWidget",
  new Schema({
    url: {
      type: String,
      trim: true,
      maxlength: [2048, "Link is too long"],
      default: null,
      validate: {
        validator: (value) => value == null || /^https?:\/\//i.test(value),
        message: "Link must start with http:// or https://",
      },
    },
    // Set for YouTube/Vimeo links so the page can show the player.
    embedUrl: { type: String, default: null },
    preview: { type: previewSchema, default: null },
  }),
  { value: "link" },
);

const widgetModels = {
  notes: NotesWidget,
  date: DateWidget,
  image: ImageWidget,
  link: LinkWidget,
};

module.exports = {
  Widget,
  widgetModels,
  WIDGET_TYPES,
  MAX_WIDGETS_PER_ROW,
  MAX_CHECKLIST_ITEMS,
};
