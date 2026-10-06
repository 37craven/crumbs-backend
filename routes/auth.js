const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");
const User = require("../models/User");
const {
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
} = require("../middleware/auth");

const router = express.Router();

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(20, "Username must be at most 20 characters")
  .regex(
    /^[a-zA-Z0-9_]+$/,
    "Username can only contain letters, numbers and underscores",
  );

const registerSchema = z.object({
  username: usernameSchema,
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many attempts, try again later" },
});

function validationError(res, error) {
  return res.status(400).json({
    message: "Validation failed",
    fields: error.flatten().fieldErrors,
  });
}

router.post("/register", authLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { username, email, password } = parsed.data;

  const existing = await User.findOne({
    $or: [{ email }, { usernameLower: username.toLowerCase() }],
  }).lean();

  if (existing) {
    const message =
      existing.email === email
        ? "An account with that email already exists"
        : "That username is taken";
    return res.status(409).json({ message });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ username, email, password: passwordHash });

  setAuthCookie(res, user._id.toString());
  res.status(201).json({ user: user.toPublic() });
});

router.post("/login", authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { email, password } = parsed.data;

  const user = await User.findOne({ email }).select("+password");
  const valid = user && (await bcrypt.compare(password, user.password));

  if (!valid) {
    return res.status(401).json({ message: "Invalid email or password" });
  }

  setAuthCookie(res, user._id.toString());
  res.json({ user: user.toPublic() });
});

router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.status(204).send();
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user.toPublic() });
});

module.exports = router;
