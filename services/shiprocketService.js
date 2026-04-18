/**
 * Shiprocket Service — production-ready integration
 * Handles token management, order creation, AWB assignment,
 * shipping rate calculation, tracking, cancellation, and returns.
 */

const axios = require("axios");
const { getStateCode } = require("../utils/stateCodeMapping");

const BASE_URL = "https://apiv2.shiprocket.in/v1/external";

// ── Token cache (single-instance; swap for Redis in multi-instance deployments) ──
const _tokenStore = { token: null, expiresAt: null };

/**
 * Returns a valid Shiprocket Bearer token.
 * Refreshes automatically 30 min before the 24-hr expiry.
 */
async function getToken() {
  const BUFFER_MS = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();

  if (
    _tokenStore.token &&
    _tokenStore.expiresAt &&
    now < _tokenStore.expiresAt - BUFFER_MS
  ) {
    return _tokenStore.token;
  }

  try {
    const email = process.env.SHIPROCKET_EMAIL;
    const password = process.env.SHIPROCKET_PASSWORD;

    console.log("[Shiprocket] Attempting login...");
    console.log("[Shiprocket] Email:", email);
    console.log(
      "[Shiprocket] Password loaded:",
      password ? `✓ (${password.length} chars)` : "✗ EMPTY",
    );

    if (!email || !password) {
      throw new Error(
        `Missing credentials: email=${!!email}, password=${!!password}`,
      );
    }

    const res = await axios.post(`${BASE_URL}/auth/login`, {
      email,
      password,
    });

    if (!res.data?.token) {
      console.error("[Shiprocket] No token in response:", res.data);
      throw new Error("Shiprocket authentication failed: no token in response");
    }

    _tokenStore.token = res.data.token;
    _tokenStore.expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours

    console.log("[Shiprocket] ✓ Token refreshed successfully");
    return _tokenStore.token;
  } catch (err) {
    console.error(
      "[Shiprocket] Auth error:",
      err.response?.data || err.message,
    );
    throw err;
  }
}

/** Build auth headers for every API call */
function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Calculate shipment weight from order items.
 * Defaults to 0.5 kg per unit if the product doesn't have a weight field.
 * Minimum: 0.5 kg (Shiprocket requirement).
 */
function calcWeight(items) {
  const total = items.reduce((sum, item) => {
    const w = item.product?.weight || 0.5;
    return sum + w * item.quantity;
  }, 0);
  return Math.max(parseFloat(total.toFixed(2)), 0.5);
}

/** Format a JS Date → "YYYY-MM-DD HH:mm" required by Shiprocket */
function fmtDate(date) {
  return new Date(date).toISOString().replace("T", " ").slice(0, 16);
}

/**
 * Normalize country name for Shiprocket — strip any parenthetical/unicode suffix.
 * e.g. "India (भारत)" → "India"
 */
function sanitizeCountry(raw) {
  if (!raw) return "India";
  return raw.replace(/\s*\(.*?\)\s*/g, "").trim() || "India";
}

