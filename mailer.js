// mailer.js — all Connexli email notifications, sent through Resend.
// If RESEND_API_KEY is not set, emails are logged to the console instead of
// sent, so the app works in every environment and nothing ever crashes
// because of email.
const zipcodes = require('zipcodes');
const { pool } = require('./db');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Connexli <onboarding@resend.dev>';
const APP_URL = (process.env.APP_URL || 'https://app.connexli.com').replace(/\/$/, '');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@connexli.com').toLowerCase();
const RADIUS_MILES = parseFloat(process.env.NOTIFY_RADIUS_MILES) || 50;

// ---------- transport ----------
async function send(to, subject, bodyHtml) {
  if (!RESEND_API_KEY) {
    const link = (bodyHtml.match(/href="([^"]+)"/) || [])[1] || '';
    console.log(`[email:DRY] to=${to} subject="${subject}"${link ? ' link=' + link : ''}`);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html: bodyHtml }),
    });
    if (!res.ok) console.error('Email send failed:', res.status, await res.text());
  } catch (e) {
    console.error('Email send error:', e.message);
  }
}

// Simple branded wrapper used by every email.
function template(title, lines, buttonText, buttonUrl) {
  const paragraphs = lines.map(l => `<p style="margin:0 0 14px; font-size:15px; line-height:1.6; color:#334155;">${l}</p>`).join('');
  const button = buttonText
    ? `<a href="${buttonUrl}" style="display:inline-block; background:#1565FF; color:#ffffff; font-weight:bold; font-size:15px; padding:13px 28px; border-radius:999px; text-decoration:none; margin-top:6px;">${buttonText}</a>`
    : '';
  return `<!DOCTYPE html><html><body style="margin:0; background:#F2F4F7; font-family:Arial,Helvetica,sans-serif; padding:24px 12px;">
  <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:14px; overflow:hidden; border:1px solid #E1E7F0;">
    <div style="background:#0A1B33; padding:18px 26px;">
      <span style="color:#ffffff; font-size:19px; font-weight:bold;">connex<span style="color:#42B6FF;">li</span></span>
    </div>
    <div style="padding:26px;">
      <h1 style="margin:0 0 16px; font-size:20px; color:#0A1B33;">${title}</h1>
      ${paragraphs}
      ${button}
    </div>
    <div style="padding:16px 26px; border-top:1px solid #F2F4F7; font-size:12px; color:#8B95A5;">
      Real Connections. Better Decisions. · Connexli is not a real estate brokerage.
    </div>
  </div></body></html>`;
}

// ---------- geography ----------
// Distance in miles between two ZIP codes using the built-in US ZIP database.
// Returns null when either ZIP is unknown (we then "fail open" and notify).
function zipDistance(zipA, zipB) {
  if (!zipA || !zipB) return null;
  const d = zipcodes.distance(String(zipA), String(zipB));
  return (typeof d === 'number' && !Number.isNaN(d)) ? d : null;
}

function zipInfo(zip) {
  return zipcodes.lookup(String(zip || '')) || null; // {city, state, latitude, longitude}
}

// ---------- the notifications ----------
function adminNewAgent(agent) {
  return send(ADMIN_EMAIL, 'Action needed: new professional awaiting verification',
    template('New professional awaiting verification', [
      `<b>${agent.name}</b> just signed up and is waiting in the verification queue.`,
      `License: <b>${agent.license_number}</b><br>Brokerage: <b>${agent.brokerage}</b><br>Service area: <b>${agent.service_zip || 'not provided'}${agent.service_city ? ' (' + agent.service_city + ')' : ''}</b><br>Email: ${agent.email}`,
      'Check the license against the Utah lookup, then approve or reject.',
    ], 'Review in admin panel', APP_URL + '/admin'));
}

function agentApproved(email, name) {
  return send(email, "You're verified — welcome to Connexli",
    template("You're verified 🎉", [
      `${name.split(' ')[0]}, your license checked out and your Connexli account is now active.`,
      "You'll receive an email whenever a homeowner near your service area invites proposals. You can also browse every open opportunity anytime.",
      'Sealed means sealed: competing professionals never see your pricing.',
    ], 'See open opportunities', APP_URL + '/agent'));
}

function agentRejected(email, name) {
  return send(email, 'About your Connexli verification',
    template('Verification unsuccessful', [
      `${name.split(' ')[0]}, we couldn't verify your license with the information provided.`,
      'If you believe this is a mistake, reply to this email with your correct license number and brokerage and we\'ll take another look.',
    ], null, null));
}

// Notify approved professionals near the property. Radius is configurable via
// NOTIFY_RADIUS_MILES (default 50). Agents without a service ZIP, and ZIPs we
// can't resolve, are included rather than silently excluded.
async function agentsNewRequest(request) {
  try {
    const { rows: agents } = await pool.query(
      `SELECT u.email, u.name, ap.service_zip FROM users u
       JOIN agent_profiles ap ON ap.user_id = u.id WHERE ap.status = 'approved'`);
    let notified = 0;
    for (const a of agents) {
      const dist = zipDistance(request.zip, a.service_zip);
      if (dist !== null && dist > RADIUS_MILES) continue;
      notified++;
      await send(a.email, 'New Connexli Opportunity Near You',
        template('New opportunity near you', [
          `A homeowner in <b>${request.city}, ${request.zip}</b> is inviting sealed proposals from professionals like you.`,
          `Property: <b>${request.property_type}</b><br>Price range: <b>${request.price_range}</b><br>Proposal window closes: <b>${new Date(request.closes_at).toLocaleString('en-US', { timeZone: 'America/Denver' })} (Mountain)</b>`,
          'Submit your sealed proposal before the window closes. Competing professionals never see your pricing.',
        ], 'View Opportunity', APP_URL + '/login'));
    }
    console.log(`Opportunity emails: ${notified}/${agents.length} approved professionals within ${RADIUS_MILES} miles of ${request.zip}`);
  } catch (e) {
    console.error('agentsNewRequest failed:', e.message);
  }
}

// Password reset. The link is single-use and expires in 60 minutes.
function passwordReset(email, name, resetUrl) {
  return send(email, 'Reset your Connexli password',
    template('Reset your password', [
      `${name.split(' ')[0]}, we received a request to reset the password for your Connexli account.`,
      'Click the button below to choose a new password. This link works once and expires in 60 minutes.',
      "If you didn't request this, you can safely ignore this email — your password will not change.",
    ], 'Choose a new password', resetUrl));
}

function sellerProposalsReady(email, name, request) {
  return send(email, 'Your Connexli proposals are ready',
    template('Your proposals are ready 🎉', [
      `${name.split(' ')[0]}, the proposal window for your ${request.property_type.toLowerCase()} in ${request.city} has closed.`,
      'Log in to compare every proposal side by side: fees, services, marketing plans, and cancellation terms.',
      'Your address and contact info are still hidden until you choose to share them.',
    ], 'Compare my proposals', APP_URL + '/requests/' + request.id));
}

function agentWon(email, name, request) {
  return send(email, "You've been chosen — a homeowner connected with you",
    template("You won the listing conversation 🎉", [
      `${name.split(' ')[0]}, the homeowner in ${request.city} chose YOUR proposal and released their contact information to you.`,
      'Their details are on your dashboard. Reach out within 24 hours while the decision is fresh.',
      'The listing agreement is signed with your brokerage, outside Connexli.',
    ], 'See my new client', APP_URL + '/agent'));
}

module.exports = {
  adminNewAgent, agentApproved, agentRejected, agentsNewRequest,
  sellerProposalsReady, agentWon, passwordReset, zipInfo, zipDistance, RADIUS_MILES,
};
