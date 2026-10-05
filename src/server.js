'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const cfg = require('./config');
const { db, newId, now } = require('./db');
const lib = require('./library');
const jobs = require('./jobs');
const auth = require('./auth');
const watch = require('./watch');
const { FORMATS } = require('./markers');
const { notify } = require('./notify');
const media = require('./media');

const app = express();
app.disable('x-powered-by');
if (cfg.TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  req.cookies = auth.parseCookies(req.headers.cookie);
  req.isAdmin = auth.isAdmin(req);
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '30d', immutable: true }));
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

// ---------- helpers ----------
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clientIp = (req) => req.ip || req.socket.remoteAddress || '?';

function fixName(n) {
  // Browsers send UTF-8 filenames; busboy may read them as latin1.
  const fixed = Buffer.from(n, 'latin1').toString('utf8');
  return fixed.includes('�') ? n : fixed;
}

// Changes whenever app.js/app.css change, so browsers fetch the new version right after a deploy.
const ASSET_V = (() => {
  const h = require('crypto').createHash('sha1');
  for (const f of ['app.js', 'app.css']) h.update(fs.readFileSync(path.join(__dirname, '..', 'public', f)));
  return h.digest('hex').slice(0, 10);
})();

function shell(boot, theme) {
  const json = JSON.stringify(boot).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"${theme ? ` data-theme="${theme}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${cfg.BRAND.replace(/[<>&"]/g, '')}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%23111'/%3E%3Cpath d='M3 8h1M5 5v6M7 3v10M9 6v4M11 4v8M13 7v2' stroke='%23e8a33d' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/static/app.css?v=${ASSET_V}">
<script id="boot" type="application/json">${json}</script>
<script src="/static/app.js?v=${ASSET_V}" defer></script>
</head>
<body><div id="app"></div></body>
</html>`;
}

// Resolves a share token and checks expiry + passcode. Returns { share } or { status, error }.
function resolveShare(req, token) {
  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(String(token || ''));
  if (!share) return { status: 404, error: 'This link does not exist or was revoked.' };
  if (share.expires_at && share.expires_at < now()) return { status: 410, error: 'This link has expired.' };
  if (!req.isAdmin && !auth.shareUnlocked(req, share)) return { status: 401, error: 'passcode', needsPasscode: true, share };
  return { share };
}

function shareCoversTrack(share, track) {
  if (!track || track.project_id !== share.project_id) return false;
  return !share.track_id || share.track_id === track.id;
}

function shareOut(s) {
  const track = s.track_id ? db.prepare('SELECT name FROM tracks WHERE id = ?').get(s.track_id) : null;
  return {
    id: s.id,
    token: s.token,
    url: `${cfg.PUBLIC_URL}/s/${s.token}`,
    scope: s.track_id ? 'track' : 'project',
    trackId: s.track_id,
    trackName: track ? track.name : null,
    label: s.label,
    hasPasscode: !!s.passcode_hash,
    allowDownload: !!s.allow_download,
    expiresAt: s.expires_at,
    createdAt: s.created_at,
    activity: shareStats(s.id),
  };
}

// ---------- link activity ----------
// Guests get an anonymous browser id (qh_v) so repeat visits and different people can be told apart.
// Nothing is logged for you (the admin cookie), so opening your own links doesn't count.
const VISITOR_RE = /^[A-Za-z0-9_-]{16,32}$/;
function ensureVisitor(req, res) {
  if (req.isAdmin) return null;
  let v = req.cookies.qh_v;
  if (!VISITOR_RE.test(v || '')) {
    v = newId(12);
    auth.setCookie(res, req, 'qh_v', v, 400 * 24 * 3600 * 1000);
    req.cookies.qh_v = v;
  }
  return v;
}

function deviceOf(ua) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook'
      : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : '';
  if (!os && !br) return 'Unknown device';
  return br && os ? `${br} on ${os}` : br || os;
}

const DEDUPE_MS = 30 * 60 * 1000;
function logEvent(req, share, kind, { trackId = null, versionId = null, name = '' } = {}) {
  if (req.isAdmin || !share) return;
  const visitor = req.cookies.qh_v;
  if (!VISITOR_RE.test(visitor || '')) return;
  const t = now();
  // Opens/track views count once per visitor per 30 minutes (the player polls in the background).
  if (kind === 'open' || kind === 'track') {
    const dup = db.prepare(`SELECT 1 FROM share_events WHERE share_id = ? AND visitor = ? AND kind = ?
      AND COALESCE(track_id, '') = ? AND created_at > ?`).get(share.id, visitor, kind, trackId || '', t - DEDUPE_MS);
    if (dup) return;
  }
  const firstEver = !db.prepare('SELECT 1 FROM share_events WHERE share_id = ? AND visitor = ?').get(share.id, visitor);
  const ua = String(req.headers['user-agent'] || '').slice(0, 400);
  db.prepare(`INSERT INTO share_events (id, share_id, visitor, name, kind, track_id, version_id, ua, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId(), share.id, visitor, String(name || '').slice(0, 60), kind, trackId, versionId, ua, t);
  if (firstEver) {
    const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(share.project_id);
    const label = share.label || (project ? project.name : 'your link');
    notify(`Link opened: ${label}`, `Someone new opened it (${deviceOf(ua)})`, cfg.PUBLIC_URL ? `${cfg.PUBLIC_URL}/#/p/${share.project_id}` : undefined);
  }
}

// Latest name each visitor has typed (they enter it once to comment; it's kept in their browser).
function visitorNames(visitors) {
  const out = new Map();
  const q = db.prepare(`SELECT name FROM share_events WHERE visitor = ? AND name <> '' ORDER BY created_at DESC LIMIT 1`);
  for (const v of visitors) { const r = q.get(v); if (r) out.set(v, r.name); }
  return out;
}

function shareStats(shareId) {
  const s = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind = 'open' THEN 1 ELSE 0 END), 0) AS opens,
      COALESCE(SUM(CASE WHEN kind = 'play' THEN 1 ELSE 0 END), 0) AS plays,
      COALESCE(SUM(CASE WHEN kind = 'download' THEN 1 ELSE 0 END), 0) AS downloads,
      COUNT(DISTINCT visitor) AS visitors,
      MAX(created_at) AS last_seen
    FROM share_events WHERE share_id = ?`).get(shareId);
  const vs = db.prepare('SELECT DISTINCT visitor FROM share_events WHERE share_id = ?').all(shareId).map((r) => r.visitor);
  const names = [...new Set(visitorNames(vs).values())];
  return { opens: s.opens, plays: s.plays, downloads: s.downloads, visitors: s.visitors, lastSeen: s.last_seen, names };
}

function insertComment({ versionId, parentId, author, isOwner, body, start, end }) {
  const v = db.prepare('SELECT v.*, t.project_id FROM versions v JOIN tracks t ON t.id = v.track_id WHERE v.id = ?').get(versionId);
  if (!v) throw Object.assign(new Error('Version not found'), { status: 404 });
  let s = Math.max(0, num(start) ?? 0);
  let e = num(end);
  if (v.duration) s = Math.min(s, v.duration);
  if (e != null) {
    e = Math.min(Math.max(e, 0), v.duration || e);
    if (e - s < 0.05) e = null;
  }
  if (parentId) {
    const p = db.prepare('SELECT * FROM comments WHERE id = ? AND version_id = ?').get(parentId, versionId);
    if (!p) throw Object.assign(new Error('Parent comment not found'), { status: 400 });
    if (p.parent_id) parentId = p.parent_id; // keep threads one level deep
    s = p.start_time;
    e = p.end_time;
  }
  const id = newId();
  db.prepare(`INSERT INTO comments (id, version_id, parent_id, author, is_owner, body, start_time, end_time, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, versionId, parentId || null, author, isOwner ? 1 : 0, body, s, e, now());
  lib.touchProject(v.project_id);
  return lib.commentOut(db.prepare('SELECT * FROM comments WHERE id = ?').get(id));
}

const upload = multer({
  dest: cfg.dirs.tmp,
  limits: { fileSize: 4 * 1024 ** 3, files: 50 },
  fileFilter: (req, file, cb) => {
    file.originalname = fixName(file.originalname);
    cb(null, lib.AUDIO_EXT.has(path.extname(file.originalname).toLowerCase()));
  },
});

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.bmp']);
const artUpload = multer({
  dest: cfg.dirs.tmp,
  limits: { fileSize: 40 * 1024 ** 2, files: 1 },
  fileFilter: (req, file, cb) => cb(null, IMAGE_EXT.has(path.extname(file.originalname).toLowerCase()) || /^image\//.test(file.mimetype)),
});

// ---------- pages ----------
const themeOf = (req) => (['light', 'dark'].includes(req.cookies.qh_theme) ? req.cookies.qh_theme : '');
const boot = (extra) => ({ brand: cfg.BRAND, owner: cfg.OWNER_NAME, publicUrl: cfg.PUBLIC_URL, ...extra });

app.use((req, res, next) => { if (!req.path.startsWith('/static/') && !req.path.startsWith('/media/')) res.set('Cache-Control', 'no-cache'); next(); });
app.get('/', (req, res) => res.type('html').send(shell(boot({ mode: 'admin' }), themeOf(req))));
app.get('/s/:token', (req, res) => {
  const exists = db.prepare('SELECT 1 FROM shares WHERE token = ?').get(req.params.token);
  if (!exists) return res.status(404).type('html').send(shell(boot({ mode: 'missing' }), themeOf(req)));
  res.type('html').send(shell(boot({ mode: 'share', token: req.params.token }), themeOf(req)));
});

// ---------- session ----------
app.get('/api/me', (req, res) => res.json({ admin: req.isAdmin }));

app.post('/api/login', (req, res) => {
  const key = 'login:' + clientIp(req);
  if (auth.rateLimited(key)) return fail(res, 429, 'Too many attempts. Try again in a few minutes.');
  if (!auth.checkPassword(str(req.body?.password, 500))) {
    auth.recordFailure(key);
    return fail(res, 401, 'Wrong password');
  }
  auth.loginAdmin(req, res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  auth.logoutAdmin(req, res);
  res.json({ ok: true });
});

// ---------- share (guest) API ----------
const S = express.Router({ mergeParams: true });

S.post('/unlock', (req, res) => {
  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(req.params.token);
  if (!share) return fail(res, 404, 'This link does not exist or was revoked.');
  const key = 'share:' + share.id + ':' + clientIp(req);
  if (auth.rateLimited(key, 10)) return fail(res, 429, 'Too many attempts. Try again in a few minutes.');
  if (!auth.verifyPasscode(str(req.body?.passcode, 200), share.passcode_hash)) {
    auth.recordFailure(key);
    return fail(res, 401, 'Wrong passcode');
  }
  auth.unlockShare(req, res, share);
  res.json({ ok: true });
});

S.use((req, res, next) => {
  const r = resolveShare(req, req.params.token);
  if (r.error) return fail(res, r.status, r.error, r.needsPasscode ? { needsPasscode: true } : {});
  req.share = r.share;
  ensureVisitor(req, res);
  next();
});

S.get('/', (req, res) => {
  const s = req.share;
  logEvent(req, s, 'open');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(s.project_id);
  res.json({
    share: { scope: s.track_id ? 'track' : 'project', allowDownload: !!s.allow_download, label: s.label },
    project: lib.projectOut(project),
    tracks: lib.tracksForProject(s.project_id, s.track_id),
  });
});

S.get('/tracks/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!shareCoversTrack(req.share, t)) return fail(res, 404, 'Not found');
  const d = lib.trackDetail(t.id, req.share.track_id ? 'track' : 'project');
  d.allowDownload = !!req.share.allow_download;
  logEvent(req, req.share, 'open');
  logEvent(req, req.share, 'track', { trackId: t.id });
  res.json(d);
});

// The player reports the first play of each version per page view.
S.post('/events', (req, res) => {
  const kind = str(req.body?.kind, 20);
  if (kind !== 'play') return fail(res, 400, 'Unknown event');
  const v = db.prepare('SELECT v.id, v.track_id, t.project_id FROM versions v JOIN tracks t ON t.id = v.track_id WHERE v.id = ?').get(str(req.body?.versionId, 40));
  if (!v || !shareCoversTrack(req.share, { id: v.track_id, project_id: v.project_id })) return fail(res, 404, 'Not found');
  const key = 'event:' + clientIp(req);
  if (auth.rateLimited(key, 300, 10 * 60 * 1000)) return res.json({ ok: true });
  auth.recordFailure(key);
  logEvent(req, req.share, 'play', { trackId: v.track_id, versionId: v.id, name: str(req.body?.name, 60) });
  res.json({ ok: true });
});

S.post('/versions/:vid/comments', (req, res) => {
  // v here is the track row that owns the version.
  const v = db.prepare('SELECT t.* FROM versions v JOIN tracks t ON t.id = v.track_id WHERE v.id = ?').get(req.params.vid);
  if (!v || !shareCoversTrack(req.share, v)) return fail(res, 404, 'Not found');
  const author = str(req.body?.author, 60);
  const body = str(req.body?.body, 4000);
  if (!author) return fail(res, 400, 'Add your name first');
  if (!body) return fail(res, 400, 'Comment is empty');
  const key = 'comment:' + clientIp(req);
  if (auth.rateLimited(key, 120, 10 * 60 * 1000)) return fail(res, 429, 'Slow down a little.');
  auth.recordFailure(key);
  try {
    const c = insertComment({ versionId: req.params.vid, parentId: str(req.body?.parentId, 40) || null, author, isOwner: false, body, start: req.body?.start, end: req.body?.end });
    logEvent(req, req.share, 'comment', { trackId: v.id, versionId: req.params.vid, name: author });
    const ver = db.prepare('SELECT number FROM versions WHERE id = ?').get(req.params.vid);
    const mm = Math.floor(c.start / 60);
    const ss = String(Math.floor(c.start % 60)).padStart(2, '0');
    notify(`${author} on ${v.name} v${ver.number}`, `@${mm}:${ss} ${body}`, cfg.PUBLIC_URL ? `${cfg.PUBLIC_URL}/#/t/${v.id}` : undefined);
    res.status(201).json(c);
  } catch (e) {
    fail(res, e.status || 500, e.message);
  }
});

app.use('/api/s/:token', S);

// ---------- media ----------
app.get('/media/:vid/:kind', (req, res, next) => {
  const { kind } = req.params;
  if (!['stream', 'peaks', 'original'].includes(kind)) return next();
  const v = db.prepare('SELECT v.*, t.project_id, t.name AS track_name FROM versions v JOIN tracks t ON t.id = v.track_id WHERE v.id = ?').get(req.params.vid);
  if (!v) return fail(res, 404, 'Not found');
  if (!req.isAdmin) {
    const r = resolveShare(req, req.query.s);
    if (r.error) return fail(res, r.status, r.error);
    if (!shareCoversTrack(r.share, { id: v.track_id, project_id: v.project_id })) return fail(res, 404, 'Not found');
    if (kind === 'original' && !r.share.allow_download) return fail(res, 403, 'Downloads are off for this link');
    if (kind === 'original') logEvent(req, r.share, 'download', { trackId: v.track_id, versionId: v.id });
  }
  res.set('Cache-Control', 'private, max-age=3600');
  if (kind === 'original') {
    const ext = path.extname(v.original_path);
    const safe = v.track_name.replace(/[\\/:*?"<>|]+/g, '-');
    return res.download(v.original_path, `${safe} v${v.number}${ext}`);
  }
  const file = kind === 'stream' ? v.stream_path : v.peaks_path;
  if (v.status !== 'ready' || !file || !fs.existsSync(file)) return fail(res, 409, 'Still processing');
  res.sendFile(file);
});

// Lossless stream for gapless album playback (admin only): the original, re-wrapped as FLAC on the fly.
app.get('/media/:vid/lossless', (req, res) => {
  if (!req.isAdmin) return fail(res, 401, 'Sign in required');
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(req.params.vid);
  if (!v || !fs.existsSync(v.original_path)) return fail(res, 404, 'Not found');
  const ff = require('child_process').spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', v.original_path,
    '-map', '0:a:0', '-map_metadata', '-1', '-c:a', 'flac', '-compression_level', '1', '-f', 'flac', 'pipe:1'],
  { stdio: ['ignore', 'pipe', 'ignore'] });
  res.set({ 'Content-Type': 'audio/flac', 'Cache-Control': 'private, max-age=3600' });
  ff.stdout.pipe(res);
  ff.on('error', () => res.destroy());
  ff.on('close', (code) => { if (code !== 0) res.destroy(); });
  req.on('close', () => ff.kill('SIGKILL'));
});

// Album art. Filenames change on every upload, so browsers can cache them forever.
app.get('/art/:pid/:file', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.pid);
  if (!p || !p.art_path) return fail(res, 404, 'Not found');
  const base = path.basename(p.art_path, '.jpg');
  const file = req.params.file === `${base}.jpg` ? p.art_path : req.params.file === `${base}-t.jpg` ? p.art_path.replace(/\.jpg$/, '-t.jpg') : null;
  if (!file) return fail(res, 404, 'Not found');
  if (!req.isAdmin) {
    const r = resolveShare(req, req.query.s);
    if (r.error) return fail(res, r.status, r.error);
    if (r.share.project_id !== p.id) return fail(res, 404, 'Not found');
  }
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(file);
});

