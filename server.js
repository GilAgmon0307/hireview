const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hireview2024';
const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const LOG_FILE = path.join(DATA_DIR, 'events.log');

// ---------------------------------------------------------------------------
// Data store (sync file I/O — safe for single-process low-traffic site)
// ---------------------------------------------------------------------------

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function appendLog(entry) {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
  fs.appendFileSync(LOG_FILE, line);
}

const defaultStats = {
  visits: 0,
  ctaClicks: 0,
  contactFormSubmissions: 0,
  clicksByButton: {},
};

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STATS_FILE)) writeJSON(STATS_FILE, defaultStats);
if (!fs.existsSync(CONTACTS_FILE)) writeJSON(CONTACTS_FILE, []);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// API: Visit tracking
// ---------------------------------------------------------------------------

app.post('/api/visit', (req, res) => {
  const stats = readJSON(STATS_FILE, defaultStats);
  stats.visits += 1;
  writeJSON(STATS_FILE, stats);
  appendLog({ event: 'page_visit', ip: req.ip, ua: req.headers['user-agent'] });
  res.json({ visits: stats.visits });
});

// ---------------------------------------------------------------------------
// API: Button click tracking (any button, with label)
// ---------------------------------------------------------------------------

app.post('/api/click', (req, res) => {
  const { button, section } = req.body || {};
  const stats = readJSON(STATS_FILE, defaultStats);
  stats.ctaClicks = (stats.ctaClicks || 0) + 1;
  if (!stats.clicksByButton) stats.clicksByButton = {};
  if (button) {
    stats.clicksByButton[button] = (stats.clicksByButton[button] || 0) + 1;
  }
  writeJSON(STATS_FILE, stats);
  appendLog({ event: 'button_click', button, section, ip: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API: Contact form submission
// ---------------------------------------------------------------------------

app.post('/api/contact', (req, res) => {
  const { name, email, company, role, teamSize, message, source } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const contact = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name || '',
    email,
    company: company || '',
    role: role || '',
    teamSize: teamSize || '',
    message: message || '',
    source: source || 'contact_form',
    submittedAt: new Date().toISOString(),
    ip: req.ip,
  };

  const contacts = readJSON(CONTACTS_FILE, []);
  contacts.push(contact);
  writeJSON(CONTACTS_FILE, contacts);

  const stats = readJSON(STATS_FILE, defaultStats);
  stats.contactFormSubmissions += 1;
  writeJSON(STATS_FILE, stats);

  appendLog({ event: 'contact_submission', email, source, name, company });
  res.json({ ok: true, id: contact.id });
});

// ---------------------------------------------------------------------------
// Admin dashboard
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

  const stats = readJSON(STATS_FILE, defaultStats);
  const contacts = readJSON(CONTACTS_FILE, []);
  const convRate = stats.visits > 0
    ? ((stats.contactFormSubmissions / stats.visits) * 100).toFixed(1)
    : '0.0';
  const clickConvRate = stats.visits > 0
    ? ((stats.ctaClicks / stats.visits) * 100).toFixed(1)
    : '0.0';

  const clickRows = Object.entries(stats.clicksByButton || {})
    .sort((a, b) => b[1] - a[1])
    .map(([btn, count]) => `<tr><td style="padding:0.5rem 1rem;color:#94a3b8">${btn}</td><td style="padding:0.5rem 1rem;text-align:right;color:#a78bfa;font-weight:600">${count}</td></tr>`)
    .join('');

  const contactRows = contacts.slice(-20).reverse()
    .map(c => `<tr>
      <td style="padding:0.4rem 0.8rem;color:#e2e8f0;font-size:0.8rem">${c.name || '-'}</td>
      <td style="padding:0.4rem 0.8rem;color:#3b82f6;font-size:0.8rem">${c.email}</td>
      <td style="padding:0.4rem 0.8rem;color:#94a3b8;font-size:0.8rem">${c.company || '-'}</td>
      <td style="padding:0.4rem 0.8rem;color:#94a3b8;font-size:0.8rem">${c.role || '-'}</td>
      <td style="padding:0.4rem 0.8rem;color:#64748b;font-size:0.8rem">${c.source}</td>
      <td style="padding:0.4rem 0.8rem;color:#64748b;font-size:0.75rem">${new Date(c.submittedAt).toLocaleString('en-IL')}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>HireView Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0a0a1a;color:#e2e8f0;min-height:100vh;padding:2rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:2rem}
.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:1.5rem}
.card h3{color:#94a3b8;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem}
.card .val{font-size:2rem;font-weight:700}
.val.blue{color:#3b82f6}.val.green{color:#10b981}.val.purple{color:#a78bfa}.val.orange{color:#f97316}
h1{color:#3b82f6;font-size:1.5rem;margin-bottom:0.25rem}
.sub{color:#64748b;font-size:0.85rem;margin-bottom:1.5rem}
h2{color:#e2e8f0;font-size:1.1rem;margin:1.5rem 0 0.75rem}
table{width:100%;border-collapse:collapse;background:rgba(255,255,255,0.03);border-radius:12px;overflow:hidden}
th{text-align:left;padding:0.5rem 1rem;color:#64748b;font-size:0.75rem;text-transform:uppercase;border-bottom:1px solid rgba(255,255,255,0.08)}
tr:hover{background:rgba(255,255,255,0.03)}
.actions{margin-top:2rem;display:flex;gap:1rem;justify-content:center}
.actions a{color:#3b82f6;text-decoration:none;font-size:0.85rem;border:1px solid rgba(59,130,246,0.3);padding:0.4rem 1rem;border-radius:8px}
.actions a:hover{background:rgba(59,130,246,0.1)}
.ts{color:#475569;font-size:0.75rem;text-align:right;margin-top:1rem}
</style></head><body>
<h1>HireView Analytics</h1>
<p class="sub">Live dashboard</p>

<div class="grid">
  <div class="card"><h3>Page Visits</h3><div class="val blue">${stats.visits}</div></div>
  <div class="card"><h3>CTA Clicks</h3><div class="val purple">${stats.ctaClicks}</div></div>
  <div class="card"><h3>Contact Submissions</h3><div class="val green">${stats.contactFormSubmissions}</div></div>
  <div class="card"><h3>Click Rate</h3><div class="val orange">${clickConvRate}%</div></div>
  <div class="card"><h3>Contact Rate</h3><div class="val green">${convRate}%</div></div>
</div>

${clickRows ? `<h2>Clicks by Button</h2><table><thead><tr><th>Button</th><th style="text-align:right">Clicks</th></tr></thead><tbody>${clickRows}</tbody></table>` : ''}

${contactRows ? `<h2>Recent Contacts (last 20)</h2><table><thead><tr><th>Name</th><th>Email</th><th>Company</th><th>Role</th><th>Source</th><th>Date</th></tr></thead><tbody>${contactRows}</tbody></table>` : '<h2>No contacts yet</h2>'}

<p class="ts">Last checked: ${new Date().toLocaleString('en-IL')}</p>
<div class="actions"><a href="/admin">Refresh</a><a href="/admin/contacts.csv">Export CSV</a></div>
</body></html>`);
});

// ---------------------------------------------------------------------------
// Export contacts as CSV
// ---------------------------------------------------------------------------

app.get('/admin/contacts.csv', (req, res) => {
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

  const contacts = readJSON(CONTACTS_FILE, []);
  const header = 'Name,Email,Company,Role,Team Size,Message,Source,Submitted At\n';
  const rows = contacts.map(c =>
    [c.name, c.email, c.company, c.role, c.teamSize, `"${(c.message || '').replace(/"/g, '""')}"`, c.source, c.submittedAt].join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=hireview-contacts.csv');
  res.send(header + rows);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`HireView running on http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin  (user: admin)`);
});
