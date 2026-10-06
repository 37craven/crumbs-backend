const { z } = require("zod");
const { objectIdString } = require("./common");
const { CAPTION_MAX } = require("../models/Crumb");

// The caption travels in the multipart body as the field "caption".
// The optional `collectionId` files this crumb into a collection too.
const createCrumbSchema = z.strictObject({
  caption: z
    .string()
    .trim()
    .max(CAPTION_MAX, `Caption must be at most ${CAPTION_MAX} characters`)
    .default(""),
  collectionId: objectIdString.nullish(),
});

module.exports = { createCrumbSchema };