/** Convert "tamil nadu" → "Tamil Nadu" for Shiprocket's full-name requirement */
function toTitleCase(str) {
  if (!str) return "";
  return str.trim().replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** Strip non-digits and return last 10 digits (Indian mobile number) */
function sanitizePhone(raw) {
  const digits = (raw || "").replace(/\D/g, "");
  return digits.slice(-10) || "9999999999";
}

// ─────────────────────────────────────────────────────────────────────────────
// Order Creation + AWB Assignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Shiprocket order and auto-assigns the best courier (AWB).
 *
 * @param {Object} order  - Mongoose Order document
 * @param {Object} user   - Mongoose User document
 * @param {Number} courierId - Optional: pre-selected courier from rate query
 * @returns {{ shiprocketOrderId, shipmentId, awbCode, courierId, courierName, trackingUrl }}
 */
async function createShiprocketOrder(order, user, courierId = null) {
  const token = await getToken();
  const addr = order.shippingAddress;
  const fullName = user?.username || user?.name || "Customer";
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] || "Customer";
  const lastName  = nameParts.slice(1).join(" ") || "."; // Shiprocket requires non-empty last name

  // Validate required address fields
  if (!addr?.street || !addr?.city || !addr?.zipCode || !addr?.state) {
    console.error("[Shiprocket] Invalid shipping address:", addr);
    throw new Error(
      `Invalid shipping address: missing required fields (street: ${!!addr?.street}, city: ${!!addr?.city}, zipCode: ${!!addr?.zipCode}, state: ${!!addr?.state})`
    );
  }

  // Validate order items are properly structured
  if (!order.items || order.items.length === 0) {
    throw new Error("Order has no items");
  }

  // Validate that order items have product details
  for (let i = 0; i < order.items.length; i++) {
    const item = order.items[i];
    if (!item.product?.name || typeof item.product.price !== "number") {
      console.error(
        `[Shiprocket] Invalid product at index ${i}:`,
        JSON.stringify(item.product)
      );
      throw new Error(
        `Invalid product details at item index ${i}: name or price missing`
      );
    }
  }

  // Shiprocket's order-creation API requires the FULL state name in title case
  // (e.g. "Tamil Nadu"), NOT a 2-letter code like "TN".
  const normalizedState = toTitleCase(addr.state);

  // Use a unique order_id — append short timestamp suffix so Shiprocket
  // doesn't reject it as duplicate if the order was previously attempted.
  const srOrderId = `${order._id.toString()}-${Date.now()}`;

  const payload = {
    order_id: srOrderId,
    order_date: fmtDate(order.createdAt || new Date()),
    pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION || "Primary",

    // Billing = Shipping (most e-commerce use case)
    billing_customer_name: firstName,
    billing_last_name: lastName,
    billing_address: addr.street,
    billing_address_2: "",
    billing_city: toTitleCase(addr.city),
    billing_pincode: (addr.zipCode || "000000").trim(),
    billing_state: normalizedState,
    billing_country: sanitizeCountry(addr.country),
    billing_email: user?.email || "customer@infinitycraftspace.com",
    billing_phone: sanitizePhone(addr.phone || ""),

    shipping_is_billing: true,

    order_items: order.items.map((item, idx) => {
      const productName = item.product?.name || `Product-${idx}`;
      const productPrice = item.product?.price || 0;
      const sku = item.product?._id?.toString() || `SKU-${Date.now()}-${idx}`;
      return {
        name: productName.substring(0, 250), // Limit to 250 chars for Shiprocket
        sku: sku.substring(0, 50), // Limit SKU to 50 chars
        units: item.quantity || 1,
        selling_price: productPrice.toString(),
        discount: "0",
        tax: "0",
        hsn: "0",
      };
    }),

    payment_method: order.paymentMethod === "cod" ? "COD" : "Prepaid",
    shipping_charges: (order.shipping || 0).toString(),
    giftwrap_charges: "0",
    transaction_charges: "0",
    total_discount: (order.discount?.amount || 0).toString(),
    sub_total: (order.subtotal || 0).toString(),

    // Package dimensions (defaults — update per your actual product sizes)
    length: 15,
    breadth: 15,
    height: 10,
    weight: calcWeight(order.items),
  };

  console.log("[Shiprocket] Sending order payload:", JSON.stringify(payload, null, 2));

  // ── Step 1: Create the order ─────────────────────────────────────────────
  let orderRes;
  try {
    orderRes = await axios.post(`${BASE_URL}/orders/create/adhoc`, payload, {
      headers: headers(token),
    });
  } catch (err) {
    const srError = err.response?.data;
    console.error("[Shiprocket] ✗ Order creation HTTP error:", err.response?.status);
    console.error("[Shiprocket] ✗ Shiprocket response body:", JSON.stringify(srError, null, 2));
    // Extract human-readable message from Shiprocket's response shape
    const srMsg =
      srError?.message ||
      srError?.error ||
      (typeof srError === "string" ? srError : null) ||
      err.message;
    throw new Error(`Shiprocket order creation failed (${err.response?.status}): ${srMsg}`);
  }

  // Shiprocket returns 200 even for "wrong pickup location" — detect it
  const orderRespData = orderRes.data;
  if (orderRespData?.message?.toLowerCase().includes("wrong pickup location")) {
    const available = (orderRespData?.data?.data || [])
      .map((loc) => loc.pickup_location || loc.name || JSON.stringify(loc))
      .filter(Boolean);
    console.error(
      `[Shiprocket] ✗ Wrong pickup_location "${payload.pickup_location}". ` +
      `Set SHIPROCKET_PICKUP_LOCATION to one of: ${available.join(" | ") || "(check Shiprocket dashboard → Manage Pickups)"}`
    );
    throw new Error(
      `Wrong Shiprocket pickup location "${payload.pickup_location}". ` +
      `Valid options: ${available.join(", ") || "check Shiprocket dashboard → Settings → Manage Pickups"}`
    );
  }

  console.log("[Shiprocket] ✓ Order created:", orderRespData);

  const { order_id: returnedOrderId, shipment_id: shipmentId } = orderRespData;

  if (!shipmentId) {
    throw new Error(
      `Shiprocket order created (${srOrderId}) but no shipment_id returned. ` +
      `Response: ${JSON.stringify(orderRespData)}`
    );
  }

  // ── Step 2: Assign AWB ───────────────────────────────────────────────────
  const awbPayload = courierId
    ? { shipment_id: shipmentId.toString(), courier_id: courierId.toString() }
    : { shipment_id: shipmentId.toString() };

  console.log("[Shiprocket] Assigning AWB with payload:", awbPayload);

  let awbRes;
  try {
    awbRes = await axios.post(`${BASE_URL}/courier/assign/awb`, awbPayload, {
      headers: headers(token),
    });
  } catch (err) {
    const srError = err.response?.data;
    console.error("[Shiprocket] ✗ AWB assignment HTTP error:", err.response?.status);
    console.error("[Shiprocket] ✗ Shiprocket AWB response body:", JSON.stringify(srError, null, 2));
    const srMsg =
      srError?.message ||
      srError?.error ||
      (typeof srError === "string" ? srError : null) ||
      err.message;
    // Order was created — return partial data so it can be retried via admin
    console.warn(`[Shiprocket] Order ${srOrderId} (shipment ${shipmentId}) created but AWB failed: ${srMsg}`);
    return {
      shiprocketOrderId: srOrderId?.toString(),
      shipmentId: shipmentId?.toString(),
      awbCode: null,
      courierId: null,
      courierName: null,
      trackingUrl: null,
    };
  }

  console.log("[Shiprocket] AWB assignment response:", awbRes.data);

  const awbData = awbRes.data?.response?.data || {};
  const awbCode = awbData.awb_code;
  const assignedCourierId = awbData.courier_company_id;
  const courierName = awbData.courier_name;
  const trackingUrl = awbCode
    ? `https://www.shiprocket.in/shipment-tracking/?id=${awbCode}`
    : null;

  console.log(
    `[Shiprocket] ✓ Order ${srOrderId} | Shipment ${shipmentId} | AWB ${awbCode} | Courier: ${courierName}`
  );

  return {
    shiprocketOrderId: srOrderId?.toString(),
    shipmentId: shipmentId?.toString(),
    awbCode,
    courierId: assignedCourierId?.toString(),
    courierName,
    trackingUrl,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shipping Rates (Serviceability)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch available couriers + shipping rates for a delivery pincode.
 *
 * @param {{ deliveryPincode, weight, cod?, declaredValue? }}
 * @returns Array of courier options sorted by rate (cheapest first)
 */
async function getShippingRates({
  deliveryPincode,
  weight,
  cod = 0,
  declaredValue = 500,
}) {
  const token = await getToken();

  const res = await axios.get(`${BASE_URL}/courier/serviceability/`, {
    headers: headers(token),
    params: {
      pickup_postcode: process.env.SHIPROCKET_PICKUP_PINCODE || "560001",
      delivery_postcode: deliveryPincode,
      weight: weight.toString(),
      cod: cod.toString(),
      declared_value: declaredValue.toString(),
      is_return: "0",
    },
  });

  const couriers = res.data?.data?.available_courier_companies || [];

  return couriers
    .filter((c) => c.is_surface_available !== false)
    .sort((a, b) => a.rate - b.rate)
    .map((c) => ({
      courierId: c.courier_company_id,
      courierName: c.courier_name,
      rate: Math.round(c.rate),
      estimatedDays: c.estimated_delivery_days || null,
      etd: c.etd || null,
      isCOD: c.cod === 1,
      rating: c.rating || null,
      logo: c.courier_company_id
        ? `https://cdn.shiprocket.in/courier-logos/${c.courier_company_id}.png`
        : null,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch live tracking data. Tries AWB first; falls back to shipment ID.
 * Returns normalized tracking object regardless of Shiprocket API version.
 */
async function trackShipment(shipmentId, awbCode) {
  const token = await getToken();

  if (awbCode) {
    try {
      const res = await axios.get(`${BASE_URL}/courier/track/awb/${awbCode}`, {
        headers: headers(token),
      });
      return normalizeTracking(res.data);
    } catch (err) {
      console.warn(
        "[Shiprocket] AWB tracking failed, trying shipment ID:",
        err.message,
      );
    }
  }

  if (shipmentId) {
    const res = await axios.get(
      `${BASE_URL}/courier/track/shipment/${shipmentId}`,
      { headers: headers(token) },
    );
    return normalizeTracking(res.data);
  }

  throw new Error("shipmentId or awbCode is required for tracking");
}

/** Normalize different Shiprocket tracking response shapes */
function normalizeTracking(raw) {
  const td = raw?.tracking_data || raw?.data || raw;
  const track = td?.shipment_track?.[0] || {};
  const activities = (td?.shipment_track_activities || []).map((a) => ({
    date: a.date,
    activity: a.activity,
    location: a.location,
    statusLabel: a["sr-status-label"] || a.status || "",
    statusCode: a["sr-status"] || null,
  }));

  return {
    awbCode: track.awb_code || td?.awb_code || null,
    courierName: track.courier_name || td?.courier_name || null,
    currentStatus: track.current_status || td?.current_status || null,
    currentStatusId: track["sr-status-id"] || null,
    deliveredDate: track.delivered_date || null,
    etd: track.etd || null,
    pickupDate: track.pickup_date || null,
    origin: track.origin || null,
    destination: track.destination || null,
    activities,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cancel a Shiprocket order by its Shiprocket order ID.
 * Note: Shiprocket accepts numeric IDs in an array.
 */
async function cancelShiprocketOrder(srOrderId) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE_URL}/orders/cancel`,
    { ids: [parseInt(srOrderId, 10)] },
    { headers: headers(token) },
  );
  return res.data;
}

/**
 * Cancel a specific AWB (after shipment is created but before pickup).
 */
async function cancelAWB(awbCode) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE_URL}/orders/cancel/shipment/awbs`,
    { awbs: [awbCode] },
    { headers: headers(token) },
  );
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Returns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a return order in Shiprocket.
 * Pickup is from customer, delivery is to your store.
 */
async function createReturnOrder({ shiprocketOrderId, order, user }) {
  const token = await getToken();
  const addr = order.shippingAddress;
  const fullName = user?.username || user?.name || "Customer";

  const payload = {
    order_id: shiprocketOrderId?.toString(),
    order_date: fmtDate(new Date()),
    channel_id: "",
    pickup_customer_name: fullName,
    pickup_last_name: "",
    pickup_address: addr.street,
    pickup_address_2: "",
    pickup_city: addr.city,
    pickup_state: getStateCode(addr.state), // Convert to state code
    pickup_country: addr.country || "India",
    pickup_pincode: addr.zipCode,
    pickup_email: user?.email || "customer@example.com",
    pickup_phone: sanitizePhone(addr.phone),

    shipping_customer_name:
      process.env.SHIPROCKET_STORE_NAME || "Infinity Craft Space",
    shipping_last_name: "",
    shipping_address: process.env.SHIPROCKET_STORE_ADDRESS || "Store Address",
    shipping_address_2: "",
    shipping_city: process.env.SHIPROCKET_STORE_CITY || "Bangalore",
    shipping_country: "India",
    shipping_state: getStateCode(
      process.env.SHIPROCKET_STORE_STATE || "Karnataka",
    ),
    shipping_pincode: process.env.SHIPROCKET_STORE_PINCODE || "560001",
    shipping_email: process.env.SHIPROCKET_EMAIL,
    shipping_phone: sanitizePhone(process.env.SHIPROCKET_STORE_PHONE),

    order_items: order.items.map((item) => ({
      name: item.product.name,
      sku: item.product._id?.toString() || `SKU-${Date.now()}`,
      units: item.quantity,
      selling_price: item.product.price.toString(),
      discount: "0",
      tax: "0",
    })),

    payment_method: "Prepaid",
    sub_total: order.subtotal,
    length: 15,
    breadth: 15,
    height: 10,
    weight: calcWeight(order.items),
  };

  const res = await axios.post(`${BASE_URL}/orders/create/return`, payload, {
    headers: headers(token),
  });
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook status mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map Shiprocket status ID → internal order status
 * Reference: https://apidocs.shiprocket.in/#webhook-statuses
 */
const SR_STATUS_MAP = {
  1: "processing", // Pending
  3: "processing", // Pickup Scheduled
  4: "processing", // Picked Up
  5: "processing", // Manifested
  6: "shipped", // Shipped
  7: "delivered", // Delivered
  8: "cancelled", // Cancelled
  9: "returned", // RTO Initiated
  10: "returned", // RTO Delivered
  12: "cancelled", // Lost
  14: "out_for_delivery", // Out for Delivery
  38: "processing", // Pickup Generated
  58: "shipped", // Undelivered (attempted)
};

function mapSRStatus(statusId) {
  return SR_STATUS_MAP[statusId] || null;
}

module.exports = {
  getToken,
  createShiprocketOrder,
  getShippingRates,
  trackShipment,
  cancelShiprocketOrder,
  cancelAWB,
  createReturnOrder,
  mapSRStatus,
  calcWeight,
};
