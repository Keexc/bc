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

// Looks up FXS Pay's own transaction list for a request matching this
// phone+amount that actually went through, so we can link our record to
// theirs even if our original request to them errored out. Used both right
// after a failed initiate call AND on every subsequent status poll, since a
// voter can take well over a minute to enter their PIN — a single lookup
// immediately after the error is usually too early to find anything yet.
async function reconcileMissedResponse(phone, amount) {
  try {
    const { data } = await fxsClient.get('/api/mpesa/transactions?limit=20');
    const list = data.transactions || data.data || data || [];

    const getPhone = t => t.phone || t.customerPhone || t.customer_phone || t.msisdn || t.phoneNumber || t.mpesaNumber || '';
    const getCreated = t => t.created_at || t.createdAt || t.timestamp || t.date;
    const last9 = phone.slice(-9);

    const withinWindow = t => {
      const created = getCreated(t);
      return created ? (Date.now() - new Date(created).getTime()) < 15 * 60 * 1000 : true;
    };

    // Phone match is mandatory. Matching by amount alone is NOT safe here —
    // with many voters paying the same standard amount (e.g. KSh 20), an
    // amount-only match can attach this voter's pending record to a
    // DIFFERENT voter's already-completed transaction, crediting votes to
    // someone who never paid. A wrong "no match" is fine (falls back to
    // pending/manual review); a wrong match is not.
    const exact = list.find(t =>
      Number(t.amount) === Number(amount) &&
      String(getPhone(t)).includes(last9) &&
      withinWindow(t)
    );

    if (!exact) {
      console.error('[reconcile] no phone match found, raw FXS transactions sample:', JSON.stringify(list.slice(0, 3)));
    }

    return exact || null;
  } catch (err) {
    console.error('[reconcile] lookup itself failed:', err.response?.data || err.message);
    return null;
  }
}

// Fires the STK push and updates the transaction row with whatever happens,
// but does NOT block the /initiate response — see comment below for why.
async function sendStkPushInBackground(txn, nominee, normalizedPhone, amount) {
  try {
    // Initiating a push should be a quick API call (it just triggers the
    // prompt — it does not wait for the customer to enter their PIN), so
    // it gets its own short timeout instead of reusing the 30s client
    // default meant for slower lookups like /status and /transactions.
    const { data } = await fxsClient.post('/api/mpesa/stk-push', {
      phone: normalizedPhone,
      amount,
      description: `${txn.votes_requested} vote(s) for ${nominee.full_name}`
    }, { timeout: 10000 });

    await supabase
      .from('transactions')
      .update({ fxs_reference: data.transactionId })
      .eq('id', txn.id);

  } catch (pushErr) {
    // FXS Pay gave us an actual error response (bad request, auth issue,
    // etc.) — this is a genuine failure, not just slowness.
    if (pushErr.response && pushErr.response.status < 500) {
      await supabase
        .from('transactions')
        .update({ status: 'failed', result_desc: pushErr.response.data?.error || 'Payment request rejected' })
        .eq('id', txn.id);
      return;
    }

    // Timeout, network blip, or a 5xx from FXS Pay — we genuinely don't
    // know if the prompt went out. Try an immediate reconciliation check,
    // but either way DON'T declare failure: a voter can take well over a
    // minute to enter their PIN, and the /status polling (plus this same
    // reconciliation check running again on every poll) has plenty more
    // chances to catch up. Wrongly failing here is worse than a slightly
    // optimistic "pending" — it's what was silently losing paid votes.
    const match = await reconcileMissedResponse(normalizedPhone, amount);
    if (match) {
      await supabase
        .from('transactions')
        .update({ fxs_reference: match.id || match.transactionId })
        .eq('id', txn.id);
    } else {
      console.error('[initiate] stk-push errored with no immediate match, leaving pending for status polling:', pushErr.message);
    }
  }
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

    // Respond as soon as the transaction is recorded — don't make the
    // voter's spinner wait on FXS Pay's round-trip. The frontend starts
    // polling /status right after this, which will pick up the
    // fxs_reference (and eventual success/failure) once the background
    // push below resolves.
    res.json({
      message: 'STK Push sent. Enter your M-Pesa PIN on your phone to complete payment.',
      transactionId: txn.id
    });

    sendStkPushInBackground(txn, nominee, normalizedPhone, amount);
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error initiating payment' });
  }
});

// GET /api/payments/status/:transactionId — polled by the frontend.
// If we're still pending, this actively tries to catch up: first attempting
// to link an unmatched transaction (if the initiate call never got a
// fxs_reference), then checking FXS Pay's status for whatever reference we
// do have.
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

  let fxsRef = txn.fxs_reference;

  if (!fxsRef) {
    const match = await reconcileMissedResponse(txn.phone_number, txn.amount);
    if (match) {
      fxsRef = match.id || match.transactionId;
      await supabase.from('transactions').update({ fxs_reference: fxsRef }).eq('id', txn.id);
    }
  }

  if (fxsRef) {
    try {
      const { data } = await fxsClient.get(`/api/mpesa/status/${fxsRef}`);
      const providerStatus = data.transaction?.status;
      if (providerStatus === 'success' || providerStatus === 'failed') {
        await creditOrFailTransaction({ ...txn, fxs_reference: fxsRef }, providerStatus, {});
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

// POST /api/payments/webhook — FXS Pay calls this when a payment resolves.
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

    const { transactionId, amount, receiptUrl, reason } = req.body;
    if (!transactionId) return res.status(400).json({ error: 'Missing transactionId' });

    let { data: txn } = await supabase
      .from('transactions')
      .select('*')
      .eq('fxs_reference', transactionId)
      .single();

    // If we don't have an exact fxs_reference match, we do NOT guess by
    // amount alone here — FXS Pay's webhook payload has no phone number to
    // narrow it down, and with several voters paying the same amount
    // (e.g. KSh 20) an amount-only match can credit votes to a different
    // voter than the one who actually paid. Better to leave it unresolved
    // (log it for manual review via the admin "Add votes" action) than to
    // silently credit the wrong person.
    if (!txn) {
      console.error('[webhook] no fxs_reference match for transactionId', transactionId, '— amount:', amount, '— needs manual review if this was a real payment');
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
