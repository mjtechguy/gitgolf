// Line-level three-way text merge (diff3) with the outcome of `git merge-file`: the same clean merges, byte for byte, and a
// conflict wherever git reports one. Conflict markers are never written; a conflict is reported with its line ranges.
//
// The line diff follows git's default xdiff Myers pipeline so that ambiguous alignments resolve as git resolves them:
// common prefix/suffix trimming, discarding lines without a counterpart (and runs of frequent lines among them), Myers'
// O(ND) divide and conquer with xdiff's cost cut-offs, then sliding each change group down as far as it goes unless it can
// line up with a change group on the other side. Merging follows xdiff's rules: changes from one side that end strictly
// before the other side's next change starts are taken; identical changes are taken once; changes that overlap or touch
// (one ends on the line where the other starts, or both insert at the same place) are a conflict unless both sides end
// up with the same lines there.
//
// Lines are compared as exact bytes including their terminator ("\n", "\r\n" or none on a last line without newline).
// Inputs are bytes; anything with a NUL in its first 8000 bytes (git's binary probe) or that is not valid UTF-8 is not
// merged ('binary'). Files over 1 MiB or 50,000 lines are not merged ('too_large_to_merge').

export const textMergeLimits = Object.freeze({ bytes: 1 << 20, lines: 50_000, binaryProbe: 8000, hunks: 50 });

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), encoder = new TextEncoder();
const lineMax = 0x7fffffff, maxEqualLimit = 1024, scanWindow = 100, keepRun = 4, maxCostMin = 256, heuristicMinCost = 256, snakeCount = 20, heuristicFactor = 4;

// Integer square root approximation used for xdiff's thresholds.
const roughSqrt = n => { let i = 1; for (; n > 0; n >>= 2) i <<= 1; return i; };

// Split decoded text into lines that keep their terminators.
function lines(text) {
  const out = [];
  for (let start = 0; start < text.length;) {
    const end = text.indexOf('\n', start);
    if (end < 0) { out.push(text.slice(start)); break; }
    out.push(text.slice(start, end + 1)); start = end + 1;
  }
  return out;
}

// Why a file cannot be merged as text, or its lines.
function prepare(bytes) {
  if (!(bytes instanceof Uint8Array)) throw TypeError('mergeText takes Uint8Array inputs');
  if (bytes.subarray(0, textMergeLimits.binaryProbe).includes(0)) return { reason: 'binary' };
  if (bytes.length > textMergeLimits.bytes) return { reason: 'too_large_to_merge' };
  let text;
  try { text = decoder.decode(bytes); } catch { return { reason: 'binary' }; }
  const list = lines(text);
  return list.length > textMergeLimits.lines ? { reason: 'too_large_to_merge' } : { lines: list };
}

// A change group may skip over a line only where the line before (or after) it equals its last (or first) line.
// rchg arrays are padded by one entry at each end: line i is at index i + 1.
class Side {
  constructor(ids) { this.ids = ids; this.n = ids.length; this.rchg = new Uint8Array(ids.length + 2); }
  changed(i) { return this.rchg[i + 1] === 1; }
  mark(i, value) { this.rchg[i + 1] = value; }
}

