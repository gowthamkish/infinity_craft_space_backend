/**
 * POST /api/delivery/estimate
 *
 * Returns estimated delivery dates for a given product + customer pincode.
 * No authentication required (public endpoint).
 *
 * Request body: { pincode: "560001", productId: "xyz" }
 *
 * Response (success):
 * {
 *   minDays, maxDays,
 *   processingDaysMin, processingDaysMax,
 *   totalMinDays, totalMaxDays,
 *   isCustom,
 *   estimatedMinDate, estimatedMaxDate,
 *   displayRange,
 *   customerState, customerZone,
 * }
 *
 * Response (error):
 * { success: false, code: "INVALID_PINCODE"|"NOT_SERVICEABLE"|"PRODUCT_NOT_FOUND", message }
 */

const express = require("express");
const router = express.Router();
const Product = require("../models/Product");
const { estimateDelivery, isValidPincode } = require("../utils/deliveryCalculator");

// Rate-limit: reuse apiLimiter if available, else no-op
let apiLimiter;
try {
  apiLimiter = require("../middleware/rateLimiter")?.apiLimiter;
} catch {
  apiLimiter = null;
}

// ── POST /api/delivery/estimate ───────────────────────────────────────────────

const estimateHandler = async (req, res) => {
  const { pincode, productId } = req.body;

  // ── 1. Basic input validation ─────────────────────────────────────────────
  if (!pincode || !productId) {
    return res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      message: "Both pincode and productId are required.",
    });
  }

  if (!isValidPincode(pincode)) {
    return res.status(400).json({
      success: false,
      code: "INVALID_PINCODE",
      message: "Please enter a valid 6-digit PIN code.",
    });
  }

  // ── 2. Load product ───────────────────────────────────────────────────────
  let product;
  try {
    product = await Product.findById(productId).lean().select(
      "isCustomizable processingDaysMin processingDaysMax name estimatedDelivery"
    );
  } catch {
    return res.status(400).json({
      success: false,
      code: "INVALID_PRODUCT",
      message: "Invalid product ID.",
    });
  }

  if (!product) {
    return res.status(404).json({
      success: false,
      code: "PRODUCT_NOT_FOUND",
      message: "Product not found.",
    });
  }

  // ── 3. Calculate estimate ─────────────────────────────────────────────────
  const result = estimateDelivery(pincode, product);

  if (!result.success) {
    const status = result.code === "INVALID_PINCODE" ? 400 : 422;
    return res.status(status).json(result);
  }

  return res.json(result);
};

// Apply rate limiter only if it was successfully imported
if (apiLimiter) {
  router.post("/estimate", apiLimiter, estimateHandler);
} else {
  router.post("/estimate", estimateHandler);
}

module.exports = router;
