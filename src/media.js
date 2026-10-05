'use strict';
// Everything that touches audio goes through ffmpeg/ffprobe.
const { spawn } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const lastLine = (s) => (s || '').trim().split('\n').pop() || 'unknown error';

async function probe(file) {
  const { code, stdout, stderr } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ]);
  if (code !== 0) throw new Error('Could not read file: ' + lastLine(stderr));
  const j = JSON.parse(stdout);
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  if (!a) throw new Error('No audio stream found');
  const duration = parseFloat(j.format?.duration ?? a.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not determine duration');
  const bits = parseInt(a.bits_per_raw_sample || a.bits_per_sample, 10);
  return {
    duration,
    sampleRate: parseInt(a.sample_rate, 10) || null,
    channels: a.channels || null,
    bitDepth: Number.isFinite(bits) && bits > 0 ? bits : null,
    codec: a.codec_name || null,
  };
}

// Streaming copy: AAC 256k in MP4 with the index up front so seeking works immediately.
async function transcode(input, output, info) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-map_metadata', '-1'];
  if (info.channels > 2) args.push('-ac', '2');
  if (info.sampleRate > 48000) args.push('-ar', '48000');
  args.push('-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-f', 'mp4', output);
  const { code, stderr } = await run('ffmpeg', args);
  if (code !== 0) throw new Error('Transcode failed: ' + lastLine(stderr));
}

// Integrated loudness, loudness range and true peak (BS.1770 / EBU R128) from the original file.
async function loudness(input) {
  const { code, stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', input, '-vn',
    '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-',
  ]);
  if (code !== 0) throw new Error('Loudness scan failed: ' + lastLine(stderr));
  const s = stderr.slice(stderr.lastIndexOf('Summary:'));
  const num = (re) => {
    const m = s.match(re);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    lufs: num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/),
    lra: num(/LRA:\s+(-?[\d.]+)\s+LU/),
    truePeak: num(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/),
  };
}

// Waveform: max absolute sample (across channels) per bucket, from the original file.
function peaks(input, duration, buckets = 2000) {
  return new Promise((resolve, reject) => {
    const rate = 22050;
    const total = Math.max(1, Math.ceil(duration * rate));
    const per = Math.max(1, Math.ceil(total / buckets));
    const out = [];
    let cur = 0;
    let count = 0;
    let leftover = Buffer.alloc(0);
    let err = '';
    const p = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', input, '-vn',
      '-ac', '2', '-ar', String(rate), '-f', 'f32le', '-',
    ]);
    p.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    p.stdout.on('data', (chunk) => {
      const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buf.length - (buf.length % 8);
      for (let i = 0; i < usable; i += 8) {
        const a = Math.abs(buf.readFloatLE(i));
        const b = Math.abs(buf.readFloatLE(i + 4));
        const m = a > b ? a : b;
        if (m > cur) cur = m;
        if (++count >= per) { out.push(cur); cur = 0; count = 0; }
      }
      leftover = Buffer.from(buf.subarray(usable));
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (count > 0) out.push(cur);
      if (code !== 0) return reject(new Error('Waveform failed: ' + lastLine(err)));
      resolve(out.map((v) => Math.round(Math.min(1, v) * 1000) / 1000));
    });
  });
}

// Album art: one JPEG at up to 1400px and a 480px thumbnail. Anything ffmpeg can decode as an image works.
async function artwork(input, fullOut, thumbOut) {
  const make = async (out, max, q) => {
    const { code, stderr } = await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1',
      '-vf', `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease,format=yuvj420p`,
      '-q:v', String(q), out,
    ]);
    if (code !== 0) throw new Error('That file isn’t an image ffmpeg can read: ' + lastLine(stderr));
  };
  await make(fullOut, 1400, 2);
  await make(thumbOut, 480, 3);
}

// Streams a process's stderr line by line (ebur128/astats logs can be megabytes long).
function eachStderrLine(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let buf = '';
    let tail = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        tail = line;
        onLine(line);
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (buf) onLine(buf);
      code === 0 ? resolve() : reject(new Error(tail || 'ffmpeg failed'));
    });
  });
}