// Marks the lines of a and b that differ (line class IDs), as git's Myers diff with its heuristics marks them.
function myers(a, b, ha1, index1, ha2, index2) {
  const n1 = ha1.length, n2 = ha2.length, diagonals = n1 + n2 + 3, offset = n2 + 1;
  const forward = new Int32Array(diagonals), backward = new Int32Array(diagonals);
  const maxCost = Math.max(roughSqrt(diagonals), maxCostMin);
  const kf = d => d + offset;
  // Finds a split point of the box (off1, off2)–(lim1, lim2): the middle snake, or a good-enough point once too costly.
  const split = (off1, lim1, off2, lim2, needMin) => {
    const dmin = off1 - lim2, dmax = lim1 - off2, fmid = off1 - off2, bmid = lim1 - lim2, odd = (fmid - bmid) & 1;
    let fmin = fmid, fmax = fmid, bmin = bmid, bmax = bmid;
    forward[kf(fmid)] = off1; backward[kf(bmid)] = lim1;
    for (let cost = 1; ; cost++) {
      let gotSnake = false;
      if (fmin > dmin) forward[kf(--fmin - 1)] = -1; else ++fmin;
      if (fmax < dmax) forward[kf(++fmax + 1)] = -1; else --fmax;
      for (let d = fmax; d >= fmin; d -= 2) {
        let i1 = forward[kf(d - 1)] >= forward[kf(d + 1)] ? forward[kf(d - 1)] + 1 : forward[kf(d + 1)];
        const prev = i1;
        let i2 = i1 - d;
        while (i1 < lim1 && i2 < lim2 && ha1[i1] === ha2[i2]) { i1++; i2++; }
        if (i1 - prev > snakeCount) gotSnake = true;
        forward[kf(d)] = i1;
        if (odd && bmin <= d && d <= bmax && backward[kf(d)] <= i1) return { i1, i2, minLo: true, minHi: true };
      }
      if (bmin > dmin) backward[kf(--bmin - 1)] = lineMax; else ++bmin;
      if (bmax < dmax) backward[kf(++bmax + 1)] = lineMax; else --bmax;
      for (let d = bmax; d >= bmin; d -= 2) {
        let i1 = backward[kf(d - 1)] < backward[kf(d + 1)] ? backward[kf(d - 1)] : backward[kf(d + 1)] - 1;
        const prev = i1;
        let i2 = i1 - d;
        while (i1 > off1 && i2 > off2 && ha1[i1 - 1] === ha2[i2 - 1]) { i1--; i2--; }
        if (prev - i1 > snakeCount) gotSnake = true;
        backward[kf(d)] = i1;
        if (!odd && fmin <= d && d <= fmax && i1 <= forward[kf(d)]) return { i1, i2, minLo: true, minHi: true };
      }
      if (needMin) continue;
      // Past the heuristic cost, accept a diagonal that is far along and ends in a long enough snake.
      if (gotSnake && cost > heuristicMinCost) {
        let best = 0, found = null;
        for (let d = fmax; d >= fmin; d -= 2) {
          const dd = d > fmid ? d - fmid : fmid - d, i1 = forward[kf(d)], i2 = i1 - d, v = (i1 - off1) + (i2 - off2) - dd;
          if (v > heuristicFactor * cost && v > best && off1 + snakeCount <= i1 && i1 < lim1 && off2 + snakeCount <= i2 && i2 < lim2) {
            for (let k = 1; ha1[i1 - k] === ha2[i2 - k]; k++) if (k === snakeCount) { best = v; found = { i1, i2 }; break; }
          }
        }
        if (best > 0) return { ...found, minLo: true, minHi: false };
        for (let d = bmax; d >= bmin; d -= 2) {
          const dd = d > bmid ? d - bmid : bmid - d, i1 = backward[kf(d)], i2 = i1 - d, v = (lim1 - i1) + (lim2 - i2) - dd;
          if (v > heuristicFactor * cost && v > best && off1 < i1 && i1 <= lim1 - snakeCount && off2 < i2 && i2 <= lim2 - snakeCount) {
            for (let k = 0; ha1[i1 + k] === ha2[i2 + k]; k++) if (k === snakeCount - 1) { best = v; found = { i1, i2 }; break; }
          }
        }
        if (best > 0) return { ...found, minLo: false, minHi: true };
      }
      // Too costly: take the furthest-reaching path in either direction.
      if (cost >= maxCost) {
        let fbest = -1, fbest1 = -1, bbest = lineMax, bbest1 = lineMax;
        for (let d = fmax; d >= fmin; d -= 2) {
          let i1 = Math.min(forward[kf(d)], lim1), i2 = i1 - d;
          if (lim2 < i2) { i1 = lim2 + d; i2 = lim2; }
          if (fbest < i1 + i2) { fbest = i1 + i2; fbest1 = i1; }
        }
        for (let d = bmax; d >= bmin; d -= 2) {
          let i1 = Math.max(off1, backward[kf(d)]), i2 = i1 - d;
          if (i2 < off2) { i1 = off2 + d; i2 = off2; }
          if (i1 + i2 < bbest) { bbest = i1 + i2; bbest1 = i1; }
        }
        return (lim1 + lim2) - bbest < fbest - (off1 + off2) ? { i1: fbest1, i2: fbest - fbest1, minLo: true, minHi: false } : { i1: bbest1, i2: bbest - bbest1, minLo: false, minHi: true };
      }
    }
  };
  // Divide and conquer with an explicit stack; the order boxes are solved in does not change the marks.
  const stack = [[0, n1, 0, n2, false]];
  while (stack.length) {
    let [off1, lim1, off2, lim2, needMin] = stack.pop();
    while (off1 < lim1 && off2 < lim2 && ha1[off1] === ha2[off2]) { off1++; off2++; }
    while (off1 < lim1 && off2 < lim2 && ha1[lim1 - 1] === ha2[lim2 - 1]) { lim1--; lim2--; }
    if (off1 === lim1) for (; off2 < lim2; off2++) b.mark(index2[off2], 1);
    else if (off2 === lim2) for (; off1 < lim1; off1++) a.mark(index1[off1], 1);
    else {
      const point = split(off1, lim1, off2, lim2, needMin);
      stack.push([point.i1, lim1, point.i2, lim2, point.minHi], [off1, point.i1, off2, point.i2, point.minLo]);
    }
  }
}