// ---------- admin API ----------
const A = express.Router();
A.use((req, res, next) => (req.isAdmin ? next() : fail(res, 401, 'Sign in required')));

A.get('/projects', (req, res) => {
  const rows = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM tracks t WHERE t.project_id = p.id) AS track_count,
      (SELECT COUNT(*) FROM comments c JOIN versions v ON v.id = c.version_id JOIN tracks t ON t.id = v.track_id
        WHERE t.project_id = p.id AND c.resolved = 0 AND c.parent_id IS NULL) AS open_comments
    FROM projects p ORDER BY p.updated_at DESC`).all();
  res.json({ projects: rows.map((p) => ({ ...lib.projectOut(p), clientId: p.client_id || null, trackCount: p.track_count, openComments: p.open_comments })) });
});

// ---------- clients (top level: a band, label or company that owns projects) ----------
const clientOut = (c) => ({ id: c.id, name: c.name, createdAt: c.created_at });
function validClientId(v) {
  const id = str(v, 40);
  if (!id) return null;
  return db.prepare('SELECT 1 FROM clients WHERE id = ?').get(id) ? id : undefined;
}

A.get('/clients', (req, res) => {
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id) AS project_count
    FROM clients c ORDER BY c.name COLLATE NOCASE`).all();
  res.json({ clients: rows.map((c) => ({ ...clientOut(c), projectCount: c.project_count })) });
});

