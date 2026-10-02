import { unzlib } from 'fflate';

const B45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const B45_REV = new Map([...B45_ALPHABET].map((c, i) => [c, i]));
const enc = new TextEncoder();
const dec = new TextDecoder();

const FRAME_MAGIC = 'QRF1';
const PARITY_MAGIC = 'QRP1';
const STREAM_MAGIC = 'QRFS1';
const FRAME_SIZE = 22;
const PARITY_SIZE = 24;
const STREAM_HDR_SIZE = 56;
const FLAG_ZLIB = 0x01;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts) {
  let c = 0xFFFFFFFF;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) c = crcTable[(c ^ part[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function ascii(bytes, start, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i]);
  return s;
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base45Decode(text) {
  const clean = String(text).trim();
  const vals = [];
  for (const ch of clean) {
    const v = B45_REV.get(ch);
    if (v === undefined) throw new Error(`invalid Base45 character ${JSON.stringify(ch)}`);
    vals.push(v);
  }
  if (vals.length % 3 === 1) throw new Error('invalid Base45 length');
  const out = [];
  let i = 0;
  while (i + 2 < vals.length) {
    const x = vals[i] + vals[i + 1] * 45 + vals[i + 2] * 45 * 45;
    if (x > 0xFFFF) throw new Error('invalid Base45 triplet');
    out.push(x >> 8, x & 0xFF);
    i += 3;
  }
  if (i + 1 < vals.length) {
    const x = vals[i] + vals[i + 1] * 45;
    if (x > 0xFF) throw new Error('invalid Base45 pair');
    out.push(x);
  }
  return Uint8Array.from(out);
}

export function parseTransportText(text) {
  const raw = base45Decode(text);
  const magic = raw.length >= 4 ? ascii(raw, 0, 4) : '';
  if (magic === FRAME_MAGIC) return parseDataFrame(raw);
  if (magic === PARITY_MAGIC) return parseParityFrame(raw);
  throw new Error('not a QRFile transport frame');
}

function parseDataFrame(raw) {
  if (raw.length < FRAME_SIZE) throw new Error('frame too short');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const fidBytes = raw.slice(4, 12);
  const idx = view.getUint16(12, false);
  const total = view.getUint16(14, false);
  const plen = view.getUint16(16, false);
  const expectedCrc = view.getUint32(18, false);
  const payload = raw.slice(FRAME_SIZE);
  if (plen !== payload.length) throw new Error('frame payload length mismatch');
  const actualCrc = crc32([raw.slice(0, 18), payload]);
  if (actualCrc !== expectedCrc) throw new Error('frame CRC mismatch');
  if (total < 1 || idx >= total) throw new Error('frame index invalid');
  return { kind: 'data', fid: hex(fidBytes), idx, total, payload };
}

function parseParityFrame(raw) {
  if (raw.length < PARITY_SIZE) throw new Error('parity frame too short');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const fidBytes = raw.slice(4, 12);
  const groupStart = view.getUint16(12, false);
  const total = view.getUint16(14, false);
  const groupCount = view.getUint8(16);
  const parityIndex = view.getUint8(17);
  const plen = view.getUint16(18, false);
  const expectedCrc = view.getUint32(20, false);
  const payload = raw.slice(PARITY_SIZE);
  if (plen !== payload.length) throw new Error('parity payload length mismatch');
  const actualCrc = crc32([raw.slice(0, 20), payload]);
  if (actualCrc !== expectedCrc) throw new Error('parity CRC mismatch');
  if (total < 1 || groupStart >= total || groupCount < 1) throw new Error('invalid parity group');
  return { kind: 'parity', fid: hex(fidBytes), groupStart, total, groupCount, parityIndex, payload };
}

function reedMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = ((z << 1) ^ (((z >>> 7) & 1) * 0x11D)) & 0xFF;
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xFF;
}

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = reedMul(x, 0x02);
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (!a || !b) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfPow(a, n) {
  if (n === 0) return 1;
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] * n) % 255];
}

function gfInv(a) {
  if (a === 0) throw new Error('GF inverse of zero');
  return GF_EXP[255 - GF_LOG[a]];
}

