const express = require("express");
const Order = require("../models/Order");
const router = express.Router();

router.post("/place", async (req, res) => {
  const { userId, items } = req.body;
  const order = new Order({ userId, items });
  await order.save();
  res.json({ success: true, order });
});

module.exports = router;
