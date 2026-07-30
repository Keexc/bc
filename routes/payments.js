const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');

const VOTE_PRICE = Number(process.env.VOTE_PRICE || 20);

const fxsClient = axios.create({
  baseURL: process.env.FXS_BASE_URL,
  headers: { Authorization: `Bearer ${process.env.FXS_API_KEY}` },
  timeout: 15000
});

// Basic abuse protection on the payment-initiate endpoint
const initiateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many payment attempts. Please wait a moment and try again.' }
});

function normalizePhone(raw) {
  // FXS Pay normalizes phone formats itself, but we validate before
  // spending a request so users get fast feedback on typos.
  let phone = String(raw).trim().replace(/\s+/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (phone.startsWith('0')) phone = '254' + phone.slice(1);
  return phone;
}

function isValidSafaricomNumber(phone) {
  return /^254(7|1)\d{8}$/.test(phone);
}

// POST /api/payments/initiate
// body: { nomineeId, phone, votes }
router.post('/initiate', initiateLimiter, async (req, res) => {
  try {
    const { nomineeId, phone, votes } = req.body;
    const voteCount = parseInt(votes, 10);

    if (!nomineeId || !phone || !voteCount || voteCount < 1) {
      return res.status(400).json({ error: 'nomineeId, phone, and votes (>=1) are required' });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!isValidSafaricomNumber(normalizedPhone)) {
      return res.status(400).json({ error: 'Enter a valid Safaricom M-Pesa number' });
    }

    // Confirm the nominee exists and voting is open for its category
    const { data: nominee, error: nomErr } = await supabase
      .from('nominees')
      .select('id, full_name, is_active, category_id, categories!inner(is_active)')
      .eq('id', nomineeId)
      .single();

    if (nomErr || !nominee || !nominee.is_active || !nominee.categories.is_active) {
      return res.status(404).json({ error: 'Nominee not found or voting is closed for this category' });
    }

    const amount = voteCount * VOTE_PRICE;

    // Create our own pending row first (votes_requested lives here, since
    // FXS Pay only ever knows the KES amount, not "votes")
    const { data: txn, error: txnErr } = await supabase
      .from('transactions')
      .insert({
        nominee_id: nomineeId,
        phone_number: normalizedPhone,
        amount,
        votes_requested: voteCount,
        status: 'pending'
      })
      .select()
      .single();

    if (txnErr) return res.status(500).json({ error: txnErr.message });

    let fxsResponse;
    try {
      const { data } = await fxsClient.post('/api/mpesa/stk-push', {
        phone: normalizedPhone,
        amount,
        description: `${voteCount} vote(s) for ${nominee.full_name}`
      });
      fxsResponse = data; // { message, transactionId, paystackStatus }
    } catch (pushErr) {
      const providerMsg = pushErr.response?.data?.error;
      await supabase
        .from('transactions')
        .update({ status: 'failed', result_desc: providerMsg || 'STK push request failed to send' })
        .eq('id', txn.id);
      return res.status(502).json({ error: 'Could not reach the payment provider. Please try again.' });
    }

    // FXS Pay's own transactionId is what its webhook will reference later —
    // save it as our matching key.
    await supabase
      .from('transactions')
      .update({ fxs_reference: fxsResponse.transactionId })
      .eq('id', txn.id);

    res.json({
      message: fxsResponse.message || 'STK Push sent. Enter your M-Pesa PIN on your phone to complete payment.',
      transactionId: txn.id
    });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error initiating payment' });
  }
});

// GET /api/payments/status/:transactionId — our own row, for the frontend to poll.
// Falls back to asking FXS Pay directly if we're still pending and haven't
// heard a webhook yet, in case the webhook is delayed or was missed.
router.get('/status/:transactionId', async (req, res) => {
  const { data: txn, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', req.params.transactionId)
    .single();

  if (error || !txn) return res.status(404).json({ error: 'Transaction not found' });

  if (txn.status === 'pending' && txn.fxs_reference) {
    try {
      const { data } = await fxsClient.get(`/api/mpesa/status/${txn.fxs_reference}`);
      const providerStatus = data.transaction?.status;
      if (providerStatus === 'success' || providerStatus === 'failed') {
        await creditOrFailTransaction(txn, providerStatus, {});
        return res.json({ status: providerStatus, votes_requested: txn.votes_requested });
      }
    } catch (_) {
      // Ignore — fall through and report our last known status. The
      // webhook is still the primary path; this is just a fallback poll.
    }
  }

  res.json({ status: txn.status, votes_requested: txn.votes_requested, mpesa_receipt: txn.mpesa_receipt });
});

// Shared logic for marking a transaction resolved and crediting votes,
// used by both the webhook and the status-poll fallback above.
async function creditOrFailTransaction(txn, status, extra) {
  // Idempotency guard — never process (or double-credit) a transaction twice
  const { data: fresh } = await supabase
    .from('transactions')
    .select('status')
    .eq('id', txn.id)
    .single();
  if (fresh.status === 'success' || fresh.status === 'failed') return;

  await supabase
    .from('transactions')
    .update({
      status,
      mpesa_receipt: extra.receiptUrl || extra.mpesa_receipt || null,
      result_desc: extra.reason || null,
      raw_callback: extra.raw || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', txn.id);

  if (status === 'success') {
    const voteRows = Array.from({ length: txn.votes_requested }, () => ({
      nominee_id: txn.nominee_id,
      transaction_id: txn.id
    }));
    await supabase.from('votes').insert(voteRows);
  }
}

// POST /api/payments/webhook — FXS Pay calls this when a payment resolves.
// Relies on req.rawBody (captured in server.js) for signature verification.
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-fxspay-signature'];
    const event = req.headers['x-fxspay-event'];

    const expected = crypto
      .createHmac('sha256', process.env.FXS_WEBHOOK_SECRET)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
      .digest('hex');

    if (!signature || signature !== expected) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const { transactionId, receiptUrl, reason } = req.body;
    if (!transactionId) return res.status(400).json({ error: 'Missing transactionId' });

    const { data: txn, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('fxs_reference', transactionId)
      .single();

    if (error || !txn) {
      // Respond 200 anyway — an unknown reference isn't something FXS Pay
      // should keep retrying, and swallowing it here avoids blocking their
      // delivery queue on our side.
      return res.status(200).json({ message: 'No matching transaction' });
    }

    const status = event === 'payment.success' ? 'success' : 'failed';
    await creditOrFailTransaction(txn, status, { receiptUrl, reason, raw: req.body });

    res.status(200).json({ message: 'Webhook processed' });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error processing webhook' });
  }
});

module.exports = router;