function matrixInverse(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let r = col; r < n; r++) {
      if (a[r][col]) { pivot = r; break; }
    }
    if (pivot < 0) throw new Error('singular FEC matrix');
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
    const inv = gfInv(a[col][col]);
    if (inv !== 1) a[col] = a[col].map((v) => gfMul(v, inv));
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (!f) continue;
      a[r] = a[r].map((x, j) => x ^ gfMul(f, a[col][j]));
    }
  }
  return a.map((row) => row.slice(n));
}

function fecRecoverGroup(knownByPos, parityByIdx, groupCount, chunkSize) {
  const missing = [];
  for (let i = 0; i < groupCount; i++) if (!knownByPos.has(i)) missing.push(i);
  if (!missing.length) return new Map();
  const available = [...parityByIdx.keys()].sort((a, b) => a - b);
  if (missing.length > available.length) return new Map();
  const use = available.slice(0, missing.length);
  const matrix = use.map((pidx) => missing.map((pos) => gfPow(pos + 1, pidx)));
  const inv = matrixInverse(matrix);
  const rhs = [];
  for (const pidx of use) {
    const parity = parityByIdx.get(pidx);
    if (!parity || parity.length !== chunkSize) return new Map();
    const r = Uint8Array.from(parity);
    for (const [pos, block] of knownByPos) {
      if (pos >= groupCount || block.length !== chunkSize) continue;
      const coef = gfPow(pos + 1, pidx);
      if (coef === 1) {
        for (let j = 0; j < chunkSize; j++) r[j] ^= block[j];
      } else {
        for (let j = 0; j < chunkSize; j++) r[j] ^= gfMul(coef, block[j]);
      }
    }
    rhs.push(r);
  }
  const recovered = new Map();
  for (let c = 0; c < missing.length; c++) {
    const dst = new Uint8Array(chunkSize);
    for (let r = 0; r < inv[c].length; r++) {
      const coeff = inv[c][r];
      if (!coeff) continue;
      const src = rhs[r];
      if (coeff === 1) {
        for (let j = 0; j < chunkSize; j++) dst[j] ^= src[j];
      } else {
        for (let j = 0; j < chunkSize; j++) dst[j] ^= gfMul(coeff, src[j]);
      }
    }
    recovered.set(missing[c], dst);
  }
  return recovered;
}

export function estimateFecRecoverable(session) {
  let recoverable = 0;
  for (const [start, pg] of session.parity) {
    const count = pg.count;
    let missing = 0;
    for (let pos = 0; pos < count; pos++) if (!session.parts.has(start + pos)) missing++;
    if (missing > 0 && missing <= pg.items.size) recoverable += missing;
  }
  return recoverable;
}

export async function recoverFec(session, onRecovered) {
  let recoveredCount = 0;
  for (const [start, pg] of [...session.parity.entries()].sort((a, b) => a[0] - b[0])) {
    if (!pg.items.size) continue;
    const chunkSize = pg.items.values().next().value.length;
    const known = new Map();
    for (let pos = 0; pos < pg.count; pos++) {
      const block = session.parts.get(start + pos);
      if (block && block.length === chunkSize) known.set(pos, block);
    }
    const missing = pg.count - known.size;
    if (!missing || missing > pg.items.size) continue;
    const recovered = fecRecoverGroup(known, pg.items, pg.count, chunkSize);
    for (const [pos, payload] of recovered) {
      const idx = start + pos;
      if (!session.parts.has(idx)) {
        session.parts.set(idx, payload);
        recoveredCount++;
        if (onRecovered) await onRecovered({ kind: 'data', fid: session.fid, idx, total: session.total, payload });
      }
    }
  }
  return recoveredCount;
}

export function missingIndices(session) {
  const missing = [];
  for (let i = 0; i < session.total; i++) if (!session.parts.has(i)) missing.push(i);
  return missing;
}

