const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');

const VOTE_PRICE = Number(process.env.VOTE_PRICE || 20);

const paystackClient = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  timeout: 30000
});

// Basic abuse protection on the payment-initiate endpoint
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

// Paystack has no bulk "list transactions" reconciliation step to worry
// about like FXS Pay did. We generate our OWN unique reference before ever
// calling Paystack and store it on the transaction immediately, so the
// reference is never ambiguous or missing — even if the /charge call times
// out or errors, we already know which reference to poll/verify against.
// GET /charge/:reference (below) always tells us the true status for that
// exact reference. There is no phone/amount matching, so there's no way to
// accidentally attach one voter's payment to a different voter's record.
function generateReference(txnId) {
  return `kea_${txnId}_${crypto.randomBytes(4).toString('hex')}`;
}

// Paystack requires an email on every /charge call even though it's not
// used for mobile money. We synthesize one from the phone number since
// voters don't provide an email anywhere in this flow.
function placeholderEmail(phone) {
  return `voter-${phone}@kea-awards.local`;
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

    const { data: nominee, error: nomErr } = await supabase
      .from('nominees')
      .select('id, full_name, is_active, category_id, categories!inner(is_active)')
      .eq('id', nomineeId)
      .single();

    if (nomErr || !nominee || !nominee.is_active || !nominee.categories.is_active) {
      return res.status(404).json({ error: 'Nominee not found or voting is closed for this category' });
    }

    const amount = voteCount * VOTE_PRICE;

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

    // Reference is generated and saved BEFORE calling Paystack, so we always
    // have a way to check status even if this next call times out or errors.
    const reference = generateReference(txn.id);
    await supabase
      .from('transactions')
      .update({ paystack_reference: reference })
      .eq('id', txn.id);

    try {
      const { data } = await paystackClient.post('/charge', {
        email: placeholderEmail(normalizedPhone),
        amount: String(amount * 100), // Paystack amount is in the smallest unit (cents) for KES
        currency: 'KES',
        reference,
        mobile_money: {
          phone: `+${normalizedPhone}`,
          provider: 'mpesa'
        }
      });

      const status = data.data?.status; // e.g. 'pay_offline', 'success', 'failed'

      if (status === 'success') {
        await creditOrFailTransaction(txn, 'success', { raw: data.data });
        return res.json({
          message: 'Payment confirmed. Thank you for voting!',
          transactionId: txn.id
        });
      }

      if (status === 'failed') {
        await supabase
          .from('transactions')
          .update({ status: 'failed', result_desc: data.data?.gateway_response || 'Payment failed' })
          .eq('id', txn.id);
        return res.status(502).json({ error: data.data?.gateway_response || 'Payment failed. Please try again.' });
      }

      // pay_offline / send_otp / pending, etc. — STK prompt is out on the
      // customer's phone. Leave status pending; /status polling and the
      // webhook will resolve it.
      return res.json({
        message: 'STK Push sent. Enter your M-Pesa PIN on your phone to complete payment.',
        transactionId: txn.id
      });
    } catch (pushErr) {
      // Network error, timeout, or 5xx from Paystack while placing the
      // charge — we genuinely don't know if the STK prompt went out.
      // Because we already saved our own reference, we don't need any
      // guesswork here: leave the transaction pending and let /status
      // (Check Pending Charge) and the webhook resolve it once Paystack
      // catches up.
      console.error('[initiate] /charge request errored, leaving pending for status polling/webhook:', pushErr.response?.data || pushErr.message);
      return res.json({
        message: 'STK Push sent. If you don\u2019t see a prompt within a minute, you can try again.',
        transactionId: txn.id
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error initiating payment' });
  }
});

// GET /api/payments/status/:transactionId — polled by the frontend.
// If we're still pending, ask Paystack directly for the status of our own
// reference via the Check Pending Charge endpoint.
router.get('/status/:transactionId', async (req, res) => {
  const { data: txn, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', req.params.transactionId)
    .single();

  if (error || !txn) return res.status(404).json({ error: 'Transaction not found' });

  if (txn.status !== 'pending') {
    return res.json({ status: txn.status, votes_requested: txn.votes_requested, mpesa_receipt: txn.mpesa_receipt });
  }

  if (txn.paystack_reference) {
    try {
      const { data } = await paystackClient.get(`/charge/${txn.paystack_reference}`);
      const providerStatus = data.data?.status;
      if (providerStatus === 'success' || providerStatus === 'failed') {
        await creditOrFailTransaction(txn, providerStatus, { raw: data.data, reason: data.data?.gateway_response });
        return res.json({ status: providerStatus, votes_requested: txn.votes_requested });
      }
    } catch (_) {
      // Ignore — the webhook is still the primary path; this is a fallback poll.
    }
  }

  res.json({ status: 'pending', votes_requested: txn.votes_requested });
});

// Shared logic for marking a transaction resolved and crediting votes,
// used by both the webhook and the status-poll fallback above.
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

// POST /api/payments/webhook — Paystack calls this when a payment resolves.
// Signature is HMAC-SHA512 of the raw request body, keyed with your
// Paystack SECRET key (not a separate webhook secret — Paystack has no
// registration step for webhooks; you set the URL by hand in
// Dashboard > Settings > API Keys & Webhooks, for both test and live mode).
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

    const { event, data } = req.body;
    const reference = data?.reference;
    if (!reference) return res.status(400).json({ error: 'Missing reference' });

    // We generated this reference ourselves at /initiate time and stored it
    // immediately, so this lookup is exact — no amount-based fallback
    // matching is needed (or safe to do), which removes the whole class of
    // "credited the wrong voter" bugs the FXS Pay integration had to guard
    // against.
    const { data: txn } = await supabase
      .from('transactions')
      .select('*')
      .eq('paystack_reference', reference)
      .single();

    if (!txn) {
      console.error('[webhook] no transaction found for reference', reference, '— needs manual review if this was a real payment');
      return res.status(200).json({ message: 'No matching transaction' });
    }

    if (event === 'charge.success') {
      await creditOrFailTransaction(txn, 'success', { receiptUrl: data.receipt_number, reason: data.gateway_response, raw: data });
    } else if (event === 'charge.failed') {
      await creditOrFailTransaction(txn, 'failed', { reason: data.gateway_response, raw: data });
    }
    // Other event types (e.g. transfer.*, refund.*) are ignored here.

    res.status(200).json({ message: 'Webhook processed' });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error processing webhook' });
  }
});

module.exports = router;
