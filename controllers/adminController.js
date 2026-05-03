const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Product = require("../models/Product");
const Order = require("../models/Order");
const Notification = require("../models/Notification");
const { cache } = require("../utils/cache");

const getDashboard = async (req, res) => {
  try {
    const cached = await cache.get("dashboard:counts");
    if (cached) return res.json(cached);

    const [userCount, productCount, orderCount] = await Promise.all([
      User.countDocuments(),
      Product.countDocuments(),
      Order.countDocuments(),
    ]);

    const result = { userCount, productCount, orderCount };
    await cache.set("dashboard:counts", result, 120); // 2 min cache
    res.json(result);
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
};

const getUsers = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const search = req.query.search?.trim() || "";

    const query = search
      ? {
          $or: [
            { username: { $regex: search, $options: "i" } },
            { email:    { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      User.find(query)
        .select("-password -securityQuestions -verificationToken -resetToken -otpHash -otpSalt")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(query),
    ]);

    res.json({
      success: true,
      users,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch users" });
  }
};

const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { isAdmin } = req.body;

    if (typeof isAdmin !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "isAdmin field must be a boolean",
      });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    user.isAdmin = isAdmin;
    await user.save();

    const updatedUser = await User.findById(id).select("-password");
    res.json({
      success: true,
      message: `User ${isAdmin ? "promoted to admin" : "role changed to user"}`,
      user: updatedUser,
    });
  } catch (error) {
    console.error("Update user role error:", error);
    res.status(500).json({ success: false, error: "Failed to update user role" });
  }
};

const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { email, password } = req.body;

    if (!email && !password) {
      return res.status(400).json({ success: false, error: "Provide email or password to update" });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    if (email) {
      const exists = await User.findOne({ email, _id: { $ne: id } });
      if (exists) return res.status(400).json({ success: false, error: "Email already in use by another account" });
      user.email = email;
    }
    if (password) {
      if (password.length < 6) return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
      user.password = await bcrypt.hash(password, 12);
    }

    await user.save();
    const updated = await User.findById(id).select("-password");
    res.json({ success: true, message: "User updated successfully", user: updated });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ success: false, error: "Failed to update user" });
  }
};

const getNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ success: true, notifications });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ success: false, error: "Failed to fetch notifications" });
  }
};

const getUnreadNotificationCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({ read: false });
    res.json({ success: true, unreadCount: count });
  } catch (error) {
    console.error("Error fetching unread notification count:", error);
    res.status(500).json({ success: false, unreadCount: 0 });
  }
};

const markNotificationRead = async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await Notification.findById(id);
    if (!notif) {
      return res.status(404).json({ success: false, error: "Notification not found" });
    }
    notif.read = true;
    await notif.save();
    res.json({ success: true, notification: notif });
  } catch (error) {
    console.error("Error marking notification read:", error);
    res.status(500).json({ success: false, error: "Failed to update notification" });
  }
};

const getAllOrders = async (req, res) => {
  try {
    // Short TTL so admin sees near-real-time data
    const cached = await cache.get("admin:all_orders");
    if (cached) return res.json(cached);

    const orders = await Order.find({})
      .populate("userId", "username email isAdmin")
      .sort({ createdAt: -1 })
      .lean();

    const result = { success: true, count: orders.length, orders };
    await cache.set("admin:all_orders", result, 30); // 30s cache
    res.json(result);
  } catch (error) {
    console.error("Error fetching all orders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error: error.message,
    });
  }
};