const num = (s) => {
  if (s == null) return null;
  if (/^-?inf$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
};
const finite = (v) => (Number.isFinite(v) ? v : null);

// Mastering QC stats for the album view. Three decode passes over the original file:
//   1. ebur128 (BS.1770): integrated, LRA, max momentary/short-term, per-channel sample + true peak
//   2. astats: per-channel RMS (total / max / min), DC offset, effective bit depth
//   3. raw samples: possibly-clipped samples, leading/trailing silence
async function analyze(input, info) {
  const out = { version: 2 };

  // 1. loudness
  let maxM = -Infinity;
  let maxS = -Infinity;
  let spk = null;
  let tpk = null;
  let I = null;
  let LRA = null;
  let inSummary = false;
  await eachStderrLine('ffmpeg', ['-hide_banner', '-nostats', '-loglevel', 'verbose', '-i', input, '-vn',
    '-af', 'ebur128=peak=true+sample', '-f', 'null', '-'], (line) => {
    if (line.includes(' t: ')) {
      const m = line.match(/ M:\s*(-?[\d.]+|nan|-?inf)/);
      const s = line.match(/ S:\s*(-?[\d.]+|nan|-?inf)/);
      const mv = m && num(m[1]);
      const sv = s && num(s[1]);
      if (mv != null && mv > maxM && mv > -120) maxM = mv;
      if (sv != null && sv > maxS && sv > -120) maxS = sv;
      const sp = line.match(/ SPK:\s*([-\d.inf\s]+?)\s*dBFS/);
      const tp = line.match(/ TPK:\s*([-\d.inf\s]+?)\s*dBFS/);
      if (sp) spk = sp[1].trim().split(/\s+/).map(num);
      if (tp) tpk = tp[1].trim().split(/\s+/).map(num);
    } else if (line.includes('Summary:')) {
      inSummary = true;
    } else if (inSummary) {
      const i = line.match(/^\s*I:\s+(-?[\d.]+|-?inf)\s+LUFS/);
      const l = line.match(/^\s*LRA:\s+(-?[\d.]+)\s+LU/);
      if (i) I = num(i[1]);
      if (l) LRA = num(l[1]);
    }
  });
  out.integrated = finite(I);
  out.lra = finite(LRA);
  out.maxMomentary = finite(maxM);
  out.maxShortTerm = finite(maxS);
  out.samplePeak = (spk || []).map(finite);
  out.truePeak = (tpk || []).map(finite);

  // 2. per-channel statistics
  const ch = [];
  let cur = null;
  await eachStderrLine('ffmpeg', ['-hide_banner', '-nostats', '-i', input, '-vn', '-af', 'astats=length=0.4', '-f', 'null', '-'], (line) => {
    const m = line.match(/\]\s+([A-Za-z ]+):\s+(.*)$/);
    if (!m) return;
    const [, key, val] = m;
    if (key === 'Channel') { cur = {}; ch.push(cur); return; }
    if (key === 'Overall') { cur = null; return; }
    if (!cur) return;
    if (key === 'DC offset') cur.dcOffset = num(val);
    else if (key === 'RMS level dB') cur.rms = num(val);
    else if (key === 'RMS peak dB') cur.rmsMax = num(val);
    else if (key === 'RMS trough dB') cur.rmsMin = num(val);
    else if (key === 'Bit depth') cur.bits = val.split('/').map((x) => parseInt(x, 10));
  });
  out.rms = ch.map((c) => finite(c.rms));
  out.rmsMax = ch.map((c) => finite(c.rmsMax));
  out.rmsMin = ch.map((c) => finite(c.rmsMin));
  out.dcOffsetPct = ch.map((c) => (c.dcOffset == null ? null : c.dcOffset * 100));
  // astats "Bit depth: a/b/…": a = span of bits in use (drops with level), b = lowest bit carrying signal
  // (drops when a 16-bit file is padded to 24). b is the honest "effective resolution".
  out.effectiveBits = ch.map((c) => (c.bits && Number.isFinite(c.bits[1]) ? c.bits[1] : c.bits && Number.isFinite(c.bits[0]) ? c.bits[0] : null));
  out.usedBits = ch.map((c) => (c.bits && Number.isFinite(c.bits[0]) ? c.bits[0] : null));

  // 3. sample scan
  const channels = Math.max(1, info.channels || 2);
  const rate = info.sampleRate || 48000;
  const silence = Math.pow(10, -60 / 20); // -60 dBFS
  const full = 0.9999; // within 0.001 dB of full scale
  const clipped = new Array(channels).fill(0);
  const prevFull = new Array(channels).fill(false);
  let frame = 0;
  let first = -1;
  let last = -1;
  await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ac', String(channels), '-f', 'f32le', '-']);
    let left = Buffer.alloc(0);
    const stride = 4 * channels;
    p.stdout.on('data', (chunk) => {
      const b = left.length ? Buffer.concat([left, chunk]) : chunk;
      const usable = b.length - (b.length % stride);
      for (let o = 0; o < usable; o += stride) {
        let loud = false;
        for (let c = 0; c < channels; c++) {
          const x = b.readFloatLE(o + c * 4);
          const a = x < 0 ? -x : x;
          if (a > silence) loud = true;
          const isFull = a >= full;
          // Two or more consecutive full-scale samples = possibly clipped.
          if (isFull && prevFull[c]) clipped[c] += 1;
          else if (isFull && !prevFull[c]) { /* first of a run; counted if the next one is full too */ }
          prevFull[c] = isFull;
        }
        if (loud) { if (first < 0) first = frame; last = frame; }
        frame++;
      }
      left = Buffer.from(b.subarray(usable));
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Sample scan failed'))));
  });
  out.clippedSamples = clipped;
  out.frames = frame;
  out.leadingSilenceMs = first < 0 ? Math.round((frame / rate) * 1000) : Math.round((first / rate) * 1000);
  out.trailingSilenceMs = last < 0 ? 0 : Math.round(((frame - 1 - last) / rate) * 1000);
  out.analyzedAt = Date.now();
  return out;
}

module.exports = { probe, transcode, loudness, peaks, artwork, analyze };
