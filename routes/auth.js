// routes/auth.js — register, login, logout, and password reset.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool, logEvent } = require('../db');
const { clean, oneOf, US_STATES } = require('../helpers');
const mailer = require('../mailer');

const router = require('../middleware').safeRouter(express.Router());

const APP_URL = (process.env.APP_URL || 'https://app.connexli.com').replace(/\/$/, '');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts. Please wait 15 minutes and try again.',
});

// Stricter limit for reset-email requests so the form can't be used to
// flood someone's inbox.
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many reset requests. Please wait 15 minutes and try again.',
});

// We store only a SHA-256 hash of the reset token, never the token itself,
// so a copy of the database can't be used to take over accounts.
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const notice = req.query.reset === '1' ? 'Your password has been updated. Log in with your new password.' : null;
  res.render('login', { title: 'Log in', error: null, notice, email: '' });
});

router.post('/login', authLimiter, async (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  // LOWER() matches legacy mixed-case rows too, and uses the same
  // case-insensitive unique index that keeps emails one-per-account.
  const { rows } = await pool.query(`SELECT * FROM users WHERE LOWER(email)=$1`, [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).render('login', { title: 'Log in', error: 'Email or password is incorrect.', notice: null, email });
  }
  req.session.user = { id: user.id, role: user.role, name: user.name, email: user.email };
  logEvent('login', { userId: user.id, meta: { role: user.role } });
  // Deep links (e.g. the Give Feedback button in follow-up emails) survive
  // the login step: only same-site paths are ever honored.
  const returnTo = req.session.returnTo;
  delete req.session.returnTo;
  res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
});

// ---------- forgot password ----------
router.get('/forgot', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('forgot', { title: 'Forgot password', error: null, sent: false, email: '' });
});

router.post('/forgot', forgotLimiter, async (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  if (!email.includes('@')) {
    return res.status(400).render('forgot', { title: 'Forgot password', error: 'Please enter a valid email address.', sent: false, email });
  }

  // Whether or not the account exists, we show the exact same confirmation.
  // This stops anyone from using this form to discover which emails have
  // Connexli accounts.
  const { rows } = await pool.query(`SELECT id, name, email FROM users WHERE LOWER(email)=$1`, [email]);
  const user = rows[0];
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    // Any older, unused links for this account stop working immediately.
    await pool.query(`UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [user.id]);
    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '60 minutes')`,
      [user.id, hashToken(token)]
    );
    mailer.passwordReset(user.email, user.name, `${APP_URL}/reset/${token}`); // fire and forget
  }
  res.render('forgot', { title: 'Forgot password', error: null, sent: true, email });
});

// Look up a token from the URL and return the matching valid reset row, or null.
async function findValidReset(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const { rows } = await pool.query(
    `SELECT pr.id, pr.user_id, u.email, u.name FROM password_resets pr
     JOIN users u ON u.id = pr.user_id
     WHERE pr.token_hash=$1 AND pr.used_at IS NULL AND pr.expires_at > now()`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

router.get('/reset/:token', async (req, res) => {
  const reset = await findValidReset(req.params.token);
  if (!reset) {
    return res.status(400).render('forgot', {
      title: 'Forgot password',
      error: 'That reset link is invalid, has expired, or was already used. Request a new one below.',
      sent: false, email: '',
    });
  }
  res.render('reset', { title: 'Choose a new password', error: null, token: req.params.token });
});

router.post('/reset/:token', authLimiter, async (req, res) => {
  const reset = await findValidReset(req.params.token);
  if (!reset) {
    return res.status(400).render('forgot', {
      title: 'Forgot password',
      error: 'That reset link is invalid, has expired, or was already used. Request a new one below.',
      sent: false, email: '',
    });
  }
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const fail = (msg) => res.status(400).render('reset', { title: 'Choose a new password', error: msg, token: req.params.token });
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  if (password !== confirm) return fail('The two passwords do not match. Please try again.');

  const hash = await bcrypt.hash(password, 12);
  await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, reset.user_id]);
  await pool.query(`UPDATE password_resets SET used_at=now() WHERE id=$1`, [reset.id]);

  // Log this account out everywhere else, in case the reset happened because
  // someone else had access to it.
  try {
    await pool.query(`DELETE FROM session WHERE (sess::jsonb #>> '{user,id}')::int = $1`, [reset.user_id]);
  } catch (e) {
    console.error('Could not clear old sessions after password reset:', e.message);
  }

  logEvent('password_reset_completed', { userId: reset.user_id });
  res.redirect('/login?reset=1');
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('register', { title: 'Create your account', error: null, form: {} });
});

