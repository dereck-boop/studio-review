'use strict';
// Watch folder: WATCH_DIR/<Project Name>/<Song_v3.wav> -> version 3 of "Song" in that project.
// Files dropped at the top level go to a project called "Inbox". Source files are copied, never moved.
const fs = require('fs');
const path = require('path');
const { db, newId, now } = require('./db');
const { WATCH_DIR, dirs } = require('./config');
const lib = require('./library');

const seen = new Map();
let scanning = false;

function start() {
  if (!WATCH_DIR) return;
  if (!fs.existsSync(WATCH_DIR)) {
    console.warn(`[watch] ${WATCH_DIR} does not exist; watch folder disabled`);
    return;
  }
  console.log(`[watch] watching ${WATCH_DIR}`);
  scan();
  setInterval(scan, 10000);
}

function candidates() {
  const out = [];
  const add = (dir, project) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && lib.AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push({ full, name: e.name, project });
      else if (e.isDirectory() && project === 'Inbox' && dir === WATCH_DIR) add(full, e.name);
    }
  };
  add(WATCH_DIR, 'Inbox');
  return out;
}

async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const done = db.prepare('SELECT 1 FROM imports WHERE path = ? AND size = ? AND mtime = ?');
    for (const f of candidates()) {
      let st;
      try { st = fs.statSync(f.full); } catch { continue; }
      const mtime = Math.floor(st.mtimeMs);
      if (done.get(f.full, st.size, mtime)) continue;
      // Wait until the bounce has finished writing: same size on two scans and quiet for 5s.
      const prev = seen.get(f.full);
      seen.set(f.full, { size: st.size, mtime });
      if (!prev || prev.size !== st.size || prev.mtime !== mtime || Date.now() - st.mtimeMs < 5000 || st.size === 0) continue;

      const tmp = path.join(dirs.tmp, newId() + path.extname(f.name));
      try {
        await fs.promises.copyFile(f.full, tmp);
        const project = lib.findOrCreateProject(f.project);
        const res = lib.ingestFile(project.id, f.name, tmp);
        db.prepare('INSERT OR IGNORE INTO imports (path, size, mtime, version_id, imported_at) VALUES (?, ?, ?, ?, ?)')
          .run(f.full, st.size, mtime, res.id, now());
        console.log(`[watch] imported ${f.name} -> ${project.name} (v${res.number})`);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        console.error(`[watch] ${f.name}:`, e.message);
      }
      seen.delete(f.full);
    }
  } catch (e) {
    console.error('[watch]', e.message);
  } finally {
    scanning = false;
  }
}

module.exports = { start };
