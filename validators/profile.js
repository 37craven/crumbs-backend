const { z } = require("zod");

const MAX_NAME = 50;

// bcrypt only looks at the first 72 bytes of a password. Anything beyond that
// would be silently ignored, so two different long passwords could unlock the
// same account. Cap by bytes rather than characters: "é" is two bytes in UTF-8.
const PASSWORD_MAX_BYTES = 72;

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= PASSWORD_MAX_BYTES,
    `Password must be at most ${PASSWORD_MAX_BYTES} bytes`,
  );

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(20, "Username must be at most 20 characters")
  .regex(
    /^[a-zA-Z0-9_]+$/,
    "Username can only contain letters, numbers and underscores",
  );

const nameField = (label) =>
  z
    .string()
    .trim()
    .max(MAX_NAME, `${label} must be at most ${MAX_NAME} characters`);

// Every field is required so the client always sends a complete profile. The
// names may be empty; the username and email may not.
const updateProfileSchema = z.strictObject({
  firstName: nameField("First name"),
  lastName: nameField("Last name"),
  username: usernameSchema,
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: passwordSchema,
});

module.exports = {
  usernameSchema,
  updateProfileSchema,
  changePasswordSchema,
  passwordSchema,
  MAX_NAME,
  PASSWORD_MAX_BYTES,
};