router.post('/register', authLimiter, async (req, res) => {
  const form = {
    role: req.body.role === 'agent' ? 'agent' : 'seller',
    name: clean(req.body.name, 100),
    email: clean(req.body.email, 120).toLowerCase(),
    phone: clean(req.body.phone, 30),
    license_number: clean(req.body.license_number, 40),
    brokerage: clean(req.body.brokerage, 100),
    service_zip: clean(req.body.service_zip, 10),
  };
  const password = String(req.body.password || '');

  const fail = (msg) => res.status(400).render('register', { title: 'Create your account', error: msg, form });

  if (!form.name || !form.email.includes('@')) return fail('Please enter your name and a valid email address.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  if (form.role === 'agent' && (!form.license_number || !form.brokerage)) {
    return fail('Professionals must provide a license number and brokerage. This is how Connexli keeps the marketplace verified.');
  }
  let geo = null;
  if (form.role === 'agent') {
    if (!form.service_zip.match(/^\d{5}$/)) return fail('Please enter the 5-digit ZIP code at the center of your service area.');
    geo = mailer.zipInfo(form.service_zip);
    if (!geo) return fail('We could not find that ZIP code. Please double-check your primary service ZIP.');
  }

  const hash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO users (role, name, email, phone, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [form.role, form.name, form.email, form.phone, hash]
    );
    if (form.role === 'agent') {
      await client.query(
        `INSERT INTO agent_profiles (user_id, license_number, brokerage, state, service_zip, service_city, service_state, latitude, longitude)
         VALUES ($1,$2,$3,'Utah',$4,$5,$6,$7,$8)`,
        [rows[0].id, form.license_number, form.brokerage, form.service_zip, geo.city, geo.state, geo.latitude, geo.longitude]
      );
    }
    await client.query('COMMIT');
    if (form.role === 'agent') {
      mailer.adminNewAgent({ ...form, service_city: geo ? geo.city : null }); // fire and forget
    }
    logEvent(form.role === 'agent' ? 'agent_registered' : 'seller_registered',
      { userId: rows[0].id, meta: form.role === 'agent' ? { service_zip: form.service_zip } : {} });
    req.session.user = { id: rows[0].id, role: form.role, name: form.name, email: form.email };
    res.redirect('/');
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return fail('An account with that email already exists. Try logging in instead.');
    throw e;
  } finally {
    client.release();
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- public contact form (Paul, Aug 23) ----------
// Replaces the footer mailto: link. Stored in the database FIRST, then
// forwarded to contact@connexli.com — a mail failure never loses a message.
const CONTACT_REASONS = ['General question', 'Technical problem', 'Feedback / suggestion', 'Account help', 'Professional / agent question', 'Other'];

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many messages. Please wait 15 minutes and try again.',
});

router.get('/contact', (req, res) => {
  res.render('contact', { title: 'Contact Connexli', reasons: CONTACT_REASONS, error: null, sent: false, form: {} });
});

