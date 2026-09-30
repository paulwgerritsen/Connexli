// routes/practice.js — the professional Practice Proposal Center (Paul, Sep 30).
//
// Two practice paths, kept completely separate:
//   /agent/practice/seller  — respond to a (fictional) homeowner who wants a listing agent
//   /agent/practice/buyer   — respond to a (fictional) buyer who wants a buyer's agent
//
// ZERO production effects, by design. Nothing in this file writes to the
// database, sends an email, records an event, or touches credits:
//   - no request, buyer profile, or proposal is created
//   - no free or paid proposal credit is used, and nothing is charged
//   - no consumer or professional is notified
//   - live opportunity counts and admin reporting never see practice data
// The practice proposal only exists inside the page: the preview carries it
// in hidden form fields so "Edit" can bring it back — then it's gone.
//
// Reuse, so practice never drifts from the real thing:
//   - the same proposal field partials as the live opportunity forms
//   - the same validation (proposal-input.js)
//   - the same consumer-facing proposal card and comparison table
//   - "See what the seller/buyer submitted" renders the REAL consumer forms,
//     read-only, filled with the fictional answers.
const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../middleware');
const H = require('../helpers');
const PI = require('../proposal-input');
const practice = require('../practice');

const router = require('../middleware').safeRouter(express.Router());
const agent = requireRole('agent');

// Approved professionals, and professionals still waiting on verification
// (a good time to learn the ropes). Suspended/rejected accounts go back to
// their dashboard, which explains their status.
async function practiceAccess(req, res, next) {
  const { rows } = await pool.query(
    `SELECT ap.status, ap.brokerage, ap.transactions_seller_12mo, ap.transactions_buyer_12mo, u.name
     FROM agent_profiles ap JOIN users u ON u.id = ap.user_id WHERE ap.user_id=$1`, [req.session.user.id]);
  const pro = rows[0];
  if (!pro || !['approved', 'pending'].includes(pro.status)) return res.redirect('/agent');
  req.practicePro = pro; // read-only: used to show YOUR name on the preview
  next();
}

// How the practice proposal is labeled on the preview: the professional's
// own name and track record, exactly as consumers would see them.
function asConsumerSees(pro, values) {
  return {
    id: 0, shortlisted: false, connected: false,
    agent_name: pro.name, brokerage: pro.brokerage,
    transactions_seller_12mo: pro.transactions_seller_12mo,
    transactions_buyer_12mo: pro.transactions_buyer_12mo,
    ...values,
  };
}

// ---------- hub ----------
router.get('/agent/practice', agent, practiceAccess, (req, res) => {
  res.render('agent/practice-hub', { title: 'Practice proposals', pending: req.practicePro.status !== 'approved' });
});

// ---------- Practice – Seller Opportunity ----------
function renderSellerPractice(res, { proposal = null, error = null, status = 200 } = {}) {
  res.status(status).render('agent/practice-seller', {
    title: 'Practice – Seller Opportunity', H, request: practice.sampleSellerRequest(), proposal, error,
  });
}

router.get('/agent/practice/seller', agent, practiceAccess, (req, res) => renderSellerPractice(res));

// "See what the seller submitted": the real homeowner form, read-only.
router.get('/agent/practice/seller/request', agent, practiceAccess, (req, res) => {
  res.render('seller/new-request', {
    title: 'Practice – what the seller submitted', H, error: null,
    form: practice.sampleSellerRequest(), sample: true,
  });
});

// Back from the preview to keep editing (values ride along in hidden fields).
router.post('/agent/practice/seller/edit', agent, practiceAccess, (req, res) => {
  renderSellerPractice(res, { proposal: PI.sellerProposal(req.body).form });
});

// "Preview What the Seller Sees" — validated exactly like a live submission.
router.post('/agent/practice/seller/preview', agent, practiceAccess, (req, res) => {
  const parsed = PI.sellerProposal(req.body);
  if (parsed.error) return renderSellerPractice(res, { proposal: parsed.form, error: parsed.error, status: 400 });
  const request = practice.sampleSellerRequest();
  const p = asConsumerSees(req.practicePro, { ...parsed.values, services: parsed.values.services.join(', ') });
  res.render('agent/practice-seller-preview', {
    title: 'Preview – what the seller sees', H, request, p, form: parsed.values,
  });
});
router.get('/agent/practice/seller/preview', agent, (req, res) => res.redirect('/agent/practice/seller'));

// ---------- Practice – Buyer Opportunity ----------
function renderBuyerPractice(res, { proposal = null, error = null, status = 200 } = {}) {
  res.status(status).render('agent/practice-buyer', {
    title: 'Practice – Buyer Opportunity', H, buyer: practice.sampleBuyerProfile(), proposal, error,
  });
}

router.get('/agent/practice/buyer', agent, practiceAccess, (req, res) => renderBuyerPractice(res));

// "See what the buyer submitted": the real buyer forms, read-only — the
// buyer profile form, then the optional "Boost your profile" step.
router.get('/agent/practice/buyer/request', agent, practiceAccess, (req, res) => {
  res.render('buyer/new', {
    title: 'Practice – what the buyer submitted', H, error: null,
    form: practice.buyerFormValues(practice.sampleBuyerProfile()), sample: true,
  });
});
router.get('/agent/practice/buyer/request/boost', agent, practiceAccess, (req, res) => {
  res.render('buyer/boost', {
    title: 'Practice – what the buyer submitted', H, error: null,
    profile: practice.sampleBuyerProfile(), sample: true,
  });
});

router.post('/agent/practice/buyer/edit', agent, practiceAccess, (req, res) => {
  renderBuyerPractice(res, { proposal: PI.buyerProposal(req.body).form });
});

// "Preview What the Buyer Sees" — validated exactly like a live submission.
router.post('/agent/practice/buyer/preview', agent, practiceAccess, (req, res) => {
  const parsed = PI.buyerProposal(req.body);
  if (parsed.error) return renderBuyerPractice(res, { proposal: parsed.form, error: parsed.error, status: 400 });
  const profile = practice.sampleBuyerProfile();
  const p = asConsumerSees(req.practicePro, { ...parsed.values, specialties: parsed.values.specialties.join(', ') });
  res.render('agent/practice-buyer-preview', {
    title: 'Preview – what the buyer sees', H, profile, p, form: parsed.values,
  });
});
router.get('/agent/practice/buyer/preview', agent, (req, res) => res.redirect('/agent/practice/buyer'));

module.exports = router;
