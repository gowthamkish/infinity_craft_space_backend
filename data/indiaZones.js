/**
 * India PIN Code → State → Zone mapping.
 *
 * Zones are used to calculate inter-state shipping distances from the
 * Bangalore (Karnataka) warehouse.
 *
 * Lookup strategy: PINCODE_RANGES is ordered so more-specific ranges
 * (shorter or higher-priority) appear before broad ones.
 * pincodeToState() walks the list and returns on first match.
 */

// ── State → Zone ─────────────────────────────────────────────────────────────

const ZONE = {
  SOUTH:     "SOUTH",
  WEST:      "WEST",
  CENTRAL:   "CENTRAL",
  NORTH:     "NORTH",
  EAST:      "EAST",
  NORTHEAST: "NORTHEAST",
};

/** Maps 2-letter state code → zone */
const STATE_TO_ZONE = {
  // South
  KA: ZONE.SOUTH, TN: ZONE.SOUTH, KL: ZONE.SOUTH,
  AP: ZONE.SOUTH, TG: ZONE.SOUTH, GA: ZONE.SOUTH,
  PY: ZONE.SOUTH, AN: ZONE.SOUTH, LD: ZONE.SOUTH,

  // West
  MH: ZONE.WEST, GJ: ZONE.WEST, DD: ZONE.WEST, DN: ZONE.WEST,

  // Central
  MP: ZONE.CENTRAL, CG: ZONE.CENTRAL,

  // North
  DL: ZONE.NORTH, HR: ZONE.NORTH, PB: ZONE.NORTH, HP: ZONE.NORTH,
  JK: ZONE.NORTH, RJ: ZONE.NORTH, UP: ZONE.NORTH, UK: ZONE.NORTH,
  CH: ZONE.NORTH, LA: ZONE.NORTH, UT: ZONE.NORTH,

  // East
  WB: ZONE.EAST, OR: ZONE.EAST, JH: ZONE.EAST, BR: ZONE.EAST,

  // Northeast
  AS: ZONE.NORTHEAST, AR: ZONE.NORTHEAST, MN: ZONE.NORTHEAST,
  MZ: ZONE.NORTHEAST, NL: ZONE.NORTHEAST, SK: ZONE.NORTHEAST,
  TR: ZONE.NORTHEAST, ML: ZONE.NORTHEAST,
};

// ── Pincode prefix ranges → state code ───────────────────────────────────────
// Each entry: [firstThreeDigitsMin, firstThreeDigitsMax, stateCode]
// IMPORTANT: More-specific / overlapping ranges MUST come before broader ones.

const PINCODE_RANGES = [
  // ── Delhi ────────────────────────────────────────────────────────────────
  [110, 119, "DL"],

  // ── Haryana ──────────────────────────────────────────────────────────────
  [120, 136, "HR"],

  // ── Uttarakhand (subset of UP range — check BEFORE UP) ───────────────────
  [246, 249, "UK"],
  [263, 273, "UK"],

  // ── Uttar Pradesh ────────────────────────────────────────────────────────
  [200, 285, "UP"],

  // ── Punjab ───────────────────────────────────────────────────────────────
  [140, 159, "PB"],

  // ── Chandigarh ───────────────────────────────────────────────────────────
  [160, 161, "CH"],

  // ── Himachal Pradesh ─────────────────────────────────────────────────────
  [170, 177, "HP"],

  // ── Jammu & Kashmir / Ladakh ─────────────────────────────────────────────
  [195, 199, "LA"],
  [180, 194, "JK"],

  // ── Rajasthan ────────────────────────────────────────────────────────────
  [302, 344, "RJ"],

  // ── Gujarat ──────────────────────────────────────────────────────────────
  [360, 396, "GJ"],

  // ── Goa (subset of MH-range — check BEFORE MH) ───────────────────────────
  [403, 403, "GA"],

  // ── Maharashtra ──────────────────────────────────────────────────────────
  [400, 445, "MH"],

  // ── Chhattisgarh (check before MP broad range) ───────────────────────────
  [490, 497, "CG"],

  // ── Madhya Pradesh ───────────────────────────────────────────────────────
  [450, 489, "MP"],

  // ── Telangana (check before AP) ──────────────────────────────────────────
  [500, 514, "TG"],
  [535, 535, "TG"],

  // ── Andhra Pradesh ───────────────────────────────────────────────────────
  [515, 534, "AP"],

  // ── Karnataka ────────────────────────────────────────────────────────────
  [560, 591, "KA"],

  // ── Tamil Nadu ───────────────────────────────────────────────────────────
  [600, 643, "TN"],

  // ── Puducherry ───────────────────────────────────────────────────────────
  [605, 605, "PY"],

  // ── Lakshadweep ──────────────────────────────────────────────────────────
  [682, 682, "LD"],

  // ── Kerala ───────────────────────────────────────────────────────────────
  [670, 695, "KL"],

  // ── West Bengal ──────────────────────────────────────────────────────────
  [700, 743, "WB"],

  // ── Andaman & Nicobar ────────────────────────────────────────────────────
  [744, 744, "AN"],

  // ── Odisha ───────────────────────────────────────────────────────────────
  [751, 770, "OR"],

  // ── Jharkhand (check before BR) ──────────────────────────────────────────
  [825, 835, "JH"],

  // ── Bihar ────────────────────────────────────────────────────────────────
  [800, 855, "BR"],

  // ── Assam ────────────────────────────────────────────────────────────────
  [781, 788, "AS"],

  // ── Northeast (generic catch-all for 790–799) ────────────────────────────
  [790, 799, "AS"], // Arunachal / Meghalaya / Manipur etc share range

  // ── Sikkim ───────────────────────────────────────────────────────────────
  [737, 737, "SK"],
];

