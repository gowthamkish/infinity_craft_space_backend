const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const mongoSanitize = require("express-mongo-sanitize");
const cron = require("node-cron");
require("dotenv").config();
const authRoutes = require("./routes/auth");
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
  const skipPaths = ["/api/payment/webhook", "/api/shipping/webhook", "/api/sse/stream"];
  if (skipPaths.some((p) => req.path.startsWith(p))) return next();

  const cookieToken = req.cookies._csrf;
  const headerToken = req.headers["x-csrf-token"];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ success: false, error: "Invalid CSRF token" });
  }
  next();
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
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error(err));

app.use("/api/auth", authRoutes);
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

// Error handling middleware for payload too large
app.use((error, req, res, next) => {
  if (error.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      error:
        "Payload too large. Please reduce the number of images or image sizes.",
      details: "Maximum allowed payload size is 50MB",
    });
  }
  next(error);
});

// Global error handler
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    message:
      process.env.NODE_ENV === "development"
        ? error.message
        : "Something went wrong",
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

// ── Abandoned cart cron — daily at 10:00 AM ──────────────────────────────────
cron.schedule("0 10 * * *", () => {
  require("./jobs/abandonedCartJob")();
});

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
