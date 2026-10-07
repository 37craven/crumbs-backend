const { z } = require("zod");

// A username as it appears in the URL. Same rules as registration, but it is
// matched case-insensitively, so "Jian" finds "jian".
const usernameParamSchema = z.strictObject({
  username: z
    .string()
    .trim()
    .min(1, "Username is required")
    .max(20, "Username must be at most 20 characters"),
});

module.exports = { usernameParamSchema };
