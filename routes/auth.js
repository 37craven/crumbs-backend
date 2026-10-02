const express = require("express");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
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

const updateProfileSchema = z.object({
  name: z.string().trim().max(50, "Name must be at most 50 characters"),
  username: usernameSchema,
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

const AVATAR_MAX_BYTES = 1024 * 1024;

const avatarBody = express.raw({
  type: ["image/jpeg", "image/png", "image/webp"],
  limit: AVATAR_MAX_BYTES,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many attempts, try again later" },
});

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many attempts, try again later" },
});

function sniffImageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length > 8 && buf.subarray(0, 8).equals(pngSignature)) {
    return "image/png";
  }
  if (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function receiveAvatar(req, res, next) {
  avatarBody(req, res, (error) => {
    if (error?.type === "entity.too.large") {
      return res.status(413).json({ message: "Image is too large (1 MB max)" });
    }
    next(error);
  });
}

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

router.patch("/me", requireAuth, async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { name, username, email } = parsed.data;
  const usernameLower = username.toLowerCase();

  const conflicts = await User.find({
    _id: { $ne: req.user._id },
    $or: [{ email }, { usernameLower }],
  }).lean();

  const fields = {};
  for (const other of conflicts) {
    if (other.email === email) {
      fields.email = ["An account with that email already exists"];
    }
    if (other.usernameLower === usernameLower) {
      fields.username = ["That username is taken"];
    }
  }
  if (Object.keys(fields).length > 0) {
    return res
      .status(409)
      .json({ message: "Email or username already in use", fields });
  }

  req.user.set({ name, username, email });
  try {
    await req.user.save();
  } catch (error) {
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ message: "Email or username already in use" });
    }
    throw error;
  }

  res.json({ user: req.user.toPublic() });
});

router.post("/password", requireAuth, passwordLimiter, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { currentPassword, newPassword } = parsed.data;

  const user = await User.findById(req.user._id).select("+password");
  const valid = user && (await bcrypt.compare(currentPassword, user.password));

  if (!valid) {
    return res.status(400).json({
      message: "Current password is incorrect",
      fields: { currentPassword: ["Current password is incorrect"] },
    });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({
      message: "Choose a different password",
      fields: { newPassword: ["Choose a password you are not already using"] },
    });
  }

  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();

  res.status(204).send();
});

router.put("/avatar", requireAuth, receiveAvatar, async (req, res) => {
  const image = Buffer.isBuffer(req.body) ? req.body : null;
  const contentType = image && sniffImageType(image);

  if (!contentType) {
    return res
      .status(400)
      .json({ message: "Upload a JPEG, PNG or WebP image" });
  }

  req.user.avatarData = image;
  req.user.avatarContentType = contentType;
  req.user.avatarUpdatedAt = new Date();
  await req.user.save();

  res.json({ user: req.user.toPublic() });
});

router.delete("/avatar", requireAuth, async (req, res) => {
  await User.updateOne(
    { _id: req.user._id },
    { $unset: { avatarData: 1, avatarContentType: 1, avatarUpdatedAt: 1 } },
  );

  const user = await User.findById(req.user._id);
  res.json({ user: user.toPublic() });
});

router.get("/avatar/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).end();
  }

  const user = await User.findById(req.params.id).select("+avatarData");
  if (!user?.avatarData) {
    return res.status(404).end();
  }

  res.set({
    "Content-Type": user.avatarContentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(Buffer.from(user.avatarData));
});

module.exports = router;