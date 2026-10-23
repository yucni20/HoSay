// 預覽版用：在瀏覽器內模擬後端 API（規則與正式版 lib/service.js 相同），資料存在這台裝置的瀏覽器
(function () {
  const KEY = 'chile-ma-preview-v1';
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei';

  // ---- 排程規則（同 lib/schedule.js）----
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
  const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  function localNow(tz) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const g = (t) => p.find((x) => x.type === t).value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: +g('hour') * 60 + +g('minute') };
  }
  function slotOf(t) { const m = toMin(t); if (m >= 300 && m < 660) return 'morning'; if (m >= 660 && m < 960) return 'noon'; if (m >= 960 && m < 1260) return 'evening'; return 'bedtime'; }
  function occursOn(m, d) {
    if (!m.start_date || d < m.start_date) return false;
    if (m.end_date && d > m.end_date) return false;
    if (m.deleted_date && d >= m.deleted_date) return false;
    if (m.paused_since && d >= m.paused_since) return false;
    if (m.freq_type === 'daily') return true;
    if (m.freq_type === 'weekly') return (m.weekdays || []).includes(dow(d));
    if (m.freq_type === 'interval') return daysBetween(m.start_date, d) % (m.interval_days || 1) === 0;
    return false;
  }
  function dosesWithHistory(meds, date, logs) {
    const out = [];
    for (const med of meds) if (occursOn(med, date)) for (const time of med.times) out.push({ med, time, slot: slotOf(time) });
    const seen = new Set(out.map((x) => `${x.med.id}|${x.time}`));
    for (const l of logs) {
      const k = `${l.med_id}|${l.time}`; const med = meds.find((m) => m.id === l.med_id);
      if (!seen.has(k) && med) { seen.add(k); out.push({ med, time: l.time, slot: slotOf(l.time) }); }
    }
    return out.sort((a, b) => a.time.localeCompare(b.time) || a.med.name.localeCompare(b.med.name));
  }

  // ---- 資料 ----
  function seed() {
    const today = localNow(TZ).date;
    const start = addDays(today, -24);
    const meds = [
      { id: 1, name: '維他命 D', category: 'supplement', dose_amount: 1, dose_unit: '顆', times: ['08:00'], note: '飯後', stock: 11, restock_threshold: 10 },
      { id: 2, name: '魚油', category: 'supplement', dose_amount: 2, dose_unit: '粒', times: ['08:00', '20:00'], note: '隨餐', stock: null, restock_threshold: null },
      { id: 3, name: '血壓藥', category: 'medicine', dose_amount: 1, dose_unit: '錠', times: ['12:30'], note: '飯後', stock: 26, restock_threshold: 7 },
      { id: 4, name: '益生菌', category: 'other', dose_amount: 1, dose_unit: '包', times: ['22:00'], note: '空腹', stock: null, restock_threshold: null, freq_type: 'weekly', weekdays: [1, 3, 5] },
    ].map((m) => ({ photo: null, freq_type: 'daily', weekdays: null, interval_days: null, start_date: start, end_date: null, notify: true, paused_since: null, deleted_date: null, ...m }));
    const logs = [];
    let r = 7;
    const rand = () => (r = (r * 9301 + 49297) % 233280) / 233280;
    for (let d = start; d < today; d = addDays(d, 1)) {
      for (const x of dosesWithHistory(meds, d, [])) {
        const v = rand();
        if (v < 0.8) logs.push({ med_id: x.med.id, date: d, time: x.time, status: 'taken', taken_at: x.time });
        else if (v < 0.88) logs.push({ med_id: x.med.id, date: d, time: x.time, status: 'skipped', taken_at: null });
      }
    }
    return { loggedIn: true, user: { email: 'demo@example.com', display_name: 'Jaynie' },
      settings: { timezone: TZ, repeat_minutes: 15, repeat_count: 2, hide_names: 0 }, meds, logs, snoozes: [], nextId: 5 };
  }
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
  if (!db) db = seed();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* 無法儲存時只保留在記憶體 */ } };
  document.addEventListener('click', (e) => { if (e.target.id === 'preview-reset') window.__previewReset(); });
  window.__previewReset = () => { db = seed(); save(); location.hash = '#/today'; location.reload(); };

  class E extends Error { constructor(s, m) { super(m); this.status = s; } }
  const bad = (m) => new E(400, m);
  const today = () => localNow(db.settings.timezone);
  const pub = (m) => ({ ...m, paused: !!m.paused_since, low_stock: m.stock != null && m.restock_threshold != null && m.stock <= m.restock_threshold });
  const getMed = (id, incDel) => { const m = db.meds.find((x) => x.id === Number(id)); if (!m || (!incDel && m.deleted_date)) throw new E(404, '找不到這個項目'); return m; };

  function validate(b) {
    const name = String(b.name ?? '').trim();
    if (!name) throw bad('請輸入名稱');
    if (name.length > 40) throw bad('名稱最多 40 字');
    const amt = b.dose_amount === '' || b.dose_amount == null ? null : Number(b.dose_amount);
    if (amt !== null && (!isFinite(amt) || amt <= 0)) throw bad('每次用量需為正數');
    if (!Array.isArray(b.times) || !b.times.length) throw bad('請至少設定一個服用時間');
    const times = [...new Set(b.times)].sort();
    if (!times.every(isTime)) throw bad('時間格式需為 HH:MM');
    let weekdays = null, interval_days = null;
    if (b.freq_type === 'weekly') { if (!b.weekdays?.length) throw bad('請選擇至少一個星期'); weekdays = [...new Set(b.weekdays.map(Number))].sort(); }
    else if (b.freq_type === 'interval') { interval_days = Number(b.interval_days); if (!Number.isInteger(interval_days) || interval_days < 2 || interval_days > 90) throw bad('間隔天數需介於 2 到 90'); }
    else if (b.freq_type !== 'daily') throw bad('頻率設定不正確');
    const start_date = b.start_date || today().date;
    if (!isDate(start_date)) throw bad('開始日期不正確');
    const end_date = b.end_date || null;
    if (end_date && (!isDate(end_date) || end_date < start_date)) throw bad('結束日期需晚於開始日期');
    const num = (v, l) => { if (v === '' || v == null) return null; const n = Number(v); if (!isFinite(n) || n < 0) throw bad(`${l}需為 0 以上的數字`); return n; };
    return { name, category: ['supplement', 'medicine', 'other'].includes(b.category) ? b.category : 'supplement', photo: b.photo || null,
      dose_amount: amt, dose_unit: String(b.dose_unit ?? '').trim().slice(0, 10), times, freq_type: b.freq_type, weekdays, interval_days,
      start_date, end_date, note: String(b.note ?? '').trim().slice(0, 100), notify: b.notify === undefined ? true : !!b.notify,
      stock: num(b.stock, '剩餘數量'), restock_threshold: num(b.restock_threshold, '補貨提醒數量') };
  }

  function dayView(date) {
    if (!isDate(date)) throw bad('日期不正確');
    const logs = db.logs.filter((l) => l.date === date);
    const now = Date.now();
    return { date, doses: dosesWithHistory(db.meds, date, logs).map(({ med, time, slot }) => {
      const l = logs.find((x) => x.med_id === med.id && x.time === time);
      const s = db.snoozes.find((x) => x.med_id === med.id && x.date === date && x.time === time && x.until > now);
      return { med: { ...pub(med), deleted: !!med.deleted_date }, time, slot, status: l ? l.status : null, taken_at: l ? l.taken_at : null, snooze_until: !l && s ? s.until : null };
    }) };
  }
  function assertScheduled(id, date, time) {
    if (!isDate(date) || !isTime(time)) throw bad('日期或時間不正確');
    const m = getMed(id, true);
    if (date > today().date) throw bad('還沒到的日子不能先打卡');
    const ok = (occursOn(m, date) && m.times.includes(time)) || db.logs.some((l) => l.med_id === m.id && l.date === date && l.time === time);
    if (!ok) throw bad('這一天沒有安排這個劑次');
    return m;
  }
  function setDose({ med_id, date, time, status, taken_at }) {
    const m = assertScheduled(med_id, date, time);
    const i = db.logs.findIndex((l) => l.med_id === m.id && l.date === date && l.time === time);
    const wasTaken = i >= 0 && db.logs[i].status === 'taken';
    if (i >= 0) db.logs.splice(i, 1);
    if (status) {
      let at = status === 'taken' ? (taken_at || null) : null;
      if (status === 'taken' && !at) { const n = today(); at = n.date === date ? `${String(Math.floor(n.minutes / 60)).padStart(2, '0')}:${String(n.minutes % 60).padStart(2, '0')}` : time; }
      db.logs.push({ med_id: m.id, date, time, status, taken_at: at });
    }
    db.snoozes = db.snoozes.filter((s) => !(s.med_id === m.id && s.date === date && s.time === time));
    const isTaken = status === 'taken';
    if (m.stock != null && m.dose_amount) {
      if (isTaken && !wasTaken) m.stock = Math.max(0, m.stock - m.dose_amount);
      if (!isTaken && wasTaken) m.stock += m.dose_amount;
    }
    return { ok: true, stock: m.stock, low_stock: pub(m).low_stock };
  }
  function calendar(month) {
    const t = today().date; const out = [];
    for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) {
      const logs = db.logs.filter((l) => l.date === d);
      const doses = dosesWithHistory(db.meds, d, logs);
      let taken = 0, skipped = 0;
      for (const x of doses) { const l = logs.find((y) => y.med_id === x.med.id && y.time === x.time); if (l?.status === 'taken') taken++; else if (l?.status === 'skipped') skipped++; }
      out.push({ date: d, expected: doses.length, taken, skipped, unconfirmed: doses.length - taken - skipped, future: d > t });
    }
    return { month, today: t, days: out };
  }

  function handle(method, url, body) {
    const p = url.pathname, q = url.searchParams;
    const id = (p.match(/^\/api\/meds\/(\d+)/) || [])[1];
    if (p.startsWith('/api/auth/')) {
      if (p.endsWith('logout')) { db.loggedIn = false; return { ok: true }; }
      const email = String(body.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('請輸入有效的 Email');
      if (String(body.password || '').length < 8) throw p.endsWith('login') ? new E(401, 'Email 或密碼不正確') : bad('密碼至少 8 個字元');
      db.loggedIn = true; db.user.email = email;
      if (body.display_name !== undefined) db.user.display_name = String(body.display_name).trim().slice(0, 20);
      return { ok: true };
    }
    if (p === '/api/push/public-key') throw new E(503, '預覽版沒有推播服務');
    if (!db.loggedIn) throw new E(401, '請先登入');
    if (p === '/api/me' && method === 'GET') { const n = today(); return { ...db.user, settings: db.settings, today: n.date, now_minutes: n.minutes, push_devices: 0 }; }
    if (p === '/api/me' && method === 'DELETE') { db = seed(); db.loggedIn = false; return { ok: true }; }
    if (p === '/api/settings') {
      for (const k of ['timezone', 'repeat_minutes', 'repeat_count']) if (body[k] !== undefined) db.settings[k] = body[k];
      if (body.hide_names !== undefined) db.settings.hide_names = body.hide_names ? 1 : 0;
      return db.settings;
    }
    if (p === '/api/meds' && method === 'GET') return db.meds.filter((m) => !m.deleted_date).sort((a, b) => (a.paused_since ? 1 : 0) - (b.paused_since ? 1 : 0) || a.times[0].localeCompare(b.times[0])).map(pub);
    if (p === '/api/meds' && method === 'POST') { const m = { id: db.nextId++, paused_since: null, deleted_date: null, ...validate(body) }; db.meds.push(m); return pub(m); }
    if (id && p.endsWith('/pause')) { const m = getMed(id); m.paused_since = body.paused ? (m.paused_since || today().date) : null; return pub(m); }
    if (id && method === 'GET') return pub(getMed(id));
    if (id && method === 'PATCH') { const m = getMed(id); Object.assign(m, validate({ ...pub(m), ...body })); return pub(m); }
    if (id && method === 'DELETE') {
      const m = getMed(id);
      if (!db.logs.some((l) => l.med_id === m.id) && m.start_date >= today().date) db.meds = db.meds.filter((x) => x !== m);
      else { m.deleted_date = today().date; m.photo = null; }
      return { ok: true };
    }
    if (p === '/api/day') return dayView(q.get('date') || today().date);
    if (p === '/api/doses') { if (body.status !== null && !['taken', 'skipped'].includes(body.status)) throw bad('狀態不正確'); return setDose(body); }
    if (p === '/api/doses/snooze') {
      const m = assertScheduled(body.med_id, body.date, body.time);
      if (db.logs.some((l) => l.med_id === m.id && l.date === body.date && l.time === body.time)) throw bad('這一劑已經有紀錄了');
      const until = Date.now() + Number(body.minutes) * 60000;
      db.snoozes = db.snoozes.filter((s) => !(s.med_id === m.id && s.date === body.date && s.time === body.time));
      db.snoozes.push({ med_id: m.id, date: body.date, time: body.time, until });
      return { ok: true, snooze_until: until };
    }
    if (p === '/api/calendar') return calendar(q.get('month') || today().date.slice(0, 7));
    if (p.startsWith('/api/push/')) throw new E(503, '這是預覽版，無法送出真正的通知');
    throw new E(404, '找不到這個功能');
  }

  window.fetch = async function (input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, 'https://preview.local');
    const method = (init.method || 'GET').toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 60));
    let status = 200, data;
    try { data = handle(method, url, body); if (method !== 'GET') save(); }
    catch (e) { status = e.status || 500; data = { error: e.message }; }
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  };

  // 下載（CSV、行事曆）在預覽中無法使用
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="/api/"]');
    if (!a) return;
    e.preventDefault();
    window.__previewToast?.('預覽版無法下載檔案，正式版才可以');
  }, true);
})();
