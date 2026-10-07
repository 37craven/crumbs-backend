const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { limiter } = require("../config/rateLimits");
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
const { sendMail, linkTo } = require("../services/mailer");
const {
  VERIFY_TTL_MS,
  RESET_TTL_MS,
  hashToken,
  issueToken,
  tokenMatches,
  clearToken,
} = require("../services/tokens");

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

const emailSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

// Tokens come out of a URL, so they are long hex strings. The length bound stops
// a huge string being hashed; it does not narrow real tokens, which are 64.
const tokenField = z.string().trim().min(20, "That link is not valid").max(128, "That link is not valid");

const verifySchema = z.strictObject({ token: tokenField });
const resetSchema = z.strictObject({
  token: tokenField,
  newPassword: z.string().min(8, "Password must be at least 8 characters").max(200),
});

const authLimiter = limiter(
  15 * 60 * 1000,
  10,
  "Too many attempts, try again later",
);

// Registration has its own window, a little more generous. Sharing the sign-in
// ceiling meant a handful of sign-ups could lock everyone on one address (an
// office behind one NAT, say) out of even creating an account, and it made the
// smoke harness throttle itself after one run.
const registerLimiter = limiter(
  15 * 60 * 1000,
  20,
  "Too many accounts created from this address. Try again later.",
);

// Password changes get their own window so a burst of failed sign-ins cannot
// lock a real user out of changing their password.
const passwordLimiter = limiter(
  15 * 60 * 1000,
  10,
  "Too many attempts, try again later",
);

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

// Mail bodies live here so the wording is in one place. Both say the same thing
// about a link the reader has to click.
function verificationEmail(user, token) {
  const link = linkTo(`/verify-email?token=${token}`);
  return {
    to: user.email,
    subject: "Confirm your Crumbs account",
    text:
      `Hi ${user.username},\n\n` +
      `Confirm this address to finish setting up your account:\n\n` +
      `${link}\n\n` +
      `The link works once and expires in 24 hours. If you did not sign up, ` +
      `ignore this and nothing happens.`,
  };
}

function resetEmail(user, token) {
  const link = linkTo(`/reset-password?token=${token}`);
  return {
    to: user.email,
    subject: "Reset your Crumbs password",
    text:
      `Hi ${user.username},\n\n` +
      `Use the link below to choose a new password:\n\n` +
      `${link}\n\n` +
      `The link works once and expires in an hour. If you did not ask for this, ` +
      `ignore it and your password stays as it is.`,
  };
}

const sendVerificationEmail = (user, token) =>
  sendMail(verificationEmail(user, token));

// These two send mail to whoever asks, so they get their own, looser windows.
// Token guessing, so a much tighter window than the sign-in limiter.
const verifyLimiter = limiter(
  15 * 60 * 1000,
  20,
  "Too many attempts. Wait a few minutes and try again.",
);

const resetLimiter = limiter(
  15 * 60 * 1000,
  10,
  "Too many attempts. Wait a few minutes and try again.",
);

const mailLimiter = limiter(
  15 * 60 * 1000,
  5,
  "Too many requests. Wait a few minutes and try again.",
);

router.post("/register", registerLimiter, async (req, res) => {
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
  const user = await User.create({
    username,
    email,
    password: passwordHash,
    emailVerified: false,
  });

  // A verification link, then a deliberate stop: no cookie is set here. Signing
  // in now would defeat the point of verifying, so the user must click first.
  const token = await issueToken(user, "emailVerifyToken", VERIFY_TTL_MS);
  const { sent } = await sendVerificationEmail(user, token);

  // 201 but NOT signed in. `verificationEmailSent` false means the account
  // exists but the mail did not go out, and the user needs to be able to retry.
  res.status(201).json({
    user: user.toPublic(),
    verificationEmailSent: sent,
  });
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

  // Verification is mandatory, so a correct password is not enough. 403, not
  // 401: the credentials were right, the account just is not ready.
  if (user.emailVerified !== true) {
    return res.status(403).json({
      message: "Confirm your email address before signing in",
      emailVerified: false,
    });
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

// POST /api/auth/verify-email — body { token }. Marks the address verified,
// clears the token so the link cannot be replayed, and signs the user in, since
// clicking the emailed link IS the proof.
router.post("/verify-email", verifyLimiter, async (req, res) => {
  const { token } = parseOrThrow(verifySchema, req.body);

  const user = await User.findOne({
    "emailVerifyToken.hash": hashToken(token),
  }).select("+emailVerifyToken");

  // One message for "wrong token", "expired" and "already used": saying which
  // would let someone probe for valid tokens.
  if (!user || !tokenMatches(user.emailVerifyToken, token)) {
    throw new HttpError(400, "That link is not valid or has expired");
  }

  user.emailVerified = true;
  user.emailVerifiedAt = new Date();
  await clearToken(user, "emailVerifyToken");
  await user.save();

  setAuthCookie(res, user._id.toString());
  res.json({ user: await publicUser(user) });
});

// POST /api/auth/resend-verification — needs a session, which only exists for a
// verified account... so this one is for the window where someone registered,
// never got the mail, and cannot sign in. It is keyed on the email instead.
router.post("/resend-verification", mailLimiter, async (req, res) => {
  const { email } = parseOrThrow(emailSchema, req.body);

  const user = await User.findOne({ email });

  // Always the same answer, whether or not the address is on file.
  if (!user || user.emailVerified === true) {
    return res.status(202).json({ message: "If that account exists, a new link is on its way" });
  }

  const token = await issueToken(user, "emailVerifyToken", VERIFY_TTL_MS);
  await sendVerificationEmail(user, token);

  res.status(202).json({ message: "If that account exists, a new link is on its way" });
});

// POST /api/auth/forgot-password — body { email }.
//
// The reply is identical whether or not the address is registered. Anything
// else would let someone enumerate which emails have accounts.
router.post("/forgot-password", mailLimiter, async (req, res) => {
  const { email } = parseOrThrow(emailSchema, req.body);

  const user = await User.findOne({ email });

  if (user) {
    const token = await issueToken(user, "passwordResetToken", RESET_TTL_MS);
    await sendMail(resetEmail(user, token));
  }

  res.status(202).json({
    message: "If that email has an account, a reset link is on its way",
  });
});

// POST /api/auth/reset-password — body { token, newPassword }.
// Also marks the address verified: reading the link proves you can receive mail.
router.post("/reset-password", resetLimiter, async (req, res) => {
  const { token, newPassword } = parseOrThrow(resetSchema, req.body);

  const user = await User.findOne({
    "passwordResetToken.hash": hashToken(token),
  }).select("+passwordResetToken");

  if (!user || !tokenMatches(user.passwordResetToken, token)) {
    throw new HttpError(400, "That link is not valid or has expired");
  }

  user.password = await bcrypt.hash(newPassword, 10);
  user.emailVerified = true;
  user.emailVerifiedAt = new Date();
  await clearToken(user, "passwordResetToken");
  await user.save();

  res.status(204).send();
});

module.exports = router;
