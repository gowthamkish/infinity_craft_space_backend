const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: { type: String },
  category: { type: String, required: true },
  subCategory: { type: String, required: true },
  // Stock/Inventory Management
  stock: { type: Number, default: 0, min: 0 },
  lowStockThreshold: { type: Number, default: 5, min: 0 }, // Show "Only X left" when stock <= this value
  trackInventory: { type: Boolean, default: true }, // Enable/disable inventory tracking
  images: [
    {
      url: { type: String }, // Cloudinary URL
      publicId: { type: String }, // Cloudinary public ID for deletion
      originalName: { type: String }, // Original filename
      isPrimary: { type: Boolean, default: false }, // Mark primary image
      uploadedAt: { type: Date, default: Date.now },
    },
  ],
  // Keep backward compatibility with old single image field
  image: {
    url: { type: String }, // Cloudinary URL
    publicId: { type: String }, // Cloudinary public ID for deletion
    originalName: { type: String }, // Original filename
    uploadedAt: { type: Date, default: Date.now },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  lastEditedBy: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: { type: String },
    email: { type: String },
  },
  lastEditedAt: { type: Date },
});

module.exports = mongoose.model("Product", ProductSchema);
