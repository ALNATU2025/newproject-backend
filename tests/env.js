// Test environment (runs before every test file).
process.env.NODE_ENV = 'test';
process.env.MONGO_URI =
  process.env.MONGO_URL || process.env.MONGO_URI_TEST || 'mongodb://127.0.0.1:27017/dalabapay_test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-tests-1234567890';
process.env.BILL_PROVIDER = 'simulator';
process.env.PAYMENT_PROVIDER = 'simulator';
process.env.WEBHOOK_SECRET = 'test-webhook-secret';
process.env.SMTP_HOST = '';
