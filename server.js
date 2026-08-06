// server.js — Connexli MVP entry point.
// Run locally:  DATABASE_URL=postgres://... node server.js
// On Render:    provisioned automatically via render.yaml (see README)
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const path = require('path');

const { pool, init, closeExpired, logEvent } = require('./db');
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
  } catch (e) { console.error('closeAndNotify:', e.message); }
}
setInterval(closeAndNotify, 5 * 60 * 1000);
app.use(async (req, res, next) => { await closeAndNotify(); next(); });

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/seller'));
app.use('/', require('./routes/agent'));
app.use('/', require('./routes/admin'));

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
