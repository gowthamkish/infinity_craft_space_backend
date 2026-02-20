const express = require("express");
// const { protect, isAdmin } = require("../middlewares/authMiddleware");
const router = express.Router();
const User = require("../models/User");
const Product = require("../models/Product");
const Order = require("../models/Order");
const Notification = require("../models/Notification");

// Protect all admin routes
// router.use(protect, isAdmin);

router.get("/dashboard", async (req, res) => {
  try {
    const userCount = await User.countDocuments();
    const productCount = await Product.countDocuments();
    const orderCount = await Order.countDocuments();

    res.json({
      userCount,
      productCount,
      orderCount,
    });
  } catch (error) {
    console.error("Dashboard counts error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch dashboard counts",
      userCount: 0,
      productCount: 0,
      orderCount: 0,
    });
  }
});

// Get all users
router.get("/users", async (req, res) => {
  try {
    const users = await User.find().select("-password");
    res.json(users);
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch users",
    });
  }
});

// Update user role (make admin/user)
router.put("/users/:id/role", async (req, res) => {
  try {
    const { id } = req.params;
    const { isAdmin } = req.body;

    // Validate input
    if (typeof isAdmin !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "isAdmin field must be a boolean",
      });
    }

    // Find and update user
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    // Update user role
    user.isAdmin = isAdmin;
    await user.save();

    // Return updated user (without password)
    const updatedUser = await User.findById(id).select("-password");

    res.json({
      success: true,
      message: `User ${isAdmin ? "promoted to admin" : "role changed to user"}`,
      user: updatedUser,
    });
  } catch (error) {
    console.error("Update user role error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update user role",
    });
  }
});

// Get admin notifications (most recent first)
router.get("/notifications", async (req, res) => {
  try {
    const notifications = await Notification.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({ success: true, notifications });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch notifications" });
  }
});

// Get unread notifications count
router.get("/notifications/unread-count", async (req, res) => {
  try {
    const count = await Notification.countDocuments({ read: false });
    res.json({ success: true, unreadCount: count });
  } catch (error) {
    console.error("Error fetching unread notification count:", error);
    res.status(500).json({ success: false, unreadCount: 0 });
  }
});

// Mark a notification as read
router.put("/notifications/:id/read", async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await Notification.findById(id);
    if (!notif)
      return res
        .status(404)
        .json({ success: false, error: "Notification not found" });
    notif.read = true;
    await notif.save();
    res.json({ success: true, notification: notif });
  } catch (error) {
    console.error("Error marking notification read:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to update notification" });
  }
});

// Get all orders (admin only)
router.get("/orders", async (req, res) => {
  try {
    const orders = await Order.find({})
      .populate("userId", "username email isAdmin")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch (error) {
    console.error("Error fetching all orders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error: error.message,
    });
  }
});

