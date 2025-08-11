const express = require("express");
const Cart = require("../models/Cart");
const router = express.Router();

// Add to cart
router.post("/add", async (req, res) => {
  const { userId, productId, quantity } = req.body;
  let cart = await Cart.findOne({ userId });
  if (!cart) {
    cart = new Cart({ userId, items: [{ productId, quantity }] });
  } else {
    const itemIndex = cart.items.findIndex(
      (item) => item.productId.toString() === productId
    );
    if (itemIndex > -1) {
      cart.items[itemIndex].quantity += quantity;
    } else {
      cart.items.push({ productId, quantity });
    }
  }
  await cart.save();
  res.json(cart);
});

module.exports = router;
