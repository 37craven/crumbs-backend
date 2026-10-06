const { z } = require("zod");

const MAX_NAME = 50;

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
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

module.exports = {
  usernameSchema,
  updateProfileSchema,
  changePasswordSchema,
  MAX_NAME,
};