// Analytics Dashboard API
router.get("/analytics", async (req, res) => {
  try {
    const { period = "30" } = req.query; // Default to 30 days
    const daysAgo = parseInt(period);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysAgo);
    startDate.setHours(0, 0, 0, 0);

    // Basic counts
    const [totalUsers, totalProducts, totalOrders, totalRevenue] =
      await Promise.all([
        User.countDocuments(),
        Product.countDocuments(),
        Order.countDocuments(),
        Order.aggregate([
          {
            $match: {
              status: {
                $in: ["confirmed", "processing", "shipped", "delivered"],
              },
            },
          },
          { $group: { _id: null, total: { $sum: "$totalAmount" } } },
        ]),
      ]);

    // Orders in period
    const ordersInPeriod = await Order.find({
      createdAt: { $gte: startDate },
    }).sort({ createdAt: 1 });

    // Revenue in period
    const revenueInPeriod = ordersInPeriod
      .filter((o) =>
        ["confirmed", "processing", "shipped", "delivered"].includes(o.status),
      )
      .reduce((sum, o) => sum + (o.totalAmount || 0), 0);

    // Daily revenue for chart (last N days)
    const dailyRevenue = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
          status: { $in: ["confirmed", "processing", "shipped", "delivered"] },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" },
          },
          revenue: { $sum: "$totalAmount" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]);

    // Format daily data for charts
    const dailyData = dailyRevenue.map((item) => ({
      date: `${item._id.year}-${String(item._id.month).padStart(2, "0")}-${String(item._id.day).padStart(2, "0")}`,
      revenue: item.revenue,
      orders: item.orders,
    }));

    // Order status distribution
    const orderStatusDistribution = await Order.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    // Top selling products
    const topProducts = await Order.aggregate([
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.product.name",
          totalQuantity: { $sum: "$items.quantity" },
          totalRevenue: { $sum: "$items.totalPrice" },
          category: { $first: "$items.product.category" },
        },
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 10 },
    ]);

    // Revenue by category
    const revenueByCategory = await Order.aggregate([
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.product.category",
          revenue: { $sum: "$items.totalPrice" },
          quantity: { $sum: "$items.quantity" },
        },
      },
      { $sort: { revenue: -1 } },
    ]);

    // Recent orders (last 10)
    const recentOrders = await Order.find()
      .populate("userId", "username email")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    // New users in period
    const newUsersInPeriod = await User.countDocuments({
      createdAt: { $gte: startDate },
    });

    // Average order value
    const avgOrderValue =
      ordersInPeriod.length > 0
        ? revenueInPeriod /
          ordersInPeriod.filter((o) =>
            ["confirmed", "processing", "shipped", "delivered"].includes(
              o.status,
            ),
          ).length
        : 0;

    // Orders by day of week
    const ordersByDayOfWeek = await Order.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: { $dayOfWeek: "$createdAt" },
          count: { $sum: 1 },
          revenue: { $sum: "$totalAmount" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weeklyData = ordersByDayOfWeek.map((item) => ({
      day: dayNames[item._id - 1],
      orders: item.count,
      revenue: item.revenue,
    }));

    // Monthly comparison (current vs previous)
    const currentMonthStart = new Date();
    currentMonthStart.setDate(1);
    currentMonthStart.setHours(0, 0, 0, 0);

    const previousMonthStart = new Date(currentMonthStart);
    previousMonthStart.setMonth(previousMonthStart.getMonth() - 1);

    const [currentMonthRevenue, previousMonthRevenue] = await Promise.all([
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: currentMonthStart },
            status: {
              $in: ["confirmed", "processing", "shipped", "delivered"],
            },
          },
        },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: previousMonthStart, $lt: currentMonthStart },
            status: {
              $in: ["confirmed", "processing", "shipped", "delivered"],
            },
          },
        },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
    ]);

    const currentRevenue = currentMonthRevenue[0]?.total || 0;
    const prevRevenue = previousMonthRevenue[0]?.total || 0;
    const revenueGrowth =
      prevRevenue > 0
        ? (((currentRevenue - prevRevenue) / prevRevenue) * 100).toFixed(1)
        : 0;

    res.json({
      success: true,
      period: daysAgo,
      summary: {
        totalUsers,
        totalProducts,
        totalOrders,
        totalRevenue: totalRevenue[0]?.total || 0,
        newUsersInPeriod,
        ordersInPeriod: ordersInPeriod.length,
        revenueInPeriod,
        avgOrderValue: Math.round(avgOrderValue),
        revenueGrowth: parseFloat(revenueGrowth),
      },
      charts: {
        dailyData,
        weeklyData,
        orderStatusDistribution: orderStatusDistribution.map((item) => ({
          status: item._id || "unknown",
          count: item.count,
        })),
        revenueByCategory: revenueByCategory.map((item) => ({
          category: item._id || "Uncategorized",
          revenue: item.revenue,
          quantity: item.quantity,
        })),
        topProducts: topProducts.map((item) => ({
          name: item._id || "Unknown Product",
          quantity: item.totalQuantity,
          revenue: item.totalRevenue,
          category: item.category,
        })),
      },
      recentOrders: recentOrders.map((order) => ({
        _id: order._id,
        orderId: order.razorpayOrderId || order._id,
        customer: order.userId?.username || order.userId?.email || "Guest",
        total: order.totalAmount,
        status: order.status,
        date: order.createdAt,
        itemCount: order.items?.length || 0,
      })),
    });
  } catch (error) {
    console.error("Analytics API error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch analytics data",
      message: error.message,
    });
  }
});

