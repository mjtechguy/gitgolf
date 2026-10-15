// Line diff for Source API blame (docs/SOURCE_API.md): which lines of a newer version are unchanged lines of an older one, decided the way
// `git blame` decides them. A port of Git's xdiff Myers path as blame drives it (xdi_diff with no context, default options):
// - the common tail is trimmed in 1 KiB blocks (xdiff-interface.c trim_common_tail);
// - the common first and last lines are set aside and lines without a match on the other side, or repeated lines among them, are
//   discarded as changes (xdl_trim_ends, xdl_cleanup_records);
// - Myers' divide-and-conquer O(ND) search with xdiff's cost cut-offs (xdl_recs_cmp, xdl_split), so time stays bounded on large rewrites;
// - change compaction with the indent heuristic, Git's default since 2.14 (xdl_change_compact).
// Self-contained and pure. Texts are byte strings (one character per byte, for example from latin1 decoding): lines and the 1 KiB blocks
// are measured in characters.

const lineMax = 0x7fffffff;
// The line records of a text: each line keeps its newline; a last line without one is its own record.
export function splitLines(text) {
  const lines = [];
  for (let start = 0; start < text.length;) {
    const end = text.indexOf('\n', start), next = end === -1 ? text.length : end + 1;
    lines.push(text.slice(start, next)); start = next;
  }
  return lines;
}

// Returns { a, b, map }: the line records of both texts, and map[j] = the index in a of the unchanged line b[j], or -1 when b[j] changed.
export function lineMatches(aText, bText) {
  // trim_common_tail: whole 1 KiB blocks of a common tail are left out, then given back up to the first newline in them.
  let trimmed = 0;
  const smaller = Math.min(aText.length, bText.length);
  while (trimmed + 1024 <= smaller && aText.slice(aText.length - trimmed - 1024, aText.length - trimmed) === bText.slice(bText.length - trimmed - 1024, bText.length - trimmed)) trimmed += 1024;
  let recovered = 0;
  while (recovered < trimmed) if (aText[aText.length - trimmed + recovered++] === '\n') break;
  const cut = trimmed - recovered, a = splitLines(aText.slice(0, aText.length - cut)), b = splitLines(bText.slice(0, bText.length - cut));
  const tail = splitLines(aText.slice(aText.length - cut)).length, n = a.length, m = b.length;
  const changedA = new Uint8Array(n), changedB = new Uint8Array(m);
  diff(a, b, changedA, changedB);
  compact(a, changedA, changedB); compact(b, changedB, changedA);
  const fullA = tail ? splitLines(aText) : a, fullB = tail ? splitLines(bText) : b, map = new Int32Array(fullB.length).fill(-1);
  // Unchanged lines pair up in order on both sides; the trimmed tail is unchanged.
  for (let i = 0, j = 0; i < n && j < m; i++, j++) {
    while (i < n && changedA[i]) i++;
    while (j < m && changedB[j]) j++;
    if (i < n && j < m) map[j] = i;
  }
  for (let k = 0; k < tail; k++) map[m + k] = n + k;
  return { a: fullA, b: fullB, map };
}

const bogosqrt = n => { let i = 1; for (; n > 0; n = Math.floor(n / 4)) i *= 2; return i; };

function diff(a, b, changedA, changedB) {
  const n = a.length, m = b.length, ids = new Map(), countA = [], countB = [];
  const id = line => { let value = ids.get(line); if (value === undefined) { ids.set(line, value = ids.size); countA.push(0); countB.push(0); } return value; };
  const ha = a.map(line => id(line)), hb = b.map(line => id(line));
  for (const value of ha) countA[value]++;
  for (const value of hb) countB[value]++;
  // xdl_trim_ends
  let start = 0, suffix = 0;
  const limit = Math.min(n, m);
  while (start < limit && ha[start] === hb[start]) start++;
  while (suffix < limit - start && ha[n - 1 - suffix] === hb[m - 1 - suffix]) suffix++;
  const endA = n - suffix - 1, endB = m - suffix - 1;
  // xdl_cleanup_records: 0 no match on the other side, 1 a few matches, 2 many (at least √n, at most 1024).
  const kept = (h, count, total, end, changed) => {
    const limit = Math.min(bogosqrt(total), 1024), dis = new Uint8Array(total + 1), rindex = [], hashes = [];
    for (let i = start; i <= end; i++) { const matches = count[h[i]]; dis[i] = matches === 0 ? 0 : matches >= limit ? 2 : 1; }
    for (let i = start; i <= end; i++) {
      if (dis[i] === 1 || dis[i] === 2 && !multimatchDiscarded(dis, i, start, end)) { rindex.push(i); hashes.push(h[i]); }
      else changed[i] = 1;
    }
    return { rindex, hashes };
  };
  const one = kept(ha, countB, n, endA, changedA), two = kept(hb, countA, m, endB, changedB);
  recordsCompare(one, two, changedA, changedB);
}

