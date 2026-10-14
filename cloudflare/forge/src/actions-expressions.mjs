// The subset of GitHub Actions expressions Golf evaluates on the server while expanding a workflow:
// job names, runs-on, matrices, concurrency groups and run names. Steps, if:, env and with: are left for the
// stock runner. Anything outside the subset throws ExpressionUnsupported, so callers can refuse visibly.
export class ExpressionUnsupported extends Error {}
const unsupported = message => { throw new ExpressionUnsupported(message); };

function tokens(source) {
  const out = [];
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let value = '';
      for (i++; ; i++) {
        if (i >= source.length) unsupported('Unterminated string in expression.');
        if (source[i] === "'") { if (source[i + 1] === "'") { value += "'"; i++; continue; } i++; break; }
        value += source[i];
      }
      out.push({ type: 'string', value }); continue;
    }
    const number = /^(?:0x[0-9a-fA-F]+|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
    if (number && !/[A-Za-z_]/.test(source[i + number[0].length] || '')) { out.push({ type: 'number', value: Number(number[0]) }); i += number[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(i));
    if (word) { out.push({ type: 'word', value: word[0] }); i += word[0].length; continue; }
    const op = /^(?:==|!=|<=|>=|&&|\|\||[<>!().,[\]*])/.exec(source.slice(i));
    if (op) { out.push({ type: 'op', value: op[0] }); i += op[0].length; continue; }
    unsupported('Unsupported character in expression: ' + c);
  }
  return out;
}

const truthy = value => !(value === null || value === undefined || value === false || value === 0 || value === '' || Number.isNaN(value));
const toNumber = value => value === null || value === undefined ? 0 : typeof value === 'boolean' ? Number(value) : typeof value === 'number' ? value :
  typeof value === 'string' ? (value.trim() === '' ? 0 : Number(value)) : NaN;
const text = value => value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
function equal(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (a === null || a === undefined) a = null; if (b === null || b === undefined) b = null;
  if (typeof a === typeof b && (typeof a !== 'object' || a === null)) return a === b;
  if (typeof a === 'object' || typeof b === 'object') return a === b;
  return toNumber(a) === toNumber(b);
}
function compare(a, b) {
  if (typeof a === 'string' && typeof b === 'string') { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  const x = toNumber(a), y = toNumber(b);
  return Number.isNaN(x) || Number.isNaN(y) ? NaN : x - y;
}
const functions = {
  contains: (haystack, needle) => Array.isArray(haystack) ? haystack.some(item => equal(item, needle)) : text(haystack).toLowerCase().includes(text(needle).toLowerCase()),
  startswith: (a, b) => text(a).toLowerCase().startsWith(text(b).toLowerCase()),
  endswith: (a, b) => text(a).toLowerCase().endsWith(text(b).toLowerCase()),
  format: (pattern, ...args) => text(pattern).replace(/\{\{|\}\}|\{(\d+)\}/g, (all, index) => all === '{{' ? '{' : all === '}}' ? '}' : text(args[Number(index)])),
  join: (value, separator = ',') => Array.isArray(value) ? value.map(text).join(text(separator)) : text(value),
  tojson: value => JSON.stringify(value ?? null, null, 2),
  fromjson: value => { try { return JSON.parse(text(value)); } catch { unsupported('fromJSON received invalid JSON.'); } },
};

function parser(list, context) {
  let at = 0;
  const peek = () => list[at], take = () => list[at++];
  const expect = value => { const token = take(); if (token?.value !== value) unsupported(`Expected ${value} in expression.`); };
  const primary = () => {
    const token = take();
    if (!token) unsupported('Incomplete expression.');
    if (token.type === 'string' || token.type === 'number') return token.value;
    if (token.type === 'op' && token.value === '(') { const value = or(); expect(')'); return value; }
    if (token.type === 'op' && token.value === '!') return !truthy(unary());
    if (token.type !== 'word') unsupported('Unexpected token in expression.');
    const name = token.value.toLowerCase();
    if (name === 'true') return true; if (name === 'false') return false; if (name === 'null') return null;
    if (peek()?.value === '(') {
      take(); const args = [];
      if (peek()?.value !== ')') for (;;) { args.push(or()); if (peek()?.value === ',') { take(); continue; } break; }
      expect(')');
      if (!Object.hasOwn(functions, name)) unsupported(`${token.value}() is evaluated by the runner, not while expanding the workflow.`);
      return functions[name](...args);
    }
    if (!Object.hasOwn(context, name)) unsupported(`The ${token.value} context is not available while expanding the workflow.`);
    let value = context[name];
    for (;;) {
      if (peek()?.value === '.') {
        take(); const property = take();
        if (property?.value === '*') { value = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []; continue; }
        if (property?.type !== 'word') unsupported('Expected a property name.');
        value = lookup(value, property.value);
      } else if (peek()?.value === '[') {
        take(); const key = or(); expect(']'); value = lookup(value, key);
      } else return value;
    }
  };
  const lookup = (value, key) => {
    if (value === null || value === undefined || typeof value !== 'object') return null;
    if (Array.isArray(value)) return typeof key === 'number' ? value[key] ?? null : value.map(item => lookup(item, key));
    const match = Object.keys(value).find(name => name.toLowerCase() === String(key).toLowerCase());
    return match === undefined ? null : value[match];
  };
  const unary = () => primary();
  const comparison = () => {
    let left = unary();
    for (;;) {
      const op = peek()?.value;
      if (!['==', '!=', '<', '<=', '>', '>='].includes(op)) return left;
      take(); const right = unary();
      if (op === '==') left = equal(left, right); else if (op === '!=') left = !equal(left, right);
      else { const c = compare(left, right); left = Number.isNaN(c) ? false : op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0; }
    }
  };
  const and = () => { let left = comparison(); while (peek()?.value === '&&') { take(); const right = comparison(); left = truthy(left) ? right : left; } return left; };
  const or = () => { let left = and(); while (peek()?.value === '||') { take(); const right = and(); left = truthy(left) ? left : right; } return left; };
  const value = or();
  if (at !== list.length) unsupported('Unexpected trailing tokens in expression.');
  return value;
}

export function evaluate(expression, context) {
  if (typeof expression !== 'string' || expression.length > 4096) unsupported('Expression too long.');
  return parser(tokens(expression), Object.fromEntries(Object.entries(context).map(([key, value]) => [key.toLowerCase(), value])));
}
// A whole-value expression keeps its type ("${{ matrix.node }}" → 26); embedded ones interpolate as text.
export function interpolate(value, context) {
  if (typeof value !== 'string' || !value.includes('${{')) return value;
  const whole = /^\s*\$\{\{([\s\S]*?)\}\}\s*$/.exec(value);
  if (whole && !whole[1].includes('}}')) return evaluate(whole[1], context);
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, inner) => text(evaluate(inner, context)));
}
// Deep interpolation for matrix values and runs-on objects.
export function interpolateDeep(value, context) {
  if (typeof value === 'string') return interpolate(value, context);
  if (Array.isArray(value)) return value.map(item => interpolateDeep(item, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateDeep(item, context)]));
  return value;
}
export const expressionText = text;
export const expressionTruthy = truthy;
