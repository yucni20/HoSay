'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const { HttpError } = require('./service');
const S = require('./schedule');

const SESSION_DAYS = 30;
const COOKIE = 'cm_session';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(pw, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(saltB64, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, Buffer.from(keyB64, 'base64'));
}

// 登入嘗試次數限制（記憶體內，單機部署適用）
const attempts = new Map();
function rateLimit(key, max = 10, windowMs = 15 * 60000) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  if (a.length >= max) throw new HttpError(429, '嘗試次數太多，請 15 分鐘後再試');
  a.push(now);
  attempts.set(key, a);
  if (attempts.size > 10000) attempts.clear();
}

function validEmail(e) { return typeof e === 'string' && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

async function register(db, { email, password, display_name, timezone }) {
  email = String(email || '').trim().toLowerCase();
  if (!validEmail(email)) throw new HttpError(400, '請輸入有效的 Email');
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, '密碼至少 8 個字元');
  if (password.length > 200) throw new HttpError(400, '密碼太長');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, '這個 Email 已經註冊過，請直接登入');
  const name = String(display_name || '').trim().slice(0, 20);
  const tz = S.isValidTimeZone(timezone) ? timezone : 'Asia/Taipei';
  const pw = await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    const uid = db.prepare('INSERT INTO users (email, pw_hash, display_name) VALUES (?,?,?)').run(email, pw, name).lastInsertRowid;
    db.prepare('INSERT INTO settings (user_id, timezone) VALUES (?,?)').run(uid, tz);
    db.prepare('INSERT INTO profiles (user_id, name) VALUES (?,?)').run(uid, name || '我');
    db.exec('COMMIT');
    return Number(uid);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

async function login(db, { email, password }, ip) {
  email = String(email || '').trim().toLowerCase();
  rateLimit(`${ip}|${email}`);
  const u = db.prepare('SELECT id, pw_hash FROM users WHERE email=?').get(email);
  // 帳號不存在時也做一次雜湊，避免以回應時間推測帳號是否存在
  const ok = u ? await verifyPassword(String(password || ''), u.pw_hash) : (await hashPassword('x'), false);
  if (!ok) throw new HttpError(401, 'Email 或密碼不正確');
  return u.id;
}

function createSession(db, uid) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)')
    .run(sha256(token), uid, now + SESSION_DAYS * 86400000, now);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return token;
}

function sessionCookie(token, secure) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
function clearCookie(secure) { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`; }

function parseCookies(h) {
  const out = {};
  for (const p of String(h || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return out;
}

function userFromRequest(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash=?').get(sha256(token));
  if (!s || s.expires_at < Date.now()) return null;
  return { id: s.user_id, tokenHash: sha256(token) };
}

function logout(db, tokenHash) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); }

module.exports = { register, login, createSession, sessionCookie, clearCookie, userFromRequest, logout, hashPassword, verifyPassword };