// xdl_clean_mmatch: a repeated line is discarded when it sits in a run made mostly of lines without a match.
function multimatchDiscarded(dis, i, s, e) {
  if (i - s > 100) s = i - 100;
  if (e - i > 100) e = i + 100;
  let r, before = 0, beforeMulti = 1, after = 0, afterMulti = 1;
  for (r = 1; i - r >= s; r++) { if (!dis[i - r]) before++; else if (dis[i - r] === 2) beforeMulti++; else break; }
  if (before === 0) return false;
  for (r = 1; i + r <= e; r++) { if (!dis[i + r]) after++; else if (dis[i + r] === 2) afterMulti++; else break; }
  if (after === 0) return false;
  const runs = after + before, multi = afterMulti + beforeMulti;
  return multi * 4 < multi + runs;
}

// xdl_do_diff / xdl_recs_cmp over the kept records, with an explicit stack instead of recursion.
function recordsCompare(one, two, changedA, changedB) {
  const h1 = one.hashes, h2 = two.hashes, n1 = h1.length, n2 = h2.length, diagonals = n1 + n2 + 3;
  const kvd = new Int32Array(2 * diagonals + 2), base = n2 + 1, mxcost = Math.max(bogosqrt(diagonals), 256);
  const env = { mxcost, snakeCount: 20, heuristicMin: 256 };
  const kvdf = { get: d => kvd[base + d], set: (d, value) => { kvd[base + d] = value; } };
  const kvdb = { get: d => kvd[diagonals + base + d], set: (d, value) => { kvd[diagonals + base + d] = value; } };
  const stack = [[0, n1, 0, n2, false]];
  while (stack.length) {
    let [off1, lim1, off2, lim2, needMin] = stack.pop();
    while (off1 < lim1 && off2 < lim2 && h1[off1] === h2[off2]) { off1++; off2++; }
    while (off1 < lim1 && off2 < lim2 && h1[lim1 - 1] === h2[lim2 - 1]) { lim1--; lim2--; }
    if (off1 === lim1) { for (; off2 < lim2; off2++) changedB[two.rindex[off2]] = 1; }
    else if (off2 === lim2) { for (; off1 < lim1; off1++) changedA[one.rindex[off1]] = 1; }
    else {
      const split = xdlSplit(h1, off1, lim1, h2, off2, lim2, kvdf, kvdb, needMin, env);
      stack.push([split.i1, lim1, split.i2, lim2, split.minHi], [off1, split.i1, off2, split.i2, split.minLo]);
    }
  }
}

