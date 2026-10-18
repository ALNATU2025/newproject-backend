const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const env = require('./config/env');
const { notFoundHandler, errorHandler } = require('./middleware/error');

function createApp() {
  const app = express();

  // Behind Render / Railway / Nginx the client IP comes from X-Forwarded-For.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      // Mobile apps send no Origin header; browsers must be on the list.
      origin: (origin, cb) => {
        if (!origin || env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
    }),
  );
  app.use(express.json({ limit: '200kb' }));
  if (!env.isTest) app.use(morgan(env.isProd ? 'combined' : 'dev'));

  app.get('/health', (req, res) =>
    res.json({
      success: true,
      data: {
        status: 'ok',
        database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        time: new Date().toISOString(),
      },
    }),
  );

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/me', require('./routes/me'));
  app.use('/api/wallet', require('./routes/wallet'));
  app.use('/api/transactions', require('./routes/transactions'));
  app.use('/api/services', require('./routes/services'));
  app.use('/api/commission', require('./routes/commission'));
  app.use('/api/referrals', require('./routes/referrals'));
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/disputes', require('./routes/disputes'));
  app.use('/api/kyc', require('./routes/kyc'));
  app.use('/api/webhooks', require('./routes/webhooks'));
  app.use('/api/admin', require('./routes/admin'));

  if (!env.isProd && env.paymentProvider === 'simulator') {
    app.use('/api/dev', require('./routes/dev'));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
