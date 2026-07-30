// Run this once after deploying your backend, so FXS Pay knows where to
// send payment.success / payment.failed events.
//
// Usage: node register-webhook.js https://your-backend.onrender.com/api/payments/webhook
require('dotenv').config();
const axios = require('axios');

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.log('Usage: node register-webhook.js <your-webhook-url>');
    process.exit(1);
  }

  try {
    const { data } = await axios.post(
      `${process.env.FXS_BASE_URL}/api/webhook/endpoints`,
      { url },
      { headers: { Authorization: `Bearer ${process.env.FXS_API_KEY}` } }
    );

    console.log('Webhook registered:', data.endpoint.url);
    console.log('\nSAVE THIS SECRET — it is only shown once:');
    console.log(data.endpoint.secret);
    console.log('\nAdd it to your .env as FXS_WEBHOOK_SECRET, then redeploy.');
  } catch (err) {
    console.error('Failed to register webhook:', err.response?.data?.error || err.message);
    process.exit(1);
  }
}

main();
