const mongoose = require("mongoose");

const CartSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  items: [
    {
      productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
      quantity: { type: Number, default: 1 },
      priceAtTimeOfAdd: { type: Number, default: 0 }, // snapshot — guards against price changes before checkout
      variantId: { type: String, default: null },
    },
  ],
  updatedAt: { type: Date, default: Date.now },
});

CartSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("Cart", CartSchema);
