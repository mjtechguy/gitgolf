// AES-GCM envelope shared by native stores. Each caller owns its Secrets Store binding and its additional-data domain.
const text = new TextEncoder();
const encode = bytes => btoa(String.fromCharCode(...bytes)), decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function sealingKey(binding, label) {
  const value = await binding.get();
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw Error(label + ' encryption key unavailable');
  const raw = decode(value);
  // A short one-way name for the key: stored beside ciphertext so a later rotation can find what it must re-seal.
  const named = await crypto.subtle.digest('SHA-256', new Uint8Array([...text.encode('golf.native.sealing-key.v1\n'), ...raw]));
  return { key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']),
    id: Array.from(new Uint8Array(named).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('') };
}
export async function seal(key, additional, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: text.encode(JSON.stringify(additional)) }, key, text.encode(plain));
  return encode(iv) + '.' + encode(new Uint8Array(encrypted));
}
export async function open(key, additional, sealed) {
  const [iv, encrypted] = sealed.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: text.encode(JSON.stringify(additional)) }, key, decode(encrypted)));
}
