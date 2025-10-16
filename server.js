const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();
const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/products");
const adminRoutes = require("./routes/admin");
const categoryRoutes = require("./routes/categories");
const { protect, isAdmin } = require("./middlewares/authMiddleware");

const app = express();
app.use(cors());

// Increase payload size limits for multiple image uploads
app.use(express.json({ 
  limit: '50mb',  // Increase JSON payload limit
  extended: true 
}));
app.use(express.urlencoded({ 
  limit: '50mb', 
  extended: true, 
  parameterLimit: 50000 
}));

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
app.use("/api/payment", require("./routes/payment"));

// Error handling middleware for payload too large
app.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: 'Payload too large. Please reduce the number of images or image sizes.',
      details: 'Maximum allowed payload size is 50MB'
    });
  }
  next(error);
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
