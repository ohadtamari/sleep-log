// Cloudflare Worker that sends the sleep log's morning and evening reminders.
// It also stores the encrypted backup, which it cannot read: the app encrypts the
// data with a recovery code that never reaches this service.
//
// Setup in the Cloudflare dashboard:
//   Cron trigger:  0 * * * *   (runs hourly; the code picks the hours below)
//   Secrets:       VAPID_PRIVATE_JWK, PUSH_SUBSCRIPTION, TEST_TOKEN
//   Variable:      REMINDER_HOURS, optional, for example "8,22" (Israel time)
//   KV binding:    BACKUPS
//
// Test: open https://<worker address>/test?token=<TEST_TOKEN>

const TIME_ZONE = 'Asia/Jerusalem';
const DEFAULT_HOURS = '8,22';
const MORNING_ENDS_AT = 15;
const VAPID_SUBJECT = 'https://ohadtamari.github.io/sleep-log/'; // Apple requires a real URL or mailto
const TTL_SECONDS = 4 * 60 * 60; // a reminder older than this is no longer useful
const RECORD_SIZE = 4096;

const enc = new TextEncoder();

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text) => Uint8Array.from(
  atob(text.replace(/-/g, '+').replace(/_/g, '/')),
  (c) => c.charCodeAt(0),
);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  parts.forEach((p) => { out.set(p, at); at += p.length; });
  return out;
};

const hkdf = async (salt, ikm, info, length) => {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
};

// RFC 8291: only the phone can read the message, not the push service in between.
// `fixed` supplies the salt and sender key for the RFC's test vector.
const encryptPayload = async (text, subscription, fixed = {}) => {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  const salt = fixed.salt || crypto.getRandomValues(new Uint8Array(16));
  const pair = fixed.keyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, pair.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(enc.encode(text), new Uint8Array([2]));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
};

// RFC 8292: proves to the push service that this sender owns the app's key.
const vapidHeader = async (endpoint, jwk, now = Date.now()) => {
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 60 * 60,
    sub: VAPID_SUBJECT,
  })));
  const key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  const publicKey = concat(new Uint8Array([4]), fromB64url(jwk.x), fromB64url(jwk.y));
  return `vapid t=${head}.${claims}.${b64url(signature)}, k=${b64url(publicKey)}`;
};

const localHour = (time) => Number(new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23',
}).format(time));

const reminderHours = (env) => String(env.REMINDER_HOURS || DEFAULT_HOURS)
  .split(',').map((h) => Number(h.trim())).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);

const partFor = (hour) => (hour >= 4 && hour < MORNING_ENDS_AT ? 'morning' : 'evening');

const sendPush = async (env, part) => {
  const subscription = JSON.parse(env.PUSH_SUBSCRIPTION);
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(subscription.endpoint, jwk),
      TTL: String(TTL_SECONDS),
      Urgency: 'high',
      Topic: 'sleep-log-reminder', // an unread reminder is replaced, not stacked
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
    },
    body: await encryptPayload(JSON.stringify({ part }), subscription),
  });
  return response;
};

const report = async (response) => {
  if (response.ok) return `sent (${response.status})`;
  const expired = response.status === 404 || response.status === 410;
  const detail = await response.text();
  return `${expired ? 'subscription expired: enable notifications again in the app. ' : 'failed. '}status ${response.status} ${detail}`;
};

// ---------- encrypted backup ----------
const APP_ORIGIN = 'https://ohadtamari.github.io';
const MAX_BACKUP_BYTES = 1024 * 1024;
const AUTH_KEY = 'auth';
const DATA_KEY = 'backup';
const TOKEN_RE = /^[\w-]{43}$/;

const backupResponse = (body, status) => new Response(body, {
  status,
  headers: {
    'Access-Control-Allow-Origin': APP_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
  },
});

const hashToken = async (token) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(token)));

// There is one backup. The first writer's token claims it, and only the same token
// can read, replace or delete it. If someone else claimed it first, the app gets a
// visible 403 and no data is exposed.
const handleBackup = async (request, env) => {
  if (request.method === 'OPTIONS') return backupResponse(null, 204);
  if (!env.BACKUPS) return backupResponse('Backup storage is not configured', 503);

  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!TOKEN_RE.test(token)) return backupResponse('Unauthorized', 401);
  const hash = await hashToken(token);
  const stored = await env.BACKUPS.get(AUTH_KEY);
  if (stored && stored !== hash) return backupResponse('Forbidden', 403);

  if (request.method === 'PUT') {
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BACKUP_BYTES) return backupResponse('Too large', 413);
    const body = await request.arrayBuffer();
    if (body.byteLength === 0) return backupResponse('Empty backup', 400);
    if (body.byteLength > MAX_BACKUP_BYTES) return backupResponse('Too large', 413);
    if (!stored) await env.BACKUPS.put(AUTH_KEY, hash);
    await env.BACKUPS.put(DATA_KEY, body);
    return backupResponse(null, 204);
  }
  if (request.method === 'GET') {
    const data = stored ? await env.BACKUPS.get(DATA_KEY, 'arrayBuffer') : null;
    return data ? backupResponse(data, 200) : backupResponse('No backup', 404);
  }
  if (request.method === 'DELETE') {
    if (stored) {
      await env.BACKUPS.delete(DATA_KEY);
      await env.BACKUPS.delete(AUTH_KEY);
    }
    return backupResponse(null, 204);
  }
  return backupResponse('Method not allowed', 405);
};

export default {
  async scheduled(event, env, ctx) {
    const hour = localHour(new Date(event.scheduledTime));
    if (!reminderHours(env).includes(hour)) return;
    ctx.waitUntil(sendPush(env, partFor(hour)).then(report).then((line) => console.log(line)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/backup') return handleBackup(request, env);
    if (url.pathname !== '/test' || !env.TEST_TOKEN || url.searchParams.get('token') !== env.TEST_TOKEN) {
      return new Response('Not found', { status: 404 });
    }
    const response = await sendPush(env, partFor(localHour(new Date())));
    return new Response(await report(response), {
      status: response.ok ? 200 : 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },

  // Ignored by Cloudflare; lets the tests reach the crypto helpers.
  internals: { encryptPayload, vapidHeader, localHour, reminderHours, partFor, b64url, fromB64url },
};