// xdl_split: the middle snake of the box, searched forward and backward at once. Past heuristicMin edits a long enough snake is taken;
// past mxcost edits the furthest-reaching diagonal is, so the result is then not minimal (as in Git).
function xdlSplit(ha1, off1, lim1, ha2, off2, lim2, kvdf, kvdb, needMin, env) {
  const dmin = off1 - lim2, dmax = lim1 - off2, fmid = off1 - off2, bmid = lim1 - lim2, odd = (fmid - bmid) & 1;
  let fmin = fmid, fmax = fmid, bmin = bmid, bmax = bmid;
  kvdf.set(fmid, off1); kvdb.set(bmid, lim1);
  for (let ec = 1; ; ec++) {
    let gotSnake = false;
    if (fmin > dmin) kvdf.set(--fmin - 1, -1); else ++fmin;
    if (fmax < dmax) kvdf.set(++fmax + 1, -1); else --fmax;
    for (let d = fmax; d >= fmin; d -= 2) {
      let i1 = kvdf.get(d - 1) >= kvdf.get(d + 1) ? kvdf.get(d - 1) + 1 : kvdf.get(d + 1);
      const previous = i1;
      let i2 = i1 - d;
      for (; i1 < lim1 && i2 < lim2 && ha1[i1] === ha2[i2]; i1++, i2++);
      if (i1 - previous > env.snakeCount) gotSnake = true;
      kvdf.set(d, i1);
      if (odd && bmin <= d && d <= bmax && kvdb.get(d) <= i1) return { i1, i2, minLo: true, minHi: true };
    }
    if (bmin > dmin) kvdb.set(--bmin - 1, lineMax); else ++bmin;
    if (bmax < dmax) kvdb.set(++bmax + 1, lineMax); else --bmax;
    for (let d = bmax; d >= bmin; d -= 2) {
      let i1 = kvdb.get(d - 1) < kvdb.get(d + 1) ? kvdb.get(d - 1) : kvdb.get(d + 1) - 1;
      const previous = i1;
      let i2 = i1 - d;
      for (; i1 > off1 && i2 > off2 && ha1[i1 - 1] === ha2[i2 - 1]; i1--, i2--);
      if (previous - i1 > env.snakeCount) gotSnake = true;
      kvdb.set(d, i1);
      if (!odd && fmin <= d && d <= fmax && i1 <= kvdf.get(d)) return { i1, i2, minLo: true, minHi: true };
    }
    if (needMin) continue;
    if (gotSnake && ec > env.heuristicMin) {
      let best = 0, found = null;
      for (let d = fmax; d >= fmin; d -= 2) {
        const dd = d > fmid ? d - fmid : fmid - d, i1 = kvdf.get(d), i2 = i1 - d, v = i1 - off1 + (i2 - off2) - dd;
        if (v > 4 * ec && v > best && off1 + env.snakeCount <= i1 && i1 < lim1 && off2 + env.snakeCount <= i2 && i2 < lim2) {
          for (let k = 1; ha1[i1 - k] === ha2[i2 - k]; k++) if (k === env.snakeCount) { best = v; found = { i1, i2 }; break; }
        }
      }
      if (best > 0) return { ...found, minLo: true, minHi: false };
      best = 0;
      for (let d = bmax; d >= bmin; d -= 2) {
        const dd = d > bmid ? d - bmid : bmid - d, i1 = kvdb.get(d), i2 = i1 - d, v = lim1 - i1 + (lim2 - i2) - dd;
        if (v > 4 * ec && v > best && off1 < i1 && i1 <= lim1 - env.snakeCount && off2 < i2 && i2 <= lim2 - env.snakeCount) {
          for (let k = 0; ha1[i1 + k] === ha2[i2 + k]; k++) if (k === env.snakeCount - 1) { best = v; found = { i1, i2 }; break; }
        }
      }
      if (best > 0) return { ...found, minLo: false, minHi: true };
    }
    if (ec >= env.mxcost) {
      let fbest = -1, fbest1 = -1, bbest = lineMax, bbest1 = lineMax;
      for (let d = fmax; d >= fmin; d -= 2) {
        let i1 = Math.min(kvdf.get(d), lim1), i2 = i1 - d;
        if (lim2 < i2) { i1 = lim2 + d; i2 = lim2; }
        if (fbest < i1 + i2) { fbest = i1 + i2; fbest1 = i1; }
      }
      for (let d = bmax; d >= bmin; d -= 2) {
        let i1 = Math.max(off1, kvdb.get(d)), i2 = i1 - d;
        if (i2 < off2) { i1 = off2 + d; i2 = off2; }
        if (i1 + i2 < bbest) { bbest = i1 + i2; bbest1 = i1; }
      }
      return lim1 + lim2 - bbest < fbest - (off1 + off2) ? { i1: fbest1, i2: fbest - fbest1, minLo: true, minHi: false } : { i1: bbest1, i2: bbest - bbest1, minLo: false, minHi: true };
    }
  }
}

