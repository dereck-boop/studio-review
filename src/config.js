'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load .env from the project folder when running with `npm start` (Docker passes it in already).
// Real environment variables always win over the file.
(function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dirs = {
  root: DATA_DIR,
  originals: path.join(DATA_DIR, 'originals'),
  stream: path.join(DATA_DIR, 'stream'),
  peaks: path.join(DATA_DIR, 'peaks'),
  tmp: path.join(DATA_DIR, 'tmp'),
  art: path.join(DATA_DIR, 'art'),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (ADMIN_PASSWORD.length < 8) {
  console.error('Set ADMIN_PASSWORD (at least 8 characters) before starting.');
  process.exit(1);
}

module.exports = {
  PORT: parseInt(process.env.PORT || '8080', 10),
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR,
  dirs,
  ADMIN_PASSWORD,
  SECRET: loadSecret(),
  BRAND: process.env.BRAND || 'Studio Review',
  OWNER_NAME: process.env.OWNER_NAME || 'Engineer',
  // PUBLIC_URL wins; otherwise derive it from DOMAIN (the same value Caddy uses for HTTPS).
  PUBLIC_URL: (process.env.PUBLIC_URL || (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : '')).replace(/\/$/, ''),
  WATCH_DIR: process.env.WATCH_DIR ? path.resolve(process.env.WATCH_DIR) : '',
  NTFY_URL: process.env.NTFY_URL || '',
  TRUST_PROXY: process.env.TRUST_PROXY === '1',
};