A.post('/clients', (req, res) => {
  const name = str(req.body?.name, 200);
  if (!name) return fail(res, 400, 'Name required');
  const dupe = db.prepare('SELECT * FROM clients WHERE name = ? COLLATE NOCASE').get(name);
  if (dupe) return res.json(clientOut(dupe));
  const id = newId();
  db.prepare('INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now());
  res.status(201).json(clientOut(db.prepare('SELECT * FROM clients WHERE id = ?').get(id)));
});

A.patch('/clients/:id', (req, res) => {
  const name = str(req.body?.name, 200);
  if (!name) return fail(res, 400, 'Name required');
  db.prepare('UPDATE clients SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json({ ok: true });
});

// Deleting a client keeps its projects; they just become unassigned.
A.delete('/clients/:id', (req, res) => {
  db.prepare('UPDATE projects SET client_id = NULL WHERE client_id = ?').run(req.params.id);
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

A.post('/projects', (req, res) => {
  const name = str(req.body?.name, 200);
  if (!name) return fail(res, 400, 'Name required');
  const clientId = validClientId(req.body?.clientId);
  if (clientId === undefined) return fail(res, 400, 'Client not found');
  const p = lib.createProject(name, str(req.body?.artist, 200));
  if (clientId) db.prepare('UPDATE projects SET client_id = ? WHERE id = ?').run(clientId, p.id);
  res.status(201).json(lib.projectOut(p));
});

A.get('/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return fail(res, 404, 'Not found');
  const client = p.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id) : null;
  res.json({ project: { ...lib.projectOut(p), clientId: client ? client.id : null }, client: client ? clientOut(client) : null, tracks: lib.tracksForProject(p.id) });
});

A.patch('/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return fail(res, 404, 'Not found');
  const name = req.body?.name != null ? str(req.body.name, 200) || p.name : p.name;
  const artist = req.body?.artist != null ? str(req.body.artist, 200) : p.artist;
  let clientId = p.client_id;
  if (req.body && 'clientId' in req.body) {
    clientId = validClientId(req.body.clientId);
    if (clientId === undefined) return fail(res, 400, 'Client not found');
  }
  db.prepare('UPDATE projects SET name = ?, artist = ?, client_id = ?, updated_at = ? WHERE id = ?').run(name, artist, clientId, now(), p.id);
  res.json({ ok: true });
});

// Album / mastering QC view: latest ready version of every track, in project order.
A.get('/projects/:id/album', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return fail(res, 404, 'Not found');
  const tracks = db.prepare('SELECT * FROM tracks WHERE project_id = ? ORDER BY position, created_at').all(p.id);
  const latest = db.prepare("SELECT * FROM versions WHERE track_id = ? AND status = 'ready' ORDER BY number DESC LIMIT 1");
  const out = [];
  let skipped = 0;
  for (const t of tracks) {
    const v = latest.get(t.id);
    if (!v) { skipped++; continue; }
    let analysis = null;
    if (v.analysis) { try { analysis = JSON.parse(v.analysis); } catch { analysis = null; } }
    if (analysis && !analysis.error && (analysis.version || 0) < 2) analysis = null; // older format: redo
    if (!analysis) jobs.enqueueAnalysis(v.id);
    out.push({
      trackId: t.id,
      name: t.name,
      version: { ...lib.versionOut(v), analysis },
    });
  }
  let vinyl = null;
  if (p.vinyl) { try { vinyl = JSON.parse(p.vinyl); } catch { vinyl = null; } }
  res.json({ project: lib.projectOut(p), tracks: out, skipped, vinyl });
});

