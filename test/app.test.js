'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const S = require('../lib/schedule');
const { createApp } = require('../server');

// ---------- 排程規則 ----------
test('排程：每天／指定星期／間隔天數／起訖日／暫停', () => {
  const base = { start_date: '2026-10-01', times: ['08:00'] };
  assert.equal(S.occursOn({ ...base, freq_type: 'daily' }, '2026-10-23'), true);
  assert.equal(S.occursOn({ ...base, freq_type: 'daily' }, '2026-09-30'), false, '開始前');
  assert.equal(S.occursOn({ ...base, freq_type: 'daily', end_date: '2026-10-10' }, '2026-10-11'), false, '結束後');
  // 2026-10-23 是星期五 (5)
  assert.equal(S.occursOn({ ...base, freq_type: 'weekly', weekdays: [1, 3, 5] }, '2026-10-23'), true);
  assert.equal(S.occursOn({ ...base, freq_type: 'weekly', weekdays: [1, 3] }, '2026-10-23'), false);
  assert.equal(S.occursOn({ ...base, freq_type: 'interval', interval_days: 3 }, '2026-10-04'), true);
  assert.equal(S.occursOn({ ...base, freq_type: 'interval', interval_days: 3 }, '2026-10-05'), false);
  assert.equal(S.occursOn({ ...base, freq_type: 'daily', paused_since: '2026-10-20' }, '2026-10-19'), true);
  assert.equal(S.occursOn({ ...base, freq_type: 'daily', paused_since: '2026-10-20' }, '2026-10-21'), false);
  assert.deepEqual(['06:00', '12:30', '19:00', '22:30', '02:00'].map(S.slotOf), ['morning', 'noon', 'evening', 'bedtime', 'bedtime']);
  assert.deepEqual(S.localNow('Asia/Taipei', Date.parse('2026-10-22T23:30:00Z')), { date: '2026-10-23', minutes: 450 });
});

// ---------- API ----------
function startServer(opts = {}) {
  const app = createApp({ dbFile: ':memory:', allowAnyPushEndpoint: true, log: { error() {}, warn() {} }, ...opts });
  const srv = http.createServer(app.handler);
  return new Promise((r) => srv.listen(0, () => r({ app, srv, port: srv.address().port })));
}

