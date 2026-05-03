const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const mongoSanitize = require("express-mongo-sanitize");
const cron = require("node-cron");
require("dotenv").config();
const authRoutes = require("./routes/auth");
const passwordResetRoutes = require("./routes/passwordReset");
const productRoutes = require("./routes/products");
const adminRoutes = require("./routes/admin");
const categoryRoutes = require("./routes/categories");
const { protect, isAdmin } = require("./middlewares/authMiddleware");
const { apiLimiter, strictLimiter } = require("./middlewares/rateLimiter");
const { sanitizeInput } = require("./middlewares/validators");

const crypto = require("crypto");
const app = express();

// Trust proxy for rate limiting behind reverse proxy (Render, Heroku, etc.)
app.set("trust proxy", 1);

// Log allowed origins for debugging
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [
      // Development
      "http://localhost:5173",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:3000",
      // Production
      "https://www.infinitycraftspace.com",
      "https://infinitycraftspace.com",
    ];

console.log("CORS Allowed Origins:", allowedOrigins);

// Security headers — CSP, X-Frame-Options, X-Content-Type-Options, etc.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // allow Cloudinary images
    contentSecurityPolicy: false, // managed separately if needed; avoid breaking CDN assets
  }),
);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, Postman, curl requests)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else if (process.env.NODE_ENV === "production") {
        console.warn(`CORS blocked: ${origin}`);
        callback(new Error(`CORS: Origin ${origin} not allowed`));
      } else {
        console.warn(`CORS dev-allow: ${origin}`);
        callback(null, true);
      }
    },
    credentials: true, // Required for httpOnly cookies
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin",
      "X-Requested-With",
      "X-CSRF-Token",
    ],
    exposedHeaders: ["Content-Length", "X-JSON-Response"],
    maxAge: 86400, // 24 hours
    optionsSuccessStatus: 200,
  }),
);

// Add additional CORS headers middleware for APIs
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin || "*");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization",
    );
    res.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    );
  }
  next();
});

app.use(cookieParser());

// Apply global rate limiting
app.use("/api/", apiLimiter);

// Recursively strip $ and . keys (NoSQL injection defence).
// Express 5 makes req.query read-only, so we call sanitize() manually on
// writable fields only instead of using the middleware form.
app.use((req, _res, next) => {
  if (req.body)   req.body   = mongoSanitize.sanitize(req.body,   { replaceWith: "_" });
  if (req.params) req.params = mongoSanitize.sanitize(req.params, { replaceWith: "_" });
  next();
});

// Apply input sanitization to all routes
app.use(sanitizeInput);

// ── CSRF protection ────────────────────────────────────────────────────────────
// Double-submit cookie pattern: server issues a random token in a readable cookie;
// client must echo it back in X-CSRF-Token header on every state-changing request.
app.get("/api/auth/csrf-token", (req, res) => {
  const token = crypto.randomBytes(32).toString("hex");
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("_csrf", token, {
    httpOnly: false,   // Must be readable by JS so the client can send it as a header
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });
  res.json({ csrfToken: token });
});

function csrfProtect(req, res, next) {
  // Only enforce on state-changing methods
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // Skip CSRF check for Razorpay webhook (uses signature-based auth) and SSE
  // Login/register have no authenticated session to exploit, so CSRF is not needed.
  // More importantly, iOS Safari (ITP) blocks cross-origin cookies, which breaks the
  // double-submit cookie pattern for these first-time calls before any session exists.
  const skipPaths = [
    "/api/payment/webhook",
    "/api/shipping/webhook",
    "/api/sse/stream",
    "/api/auth/login",
    "/api/auth/register",
    // Password-reset flow: unauthenticated calls before session exists
    "/api/auth/forgot-password",
    "/api/auth/verify-otp",
    "/api/auth/verify-answers",
    "/api/auth/reset-password",
  ];
  if (skipPaths.some((p) => req.path.startsWith(p))) return next();

  const cookieToken = req.cookies._csrf;
  const headerToken = req.headers["x-csrf-token"];

  // Standard double-submit cookie check
  if (cookieToken && headerToken && cookieToken === headerToken) return next();

  // iOS Safari ITP blocks third-party cookies on cross-origin requests, so the
  // _csrf cookie may never arrive. Fall back to Origin/Referer validation:
  // if the request comes from a trusted origin AND includes any X-CSRF-Token header,
  // it cannot be a cross-site forgery (browsers set Origin on all cross-origin requests
  // and it is a forbidden header that JS cannot spoof).
  if (headerToken) {
    const origin = req.headers.origin || req.headers.referer || "";
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const trusted = allowedOrigins.some((o) => origin.startsWith(o));
    if (trusted) return next();
  }

  return res.status(403).json({ success: false, error: "Invalid CSRF token" });
}
app.use(csrfProtect);