// Vinyl side plan for a project (album view).
A.put('/projects/:id/vinyl', (req, res) => {
  const p = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return fail(res, 404, 'Not found');
  const b = req.body || {};
  const trackIds = new Set(db.prepare('SELECT id FROM tracks WHERE project_id = ?').all(p.id).map((r) => r.id));
  const sideCount = [2, 4, 6].includes(b.sideCount) ? b.sideCount : 2;
  const names = 'ABCDEF'.slice(0, sideCount).split('');
  const used = new Set();
  const sides = {};
  for (const n of names) {
    sides[n] = (Array.isArray(b.sides?.[n]) ? b.sides[n] : []).filter((id) => typeof id === 'string' && trackIds.has(id) && !used.has(id) && used.add(id));
  }
  const secs = (v) => (Number.isFinite(v) && v > 0 && v < 3600 ? Math.round(v) : null);
  const plan = {
    format: ['12', '10', '7'].includes(b.format) ? b.format : '12',
    rpm: b.rpm === 45 ? 45 : 33,
    sideCount,
    gap: Number.isFinite(b.gap) && b.gap >= 0 && b.gap <= 10 ? b.gap : 2,
    ideal: secs(b.ideal),
    max: secs(b.max),
    sides,
  };
  db.prepare('UPDATE projects SET vinyl = ? WHERE id = ?').run(JSON.stringify(plan), p.id);
  res.json(plan);
});

