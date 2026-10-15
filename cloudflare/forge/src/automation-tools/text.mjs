// Small text helpers shared by the automation tools.
const encoder = new TextEncoder();
export const byteLength = value => encoder.encode(value).length;
// A UTF-8 prefix of at most `limit` bytes, never splitting a character.
export function clipBytes(text, limit) {
  const value = String(text ?? '');
  if (byteLength(value) <= limit) return value;
  let out = '';
  for (const c of value) { if (byteLength(out + c) > limit - 3) break; out += c; }
  return out + '…';
}
// The last `limit` bytes, starting at a line boundary when one is near.
export function tailBytes(text, limit) {
  const value = String(text ?? '');
  if (byteLength(value) <= limit) return value;
  let out = '';
  for (const c of [...value].reverse()) { if (byteLength(c + out) > limit) break; out = c + out; }
  const line = out.indexOf('\n');
  return line >= 0 && line < 200 ? out.slice(line + 1) : out;
}
// A Markdown code fence that the text cannot close: one backtick longer than its longest run.
export function fenced(text, info = '') {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${info}\n${String(text).replace(/\n$/, '')}\n${fence}`;
}
