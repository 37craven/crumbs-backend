const { z } = require("zod");
const { objectIdString } = require("./common");

const sendRequestSchema = z.strictObject({ userId: objectIdString });

const userSearchSchema = z.object({
  q: z
    .string()
    .trim()
    .min(2, "Type at least 2 characters")
    .max(20, "Usernames are at most 20 characters"),
});

module.exports = { sendRequestSchema, userSearchSchema };