A.post('/versions/:id/analyze', (req, res) => {
  const v = db.prepare("SELECT id FROM versions WHERE id = ? AND status = 'ready'").get(req.params.id);
  if (!v) return fail(res, 404, 'Not found');
  db.prepare('UPDATE versions SET analysis = NULL WHERE id = ?').run(v.id);
  jobs.enqueueAnalysis(v.id);
  res.json({ ok: true });
});

A.post('/projects/:id/art', artUpload.single('art'), async (req, res) => {
  const f = req.file;
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) { if (f) fs.rmSync(f.path, { force: true }); return fail(res, 404, 'Project not found'); }
  if (!f) return fail(res, 400, 'No image received (jpg, png, webp, gif, tiff)');
  const base = `${p.id}-${newId(6)}`;
  const full = path.join(cfg.dirs.art, base + '.jpg');
  const thumb = path.join(cfg.dirs.art, base + '-t.jpg');
  try {
    await media.artwork(f.path, full, thumb);
  } catch (e) {
    for (const x of [full, thumb]) fs.rmSync(x, { force: true });
    return fail(res, 400, e.message);
  } finally {
    fs.rmSync(f.path, { force: true });
  }
  lib.removeArt(p);
  db.prepare('UPDATE projects SET art_path = ?, updated_at = ? WHERE id = ?').run(full, now(), p.id);
  res.json({ art: lib.projectOut(db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id)).art });
});