export function compactFrameRanges(indices) {
  const vals = [...new Set(indices.map((v) => Number(v) + 1))].sort((a, b) => a - b);
  if (!vals.length) return '';
  const out = [];
  let start = vals[0], prev = vals[0];
  for (const v of vals.slice(1)) {
    if (v === prev + 1) { prev = v; continue; }
    out.push(start === prev ? String(start) : `${start}-${prev}`);
    start = prev = v;
  }
  out.push(start === prev ? String(start) : `${start}-${prev}`);
  return out.join(',');
}

function readU64(view, offset) {
  const n = view.getBigUint64(offset, false);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('stream size is too large for this browser');
  return Number(n);
}

function unzlibAsync(data) {
  return new Promise((resolve, reject) => {
    unzlib(data, (err, out) => err ? reject(err) : resolve(out));
  });
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function restoreSession(session) {
  if (session.parts.size !== session.total) throw new Error(`still missing ${session.total - session.parts.size} data frame(s)`);
  let totalBytes = 0;
  for (let i = 0; i < session.total; i++) {
    const p = session.parts.get(i);
    if (!p) throw new Error(`missing frame ${i + 1}`);
    totalBytes += p.length;
  }
  const stream = new Uint8Array(totalBytes);
  let pos = 0;
  for (let i = 0; i < session.total; i++) {
    const p = session.parts.get(i);
    stream.set(p, pos);
    pos += p.length;
  }
  if (stream.length < STREAM_HDR_SIZE) throw new Error('transport stream too short');
  if (ascii(stream, 0, 5) !== STREAM_MAGIC) throw new Error('bad stream magic');
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const flags = view.getUint8(5);
  const originalSize = readU64(view, 6);
  const packedSize = readU64(view, 14);
  const digest = stream.slice(22, 54);
  const nameLen = view.getUint16(54, false);
  let off = STREAM_HDR_SIZE;
  if (off + nameLen > stream.length) throw new Error('truncated filename');
  const nameBytes = stream.slice(off, off + nameLen);
  off += nameLen;
  const end = off + packedSize;
  if (end > stream.length) throw new Error('transport stream length mismatch');
  for (let i = end; i < stream.length; i++) if (stream[i] !== 0) throw new Error('non-zero trailing bytes after stream');
  if (flags & ~FLAG_ZLIB) throw new Error(`unsupported stream flags 0x${flags.toString(16)}`);
  const packed = stream.slice(off, end);
  const data = (flags & FLAG_ZLIB) ? await unzlibAsync(packed) : packed;
  if (data.length !== originalSize) throw new Error(`restored size mismatch: ${data.length} != ${originalSize}`);
  const got = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  if (!equalBytes(got, digest)) throw new Error('SHA-256 mismatch');
  let name = 'recovered.bin';
  try { name = dec.decode(nameBytes) || name; } catch (_) {}
  name = name.replaceAll('\\', '/').split('/').pop() || 'recovered.bin';
  return { name, data, sha256: hex(got), compressed: Boolean(flags & FLAG_ZLIB) };
}

export function makeSession(fid, total) {
  return { fid, total, parts: new Map(), parity: new Map() };
}

export function mergeRecord(sessions, record) {
  let session = sessions.get(record.fid);
  if (!session) {
    session = makeSession(record.fid, record.total);
    sessions.set(record.fid, session);
  }
  if (session.total !== record.total) throw new Error(`conflicting total for file_id ${record.fid}`);
  if (record.kind === 'data') {
    const old = session.parts.get(record.idx);
    if (old) return { added: false, duplicate: true, session };
    session.parts.set(record.idx, record.payload);
    return { added: true, duplicate: false, session };
  }
  let pg = session.parity.get(record.groupStart);
  if (!pg) {
    pg = { count: record.groupCount, items: new Map() };
    session.parity.set(record.groupStart, pg);
  }
  if (pg.count !== record.groupCount) throw new Error(`conflicting parity group size at ${record.groupStart + 1}`);
  if (pg.items.has(record.parityIndex)) return { added: false, duplicate: true, session };
  pg.items.set(record.parityIndex, record.payload);
  return { added: true, duplicate: false, session };
}

export function parityCount(session) {
  let n = 0;
  for (const pg of session.parity.values()) n += pg.items.size;
  return n;
}
