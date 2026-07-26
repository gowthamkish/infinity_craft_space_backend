const mongoose = require("mongoose");

const VariantSchema = new mongoose.Schema(
  {
    variantId: String,
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

const BulkDiscountSchema = new mongoose.Schema(
  {
    minQuantity: {
      type: Number,
      required: true,
    },
    maxQuantity: Number,
    discount: {
      type: Number,
      required: true, // percentage
    },
  },
  { _id: false },
);

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  // SEO-friendly slug: auto-generated from name if not provided
  // e.g. "Handmade Resin Coaster Set" → "handmade-resin-coaster-set"
  slug: { type: String, trim: true },
  price: { type: Number, required: true },
  description: { type: String },
  category: { type: String, required: true },
  subCategory: { type: String, required: true },

  // Stock/Inventory Management
  stock: { type: Number, default: 0, min: 0 },
  lowStockThreshold: { type: Number, default: 5, min: 0 },
  trackInventory: { type: Boolean, default: true },
  estimatedDelivery: { type: Number, default: 5 }, // days (fallback when no pincode given)

  // Customizable / made-to-order product settings
  isActive: { type: Boolean, default: true, index: true },
  isCustomizable: { type: Boolean, default: false },
  processingDaysMin: { type: Number, default: 10, min: 0 }, // business days before dispatch
  processingDaysMax: { type: Number, default: 12, min: 0 },

  // Shipping weight — stored in grams for precision
  // Admin sets this per product; used to calculate roadways shipping charge at checkout
  weightInGrams: { type: Number, default: 500, min: 1 },

  // Images
  images: [
    {
      url: { type: String },
      publicId: { type: String },
      originalName: { type: String },
      isPrimary: { type: Boolean, default: false },
      uploadedAt: { type: Date, default: Date.now },
    },
  ],
  image: {
    url: { type: String },
    publicId: { type: String },
    originalName: { type: String },
    uploadedAt: { type: Date, default: Date.now },
  },

  // Variants support
  hasVariants: {
    type: Boolean,
    default: false,
  },
  variantTypes: [String], // ['color', 'size', 'material']
  variants: [VariantSchema],

  // Color variants
  showColorPickerToUsers: { type: Boolean, default: false },
  colors: [
    {
      name:             { type: String, required: true, maxlength: 30 },
      hex:              { type: String, required: true },
      stock:            { type: Number, default: 0, min: 0 },
      visibleToUsers:   { type: Boolean, default: true },
      sortOrder:        { type: Number, default: 0 },
    },
  ],

  // Bulk discounts
  bulkDiscounts: [BulkDiscountSchema],

  // Product recommendations
  tags: [String], // for recommendation algorithm
  relatedProducts: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
  ],

  // SEO and metadata
  seoTitle: String,
  seoDescription: String,
  seoKeywords: [String],

  // Product rating summary
  averageRating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5,
  },
  ratingCount: {
    type: Number,
    default: 0,
  },

  // Vector embedding for Atlas Vector Search (RAG chatbot)
  // Populated by utils/embeddings.js — not returned in normal queries
  embedding: { type: [Number], select: false },
  embeddingUpdatedAt: { type: Date, select: false },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  lastEditedBy: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: { type: String },
    email: { type: String },
  },
  lastEditedAt: { type: Date },
});

// Indexes for common queries
ProductSchema.index({ category: 1, subCategory: 1 });
ProductSchema.index({ category: 1, price: 1 });
ProductSchema.index({ name: "text", description: "text", tags: "text" });
ProductSchema.index({ stock: 1, trackInventory: 1 });
ProductSchema.index({ averageRating: -1, ratingCount: -1 });
ProductSchema.index({ price: 1 });
ProductSchema.index({ isCustomizable: 1 });
// Compound index covering the most common catalog query: active products in a category sorted by price
ProductSchema.index({ isActive: 1, category: 1, price: 1 });
// Low-stock alert queries
ProductSchema.index({ trackInventory: 1, stock: 1, lowStockThreshold: 1 });
// Slug lookups (added with slug field)
ProductSchema.index({ slug: 1 }, { unique: true, sparse: true });
// Covers getAllProducts filter: isActive + category + subCategory (sorted by price or rating)
ProductSchema.index({ isActive: 1, category: 1, subCategory: 1, price: 1 });
// Default sort: newest first
ProductSchema.index({ createdAt: -1 });

// Auto-generate slug from name before saving
ProductSchema.pre("save", async function (next) {
  if (this.isModified("name") && !this.slug) {
    const base = this.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80);
    // Append last 5 chars of ObjectId for uniqueness without ugly random strings
    const suffix = this._id.toString().slice(-5);
    this.slug = `${base}-${suffix}`;
  }
  next();
});

// Re-embed asynchronously whenever descriptive fields change.
// Fire-and-forget — don't block the save response waiting for Voyage.
const EMBEDDING_FIELDS = ["name", "description", "category", "subCategory", "tags", "isCustomizable", "colors", "variants", "price", "seoKeywords"];
ProductSchema.post("save", function (doc) {
  if (!process.env.VOYAGE_API_KEY) return;
  const changed = EMBEDDING_FIELDS.some((f) => doc.isDirectModified?.(f));
  if (!changed && doc.embedding?.length) return; // nothing descriptive changed
  const { embedText, buildProductText } = require("../utils/embeddings");
  embedText(buildProductText(doc))
    .then((embedding) =>
      doc.constructor.updateOne(
        { _id: doc._id },
        { $set: { embedding, embeddingUpdatedAt: new Date() } },
      ),
    )
    .catch((err) => console.error("[Embedding] Failed to update product embedding:", err.message));
});

module.exports = mongoose.model("Product", ProductSchema);
