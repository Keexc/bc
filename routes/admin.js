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

// ---- Manually add votes (corrections, sponsor/bonus votes, etc.) ----
// Recorded as a KSh 0 transaction with status 'success' so it shows up in
// the audit trail (transactions table) rather than just silently appearing
// in the vote count.
router.post('/nominees/:id/votes', async (req, res) => {
  const { count, note } = req.body;
  const voteCount = parseInt(count, 10);

  if (!voteCount || voteCount < 1) {
    return res.status(400).json({ error: 'count must be a positive integer' });
  }

  const { data: nominee, error: nomErr } = await supabase
    .from('nominees')
    .select('id')
    .eq('id', req.params.id)
    .single();
  if (nomErr || !nominee) return res.status(404).json({ error: 'Nominee not found' });

  const { data: txn, error: txnErr } = await supabase
    .from('transactions')
    .insert({
      nominee_id: nominee.id,
      phone_number: `ADMIN:${req.admin.email}`,
      amount: 0,
      votes_requested: voteCount,
      status: 'success',
      result_desc: note || 'Manually added by admin'
    })
    .select()
    .single();
  if (txnErr) return res.status(500).json({ error: txnErr.message });

  const voteRows = Array.from({ length: voteCount }, () => ({
    nominee_id: nominee.id,
    transaction_id: txn.id
  }));
  const { error: voteErr } = await supabase.from('votes').insert(voteRows);
  if (voteErr) return res.status(500).json({ error: voteErr.message });

  res.json({ message: `${voteCount} vote(s) added`, transaction: txn });
});

// ---- Manually deduct votes (e.g. correcting votes wrongly credited
// without a real payment) ----
// Deletes actual rows from the votes table (that's what the public count is
// derived from) and logs a KSh 0 audit-trail transaction with a negative
// votes_requested so the correction is visible in the transactions log/export.
router.post('/nominees/:id/votes/deduct', async (req, res) => {
  const { count, note } = req.body;
  const voteCount = parseInt(count, 10);

  if (!voteCount || voteCount < 1) {
    return res.status(400).json({ error: 'count must be a positive integer' });
  }

  const { data: nominee, error: nomErr } = await supabase
    .from('nominees')
    .select('id')
    .eq('id', req.params.id)
    .single();
  if (nomErr || !nominee) return res.status(404).json({ error: 'Nominee not found' });

  // Pick the oldest votes for this nominee to remove first
  const { data: voteRows, error: fetchErr } = await supabase
    .from('votes')
    .select('id')
    .eq('nominee_id', nominee.id)
    .order('created_at', { ascending: true })
    .limit(voteCount);
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  if (!voteRows.length) {
    return res.status(400).json({ error: 'This nominee has no votes to deduct' });
  }

  const { error: delErr } = await supabase
    .from('votes')
    .delete()
    .in('id', voteRows.map(v => v.id));
  if (delErr) return res.status(500).json({ error: delErr.message });

  const { data: txn, error: txnErr } = await supabase
    .from('transactions')
    .insert({
      nominee_id: nominee.id,
      phone_number: `ADMIN:${req.admin.email}`,
      amount: 0,
      votes_requested: -voteRows.length,
      status: 'success',
      result_desc: note || 'Manually deducted by admin'
    })
    .select()
    .single();
  if (txnErr) return res.status(500).json({ error: txnErr.message });

  res.json({ message: `${voteRows.length} vote(s) deducted`, transaction: txn });
});

// ---- All nominees across every category, with vote counts, in one query
// (used by the admin dashboard instead of looping per-category) ----
router.get('/nominees-overview', async (req, res) => {
  const { data, error } = await supabase
    .from('nominees')
    .select('id, full_name, category_id, categories(name), votes(count)')
    .order('full_name');

  if (error) return res.status(500).json({ error: error.message });

  const result = data.map(n => ({
    id: n.id,
    full_name: n.full_name,
    category_id: n.category_id,
    categoryName: n.categories?.name || '—',
    vote_count: n.votes?.[0]?.count || 0
  }));

  res.json(result);
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
