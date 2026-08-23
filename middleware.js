// middleware.js — login guards and CSRF protection.
const crypto = require('crypto');

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== role) return res.status(403).render('error', { title: 'Not allowed', message: 'You do not have access to that page.' });
    next();
  };
}

// Simple CSRF: a random token stored in the session, required on every POST.
// /waitlist is exempt (Paul, Aug 23): the connexli.com marketing site posts
// to it cross-origin with no session, and the endpoint touches no account —
// it's protected by validation, a honeypot, and a rate limit instead.
const CSRF_EXEMPT = new Set(['/waitlist']);
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.method === 'POST' && !CSRF_EXEMPT.has(req.path)) {
    if (req.body._csrf !== req.session.csrf) {
      return res.status(403).render('error', { title: 'Session expired', message: 'Your session expired. Please go back and try again.' });
    }
  }
  next();
}

// Wraps a router so that errors thrown inside async page handlers are passed
// to the error page instead of crashing the whole server.
function safeRouter(router) {
  const wrap = (fn) => fn.length >= 4 ? fn : (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  ['get', 'post'].forEach((method) => {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) => original(path, ...handlers.map(wrap));
  });
  return router;
}

module.exports = { requireLogin, requireRole, csrf, safeRouter };