// xdl_change_compact for one side (lines, changed) against the other side's changes (other). Groups are maximal runs of changed lines;
// each group here corresponds, in order, to a (possibly empty) group on the other side.
function compact(lines, changed, other) {
  const n = changed.length, no = other.length, g = { start: 0, end: 0 }, go = { start: 0, end: 0 };
  const groupEnd = (flags, length, group) => { while (group.end < length && flags[group.end]) group.end++; };
  const next = (flags, length, group) => {
    if (group.end === length) return false;
    group.start = group.end + 1; group.end = group.start; groupEnd(flags, length, group); return true;
  };
  const previous = (flags, group) => {
    if (group.start === 0) return false;
    group.end = group.start - 1; group.start = group.end;
    while (group.start > 0 && flags[group.start - 1]) group.start--;
    return true;
  };
  const slideDown = () => {
    if (g.end >= n || lines[g.start] !== lines[g.end]) return false;
    changed[g.start++] = 0; changed[g.end++] = 1; groupEnd(changed, n, g); return true;
  };
  const slideUp = () => {
    if (g.start === 0 || lines[g.start - 1] !== lines[g.end - 1]) return false;
    changed[--g.start] = 1; changed[--g.end] = 0;
    while (g.start > 0 && changed[g.start - 1]) g.start--;
    return true;
  };
  const up = message => { if (!slideUp()) throw Error(message); if (!previous(other, go)) throw Error('Line diff groups out of step'); };
  groupEnd(changed, n, g); groupEnd(other, no, go);
  for (;;) {
    if (g.end !== g.start) {
      let size, earliestEnd, endMatchingOther;
      do {
        size = g.end - g.start; endMatchingOther = -1;
        while (slideUp()) if (!previous(other, go)) throw Error('Line diff groups out of step');
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;
        while (slideDown()) {
          if (!next(other, no, go)) throw Error('Line diff groups out of step');
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (size !== g.end - g.start);
      // Slid as far down as it goes. If it can line up with a change on the other side, back up to meet it; otherwise take the
      // best-scoring position of the last 100 (the indent heuristic).
      if (g.end !== earliestEnd && endMatchingOther !== -1) {
        while (go.end === go.start) up('Line diff match lost');
      } else if (g.end !== earliestEnd) {
        let best = -1, bestScore;
        for (let shift = Math.max(earliestEnd, g.end - size - 1, g.end - 100); shift <= g.end; shift++) {
          const score = { indent: 0, penalty: 0 };
          scoreSplit(lines, shift, score); scoreSplit(lines, shift - size, score);
          if (best === -1 || compareScores(score, bestScore) <= 0) { bestScore = score; best = shift; }
        }
        while (g.end > best) up('Line diff best shift unreached');
      }
    }
    if (!next(changed, n, g)) break;
    if (!next(other, no, go)) throw Error('Line diff groups out of step');
  }
}

// The indent heuristic (xdiff measure_split, score_add_split and score_cmp): a split between two lines scores by the indentation around
// it and the blank lines next to it; lower is better. A line of only whitespace has no indent (-1).
function indentOf(line) {
  let indent = 0;
  for (const c of line) {
    if (c === ' ') indent++;
    else if (c === '\t') indent += 8 - indent % 8;
    else if (!'\n\r\v\f'.includes(c)) return indent;
    if (indent >= 200) return 200;
  }
  return -1;
}
function scoreSplit(lines, split, score) {
  const end = split >= lines.length, indent = end ? -1 : indentOf(lines[split]);
  let preBlank = 0, preIndent = -1, postBlank = 0, postIndent = -1;
  for (let i = split - 1; i >= 0; i--) {
    if ((preIndent = indentOf(lines[i])) !== -1) break;
    if (++preBlank === 20) { preIndent = 0; break; }
  }
  for (let i = split + 1; i < lines.length; i++) {
    if ((postIndent = indentOf(lines[i])) !== -1) break;
    if (++postBlank === 20) { postIndent = 0; break; }
  }
  if (preIndent === -1 && preBlank === 0) score.penalty += 1;
  if (end) score.penalty += 21;
  const post = indent === -1 ? 1 + postBlank : 0, total = preBlank + post, effective = indent !== -1 ? indent : postIndent;
  score.penalty += -30 * total + 6 * post;
  score.indent += effective;
  if (effective === -1 || preIndent === -1 || effective === preIndent) return;
  if (effective > preIndent) score.penalty += total ? 10 : -4;
  else if (postIndent !== -1 && postIndent > effective) score.penalty += total ? 17 : 24;
  else score.penalty += total ? 17 : 23;
}
const compareScores = (a, b) => 60 * ((a.indent > b.indent) - (a.indent < b.indent)) + (a.penalty - b.penalty);
