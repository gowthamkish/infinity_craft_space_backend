const express = require("express");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const router = express.Router();

// Get user's cart with populated product details
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const cart = await Cart.findOne({ userId }).populate({
      path: "items.productId",
      select:
        "name price description image category subCategory stock trackInventory",
    });

    if (!cart) {
      return res.json({ success: true, items: [] });
    }

    // Transform cart items to match frontend format
    const items = cart.items
      .filter((item) => item.productId) // Filter out items with deleted products
      .map((item) => ({
        product: {
          _id: item.productId._id,
          name: item.productId.name,
          price: item.productId.price,
          description: item.productId.description,
          image: item.productId.image,
          category: item.productId.category,
          subCategory: item.productId.subCategory,
          stock: item.productId.stock,
          trackInventory: item.productId.trackInventory,
        },
        quantity: item.quantity,
        totalPrice: item.quantity * item.productId.price,
      }));

    res.json({ success: true, items });
  } catch (error) {
    console.error("Get cart error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Sync entire cart from frontend (replace cart contents)
// Accepts optional clientUpdatedAt timestamp for last-write-wins conflict resolution.
// If the server cart is newer than what the client last saw, we reject the write
// so a stale second tab can't overwrite changes made in a newer tab.
router.post("/sync", async (req, res) => {
  try {
    const { userId, items, clientUpdatedAt } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
      });
    }

    const cartItems = items.map((item) => ({
      productId: item.product._id,
      quantity: item.quantity,
    }));

    let cart = await Cart.findOne({ userId });

    if (!cart) {
      cart = new Cart({ userId, items: cartItems });
    } else {
      // Last-write-wins: reject if server cart was updated AFTER the client's snapshot
      if (clientUpdatedAt && cart.updatedAt > new Date(clientUpdatedAt)) {
        return res.status(409).json({
          success: false,
          conflict: true,
          message: "Cart was updated from another session",
          serverUpdatedAt: cart.updatedAt,
        });
      }
      cart.items = cartItems;
    }

    await cart.save();
    res.json({ success: true, message: "Cart synced successfully", updatedAt: cart.updatedAt });
  } catch (error) {
    console.error("Cart sync error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Clear user's cart
router.delete("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    await Cart.findOneAndUpdate({ userId }, { items: [] });
    res.json({ success: true, message: "Cart cleared" });
  } catch (error) {
    console.error("Clear cart error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

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
