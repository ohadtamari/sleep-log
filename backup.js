// Encrypted backup. Everything is encrypted here, on the device, before it leaves.
// The recovery code is the only way to read a backup: the service never receives it.
window.SleepBackup = (() => {
  'use strict';

  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O or U, which are easy to misread
  const CODE_CHARS = 24; // 120 random bits
  const FORMAT = 1;
  const IV_BYTES = 12;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const HKDF_SALT = enc.encode('sleep-log-backup');
  const AAD = enc.encode('sleep-log-backup-v1');

  const group = (chars) => chars.match(/.{1,4}/g).join('-');

  const newCode = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_CHARS * 5 / 8));
    let bits = 0;
    let value = 0;
    let out = '';
    bytes.forEach((b) => {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out += ALPHABET[(value >> bits) & 31];
      }
      value &= (1 << bits) - 1;
    });
    return group(out);
  };

  // Accepts a code as typed: any case, with or without separators.
  const normalizeCode = (text) => {
    const chars = String(text).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (chars.length !== CODE_CHARS || [...chars].some((c) => !ALPHABET.includes(c))) return null;
    return group(chars);
  };

  const deriveKeys = async (code) => {
    const ikm = await crypto.subtle.importKey('raw', enc.encode(code.replace(/-/g, '')), 'HKDF', false, ['deriveKey', 'deriveBits']);
    const params = (label) => ({ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: enc.encode(label) });
    const key = await crypto.subtle.deriveKey(params('encryption v1'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(params('auth v1'), ikm, 256));
    const token = btoa(String.fromCharCode(...bits)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { key, token };
  };

  const seal = async (entries, key) => {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plain = enc.encode(JSON.stringify({ entries }));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, plain));
    const out = new Uint8Array(1 + IV_BYTES + cipher.length);
    out[0] = FORMAT;
    out.set(iv, 1);
    out.set(cipher, 1 + IV_BYTES);
    return out;
  };

  const open = async (bytes, key) => {
    if (bytes[0] !== FORMAT) throw new Error('Unknown backup format');
    const iv = bytes.slice(1, 1 + IV_BYTES);
    const cipher = bytes.slice(1 + IV_BYTES);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, cipher);
    return JSON.parse(dec.decode(plain)).entries;
  };

  const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });

  // Each call returns the HTTP status. A network failure rejects.
  const upload = async (url, code, entries) => {
    const { key, token } = await deriveKeys(code);
    const body = await seal(entries, key);
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/octet-stream' },
      body,
    });
    return res.status;
  };

  const download = async (url, code) => {
    const { key, token } = await deriveKeys(code);
    const res = await fetch(url, { headers: authHeaders(token), cache: 'no-store' });
    if (!res.ok) return { status: res.status, entries: null };
    return { status: res.status, entries: await open(new Uint8Array(await res.arrayBuffer()), key) };
  };

  const remove = async (url, code) => {
    const { token } = await deriveKeys(code);
    const res = await fetch(url, { method: 'DELETE', headers: authHeaders(token) });
    return res.status;
  };

  return { newCode, normalizeCode, deriveKeys, seal, open, upload, download, remove };
})();
