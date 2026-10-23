'use strict';
// 零相依的 Web Push 實作：
//  - 訊息加密：RFC 8291（aes128gcm, RFC 8188）
//  - 伺服器身分：VAPID，RFC 8292（ES256 JWT）
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidPrivateKeyObject(publicKeyB64u, privateKeyB64u) {
  const pub = fromB64u(publicKeyB64u);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: privateKeyB64u, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
  });
}

function vapidAuthHeader(endpoint, vapid, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: vapid.subject }));
  const data = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(data), {
    key: vapidPrivateKeyObject(vapid.publicKey, vapid.privateKey), dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${data}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// 依 RFC 8291 加密。opts 可注入 salt / 伺服器臨時金鑰以做測試
function encryptPayload(plaintext, p256dhB64u, authB64u, opts = {}) {
  const uaPublic = fromB64u(p256dhB64u);
  const authSecret = fromB64u(authB64u);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('invalid subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt || crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const rs = 4096;
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]); // 0x02 = 最後一筆紀錄
  if (data.length + 16 > rs) throw new Error('payload too large');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// 送出一則推播。回傳 { statusCode }；404/410 代表訂閱失效
function sendNotification(subscription, payloadObj, vapid, { ttl = 3600, urgency = 'high', topic } = {}) {
  const body = encryptPayload(JSON.stringify(payloadObj), subscription.p256dh, subscription.auth);
  const url = new URL(subscription.endpoint);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    'Content-Length': body.length,
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidAuthHeader(subscription.endpoint, vapid),
  };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const mod = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: 'POST', headers, timeout: 15000 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: text.slice(0, 300) }));
    });
    req.on('timeout', () => req.destroy(new Error('push timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { generateVapidKeys, vapidAuthHeader, encryptPayload, sendNotification };
