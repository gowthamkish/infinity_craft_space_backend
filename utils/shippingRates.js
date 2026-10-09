/**
 * Server-side shipping charge calculation.
 *
 * Mirrors the rate card shown in the checkout UI
 * (frontend/src/pages/checkout/ShippingStep.js). The server is the source of
 * truth for what is actually charged — the client's number is display-only.
 * If you change a rate here, change it in the frontend too (and vice versa).
 */

const ROAD_ZONES = {
  LOCAL: {
    rates: [
      { maxG: 250, price: 50 },  { maxG: 500, price: 70 },
      { maxG: 750, price: 90 },  { maxG: 1000, price: 110 },
      { maxG: 2000, price: 175 }, { maxG: 3000, price: 240 },
      { maxG: 4000, price: 305 }, { maxG: 5000, price: 370 },
      { maxG: 6000, price: 425 }, { maxG: 7000, price: 480 },
      { maxG: 8000, price: 535 }, { maxG: 9000, price: 590 },
      { maxG: 10000, price: 645 },
    ],
    perKgAbove10: 55, perKgAbove50: 45,
  },
  STATE: {
    rates: [
      { maxG: 250, price: 65 },  { maxG: 500, price: 88 },
      { maxG: 750, price: 110 }, { maxG: 1000, price: 133 },
      { maxG: 2000, price: 210 }, { maxG: 3000, price: 290 },
      { maxG: 4000, price: 370 }, { maxG: 5000, price: 450 },
      { maxG: 6000, price: 520 }, { maxG: 7000, price: 595 },
      { maxG: 8000, price: 670 }, { maxG: 9000, price: 745 },
      { maxG: 10000, price: 820 },
    ],
    perKgAbove10: 70, perKgAbove50: 58,
  },
  SOUTH: {
    rates: [
      { maxG: 250, price: 85 },  { maxG: 500, price: 110 },
      { maxG: 750, price: 135 }, { maxG: 1000, price: 160 },
      { maxG: 2000, price: 255 }, { maxG: 3000, price: 355 },
      { maxG: 4000, price: 455 }, { maxG: 5000, price: 555 },
      { maxG: 6000, price: 640 }, { maxG: 7000, price: 730 },
      { maxG: 8000, price: 820 }, { maxG: 9000, price: 910 },
      { maxG: 10000, price: 1000 },
    ],
    perKgAbove10: 88, perKgAbove50: 72,
  },
  PAN_INDIA: {
    rates: [
      { maxG: 250, price: 120 },  { maxG: 500, price: 155 },
      { maxG: 750, price: 190 },  { maxG: 1000, price: 225 },
      { maxG: 2000, price: 360 }, { maxG: 3000, price: 500 },
      { maxG: 4000, price: 640 }, { maxG: 5000, price: 780 },
      { maxG: 6000, price: 895 }, { maxG: 7000, price: 1020 },
      { maxG: 8000, price: 1145 }, { maxG: 9000, price: 1270 },
      { maxG: 10000, price: 1395 },
    ],
    perKgAbove10: 130, perKgAbove50: 108,
  },
  REMOTE: {
    rates: [
      { maxG: 250, price: 145 },  { maxG: 500, price: 188 },
      { maxG: 750, price: 232 },  { maxG: 1000, price: 275 },
      { maxG: 2000, price: 440 }, { maxG: 3000, price: 610 },
      { maxG: 4000, price: 785 }, { maxG: 5000, price: 960 },
      { maxG: 6000, price: 1105 }, { maxG: 7000, price: 1265 },
      { maxG: 8000, price: 1425 }, { maxG: 9000, price: 1590 },
      { maxG: 10000, price: 1750 },
    ],
    perKgAbove10: 165, perKgAbove50: 138,
  },
};

const REMOTE_STATES = [
  "manipur", "meghalaya", "mizoram", "nagaland", "sikkim", "tripura",
  "assam", "arunachal", "andaman", "jammu", "kashmir", "ladakh", "himachal",
];
const SOUTH_STATES = ["andhra", "telangana", "kerala", "tamil"];

function getZoneKey(state, city) {
  const s = String(state || "").toLowerCase().trim();
  const c = String(city || "").toLowerCase().trim();
  if (c.includes("bangalore") || c.includes("bengaluru")) return "LOCAL";
  if (s.includes("karnataka")) return "STATE";
  if (SOUTH_STATES.some((k) => s.includes(k))) return "SOUTH";
  if (REMOTE_STATES.some((k) => s.includes(k))) return "REMOTE";
  return "PAN_INDIA";
}

function calcShippingRate(weightKg, zoneKey) {
  const zone = ROAD_ZONES[zoneKey];
  if (!zone) return 0;
  const weightG = weightKg * 1000;
  for (const slab of zone.rates) {
    if (weightG <= slab.maxG) return slab.price;
  }
  const top = zone.rates[zone.rates.length - 1].price;
  if (weightKg <= 50) return top + Math.ceil(weightKg - 10) * zone.perKgAbove10;
  return top + 40 * zone.perKgAbove10 + Math.ceil(weightKg - 50) * zone.perKgAbove50;
}

/**
 * @param {{ weightInGrams?: number, quantity: number }[]} lines
 * @param {{ state?: string, city?: string }} address
 * @returns {number} shipping charge in rupees
 */
function computeShipping(lines, address) {
  const weightKg = lines.reduce(
    (sum, l) => sum + ((l.weightInGrams ?? 500) / 1000) * l.quantity,
    0,
  );
  // 0.25 kg minimum billable weight, same as the UI
  return calcShippingRate(Math.max(weightKg, 0.25), getZoneKey(address?.state, address?.city));
}

module.exports = { computeShipping, getZoneKey, calcShippingRate };
