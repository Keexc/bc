require('dotenv').config();
const express = require('express');
const cors = require('cors');

const publicRoutes = require('./routes/public');
const paymentRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');

const app = express();

// Render sits behind a proxy — without this, express-rate-limit can't
// safely use the X-Forwarded-For header to identify clients and throws
// a validation error on every request.
app.set('trust proxy', 1);

app.use(cors());
// The `verify` hook stashes the raw body bytes on req.rawBody, needed to
// check the Paystack webhook's HMAC-SHA512 signature (must be computed over
// the exact raw bytes, not a re-serialized JSON.stringify(req.body)).
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/', (req, res) => res.json({ status: 'Kenyan Excellence Awards API running' }));

app.use('/api', publicRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);

// Fallback error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`KEA API listening on port ${PORT}`));
