/**
 * Shiprocket Service — DISABLED (will be re-enabled in future)
 * 
 * This service has been disabled and is not in use.
 * The complete implementation is preserved in version control history
 * and can be re-enabled when Shiprocket integration resumes.
 * 
 * For now, all Shiprocket functions throw errors indicating the integration is disabled.
 */

// COMMENTED OUT — Shiprocket integration disabled
// Full implementation removed to simplify the codebase during development phase

// Exporting disabled stub functions to prevent import errors
module.exports = {
  getToken: async () => {
    throw new Error("Shiprocket integration disabled");
  },
  createShiprocketOrder: async () => {
    throw new Error("Shiprocket integration disabled");
  },
  getShippingRates: async () => {
    throw new Error("Shiprocket integration disabled");
  },
  trackShipment: async () => {
    throw new Error("Shiprocket integration disabled");
  },
  cancelShiprocketOrder: async () => {
    throw new Error("Shiprocket integration disabled");
  },
  cancelAWB: async () => {
    throw new Error("Shiprocket integration disabled");
  },
  createReturnOrder: async () => {
    throw new Error("Shiprocket integration disabled");
  },
  mapSRStatus: () => null,
  calcWeight: () => 0.5,
};
