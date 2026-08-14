// mailer.js — all Connexli email notifications, sent through Resend.
// If RESEND_API_KEY is not set, emails are logged to the console instead of
// sent, so the app works in every environment and nothing ever crashes
// because of email.
const zipcodes = require('zipcodes');
const { pool } = require('./db');
const H = require('./helpers');

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
// excludeAgentIds: professionals who already proposed in an earlier round are
// never told about a fresh round — those slots belong to new agents.
async function agentsNewRequest(request, excludeAgentIds = []) {
  try {
    const { rows: agents } = await pool.query(
      `SELECT u.id, u.email, u.name, ap.service_zip FROM users u
       JOIN agent_profiles ap ON ap.user_id = u.id WHERE ap.status = 'approved'`);
    const excluded = new Set(excludeAgentIds.map(Number));
    const newRound = (request.round || 1) > 1;
    let notified = 0, unresolved = 0;
    for (const a of agents) {
      if (excluded.has(Number(a.id))) continue;
      const dist = zipDistance(request.zip, a.service_zip);
      // FAIL CLOSED (Paul, Aug 12): if we cannot compute the distance, we do
      // NOT email — a professional far outside the radius must never be
      // notified because of a data gap. Unresolved ZIPs are counted and
      // logged so they can be fixed in the agent's settings.
      if (dist === null) { unresolved++; continue; }
      if (dist > RADIUS_MILES) continue;
      notified++;
      await send(a.email, newRound ? 'Fresh Round: Connexli Opportunity Near You' : 'New Connexli Opportunity Near You',
        template(newRound ? 'A fresh round just opened near you' : 'New opportunity near you', [
          newRound
            ? `A homeowner in <b>${request.city}, ${request.zip}</b> opened a new round of sealed proposals — reserved for professionals who haven't proposed yet, like you.`
            : `A homeowner in <b>${request.city}, ${request.zip}</b> is inviting sealed proposals from professionals like you.`,
          `Property: <b>${request.property_type}</b><br>Price range: <b>${request.price_range}</b><br>Proposal window closes: <b>${new Date(request.closes_at).toLocaleString('en-US', { timeZone: 'America/Denver' })} (Mountain)</b>`,
          'Submit your sealed proposal before the window closes — it ends early once 10 proposals arrive. Competing professionals never see your pricing.',
        ], 'View Opportunity', APP_URL + '/login'));
    }
    console.log(`Opportunity emails: ${notified}/${agents.length} approved professionals within ${RADIUS_MILES} miles of ${request.zip}${excluded.size ? ` (${excluded.size} prior bidders excluded)` : ''}${unresolved ? ` (${unresolved} skipped: service ZIP unresolvable)` : ''}`);
    if (notified === 0) console.warn(`WARNING: no professionals within ${RADIUS_MILES} miles of ${request.zip} — request ${request.id} will get no notifications.`);
  } catch (e) {
    console.error('agentsNewRequest failed:', e.message);
  }
}

// ---------- buyer-side notifications ----------
// Rough distance from an agent's service ZIP to any of the buyer's named
// cities (buyers think in cities, not ZIPs). Fail-open: unknown city or
// missing data means we notify rather than silently exclude.
function cityDistance(agentZip, cityName) {
  try {
    const zips = zipcodes.lookupByName(String(cityName).trim(), 'UT');
    if (!zips || !zips.length) return null;
    return zipDistance(agentZip, zips[0].zip);
  } catch (e) { return null; }
}

