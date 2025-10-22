const crypto = require('crypto');
const CryptoJS = require('crypto-js');
const jwt = require('jsonwebtoken');

class SecurityUtils {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    this.encryptionKey = process.env.ENCRYPTION_KEY || crypto.randomBytes(32);
    this.jwtSecret = process.env.JWT_SECRET;
    this.jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
  }

  // JWT Token Generation with enhanced security
  generateTokens(payload) {
    const accessToken = jwt.sign(
      payload,
      this.jwtSecret,
      {
        expiresIn: process.env.JWT_EXPIRE || '15m',
        issuer: 'infinity-craft-space',
        audience: 'infinity-craft-users',
        algorithm: 'HS256'
      }
    );

    const refreshToken = jwt.sign(
      { id: payload.id, type: 'refresh' },
      this.jwtRefreshSecret,
      {
        expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d',
        issuer: 'infinity-craft-space',
        audience: 'infinity-craft-users',
        algorithm: 'HS256'
      }
    );

    return { accessToken, refreshToken };
  }

  // Enhanced JWT verification with additional security checks
  verifyToken(token, isRefreshToken = false) {
    try {
      const secret = isRefreshToken ? this.jwtRefreshSecret : this.jwtSecret;
      const decoded = jwt.verify(token, secret, {
        issuer: 'infinity-craft-space',
        audience: 'infinity-craft-users',
        algorithms: ['HS256']
      });

      // Additional security checks
      if (isRefreshToken && decoded.type !== 'refresh') {
        throw new Error('Invalid refresh token type');
      }

      return decoded;
    } catch (error) {
      throw new Error(`Token verification failed: ${error.message}`);
    }
  }

  // Encrypt sensitive data
  encrypt(text) {
    if (!text) return null;
    
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipher(this.algorithm, this.encryptionKey);
      
      let encrypted = cipher.update(text.toString(), 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const authTag = cipher.getAuthTag();
      
      return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
      };
    } catch (error) {
      throw new Error(`Encryption failed: ${error.message}`);
    }
  }

  // Decrypt sensitive data
  decrypt(encryptedData) {
    if (!encryptedData || !encryptedData.encrypted) return null;
    
    try {
      const decipher = crypto.createDecipher(this.algorithm, this.encryptionKey);
      
      if (encryptedData.authTag) {
        decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));
      }
      
      let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      throw new Error(`Decryption failed: ${error.message}`);
    }
  }

  // Hash sensitive data (one-way)
  hashData(data, salt = null) {
    const saltToUse = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(data, saltToUse, 10000, 64, 'sha512').toString('hex');
    
    return {
      hash,
      salt: saltToUse
    };
  }

  // Verify hashed data
  verifyHash(data, hash, salt) {
    const verifyHash = crypto.pbkdf2Sync(data, salt, 10000, 64, 'sha512').toString('hex');
    return hash === verifyHash;
  }

  // Generate secure random tokens
  generateSecureToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }

  // Generate secure OTP
  generateOTP(length = 6) {
    const digits = '0123456789';
    let otp = '';
    
    for (let i = 0; i < length; i++) {
      otp += digits[crypto.randomInt(0, digits.length)];
    }
    
    return otp;
  }

  // Encrypt personal information (PII)
  encryptPII(data) {
    if (typeof data !== 'object' || data === null) {
      throw new Error('PII data must be an object');
    }

    const encryptedData = {};
    const sensitiveFields = ['email', 'phone', 'address', 'ssn', 'creditCard', 'bankAccount'];
    
    for (const [key, value] of Object.entries(data)) {
      if (sensitiveFields.includes(key) && value) {
        encryptedData[key] = this.encrypt(value);
      } else {
        encryptedData[key] = value;
      }
    }
    
    return encryptedData;
  }

  // Decrypt personal information (PII)
  decryptPII(data) {
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    const decryptedData = {};
    const sensitiveFields = ['email', 'phone', 'address', 'ssn', 'creditCard', 'bankAccount'];
    
    for (const [key, value] of Object.entries(data)) {
      if (sensitiveFields.includes(key) && value && typeof value === 'object') {
        try {
          decryptedData[key] = this.decrypt(value);
        } catch (error) {
          // If decryption fails, return original value (might not be encrypted)
          decryptedData[key] = value;
        }
      } else {
        decryptedData[key] = value;
      }
    }
    
    return decryptedData;
  }

  // Sanitize input to prevent XSS
  sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    
    return input
      .replace(/[<>]/g, '') // Remove < and >
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/on\w+=/gi, '') // Remove event handlers
      .trim();
  }

  // Generate secure session ID
  generateSessionId() {
    return this.generateSecureToken(64);
  }

  // Create secure cookie options
  getSecureCookieOptions() {
    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      path: '/'
    };
  }

  // Rate limiting helper
  createRateLimitKey(req, identifier = 'ip') {
    switch (identifier) {
      case 'ip':
        return req.ip || req.connection.remoteAddress;
      case 'user':
        return req.user?.id || req.ip;
      case 'email':
        return req.body?.email || req.ip;
      default:
        return req.ip;
    }
  }

  // Validate password strength
  validatePasswordStrength(password) {
    const minLength = 8;
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
    
    const strength = {
      isValid: password.length >= minLength && hasUpperCase && hasLowerCase && hasNumbers && hasSpecialChar,
      score: 0,
      feedback: []
    };

    if (password.length >= minLength) strength.score += 20;
    else strength.feedback.push('Password must be at least 8 characters long');

    if (hasUpperCase) strength.score += 20;
    else strength.feedback.push('Password must contain uppercase letters');

    if (hasLowerCase) strength.score += 20;
    else strength.feedback.push('Password must contain lowercase letters');

    if (hasNumbers) strength.score += 20;
    else strength.feedback.push('Password must contain numbers');

    if (hasSpecialChar) strength.score += 20;
    else strength.feedback.push('Password must contain special characters');

    return strength;
  }

  // Mask sensitive data for logging
  maskSensitiveData(obj, fields = ['password', 'token', 'creditCard', 'ssn']) {
    if (typeof obj !== 'object' || obj === null) return obj;
    
    const masked = { ...obj };
    
    fields.forEach(field => {
      if (masked[field]) {
        masked[field] = '*'.repeat(8);
      }
    });
    
    return masked;
  }
}

module.exports = new SecurityUtils();