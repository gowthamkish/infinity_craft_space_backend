const mongoose = require("mongoose");
const crypto = require("crypto");

const AddressSchema = new mongoose.Schema({
  label: { type: String, default: "" },
  street: { type: String, required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },
  zipCode: { type: String, required: true },
  country: { type: String, required: true, default: "India" },
  isDefault: { type: Boolean, default: false },
  phone: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },

  // Role-based access (isAdmin kept for backward-compat)
  isAdmin: { type: Boolean, default: false },
  role: {
    type: String,
    enum: ["customer", "staff", "admin", "superadmin"],
    default: "customer",
  },
  permissions: {
    type: [String],
    default: [],
    // e.g. ["manage_orders", "manage_products", "manage_users"]
  },

  addresses: { type: [AddressSchema], default: [] },
  wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],

  // Account lockout
  loginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },

  // Loyalty programme
  loyaltyPoints: { type: Number, default: 0 },
  loyaltyTier: {
    type: String,
    enum: ["bronze", "silver", "gold"],
    default: "bronze",
  },

  // Referral programme
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  referralCredits: { type: Number, default: 0 }, // store credit in ₹
});

// Auto-generate referral code on first save
userSchema.pre("save", function (next) {
  if (!this.referralCode) {
    this.referralCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  }
  // Keep isAdmin in sync with role for backward-compat
  if (this.isModified("role")) {
    this.isAdmin = this.role === "admin" || this.role === "superadmin";
  }
  if (this.isModified("isAdmin") && !this.isModified("role")) {
    this.role = this.isAdmin ? "admin" : "customer";
  }
  // Auto-upgrade loyalty tier
  if (this.isModified("loyaltyPoints")) {
    if (this.loyaltyPoints >= 5000) this.loyaltyTier = "gold";
    else if (this.loyaltyPoints >= 2000) this.loyaltyTier = "silver";
    else this.loyaltyTier = "bronze";
  }
  next();
});

userSchema.index({ email: 1 });
userSchema.index({ referralCode: 1 });
userSchema.index({ role: 1 });

module.exports = mongoose.model("User", userSchema);
