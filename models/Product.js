const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: { type: String },
  category: { type: String, required: true },
  subCategory: { type: String, required: true },
  images: [{
    url: { type: String }, // Cloudinary URL
    publicId: { type: String }, // Cloudinary public ID for deletion
    originalName: { type: String }, // Original filename
    isPrimary: { type: Boolean, default: false }, // Mark primary image
    uploadedAt: { type: Date, default: Date.now }
  }],
  // Keep backward compatibility with old single image field
  image: {
    url: { type: String }, // Cloudinary URL
    publicId: { type: String }, // Cloudinary public ID for deletion
    originalName: { type: String }, // Original filename
    uploadedAt: { type: Date, default: Date.now }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Product", ProductSchema);
