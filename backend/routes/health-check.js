const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { checkUrl } = require('../utils/link-checker');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

function getLinksWithMeta(db, userId) {
  const links = db.prepare(`
    SELECT l.*, c.name as category_name, c.color as category_color
    FROM links l
    LEFT JOIN categories c ON l.category_id = c.id
    WHERE l.user_id = ?
    ORDER BY l.created_at DESC
  `).all(userId);

  const getTagsStmt = db.prepare('SELECT tag FROM link_tags WHERE link_id = ?');
  return links.map((link) => ({
    ...link,
    tags: getTagsStmt.all(link.id).map((t) => t.tag),
  }));
}

function getStatusCounts(db, userId) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM links
    WHERE user_id = ?
    GROUP BY status
  `).all(userId);

  const counts = { total: 0, alive: 0, dead: 0, failed: 0, unchecked: 0 };
  rows.forEach((row) => {
    counts[row.status] = row.count;
    counts.total += row.count;
  });
  return counts;
}

// GET /api/health-check/status - Summary counts plus every link's check state.
// Used to restore the page (conclusion + counts) exactly as it was left.
router.get('/status', (req, res) => {
  const userId = req.userId;
  const db = getDb();

  res.json({
    counts: getStatusCounts(db, userId),
    links: getLinksWithMeta(db, userId),
  });
});

// POST /api/health-check/all - Check all links for the user (bulk fallback).
// The frontend normally drives a per-link loop so it can show progress and be
// interrupted; this endpoint remains for completeness.
// NOTE: must be registered before '/:id' so it isn't captured as an id.
router.post('/all', async (req, res) => {
  const userId = req.userId;
  const db = getDb();

  const links = db.prepare('SELECT id, url FROM links WHERE user_id = ?').all(userId);

  if (links.length === 0) {
    return res.json({ message: 'No links to check', results: [] });
  }

  const results = [];
  const updateStmt = db.prepare(`
    UPDATE links
    SET status = ?, http_status = ?, check_error = ?, last_checked = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  // Process links sequentially to avoid overwhelming servers
  for (const link of links) {
    const result = await checkUrl(link.url);
    updateStmt.run(result.outcome, result.status, result.error, link.id);

    results.push({
      id: link.id,
      url: link.url,
      status: result.outcome,
      http_status: result.status,
      error: result.error,
    });
  }

  res.json({
    message: `Checked ${results.length} links`,
    total: results.length,
    alive: results.filter((r) => r.status === 'alive').length,
    dead: results.filter((r) => r.status === 'dead').length,
    failed: results.filter((r) => r.status === 'failed').length,
    counts: getStatusCounts(db, userId),
    results,
  });
});

// POST /api/health-check/:id - Check a single link.
// A timeout / refused connection only fails this one link ('failed') and can be
// retried independently; confirmed HTTP errors are recorded as 'dead'.
router.post('/:id', async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  const db = getDb();

  const link = db.prepare('SELECT * FROM links WHERE id = ? AND user_id = ?').get(id, userId);
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }

  const result = await checkUrl(link.url);

  db.prepare(`
    UPDATE links
    SET status = ?, http_status = ?, check_error = ?, last_checked = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(result.outcome, result.status, result.error, link.id);

  res.json({
    id: link.id,
    url: link.url,
    status: result.outcome,
    http_status: result.status,
    error: result.error,
  });
});

// GET /api/health-check/dead - Get confirmed dead links
router.get('/dead', (req, res) => {
  const userId = req.userId;
  const db = getDb();

  const deadLinks = db.prepare(`
    SELECT l.*, c.name as category_name, c.color as category_color
    FROM links l
    LEFT JOIN categories c ON l.category_id = c.id
    WHERE l.user_id = ? AND l.status = 'dead'
    ORDER BY l.last_checked DESC
  `).all(userId);

  const getTagsStmt = db.prepare('SELECT tag FROM link_tags WHERE link_id = ?');
  const linksWithTags = deadLinks.map((link) => ({
    ...link,
    tags: getTagsStmt.all(link.id).map((t) => t.tag),
  }));

  res.json(linksWithTags);
});

module.exports = router;
