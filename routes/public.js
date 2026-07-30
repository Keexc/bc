const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

// GET /api/categories — list active categories, grouped by section
router.get('/categories', async (req, res) => {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/categories/:id/nominees — nominees + live vote counts for a category
router.get('/categories/:id/nominees', async (req, res) => {
  const { id } = req.params;

  const { data: nominees, error: nomErr } = await supabase
    .from('nominees')
    .select('*')
    .eq('category_id', id)
    .eq('is_active', true);

  if (nomErr) return res.status(500).json({ error: nomErr.message });

  const { data: counts, error: countErr } = await supabase
    .from('public_vote_counts')
    .select('*')
    .eq('category_id', id);

  if (countErr) return res.status(500).json({ error: countErr.message });

  const countMap = Object.fromEntries(counts.map(c => [c.nominee_id, c.vote_count]));
  const withVotes = nominees
    .map(n => ({ ...n, vote_count: countMap[n.id] || 0 }))
    .sort((a, b) => b.vote_count - a.vote_count);

  res.json(withVotes);
});

// GET /api/results — public leaderboard across all categories
// (public by request — votes are visible to everyone, no admin login needed)
router.get('/results', async (req, res) => {
  const { data: categories, error: catErr } = await supabase
    .from('categories')
    .select('id, name, section')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (catErr) return res.status(500).json({ error: catErr.message });

  const { data: counts, error: countErr } = await supabase
    .from('public_vote_counts')
    .select('*');

  if (countErr) return res.status(500).json({ error: countErr.message });

  const results = categories.map(cat => {
    const nomineesInCat = counts
      .filter(c => c.category_id === cat.id)
      .sort((a, b) => b.vote_count - a.vote_count);
    const total = nomineesInCat.reduce((sum, n) => sum + Number(n.vote_count), 0);

    return {
      category: cat,
      total_votes: total,
      nominees: nomineesInCat.map(n => ({
        nominee_id: n.nominee_id,
        full_name: n.full_name,
        vote_count: Number(n.vote_count),
        percentage: total > 0 ? Math.round((n.vote_count / total) * 1000) / 10 : 0
      }))
    };
  });

  res.json(results);
});

module.exports = router;
