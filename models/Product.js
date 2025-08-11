const mongoose = require("mongoose");
const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: String,
  category: { type: String },
  subCategory: { type: String },
  image: { type: String },
});
module.exports = mongoose.model("Product", ProductSchema);