// Whether a frequent line sits inside a run of lines without counterparts, and may be discarded with them.
function discardable(dis, i, start, end) {
  if (i - start > scanWindow) start = i - scanWindow;
  if (end - i > scanWindow) end = i + scanWindow;
  let before = 0, beforeMulti = 1, after = 0, afterMulti = 1;
  for (let r = 1; i - r >= start; r++) { if (!dis[i - r]) before++; else if (dis[i - r] === 2) beforeMulti++; else break; }
  if (!before) return false;
  for (let r = 1; i + r <= end; r++) { if (!dis[i + r]) after++; else if (dis[i + r] === 2) afterMulti++; else break; }
  if (!after) return false;
  return (beforeMulti + afterMulti) * keepRun < (beforeMulti + afterMulti) + (before + after);
}

// Changed lines of a and b (arrays of line class IDs), before compaction.
function markChanges(a, b, classes) {
  const n1 = a.n, n2 = b.n, limit = Math.min(n1, n2);
  let start = 0, tail = 0;
  while (start < limit && a.ids[start] === b.ids[start]) start++;
  while (tail < limit - start && a.ids[n1 - 1 - tail] === b.ids[n2 - 1 - tail]) tail++;
  const count1 = new Int32Array(classes), count2 = new Int32Array(classes);
  for (const id of a.ids) count1[id]++;
  for (const id of b.ids) count2[id]++;
  const reduce = (side, end, other) => {
    const max = Math.min(roughSqrt(side.n), maxEqualLimit), dis = new Uint8Array(side.n), index = [], hashes = [];
    for (let i = start; i <= end; i++) { const matches = other[side.ids[i]]; dis[i] = matches === 0 ? 0 : matches >= max ? 2 : 1; }
    for (let i = start; i <= end; i++) {
      if (dis[i] === 1 || (dis[i] === 2 && !discardable(dis, i, start, end))) { index.push(i); hashes.push(side.ids[i]); }
      else side.mark(i, 1);
    }
    return [Int32Array.from(hashes), index];
  };
  const [ha1, index1] = reduce(a, n1 - tail - 1, count2), [ha2, index2] = reduce(b, n2 - tail - 1, count1);
  myers(a, b, ha1, index1, ha2, index2);
}