// ── Analytics: fast summary (4 count queries, ~50–100ms) ─────────────────────
// Returns aggregate KPIs for the dashboard header cards.
// Cached 2 minutes — short enough to feel live, long enough to not hammer Atlas.
const getAnalyticsSummary = async (req, res) => {
  try {
    const { period = "30" } = req.query;
    const daysAgo = parseInt(period);
    const cacheKey = `admin:analytics:summary:${daysAgo}`;

    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysAgo);
    startDate.setHours(0, 0, 0, 0);

    const currentMonthStart = new Date();
    currentMonthStart.setDate(1);
    currentMonthStart.setHours(0, 0, 0, 0);
    const previousMonthStart = new Date(currentMonthStart);
    previousMonthStart.setMonth(previousMonthStart.getMonth() - 1);

    const PAID_STATUSES = ["confirmed", "processing", "shipped", "delivered"];

    const [
      totalUsers,
      totalProducts,
      totalOrders,
      totalRevenueAgg,
      newUsersInPeriod,
      periodRevenueAgg,
      periodOrderCount,
      currentMonthRevenueAgg,
      previousMonthRevenueAgg,
      recentOrders,
    ] = await Promise.all([
      User.countDocuments(),
      Product.countDocuments(),
      Order.countDocuments(),
      Order.aggregate([
        { $match: { status: { $in: PAID_STATUSES } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]),
      User.countDocuments({ createdAt: { $gte: startDate } }),
      Order.aggregate([
        { $match: { createdAt: { $gte: startDate }, status: { $in: PAID_STATUSES } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]),
      Order.countDocuments({ createdAt: { $gte: startDate } }),
      Order.aggregate([
        { $match: { createdAt: { $gte: currentMonthStart }, status: { $in: PAID_STATUSES } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: previousMonthStart, $lt: currentMonthStart }, status: { $in: PAID_STATUSES } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
      Order.find()
        .populate("userId", "username email")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    const revenueInPeriod  = periodRevenueAgg[0]?.total || 0;
    const paidInPeriod     = periodRevenueAgg[0]?.count || 0;
    const currentRevenue   = currentMonthRevenueAgg[0]?.total || 0;
    const prevRevenue      = previousMonthRevenueAgg[0]?.total || 0;
    const revenueGrowth    = prevRevenue > 0
      ? parseFloat((((currentRevenue - prevRevenue) / prevRevenue) * 100).toFixed(1))
      : 0;

    const result = {
      success: true,
      period: daysAgo,
      summary: {
        totalUsers,
        totalProducts,
        totalOrders,
        totalRevenue: totalRevenueAgg[0]?.total || 0,
        newUsersInPeriod,
        ordersInPeriod: periodOrderCount,
        revenueInPeriod,
        avgOrderValue: paidInPeriod > 0 ? Math.round(revenueInPeriod / paidInPeriod) : 0,
        revenueGrowth,
        currentMonthRevenue: currentRevenue,
        previousMonthRevenue: prevRevenue,
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
    };

    await cache.set(cacheKey, result, 120); // 2 min
    res.json(result);
  } catch (error) {
    console.error("Analytics summary error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch analytics summary" });
  }
};

// ── Analytics: heavy chart data (8 aggregation pipelines, ~1–5s cold) ────────
// Separated from the summary so the dashboard header cards load instantly
// while charts load progressively. Cached 5 minutes — charts don't need
// to be real-time; recent orders in the summary are sufficient for urgency.
const getAnalyticsCharts = async (req, res) => {
  try {
    const { period = "30" } = req.query;
    const daysAgo = parseInt(period);
    const cacheKey = `admin:analytics:charts:${daysAgo}`;

    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysAgo);
    startDate.setHours(0, 0, 0, 0);

    const PAID_STATUSES = ["confirmed", "processing", "shipped", "delivered"];

    const [
      dailyRevenue,
      ordersByDayOfWeek,
      orderStatusDistribution,
      topProducts,
      revenueByCategory,
    ] = await Promise.all([
      Order.aggregate([
        { $match: { createdAt: { $gte: startDate }, status: { $in: PAID_STATUSES } } },
        {
          $group: {
            _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" }, day: { $dayOfMonth: "$createdAt" } },
            revenue: { $sum: "$totalAmount" },
            orders:  { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        { $group: { _id: { $dayOfWeek: "$createdAt" }, count: { $sum: 1 }, revenue: { $sum: "$totalAmount" } } },
        { $sort: { _id: 1 } },
      ]),
      Order.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.product.name",
            totalQuantity: { $sum: "$items.quantity" },
            totalRevenue:  { $sum: "$items.totalPrice" },
            category:      { $first: "$items.product.category" },
          },
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 10 },
      ]),
      Order.aggregate([
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.product.category",
            revenue:  { $sum: "$items.totalPrice" },
            quantity: { $sum: "$items.quantity" },
          },
        },
        { $sort: { revenue: -1 } },
      ]),
    ]);

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    const result = {
      success: true,
      period: daysAgo,
      charts: {
        dailyData: dailyRevenue.map((item) => ({
          date: `${item._id.year}-${String(item._id.month).padStart(2, "0")}-${String(item._id.day).padStart(2, "0")}`,
          revenue: item.revenue,
          orders:  item.orders,
        })),
        weeklyData: ordersByDayOfWeek.map((item) => ({
          day:     dayNames[item._id - 1],
          orders:  item.count,
          revenue: item.revenue,
        })),
        orderStatusDistribution: orderStatusDistribution.map((item) => ({
          status: item._id || "unknown",
          count:  item.count,
        })),
        revenueByCategory: revenueByCategory.map((item) => ({
          category: item._id || "Uncategorized",
          revenue:  item.revenue,
          quantity: item.quantity,
        })),
        topProducts: topProducts.map((item) => ({
          name:     item._id || "Unknown Product",
          quantity: item.totalQuantity,
          revenue:  item.totalRevenue,
          category: item.category,
        })),
      },
    };

    await cache.set(cacheKey, result, 300); // 5 min
    res.json(result);
  } catch (error) {
    console.error("Analytics charts error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch analytics charts" });
  }
};

// Keep the original combined endpoint for backwards compatibility — it now just
// calls summary sequentially (charts are fetched separately by the frontend).
const getAnalytics = async (req, res) => getAnalyticsSummary(req, res);

const getPredictions = async (req, res) => {
  try {
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const twoMonthsAgoStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const twoMonthsAgoEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0, 23, 59, 59);

    const daysInCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();
    const projectionFactor = daysInCurrentMonth / daysElapsed;

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
          _id: { productId: "$items.product._id", productName: "$items.product.name", category: "$items.product.category" },
          lastMonthQuantity: { $sum: "$items.quantity" },
          lastMonthRevenue: { $sum: "$items.totalPrice" },
          orderCount: { $sum: 1 },
        },
      },
    ]);

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
          _id: { productId: "$items.product._id", productName: "$items.product.name" },
          quantity: { $sum: "$items.quantity" },
        },
      },
    ]);

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
          _id: { productId: "$items.product._id", productName: "$items.product.name" },
          currentQuantity: { $sum: "$items.quantity" },
          currentRevenue: { $sum: "$items.totalPrice" },
        },
      },
    ]);

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

    const predictions = lastMonthOrders.map((item) => {
      const productName = item._id.productName;
      const lastMonthQty = item.lastMonthQuantity;
      const twoMonthsAgoQty = twoMonthsAgoMap.get(productName) || 0;
      const currentMonthData = currentMonthMap.get(productName) || { quantity: 0, revenue: 0 };

      let trendPercentage = 0;
      if (twoMonthsAgoQty > 0) {
        trendPercentage = ((lastMonthQty - twoMonthsAgoQty) / twoMonthsAgoQty) * 100;
      } else if (lastMonthQty > 0) {
        trendPercentage = 100;
      }

      const trendMultiplier = 1 + trendPercentage / 100;
      const trendAdjustedPrediction = lastMonthQty * Math.max(0.5, Math.min(2, trendMultiplier));
      const predictedQuantity = Math.round(lastMonthQty * 0.6 + trendAdjustedPrediction * 0.4);
      const projectedCurrentMonth = Math.round(currentMonthData.quantity * projectionFactor);

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
        projectedCurrentMonth,
        predictedQuantity,
        trendPercentage: Math.round(trendPercentage * 10) / 10,
        confidence,
        orderFrequency: item.orderCount,
      };
    });

    predictions.sort((a, b) => b.predictedQuantity - a.predictedQuantity);

    const categoryPredictions = predictions.reduce((acc, item) => {
      const cat = item.category;
      if (!acc[cat]) {
        acc[cat] = { category: cat, predictedQuantity: 0, lastMonthQuantity: 0, productCount: 0 };
      }
      acc[cat].predictedQuantity += item.predictedQuantity;
      acc[cat].lastMonthQuantity += item.lastMonthQuantity;
      acc[cat].productCount += 1;
      return acc;
    }, {});

    res.json({
      success: true,
      metadata: {
        lastMonthRange: { start: lastMonthStart.toISOString(), end: lastMonthEnd.toISOString() },
        currentMonthProgress: {
          daysElapsed,
          totalDays: daysInCurrentMonth,
          percentComplete: Math.round((daysElapsed / daysInCurrentMonth) * 100),
        },
        summary: {
          totalProductsAnalyzed: predictions.length,
          totalLastMonthOrders: predictions.reduce((sum, p) => sum + p.lastMonthQuantity, 0),
          totalPredictedThisMonth: predictions.reduce((sum, p) => sum + p.predictedQuantity, 0),
          currentMonthActualSoFar: predictions.reduce((sum, p) => sum + p.currentMonthQuantity, 0),
          projectedCurrentMonth: predictions.reduce((sum, p) => sum + p.projectedCurrentMonth, 0),
        },
      },
      predictions: predictions.slice(0, 10),
      allPredictions: predictions,
      categoryPredictions: Object.values(categoryPredictions).sort((a, b) => b.predictedQuantity - a.predictedQuantity),
    });
  } catch (error) {
    console.error("Predictions API error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to generate predictions",
      message: error.message,
    });
  }
};

module.exports = {
  getDashboard,
  getUsers,
  updateUserRole,
  updateUser,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  getAllOrders,
  getAnalytics,
  getAnalyticsSummary,
  getAnalyticsCharts,
  getPredictions,
};
