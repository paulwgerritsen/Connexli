// routes/preview.js — public "See what Connexli asks" request previews
// (Paul, Oct 1).
//
// A visitor with NO account can open the real selling and buying request
// forms, click through every question, and reach the end — where a "Create a
// Selling/Buying Request" button leads into the normal signup.
//
// Nothing here touches the database, by construction: this router is mounted
// in server.js BEFORE sessions, CSRF and the marketplace sweeps, and it never
// imports the database module. No account, no email verification, no
// CAPTCHA, no request/profile records, no notifications, no events. The
// forms have no submit action, and there are no POST routes.
//
// The pages render the SAME templates as the live forms (seller/new-request,
// buyer/new, buyer/boost) with preview:true, so the previews always show the
// current production questions.
const express = require('express');
const H = require('../helpers');

const router = express.Router();

// What the shared page header expects, without a session: previews always
// render as a logged-out visitor.
router.use('/preview', (req, res, next) => {
  res.locals.user = null;
  res.locals.csrf = '';
  res.locals.path = req.path;
  res.locals.posthogKey = process.env.POSTHOG_KEY || '';
  res.set('Cache-Control', 'public, max-age=300'); // same page for everyone
  next();
});

router.get('/preview', (req, res) => res.redirect('https://connexli.com/#preview'));

router.get('/preview/selling', (req, res) => {
  res.render('seller/new-request', { title: 'Preview a selling request', H, error: null, form: {}, preview: true });
});

router.get('/preview/buying', (req, res) => {
  res.render('buyer/new', { title: 'Preview a buying request', H, error: null, form: {}, preview: true });
});

// The optional second step buyers see after publishing ("Boost your profile").
router.get('/preview/buying/details', (req, res) => {
  const blank = { property_prefs: '', priorities: '', availability: '', first_time: null, notes: '' };
  res.render('buyer/boost', { title: 'Preview a buying request', H, error: null, profile: blank, preview: true });
});

module.exports = router;
