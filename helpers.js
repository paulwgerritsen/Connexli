// helpers.js — shared constants and small utilities.

const PROPERTY_TYPES = ['Single Family', 'Townhome', 'Condo', 'Duplex', 'Land'];
const BEDS = ['1', '2', '3', '4', '5', '6+'];
const BATHS = ['1', '2', '3', '4', '5+'];
const SQFT = ['Under 1,500', '1,500–2,000', '2,000–2,500', '2,500–3,000', '3,000–4,000', '4,000+'];
const YEARS = ['2020s', '2010–2019', '2000–2009', '1980–1999', 'Before 1980'];
const CONDITIONS = ['Like new', 'Updated', 'Average', 'Needs work'];
const PRIORITIES = ['Lowest listing fee', 'Most experienced', 'Fastest sale', 'Best marketing', 'Highest sale price'];
const SERVICES = ['Professional photos', 'Drone video', 'Open house(s)', 'Social campaign', '3D tour', 'Staging consult', 'Print marketing'];
const CANCELLATION = ['Cancel anytime, no fee', '30-day written notice', 'Locked for listing term'];

const PRICE_RANGES = {
  'Under $300k': 250000,
  '$300k–$500k': 400000,
  '$500k–$750k': 625000,
  '$750k–$1M': 875000,
  '$1M–$1.5M': 1250000,
  '$1.5M+': 1750000,
};

// One number controls the marketplace cap everywhere: each round accepts at
// most this many sealed proposals, then the window closes on the spot.
const ROUND_CAP = 10;

// Three windows (Paul, Aug 12): 72h removed; 48h is the single Recommended
// option; 7 days explains its use cases without competing messaging.
const WINDOWS = [
  { hours: 24,  label: '24 hours', tag: 'Rush',        desc: 'Fastest turnaround. Many agents respond within hours.' },
  { hours: 48,  label: '48 hours', tag: 'Recommended', desc: 'Our recommendation. Fast answers, with enough time for thoughtful proposals.' },
  { hours: 168, label: '7 days',   tag: 'Extended',    desc: 'Useful for luxury homes, unique properties, and rural areas.' },
];

// ---------- buyer-side constants ----------
const B_FINANCING = ['Cash', 'Conventional', 'FHA', 'VA', 'USDA', 'Not sure'];
const B_LENDER = ['Yes — preapproved', 'Yes — prequalified', 'Yes — in conversations', 'No — not yet', "No — I'd like a recommendation"];
const B_DOWN = ['Under 5%', '5–10%', '10–20%', '20%+', 'Cash purchase'];
const B_SITUATION = ['Rent', 'Own', 'Live with family', 'Other'];
const B_SELL_FIRST = ['No', 'Yes — not started', 'Yes — already listed', 'Yes — under contract'];
const B_TIMELINE = ['ASAP', 'Within 30 days', '1–3 months', '3–6 months', '6–12 months', 'Just researching'];
const B_PURPOSE = ['Primary residence', 'Second home', 'Investment'];
const B_BBA = ['No', "Yes — it's expired or cancelled", 'Yes — currently active'];
const B_PRIORITIES = ['Schools', 'Commute', 'Yard/lot size', 'Main-level living', 'Updated/move-in ready', 'Fixer-upper potential', 'New construction', 'Quiet neighborhood', 'Walkability', 'Views', 'Room to grow', 'Investment value'];
// Buyer proposals: two structures only (Paul, Aug 11 — hourly/retainer removed
// from the FORM for simplicity; legacy rows still display via buyerFeeLabel).
const BP_STRUCTURES = { pct: 'Percentage at closing', flat: 'Flat fee at closing' };
// For the relocating-buyer "moving from" dropdown (standardized, no free text).
const US_STATES = ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','District of Columbia','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming','Other / outside the U.S.'];
const BP_TOURS = ['Up to 5 tours included', 'Up to 10 tours included', 'Up to 20 tours included', 'Unlimited tours'];
const BP_RESPONSE = ['Within 1 hour', 'Same day', 'Within 24 hours'];
const BP_SPECIALTIES = ['First-time buyers', 'VA/FHA', 'New construction', 'Relocation', 'Investment', 'Luxury'];

// Readiness badge, computed from Step-1 answers. Never rejects — sorts.
function readiness(p) {
  const preapproved = p.financing_type === 'Cash' || p.lender_status === 'Yes — preapproved';
  const nearTerm = ['ASAP', 'Within 30 days', '1–3 months'].includes(p.timeline);
  const researching = ['6–12 months', 'Just researching'].includes(p.timeline);
  const noLender = ['No — not yet', "No — I'd like a recommendation"].includes(p.lender_status);
  const mustSellUnstarted = p.need_to_sell === 'Yes — not started';
  if (preapproved && nearTerm && !mustSellUnstarted) return 'ready_now';
  if (!preapproved && ((noLender && researching) || p.timeline === 'Just researching')) return 'exploring';
  return 'preparing';
}
const READINESS_LABELS = { ready_now: 'Ready Now', preparing: 'Preparing', exploring: 'Exploring' };

// Label for a buyer proposal's fee structure.
function buyerFeeLabel(p) {
  const amt = parseFloat(p.comp_amount);
  if (p.comp_structure === 'pct') return amt + '% at closing';
  if (p.comp_structure === 'flat') return money(amt) + ' flat fee';
  if (p.comp_structure === 'hourly') return money(amt) + '/hour';
  return money(amt) + ' retainer, credited at closing';
}

function midPrice(range) { return PRICE_RANGES[range] || 875000; }

// Estimated buyer-agent fee at the midpoint of the buyer's price range.
function estBuyerFee(p, priceRange) {
  const amt = parseFloat(p.comp_amount);
  if (p.comp_structure === 'pct') return midPrice(priceRange) * amt / 100;
  if (p.comp_structure === 'flat') return amt;
  return null; // hourly/retainer legacy rows: no midpoint estimate
}

// Window state helpers shared by seller requests and buyer profiles.
function windowOpen(row) {
  return new Date(row.closes_at).getTime() > Date.now() && row.proposal_count < row.proposal_cap;
}
function spotsLeft(row) { return Math.max(0, row.proposal_cap - row.proposal_count); }
function takenThisRound(row) { return Math.max(0, row.proposal_count - (row.proposal_cap - 10)); }

function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

function estFee(proposal, priceRange) {
  const amt = parseFloat(proposal.fee_amount);
  return proposal.fee_type === 'pct' ? midPrice(priceRange) * amt / 100 : amt;
}

function feeLabel(proposal) {
  const amt = parseFloat(proposal.fee_amount);
  return proposal.fee_type === 'pct' ? amt + '%' : money(amt) + ' flat';
}

// Basic input guards
function clean(s, max = 200) { return String(s || '').trim().slice(0, max); }
function oneOf(value, list, fallback) { return list.includes(value) ? value : fallback; }

module.exports = {
  PROPERTY_TYPES, BEDS, BATHS, SQFT, YEARS, CONDITIONS, PRIORITIES, SERVICES,
  CANCELLATION, PRICE_RANGES, WINDOWS, ROUND_CAP,
  B_FINANCING, B_LENDER, B_DOWN, B_SITUATION, B_SELL_FIRST, B_TIMELINE,
  B_PURPOSE, B_BBA, B_PRIORITIES, BP_STRUCTURES, BP_TOURS, BP_RESPONSE, BP_SPECIALTIES, US_STATES,
  readiness, READINESS_LABELS, buyerFeeLabel,
  midPrice, money, estFee, feeLabel, clean, oneOf,
  estBuyerFee, windowOpen, spotsLeft, takenThisRound,
};
