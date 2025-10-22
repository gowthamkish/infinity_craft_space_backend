const crypto = require('crypto');

class SecurityConfigChecker {
  constructor() {
    this.requiredEnvVars = [
      'JWT_SECRET',
      'JWT_REFRESH_SECRET',
      'MONGO_URI',
      'ENCRYPTION_KEY'
    ];
    
    this.recommendations = [];
    this.warnings = [];
    this.errors = [];
  }

  checkEnvironmentVariables() {
    console.log('🔒 Checking security configuration...\n');

    // Check required environment variables
    for (const envVar of this.requiredEnvVars) {
      if (!process.env[envVar]) {
        this.errors.push(`Missing required environment variable: ${envVar}`);
      }
    }

    // Check JWT secret strength
    this.checkJWTSecrets();
    
    // Check encryption key
    this.checkEncryptionKey();
    
    // Check database security
    this.checkDatabaseSecurity();
    
    // Check CORS configuration
    this.checkCORSConfiguration();
    
    // Check NODE_ENV
    this.checkNodeEnvironment();
    
    // Check password policies
    this.checkPasswordPolicies();
    
    this.printResults();
  }

  checkJWTSecrets() {
    const jwtSecret = process.env.JWT_SECRET;
    const refreshSecret = process.env.JWT_REFRESH_SECRET;

    if (jwtSecret) {
      if (jwtSecret.length < 32) {
        this.warnings.push('JWT_SECRET should be at least 32 characters long');
      }
      
      if (jwtSecret === refreshSecret) {
        this.errors.push('JWT_SECRET and JWT_REFRESH_SECRET must be different');
      }
      
      // Check for common weak secrets
      const weakSecrets = [
        'secret',
        'password',
        'your-secret-key',
        'jwt-secret',
        '123456789',
        'mysecret'
      ];
      
      if (weakSecrets.some(weak => jwtSecret.toLowerCase().includes(weak))) {
        this.errors.push('JWT_SECRET appears to use common/weak patterns');
      }
    }

    if (refreshSecret && refreshSecret.length < 32) {
      this.warnings.push('JWT_REFRESH_SECRET should be at least 32 characters long');
    }
  }

  checkEncryptionKey() {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    
    if (encryptionKey) {
      if (encryptionKey.length < 32) {
        this.errors.push('ENCRYPTION_KEY must be at least 32 characters long');
      }
      
      // Check if it's properly random (basic check)
      const pattern = /^[a-zA-Z0-9+/=]+$/;
      if (!pattern.test(encryptionKey)) {
        this.recommendations.push('Consider using a base64-encoded random key for ENCRYPTION_KEY');
      }
    }
  }

  checkDatabaseSecurity() {
    const mongoUri = process.env.MONGO_URI;
    
    if (mongoUri) {
      // Check for embedded credentials
      if (mongoUri.includes('@') && !mongoUri.includes('localhost')) {
        this.warnings.push('Database URI contains embedded credentials - consider using environment variables');
      }
      
      // Check for SSL/TLS
      if (process.env.NODE_ENV === 'production' && !mongoUri.includes('ssl=true')) {
        this.recommendations.push('Consider enabling SSL/TLS for database connections in production');
      }
      
      // Check for localhost in production
      if (process.env.NODE_ENV === 'production' && mongoUri.includes('localhost')) {
        this.warnings.push('Using localhost database in production environment');
      }
    }
  }

  checkCORSConfiguration() {
    const allowedOrigins = process.env.ALLOWED_ORIGINS;
    
    if (!allowedOrigins) {
      this.warnings.push('ALLOWED_ORIGINS not configured - CORS may be too permissive');
    } else if (allowedOrigins.includes('*')) {
      this.errors.push('CORS configured to allow all origins (*) - this is a security risk');
    }
  }

  checkNodeEnvironment() {
    const nodeEnv = process.env.NODE_ENV;
    
    if (nodeEnv !== 'production' && nodeEnv !== 'development') {
      this.warnings.push(`NODE_ENV is set to '${nodeEnv}' - should be 'production' or 'development'`);
    }
    
    if (nodeEnv === 'production') {
      // Production-specific checks
      if (process.env.ENABLE_DEBUG_LOGS === 'true') {
        this.warnings.push('Debug logging is enabled in production');
      }
      
      if (process.env.ENABLE_SWAGGER_UI === 'true') {
        this.warnings.push('Swagger UI is enabled in production');
      }
    }
  }

  checkPasswordPolicies() {
    // These are recommendations based on the User model
    this.recommendations.push('Ensure password policy requires: 8+ chars, uppercase, lowercase, number, special character');
    this.recommendations.push('Consider implementing account lockout after failed login attempts');
    this.recommendations.push('Consider implementing password history to prevent reuse');
  }

  generateSecureKeys() {
    console.log('\n🔑 Generated secure keys for your .env file:');
    console.log('Copy these to your .env file:\n');
    
    console.log(`JWT_SECRET=${crypto.randomBytes(64).toString('hex')}`);
    console.log(`JWT_REFRESH_SECRET=${crypto.randomBytes(64).toString('hex')}`);
    console.log(`ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);
    console.log(`SESSION_SECRET=${crypto.randomBytes(64).toString('hex')}`);
    console.log(`COOKIE_SECRET=${crypto.randomBytes(32).toString('hex')}`);
    
    console.log('\n⚠️  IMPORTANT: Keep these keys secure and never commit them to version control!');
  }

  printResults() {
    console.log('\n📊 Security Configuration Report:\n');
    
    if (this.errors.length > 0) {
      console.log('❌ ERRORS (Must Fix):');
      this.errors.forEach(error => console.log(`   • ${error}`));
      console.log();
    }
    
    if (this.warnings.length > 0) {
      console.log('⚠️  WARNINGS (Should Fix):');
      this.warnings.forEach(warning => console.log(`   • ${warning}`));
      console.log();
    }
    
    if (this.recommendations.length > 0) {
      console.log('💡 RECOMMENDATIONS:');
      this.recommendations.forEach(rec => console.log(`   • ${rec}`));
      console.log();
    }
    
    if (this.errors.length === 0 && this.warnings.length === 0) {
      console.log('✅ Security configuration looks good!');
    }
    
    console.log('\n🔒 Additional Security Checklist:');
    console.log('   □ Use HTTPS in production');
    console.log('   □ Keep dependencies updated');
    console.log('   □ Regular security audits');
    console.log('   □ Monitor for suspicious activity');
    console.log('   □ Implement proper logging');
    console.log('   □ Use environment-specific configurations');
    console.log('   □ Regular backups with encryption');
  }

  runFullCheck() {
    this.checkEnvironmentVariables();
    
    if (process.argv.includes('--generate-keys')) {
      this.generateSecureKeys();
    }
  }
}

// Export for use in other modules
module.exports = SecurityConfigChecker;

// Run check if this file is executed directly
if (require.main === module) {
  const checker = new SecurityConfigChecker();
  checker.runFullCheck();
}