async function agentsNewBuyerProfile(profile, badgeLabel, excludeAgentIds = []) {
  try {
    const { rows: agents } = await pool.query(
      `SELECT u.id, u.email, u.name, ap.service_zip FROM users u
       JOIN agent_profiles ap ON ap.user_id = u.id WHERE ap.status = 'approved'`);
    const excluded = new Set(excludeAgentIds.map(Number));
    const newRound = (profile.round || 1) > 1;
    const cities = String(profile.search_areas).split(',').map(s => s.trim()).filter(Boolean);
    // Prefer the stored lat/lng saved with the profile (standardized city
    // selector, Aug 14) — exact geography, no name-lookup guesswork. Legacy
    // rows without search_geo fall back to the city-name lookup.
    let geo = profile.search_geo;
    if (typeof geo === 'string') { try { geo = JSON.parse(geo); } catch (e) { geo = null; } }
    if (!Array.isArray(geo) || !geo.length) geo = null;
    let notified = 0, unresolved = 0;
    for (const a of agents) {
      if (excluded.has(Number(a.id))) continue;
      let dists;
      if (geo) {
        const z = zipInfo(a.service_zip);
        dists = z ? geo.map(g => H.geoMiles(z.latitude, z.longitude, g.lat, g.lng)) : [];
      } else {
        dists = cities.map(c => cityDistance(a.service_zip, c)).filter(d => d !== null);
      }
      // FAIL CLOSED: no resolvable distance = no email (see agentsNewRequest).
      if (!dists.length) { unresolved++; continue; }
      if (Math.min(...dists) > RADIUS_MILES) continue;
      notified++;
      await send(a.email, newRound ? 'Fresh Round: Connexli Buyer Near You' : 'New Connexli Buyer Near You',
        template(newRound ? 'A buyer opened a fresh round near you' : 'New buyer profile near you', [
          newRound
            ? `A <b>${badgeLabel}</b> buyer looking in <b>${profile.search_areas}</b> opened a new round of sealed proposals — reserved for professionals who haven't proposed yet, like you.`
            : `A <b>${badgeLabel}</b> buyer is looking in <b>${profile.search_areas}</b>.`,
          `Price range: <b>${profile.price_range}</b><br>Timeline: <b>${profile.timeline}</b>${profile.in_utah ? '' : '<br>Relocating from: <b>' + (profile.origin_state || 'out of state') + '</b>'}${profile.closes_at ? '<br>Proposal window closes: <b>' + new Date(profile.closes_at).toLocaleString('en-US', { timeZone: 'America/Denver' }) + ' (Mountain)</b>' : ''}`,
          'Review the anonymous Buyer Snapshot and submit a sealed proposal before the window closes — it ends early once 10 proposals arrive. Competing professionals never see your terms.',
        ], 'View Buyer Snapshot', APP_URL + '/login'));
    }
    console.log(`Buyer-profile emails: ${notified}/${agents.length} approved professionals for areas "${profile.search_areas}"${excluded.size ? ` (${excluded.size} prior bidders excluded)` : ''}${unresolved ? ` (${unresolved} skipped: distance unresolvable)` : ''}`);
    if (notified === 0) console.warn(`WARNING: no professionals matched buyer areas "${profile.search_areas}" — profile ${profile.id} will get no notifications.`);
  } catch (e) {
    console.error('agentsNewBuyerProfile failed:', e.message);
  }
}

function buyerNewProposal(email, name, count, roundFull = false) {
  return send(email, roundFull ? 'Your Connexli proposal set is complete' : 'A buyer’s agent sent you a proposal on Connexli',
    template(roundFull ? 'All 10 proposals are in 🎉' : 'You have a new proposal 🎉', [
      `${name.split(' ')[0]}, a verified buyer's agent just submitted a sealed proposal for your home search.`,
      roundFull
        ? `That fills all <b>10</b> proposal spots for this round — your full set is ready to compare now, sooner than expected. If you'd like even more options after reviewing, you can open another round anytime.`
        : `You now have <b>${count}</b> proposal${count === 1 ? '' : 's'} to compare. Your name and contact info remain hidden until you choose to connect.`,
    ], 'Compare my proposals', APP_URL + '/buyer'));
}

// Mirrors sellerProposalsReady: the buyer's window ended (time or cap) and
// their sealed proposals are ready to compare.
function buyerProposalsReady(email, name, profile, filledEarly = false) {
  return send(email, filledEarly ? 'All proposals are in — ready early' : 'Your buyer-agent proposals are ready',
    template(filledEarly ? 'All proposals are in 🎉' : 'Your proposals are ready 🎉', [
      filledEarly
        ? `${name.split(' ')[0]}, your buyer request filled every proposal spot before the window even ended — so we closed it and your proposals are ready now, sooner than expected.`
        : `${name.split(' ')[0]}, the proposal window for your home search in ${profile.search_areas} has closed.`,
      'Log in to compare every sealed proposal side by side: compensation, tours, response times, and each agent\'s plan for you.',
      'Want more options after reviewing? You can receive 10 more proposals — shown only to agents who haven\'t proposed yet. Your name and contact info stay hidden until you choose to connect.',
    ], 'Compare my proposals', APP_URL + '/buyer'));
}

