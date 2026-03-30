require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hireview2024';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'GilAgmon3@gmail.com';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const VISITS_FILE = path.join(DATA_DIR, 'visits.json');
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
if (!fs.existsSync(VISITS_FILE)) writeJSON(VISITS_FILE, []);

// ---------------------------------------------------------------------------
// Email transporter (Gmail SMTP — requires App Password)
// ---------------------------------------------------------------------------

let transporter = null;
if (SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  transporter.verify()
    .then(() => console.log('Email notifications enabled'))
    .catch((err) => { console.warn('Email setup failed (notifications disabled):', err.message); transporter = null; });
} else {
  console.log('Email notifications disabled — set SMTP_USER and SMTP_PASS env vars to enable');
}

async function notifyNewSignup(email, message) {
  if (!transporter) return;
  try {
    const msgLine = message ? `\nMessage: ${message}` : '';
    const msgHtml = message ? `<div style="margin:12px 0 0;padding:12px;background:#e8f0fe;border-left:4px solid #3b82f6;border-radius:4px"><p style="margin:0 0 4px;font-size:12px;color:#64748b;font-weight:600">MESSAGE</p><p style="margin:0;font-size:15px;color:#1e293b">${message}</p></div>` : '';
    await transporter.sendMail({
      from: `"HireView Alerts" <${SMTP_USER}>`,
      to: NOTIFY_EMAIL,
      subject: `New early access signup: ${email}`,
      text: `Someone just signed up for early access!\n\nEmail: ${email}${msgLine}\nTime: ${new Date().toISOString()}\n\nView all signups at your admin dashboard.`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#3b82f6;margin-bottom:8px">New Early Access Signup</h2>
          <p style="color:#333;font-size:15px">Someone just signed up on HireView!</p>
          <div style="background:#f1f5f9;border-radius:8px;padding:16px;margin:16px 0">
            <p style="margin:0;font-size:15px"><strong>Email:</strong> ${email}</p>
            ${msgHtml}
            <p style="margin:8px 0 0;font-size:13px;color:#64748b"><strong>Time:</strong> ${new Date().toLocaleString('en-IL')}</p>
          </div>
          <p style="color:#64748b;font-size:13px">View all signups in your <a href="#" style="color:#3b82f6">admin dashboard</a>.</p>
        </div>`,
    });
  } catch (err) {
    console.error('Failed to send notification email:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// API: Visit tracking (returns visit ID for duration tracking)
// ---------------------------------------------------------------------------

app.post('/api/visit', (req, res) => {
  const stats = readJSON(STATS_FILE, defaultStats);
  stats.visits += 1;
  writeJSON(STATS_FILE, stats);

  const visit = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ip: req.ip,
    ua: req.headers['user-agent'] || '',
    startedAt: new Date().toISOString(),
    durationSeconds: null,
  };
  const visits = readJSON(VISITS_FILE, []);
  visits.push(visit);
  writeJSON(VISITS_FILE, visits);

  appendLog({ event: 'page_visit', id: visit.id, ip: req.ip, ua: visit.ua });
  res.json({ id: visit.id, visits: stats.visits });
});

// ---------------------------------------------------------------------------
// API: Visit end (update duration)
// ---------------------------------------------------------------------------

app.post('/api/visit-end', (req, res) => {
  const { id, duration } = req.body || {};
  if (!id || typeof duration !== 'number') return res.status(400).json({ error: 'id and duration required' });

  const visits = readJSON(VISITS_FILE, []);
  const visit = visits.find(v => v.id === id);
  if (visit) {
    visit.durationSeconds = Math.min(duration, 3600); // cap at 1 hour
    writeJSON(VISITS_FILE, visits);
  }
  res.json({ ok: true });
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
// API: Contact form submission (+ email notification)
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

  // Send email notification (async, don't block response)
  notifyNewSignup(email, message);

  res.json({ ok: true, id: contact.id });
});

// ---------------------------------------------------------------------------
// Admin: Auth middleware
// ---------------------------------------------------------------------------

function requireAdmin(req, res, next) {
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
  next();
}

// ---------------------------------------------------------------------------
// Admin: Reset all stats
// ---------------------------------------------------------------------------

app.post('/admin/reset', requireAdmin, (req, res) => {
  writeJSON(STATS_FILE, { ...defaultStats });
  writeJSON(VISITS_FILE, []);
  writeJSON(CONTACTS_FILE, []);
  appendLog({ event: 'admin_reset_all', ip: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin: Delete a single signup
// ---------------------------------------------------------------------------

app.delete('/admin/contact/:id', requireAdmin, (req, res) => {
  const contacts = readJSON(CONTACTS_FILE, []);
  const idx = contacts.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  contacts.splice(idx, 1);
  writeJSON(CONTACTS_FILE, contacts);

  const stats = readJSON(STATS_FILE, defaultStats);
  stats.contactFormSubmissions = contacts.length;
  writeJSON(STATS_FILE, stats);

  appendLog({ event: 'admin_delete_contact', id: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin: Delete a single visit
// ---------------------------------------------------------------------------

app.delete('/admin/visit/:id', requireAdmin, (req, res) => {
  const visits = readJSON(VISITS_FILE, []);
  const idx = visits.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  visits.splice(idx, 1);
  writeJSON(VISITS_FILE, visits);

  const stats = readJSON(STATS_FILE, defaultStats);
  stats.visits = Math.max(0, stats.visits - 1);
  writeJSON(STATS_FILE, stats);

  appendLog({ event: 'admin_delete_visit', id: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin dashboard
// ---------------------------------------------------------------------------

app.get('/admin', requireAdmin, (req, res) => {
  const stats = readJSON(STATS_FILE, defaultStats);
  const contacts = readJSON(CONTACTS_FILE, []);
  const visits = readJSON(VISITS_FILE, []);

  const totalVisits = stats.visits;
  const ctaClicks = stats.ctaClicks || 0;
  const totalSignups = contacts.length;
  const ctaRate = totalVisits > 0 ? ((ctaClicks / totalVisits) * 100).toFixed(1) : '0.0';
  const signupRate = totalVisits > 0 ? ((totalSignups / totalVisits) * 100).toFixed(1) : '0.0';

  // Average time on page
  const visitsWithDuration = visits.filter(v => v.durationSeconds !== null);
  const avgDuration = visitsWithDuration.length > 0
    ? Math.round(visitsWithDuration.reduce((sum, v) => sum + v.durationSeconds, 0) / visitsWithDuration.length)
    : 0;

  function fmtDuration(s) {
    if (s === null || s === undefined) return '-';
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  // Click breakdown
  const clickRows = Object.entries(stats.clicksByButton || {})
    .sort((a, b) => b[1] - a[1])
    .map(([btn, count]) => `<tr><td style="padding:0.5rem 1rem;color:#94a3b8">${btn}</td><td style="padding:0.5rem 1rem;text-align:right;color:#a78bfa;font-weight:600">${count}</td></tr>`)
    .join('');

  // Recent visits (last 50)
  const visitRows = visits.slice(-50).reverse()
    .map(v => {
      const shortUA = (v.ua || '').slice(0, 60) + ((v.ua || '').length > 60 ? '...' : '');
      return `<tr>
        <td style="padding:0.4rem 0.8rem;color:#64748b;font-size:0.8rem">${new Date(v.startedAt).toLocaleString('en-IL')}</td>
        <td style="padding:0.4rem 0.8rem;text-align:center;font-size:0.85rem;font-weight:600;color:${v.durationSeconds !== null ? '#3b82f6' : '#475569'}">${fmtDuration(v.durationSeconds)}</td>
        <td style="padding:0.4rem 0.8rem;color:#64748b;font-size:0.75rem">${v.ip || '-'}</td>
        <td style="padding:0.4rem 0.8rem;color:#475569;font-size:0.7rem;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${shortUA}</td>
        <td style="padding:0.4rem 0.8rem;text-align:center"><button class="del-btn" onclick="deleteItem('visit','${v.id}')" title="Delete">x</button></td>
      </tr>`;
    }).join('');

  // Contacts table (all, newest first)
  const contactRows = contacts.slice().reverse()
    .map(c => {
      const msgPreview = (c.message || '').slice(0, 80) + ((c.message || '').length > 80 ? '...' : '');
      return `<tr>
      <td style="padding:0.5rem 0.8rem;color:#3b82f6;font-weight:500;font-size:0.85rem">${c.email}</td>
      <td style="padding:0.5rem 0.8rem;color:#94a3b8;font-size:0.8rem;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(c.message || '').replace(/"/g, '&quot;')}">${msgPreview || '-'}</td>
      <td style="padding:0.5rem 0.8rem;color:#64748b;font-size:0.8rem">${c.source || '-'}</td>
      <td style="padding:0.5rem 0.8rem;color:#64748b;font-size:0.75rem">${new Date(c.submittedAt).toLocaleString('en-IL')}</td>
      <td style="padding:0.5rem 0.8rem;text-align:center"><button class="del-btn" onclick="deleteItem('contact','${c.id}')" title="Delete">x</button></td>
    </tr>`;
    }).join('');

  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>HireView Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#050510;color:#e2e8f0;min-height:100vh;padding:2rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1rem;margin-bottom:2.5rem}
.card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:1.5rem}
.card h3{color:#64748b;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.4rem}
.card .val{font-size:2.2rem;font-weight:800;letter-spacing:-0.02em}
.card .sub{font-size:0.75rem;color:#475569;margin-top:0.2rem}
.val.blue{color:#3b82f6}.val.green{color:#10b981}.val.purple{color:#a78bfa}.val.orange{color:#f97316}.val.cyan{color:#06b6d4}
h1{color:#f1f5f9;font-size:1.6rem;font-weight:800;letter-spacing:-0.02em;margin-bottom:0.15rem}
.top-sub{color:#64748b;font-size:0.85rem;margin-bottom:2rem}
h2{color:#f1f5f9;font-size:1.1rem;font-weight:700;margin:2rem 0 0.8rem;display:flex;align-items:center;gap:0.5rem}
h2 .badge{background:rgba(59,130,246,0.15);color:#3b82f6;font-size:0.7rem;font-weight:600;padding:0.15rem 0.5rem;border-radius:6px}
table{width:100%;border-collapse:collapse;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;margin-bottom:1rem}
th{text-align:left;padding:0.6rem 0.8rem;color:#475569;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid rgba(255,255,255,0.06);font-weight:600}
td{border-bottom:1px solid rgba(255,255,255,0.04)}
tr:last-child td{border-bottom:none}
tr:hover{background:rgba(255,255,255,0.02)}
.actions{margin-top:2rem;display:flex;gap:1rem;justify-content:center;flex-wrap:wrap}
.actions a{color:#3b82f6;text-decoration:none;font-size:0.85rem;border:1px solid rgba(59,130,246,0.2);padding:0.5rem 1.2rem;border-radius:8px;transition:background .2s}
.actions a:hover{background:rgba(59,130,246,0.1)}
.ts{color:#475569;font-size:0.75rem;text-align:center;margin-top:1.5rem}
.empty{color:#475569;font-size:0.85rem;padding:2rem;text-align:center}
.notify-status{font-size:0.75rem;padding:0.4rem 0.8rem;border-radius:8px;display:inline-block;margin-bottom:1.5rem}
.notify-on{background:rgba(16,185,129,0.1);color:#10b981;border:1px solid rgba(16,185,129,0.2)}
.notify-off{background:rgba(249,115,22,0.1);color:#f97316;border:1px solid rgba(249,115,22,0.2)}
.del-btn{background:none;border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:6px;cursor:pointer;font-size:0.7rem;padding:0.2rem 0.5rem;transition:background .2s}
.del-btn:hover{background:rgba(239,68,68,0.15)}
.reset-btn{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:8px;cursor:pointer;font-size:0.85rem;font-weight:600;padding:0.5rem 1.2rem;transition:background .2s;font-family:inherit}
.reset-btn:hover{background:rgba(239,68,68,0.2)}
@media(max-width:640px){body{padding:1rem}.grid{grid-template-columns:1fr 1fr}}
</style>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
</head><body>
<h1>HireView Admin</h1>
<p class="top-sub">Analytics &amp; signups dashboard</p>

<div class="notify-status ${transporter ? 'notify-on' : 'notify-off'}">
  ${transporter ? 'Email notifications: ON' : 'Email notifications: OFF — set SMTP_USER + SMTP_PASS to enable'}
</div>

<div class="grid">
  <div class="card"><h3>Total Visitors</h3><div class="val blue">${totalVisits}</div></div>
  <div class="card"><h3>Avg. Time on Page</h3><div class="val cyan">${fmtDuration(avgDuration)}</div><div class="sub">${visitsWithDuration.length} sessions tracked</div></div>
  <div class="card"><h3>CTA Clicks</h3><div class="val purple">${ctaClicks}</div><div class="sub">${ctaRate}% click rate</div></div>
  <div class="card"><h3>Signups</h3><div class="val green">${totalSignups}</div><div class="sub">${signupRate}% conversion</div></div>
</div>

<h2>Signups <span class="badge">${totalSignups}</span></h2>
${contactRows ? `<table><thead><tr><th>Email</th><th>Message</th><th>Source</th><th>Date</th><th style="text-align:center;width:50px"></th></tr></thead><tbody>${contactRows}</tbody></table>` : '<p class="empty">No signups yet</p>'}

<h2>Visitors <span class="badge">last 50</span></h2>
${visitRows ? `<table><thead><tr><th>Time</th><th style="text-align:center">Duration</th><th>IP</th><th>User Agent</th><th style="text-align:center;width:50px"></th></tr></thead><tbody>${visitRows}</tbody></table>` : '<p class="empty">No visits recorded yet</p>'}

${clickRows ? `<h2>Clicks by Button</h2><table><thead><tr><th>Button</th><th style="text-align:right">Clicks</th></tr></thead><tbody>${clickRows}</tbody></table>` : ''}

<p class="ts">Last refreshed: ${new Date().toLocaleString('en-IL')}</p>
<div class="actions">
  <a href="/admin">Refresh</a>
  <a href="/admin/contacts.csv">Export Signups CSV</a>
  <button class="reset-btn" onclick="resetAll()">Reset All Data</button>
</div>
<script>
function getAuth() {
  return 'Basic ' + btoa('admin:${ADMIN_PASSWORD}');
}
async function deleteItem(type, id) {
  if (!confirm('Delete this ' + type + '?')) return;
  const res = await fetch('/admin/' + type + '/' + id, { method: 'DELETE', headers: { 'Authorization': getAuth() } });
  if (res.ok) location.reload();
  else alert('Failed to delete');
}
async function resetAll() {
  if (!confirm('This will delete ALL visitors, signups, and click data. Are you sure?')) return;
  if (!confirm('Really? This cannot be undone.')) return;
  const res = await fetch('/admin/reset', { method: 'POST', headers: { 'Authorization': getAuth() } });
  if (res.ok) location.reload();
  else alert('Failed to reset');
}
</script>
</body></html>`);
});

// ---------------------------------------------------------------------------
// Export contacts as CSV
// ---------------------------------------------------------------------------

app.get('/admin/contacts.csv', requireAdmin, (req, res) => {
  const contacts = readJSON(CONTACTS_FILE, []);
  const header = 'Email,Name,Company,Role,Team Size,Message,Source,Submitted At\n';
  const rows = contacts.map(c =>
    [c.email, c.name, c.company, c.role, c.teamSize, `"${(c.message || '').replace(/"/g, '""')}"`, c.source, c.submittedAt].join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=hireview-signups.csv');
  res.send(header + rows);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`HireView running on http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin  (user: admin)`);
});
