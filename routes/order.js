const express = require("express");
const router = express.Router();
const { createOrder, getUserOrders, updateOrderStatus } = require("../controllers/orderController");

router.post("/", createOrder);
router.get("/", getUserOrders);
router.put("/:orderId/status", updateOrderStatus);

module.exports = router;
