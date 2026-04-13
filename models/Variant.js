const mongoose = require("mongoose");

const VariantSchema = new mongoose.Schema(
  {
    variantId: {
      type: String,
      required: true,
    },
    name: String, // e.g., "Red, Size M"
    sku: String,
    type: {
      type: String,
      enum: ["color", "size", "material", "combo", "custom"],
      required: true,
    },
    attributes: {
      color: String,
      size: String,
      material: String,
      customAttribute: String,
    },
    price: Number, // Override base price
    stock: {
      type: Number,
      default: 0,
    },
    images: [String], // Cloudinary URLs
    barcode: String,
    weight: Number, // in grams
    dimensions: {
      length: Number,
      width: Number,
      height: Number,
      unit: { type: String, default: "cm" },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true },
);

module.exports = mongoose.model("Variant", VariantSchema);
