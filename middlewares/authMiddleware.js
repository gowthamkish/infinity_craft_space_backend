const jwt = require('jsonwebtoken');
const User = require('../models/User');
const securityUtils = require('../utils/security');

const protect = async (req, res, next) => {
  let token;
  
  try {
    // Extract token from Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    // If no token found, return unauthorized
    if (!token) {
      return res.status(401).json({ 
        success: false,
        error: 'Access denied',
        message: 'No token provided' 
      });
    }

    // Verify token using enhanced security utils
    const decoded = securityUtils.verifyToken(token, false);
    
    // Find user and exclude sensitive fields
    const user = await User.findById(decoded.id).select('-password -__v');
    
    if (!user) {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid token',
        message: 'User not found' 
      });
    }

    // Check if user account is active (if you have this field)
    if (user.isActive === false) {
      return res.status(401).json({ 
        success: false,
        error: 'Account deactivated',
        message: 'Your account has been deactivated' 
      });
    }

    // Add user to request object
    req.user = user;
    
    // Log successful authentication for monitoring
    console.log(`User authenticated: ${user.email} (${user._id})`);
    
    next();
    
  } catch (error) {
    console.error('Authentication error:', {
      error: error.message,
      token: token ? 'present' : 'missing',
      timestamp: new Date().toISOString(),
      ip: req.ip
    });

    // Handle specific JWT errors
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired',
        message: 'Your session has expired. Please log in again.',
        code: 'TOKEN_EXPIRED'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token',
        message: 'Invalid authentication token',
        code: 'INVALID_TOKEN'
      });
    }

    // Generic authentication failure
    return res.status(401).json({
      success: false,
      error: 'Authentication failed',
      message: 'Invalid or malformed token',
      code: 'AUTH_FAILED'
    });
  }
};

const isAdmin = (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        message: 'You must be logged in to access admin resources'
      });
    }

    if (!req.user.isAdmin) {
      // Log unauthorized admin access attempt
      console.warn('Unauthorized admin access attempt:', {
        userId: req.user._id,
        email: req.user.email,
        ip: req.ip,
        timestamp: new Date().toISOString(),
        path: req.path,
        method: req.method
      });

      return res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'Admin privileges required'
      });
    }

    // Log successful admin access for audit trail
    console.log('Admin access granted:', {
      userId: req.user._id,
      email: req.user.email,
      ip: req.ip,
      timestamp: new Date().toISOString(),
      path: req.path,
      method: req.method
    });

    next();
  } catch (error) {
    console.error('Admin authorization error:', error);
    return res.status(500).json({
      success: false,
      error: 'Authorization error',
      message: 'Failed to verify admin privileges'
    });
  }
};

// Optional: Role-based access control
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        message: 'You must be logged in'
      });
    }

    const userRole = req.user.role || 'user';
    
    if (!roles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
        message: `This action requires one of the following roles: ${roles.join(', ')}`
      });
    }

    next();
  };
};

module.exports = { protect, isAdmin, requireRole };
