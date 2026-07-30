const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabaseClient');
const { requireAdmin } = require('../middleware/auth');

// POST /api/admin/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const { data: admin, error } = await supabase
    .from('admins')
    .select('*')
    .eq('email', email.toLowerCase())
    .single();

  if (error || !admin) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { adminId: admin.id, email: admin.email },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({ token, admin: { id: admin.id, email: admin.email, full_name: admin.full_name } });
});

// All routes below require a valid admin token
router.use(requireAdmin);

// ---- Categories ----
router.post('/categories', async (req, res) => {
  const { name, section, description, display_order } = req.body;
  const { data, error } = await supabase
    .from('categories')
    .insert({ name, section, description, display_order })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/categories/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('categories')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/categories/:id', async (req, res) => {
  const { error } = await supabase.from('categories').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Category deleted' });
});

// ---- Nominees ----
router.post('/nominees', async (req, res) => {
  const { category_id, full_name, organization, county, bio, photo_url, social_links } = req.body;
  const { data, error } = await supabase
    .from('nominees')
    .insert({ category_id, full_name, organization, county, bio, photo_url, social_links })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/nominees/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('nominees')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/nominees/:id', async (req, res) => {
  const { error } = await supabase.from('nominees').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Nominee deleted' });
});

// ---- Analytics ----
router.get('/analytics', async (req, res) => {
  const { data: transactions, error: txnErr } = await supabase
    .from('transactions')
    .select('status, amount, votes_requested, created_at');
  if (txnErr) return res.status(500).json({ error: txnErr.message });

  const successful = transactions.filter(t => t.status === 'success');
  const today = new Date().toISOString().slice(0, 10);

  const totalVotes = successful.reduce((sum, t) => sum + t.votes_requested, 0);
  const votesToday = successful
    .filter(t => t.created_at.slice(0, 10) === today)
    .reduce((sum, t) => sum + t.votes_requested, 0);
  const revenue = successful.reduce((sum, t) => sum + Number(t.amount), 0);
  const successRate = transactions.length
    ? Math.round((successful.length / transactions.length) * 1000) / 10
    : 0;

  const { data: votesByNominee } = await supabase
    .from('public_vote_counts')
    .select('*')
    .order('vote_count', { ascending: false })
    .limit(1);

  res.json({
    total_votes: totalVotes,
    votes_today: votesToday,
    revenue_collected: revenue,
    payment_success_rate_pct: successRate,
    most_voted_nominee: votesByNominee?.[0] || null
  });
});

// ---- Transactions (for admin search / export) ----
router.get('/transactions', async (req, res) => {
  const { status, nomineeId } = req.query;
  let query = supabase.from('transactions').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  if (nomineeId) query = query.eq('nominee_id', nomineeId);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/admin/export/csv — simple CSV export of successful votes
// (kept as CSV so it opens cleanly in Excel/Sheets without extra libraries;
// swap in a library like exceljs if you need native .xlsx formatting)
router.get('/export/csv', async (req, res) => {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, nominee_id, votes_requested, amount, status, mpesa_receipt, created_at')
    .eq('status', 'success')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const header = 'transaction_id,nominee_id,votes,amount,status,mpesa_receipt,created_at\n';
  const rows = data
    .map(t => [t.id, t.nominee_id, t.votes_requested, t.amount, t.status, t.mpesa_receipt || '', t.created_at].join(','))
    .join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="kea-votes-export.csv"');
  res.send(header + rows);
});

// ---- Open/close voting on a category ----
router.patch('/categories/:id/toggle-voting', async (req, res) => {
  const { is_active } = req.body;
  const { data, error } = await supabase
    .from('categories')
    .update({ is_active })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
