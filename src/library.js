'use strict';
// Data-access helpers shared by the HTTP API and the watch folder.
const fs = require('fs');
const path = require('path');
const { db, newId, now } = require('./db');
const { dirs } = require('./config');
const jobs = require('./jobs');

const AUDIO_EXT = new Set(['.wav', '.wave', '.aif', '.aiff', '.aifc', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wv', '.caf', '.bwf']);

const normName = (s) => String(s).toLowerCase().replace(/[\s_.\-]+/g, ' ').trim();

// "My_Song_v5.wav" -> { name: "My Song", number: 5 }. "Song - Mix 3" -> { "Song", 3 }.
function parseFilename(original) {
  const base = path.basename(original, path.extname(original));
  const m = base.match(/^(.*?)[\s._\-]+(?:v|ver|version|mix|rev)[\s._\-]?(\d{1,3})$/i);
  let name = (m ? m[1] : base).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) name = base;
  return { name, number: m ? parseInt(m[2], 10) : null };
}

function touchProject(projectId) {
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), projectId);
}

function createProject(name, artist = '') {
  const id = newId();
  const t = now();
  db.prepare('INSERT INTO projects (id, name, artist, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, artist, t, t);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

function findOrCreateProject(name) {
  const hit = db.prepare('SELECT * FROM projects').all().find((p) => normName(p.name) === normName(name));
  return hit || createProject(name);
}

function findOrCreateTrack(projectId, name) {
  const rows = db.prepare('SELECT * FROM tracks WHERE project_id = ?').all(projectId);
  const hit = rows.find((r) => normName(r.name) === normName(name));
  if (hit) return hit;
  const pos = rows.reduce((m, r) => Math.max(m, r.position), -1) + 1;
  const id = newId();
  db.prepare('INSERT INTO tracks (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, projectId, name, pos, now());
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
}

function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

// Takes ownership of srcPath (moves it into storage) and queues processing.
function addVersion({ trackId, number, originalName, srcPath, note = '' }) {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId);
  if (!track) throw new Error('Track not found');
  const taken = new Set(db.prepare('SELECT number FROM versions WHERE track_id = ?').all(trackId).map((r) => r.number));
  const max = taken.size ? Math.max(...taken) : 0;
  const n = number && number > 0 && !taken.has(number) ? number : max + 1;
  const id = newId();
  const ext = path.extname(originalName).toLowerCase() || '.wav';
  const dest = path.join(dirs.originals, id + ext);
  moveFile(srcPath, dest);
  db.prepare(`INSERT INTO versions (id, track_id, number, note, original_name, original_path, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`).run(id, trackId, n, note, originalName, dest, now());
  touchProject(track.project_id);
  jobs.enqueue(id);
  return { id, number: n, trackId };
}

// Upload without a target track: the filename decides track + version number.
function ingestFile(projectId, originalName, srcPath) {
  const { name, number } = parseFilename(originalName);
  const track = findOrCreateTrack(projectId, name);
  return addVersion({ trackId: track.id, number, originalName, srcPath });
}

function versionOut(v) {
  return {
    id: v.id,
    number: v.number,
    note: v.note,
    status: v.status,
    error: v.error,
    originalName: v.original_name,
    duration: v.duration,
    sampleRate: v.sample_rate,
    channels: v.channels,
    bitDepth: v.bit_depth,
    codec: v.codec,
    lufs: v.lufs,
    truePeak: v.true_peak,
    lra: v.lra,
    createdAt: v.created_at,
  };
}

function commentOut(c) {
  return {
    id: c.id,
    versionId: c.version_id,
    parentId: c.parent_id,
    author: c.author,
    isOwner: !!c.is_owner,
    body: c.body,
    start: c.start_time,
    end: c.end_time,
    resolved: !!c.resolved,
    createdAt: c.created_at,
  };
}

function artOut(p) {
  if (!p.art_path) return null;
  const base = path.basename(p.art_path, '.jpg');
  return { full: `/art/${p.id}/${base}.jpg`, thumb: `/art/${p.id}/${base}-t.jpg` };
}

function projectOut(p) {
  return { id: p.id, name: p.name, artist: p.artist, art: artOut(p), createdAt: p.created_at, updatedAt: p.updated_at };
}

function removeArt(p) {
  if (!p || !p.art_path) return;
  fs.rmSync(p.art_path, { force: true });
  fs.rmSync(p.art_path.replace(/\.jpg$/, '-t.jpg'), { force: true });
}

function tracksForProject(projectId, onlyTrackId = null) {
  let tracks = db.prepare('SELECT * FROM tracks WHERE project_id = ? ORDER BY position, created_at').all(projectId);
  if (onlyTrackId) tracks = tracks.filter((t) => t.id === onlyTrackId);
  const verStmt = db.prepare('SELECT * FROM versions WHERE track_id = ? ORDER BY number DESC');
  const cStmt = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN c.resolved = 0 THEN 1 ELSE 0 END), 0) AS open
    FROM comments c JOIN versions v ON v.id = c.version_id WHERE v.track_id = ? AND c.parent_id IS NULL`);
  return tracks.map((t) => {
    const versions = verStmt.all(t.id);
    const latest = versions[0] || null;
    const latestReady = versions.find((v) => v.status === 'ready') || null;
    const counts = cStmt.get(t.id);
    return {
      id: t.id,
      name: t.name,
      position: t.position,
      versionCount: versions.length,
      latest: latest ? versionOut(latest) : null,
      latestReady: latestReady ? versionOut(latestReady) : null,
      comments: { total: counts.total, open: counts.open },
    };
  });
}

function trackDetail(trackId, siblingScope = null) {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId);
  if (!track) return null;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(track.project_id);
  const versions = db.prepare('SELECT * FROM versions WHERE track_id = ? ORDER BY number').all(trackId);
  const comments = db.prepare(`SELECT c.* FROM comments c JOIN versions v ON v.id = c.version_id
    WHERE v.track_id = ? ORDER BY c.start_time, c.created_at`).all(trackId);
  let siblings = db.prepare('SELECT id, name FROM tracks WHERE project_id = ? ORDER BY position, created_at').all(track.project_id);
  if (siblingScope === 'track') siblings = siblings.filter((s) => s.id === trackId);
  const idx = siblings.findIndex((s) => s.id === trackId);
  return {
    project: projectOut(project),
    track: { id: track.id, name: track.name, position: track.position },
    versions: versions.map(versionOut),
    comments: comments.map(commentOut),
    prev: idx > 0 ? siblings[idx - 1] : null,
    next: idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null,
  };
}

function removeVersionFiles(v) {
  for (const f of [v.original_path, v.stream_path, v.peaks_path]) {
    if (f) fs.rmSync(f, { force: true });
  }
}

function deleteVersion(id) {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
  if (!v) return false;
  db.prepare('DELETE FROM versions WHERE id = ?').run(id);
  removeVersionFiles(v);
  return true;
}

function deleteTrack(id) {
  const vs = db.prepare('SELECT * FROM versions WHERE track_id = ?').all(id);
  db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
  vs.forEach(removeVersionFiles);
}

function deleteProject(id) {
  removeArt(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  const vs = db.prepare('SELECT v.* FROM versions v JOIN tracks t ON t.id = v.track_id WHERE t.project_id = ?').all(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  vs.forEach(removeVersionFiles);
}

function moveTrack(id, dir) {
  const t = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
  if (!t) return;
  const rows = db.prepare('SELECT id FROM tracks WHERE project_id = ? ORDER BY position, created_at').all(t.project_id);
  const i = rows.findIndex((r) => r.id === id);
  const j = i + (dir < 0 ? -1 : 1);
  if (j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  const upd = db.prepare('UPDATE tracks SET position = ? WHERE id = ?');
  rows.forEach((r, k) => upd.run(k, r.id));
}

module.exports = {
  AUDIO_EXT, parseFilename, createProject, findOrCreateProject, findOrCreateTrack,
  addVersion, ingestFile, tracksForProject, trackDetail, deleteVersion, deleteTrack,
  deleteProject, moveTrack, versionOut, commentOut, projectOut, touchProject, removeArt,
};