function client(port) {
  let cookie = '';
  return async function call(method, path, body, { csrf = true } = {}) {
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    if (csrf) headers['X-Requested-With'] = 'chile-ma';
    const res = await fetch(`http://localhost:${port}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
}

test('API：註冊、新增項目、打卡、庫存、稍後提醒、日曆、權限隔離', async (t) => {
  const { srv, port } = await startServer();
  t.after(() => srv.close());
  const a = client(port), b = client(port);

  assert.equal((await a('POST', '/api/auth/register', { email: 'a@test.com', password: 'short' })).status, 400);
  assert.equal((await a('POST', '/api/auth/register', { email: 'a@test.com', password: 'password123', timezone: 'Asia/Taipei' })).status, 201);
  assert.equal((await b('POST', '/api/auth/register', { email: 'b@test.com', password: 'password123' })).status, 201);
  assert.equal((await a('POST', '/api/auth/register', { email: 'A@test.com', password: 'password123' })).status, 409, 'Email 不分大小寫');

  const me = (await a('GET', '/api/me')).body;
  const today = me.today;

  // CSRF：缺少自訂標頭會被擋
  assert.equal((await a('POST', '/api/meds', { name: 'x' }, { csrf: false })).status, 403);

  const bad = await a('POST', '/api/meds', { name: '', times: ['08:00'], freq_type: 'daily' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /名稱/);

  const vd = (await a('POST', '/api/meds', {
    name: '維他命 D', dose_amount: 1, dose_unit: '顆', times: ['20:00', '08:00'], freq_type: 'daily', stock: 3, restock_threshold: 2, note: '飯後',
  })).body;
  assert.deepEqual(vd.times, ['08:00', '20:00']);
  const fish = (await a('POST', '/api/meds', { name: '魚油', times: ['08:00'], freq_type: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6] })).body;

  let day = (await a('GET', `/api/day?date=${today}`)).body;
  assert.equal(day.doses.length, 3);
  assert.deepEqual(day.doses.map((d) => d.slot), ['morning', 'morning', 'evening']);

  // 已服用：重複按也只算一次、庫存只扣一次
  const r1 = (await a('POST', '/api/doses', { med_id: vd.id, date: today, time: '08:00', status: 'taken' })).body;
  const r2 = (await a('POST', '/api/doses', { med_id: vd.id, date: today, time: '08:00', status: 'taken' })).body;
  assert.equal(r1.stock, 2); assert.equal(r2.stock, 2); assert.equal(r2.low_stock, true);
  // 取消紀錄 → 庫存還原
  assert.equal((await a('POST', '/api/doses', { med_id: vd.id, date: today, time: '08:00', status: null })).body.stock, 3);
  await a('POST', '/api/doses', { med_id: vd.id, date: today, time: '08:00', status: 'taken', taken_at: '08:12' });
  await a('POST', '/api/doses', { med_id: fish.id, date: today, time: '08:00', status: 'skipped' });

  // 未來日期不能打卡；沒排程的時間不能打卡
  assert.equal((await a('POST', '/api/doses', { med_id: vd.id, date: S.addDays(today, 1), time: '08:00', status: 'taken' })).status, 400);
  assert.equal((await a('POST', '/api/doses', { med_id: vd.id, date: today, time: '09:00', status: 'taken' })).status, 400);

  // 稍後提醒
  const snz = await a('POST', '/api/doses/snooze', { med_id: vd.id, date: today, time: '20:00', minutes: 30 });
  assert.equal(snz.status, 200);
  day = (await a('GET', `/api/day?date=${today}`)).body;
  const evening = day.doses.find((d) => d.time === '20:00');
  assert.ok(evening.snooze_until > Date.now());
  assert.equal(day.doses.find((d) => d.med.id === vd.id && d.time === '08:00').taken_at, '08:12');

  // 日曆：今天 3 劑，1 已服用、1 略過、1 未確認（不推定為沒吃）
  const cal = (await a('GET', `/api/calendar?month=${today.slice(0, 7)}`)).body;
  const td = cal.days.find((d) => d.date === today);
  assert.deepEqual([td.expected, td.taken, td.skipped, td.unconfirmed], [3, 1, 1, 1]);

  // 權限隔離：B 看不到也改不了 A 的資料
  assert.equal((await b('GET', '/api/meds')).body.length, 0);
  assert.equal((await b('GET', `/api/meds/${vd.id}`)).status, 404);
  assert.equal((await b('PATCH', `/api/meds/${vd.id}`, { name: 'hack' })).status, 404);
  assert.equal((await b('POST', '/api/doses', { med_id: vd.id, date: today, time: '20:00', status: 'taken' })).status, 404);
  assert.equal((await b('GET', `/api/day?date=${today}`)).body.doses.length, 0);

  // 修改時間後，舊的打卡紀錄仍保留在歷史中
  await a('PATCH', `/api/meds/${vd.id}`, { times: ['09:00', '20:00'] });
  day = (await a('GET', `/api/day?date=${today}`)).body;
  assert.ok(day.doses.some((d) => d.med.id === vd.id && d.time === '08:00' && d.status === 'taken'));

  // 暫停、刪除後歷史紀錄仍在
  assert.equal((await a('POST', `/api/meds/${fish.id}/pause`, { paused: true })).body.paused, true);
  assert.equal((await a('DELETE', `/api/meds/${vd.id}`)).status, 200);
  assert.equal((await a('GET', '/api/meds')).body.length, 1);
  day = (await a('GET', `/api/day?date=${today}`)).body;
  assert.ok(day.doses.some((d) => d.med.id === vd.id && d.status === 'taken'), '已刪除項目的紀錄仍保留');

  // 匯出
  const csv = await a('GET', `/api/export.csv?from=${today}&to=${today}`);
  assert.equal(csv.status, 200);
  assert.match(csv.body, /維他命 D,1顆,已服用,08:12/);
  const ics = await a('GET', '/api/reminders.ics');
  assert.match(ics.body, /BEGIN:VCALENDAR/);

  // 登出後無法存取
  await a('POST', '/api/auth/logout');
  assert.equal((await a('GET', '/api/me')).status, 401);
  assert.equal((await a('POST', '/api/auth/login', { email: 'a@test.com', password: 'wrong-pass' })).status, 401);
  assert.equal((await a('POST', '/api/auth/login', { email: 'a@test.com', password: 'password123' })).status, 200);

  // 刪除帳號會清除所有資料
  assert.equal((await a('DELETE', '/api/me', { password: 'password123' })).status, 200);
  assert.equal((await a('POST', '/api/auth/login', { email: 'a@test.com', password: 'password123' })).status, 401);
});

// ---------- 推播排程 ----------
test('排程推播：準時、再次提醒、防重複、同時段合併、已服用即停止、稍後提醒、時區', async (t) => {
  const sent = [];
  const send = async (sub, payload) => { sent.push(payload); return { statusCode: 201 }; };
  const { app, srv, port } = await startServer({ send });
  t.after(() => srv.close());
  const a = client(port);
  await a('POST', '/api/auth/register', { email: 'p@test.com', password: 'password123', timezone: 'Asia/Taipei' });
  const k = crypto.createECDH('prime256v1'); k.generateKeys();
  await a('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/x1', keys: { p256dh: k.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });
  await a('PATCH', '/api/settings', { repeat_minutes: 15, repeat_count: 2 });
  const today = (await a('GET', '/api/me')).body.today;
  const m1 = (await a('POST', '/api/meds', { name: '維他命 D', times: ['08:00'], freq_type: 'daily', start_date: today })).body;
  await a('POST', '/api/meds', { name: '魚油', times: ['08:00'], freq_type: 'daily', start_date: today });
  await a('POST', '/api/meds', { name: '鈣片', times: ['21:00'], freq_type: 'daily', start_date: today, notify: false });

  // 台北時間 = UTC+8；today 08:00 台北 = today 00:00Z
  const at = (hhmm) => Date.parse(`${today}T${hhmm}:00+08:00`);
  const tick = (hhmm) => app.scheduler.tick(at(hhmm));

  assert.equal((await tick('07:59')).length, 0, '還沒到時間');
  assert.equal((await tick('08:00')).length, 1, '兩個項目同時段合併成一則');
  assert.match(sent.at(-1).body, /維他命 D、魚油/);
  assert.equal((await tick('08:01')).length, 0, '同一時段不重複通知');
  assert.equal((await tick('08:15')).length, 1, '未確認 → 再次提醒');
  assert.match(sent.at(-1).title, /還沒確認/);

  // 維他命 D 已服用 → 下次只提醒魚油
  await a('POST', '/api/doses', { med_id: m1.id, date: today, time: '08:00', status: 'taken' });
  assert.equal((await tick('08:30')).length, 1);
  assert.equal(sent.at(-1).body, '魚油');
  assert.equal((await tick('08:45')).length, 0, '超過再次提醒次數上限');
  assert.equal((await tick('21:00')).length, 0, '關閉通知的項目不提醒');

  // 隱藏名稱
  await a('PATCH', '/api/settings', { hide_names: true });
  await a('POST', '/api/meds', { name: '葉酸', times: ['12:00'], freq_type: 'daily', start_date: today });
  await tick('12:00');
  assert.doesNotMatch(sent.at(-1).body, /葉酸/);

  // 時區變更：改成東京（UTC+9）後，東京 12:00 才提醒新項目
  await a('PATCH', '/api/settings', { timezone: 'Asia/Tokyo', hide_names: false });
  await a('POST', '/api/meds', { name: '益生菌', times: ['13:00'], freq_type: 'daily', start_date: today });
  // 東京 13:00 = 台北 12:00
  assert.equal((await app.scheduler.tick(Date.parse(`${today}T12:59:00+08:00`))).length, 0, '台北 12:59 = 東京 13:59，已錯過');
  const sentKeys = await app.scheduler.tick(Date.parse(`${today}T13:00:00+09:00`));
  assert.ok(sentKeys.some((k) => k.endsWith('|13:00|0')), '依新時區的 13:00 提醒');
});

test('稍後提醒：到期前不打擾、到期時提醒一次', async (t) => {
  const sent = [];
  const { app, srv, port } = await startServer({ send: async (s, p) => { sent.push(p); return { statusCode: 201 }; } });
  t.after(() => srv.close());
  const a = client(port);
  await a('POST', '/api/auth/register', { email: 's@test.com', password: 'password123', timezone: 'UTC' });
  const k = crypto.createECDH('prime256v1'); k.generateKeys();
  await a('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/y', keys: { p256dh: k.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });
  await a('PATCH', '/api/settings', { repeat_count: 0 });
  const today = (await a('GET', '/api/me')).body.today;
  const m = (await a('POST', '/api/meds', { name: '鐵劑', times: ['00:00'], freq_type: 'daily', start_date: today })).body;
  // 直接寫入一筆稍後提醒（模擬使用者在 00:00 按了「30 分鐘後」）
  const until = Date.parse(`${today}T00:30:00Z`);
  app.db.prepare('INSERT INTO snoozes (user_id, med_id, date, time, until_ms) VALUES (1, ?, ?, ?, ?)').run(m.id, today, '00:00', until);
  assert.equal((await app.scheduler.tick(Date.parse(`${today}T00:10:00Z`))).length, 0, '稍後提醒期間不通知');
  assert.equal((await app.scheduler.tick(until)).length, 1, '到期提醒');
  assert.equal((await app.scheduler.tick(until + 60000)).length, 0, '只提醒一次');
});

test('推播訂閱：預設只接受正式推播服務網址', async (t) => {
  const { srv, port } = await startServer({ allowAnyPushEndpoint: false });
  t.after(() => srv.close());
  const a = client(port);
  await a('POST', '/api/auth/register', { email: 'x@test.com', password: 'password123' });
  const k = crypto.createECDH('prime256v1'); k.generateKeys();
  const keys = { p256dh: k.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  assert.equal((await a('POST', '/api/push/subscribe', { endpoint: 'https://evil.example.com/x', keys })).status, 400);
  assert.equal((await a('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/abc', keys })).status, 200);
});