// Slides each change group of side to its canonical place: as low as it goes, unless it can line up with a change group of other.
function compact(side, other) {
  const g = { start: 0, end: 0 }, go = { start: 0, end: 0 };
  const init = (s, group) => { group.start = group.end = 0; while (s.changed(group.end)) group.end++; };
  const next = (s, group) => {
    if (group.end === s.n) return false;
    group.start = group.end + 1;
    for (group.end = group.start; s.changed(group.end); group.end++);
    return true;
  };
  const previous = (s, group) => {
    if (group.start === 0) return false;
    group.end = group.start - 1;
    for (group.start = group.end; s.changed(group.start - 1); group.start--);
    return true;
  };
  const down = () => {
    if (g.end < side.n && side.ids[g.start] === side.ids[g.end]) {
      side.mark(g.start++, 0); side.mark(g.end++, 1);
      while (side.changed(g.end)) g.end++;
      return true;
    }
    return false;
  };
  const up = () => {
    if (g.start > 0 && side.ids[g.start - 1] === side.ids[g.end - 1]) {
      side.mark(--g.start, 1); side.mark(--g.end, 0);
      while (side.changed(g.start - 1)) g.start--;
      return true;
    }
    return false;
  };
  const broken = () => { throw Error('Text merge group sync broken'); };
  init(side, g); init(other, go);
  for (;;) {
    if (g.end !== g.start) {
      let size, earliestEnd, matchingEnd;
      do {
        size = g.end - g.start; matchingEnd = -1;
        while (up()) if (!previous(other, go)) broken();
        earliestEnd = g.end;
        if (go.end > go.start) matchingEnd = g.end;
        for (;;) {
          if (!down()) break;
          if (!next(other, go)) broken();
          if (go.end > go.start) matchingEnd = g.end;
        }
      } while (size !== g.end - g.start);
      if (g.end !== earliestEnd && matchingEnd !== -1) {
        while (go.end === go.start) { if (!up()) broken(); if (!previous(other, go)) broken(); }
      }
    }
    if (!next(side, g)) break;
    if (!next(other, go)) broken();
  }
}

// The edit script from a to b: [{i1, chg1, i2, chg2}] in order, i1/i2 being line indexes in a and b.
function diff(aIds, bIds, classes) {
  const a = new Side(aIds), b = new Side(bIds);
  markChanges(a, b, classes);
  compact(a, b); compact(b, a);
  const script = [];
  for (let i1 = a.n, i2 = b.n; i1 >= 0 || i2 >= 0; i1--, i2--) {
    if (a.changed(i1 - 1) || b.changed(i2 - 1)) {
      const l1 = i1, l2 = i2;
      while (a.changed(i1 - 1)) i1--;
      while (b.changed(i2 - 1)) i2--;
      script.push({ i1, i2, chg1: l1 - i1, chg2: l2 - i2 });
    }
  }
  return script.reverse();
}

