const { z } = require("zod");
const { COLLECTION_STATUSES, MAX_TAGS, MAX_COLLABORATORS } = require("../models/Collection");
const { atLeastOneField, objectIdString } = require("./common");

const title = z
  .string()
  .trim()
  .min(1, "Title is required")
  .max(80, "Title must be at most 80 characters");

const description = z
  .string()
  .trim()
  .max(500, "Description must be at most 500 characters");

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Tags cannot be empty")
  .max(24, "Tags must be at most 24 characters");

// ["Work", "work "] -> ["work"]: lowercase, trim, then drop duplicates.
const tags = z
  .array(tag)
  .max(MAX_TAGS, `A collection can have at most ${MAX_TAGS} tags`)
  .transform((list) => [...new Set(list)]);

// Ids of friends to share the collection with. Checked against the friends list
// by the route, not here.
const collaboratorIds = z
  .array(objectIdString)
  .max(MAX_COLLABORATORS, `A collection can be shared with at most ${MAX_COLLABORATORS} people`);

const createCollectionSchema = z.strictObject({
  // Optional: a collection can be opened blank and titled later.
  title: title.or(z.literal("")).default(""),
  description: description.default(""),
  tags: tags.default([]),
  collaborators: collaboratorIds.default([]),
});

// Status is NOT editable here; it has its own endpoint with transition rules.
const updateCollectionSchema = atLeastOneField(
  z.strictObject({
    title: title.optional(),
    description: description.optional(),
    tags: tags.optional(),
  }),
);

const statusSchema = z.strictObject({
  status: z.enum(COLLECTION_STATUSES.filter((s) => s !== "new"), {
    error: `Status must be one of: ${COLLECTION_STATUSES.filter((s) => s !== "new").join(", ")}`,
  }),
});

// ---- Rows ---------------------------------------------------------------------
const rowName = z.string().trim().max(40, "Row names must be at most 40 characters");
const addRowSchema = z.strictObject({ name: rowName.default("") });
const renameRowSchema = z.strictObject({ name: rowName });

const addCollaboratorSchema = z.strictObject({ userId: objectIdString });

module.exports = {
  createCollectionSchema,
  updateCollectionSchema,
  statusSchema,
  addCollaboratorSchema,
  addRowSchema,
  renameRowSchema,
};
