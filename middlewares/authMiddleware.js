const jwt = require("jsonwebtoken");
const User = require("../models/User");

// JWT token expiry settings
const ACCESS_TOKEN_EXPIRY = "2h"; // 2 hours — 15m was too short for mobile (refresh cycle caused logout)
const REFRESH_TOKEN_EXPIRY = "30d"; // 30 days — keep users logged in on mobile

// Generate access token
const generateAccessToken = (userId) => {
  return jwt.sign({ id: userId, type: "access" }, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
};

// Generate refresh token
const generateRefreshToken = (userId) => {
  if (!process.env.JWT_REFRESH_SECRET) {
    throw new Error("JWT_REFRESH_SECRET must be set separately from JWT_SECRET");
  }
  return jwt.sign(
    { id: userId, type: "refresh" },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY },
  );
};

// Generate both tokens
const generateTokens = (userId) => {
  return {
    accessToken: generateAccessToken(userId),
    refreshToken: generateRefreshToken(userId),
  };
};

const protect = async (req, res, next) => {
  let token;
  // Prefer httpOnly cookie, fall back to Authorization header
  if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  } else if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Check if token is access token
      if (decoded.type && decoded.type !== "access") {
        return res.status(401).json({ message: "Invalid token type" });
      }

      req.user = await User.findById(decoded.id).select("-password");

      if (!req.user) {
        return res.status(401).json({ message: "User not found" });
      }

      next();
    } catch (err) {
      console.error("Token verification error:", err.name);

      // Handle specific JWT errors
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({
          message: "Token expired",
          code: "TOKEN_EXPIRED",
        });
      }
      if (err.name === "JsonWebTokenError") {
        return res.status(401).json({
          message: "Invalid token",
          code: "INVALID_TOKEN",
        });
      }

      return res.status(401).json({ message: "Not authorized, token failed" });
    }
  } else {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};

// Cookie options helper
// Cross-domain (Vercel frontend <-> Render backend) requires sameSite: "none" + secure: true
// For localhost dev: sameSite: "lax", secure: false
const isProduction = process.env.NODE_ENV === "production";
const cookieOptions = (maxAgeMs) => ({
  httpOnly: true,
  secure: isProduction,       // must be true for SameSite=None
  sameSite: isProduction ? "none" : "lax", // "none" required for cross-origin on mobile
  path: "/",                  // explicit root path so cookie is sent on all routes
  maxAge: maxAgeMs,
});

// Clear auth cookies (used on logout)
const clearAuthCookies = (res) => {
  res.clearCookie("token", cookieOptions(0));
  res.clearCookie("refreshToken", cookieOptions(0));
};

// Set auth cookies
const setAuthCookies = (res, tokens) => {
  res.cookie("token", tokens.accessToken, cookieOptions(2 * 60 * 60 * 1000)); // 2 hours
  res.cookie("refreshToken", tokens.refreshToken, cookieOptions(30 * 24 * 60 * 60 * 1000)); // 30 days
};

// Middleware to refresh access token using refresh token
const refreshAccessToken = async (req, res) => {
  try {
    // Read from cookie first, then body (for backward compatibility)
    const refreshToken = (req.cookies && req.cookies.refreshToken) || req.body.refreshToken;

    if (!refreshToken) {
      return res.status(400).json({ error: "Refresh token required" });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    // Check if it's a refresh token
    if (decoded.type !== "refresh") {
      return res.status(401).json({ error: "Invalid token type" });
    }

    // Verify user still exists
    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // Generate new tokens (rotation)
    const tokens = generateTokens(user._id);

    // Set new httpOnly cookies
    setAuthCookies(res, tokens);

    res.json({
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
      },
    });
  } catch (err) {
    console.error("Refresh token error:", err.name);

    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        error: "Refresh token expired, please login again",
        code: "REFRESH_TOKEN_EXPIRED",
      });
    }

    return res.status(401).json({ error: "Invalid refresh token" });
  }
};

const isAdmin = (req, res, next) => {
  if (req.user && req.user.isAdmin) {
    next();
  } else {
    res.status(403).json({ message: "Not authorized as admin" });
  }
};

// Optional auth - doesn't fail if no token, but sets user if valid token present
const optionalAuth = async (req, res, next) => {
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      const token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select("-password");
    } catch (err) {
      // Silently fail for optional auth
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
};

module.exports = {
  protect,
  isAdmin,
  optionalAuth,
  generateAccessToken,
  generateRefreshToken,
  generateTokens,
  refreshAccessToken,
  setAuthCookies,
  clearAuthCookies,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY,
};
