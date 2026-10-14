// Minimal proto3 wire codec for the pinned Forgejo actions-proto v0.8.0 messages (runner.v1, ping.v1) and
// google.protobuf.Struct/Timestamp. Schemas are { field: [number, type, repeated?] }; type is a scalar name,
// a nested schema, or ['map', keyType, valueType].
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  bytes(value) { this.parts.push(value); this.length += value.length; }
  varint(value) {
    let n = BigInt.asUintN(64, BigInt(value)); const out = [];
    do { let byte = Number(n & 0x7fn); n >>= 7n; if (n) byte |= 0x80; out.push(byte); } while (n);
    this.bytes(Uint8Array.from(out));
  }
  tag(number, wire) { this.varint((number << 3) | wire); }
  finish() { const out = new Uint8Array(this.length); let at = 0; for (const part of this.parts) { out.set(part, at); at += part.length; } return out; }
}
const scalarWire = { string: 2, bytes: 2, int64: 0, int32: 0, enum: 0, bool: 0, double: 1 };
function writeValue(writer, number, type, value) {
  if (Array.isArray(type) && type[0] === 'map') {
    for (const [key, item] of Object.entries(value || {})) {
      const entry = new Writer(); writeValue(entry, 1, type[1], key); writeValue(entry, 2, type[2], item);
      const bytes = entry.finish(); writer.tag(number, 2); writer.varint(bytes.length); writer.bytes(bytes);
    }
    return;
  }
  if (typeof type === 'object') { const bytes = encode(type, value); writer.tag(number, 2); writer.varint(bytes.length); writer.bytes(bytes); return; }
  if (type === 'string') { const bytes = encoder.encode(String(value)); writer.tag(number, 2); writer.varint(bytes.length); writer.bytes(bytes); return; }
  if (type === 'bytes') { const bytes = value instanceof Uint8Array ? value : encoder.encode(String(value)); writer.tag(number, 2); writer.varint(bytes.length); writer.bytes(bytes); return; }
  if (type === 'double') { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value, true); writer.tag(number, 1); writer.bytes(new Uint8Array(view.buffer)); return; }
  writer.tag(number, 0); writer.varint(type === 'bool' ? (value ? 1 : 0) : value);
}
export function encode(schema, message = {}) {
  const writer = new Writer();
  for (const [name, [number, type, repeated]] of Object.entries(schema)) {
    const value = message[name];
    if (value === undefined || value === null) continue;
    if (repeated) { for (const item of value) writeValue(writer, number, type, item); continue; }
    // proto3 omits defaults for scalars; messages, maps and oneof members (marked `present`) are written when set.
    if (!(typeof type === 'object') && !schema[name][3] && (value === '' || value === 0 || value === false || value === 0n)) continue;
    writeValue(writer, number, type, value);
  }
  return writer.finish();
}

class Reader {
  constructor(bytes) { this.bytes = bytes; this.at = 0; }
  varint() {
    let result = 0n, shift = 0n;
    for (;;) {
      if (this.at >= this.bytes.length || shift > 63n) throw Error('Truncated varint');
      const byte = this.bytes[this.at++]; result |= BigInt(byte & 0x7f) << shift; shift += 7n;
      if (!(byte & 0x80)) return result;
    }
  }
  take(length) { if (this.at + length > this.bytes.length) throw Error('Truncated field'); const out = this.bytes.subarray(this.at, this.at + length); this.at += length; return out; }
}
function readValue(reader, wire, type) {
  if (wire === 0) { const n = reader.varint(); return type === 'bool' ? n !== 0n : type === 'int64' ? Number(BigInt.asIntN(64, n)) : Number(BigInt.asIntN(32, n)); }
  if (wire === 1) { const bytes = reader.take(8); return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true); }
  if (wire === 5) { reader.take(4); return 0; }
  if (wire !== 2) throw Error('Unsupported wire type');
  const bytes = reader.take(Number(reader.varint()));
  if (Array.isArray(type) && type[0] === 'map') { const entry = decode({ key: [1, type[1]], value: [2, type[2]] }, bytes); return [entry.key ?? (type[1] === 'string' ? '' : 0), entry.value ?? defaultOf(type[2])]; }
  if (typeof type === 'object') return decode(type, bytes);
  if (type === 'string') return decoder.decode(bytes);
  if (type === 'bytes') return bytes.slice();
  // Packed repeated scalars.
  const packed = new Reader(bytes), values = [];
  while (packed.at < bytes.length) values.push(readValue(packed, 0, type));
  return { packed: values };
}
const defaultOf = type => typeof type === 'object' ? {} : type === 'string' ? '' : type === 'bool' ? false : type === 'bytes' ? new Uint8Array() : 0;
export function decode(schema, bytes) {
  const byNumber = new Map(Object.entries(schema).map(([name, spec]) => [spec[0], [name, spec]]));
  const reader = new Reader(bytes), message = {};
  for (const [name, [, type, repeated]] of Object.entries(schema)) if (Array.isArray(type) && type[0] === 'map') message[name] = {}; else if (repeated) message[name] = [];
  while (reader.at < bytes.length) {
    const key = Number(reader.varint()), number = key >>> 3, wire = key & 7, known = byNumber.get(number);
    if (!known) { readValue(reader, wire, 'bytes'); continue; }
    const [name, [, type, repeated]] = known, value = readValue(reader, wire, type);
    if (Array.isArray(type) && type[0] === 'map') message[name][value[0]] = value[1];
    else if (repeated) { if (value?.packed) message[name].push(...value.packed); else message[name].push(value); }
    else message[name] = value;
  }
  return message;
}

// google.protobuf.Struct / Value / ListValue / Timestamp
export const Value = {};
export const Struct = { fields: [1, ['map', 'string', Value]] };
const ListValue = { values: [1, Value, true] };
Object.assign(Value, { null_value: [1, 'enum', false, true], number_value: [2, 'double', false, true], string_value: [3, 'string', false, true], bool_value: [4, 'bool', false, true], struct_value: [5, Struct], list_value: [6, ListValue] });
export function toValue(value) {
  if (value === null || value === undefined) return { null_value: 0 };
  if (typeof value === 'string') return { string_value: value };
  if (typeof value === 'number') return { number_value: value };
  if (typeof value === 'boolean') return { bool_value: value };
  if (Array.isArray(value)) return { list_value: { values: value.map(toValue) } };
  return { struct_value: toStruct(value) };
}
export const toStruct = object => ({ fields: Object.fromEntries(Object.entries(object).map(([key, value]) => [key, toValue(value)])) });
export const Timestamp = { seconds: [1, 'int64'], nanos: [2, 'int32'] };
export const timestampISO = value => value && (value.seconds || value.nanos) ? new Date(value.seconds * 1000 + Math.floor((value.nanos || 0) / 1e6)).toISOString() : null;