// Three-way merge of base, ours and theirs (Uint8Array each).
// Returns { merged: Uint8Array } or { conflict: true, reason: 'both_modified' | 'binary' | 'too_large_to_merge', hunks }.
// hunks (at most textMergeLimits.hunks) give the conflicting regions as 0-based, end-exclusive line ranges of each file.
export function mergeText(baseBytes, oursBytes, theirsBytes) {
  const files = [baseBytes, oursBytes, theirsBytes].map(prepare), refused = files.find(file => file.reason);
  if (refused) return { conflict: true, reason: refused.reason, hunks: [] };
  const [base, ours, theirs] = files.map(file => file.lines), classes = new Map();
  const ids = list => Int32Array.from(list, line => { let id = classes.get(line); if (id === undefined) classes.set(line, id = classes.size); return id; });
  const [baseIds, oursIds, theirsIds] = [base, ours, theirs].map(ids);
  const script1 = diff(baseIds, oursIds, classes.size), script2 = diff(baseIds, theirsIds, classes.size);
  if (!script1.length) return { merged: theirsBytes };
  if (!script2.length) return { merged: oursBytes };
  // Merge regions: mode 0 conflict, 1 ours, 2 theirs, 4 resolved (both sides hold the same lines).
  const regions = [];
  const append = (mode, i0, chg0, i1, chg1, i2, chg2) => {
    const last = regions.at(-1);
    if (last && (i1 <= last.i1 + last.chg1 || i2 <= last.i2 + last.chg2)) {
      if (mode !== last.mode) last.mode = 0;
      last.chg0 = i0 + chg0 - last.i0; last.chg1 = i1 + chg1 - last.i1; last.chg2 = i2 + chg2 - last.i2;
    } else regions.push({ mode, i0, chg0, i1, chg1, i2, chg2 });
  };
  const sameLines = (from1, from2, count) => { for (let i = 0; i < count; i++) if (ours[from1 + i] !== theirs[from2 + i]) return false; return true; };
  let x = 0, y = 0;
  while (x < script1.length && y < script2.length) {
    const c1 = script1[x], c2 = script2[y];
    if (c1.i1 + c1.chg1 < c2.i1) { append(1, c1.i1, c1.chg1, c1.i2, c1.chg2, c2.i2 - c2.i1 + c1.i1, c1.chg1); x++; continue; }
    if (c2.i1 + c2.chg1 < c1.i1) { append(2, c2.i1, c2.chg1, c1.i2 - c1.i1 + c2.i1, c2.chg1, c2.i2, c2.chg2); y++; continue; }
    if (c1.i1 !== c2.i1 || c1.chg1 !== c2.chg1 || c1.chg2 !== c2.chg2 || !sameLines(c1.i2, c2.i2, c1.chg2)) {
      const off = c1.i1 - c2.i1, ffo = off + c1.chg1 - c2.chg1;
      let i0 = c1.i1, i1 = c1.i2, i2 = c2.i2;
      if (off > 0) { i0 -= off; i1 -= off; } else i2 += off;
      let chg0 = c1.i1 + c1.chg1 - i0, chg1 = c1.i2 + c1.chg2 - i1, chg2 = c2.i2 + c2.chg2 - i2;
      if (ffo < 0) { chg0 -= ffo; chg1 -= ffo; } else chg2 += ffo;
      append(0, i0, chg0, i1, chg1, i2, chg2);
    }
    const end1 = c1.i1 + c1.chg1, end2 = c2.i1 + c2.chg1;
    if (end1 >= end2) y++;
    if (end2 >= end1) x++;
  }
  for (; x < script1.length; x++) { const c = script1[x]; append(1, c.i1, c.chg1, c.i2, c.chg2, c.i1 + theirs.length - base.length, c.chg1); }
  for (; y < script2.length; y++) { const c = script2[y]; append(2, c.i1, c.chg1, c.i1 + ours.length - base.length, c.chg1, c.i2, c.chg2); }
  // A conflict whose two sides hold exactly the same lines is no conflict (git's refinement finds no difference).
  const hunks = [];
  for (const region of regions) {
    if (region.mode) continue;
    if (region.chg1 && region.chg1 === region.chg2 && sameLines(region.i1, region.i2, region.chg1)) { region.mode = 4; continue; }
    hunks.push({ baseStart: region.i0, baseEnd: region.i0 + region.chg0, oursStart: region.i1, oursEnd: region.i1 + region.chg1, theirsStart: region.i2, theirsEnd: region.i2 + region.chg2 });
  }
  if (hunks.length) return { conflict: true, reason: 'both_modified', hunks: hunks.slice(0, textMergeLimits.hunks) };
  // Ours with theirs' regions spliced in.
  const out = [];
  let at = 0;
  for (const region of regions) {
    if (region.mode !== 2) continue;
    for (; at < region.i1; at++) out.push(ours[at]);
    for (let i = region.i2; i < region.i2 + region.chg2; i++) out.push(theirs[i]);
    at = region.i1 + region.chg1;
  }
  for (; at < ours.length; at++) out.push(ours[at]);
  return { merged: encoder.encode(out.join('')) };
}
