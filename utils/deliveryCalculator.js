/**
 * Delivery estimation engine.
 *
 * Responsibilities:
 *  - Validate Indian pincodes
 *  - Resolve pincode → state → zone (with in-memory cache)
 *  - Look up zone-to-zone shipping days via ZONE_MATRIX
 *  - Add product processing days for customisable items
 *  - Calculate business-day dates (skip Sundays + public holidays)
 *  - Format dates as "Apr 25 – Apr 28"
 */

const {
  PINCODE_RANGES,
  STATE_TO_ZONE,
  ZONE_MATRIX,
  PUBLIC_HOLIDAYS,
  WAREHOUSE_PINCODE,
} = require("../data/indiaZones");

// ── In-memory pincode cache (TTL: 1 hour) ────────────────────────────────────
const _cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function _getFromCache(pin) {
  const entry = _cache.get(pin);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(pin);
    return null;
  }
  return entry.data;
}

function _setCache(pin, data) {
  _cache.set(pin, { data, ts: Date.now() });
}

// ── Pincode helpers ───────────────────────────────────────────────────────────

/** Returns true for a valid 6-digit Indian PIN */
function isValidPincode(pin) {
  return /^[1-9][0-9]{5}$/.test(String(pin).trim());
}

/**
 * Resolves a pincode to { state, zone }.
 * Returns null if the pincode doesn't map to a known state.
 * Results are cached for 1 hour.
 */
function resolveZone(pincode) {
  const pin = String(pincode).trim();

  const cached = _getFromCache(pin);
  if (cached) return cached;

  const prefix = parseInt(pin.slice(0, 3), 10);

  // Walk ranges; first match wins (ranges are ordered so specific ones come first)
  for (const [lo, hi, stateCode] of PINCODE_RANGES) {
    if (prefix >= lo && prefix <= hi) {
      const zone = STATE_TO_ZONE[stateCode];
      if (!zone) break;
      const result = { state: stateCode, zone };
      _setCache(pin, result);
      return result;
    }
  }

  return null; // not serviceable
}

// ── Zone-to-zone shipping days ────────────────────────────────────────────────

/**
 * Returns { min, max } shipping days between two zones.
 * Tries both key orderings so the matrix doesn't need to be duplicated.
 */
function shippingDaysForZones(fromZone, toZone) {
  const key1 = `${fromZone}-${toZone}`;
  const key2 = `${toZone}-${fromZone}`;
  return ZONE_MATRIX[key1] || ZONE_MATRIX[key2] || { min: 5, max: 8 };
}

// ── Business day calculator ───────────────────────────────────────────────────

const _holidaySet = new Set(PUBLIC_HOLIDAYS);

/** Checks if a given Date is a non-working day (Sunday or public holiday). */
function _isNonWorkingDay(date) {
  if (date.getDay() === 0) return true; // Sunday
  const iso = date.toISOString().slice(0, 10);
  return _holidaySet.has(iso);
}

/**
 * Adds `days` business days to `startDate`.
 * Returns a new Date (does not mutate the argument).
 */
function addBusinessDays(startDate, days) {
  const result = new Date(startDate);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (!_isNonWorkingDay(result)) added++;
  }
  return result;
}

// ── Date formatting ───────────────────────────────────────────────────────────

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Formats a Date as "Apr 25" */
function _fmtDate(date) {
  return `${MONTH_ABBR[date.getMonth()]} ${date.getDate()}`;
}

/** Formats a Date as "2026-04-25" (ISO) */
function _isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// ── Main estimator ────────────────────────────────────────────────────────────

/**
 * Calculates the full delivery estimate.
 *
 * @param {string} customerPincode  - 6-digit destination pincode
 * @param {object} product          - Mongoose product document (or plain object)
 * @returns {object} estimate result
 *
 * Result shape:
 * {
 *   success: true,
 *   minDays, maxDays,             // shipping only
 *   processingDaysMin, processingDaysMax,  // 0 for normal products
 *   totalMinDays, totalMaxDays,   // processing + shipping
 *   isCustom: Boolean,
 *   estimatedMinDate: "YYYY-MM-DD",
 *   estimatedMaxDate: "YYYY-MM-DD",
 *   displayRange: "Apr 25 – Apr 28",
 *   customerState, customerZone,
 *   warehouseState, warehouseZone,
 * }
 *
 * On error:
 * { success: false, code: "INVALID_PINCODE"|"NOT_SERVICEABLE", message }
 */
function estimateDelivery(customerPincode, product) {
  // 1. Validate pincode
  if (!isValidPincode(customerPincode)) {
    return {
      success: false,
      code: "INVALID_PINCODE",
      message: "Please enter a valid 6-digit PIN code.",
    };
  }

  // 2. Resolve warehouse zone
  const warehouseInfo = resolveZone(WAREHOUSE_PINCODE);
  if (!warehouseInfo) {
    // Should never happen for a hardcoded Bangalore pincode
    return {
      success: false,
      code: "NOT_SERVICEABLE",
      message: "Warehouse location could not be resolved.",
    };
  }

  // 3. Resolve customer zone
  const customerInfo = resolveZone(customerPincode);
  if (!customerInfo) {
    return {
      success: false,
      code: "NOT_SERVICEABLE",
      message: "We do not currently deliver to this PIN code.",
    };
  }

  // 4. Same pincode → 1–2 days shipping
  const samePincode =
    String(customerPincode).trim() === String(WAREHOUSE_PINCODE).trim();
  let shipping;
  if (samePincode) {
    shipping = { min: 1, max: 2 };
  } else if (customerInfo.state === warehouseInfo.state) {
    // Same state → 2–4 days
    shipping = { min: 2, max: 4 };
  } else {
    shipping = shippingDaysForZones(warehouseInfo.zone, customerInfo.zone);
  }

  // 5. Processing days for customisable products
  const isCustom = Boolean(product.isCustomizable);
  const processingDaysMin = isCustom ? (product.processingDaysMin ?? 10) : 0;
  const processingDaysMax = isCustom ? (product.processingDaysMax ?? 12) : 0;

  // 6. Total days
  const totalMinDays = processingDaysMin + shipping.min;
  const totalMaxDays = processingDaysMax + shipping.max;

  // 7. Calculate actual dates (from today, business days only)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const minDate = addBusinessDays(today, totalMinDays);
  const maxDate = addBusinessDays(today, totalMaxDays);

  // 8. Format display range
  const minFormatted = _fmtDate(minDate);
  const maxFormatted = _fmtDate(maxDate);
  const displayRange =
    minFormatted === maxFormatted
      ? minFormatted
      : `${minFormatted} – ${maxFormatted}`;

  return {
    success: true,
    minDays: shipping.min,
    maxDays: shipping.max,
    processingDaysMin,
    processingDaysMax,
    totalMinDays,
    totalMaxDays,
    isCustom,
    estimatedMinDate: _isoDate(minDate),
    estimatedMaxDate: _isoDate(maxDate),
    displayRange,
    customerState: customerInfo.state,
    customerZone: customerInfo.zone,
    warehouseState: warehouseInfo.state,
    warehouseZone: warehouseInfo.zone,
  };
}

module.exports = { estimateDelivery, isValidPincode, resolveZone, addBusinessDays };
