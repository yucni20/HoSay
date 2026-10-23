'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./lib/db');
const svc = require('./lib/service');
const auth = require('./lib/auth');
const { generateVapidKeys } = require('./lib/webpush');
const { createScheduler } = require('./lib/scheduler');
const { HttpError } = svc;

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json',
};
// 只接受主流瀏覽器推播服務的端點，避免伺服器被利用去請求任意網址
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/, /(^|\.)push\.api\.chrome\.google\.com$/];

function createApp(opts = {}) {
  const db = opts.db || openDb(opts.dbFile || process.env.DB_FILE || path.join(__dirname, 'data', 'app.db'));
  const allowAnyPush = opts.allowAnyPushEndpoint || process.env.PUSH_ALLOW_ANY === '1';
  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY === '1';

  // VAPID 金鑰：首次啟動自動產生並存入資料庫（也可用環境變數指定）
  let vapid;
  function getVapid() {
    if (vapid) return vapid;
    let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
    if (!pub || !priv) {
      const row = db.prepare("SELECT value FROM meta WHERE key='vapid'").get();
      if (row) ({ publicKey: pub, privateKey: priv } = JSON.parse(row.value));
      else {
        const k = generateVapidKeys();
        db.prepare("INSERT INTO meta (key, value) VALUES ('vapid', ?)").run(JSON.stringify(k));
        pub = k.publicKey; priv = k.privateKey;
      }
    }
    vapid = { publicKey: pub, privateKey: priv, subject: opts.vapidSubject || process.env.VAPID_SUBJECT || 'mailto:admin@example.com' };
    return vapid;
  }
  getVapid();

  const scheduler = createScheduler({ db, getVapid, send: opts.send, log: opts.log || console });

  const json = (res, status, obj, headers = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };

  function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new HttpError(413, '資料太大')); req.destroy(); } else chunks.push(c);
      });
      req.on('end', () => {
        if (!size) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, '資料格式錯誤')); }
      });
      req.on('error', reject);
    });
  }

  const isSecure = (req) => req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const clientIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;

  const routes = [];
  const route = (method, pattern, handler, { authRequired = true } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
    routes.push({ method, re, keys, handler, authRequired });
  };

  // ---- 帳號 ----
  route('POST', '/api/auth/register', async ({ req, res, body }) => {
    const uid = await auth.register(db, body);
    const token = auth.createSession(db, uid);
    json(res, 201, { ok: true }, { 'Set-Cookie': auth.sessionCookie(token, isSecure(req)) });
  }, { authRequired: false });

  route('POST', '/api/auth/login', async ({ req, res, body }) => {
    const uid = await auth.login(db, body, clientIp(req));
    const token = auth.createSession(db, uid);
    json(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(token, isSecure(req)) });
  }, { authRequired: false });

  route('POST', '/api/auth/logout', ({ req, res, user }) => {
    auth.logout(db, user.tokenHash);
    json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(isSecure(req)) });
  });

  route('GET', '/api/me', ({ res, user }) => {
    const u = db.prepare('SELECT email, display_name FROM users WHERE id=?').get(user.id);
    const st = svc.getSettings(db, user.id);
    const t = svc.today(db, user.id);
    const subs = db.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id=?').get(user.id).n;
    json(res, 200, { email: u.email, display_name: u.display_name, settings: st, today: t.date, now_minutes: t.minutes, push_devices: subs });
  });

  route('DELETE', '/api/me', async ({ req, res, user, body }) => {
    const u = db.prepare('SELECT pw_hash FROM users WHERE id=?').get(user.id);
    if (!(await auth.verifyPassword(String(body.password || ''), u.pw_hash))) throw new HttpError(401, '密碼不正確');
    db.prepare('DELETE FROM users WHERE id=?').run(user.id); // 外鍵 CASCADE 會一併刪除所有個人資料
    db.prepare('DELETE FROM notif_log WHERE user_id=?').run(user.id);
    json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(isSecure(req)) });
  });

  route('PATCH', '/api/settings', ({ res, user, body }) => json(res, 200, svc.updateSettings(db, user.id, body)));

  // ---- 項目 ----
  route('GET', '/api/meds', ({ res, user }) => json(res, 200, svc.listMeds(db, user.id)));
  route('POST', '/api/meds', ({ res, user, body }) => json(res, 201, svc.createMed(db, user.id, body)));
  route('GET', '/api/meds/:id', ({ res, user, params }) => json(res, 200, svc.publicMed(svc.getMed(db, user.id, params.id))));
  route('PATCH', '/api/meds/:id', ({ res, user, params, body }) => json(res, 200, svc.updateMed(db, user.id, params.id, body)));
  route('POST', '/api/meds/:id/pause', ({ res, user, params, body }) => json(res, 200, svc.setPaused(db, user.id, params.id, !!body.paused)));
  route('DELETE', '/api/meds/:id', ({ res, user, params }) => json(res, 200, svc.deleteMed(db, user.id, params.id)));

  // ---- 打卡 ----
  route('GET', '/api/day', ({ res, user, query }) => json(res, 200, svc.dayView(db, user.id, query.get('date') || svc.today(db, user.id).date)));
  route('POST', '/api/doses', ({ res, user, body }) => json(res, 200, svc.setDose(db, user.id, body)));
  route('POST', '/api/doses/snooze', ({ res, user, body }) => json(res, 200, svc.snoozeDose(db, user.id, body)));
  // 通知上的「全部已服用／稍後提醒」按鈕使用
  route('POST', '/api/doses/bulk', ({ res, user, body }) => {
    const ids = Array.isArray(body.med_ids) ? body.med_ids.slice(0, 50) : [];
    const results = [];
    for (const med_id of ids) {
      try {
        if (body.action === 'snooze') results.push(svc.snoozeDose(db, user.id, { med_id, date: body.date, time: body.time, minutes: body.minutes || 10 }));
        else if (body.action === 'taken') {
          const cur = svc.dayView(db, user.id, body.date).doses.find((d) => d.med.id === Number(med_id) && d.time === body.time);
          if (cur && cur.status) { results.push({ ok: true, unchanged: true }); continue; } // 已有紀錄就不覆蓋
          results.push(svc.setDose(db, user.id, { med_id, date: body.date, time: body.time, status: 'taken' }));
        } else throw new HttpError(400, '動作不正確');
      } catch (e) { results.push({ ok: false, error: e.message }); }
    }
    json(res, 200, { results });
  });

  route('GET', '/api/calendar', ({ res, user, query }) => json(res, 200, svc.calendarMonth(db, user.id, query.get('month') || svc.today(db, user.id).date.slice(0, 7))));

  route('GET', '/api/export.csv', ({ res, user, query }) => {
    const csv = svc.exportCsv(db, user.id, query.get('from'), query.get('to'));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="health-log-${query.get('from')}_${query.get('to')}.csv"` });
    res.end(csv);
  });

  route('GET', '/api/reminders.ics', ({ req, res, user }) => {
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="health-reminders.ics"' });
    res.end(svc.exportIcs(db, user.id, String(req.headers.host || 'localhost').replace(/[^\w.-]/g, '')));
  });

  // ---- 推播 ----
  route('GET', '/api/push/public-key', ({ res }) => json(res, 200, { publicKey: getVapid().publicKey }), { authRequired: false });

  route('POST', '/api/push/subscribe', ({ req, res, user, body }) => {
    const endpoint = String(body.endpoint || '');
    const p256dh = String(body.keys?.p256dh || ''), authKey = String(body.keys?.auth || '');
    let u;
    try { u = new URL(endpoint); } catch { throw new HttpError(400, '推播訂閱資料不正確'); }
    if (!allowAnyPush && (u.protocol !== 'https:' || !PUSH_HOSTS.some((r) => r.test(u.hostname)))) throw new HttpError(400, '不支援的推播服務');
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(authKey, 'base64url').length !== 16) throw new HttpError(400, '推播金鑰不正確');
    if (db.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id=?').get(user.id).n >= 10) {
      db.prepare('DELETE FROM push_subs WHERE id = (SELECT id FROM push_subs WHERE user_id=? ORDER BY created_at LIMIT 1)').run(user.id);
    }
    db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, user_agent) VALUES (?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, fail_count=0`)
      .run(user.id, endpoint, p256dh, authKey, String(req.headers['user-agent'] || '').slice(0, 200));
    json(res, 200, { ok: true });
  });

  route('POST', '/api/push/unsubscribe', ({ res, user, body }) => {
    db.prepare('DELETE FROM push_subs WHERE user_id=? AND endpoint=?').run(user.id, String(body.endpoint || ''));
    json(res, 200, { ok: true });
  });

  route('POST', '/api/push/test', async ({ res, user }) => {
    const n = await scheduler.deliver(user.id, {
      type: 'test', title: '通知設定成功 🌷', body: '之後時間到了，會在這裡提醒你', tag: 'test', data: { url: '/' },
    }, 'test');
    if (!n) throw new HttpError(502, '推播服務沒有成功送達，請重新開啟通知再試一次');
    json(res, 200, { ok: true, delivered: n });
  });

  route('GET', '/api/health', ({ res }) => json(res, 200, { ok: true }), { authRequired: false });

  // ---- 靜態檔案 ----
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
      const ext = path.extname(file);
      const noCache = ext === '.html' || rel === '/sw.js' || ext === '.webmanifest';
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
        ...(rel === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
      });
      res.end(data);
    });
  }

  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };

  async function handler(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url, 'http://x');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
        return serveStatic(req, res, url.pathname);
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(404, '找不到這個功能');
      // CSRF 防護：所有會改變資料的請求都必須帶自訂標頭，且來源需與本站一致
      if (req.method !== 'GET') {
        if (req.headers['x-requested-with'] !== 'chile-ma') throw new HttpError(403, '請求來源不正確');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, '請求來源不正確');
      }
      const user = auth.userFromRequest(db, req);
      if (r.authRequired && !user) throw new HttpError(401, '請先登入');
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const body = req.method === 'GET' ? {} : await readBody(req);
      await r.handler({ req, res, user, body, params, query: url.searchParams });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) (opts.log || console).error(e);
      if (!res.headersSent) json(res, status, { error: status === 500 ? '伺服器發生錯誤，請稍後再試' : e.message });
      else res.end();
    }
  }

  return { handler, db, scheduler, getVapid };
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  http.createServer(app.handler).listen(port, () => {
    console.log(`今天吃了嗎？ running on http://localhost:${port}`);
    if (!process.env.VAPID_SUBJECT) console.warn('[提醒] 請設定 VAPID_SUBJECT=mailto:你的信箱，推播服務需要聯絡方式');
  });
  app.scheduler.start();
  const shutdown = () => { app.scheduler.stop(); app.db.close(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

module.exports = { createApp };
