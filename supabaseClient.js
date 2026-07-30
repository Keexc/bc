const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[supabaseClient] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
}

// Service role key is used because vote-crediting and admin actions run
// server-side only. Never ship this key to the frontend.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = supabase;
