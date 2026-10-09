const Product = require("../models/Product");
const Order = require("../models/Order");

/**
 * Recommendation Engine Service
 * Provides product recommendations using multiple algorithms
 */

// `$in` queries return documents in arbitrary order, which discards a ranking
// computed beforehand. Re-sort the docs to match `rankedIds` in O(n) via a
// Map of id → rank.
const orderByRank = (docs, rankedIds) => {
  const rank = new Map(rankedIds.map((id, i) => [String(id), i]));
  return docs.sort((a, b) => rank.get(String(a._id)) - rank.get(String(b._id)));
};

// Get recommendations based on category/tags matching
exports.getRecommendationsByProductId = async (productId, limit = 6) => {
  try {
    const product = await Product.findById(productId).select(
      "category tags subCategory",
    );

    if (!product) {
      return [];
    }

    // Find similar products by category and tags
    const recommendations = await Product.find({
      _id: { $ne: productId },
      $or: [
        { category: product.category },
        { tags: { $in: product.tags || [] } },
        { subCategory: product.subCategory },
      ],
    })
      .limit(limit)
      .select("name price images averageRating ratingCount stock");

    return recommendations;
  } catch (error) {
    console.error("Error generating recommendations:", error);
    return [];
  }
};

// Get popular products
exports.getPopularProducts = async (limit = 6, minRating = 3.5) => {
  try {
    const products = await Product.find({
      averageRating: { $gte: minRating },
      ratingCount: { $gte: 5 },
    })
      .sort({ averageRating: -1, ratingCount: -1 })
      .limit(limit)
      .select("name price images averageRating ratingCount stock");

    return products;
  } catch (error) {
    console.error("Error fetching popular products:", error);
    return [];
  }
};

// Get trending products (recently purchased)
exports.getTrendingProducts = async (limit = 6, days = 7) => {
  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const trendingOrders = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
          status: { $ne: "cancelled" },
        },
      },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.product._id",
          count: { $sum: 1 },
          totalSales: { $sum: "$items.totalPrice" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]);

    const productIds = trendingOrders.map((item) => item._id);

    const products = await Product.find({ _id: { $in: productIds } }).select(
      "name price images averageRating ratingCount stock",
    );

    return orderByRank(products, productIds); // keep most-purchased first
  } catch (error) {
    console.error("Error fetching trending products:", error);
    return [];
  }
};

// Get personalized recommendations for user
exports.getPersonalizedRecommendations = async (userId, limit = 6) => {
  try {
    // Get user's purchase history
    const userOrders = await Order.find({ userId }).select("items").limit(5);

    if (userOrders.length === 0) {
      // Return popular products if user has no history
      return exports.getPopularProducts(limit);
    }

    // Extract categories from purchases — Sets dedupe repeat purchases so the
    // $in / $nin lists stay small
    const purchasedCategories = new Set();
    const purchasedProductIds = new Map(); // String(id) → ObjectId

    userOrders.forEach((order) => {
      order.items.forEach((item) => {
        if (!item.product) return;
        if (item.product.category) purchasedCategories.add(item.product.category);
        if (item.product._id) purchasedProductIds.set(String(item.product._id), item.product._id);
      });
    });

    // Find similar products they haven't purchased
    const recommendations = await Product.find({
      _id: { $nin: [...purchasedProductIds.values()] },
      category: { $in: [...purchasedCategories] },
    })
      .sort({ averageRating: -1, ratingCount: -1 })
      .limit(limit)
      .select("name price images averageRating ratingCount stock");

    return recommendations;
  } catch (error) {
    console.error("Error fetching personalized recommendations:", error);
    return [];
  }
};

// Get products frequently bought together
exports.getBoughtTogether = async (productId, limit = 4) => {
  try {
    // Find orders containing this product
    const orders = await Order.find({
      "items.product._id": productId,
    })
      .select("items")
      .limit(50);

    // Count co-purchases with a hash map (id → count). The query already
    // guarantees each order contains productId. Count each co-product once
    // per order, so a product listed twice in one order isn't double-counted.
    const target = String(productId);
    const coProductCounts = new Map();

    orders.forEach((order) => {
      const seen = new Set();
      order.items.forEach((item) => {
        const id = item.product?._id ? String(item.product._id) : null;
        if (!id || id === target || seen.has(id)) return;
        seen.add(id);
        coProductCounts.set(id, (coProductCounts.get(id) || 0) + 1);
      });
    });

    // Get top co-purchased products
    const topProducts = [...coProductCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([id]) => id);

    const products = await Product.find({ _id: { $in: topProducts } }).select(
      "name price images averageRating ratingCount stock",
    );

    return orderByRank(products, topProducts); // most co-purchased first
  } catch (error) {
    console.error("Error fetching bought together products:", error);
    return [];
  }
};

// Update related products for a product
exports.updateRelatedProducts = async (productId) => {
  try {
    const product = await Product.findById(productId);

    if (!product) {
      return;
    }

    // Get recommendations and update relatedProducts field
    const recommendations = await exports.getRecommendationsByProductId(
      productId,
      10,
    );
    const relatedIds = recommendations
      .map((p) => p._id)
      .filter((id) => id.toString() !== productId);

    await Product.findByIdAndUpdate(productId, {
      relatedProducts: relatedIds,
    });
  } catch (error) {
    console.error("Error updating related products:", error);
  }
};
