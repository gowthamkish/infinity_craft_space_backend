const Product = require("../models/Product");
const { deleteMultipleImages } = require("../config/cloudinary");
const {
  getRecommendationsByProductId,
  getPopularProducts,
  getTrendingProducts,
  getPersonalizedRecommendations,
  getBoughtTogether,
} = require("../utils/recommendations");

const getAllProducts = async (req, res) => {
  try {
    const products = await Product.find();
    res.json({ success: true, count: products.length, products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const getProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }

    const imagesToDelete = [];
    if (product.images && product.images.length > 0) {
      imagesToDelete.push(...product.images.map((img) => img.publicId).filter(Boolean));
    }
    if (product.image?.publicId && !imagesToDelete.includes(product.image.publicId)) {
      imagesToDelete.push(product.image.publicId);
    }

    if (imagesToDelete.length > 0) {
      try {
        await deleteMultipleImages(imagesToDelete);
      } catch (imageError) {
        console.error("Failed to delete images from Cloudinary:", imageError);
      }
    }

    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Product and associated images deleted successfully" });
  } catch (err) {
    console.error("Product deletion error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

const checkStock = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Items array is required" });
    }

    const stockStatus = [];
    let allAvailable = true;

    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product) {
        stockStatus.push({ productId: item.productId, available: false, error: "Product not found" });
        allAvailable = false;
        continue;
      }

      const isAvailable = !product.trackInventory || product.stock >= item.quantity;
      const isLowStock = product.trackInventory && product.stock <= product.lowStockThreshold && product.stock > 0;
      const isOutOfStock = product.trackInventory && product.stock <= 0;

      stockStatus.push({
        productId: item.productId,
        name: product.name,
        requestedQuantity: item.quantity,
        availableStock: product.trackInventory ? product.stock : null,
        trackInventory: product.trackInventory,
        available: isAvailable,
        isLowStock,
        isOutOfStock,
        lowStockThreshold: product.lowStockThreshold,
      });

      if (!isAvailable) allAvailable = false;
    }

    res.json({ success: true, allAvailable, items: stockStatus });
  } catch (err) {
    console.error("Stock check error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

const updateStock = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Items array is required" });
    }

    const results = [];
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product) {
        results.push({ productId: item.productId, success: false, error: "Product not found" });
        continue;
      }

      if (product.trackInventory) {
        const newStock = Math.max(0, product.stock - item.quantity);
        await Product.findByIdAndUpdate(item.productId, { stock: newStock, updatedAt: new Date() });
        results.push({
          productId: item.productId,
          name: product.name,
          previousStock: product.stock,
          quantityDeducted: item.quantity,
          newStock,
          success: true,
        });
      } else {
        results.push({
          productId: item.productId,
          name: product.name,
          success: true,
          message: "Inventory tracking disabled for this product",
        });
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error("Stock update error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

const getRecommendations = async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 6, 20);
    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }
    const recommendations = await getRecommendationsByProductId(id, limit);
    res.json({ success: true, count: recommendations.length, data: recommendations });
  } catch (err) {
    console.error("Error fetching recommendations:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

const getPopular = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 6, 20);
    const minRating = parseFloat(req.query.minRating) || 3.5;
    const products = await getPopularProducts(limit, minRating);
    res.json({ success: true, count: products.length, data: products });
  } catch (err) {
    console.error("Error fetching popular products:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

const getTrending = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 6, 20);
    const days = parseInt(req.query.days) || 30;
    const products = await getTrendingProducts(limit, days);
    res.json({ success: true, count: products.length, data: products });
  } catch (err) {
    console.error("Error fetching trending products:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

const getBoughtTogetherProducts = async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 5, 15);
    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }
    const products = await getBoughtTogether(id, limit);
    res.json({ success: true, count: products.length, data: products });
  } catch (err) {
    console.error("Error fetching bought together products:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

const getPersonalized = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 6, 20);
    const products = await getPersonalizedRecommendations(userId, limit);
    res.json({ success: true, count: products.length, products });
  } catch (err) {
    console.error("Error fetching personalized recommendations:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getAllProducts,
  getProduct,
  deleteProduct,
  checkStock,
  updateStock,
  getRecommendations,
  getPopular,
  getTrending,
  getBoughtTogetherProducts,
  getPersonalized,
};