router.post('/contact', contactLimiter, async (req, res) => {
  // Honeypot: real people never fill the invisible "website" field. Bots do.
  // Pretend success so the bot learns nothing; store and send nothing.
  if (String(req.body.website || '').trim() !== '') {
    return res.render('contact', { title: 'Contact Connexli', reasons: CONTACT_REASONS, error: null, sent: true, form: {} });
  }
  const form = {
    name: clean(req.body.name, 100),
    email: clean(req.body.email, 120).toLowerCase(),
    reason: oneOf(req.body.reason, CONTACT_REASONS, null),
    message: clean(req.body.message, 5000),
  };
  const fail = (msg) => res.status(400).render('contact', { title: 'Contact Connexli', reasons: CONTACT_REASONS, error: msg, sent: false, form });
  if (!form.name || !form.email.includes('@') || !form.reason || !form.message) {
    return fail('Please fill in your name, a valid email address, a reason, and your message.');
  }
  const { rows } = await pool.query(
    `INSERT INTO contact_messages (name, email, reason, message) VALUES ($1,$2,$3,$4) RETURNING id`,
    [form.name, form.email, form.reason, form.message]);
  mailer.contactMessage({ ...form, id: rows[0].id }); // fire and forget — already stored
  logEvent('contact_message', { meta: { reason: form.reason } });
  res.render('contact', { title: 'Contact Connexli', reasons: CONTACT_REASONS, error: null, sent: true, form: {} });
});

// ---------- expansion waitlist (Paul, Aug 23) ----------
// The connexli.com "Not in Utah?" form posts here directly — no email step,
// no third-party form service. One row per email (upsert keeps the newest
// choice of type/state); standardized state values only.
const WAITLIST_TYPES = ['Homeowner thinking about selling', 'Buyer looking for a home', 'Real estate professional', 'Just curious'];

const waitlistLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many signups from this connection. Please try again later.',
});

router.post('/waitlist', waitlistLimiter, async (req, res) => {
  const renderPage = (opts) => res.status(opts.error ? 400 : 200).render('waitlist-joined', {
    title: 'Connexli Waitlist', H: require('../helpers'),
    types: WAITLIST_TYPES, error: opts.error || null, joined: !!opts.joined, form: opts.form || {},
  });
  if (String(req.body.website || '').trim() !== '') return renderPage({ joined: true }); // honeypot
  const form = {
    email: clean(req.body.email, 120).toLowerCase(),
    user_type: oneOf(req.body.role, WAITLIST_TYPES, null),
    state: oneOf(req.body.state, US_STATES, null), // standardized list — misspellings impossible
  };
  if (!form.email.includes('@') || !form.user_type || !form.state) {
    return renderPage({ error: 'Please choose who you are, enter a valid email address, and pick your state from the list.', form });
  }
  await pool.query(
    `INSERT INTO waitlist (email, user_type, state) VALUES ($1,$2,$3)
     ON CONFLICT ((LOWER(email))) DO UPDATE SET user_type=EXCLUDED.user_type, state=EXCLUDED.state`,
    [form.email, form.user_type, form.state]);
  logEvent('waitlist_joined', { meta: { state: form.state, user_type: form.user_type } });
  renderPage({ joined: true, form });
});

// Direct visits (or validation errors) get a standalone copy of the form.
router.get('/waitlist', (req, res) => {
  res.render('waitlist-joined', { title: 'Connexli Waitlist', H: require('../helpers'), types: WAITLIST_TYPES, error: null, joined: false, form: {} });
});

// ---------- structured connection feedback (Paul, Aug 25) ----------
// One short form per side of each connection, reachable from the follow-up
// email's Give Feedback button AND from the dashboards. Role is resolved
// from the connection itself: the request's owner is the client, the
// connected agent is the professional — anyone else is turned away.
async function loadConnection(type, id) {
  if (type === 'seller') {
    const { rows } = await pool.query(
      `SELECT r.id, r.seller_id AS client_id, p.agent_id, u.name AS agent_name, cu.name AS client_name,
              r.city, r.property_type
       FROM requests r JOIN proposals p ON p.request_id = r.id AND p.connected
       JOIN users u ON u.id = p.agent_id JOIN users cu ON cu.id = r.seller_id
       WHERE r.id=$1`, [id]);
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `SELECT b.id, b.user_id AS client_id, bp.agent_id, u.name AS agent_name, cu.name AS client_name,
            b.search_areas
     FROM buyer_profiles b JOIN buyer_proposals bp ON bp.profile_id = b.id AND bp.connected
     JOIN users u ON u.id = bp.agent_id JOIN users cu ON cu.id = b.user_id
     WHERE b.id=$1`, [id]);
  return rows[0] || null;
}

