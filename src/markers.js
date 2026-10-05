'use strict';
// Timecode-note exports so client feedback lands on your DAW timeline.

function hms(t, sep = '.') {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = s.toFixed(3).padStart(6, '0').replace('.', sep);
  return `${h}:${String(m).padStart(2, '0')}:${ss}`;
}

const oneLine = (s) => String(s).replace(/\s*\n\s*/g, ' / ').trim();
const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;

function label(c) {
  return oneLine(`${c.author}: ${c.body}`);
}

// Reaper Region/Marker Manager CSV (import via Region/Marker Manager > Import).
function reaper(comments) {
  const lines = ['#,Name,Start,End,Length'];
  let m = 0;
  let r = 0;
  for (const c of comments) {
    if (c.end != null && c.end > c.start) {
      r += 1;
      lines.push(`R${r},${csvCell(label(c))},${hms(c.start)},${hms(c.end)},${hms(c.end - c.start)}`);
    } else {
      m += 1;
      lines.push(`M${m},${csvCell(label(c))},${hms(c.start)},,`);
    }
  }
  return lines.join('\r\n') + '\r\n';
}

// Audacity label track: start<TAB>end<TAB>text, seconds. Also readable by many other tools.
function audacity(comments) {
  return comments.map((c) => `${(c.start || 0).toFixed(6)}\t${(c.end ?? c.start ?? 0).toFixed(6)}\t${label(c)}`).join('\n') + '\n';
}

// Spreadsheet-friendly CSV.
function csv(comments) {
  const lines = ['Start,End,Author,Comment,Resolved'];
  for (const c of comments) {
    lines.push([hms(c.start), c.end != null ? hms(c.end) : '', csvCell(c.author), csvCell(oneLine(c.body)), c.resolved ? 'yes' : 'no'].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// Plain revision list to paste into an email or session notes.
function text(comments, heading) {
  const out = [heading, ''];
  for (const c of comments) {
    const t = hms(c.start).replace(/^0:/, '').replace(/\.(\d)\d\d$/, '.$1');
    const range = c.end != null ? `–${hms(c.end).replace(/^0:/, '').replace(/\.(\d)\d\d$/, '.$1')}` : '';
    out.push(`[${c.resolved ? 'x' : ' '}] ${t}${range}  ${c.author}: ${oneLine(c.body)}`);
    for (const r of c.replies || []) out.push(`        ↳ ${r.author}: ${oneLine(r.body)}`);
  }
  return out.join('\n') + '\n';
}

const FORMATS = {
  reaper: { ext: 'csv', type: 'text/csv', fn: reaper },
  audacity: { ext: 'txt', type: 'text/plain', fn: audacity },
  csv: { ext: 'csv', type: 'text/csv', fn: csv },
  text: { ext: 'txt', type: 'text/plain', fn: text },
};

module.exports = { FORMATS };
