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
const { imageUploader } = require("../middleware/upload");
const HttpError = require("../utils/httpError");
const { parseOrThrow } = require("../validators/common");
const {
  usernameSchema,
  updateProfileSchema,
  changePasswordSchema,
} = require("../validators/profile");
const { getFriendIds } = require("../services/friends");
const { publicUrl, removeStoredFiles } = require("../services/imageFiles");
const { MAX_AVATAR_SIZE } = require("../config/uploads");

const router = express.Router();

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

// Password changes get their own window so a burst of failed sign-ins cannot
// lock a real user out of changing their password.
const passwordLimiter = rateLimit({
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

// toPublic() cannot count friends, so it is added here, once, for the routes
// that return the signed-in user.
async function publicUser(user) {
  const friendIds = await getFriendIds(user._id);
  return user.toPublic({ friendsCount: friendIds.length });
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

router.get("/me", requireAuth, async (req, res) => {
  res.json({ user: await publicUser(req.user) });
});

// PATCH /api/auth/me — change first name, last name, username and email. Every
// field is sent each time. `409` names the fields another account already has.
router.patch("/me", requireAuth, async (req, res) => {
  const { firstName, lastName, username, email } = parseOrThrow(
    updateProfileSchema,
    req.body,
  );
  const usernameLower = username.toLowerCase();

  const taken = await User.find({
    _id: { $ne: req.user._id },
    $or: [{ email }, { usernameLower }],
  })
    .select("email usernameLower")
    .lean();

  const fields = {};
  for (const other of taken) {
    if (other.email === email) {
      fields.email = ["An account with that email already exists"];
    }
    if (other.usernameLower === usernameLower) {
      fields.username = ["That username is taken"];
    }
  }
  if (Object.keys(fields).length > 0) {
    throw new HttpError(409, "Email or username already in use", fields);
  }

  req.user.set({ firstName, lastName, username, email });
  await req.user.save();

  res.json({ user: await publicUser(req.user) });
});

// POST /api/auth/password — body { currentPassword, newPassword }.
// `400` when the current password is wrong, `204` on success.
router.post("/password", requireAuth, passwordLimiter, async (req, res) => {
  const { currentPassword, newPassword } = parseOrThrow(
    changePasswordSchema,
    req.body,
  );

  const user = await User.findById(req.user._id).select("+password");
  const valid = user && (await bcrypt.compare(currentPassword, user.password));

  if (!valid) {
    throw new HttpError(400, "Current password is incorrect", {
      currentPassword: ["Current password is incorrect"],
    });
  }
  if (currentPassword === newPassword) {
    throw new HttpError(400, "Choose a different password", {
      newPassword: ["Choose a password you are not already using"],
    });
  }

  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();

  res.status(204).send();
});

// PUT /api/auth/avatar — set the profile photo (multipart/form-data, field
// "image", up to 1 MB). Uploading again replaces it and deletes the old file.
router.put("/avatar", requireAuth, imageUploader(MAX_AVATAR_SIZE), async (req, res) => {
  if (!req.file) {
    throw new HttpError(
      400,
      'No image received. Send it as multipart/form-data in the field "image".',
    );
  }

  const previous = req.user.avatar?.filename;

  req.user.avatar = {
    filename: req.file.filename,
    url: publicUrl(req.file.filename),
    mimeType: req.file.mimetype,
    size: req.file.size,
    uploadedAt: new Date(),
  };
  await req.user.save();

  if (previous) await removeStoredFiles([previous]); // the replaced photo

  res.json({ user: await publicUser(req.user) });
});

// DELETE /api/auth/avatar — go back to the initial. The photo file goes too.
router.delete("/avatar", requireAuth, async (req, res) => {
  const previous = req.user.avatar?.filename;

  req.user.avatar = null;
  await req.user.save();

  if (previous) await removeStoredFiles([previous]);

  res.json({ user: await publicUser(req.user) });
});

module.exports = router;