// Product Prediction API - Predicts which products will be ordered this month
router.get("/predictions", async (req, res) => {
  try {
    // Get last month's date range
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      0,
      23,
      59,
      59,
    );

    // Get two months ago for trend comparison
    const twoMonthsAgoStart = new Date(
      now.getFullYear(),
      now.getMonth() - 2,
      1,
    );
    const twoMonthsAgoEnd = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      0,
      23,
      59,
      59,
    );

    // Days elapsed in current month
    const daysInCurrentMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
    ).getDate();
    const daysElapsed = now.getDate();
    const projectionFactor = daysInCurrentMonth / daysElapsed;

    // Get last month's product orders
    const lastMonthOrders = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd },
          status: { $in: ["confirmed", "processing", "shipped", "delivered"] },
        },
      },
      { $unwind: "$items" },
      {
        $group: {
          _id: {
            productId: "$items.product._id",
            productName: "$items.product.name",
            category: "$items.product.category",
          },
          lastMonthQuantity: { $sum: "$items.quantity" },
          lastMonthRevenue: { $sum: "$items.totalPrice" },
          orderCount: { $sum: 1 },
        },
      },
    ]);

    // Get two months ago product orders for trend analysis
    const twoMonthsAgoOrders = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: twoMonthsAgoStart, $lte: twoMonthsAgoEnd },
          status: { $in: ["confirmed", "processing", "shipped", "delivered"] },
        },
      },
      { $unwind: "$items" },
      {
        $group: {
          _id: {
            productId: "$items.product._id",
            productName: "$items.product.name",
          },
          quantity: { $sum: "$items.quantity" },
        },
      },
    ]);

    // Get current month's actual orders so far
    const currentMonthOrders = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: currentMonthStart },
          status: { $in: ["confirmed", "processing", "shipped", "delivered"] },
        },
      },
      { $unwind: "$items" },
      {
        $group: {
          _id: {
            productId: "$items.product._id",
            productName: "$items.product.name",
          },
          currentQuantity: { $sum: "$items.quantity" },
          currentRevenue: { $sum: "$items.totalPrice" },
        },
      },
    ]);

    // Create lookup maps
    const twoMonthsAgoMap = new Map();
    twoMonthsAgoOrders.forEach((item) => {
      twoMonthsAgoMap.set(item._id.productName, item.quantity);
    });

    const currentMonthMap = new Map();
    currentMonthOrders.forEach((item) => {
      currentMonthMap.set(item._id.productName, {
        quantity: item.currentQuantity,
        revenue: item.currentRevenue,
      });
    });

    // Calculate predictions with trend analysis
    const predictions = lastMonthOrders.map((item) => {
      const productName = item._id.productName;
      const lastMonthQty = item.lastMonthQuantity;
      const twoMonthsAgoQty = twoMonthsAgoMap.get(productName) || 0;
      const currentMonthData = currentMonthMap.get(productName) || {
        quantity: 0,
        revenue: 0,
      };

      // Calculate growth trend (comparing last month to two months ago)
      let trendPercentage = 0;
      if (twoMonthsAgoQty > 0) {
        trendPercentage =
          ((lastMonthQty - twoMonthsAgoQty) / twoMonthsAgoQty) * 100;
      } else if (lastMonthQty > 0) {
        trendPercentage = 100; // New product, 100% growth
      }

      // Apply trend to prediction - using weighted moving average
      // Weight: 60% last month, 40% trend-adjusted
      const trendMultiplier = 1 + trendPercentage / 100;
      const basePrediction = lastMonthQty;
      const trendAdjustedPrediction =
        lastMonthQty * Math.max(0.5, Math.min(2, trendMultiplier));

      // Final prediction: weighted average
      const predictedQuantity = Math.round(
        basePrediction * 0.6 + trendAdjustedPrediction * 0.4,
      );

      // Project current month to full month based on days elapsed
      const projectedCurrentMonth = Math.round(
        currentMonthData.quantity * projectionFactor,
      );

      // Calculate confidence based on data availability and consistency
      let confidence = "Medium";
      if (twoMonthsAgoQty > 0 && lastMonthQty > 0) {
        const variance = Math.abs(trendPercentage);
        if (variance < 20) confidence = "High";
        else if (variance > 50) confidence = "Low";
      } else if (twoMonthsAgoQty === 0) {
        confidence = "Low";
      }

      return {
        productId: item._id.productId,
        productName: productName || "Unknown Product",
        category: item._id.category || "Uncategorized",
        lastMonthQuantity: lastMonthQty,
        lastMonthRevenue: item.lastMonthRevenue,
        twoMonthsAgoQuantity: twoMonthsAgoQty,
        currentMonthQuantity: currentMonthData.quantity,
        projectedCurrentMonth: projectedCurrentMonth,
        predictedQuantity: predictedQuantity,
        trendPercentage: Math.round(trendPercentage * 10) / 10,
        confidence: confidence,
        orderFrequency: item.orderCount,
      };
    });

    // Sort by predicted quantity descending
    predictions.sort((a, b) => b.predictedQuantity - a.predictedQuantity);

    // Get top 10 predictions
    const topPredictions = predictions.slice(0, 10);

    // Category-wise prediction summary
    const categoryPredictions = predictions.reduce((acc, item) => {
      const cat = item.category;
      if (!acc[cat]) {
        acc[cat] = {
          category: cat,
          predictedQuantity: 0,
          lastMonthQuantity: 0,
          productCount: 0,
        };
      }
      acc[cat].predictedQuantity += item.predictedQuantity;
      acc[cat].lastMonthQuantity += item.lastMonthQuantity;
      acc[cat].productCount += 1;
      return acc;
    }, {});

    const categoryPredictionList = Object.values(categoryPredictions).sort(
      (a, b) => b.predictedQuantity - a.predictedQuantity,
    );

    // Calculate overall prediction accuracy indicator
    const totalLastMonth = predictions.reduce(
      (sum, p) => sum + p.lastMonthQuantity,
      0,
    );
    const totalPredicted = predictions.reduce(
      (sum, p) => sum + p.predictedQuantity,
      0,
    );
    const totalCurrentActual = predictions.reduce(
      (sum, p) => sum + p.currentMonthQuantity,
      0,
    );
    const totalProjected = predictions.reduce(
      (sum, p) => sum + p.projectedCurrentMonth,
      0,
    );

    res.json({
      success: true,
      metadata: {
        lastMonthRange: {
          start: lastMonthStart.toISOString(),
          end: lastMonthEnd.toISOString(),
        },
        currentMonthProgress: {
          daysElapsed,
          totalDays: daysInCurrentMonth,
          percentComplete: Math.round((daysElapsed / daysInCurrentMonth) * 100),
        },
        summary: {
          totalProductsAnalyzed: predictions.length,
          totalLastMonthOrders: totalLastMonth,
          totalPredictedThisMonth: totalPredicted,
          currentMonthActualSoFar: totalCurrentActual,
          projectedCurrentMonth: totalProjected,
        },
      },
      predictions: topPredictions,
      allPredictions: predictions,
      categoryPredictions: categoryPredictionList,
    });
  } catch (error) {
    console.error("Predictions API error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to generate predictions",
      message: error.message,
    });
  }
});

module.exports = router;
