const Product = require("../models/Product");
const Order = require("../models/Order");

/**
 * Recommendation Engine Service
 * Provides product recommendations using multiple algorithms
 */

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

    return products;
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

    // Extract categories from purchases
    const purchasedCategories = [];
    const purchasedProductIds = [];

    userOrders.forEach((order) => {
      order.items.forEach((item) => {
        purchasedCategories.push(item.product.category);
        purchasedProductIds.push(item.product._id);
      });
    });

    // Find similar products they haven't purchased
    const recommendations = await Product.find({
      _id: { $nin: purchasedProductIds },
      category: { $in: purchasedCategories },
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

    // Count co-purchases
    const coProductCounts = {};

    orders.forEach((order) => {
      const hasProduct = order.items.some(
        (item) => item.product._id.toString() === productId,
      );

      if (hasProduct) {
        order.items.forEach((item) => {
          if (item.product._id.toString() !== productId) {
            const id = item.product._id.toString();
            coProductCounts[id] = (coProductCounts[id] || 0) + 1;
          }
        });
      }
    });

    // Get top co-purchased products
    const topProducts = Object.entries(coProductCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([id]) => id);

    const products = await Product.find({ _id: { $in: topProducts } }).select(
      "name price images averageRating ratingCount stock",
    );

    return products;
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
