'use strict';
const crypto = require('crypto');
const { SECRET, ADMIN_PASSWORD } = require('./config');

const ADMIN_MAX_AGE = 30 * 24 * 3600 * 1000;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
  }
  return out;
}

const sign = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function setCookie(res, req, name, value, maxAgeMs) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeMs != null) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function isAdmin(req) {
  const c = req.cookies.qh_admin;
  if (!c) return false;
  const [ts, sig] = c.split('.');
  const t = parseInt(ts, 10);
  if (!Number.isFinite(t) || Date.now() - t > ADMIN_MAX_AGE) return false;
  return safeEqual(sign('admin.' + ts), sig);
}

function loginAdmin(req, res) {
  const ts = String(Date.now());
  setCookie(res, req, 'qh_admin', `${ts}.${sign('admin.' + ts)}`, ADMIN_MAX_AGE);
}

function logoutAdmin(req, res) {
  setCookie(res, req, 'qh_admin', '', 0);
}

function checkPassword(pw) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(pw), h(ADMIN_PASSWORD));
}

function hashPasscode(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(p), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPasscode(p, stored) {
  if (!stored) return true;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(p), salt, 32).toString('hex');
  return safeEqual(test, hash);
}

// Cookie proves the viewer typed this share's passcode; changing the passcode invalidates it.
const shareCookieName = (share) => 'qh_s_' + share.id;
const shareCookieValue = (share) => sign('share.' + share.id + '.' + share.passcode_hash);

function shareUnlocked(req, share) {
  if (!share.passcode_hash) return true;
  return safeEqual(req.cookies[shareCookieName(share)] || '', shareCookieValue(share));
}

function unlockShare(req, res, share) {
  setCookie(res, req, shareCookieName(share), shareCookieValue(share), 90 * 24 * 3600 * 1000);
}

// Tiny in-memory limiter for password guesses.
const attempts = new Map();
function rateLimited(key, max = 8, windowMs = 15 * 60 * 1000) {
  const t = Date.now();
  const list = (attempts.get(key) || []).filter((x) => t - x < windowMs);
  attempts.set(key, list);
  return list.length >= max;
}
function recordFailure(key) {
  const list = attempts.get(key) || [];
  list.push(Date.now());
  attempts.set(key, list);
}

module.exports = {
  parseCookies, setCookie, isAdmin, loginAdmin, logoutAdmin, checkPassword, hashPasscode, verifyPasscode,
  shareUnlocked, unlockShare, rateLimited, recordFailure,
};
