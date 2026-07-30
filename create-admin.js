// One-off script to create your first admin login.
// Usage: node create-admin.js you@example.com yourPassword "Full Name"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const supabase = require('./supabaseClient');

async function main() {
  const [, , email, password, fullName] = process.argv;
  if (!email || !password) {
    console.log('Usage: node create-admin.js <email> <password> [full name]');
    process.exit(1);
  }

  const password_hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase
    .from('admins')
    .insert({ email: email.toLowerCase(), password_hash, full_name: fullName || null })
    .select()
    .single();

  if (error) {
    console.error('Failed to create admin:', error.message);
    process.exit(1);
  }
  console.log('Admin created:', data.email);
}

main();
