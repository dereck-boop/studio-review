'use strict';
// Studio settings edited on the /admin page: branding, look and notifications.
// Values saved here win over the .env defaults (BRAND, OWNER_NAME, NTFY_URL).
const cfg = require('./config');
const { db } = require('./db');

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

// Fonts bundled in public/fonts (all SIL Open Font License). `track` tightens big headings to suit each face.
const FONTS = {
  'inter-tight': { name: 'Inter Tight', file: 'inter-tight', weights: [400, 500, 600, 700, 800, 900], track: 0 },
  archivo: { name: 'Archivo', file: 'archivo', weights: [400, 500, 600, 700, 800, 900], track: -0.02 },
  'schibsted-grotesk': { name: 'Schibsted Grotesk', file: 'schibsted-grotesk', weights: [400, 500, 600, 700, 800, 900], track: -0.01 },
  'hanken-grotesk': { name: 'Hanken Grotesk', file: 'hanken-grotesk', weights: [400, 500, 600, 700, 800, 900], track: -0.01 },
  'host-grotesk': { name: 'Host Grotesk', file: 'host-grotesk', weights: [400, 500, 600, 700, 800], track: 0 },
  system: { name: 'System (Helvetica / San Francisco)', file: null, weights: [], track: -0.005 },
};

const PAPERS = {
  white: { name: 'White', bg: '#ffffff', panel2: '#f2f2f0', line: '#dcdcdc' },
  warm: { name: 'Warm paper', bg: '#f7f4ee', panel2: '#ece7dc', line: '#d8d1c3' },
  cool: { name: 'Cool grey', bg: '#f3f4f6', panel2: '#e6e8ec', line: '#d3d6dc' },
};
const NIGHTS = {
  black: { name: 'Black', bg: '#0d0d0d', panel2: '#1a1a1a', line: '#2f2f2f' },
  charcoal: { name: 'Charcoal', bg: '#17181a', panel2: '#232528', line: '#36393d' },
  navy: { name: 'Midnight', bg: '#0d1320', panel2: '#18202f', line: '#2b3446' },
};

const DEFAULTS = () => ({
  brand: cfg.BRAND,
  owner: cfg.OWNER_NAME,
  footer: '',
  defaultTheme: 'auto',
  font: 'inter-tight',
  accent: '#d63f26',
  paper: 'white',
  night: 'black',
  ntfyUrl: cfg.NTFY_URL,
  logo: '',
});

let cache = null;
function get() {
  if (cache) return cache;
  const out = DEFAULTS();
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (r.key in out) out[r.key] = r.value;
  }
  cache = out;
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);

// Validates and saves a partial update. Unknown keys and bad values are ignored.
function update(body = {}) {
  const next = {};
  const brand = clean(body.brand, 60);
  if (brand) next.brand = brand;
  const owner = clean(body.owner, 60);
  if (owner) next.owner = owner;
  if (typeof body.footer === 'string') next.footer = clean(body.footer, 200);
  if (['auto', 'light', 'dark'].includes(body.defaultTheme)) next.defaultTheme = body.defaultTheme;
  if (body.font in FONTS) next.font = body.font;
  if (typeof body.accent === 'string' && HEX.test(body.accent)) next.accent = body.accent.toLowerCase();
  if (body.paper in PAPERS) next.paper = body.paper;
  if (body.night in NIGHTS) next.night = body.night;
  if (typeof body.ntfyUrl === 'string') {
    const u = clean(body.ntfyUrl, 300);
    if (u === '' || /^https?:\/\/[^\s]+$/i.test(u)) next.ntfyUrl = u;
  }
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(next)) put.run(k, v);
  cache = null;
  return get();
}

function reset(keys) {
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  for (const k of keys) del.run(k);
  cache = null;
  return get();
}

function setLogo(file) {
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  put.run('logo', file || '');
  cache = null;
}

// ---------- the stylesheet that applies the look ----------
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (rgb) => '#' + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
function luminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);

// Lighten the accent until it reads on the dark background (and darken for light if needed).
function tuneFor(bgHex, accentHex, minRatio) {
  const bg = hexToRgb(bgHex);
  let c = hexToRgb(accentHex);
  const toward = luminance(bg) < 0.2 ? [255, 255, 255] : [0, 0, 0];
  for (let i = 0; i < 12 && contrast(c, bg) < minRatio; i++) c = mix(c, toward, 0.12);
  return c;
}

function themeCss() {
  const s = get();
  const font = FONTS[s.font] || FONTS['inter-tight'];
  const paper = PAPERS[s.paper] || PAPERS.white;
  const night = NIGHTS[s.night] || NIGHTS.black;
  const lightAccent = tuneFor(paper.bg, s.accent, 3);
  const darkAccent = tuneFor(night.bg, s.accent, 4);
  const inkOn = (rgb) => (contrast(rgb, [255, 255, 255]) >= contrast(rgb, [17, 17, 17]) ? '#ffffff' : '#111111');
  const vars = (bg, p, acc) => `--bg:${bg.bg};--panel:${bg.bg};--panel-2:${bg.panel2};--line:${bg.line};--accent:${toHex(acc)};--accent-ink:${inkOn(acc)};--marker:${toHex(acc)};--sel:rgba(${acc.map(Math.round).join(',')},${p});`;
  const out = [];
  if (font.file) {
    for (const w of [400, 500, 600, 700, 800, 900]) {
      const use = font.weights.includes(w) ? w : font.weights[font.weights.length - 1];
      out.push(`@font-face{font-family:'Studio Sans';font-weight:${w};font-display:swap;src:url('/static/fonts/${font.file}-latin-${use}-normal.woff2') format('woff2')}`);
    }
  }
  const family = font.file ? "'Studio Sans'," : '';
  out.push(`:root{${vars(paper, 0.08, lightAccent)}--sans:${family}-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif}`);
  const dark = vars(night, 0.14, darkAccent);
  out.push(`@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}`);
  out.push(`:root[data-theme="dark"]{${dark}}`);
  if (font.track) {
    out.push(`h1.display,h1.proj-title,.project-head h1,.track-head h1.display{letter-spacing:${(-0.015 + font.track).toFixed(3)}em}`);
  }
  return out.join('\n') + '\n';
}

function cssVersion() {
  return require('crypto').createHash('sha1').update(themeCss()).digest('hex').slice(0, 10);
}

module.exports = { get, update, reset, setLogo, themeCss, cssVersion, FONTS, PAPERS, NIGHTS };
