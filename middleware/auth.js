const jwt = require("jsonwebtoken");
const User = require("../models/User");

const COOKIE_NAME = "crumbs_token";

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  });
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function setAuthCookie(res, userId) {
  res.cookie(COOKIE_NAME, signToken(userId), cookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
}

async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid or expired session" });
  }

  const user = await User.findById(payload.sub);
  if (!user) {
    return res.status(401).json({ message: "Invalid or expired session" });
  }

  req.user = user;
  next();
}

module.exports = {
  COOKIE_NAME,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
};