// Increase payload size limits for multiple image uploads
app.use(
  express.json({
    limit: "50mb", // Increase JSON payload limit
    extended: true,
  }),
);
app.use(
  express.urlencoded({
    limit: "50mb",
    extended: true,
    parameterLimit: 50000,
  }),
);

// gowthamkish
// gowthamkish93
mongoose
  .connect(process.env.MONGO_URI, {
    maxPoolSize: 10,              // up from default 5; handles concurrent requests under load
    serverSelectionTimeoutMS: 5000, // fail fast if Atlas is unreachable
    socketTimeoutMS: 45000,        // drop idle sockets after 45s
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error(err));

app.use("/api/auth", authRoutes);
app.use("/api/auth", passwordResetRoutes);
app.use("/api/products", productRoutes);
app.use("/api/admin", protect, isAdmin, adminRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/orders", protect, require("./routes/order"));
app.use("/api/cart", protect, require("./routes/cart"));
app.use("/api/payment", strictLimiter, require("./routes/payment")); // Strict limiting for payments
app.use("/api/reviews", require("./routes/reviews"));
app.use("/api/coupons", require("./routes/coupons"));
app.use("/api/qna", require("./routes/qna"));
app.use("/api/returns", require("./routes/returns"));
// Shiprocket shipping integration (webhook is public, rest is protected inside the router)
app.use("/api/shipping", require("./routes/shipping"));
// Pincode-based delivery estimation (public)
app.use("/api/delivery", require("./routes/delivery"));
// Server-Sent Events — real-time order status push
app.use("/api/sse", require("./routes/sse"));
// WhatsApp notifications (admin APIs: logs, test, resend)
app.use("/api/whatsapp", require("./routes/whatsapp"));
// Dynamic sitemap (no auth required — for search engine crawlers)
app.use("/", require("./routes/sitemap"));

// ── Centralised error handler ─────────────────────────────────────────────────
// Differentiates operational errors (safe to expose) from programmer errors
// (log + generic message) so Sentry doesn't fill up with expected 4xx noise.
app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  // Payload too large (multer / express.json limit)
  if (error.type === "entity.too.large" || error.status === 413) {
    return res.status(413).json({
      success: false,
      error: "Payload too large. Please reduce the number of images or image sizes.",
      details: "Maximum allowed payload size is 50MB",
    });
  }

  // Mongoose bad ObjectId (e.g. /api/products/not-an-id)
  if (error.name === "CastError" && error.kind === "ObjectId") {
    return res.status(400).json({ success: false, error: "Invalid ID format" });
  }

  // Mongoose duplicate key (e.g. duplicate email on register)
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue || {})[0] || "field";
    return res.status(409).json({
      success: false,
      error: `${field.charAt(0).toUpperCase() + field.slice(1)} already exists`,
    });
  }

  // Mongoose validation error (schema-level constraints)
  if (error.name === "ValidationError") {
    const messages = Object.values(error.errors).map((e) => e.message);
    return res.status(400).json({ success: false, error: messages.join(", ") });
  }

  // JWT errors (malformed token outside of auth middleware)
  if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }

  // CORS rejection
  if (error.message && error.message.startsWith("CORS:")) {
    return res.status(403).json({ success: false, error: error.message });
  }

  // Programmer / unexpected error — log fully, return generic message
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    message: process.env.NODE_ENV === "development" ? error.message : "Something went wrong",
  });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    uptime: process.uptime(),
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  }),
);

// ── Abandoned cart cron — daily at 10:00 AM IST ──────────────────────────────
cron.schedule("0 10 * * *", () => {
  require("./jobs/abandonedCartJob")();
}, { timezone: "Asia/Kolkata" });

// ── WhatsApp retry cron — every 10 minutes, sweep failed/pending logs ─────────
cron.schedule("*/10 * * * *", async () => {
  try {
    const { retryFailedNotifications } = require("./services/whatsappService");
    const count = await retryFailedNotifications();
    if (count > 0) console.log(`[WhatsApp Cron] Retried ${count} failed notification(s)`);
  } catch (err) {
    console.error("[WhatsApp Cron] Error:", err.message);
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
