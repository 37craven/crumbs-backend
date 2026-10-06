const { z } = require("zod");
const { EVENT_STATUSES, MAX_TAGS, MAX_COLLABORATORS } = require("../models/Event");
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
  .max(MAX_TAGS, `An event can have at most ${MAX_TAGS} tags`)
  .transform((list) => [...new Set(list)]);

// Ids of friends to share the event with. Checked against the friends list
// by the route, not here.
const collaboratorIds = z
  .array(objectIdString)
  .max(MAX_COLLABORATORS, `An event can be shared with at most ${MAX_COLLABORATORS} people`);

const createEventSchema = z.strictObject({
  // Optional: an event can be opened blank and titled later.
  title: title.or(z.literal("")).default(""),
  description: description.default(""),
  tags: tags.default([]),
  collaborators: collaboratorIds.default([]),
});

// Status is NOT editable here; it has its own endpoint with transition rules.
const updateEventSchema = atLeastOneField(
  z.strictObject({
    title: title.optional(),
    description: description.optional(),
    tags: tags.optional(),
  }),
);

const statusSchema = z.strictObject({
  status: z.enum(EVENT_STATUSES.filter((s) => s !== "new"), {
    error: `Status must be one of: ${EVENT_STATUSES.filter((s) => s !== "new").join(", ")}`,
  }),
});

// ---- Rows ---------------------------------------------------------------------
const rowName = z.string().trim().max(40, "Row names must be at most 40 characters");
const addRowSchema = z.strictObject({ name: rowName.default("") });
const renameRowSchema = z.strictObject({ name: rowName });

const addCollaboratorSchema = z.strictObject({ userId: objectIdString });

module.exports = {
  createEventSchema,
  updateEventSchema,
  statusSchema,
  addCollaboratorSchema,
  addRowSchema,
  renameRowSchema,
};
