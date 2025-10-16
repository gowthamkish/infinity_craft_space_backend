const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String }, // Make optional for SSO users
  isAdmin: { type: Boolean, default: false },
  
  // SSO fields
  googleId: { type: String, sparse: true },
  microsoftId: { type: String, sparse: true },
  facebookId: { type: String, sparse: true },
  avatar: { type: String },
  provider: { type: String, enum: ['local', 'google', 'microsoft', 'facebook'], default: 'local' },
  
  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  lastLogin: { type: Date }
});

module.exports = mongoose.model("User", userSchema);