async function feedbackContext(req, res) {
  const type = req.params.type === 'buyer' ? 'buyer' : 'seller';
  const conn = await loadConnection(type, req.params.id);
  if (!conn) {
    res.status(404).render('error', { title: 'Not found', message: 'That connection was not found — feedback opens once a connection has been made.' });
    return null;
  }
  const uid = req.session.user.id;
  const role = uid === conn.client_id ? 'client' : uid === conn.agent_id ? 'professional' : null;
  if (!role) {
    res.status(403).render('error', { title: 'Not allowed', message: 'Only the two people in this connection can leave feedback on it.' });
    return null;
  }
  const { rows: existing } = await pool.query(
    `SELECT * FROM connection_feedback WHERE opportunity_type=$1 AND opportunity_id=$2 AND respondent_role=$3`,
    [type, conn.id, role]);
  return { type, conn, role, existing: existing[0] || null };
}

// Remember where an email click was headed, then send through login.
router.get('/feedback/:type(seller|buyer)/:id(\\d+)', async (req, res) => {
  if (!req.session.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
  const ctx = await feedbackContext(req, res);
  if (!ctx) return;
  res.render('feedback', {
    title: 'Give feedback', H: require('../helpers'),
    ...ctx, counterpartName: ctx.role === 'client' ? ctx.conn.agent_name : ctx.conn.client_name,
    error: null, done: !!ctx.existing, form: {},
  });
});

router.post('/feedback/:type(seller|buyer)/:id(\\d+)', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const ctx = await feedbackContext(req, res);
  if (!ctx) return;
  const counterpartName = ctx.role === 'client' ? ctx.conn.agent_name : ctx.conn.client_name;
  if (ctx.existing) {
    return res.render('feedback', { title: 'Give feedback', H: require('../helpers'), ...ctx, counterpartName, error: null, done: true, form: {} });
  }
  const star = (v) => { const n = parseInt(v, 10); return n >= 1 && n <= 5 ? n : null; };
  const form = {
    q_connected: ['Yes', 'No'].includes(req.body.q_connected) ? req.body.q_connected : null,
    q_agreement: ctx.role === 'client' ? (['Yes', 'No', 'Not yet'].includes(req.body.q_agreement) ? req.body.q_agreement : null) : null,
    rating_counterpart: star(req.body.rating_counterpart),
    rating_connexli: star(req.body.rating_connexli),
    rating_recommend: star(req.body.rating_recommend),
    comments: clean(req.body.comments, 3000),
  };
  if (!form.q_connected || !form.rating_counterpart || !form.rating_connexli || !form.rating_recommend || (ctx.role === 'client' && !form.q_agreement)) {
    return res.status(400).render('feedback', {
      title: 'Give feedback', H: require('../helpers'), ...ctx, counterpartName,
      error: 'Please answer every question (comments are optional).', done: false, form,
    });
  }
  await pool.query(
    `INSERT INTO connection_feedback (opportunity_type, opportunity_id, respondent_role, respondent_id,
       counterpart_agent_id, q_connected, q_agreement, rating_counterpart, rating_connexli, rating_recommend, comments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (opportunity_type, opportunity_id, respondent_role) DO NOTHING`,
    [ctx.type, ctx.conn.id, ctx.role, req.session.user.id, ctx.conn.agent_id,
     form.q_connected, form.q_agreement, form.rating_counterpart, form.rating_connexli, form.rating_recommend, form.comments]);
  logEvent('feedback_submitted', { userId: req.session.user.id, meta: { type: ctx.type, opportunity_id: ctx.conn.id, role: ctx.role } });
  res.render('feedback', { title: 'Give feedback', H: require('../helpers'), ...ctx, counterpartName, error: null, done: true, form: {} });
});

module.exports = router;
