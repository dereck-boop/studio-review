'use strict';
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR } = require('./config');

const db = new DatabaseSync(path.join(DATA_DIR, 'review.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_project ON tracks(project_id, position);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  original_name TEXT NOT NULL,
  original_path TEXT NOT NULL,
  stream_path TEXT,
  peaks_path TEXT,
  duration REAL,
  sample_rate INTEGER,
  channels INTEGER,
  bit_depth INTEGER,
  codec TEXT,
  lufs REAL,
  true_peak REAL,
  lra REAL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(track_id, number)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  start_time REAL NOT NULL DEFAULT 0,
  end_time REAL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_version ON comments(version_id);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  passcode_hash TEXT,
  allow_download INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS share_events (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  visitor TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  track_id TEXT,
  version_id TEXT,
  ua TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS share_events_share ON share_events(share_id, created_at);
CREATE INDEX IF NOT EXISTS share_events_visitor ON share_events(visitor, created_at);

CREATE TABLE IF NOT EXISTS imports (
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  version_id TEXT,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (path, size, mtime)
);
`);

// Columns added after the first release; ALTER only when missing so existing databases upgrade in place.
{
  const cols = new Set(db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name));
  if (!cols.has('client_id')) db.exec('ALTER TABLE projects ADD COLUMN client_id TEXT REFERENCES clients(id) ON DELETE SET NULL');
  if (!cols.has('art_path')) db.exec('ALTER TABLE projects ADD COLUMN art_path TEXT');
  if (!cols.has('vinyl')) db.exec('ALTER TABLE projects ADD COLUMN vinyl TEXT');
  const vcols = new Set(db.prepare('PRAGMA table_info(versions)').all().map((c) => c.name));
  if (!vcols.has('analysis')) db.exec('ALTER TABLE versions ADD COLUMN analysis TEXT');
}

const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
const now = () => Date.now();

module.exports = { db, newId, now };
