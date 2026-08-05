// helpers.js — shared constants and small utilities.

const PROPERTY_TYPES = ['Single Family', 'Townhome', 'Condo', 'Duplex', 'Land'];
const BEDS = ['1', '2', '3', '4', '5', '6+'];
const BATHS = ['1', '2', '3', '4', '5+'];
const SQFT = ['Under 1,500', '1,500–2,000', '2,000–2,500', '2,500–3,000', '3,000–4,000', '4,000+'];
const YEARS = ['2020s', '2010–2019', '2000–2009', '1980–1999', 'Before 1980'];
const CONDITIONS = ['Like new', 'Updated', 'Average', 'Needs work'];
const PRIORITIES = ['Lowest commission', 'Most experienced', 'Fastest sale', 'Best marketing', 'Highest sale price'];
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

const WINDOWS = [
  { hours: 24,  label: '24 hours', tag: 'Rush',         desc: 'Fastest turnaround. Many agents respond within hours.' },
  { hours: 48,  label: '48 hours', tag: 'Fast track',   desc: "Great if you're ready to meet agents this week." },
  { hours: 72,  label: '72 hours', tag: 'Recommended',  desc: 'Our recommendation. Gives agents enough time to prepare thoughtful proposals.' },
  { hours: 168, label: '7 days',   tag: 'Extend',       desc: "Best for luxury homes, unique properties, rural areas, or if you're not in a hurry." },
];

function midPrice(range) { return PRICE_RANGES[range] || 875000; }

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
  CANCELLATION, PRICE_RANGES, WINDOWS,
  midPrice, money, estFee, feeLabel, clean, oneOf,
};
