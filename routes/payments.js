const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');

const VOTE_PRICE = Number(process.env.VOTE_PRICE || 20);

const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  timeout: 20000
});

const initiateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many payment attempts. Please wait a moment and try again.' }
});

function normalizePhone(raw) {
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

    const amount = voteCount * VOTE_PRICE;

    // Confirm the nominee up front — unlike FXS Pay, Paystack's charge call
    // reliably returns a reference synchronously, so there's no benefit to
    // firing it before we know the nominee is valid.
    const { data: nominee, error: nomErr } = await supabase
      .from('nominees')
      .select('id, full_name, is_active, category_id, categories!inner(is_active)')
      .eq('id', nomineeId)
      .single();

    if (nomErr || !nominee || !nominee.is_active || !nominee.categories.is_active) {
      return res.status(404).json({ error: 'Nominee not found or voting is closed for this category' });
    }

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

    try {
      // Paystack requires an email even though voters never provide one —
      // a synthetic address tied to the phone number is fine, it's never
      // actually emailed for this channel.
      const { data } = await paystack.post('/charge', {
        email: `voter+${normalizedPhone}@kea-awards.local`,
        amount,
        currency: 'KES',
        mobile_money: {
          phone: normalizedPhone,
          provider: 'mpesa'
        }
      });

      // Paystack's own transaction reference — this is what the webhook
      // and Verify Transaction API will reference later.
      await supabase
        .from('transactions')
        .update({ fxs_reference: data.data.reference })
        .eq('id', txn.id);

      return res.json({
        message: data.data.display_text || 'STK Push sent. Enter your M-Pesa PIN on your phone to complete payment.',
        transactionId: txn.id
      });
    } catch (pushErr) {
      const providerMsg = pushErr.response?.data?.message;
      await supabase
        .from('transactions')
        .update({ status: 'failed', result_desc: providerMsg || pushErr.message || 'Charge request failed' })
        .eq('id', txn.id);
      return res.status(502).json({ error: providerMsg || 'Could not start payment. Please try again.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error initiating payment' });
  }
});

// GET /api/payments/status/:transactionId — polled by the frontend.
// Falls back to Paystack's Verify Transaction API if still pending and no
// webhook has landed yet — mobile money charges are expected to resolve or
// fail within Paystack's own 180-second window.
router.get('/status/:transactionId', async (req, res) => {
  const { data: txn, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', req.params.transactionId)
    .single();

  if (error || !txn) return res.status(404).json({ error: 'Transaction not found' });

  if (txn.status === 'pending' && txn.fxs_reference) {
    try {
      const { data } = await paystack.get(`/transaction/verify/${txn.fxs_reference}`);
      const providerStatus = data.data?.status; // 'success' | 'failed' | 'abandoned' | ...

      if (providerStatus === 'success') {
        await creditOrFailTransaction(txn, 'success', { raw: data.data });
        return res.json({ status: 'success', votes_requested: txn.votes_requested });
      }
      if (providerStatus === 'failed' || providerStatus === 'abandoned') {
        await creditOrFailTransaction(txn, 'failed', { reason: providerStatus, raw: data.data });
        return res.json({ status: 'failed', votes_requested: txn.votes_requested });
      }
    } catch (_) {
      // Ignore — webhook is still the primary path; this is a fallback poll.
    }
  }

  res.json({ status: txn.status, votes_requested: txn.votes_requested, mpesa_receipt: txn.mpesa_receipt });
});

async function creditOrFailTransaction(txn, status, extra) {
  const { data: fresh } = await supabase
    .from('transactions')
    .select('status')
    .eq('id', txn.id)
    .single();
  if (fresh.status === 'success' || fresh.status === 'failed') return; // idempotency guard

  await supabase
    .from('transactions')
    .update({
      status,
      mpesa_receipt: extra.receiptUrl || null,
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

// POST /api/payments/webhook — Paystack calls this on charge.success (and
// other events we ignore). Signature is HMAC-SHA512 of the raw body using
// your Paystack SECRET KEY — no separate webhook secret to register, unlike
// FXS Pay. Set this URL once in the Paystack dashboard under
// Settings → API Keys & Webhooks.
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const expected = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
      .digest('hex');

    if (!signature || signature !== expected) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    // Acknowledge immediately — Paystack times out and retries if we're slow
    res.status(200).json({ message: 'Received' });

    const { event, data } = req.body;
    if (event !== 'charge.success' || !data?.reference) return;

    const { data: txn } = await supabase
      .from('transactions')
      .select('*')
      .eq('fxs_reference', data.reference)
      .single();

    if (!txn) {
      console.error('[webhook] no matching transaction for reference', data.reference);
      return;
    }

    await creditOrFailTransaction(txn, 'success', { raw: data });
  } catch (err) {
    console.error('[webhook] error processing event:', err.message);
    // Response already sent above — nothing further to return here.
  }
});

module.exports = router;
