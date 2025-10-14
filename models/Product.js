const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: { type: String },
  category: { type: String, required: true },
  subCategory: { type: String, required: true },
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
