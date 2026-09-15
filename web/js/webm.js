// Copied from ~/projects/aqi/dashboard/static/js/webm.js (pol.reclaimchennai.city); keep the two in step.
/* Writing a duration into a WebM that MediaRecorder left without one.

   MediaRecorder streams: it writes the Segment with an unknown size and no
   Duration element, because when recording starts it does not know how long
   the clip will be. Players then report 0:00 and editors refuse the file.

   Once the recording has stopped we do know the length, so this walks the
   EBML tree to the Segment's Info block and puts a Duration in it. Nothing
   else about the file changes. */

function readId(b, i) {
  let len = 1, mask = 0x80;
  while (len <= 4 && !(b[i] & mask)) { mask >>= 1; len++; }
  if (len > 4 || i + len > b.length) return null;
  let id = 0;
  for (let k = 0; k < len; k++) id = id * 256 + b[i + k];
  return { id, len };
}

function readSize(b, i) {
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b[i] & mask)) { mask >>= 1; len++; }
  if (len > 8 || i + len > b.length) return null;
  let value = b[i] & (mask - 1);
  let unknown = (b[i] & (mask - 1)) === mask - 1;
  for (let k = 1; k < len; k++) {
    value = value * 256 + b[i + k];
    if (b[i + k] !== 0xff) unknown = false;
  }
  return { value, len, unknown };
}

function writeSize(value, len) {
  const out = new Uint8Array(len);
  let v = value;
  for (let k = len - 1; k >= 0; k--) { out[k] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 1 << (8 - len);
  return out;
}

function sizeLength(value) {
  for (let len = 1; len <= 8; len++) if (value < Math.pow(2, 7 * len) - 1) return len;
  return 8;
}

/* Walk the children of one element, calling back with (id, contentStart,
   contentEnd, headerStart, sizeStart, sizeLen). */
function children(b, start, end, visit) {
  let i = start;
  while (i < end) {
    const id = readId(b, i);
    if (!id) return;
    const size = readSize(b, i + id.len);
    if (!size) return;
    const contentStart = i + id.len + size.len;
    const contentEnd = size.unknown ? end : Math.min(end, contentStart + size.value);
    if (visit(id.id, contentStart, contentEnd, i, i + id.len, size.len) === false) return;
    i = contentEnd;
    if (contentEnd <= contentStart && size.value === 0) i = contentStart;
  }
}

const SEGMENT = 0x18538067, INFO = 0x1549a966, TIMECODE_SCALE = 0x2ad7b1, DURATION = 0x4489;

export function withDuration(bytes, milliseconds) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let segStart = -1, segEnd = -1;
  children(b, 0, b.length, (id, cs, ce) => {
    if (id === SEGMENT) { segStart = cs; segEnd = ce; return false; }
  });
  if (segStart < 0) return null;

  let info = null;
  children(b, segStart, segEnd, (id, cs, ce, hs, ss, sl) => {
    if (id === INFO) { info = { contentStart: cs, contentEnd: ce, sizeStart: ss, sizeLen: sl }; return false; }
  });
  if (!info) return null;

  // Duration is counted in TimecodeScale units, a nanosecond figure that is
  // a millisecond by default.
  let scale = 1000000, existing = null;
  children(b, info.contentStart, info.contentEnd, (id, cs, ce) => {
    if (id === TIMECODE_SCALE) {
      let v = 0;
      for (let k = cs; k < ce; k++) v = v * 256 + b[k];
      if (v > 0) scale = v;
    }
    if (id === DURATION) existing = { start: cs, end: ce };
  });
  const units = (milliseconds * 1e6) / scale;

  if (existing && existing.end - existing.start === 8) {
    const out = b.slice();
    new DataView(out.buffer, out.byteOffset).setFloat64(existing.start, units);
    return out;
  }

  const element = new Uint8Array(11);
  element[0] = 0x44; element[1] = 0x89; element[2] = 0x88;
  new DataView(element.buffer).setFloat64(3, units);

  const oldSize = info.contentEnd - info.contentStart;
  const newSize = oldSize + element.length;
  const newLen = Math.max(info.sizeLen, sizeLength(newSize));
  const sizeBytes = writeSize(newSize, newLen);

  const out = new Uint8Array(b.length + element.length + (newLen - info.sizeLen));
  let at = 0;
  out.set(b.subarray(0, info.sizeStart), at); at += info.sizeStart;
  out.set(sizeBytes, at); at += sizeBytes.length;
  out.set(element, at); at += element.length;
  out.set(b.subarray(info.contentStart), at);
  return out;
}

export async function fixWebmDuration(blob, milliseconds) {
  try {
    const patched = withDuration(new Uint8Array(await blob.arrayBuffer()), milliseconds);
    return patched ? new Blob([patched], { type: blob.type }) : blob;
  } catch (e) {
    return blob;
  }
}