A.delete('/projects/:id/art', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return fail(res, 404, 'Not found');
  lib.removeArt(p);
  db.prepare('UPDATE projects SET art_path = NULL WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

A.delete('/projects/:id', (req, res) => {
  lib.deleteProject(req.params.id);
  res.json({ ok: true });
});

A.post('/projects/:id/upload', upload.array('files'), (req, res) => {
  const files = req.files || [];
  const cleanup = () => files.forEach((f) => fs.rmSync(f.path, { force: true }));
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) { cleanup(); return fail(res, 404, 'Project not found'); }
  if (!files.length) return fail(res, 400, 'No audio files received (wav, aiff, flac, mp3, m4a…)');
  const trackId = str(req.body?.trackId, 40);
  if (trackId && !db.prepare('SELECT 1 FROM tracks WHERE id = ? AND project_id = ?').get(trackId, p.id)) {
    cleanup();
    return fail(res, 400, 'Track not in this project');
  }
  const created = [];
  for (const f of files) {
    try {
      if (trackId) {
        const { number } = lib.parseFilename(f.originalname);
        created.push(lib.addVersion({ trackId, number, originalName: f.originalname, srcPath: f.path }));
      } else {
        created.push(lib.ingestFile(p.id, f.originalname, f.path));
      }
    } catch (e) {
      fs.rmSync(f.path, { force: true });
      console.error('[upload]', e);
    }
  }
  res.status(201).json({ created });
});

A.get('/tracks/:id', (req, res) => {
  const d = lib.trackDetail(req.params.id);
  if (!d) return fail(res, 404, 'Not found');
  d.allowDownload = true;
  res.json(d);
});

A.patch('/tracks/:id', (req, res) => {
  const name = str(req.body?.name, 200);
  if (!name) return fail(res, 400, 'Name required');
  db.prepare('UPDATE tracks SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json({ ok: true });
});

A.post('/tracks/:id/move', (req, res) => {
  lib.moveTrack(req.params.id, req.body?.dir < 0 ? -1 : 1);
  res.json({ ok: true });
});

A.delete('/tracks/:id', (req, res) => {
  lib.deleteTrack(req.params.id);
  res.json({ ok: true });
});

A.patch('/versions/:id', (req, res) => {
  db.prepare('UPDATE versions SET note = ? WHERE id = ?').run(str(req.body?.note, 1000), req.params.id);
  res.json({ ok: true });
});

A.delete('/versions/:id', (req, res) => {
  lib.deleteVersion(req.params.id);
  res.json({ ok: true });
});

A.post('/versions/:id/reprocess', (req, res) => {
  const v = db.prepare('SELECT id FROM versions WHERE id = ?').get(req.params.id);
  if (!v) return fail(res, 404, 'Not found');
  db.prepare("UPDATE versions SET status = 'queued', error = NULL WHERE id = ?").run(v.id);
  jobs.enqueue(v.id);
  res.json({ ok: true });
});

A.post('/versions/:id/comments', (req, res) => {
  const body = str(req.body?.body, 4000);
  if (!body) return fail(res, 400, 'Comment is empty');
  try {
    res.status(201).json(insertComment({ versionId: req.params.id, parentId: str(req.body?.parentId, 40) || null, author: cfg.OWNER_NAME, isOwner: true, body, start: req.body?.start, end: req.body?.end }));
  } catch (e) {
    fail(res, e.status || 500, e.message);
  }
});

A.patch('/comments/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, 'Not found');
  const resolved = typeof req.body?.resolved === 'boolean' ? (req.body.resolved ? 1 : 0) : c.resolved;
  const body = req.body?.body != null ? str(req.body.body, 4000) || c.body : c.body;
  db.prepare('UPDATE comments SET resolved = ?, body = ? WHERE id = ?').run(resolved, body, c.id);
  res.json({ ok: true });
});

A.delete('/comments/:id', (req, res) => {
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

A.get('/versions/:id/markers', (req, res) => {
  const fmt = FORMATS[req.query.format] || FORMATS.text;
  const v = db.prepare('SELECT v.*, t.name AS track_name FROM versions v JOIN tracks t ON t.id = v.track_id WHERE v.id = ?').get(req.params.id);
  if (!v) return fail(res, 404, 'Not found');
  const includeResolved = req.query.resolved === '1';
  const all = db.prepare('SELECT * FROM comments WHERE version_id = ? ORDER BY start_time, created_at').all(v.id).map(lib.commentOut);
  const top = all.filter((c) => !c.parentId && (includeResolved || !c.resolved));
  for (const c of top) c.replies = all.filter((r) => r.parentId === c.id);
  const out = fmt.fn(top, `${v.track_name} — v${v.number}${v.note ? ` (${v.note})` : ''}`);
  const safe = v.track_name.replace(/[\\/:*?"<>|]+/g, '-');
  res.set('Content-Disposition', `attachment; filename="${safe.replace(/"/g, '')} v${v.number} notes.${fmt.ext}"`);
  res.type(fmt.type).send(out);
});

A.get('/shares', (req, res) => {
  const rows = db.prepare('SELECT * FROM shares WHERE project_id = ? ORDER BY created_at DESC').all(str(req.query.projectId, 40));
  res.json({ shares: rows.map(shareOut) });
});

A.post('/shares', (req, res) => {
  const projectId = str(req.body?.projectId, 40);
  const trackId = str(req.body?.trackId, 40) || null;
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return fail(res, 400, 'Project not found');
  if (trackId && !db.prepare('SELECT 1 FROM tracks WHERE id = ? AND project_id = ?').get(trackId, projectId)) return fail(res, 400, 'Track not found');
  const passcode = str(req.body?.passcode, 200);
  const days = Number(req.body?.expiresDays) || 0;
  const id = newId();
  db.prepare(`INSERT INTO shares (id, token, project_id, track_id, label, passcode_hash, allow_download, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, newId(18), projectId, trackId, str(req.body?.label, 120),
    passcode ? auth.hashPasscode(passcode) : null, req.body?.allowDownload ? 1 : 0,
    days > 0 ? now() + days * 86400000 : null, now(),
  );
  res.status(201).json(shareOut(db.prepare('SELECT * FROM shares WHERE id = ?').get(id)));
});

A.get('/shares/:id/activity', (req, res) => {
  const share = db.prepare('SELECT * FROM shares WHERE id = ?').get(req.params.id);
  if (!share) return fail(res, 404, 'Not found');
  const rows = db.prepare(`SELECT e.*, t.name AS track_name, v.number AS version_number
    FROM share_events e LEFT JOIN tracks t ON t.id = e.track_id LEFT JOIN versions v ON v.id = e.version_id
    WHERE e.share_id = ? ORDER BY e.created_at DESC LIMIT 500`).all(share.id);
  // Stable "Visitor 1, 2…" labels in order of first appearance, replaced by a name once they've typed one.
  const firstSeen = db.prepare(`SELECT visitor, MIN(created_at) AS t FROM share_events WHERE share_id = ? GROUP BY visitor ORDER BY t`).all(share.id);
  const names = visitorNames(firstSeen.map((r) => r.visitor));
  const label = new Map(firstSeen.map((r, i) => [r.visitor, names.get(r.visitor) || `Visitor ${i + 1}`]));
  res.json({
    share: shareOut(share),
    events: rows.map((e) => ({
      kind: e.kind,
      who: label.get(e.visitor) || 'Visitor',
      named: names.has(e.visitor),
      device: deviceOf(e.ua),
      track: e.track_name || null,
      version: e.version_number ?? null,
      at: e.created_at,
    })),
  });
});

A.delete('/shares/:id', (req, res) => {
  db.prepare('DELETE FROM shares WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.use('/api', A);

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'Invalid JSON');
  if (err instanceof multer.MulterError) return fail(res, 413, err.message);
  console.error(err);
  fail(res, 500, 'Server error');
});

// Clear any half-finished uploads from a previous run.
for (const f of fs.readdirSync(cfg.dirs.tmp)) fs.rmSync(path.join(cfg.dirs.tmp, f), { force: true, recursive: true });

app.listen(cfg.PORT, cfg.HOST, () => {
  console.log(`${cfg.BRAND} running on http://${cfg.HOST === '0.0.0.0' ? 'localhost' : cfg.HOST}:${cfg.PORT}  (data: ${cfg.DATA_DIR})`);
  jobs.resume();
  watch.start();
});
