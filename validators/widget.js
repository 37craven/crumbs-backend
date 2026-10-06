const { z } = require("zod");
const { MAX_CHECKLIST_ITEMS, WIDGET_TYPES } = require("../models/Widget");
const {
  dateString,
  objectIdString,
  isHttpUrl,
  atLeastOneField,
} = require("./common");

// ---- Notes: text AND a checklist ---------------------------------------------
// `id` is sent back for checklist items that already exist, so editing one
// item keeps its identity. Items without an id are new.
const checklistItem = z.strictObject({
  id: objectIdString.optional(),
  text: z
    .string()
    .trim()
    .min(1, "Checklist items cannot be empty")
    .max(200, "Checklist items must be at most 200 characters"),
  done: z.boolean().default(false),
});

const notesData = z.strictObject({
  body: z.string().max(5000, "Notes can be at most 5000 characters").optional(),
  checklist: z
    .array(checklistItem)
    .max(MAX_CHECKLIST_ITEMS, `A checklist can have at most ${MAX_CHECKLIST_ITEMS} items`)
    .optional(),
});

// ---- Date --------------------------------------------------------------------
// `date: null` clears the date.
const dateData = z.strictObject({
  date: dateString.nullable().optional(),
  label: z.string().trim().max(60, "Label must be at most 60 characters").optional(),
});

// ---- Link --------------------------------------------------------------------
// "" or null clears the link.
const linkUrl = z
  .string()
  .trim()
  .max(2048, "Link is too long")
  .refine(
    (value) => value === "" || isHttpUrl(value),
    "Enter a valid link starting with http:// or https://",
  );

const linkData = z.strictObject({
  url: linkUrl.nullable().optional(),
});

// The image widget has no PATCH body: its picture changes through /image.
const widgetUpdateSchemas = {
  notes: atLeastOneField(notesData),
  date: atLeastOneField(dateData),
  link: atLeastOneField(linkData),
};

// ---- Adding a widget to a row ----------------------------------------------------
// The user picks a type; starting content is optional and depends on the type.
//   { "type": "notes" }   { "type": "date", "date": "2026-10-12" }
//   { "type": "image" }   { "type": "link", "url": "https://..." }
const addWidgetSchema = z.discriminatedUnion(
  "type",
  [
    z.strictObject({ type: z.literal("notes"), ...notesData.shape }),
    z.strictObject({ type: z.literal("date"), ...dateData.shape }),
    z.strictObject({ type: z.literal("image") }),
    z.strictObject({ type: z.literal("link"), ...linkData.shape }),
  ],
  { error: `Type must be one of: ${WIDGET_TYPES.join(", ")}` },
);

// ---- Smaller request bodies -------------------------------------------------
const checklistToggleSchema = z.strictObject({ done: z.boolean().optional() });
const reorderSchema = z.strictObject({
  order: z.array(objectIdString).min(1, "Send every id"),
});
const linkPreviewSchema = z.strictObject({
  url: linkUrl.min(1, "Link is required"),
});

module.exports = {
  notesData,
  dateData,
  linkData,
  widgetUpdateSchemas,
  addWidgetSchema,
  reorderSchema,
  checklistToggleSchema,
  linkPreviewSchema,
};
