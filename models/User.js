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
  referralCredits: { type: Number, default: 0 },

  // ── Security questions ────────────────────────────────────────────────────
  // answerHash = bcrypt(normalised_answer, 12). select:false keeps hashes off API responses.
  hasSecurityQuestions: { type: Boolean, default: false }, // fast check without loading the array
  securityQuestions: {
    type: [{
      questionIndex: { type: Number, required: true },
      answerHash: { type: String, required: true },
    }],
    default: [],
    select: false, // contains bcrypt hashes — never expose
  },

  // ── Password reset tokens ─────────────────────────────────────────────────
  // These store SHA-256 hashes of random tokens (hashes are not secret).
  // They are excluded from API responses via the protect middleware's projection,
  // NOT via select:false (which causes Mongoose save/query quirks with partial projections).
  verificationToken: { type: String },
  verificationTokenExpiry: { type: Date },
  verificationAttempts: { type: Number, default: 0 },

  resetToken: { type: String },
  resetTokenExpiry: { type: Date },

  // ── Session invalidation ───────────────────────────────────────────────────
  // JWTs issued before this timestamp are rejected by the protect middleware.
  passwordChangedAt: { type: Date },

  // ── Previous password hash (reuse prevention) ─────────────────────────────
  previousPasswordHash: { type: String, select: false },
});

userSchema.pre("save", function (next) {
  if (!this.referralCode) {
    this.referralCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  }
  if (this.isModified("role")) {
    this.isAdmin = this.role === "admin" || this.role === "superadmin";
  }
  if (this.isModified("isAdmin") && !this.isModified("role")) {
    this.role = this.isAdmin ? "admin" : "customer";
  }
  if (this.isModified("loyaltyPoints")) {
    if (this.loyaltyPoints >= 5000) this.loyaltyTier = "gold";
    else if (this.loyaltyPoints >= 2000) this.loyaltyTier = "silver";
    else this.loyaltyTier = "bronze";
  }
  next();
});

userSchema.index({ role: 1 });
// Sparse indexes for O(1) token lookups
userSchema.index({ verificationToken: 1 }, { sparse: true });
userSchema.index({ resetToken: 1 }, { sparse: true });

module.exports = mongoose.model("User", userSchema);
