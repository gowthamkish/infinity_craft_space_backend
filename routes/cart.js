const express = require("express");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const router = express.Router();

// Add to cart with stock validation
router.post("/add", async (req, res) => {
  try {
    const { userId, productId, quantity } = req.body;

    // Check product stock
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    // Check if inventory tracking is enabled and validate stock
    if (product.trackInventory) {
      // Get current quantity in cart
      let currentCartQuantity = 0;
      const existingCart = await Cart.findOne({ userId });
      if (existingCart) {
        const cartItem = existingCart.items.find(
          (item) => item.productId.toString() === productId,
        );
        if (cartItem) {
          currentCartQuantity = cartItem.quantity;
        }
      }

      const requestedTotal = currentCartQuantity + quantity;

      if (product.stock <= 0) {
        return res.status(400).json({
          success: false,
          error: "This product is out of stock",
          outOfStock: true,
        });
      }

      if (requestedTotal > product.stock) {
        return res.status(400).json({
          success: false,
          error: `Only ${product.stock} items available in stock. You already have ${currentCartQuantity} in your cart.`,
          availableStock: product.stock,
          currentInCart: currentCartQuantity,
        });
      }
    }

    let cart = await Cart.findOne({ userId });
    if (!cart) {
      cart = new Cart({ userId, items: [{ productId, quantity }] });
    } else {
      const itemIndex = cart.items.findIndex(
        (item) => item.productId.toString() === productId,
      );
      if (itemIndex > -1) {
        cart.items[itemIndex].quantity += quantity;
      } else {
        cart.items.push({ productId, quantity });
      }
    }
    await cart.save();
    res.json({ success: true, cart });
  } catch (error) {
    console.error("Cart add error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
