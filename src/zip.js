'use strict';
// Minimal streaming ZIP writer for "Download all": files are stored, not compressed
// (WAV/AIFF barely compress, and storing keeps it fast). CRCs are computed up front so
// every header carries real sizes (no data descriptors), which Finder's Archive Utility
// and Windows Explorer both open reliably. ZIP64 records are added only when needed.
const fs = require('fs');
const zlib = require('zlib');

const MAX32 = 0xffffffff;

async function crcOf(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) crc = zlib.crc32(chunk, crc);
  return crc >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

function localHeader(e) {
  const big = e.size >= MAX32;
  const extra = big ? Buffer.concat([Buffer.from([0x01, 0x00, 16, 0]), u64(e.size), u64(e.size)]) : Buffer.alloc(0);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(big ? 45 : 20, 4);
  h.writeUInt16LE(0x0800, 6); // UTF-8 names
  h.writeUInt16LE(0, 8); // stored
  h.writeUInt16LE(e.dos.time, 10);
  h.writeUInt16LE(e.dos.date, 12);
  h.writeUInt32LE(e.crc, 14);
  h.writeUInt32LE(big ? MAX32 : e.size, 18);
  h.writeUInt32LE(big ? MAX32 : e.size, 22);
  h.writeUInt16LE(e.nameBuf.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, e.nameBuf, extra]);
}

function centralHeader(e) {
  const bigSize = e.size >= MAX32;
  const bigOff = e.offset >= MAX32;
  const parts = [];
  if (bigSize) parts.push(u64(e.size), u64(e.size));
  if (bigOff) parts.push(u64(e.offset));
  const body = Buffer.concat(parts);
  const extra = body.length ? Buffer.concat([Buffer.from([0x01, 0x00, body.length, 0]), body]) : Buffer.alloc(0);
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, spec 4.5
  h.writeUInt16LE(extra.length ? 45 : 20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(e.dos.time, 12);
  h.writeUInt16LE(e.dos.date, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(bigSize ? MAX32 : e.size, 20);
  h.writeUInt32LE(bigSize ? MAX32 : e.size, 24);
  h.writeUInt16LE(e.nameBuf.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt16LE(0, 32); // comment
  h.writeUInt16LE(0, 34); // disk
  h.writeUInt16LE(0, 36); // internal attrs
  h.writeUInt32LE(((0o100644) << 16) >>> 0, 38); // -rw-r--r--
  h.writeUInt32LE(bigOff ? MAX32 : e.offset, 42);
  return Buffer.concat([h, e.nameBuf, extra]);
}

function endRecords(count, cdOffset, cdSize) {
  const need64 = count >= 0xffff || cdOffset >= MAX32 || cdSize >= MAX32;
  const out = [];
  if (need64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(count), 24);
    z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    loc.writeUInt32LE(1, 16);
    out.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Math.min(count, 0xffff), 8);
  e.writeUInt16LE(Math.min(count, 0xffff), 10);
  e.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  e.writeUInt32LE(Math.min(cdOffset, MAX32), 16);
  out.push(e);
  return Buffer.concat(out);
}

// entries: [{ name: 'Album/01 Song v3.wav', path: '/data/originals/…' }]
async function sendZip(res, zipName, entries) {
  const list = [];
  for (const it of entries) {
    const st = fs.statSync(it.path);
    list.push({ ...it, size: st.size, dos: dosTime(st.mtime), nameBuf: Buffer.from(it.name, 'utf8'), crc: await crcOf(it.path) });
  }
  // Lay out offsets first so we can send an exact Content-Length (download progress bars work).
  let off = 0;
  for (const e of list) { e.offset = off; off += localHeader(e).length + e.size; }
  const central = Buffer.concat(list.map(centralHeader));
  const tail = Buffer.concat([central, endRecords(list.length, off, central.length)]);

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': String(off + tail.length),
    'Content-Disposition': `attachment; filename="${zipName.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    'Cache-Control': 'no-store',
  });

  const write = (buf) => new Promise((ok) => (res.write(buf) ? ok() : res.once('drain', ok)));
  for (const e of list) {
    if (res.destroyed) return;
    await write(localHeader(e));
    for await (const chunk of fs.createReadStream(e.path, { highWaterMark: 1 << 20 })) {
      if (res.destroyed) return;
      await write(chunk);
    }
  }
  res.end(tail);
}

module.exports = { sendZip };
