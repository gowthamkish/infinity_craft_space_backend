const express = require("express");
const mongoose = require("mongoose");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const { parseStringSize, resolveUnitPrice } = require("../utils/stringSizes");
const router = express.Router();

// SECURITY: the cart owner is ALWAYS the logged-in user (req.user, set by `protect`
// in server.js). A userId in the URL or body is never trusted — it used to be, which
// let any user read, clear or modify anyone else's cart.
const ownerId = (req) => String(req.user._id);
// "/me" is what the frontend calls; an explicit id is only accepted if it is the caller's own.
const isOwnParam = (req) => req.params.userId === "me" || req.params.userId === ownerId(req);
const lineKey = (productId, size) => `${productId}|${size ?? ""}`;
const PRODUCT_SELECT = "name price description image category subCategory stock trackInventory showStringSizePicker stringSizes";
// Shape one stored cart line for the frontend; string products are priced by their chosen size.
const toClientItem = (item) => {
  const p = item.productId;
  const { price } = resolveUnitPrice(p, item.stringSize);
  const sized = p.showStringSizePicker && p.stringSizes?.length > 0;
  return {
    product: {
      _id: p._id,
      name: p.name,
      price: price ?? p.price,
      description: p.description,
      image: p.image,
      category: p.category,
      subCategory: p.subCategory,
      stock: p.stock,
      trackInventory: p.trackInventory,
    },
    quantity: item.quantity,
    totalPrice: item.quantity * (price ?? p.price),
    ...(sized && item.stringSize != null ? { selectedStringSize: item.stringSize } : {}),
  };
};
const entriesToItems = (map) =>
  [...map.entries()].map(([key, quantity]) => {
    const [productId, size] = key.split("|");
    return { productId, quantity, stringSize: size === "" ? null : Number(size) };
  });
const parseQty = (q) => (Number.isInteger(Number(q)) && Number(q) >= 1 && Number(q) <= 100 ? Number(q) : null);

// Get user's cart with populated product details
router.get("/:userId", async (req, res) => {
  try {
    if (!isOwnParam(req)) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    const userId = ownerId(req);

    const cart = await Cart.findOne({ userId }).populate({
      path: "items.productId",
      select: PRODUCT_SELECT,
    });

    if (!cart) {
      return res.json({ success: true, items: [] });
    }

    // Transform cart items to match frontend format
    const items = cart.items
      .filter((item) => item.productId) // Filter out items with deleted products
      .map(toClientItem);

    res.json({ success: true, items });
  } catch (error) {
    console.error("Get cart error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Sync cart from frontend with merge-on-conflict strategy.
//
// Strategy:
//   • If the server cart was NOT modified since the client's last sync
//     (clientUpdatedAt >= cart.updatedAt), replace server cart with the
//     client's version — the client is authoritative.
//   • If the server cart IS newer (another tab / device wrote to it),
//     merge by taking the MAX quantity per product from both sides, then
//     return the merged cart so all tabs converge to the same state.
//     This avoids the "second tab silently discards first tab's items" bug.
router.post("/sync", async (req, res) => {
  try {
    const userId = ownerId(req);
    const { items, clientUpdatedAt } = req.body;

    if (items != null && !Array.isArray(items)) {
      return res.status(400).json({ success: false, error: "items must be an array" });
    }

    // Skip malformed lines and clamp quantities instead of throwing a 500
    const incomingMap = new Map();
    for (const item of items || []) {
      const pid = item?.product?._id;
      const qty = parseQty(item?.quantity);
      if (pid && qty) incomingMap.set(lineKey(pid, parseStringSize(item.selectedStringSize)), qty);
    }

    let cart = await Cart.findOne({ userId });

    if (!cart) {
      cart = new Cart({
        userId,
        items: entriesToItems(incomingMap),
      });
    } else {
      const serverIsNewer =
        clientUpdatedAt && cart.updatedAt > new Date(clientUpdatedAt);

      if (serverIsNewer) {
        // Merge: union of both carts, taking max quantity per product so no
        // items added in either tab are lost.
        const mergedMap = new Map(
          cart.items.map((item) => [lineKey(item.productId, item.stringSize), item.quantity])
        );
        incomingMap.forEach((qty, pid) => {
          mergedMap.set(pid, Math.max(mergedMap.get(pid) || 0, qty));
        });
        cart.items = entriesToItems(mergedMap);
      } else {
        // Client is authoritative — straightforward replace.
        cart.items = entriesToItems(incomingMap);
      }
    }

    await cart.save();

    // Always return the resolved cart so the calling tab can update its state.
    const populated = await Cart.findById(cart._id).populate({
      path: "items.productId",
      select: PRODUCT_SELECT,
    });

    const resolvedItems = (populated.items || [])
      .filter((item) => item.productId)
      .map(toClientItem);

    res.json({
      success: true,
      message: "Cart synced successfully",
      updatedAt: cart.updatedAt,
      items: resolvedItems,
    });
  } catch (error) {
    console.error("Cart sync error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear user's cart
router.delete("/:userId", async (req, res) => {
  try {
    if (!isOwnParam(req)) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    await Cart.findOneAndUpdate({ userId: ownerId(req) }, { items: [] });
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
    const userId = ownerId(req);
    const { productId } = req.body;
    const stringSize = parseStringSize(req.body.stringSize);
    const quantity = req.body.quantity === undefined ? 1 : parseQty(req.body.quantity);
    if (!mongoose.Types.ObjectId.isValid(String(productId)) || !quantity) {
      return res.status(400).json({ success: false, error: "Valid productId and quantity are required" });
    }

    // Check product stock
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    const sizeCheck = resolveUnitPrice(product, stringSize);
    if (sizeCheck.error) {
      return res.status(400).json({ success: false, error: sizeCheck.error });
    }

    // Check if inventory tracking is enabled and validate stock
    if (product.trackInventory) {
      // Get current quantity in cart
      let currentCartQuantity = 0;
      const existingCart = await Cart.findOne({ userId });
      if (existingCart) {
        // Stock is shared across all sizes of a product
        currentCartQuantity = existingCart.items
          .filter((item) => item.productId.toString() === productId)
          .reduce((sum, item) => sum + item.quantity, 0);
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
      cart = new Cart({ userId, items: [{ productId, quantity, stringSize: sizeCheck.stringSize }] });
    } else {
      const itemIndex = cart.items.findIndex(
        (item) => item.productId.toString() === productId && (item.stringSize ?? null) === sizeCheck.stringSize,
      );
      if (itemIndex > -1) {
        cart.items[itemIndex].quantity += quantity;
      } else {
        cart.items.push({ productId, quantity, stringSize: sizeCheck.stringSize });
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
