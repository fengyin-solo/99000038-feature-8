const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { checkUrl } = require('../utils/link-checker');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// GET /api/health-check/targets - List all links to be checked
router.get('/targets', (req, res) => {
  const userId = req.userId;
  const db = getDb();

  const links = db.prepare('SELECT id, url, title FROM links WHERE user_id = ? ORDER BY id').all(userId);

  res.json(links);
});

// GET /api/health-check/summary - Status counts derived from the database
router.get('/summary', (req, res) => {
  const userId = req.userId;
  const db = getDb();

  const rows = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM links
    WHERE user_id = ?
    GROUP BY status
  `).all(userId);

  const summary = { total: 0, alive: 0, dead: 0, unchecked: 0 };
  rows.forEach((row) => {
    summary[row.status] = row.count;
    summary.total += row.count;
  });

  res.json(summary);
});

// POST /api/health-check/link/:id - Check a single link
router.post('/link/:id', async (req, res) => {
  const userId = req.userId;
  const db = getDb();

  const link = db.prepare('SELECT id, url FROM links WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }

  const result = await checkUrl(link.url);
  const status = result.alive ? 'alive' : 'dead';

  db.prepare('UPDATE links SET status = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?').run(status, link.id);

  res.json({
    id: link.id,
    url: link.url,
    status,
    http_status: result.status,
    error: result.error,
  });
});

// GET /api/health-check/dead - Get dead links
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

  // Get tags for each link
  const getTagsStmt = db.prepare('SELECT tag FROM link_tags WHERE link_id = ?');
  const linksWithTags = deadLinks.map((link) => ({
    ...link,
    tags: getTagsStmt.all(link.id).map((t) => t.tag),
  }));

  res.json(linksWithTags);
});

module.exports = router;
