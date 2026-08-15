// server.js — Connexli MVP entry point.
// Run locally:  DATABASE_URL=postgres://... node server.js
// On Render:    provisioned automatically via render.yaml (see README)
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const path = require('path');

const { pool, init, closeExpired, expireBuyerProfiles, logEvent } = require('./db');
const mailer = require('./mailer');
const { csrf } = require('./middleware');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // Render sits behind a proxy

app.use(helmet({ contentSecurityPolicy: false })); // CSP kept simple for the pilot (Google Fonts)
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14, // two weeks
  },
}));

// Make the logged-in user available to every template.
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.path = req.path;
  res.locals.posthogKey = process.env.POSTHOG_KEY || ''; // analytics on only when set
  next();
});
app.use(csrf);

// Close expired proposal windows and email each seller that proposals are
// ready. Runs before every page view AND on a 5-minute timer, so windows
// close on schedule even when nobody is browsing. Each closed request is
// returned exactly once, so emails never duplicate.
async function closeAndNotify() {
  try {
    const closed = await closeExpired();
    for (const r of closed) {
      const { rows } = await pool.query(`SELECT email, name FROM users WHERE id=$1`, [r.seller_id]);
      if (rows[0]) mailer.sellerProposalsReady(rows[0].email, rows[0].name, r);
      logEvent('request_closed', { userId: r.seller_id, requestId: r.id });
    }
    // Buyer windows that just expired: notify each buyer exactly once that
    // their sealed proposals are ready (mirrors the seller flow).
    const { rows: endedBuyers } = await pool.query(
      `UPDATE buyer_profiles SET window_notified = true
       WHERE status='active' AND published AND window_notified = false AND closes_at <= now()
       RETURNING id, user_id, search_areas`);
    for (const b of endedBuyers) {
      const { rows } = await pool.query(`SELECT email, name FROM users WHERE id=$1`, [b.user_id]);
      if (rows[0]) mailer.buyerProposalsReady(rows[0].email, rows[0].name, b);
      logEvent('buyer_window_closed', { userId: b.user_id, meta: { profile_id: b.id } });
    }
    await expireBuyerProfiles();
  } catch (e) { console.error('closeAndNotify:', e.message); }
}
setInterval(closeAndNotify, 5 * 60 * 1000);
app.use(async (req, res, next) => { await closeAndNotify(); next(); });

// Every feature area the app expects to serve. If a route file is missing the
// server refuses to start with a clear message — a half-deployed update can
// never boot silently with features missing.
const APP_VERSION = '2026-08-14b-city-picker-new-after-connect';
const ROUTE_MODULES = ['auth', 'seller', 'buyer', 'agent', 'admin'];
for (const m of ROUTE_MODULES) {
  app.use('/', require('./routes/' + m));
}
console.log(`Connexli ${APP_VERSION} — mounted routes: ${ROUTE_MODULES.join(', ')}`);

// One-glance deploy check: visit /healthz after every deploy. If "buyer" (or
// any module) is missing from this list, the deploy is incomplete.
app.get('/healthz', (req, res) => res.json({ ok: true, version: APP_VERSION, routes: ROUTE_MODULES }));

app.get('/', (req, res) => {
  const u = req.session.user;
  if (!u) return res.redirect('/login');
  if (u.role === 'seller') return res.redirect('/dashboard');
  if (u.role === 'agent') return res.redirect('/agent');
  return res.redirect('/admin');
});

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log(`Connexli running on port ${PORT}`)))
  .catch((e) => { console.error('Failed to start:', e); process.exit(1); });

// Last-resort safety net: log unexpected async errors instead of exiting.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
