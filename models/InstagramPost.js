const mongoose = require("mongoose");

/**
 * A curated Instagram post shown on the home page, with "shop the look" product tags.
 * The photo is uploaded to Cloudinary (not hot-linked from Instagram, whose image URLs expire),
 * and `permalink` points at the real Instagram post.
 */
const TagSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    x: { type: Number, min: 0, max: 100, required: true }, // pin position, % from the left of the photo
    y: { type: Number, min: 0, max: 100, required: true }, // pin position, % from the top
  },
  { _id: false },
);

const InstagramPostSchema = new mongoose.Schema(
  {
    imageUrl: { type: String, required: true },
    imagePublicId: { type: String },
    permalink: { type: String, trim: true, default: "" }, // https://www.instagram.com/p/XXXX/
    caption: { type: String, trim: true, maxlength: 300, default: "" },
    tags: { type: [TagSchema], default: [] },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

InstagramPostSchema.index({ isActive: 1, createdAt: -1 });

module.exports = mongoose.model("InstagramPost", InstagramPostSchema);
