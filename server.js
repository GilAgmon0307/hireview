const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hireview2024';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'stats.json');

// ---------------------------------------------------------------------------
// Stats store (sync file I/O — safe for single-process low-traffic landing)
// ---------------------------------------------------------------------------

function readStats() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { visits: 0, ctaClicks: 0, joinClicks: 0, detailClicks: 0 };
  }
}

function writeStats(stats) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(stats, null, 2));
}

// Ensure data directory and file exist on startup
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  writeStats({ visits: 0, ctaClicks: 0, joinClicks: 0, detailClicks: 0 });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.post('/api/visit', (req, res) => {
  const stats = readStats();
  stats.visits += 1;
  writeStats(stats);
  res.json({ visits: stats.visits });
});

app.post('/api/cta-click', (req, res) => {
  const { button } = req.body || {};
  const stats = readStats();
  stats.ctaClicks += 1;
  if (button === 'join') stats.joinClicks = (stats.joinClicks || 0) + 1;
  if (button === 'details') stats.detailClicks = (stats.detailClicks || 0) + 1;
  writeStats(stats);
  res.json({ ctaClicks: stats.ctaClicks });
});

app.get('/api/stats', (req, res) => {
  res.json(readStats());
});

// ---------------------------------------------------------------------------
// Admin dashboard (HTTP Basic Auth)
// ---------------------------------------------------------------------------

app.get('/admin', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="HireView Admin"');
    return res.status(401).send('Unauthorized');
  }
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
  const [user, pass] = decoded.split(':');
  if (user !== 'admin' || pass !== ADMIN_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="HireView Admin"');
    return res.status(401).send('Unauthorized');
  }

  const stats = readStats();
  const convRate = stats.visits > 0
    ? ((stats.ctaClicks / stats.visits) * 100).toFixed(1)
    : '0.0';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HireView Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a1a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px;
      padding: 2.5rem;
      min-width: 420px;
      backdrop-filter: blur(10px);
    }
    h1 { font-size: 1.5rem; color: #a78bfa; margin-bottom: 0.25rem; }
    .subtitle { color: #64748b; font-size: 0.85rem; margin-bottom: 2rem; }
    .stat {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .stat:last-of-type { border-bottom: none; }
    .stat-label { color: #94a3b8; font-size: 0.9rem; }
    .stat-value { font-size: 2rem; font-weight: 700; color: #34d399; }
    .stat-value.purple { color: #a78bfa; }
    .stat-value.blue { color: #60a5fa; }
    .sub-stats { display: flex; gap: 1rem; margin-top: 0.25rem; }
    .sub-stat { font-size: 0.75rem; color: #64748b; }
    .timestamp { margin-top: 1.5rem; color: #475569; font-size: 0.75rem; text-align: right; }
    .refresh { margin-top: 1.5rem; text-align: center; }
    .refresh a {
      color: #a78bfa;
      text-decoration: none;
      font-size: 0.85rem;
      border: 1px solid rgba(167,139,250,0.3);
      padding: 0.4rem 1rem;
      border-radius: 8px;
      transition: background 0.2s;
    }
    .refresh a:hover { background: rgba(167,139,250,0.1); }
  </style>
</head>
<body>
  <div class="card">
    <h1>HireView Analytics</h1>
    <p class="subtitle">Live dashboard &mdash; refreshed on load</p>

    <div class="stat">
      <div>
        <div class="stat-label">Total Page Visits</div>
      </div>
      <div class="stat-value">${stats.visits}</div>
    </div>

    <div class="stat">
      <div>
        <div class="stat-label">CTA Button Clicks</div>
        <div class="sub-stats">
          <span class="sub-stat">Join Now: ${stats.joinClicks || 0}</span>
          <span class="sub-stat">Hear Details: ${stats.detailClicks || 0}</span>
        </div>
      </div>
      <div class="stat-value purple">${stats.ctaClicks}</div>
    </div>

    <div class="stat">
      <div>
        <div class="stat-label">Conversion Rate</div>
        <div class="sub-stats"><span class="sub-stat">clicks / visits</span></div>
      </div>
      <div class="stat-value blue">${convRate}%</div>
    </div>

    <p class="timestamp">Last checked: ${new Date().toLocaleString('en-IL')}</p>
    <div class="refresh"><a href="/admin">Refresh Stats</a></div>
  </div>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`HireView landing running on http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin  (user: admin)`);
});