// ── Zone-to-Zone delivery day matrix ─────────────────────────────────────────
// Key format: "${fromZone}-${toZone}"
// Values: { min, max } in business days (excludes Sundays + holidays)

const ZONE_MATRIX = {
  "SOUTH-SOUTH":         { min: 2, max: 4 },
  "SOUTH-WEST":          { min: 3, max: 5 },
  "SOUTH-CENTRAL":       { min: 4, max: 6 },
  "SOUTH-NORTH":         { min: 5, max: 8 },
  "SOUTH-EAST":          { min: 5, max: 7 },
  "SOUTH-NORTHEAST":     { min: 7, max: 10 },

  "WEST-WEST":           { min: 2, max: 4 },
  "WEST-SOUTH":          { min: 3, max: 5 },
  "WEST-CENTRAL":        { min: 3, max: 5 },
  "WEST-NORTH":          { min: 4, max: 7 },
  "WEST-EAST":           { min: 5, max: 8 },
  "WEST-NORTHEAST":      { min: 7, max: 10 },

  "CENTRAL-CENTRAL":     { min: 2, max: 4 },
  "CENTRAL-SOUTH":       { min: 4, max: 6 },
  "CENTRAL-WEST":        { min: 3, max: 5 },
  "CENTRAL-NORTH":       { min: 3, max: 6 },
  "CENTRAL-EAST":        { min: 3, max: 6 },
  "CENTRAL-NORTHEAST":   { min: 6, max: 9 },

  "NORTH-NORTH":         { min: 2, max: 4 },
  "NORTH-SOUTH":         { min: 5, max: 8 },
  "NORTH-WEST":          { min: 4, max: 7 },
  "NORTH-CENTRAL":       { min: 3, max: 6 },
  "NORTH-EAST":          { min: 4, max: 7 },
  "NORTH-NORTHEAST":     { min: 5, max: 8 },

  "EAST-EAST":           { min: 2, max: 4 },
  "EAST-SOUTH":          { min: 5, max: 7 },
  "EAST-WEST":           { min: 5, max: 8 },
  "EAST-CENTRAL":        { min: 3, max: 6 },
  "EAST-NORTH":          { min: 4, max: 7 },
  "EAST-NORTHEAST":      { min: 3, max: 6 },

  "NORTHEAST-NORTHEAST": { min: 2, max: 4 },
  "NORTHEAST-EAST":      { min: 3, max: 6 },
  "NORTHEAST-NORTH":     { min: 5, max: 8 },
  "NORTHEAST-WEST":      { min: 7, max: 10 },
  "NORTHEAST-SOUTH":     { min: 7, max: 10 },
  "NORTHEAST-CENTRAL":   { min: 6, max: 9 },
};

// ── Configurable holidays (YYYY-MM-DD) ───────────────────────────────────────
// Update annually. Sundays are always excluded by the business-day calculator.
const PUBLIC_HOLIDAYS = [
  "2026-01-26", // Republic Day
  "2026-03-17", // Holi
  "2026-04-14", // Dr. Ambedkar Jayanti
  "2026-04-19", // Good Friday (approximate)
  "2026-05-01", // Labour Day
  "2026-08-15", // Independence Day
  "2026-08-19", // Janmashtami (approximate)
  "2026-10-02", // Gandhi Jayanti
  "2026-10-20", // Dussehra (approximate)
  "2026-11-05", // Diwali (approximate)
  "2026-12-25", // Christmas
];

// ── Warehouse config ──────────────────────────────────────────────────────────
const WAREHOUSE_PINCODE = "560001"; // Bangalore, Karnataka

module.exports = {
  ZONE,
  STATE_TO_ZONE,
  PINCODE_RANGES,
  ZONE_MATRIX,
  PUBLIC_HOLIDAYS,
  WAREHOUSE_PINCODE,
};
