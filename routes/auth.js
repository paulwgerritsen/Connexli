// routes/auth.js — register, login, logout.
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { clean } = require('../helpers');

const router = require('../middleware').safeRouter(express.Router());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts. Please wait 15 minutes and try again.',
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Log in', error: null, email: '' });
});

router.post('/login', authLimiter, async (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).render('login', { title: 'Log in', error: 'Email or password is incorrect.', email });
  }
  req.session.user = { id: user.id, role: user.role, name: user.name, email: user.email };
  res.redirect('/');
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
  };
  const password = String(req.body.password || '');

  const fail = (msg) => res.status(400).render('register', { title: 'Create your account', error: msg, form });

  if (!form.name || !form.email.includes('@')) return fail('Please enter your name and a valid email address.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  if (form.role === 'agent' && (!form.license_number || !form.brokerage)) {
    return fail('Professionals must provide a license number and brokerage. This is how Connexli keeps the marketplace verified.');
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
        `INSERT INTO agent_profiles (user_id, license_number, brokerage, state) VALUES ($1,$2,$3,'Utah')`,
        [rows[0].id, form.license_number, form.brokerage]
      );
    }
    await client.query('COMMIT');
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
