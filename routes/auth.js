// routes/auth.js — register, login, logout, and password reset.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { clean } = require('../helpers');
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
  const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).render('login', { title: 'Log in', error: 'Email or password is incorrect.', notice: null, email });
  }
  req.session.user = { id: user.id, role: user.role, name: user.name, email: user.email };
  res.redirect('/');
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
  const { rows } = await pool.query(`SELECT id, name, email FROM users WHERE email=$1`, [email]);
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

module.exports = router;
