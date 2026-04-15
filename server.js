const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const cookieParser = require("cookie-parser");
require("dotenv").config();
const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/products");
const adminRoutes = require("./routes/admin");
const categoryRoutes = require("./routes/categories");
const { protect, isAdmin } = require("./middlewares/authMiddleware");
const { apiLimiter, strictLimiter } = require("./middlewares/rateLimiter");
const { sanitizeInput } = require("./middlewares/validators");

const app = express();

// Trust proxy for rate limiting behind reverse proxy (Render, Heroku, etc.)
app.set("trust proxy", 1);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:5173", "http://localhost:3000"];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, same-origin)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true, // Required for httpOnly cookies
  }),
);

app.use(cookieParser());

// Apply global rate limiting
app.use("/api/", apiLimiter);

// Apply input sanitization to all routes
app.use(sanitizeInput);

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
