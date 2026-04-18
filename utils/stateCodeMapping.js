/**
 * State Code Mapping for Shiprocket
 * Converts full state names to 2-letter state codes
 */

const stateToCodeMap = {
  // Use lowercase keys for case-insensitive lookup
  "andaman and nicobar islands": "AN",
  "andhra pradesh": "AP",
  "arunachal pradesh": "AR",
  assam: "AS",
  bihar: "BR",
  chhattisgarh: "CT",
  "dadra and nagar haveli": "DD",
  "daman and diu": "DL",
  delhi: "DL",
  goa: "GA",
  gujarat: "GJ",
  haryana: "HR",
  "himachal pradesh": "HP",
  "jammu and kashmir": "JK",
  jharkhand: "JH",
  karnataka: "KA",
  kerala: "KL",
  lakshadweep: "LD",
  "madhya pradesh": "MP",
  maharashtra: "MH",
  manipur: "MN",
  meghalaya: "ML",
  mizoram: "MZ",
  nagaland: "NL",
  odisha: "OR",
  puducherry: "PY",
  punjab: "PB",
  rajasthan: "RJ",
  sikkim: "SK",
  "tamil nadu": "TN",
  telangana: "TG",
  tripura: "TR",
  "uttar pradesh": "UP",
  uttarakhand: "UT",
  "west bengal": "WB",
};

/**
 * Get state code from state name
 * @param {string} stateName - Full state name
 * @returns {string} 2-letter state code or original input
 */
function getStateCode(stateName) {
  if (!stateName) return "";

  // Normalize: trim and lowercase
  const normalized = stateName.trim().toLowerCase();

  // Return code if found, otherwise return original (might already be a code)
  return stateToCodeMap[normalized] || stateName;
}

module.exports = {
  stateToCodeMap,
  getStateCode,
};
