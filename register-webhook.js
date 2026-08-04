// Paystack does NOT have an API to register a webhook URL the way FXS Pay
// did — there's no endpoint to call and no per-webhook secret to save.
// Instead:
//
//   1. Go to your Paystack Dashboard > Settings > API Keys & Webhooks.
//   2. Under "Webhook URL", paste:
//        https://your-backend.onrender.com/api/payments/webhook
//   3. Save. Note that TEST mode and LIVE mode each have their own webhook
//      URL field — set both if you test in test mode before going live.
//
// There's no separate webhook secret to store: Paystack signs every webhook
// with the same secret key you already use for API calls
// (PAYSTACK_SECRET_KEY in your .env), via HMAC-SHA512 over the raw request
// body, sent in the `x-paystack-signature` header. payments.js already
// verifies this.
//
// This script just does a quick sanity check that your PAYSTACK_SECRET_KEY
// is valid before you go set the webhook URL by hand.
//
// Usage: node register-webhook.js
require('dotenv').config();
const axios = require('axios');

async function main() {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    console.log('Set PAYSTACK_SECRET_KEY in your .env first.');
    process.exit(1);
  }

  try {
    await axios.get('https://api.paystack.co/transaction/totals', {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    console.log('PAYSTACK_SECRET_KEY is valid — Paystack API reachable.');
    console.log('\nNow go set your webhook URL by hand in the Paystack Dashboard:');
    console.log('Settings > API Keys & Webhooks > Webhook URL');
    console.log('  https://your-backend.onrender.com/api/payments/webhook');
    console.log('(set this for both Test and Live mode)');
  } catch (err) {
    console.error('Could not verify PAYSTACK_SECRET_KEY:', err.response?.data?.message || err.message);
    process.exit(1);
  }
}

main();
