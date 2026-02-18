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

module.exports = router;
