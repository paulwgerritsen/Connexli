// proposal-input.js — reads and checks a professional's proposal form.
//
// ONE place for both proposal types (Sep 30), used by:
//   - the live submit routes (routes/agent.js), and
//   - the practice proposals (routes/practice.js).
// So if a proposal field or rule changes here, the practice version changes
// with it automatically — they can never drift apart.
//
// Each function returns { values, form, error }:
//   values — the cleaned values to save (live) or preview (practice)
//   form   — what to put back in the form when showing an error
//   error  — a friendly message, or null when everything is valid
const H = require('./helpers');

function list(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

// Listing (seller-side) proposal.
function sellerProposal(body) {
  const fee_type = body.fee_type === 'flat' ? 'flat' : 'pct';
  const fee_amount = parseFloat(String(body.fee_amount).replace(/[^0-9.]/g, ''));
  const services = list(body.services).filter(s => H.SERVICES.includes(s));
  const marketing_plan = H.clean(body.marketing_plan, 2000);
  const cancellation_terms = H.oneOf(body.cancellation_terms, H.CANCELLATION, H.CANCELLATION[0]);
  const listing_ack = body.listing_ack === 'yes' ? 'yes' : '';

  const bad = !fee_amount || fee_amount <= 0 ||
    (fee_type === 'pct' && fee_amount > 10) ||
    (fee_type === 'flat' && fee_amount > 200000);
  let error = null;
  if (bad) {
    error = fee_type === 'pct'
      ? 'Please enter a percentage fee between 0.1 and 10.'
      : 'Please enter a flat fee amount in dollars (up to $200,000).';
  } else if (!listing_ack) {
    error = 'Please confirm the listing-side compensation acknowledgement before submitting.';
  }
  return {
    values: { fee_type, fee_amount, services, marketing_plan, cancellation_terms, listing_ack },
    form: { fee_type, fee_amount: body.fee_amount, services: services.join(', '), marketing_plan, cancellation_terms, listing_ack },
    error,
  };
}

// Buyer-agent proposal.
function buyerProposal(body) {
  const comp_structure = ['pct', 'flat'].includes(body.comp_structure) ? body.comp_structure : 'pct';
  // Shortfall policy (Paul, Sep 1 UX #2):
  //  buyer_pays — seller-paid compensation is credited toward the proposed
  //              fee; the buyer covers any remaining amount.
  //  min_fee   — the professional accepts the seller-paid amount, subject to
  //              a REQUIRED minimum compensation figure.
  // gap_responsibility is still stored (derived) so historical displays and
  // analytics keep working.
  const shortfall_policy = body.shortfall_policy === 'min_fee' ? 'min_fee' : 'buyer_pays';
  const gap_responsibility = shortfall_policy === 'buyer_pays' ? 'Yes' : 'No';
  const comp_amount = parseFloat(String(body.comp_amount).replace(/[^0-9.]/g, ''));
  const min_fee = shortfall_policy === 'min_fee'
    ? (String(body.min_fee || '').trim() === '' ? NaN : parseFloat(String(body.min_fee).replace(/[^0-9.]/g, '')))
    : null; // Option A has no minimum-fee concept
  const specialties = list(body.specialties).filter(s => H.BP_SPECIALTIES.includes(s));
  const fields = {
    // Tours-included and rebate are no longer collected (Paul, Sep 1 UX #1/#9).
    video_tours: body.video_tours === 'yes',
    response_time: H.oneOf(body.response_time, H.BP_RESPONSE, H.BP_RESPONSE[1]),
    seller_contribution: H.clean(body.seller_contribution, 300),
    plan: H.clean(body.plan, 2000),
  };

  const badFee = !comp_amount || comp_amount <= 0 ||
    (comp_structure === 'pct' && comp_amount > 10) ||
    (comp_structure === 'flat' && comp_amount > 100000);
  const badMin = shortfall_policy === 'min_fee' && (Number.isNaN(min_fee) || min_fee <= 0 || min_fee > 100000);
  let error = null;
  if (badFee) {
    error = 'Please enter a valid amount for the fee structure you chose (percentages up to 10, or a flat dollar amount in a reasonable range).';
  } else if (badMin) {
    error = 'You chose "subject to a minimum fee" — please enter the minimum compensation you will accept (a dollar amount in a reasonable range).';
  }
  return {
    values: { comp_structure, comp_amount, min_fee, shortfall_policy, gap_responsibility, specialties, ...fields },
    form: { comp_structure, comp_amount: body.comp_amount, min_fee: body.min_fee, specialties: specialties.join(', '), shortfall_policy, gap_responsibility, ...fields },
    error,
  };
}

module.exports = { sellerProposal, buyerProposal };
