'use strict';
// One-at-a-time processing queue: probe -> stream copy -> waveform -> loudness.
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { dirs } = require('./config');
const media = require('./media');

// Two queues: new uploads first (so clients can listen quickly), QC analysis after.
const queue = [];
const analysisQueue = [];
let busy = false;
let current = null;

function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  pump();
}

function enqueueAnalysis(id) {
  if (current === id || analysisQueue.includes(id)) return;
  analysisQueue.push(id);
  pump();
}

const pendingAnalysis = (id) => analysisQueue.includes(id);

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length || analysisQueue.length) {
    const isProcess = queue.length > 0;
    const id = isProcess ? queue.shift() : analysisQueue.shift();
    current = id;
    try {
      if (isProcess) await processVersion(id);
      else await analyzeVersion(id);
    } catch (e) {
      console.error('[jobs]', id, e);
    }
    current = null;
  }
  busy = false;
}

async function analyzeVersion(id) {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
  if (!v || v.status !== 'ready') return;
  const t0 = Date.now();
  let result;
  try {
    result = await media.analyze(v.original_path, { channels: v.channels, sampleRate: v.sample_rate });
  } catch (e) {
    result = { version: 1, error: String(e.message || e).slice(0, 300) };
    console.error(`[jobs] analysis of ${v.original_name} failed:`, e.message);
  }
  db.prepare('UPDATE versions SET analysis = ? WHERE id = ?').run(JSON.stringify(result), id);
  if (!result.error) console.log(`[jobs] ${v.original_name} analyzed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function processVersion(id) {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
  if (!v) return;
  db.prepare("UPDATE versions SET status = 'processing', error = NULL WHERE id = ?").run(id);
  const t0 = Date.now();
  try {
    const info = await media.probe(v.original_path);
    const streamPath = path.join(dirs.stream, id + '.m4a');
    const partPath = streamPath + '.part';
    await media.transcode(v.original_path, partPath, info);
    fs.renameSync(partPath, streamPath);

    const pk = await media.peaks(v.original_path, info.duration);
    const peaksPath = path.join(dirs.peaks, id + '.json');
    fs.writeFileSync(peaksPath, JSON.stringify({ duration: info.duration, peaks: pk }));

    const ld = await media.loudness(v.original_path);

    // The version may have been deleted while we worked.
    if (!db.prepare('SELECT 1 FROM versions WHERE id = ?').get(id)) {
      for (const f of [streamPath, peaksPath]) fs.rmSync(f, { force: true });
      return;
    }
    db.prepare(`UPDATE versions SET status = 'ready', error = NULL, stream_path = ?, peaks_path = ?,
      duration = ?, sample_rate = ?, channels = ?, bit_depth = ?, codec = ?, lufs = ?, true_peak = ?, lra = ?
      WHERE id = ?`).run(
      streamPath, peaksPath, info.duration, info.sampleRate, info.channels, info.bitDepth, info.codec,
      ld.lufs, ld.truePeak, ld.lra, id,
    );
    console.log(`[jobs] ${v.original_name} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    db.prepare('UPDATE versions SET analysis = NULL WHERE id = ?').run(id);
    enqueueAnalysis(id);
  } catch (e) {
    db.prepare("UPDATE versions SET status = 'error', error = ? WHERE id = ?").run(String(e.message || e).slice(0, 500), id);
    console.error(`[jobs] ${v.original_name} failed:`, e.message);
  }
}

function resume() {
  const rows = db.prepare("SELECT id FROM versions WHERE status IN ('queued', 'processing') ORDER BY created_at").all();
  for (const r of rows) enqueue(r.id);
}

module.exports = { enqueue, enqueueAnalysis, pendingAnalysis, resume };