function buyerAgentWon(email, name, profile) {
  return send(email, 'Congratulations — a buyer chose your proposal',
    template('A buyer chose your proposal 🎉', [
      `${name.split(' ')[0]}, a buyer searching in ${profile.search_areas} compared their sealed proposals and chose yours. Their contact information has been released to you.`,
      'Their details are on your dashboard. Reach out within 24 hours while the decision is fresh.',
      'The buyer representation agreement is signed with your brokerage, outside Connexli.',
    ], 'See my new client', APP_URL + '/agent'));
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

// Instant confirmation the moment a seller's request goes live. Requested by
// Paul (Aug 7): reassure the requester right away, then the "ready" email
// closes the loop later.
function sellerRequestReceived(email, name, request) {
  return send(email, 'Your Connexli request is live',
    template('Your request is live 🏡', [
      `${name.split(' ')[0]}, thanks for inviting proposals — verified professionals near ${request.city} are being notified right now.`,
      `Your proposal window closes <b>${new Date(request.closes_at).toLocaleString('en-US', { timeZone: 'America/Denver' })} (Mountain)</b> — or the moment all 10 proposal spots fill, whichever comes first.`,
      "You don't need to do anything. We'll email you the instant your sealed proposals are ready to compare. Your address and contact info stay hidden until you choose to share them.",
    ], 'Watch my request', APP_URL + '/requests/' + request.id));
}

// Same confirmation for buyers when their profile publishes to agents.
function buyerProfileLive(email, name, profile) {
  return send(email, 'Your buyer profile is live',
    template('Your profile is live 🔑', [
      `${name.split(' ')[0]}, thanks for creating your buyer profile — verified buyer's agents near ${profile.search_areas} are being notified right now.`,
      "You don't need to do anything. We'll email you as each sealed proposal arrives (up to 10 this round), and your name and contact info stay hidden until you choose to connect.",
    ], 'See my profile', APP_URL + '/buyer'));
}

function sellerProposalsReady(email, name, request, filledEarly = false) {
  return send(email, filledEarly ? 'All 10 proposals are in — ready early' : 'Your Connexli proposals are ready',
    template(filledEarly ? 'All 10 proposals are in 🎉' : 'Your proposals are ready 🎉', [
      filledEarly
        ? `${name.split(' ')[0]}, your ${request.property_type.toLowerCase()} in ${request.city} filled all 10 proposal spots before the window even ended — so we closed it and your proposals are ready now, sooner than expected.`
        : `${name.split(' ')[0]}, the proposal window for your ${request.property_type.toLowerCase()} in ${request.city} has closed.`,
      'Log in to compare every proposal side by side: fees, services, marketing plans, and cancellation terms.',
      filledEarly
        ? 'If you want even more options after reviewing, you can open another round — shown only to professionals who haven\'t proposed yet. Your contact info stays hidden until you choose to share it.'
        : 'Your address and contact info are still hidden until you choose to share them.',
    ], 'Compare my proposals', APP_URL + '/requests/' + request.id));
}

function agentWon(email, name, request) {
  return send(email, 'Congratulations — a homeowner chose your proposal',
    template('A homeowner chose your proposal 🎉', [
      `${name.split(' ')[0]}, the homeowner in ${request.city} compared their sealed proposals and chose yours. Their contact information has been released to you.`,
      'Their details are on your dashboard. Reach out within 24 hours while the decision is fresh.',
      'The listing agreement is signed with your brokerage, outside Connexli.',
    ], 'See my new client', APP_URL + '/agent'));
}

module.exports = {
  adminNewAgent, agentApproved, agentRejected, agentsNewRequest,
  sellerRequestReceived, buyerProfileLive,
  sellerProposalsReady, agentWon, passwordReset,
  agentsNewBuyerProfile, buyerNewProposal, buyerProposalsReady, buyerAgentWon, cityDistance,
  zipInfo, zipDistance, RADIUS_MILES,
};
