'use strict';
// 業務邏輯：所有查詢一律以 user_id 限定範圍，確保使用者只能存取自己的資料。
const S = require('./schedule');
const { tx, rowToMed } = require('./db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

const CATEGORIES = ['supplement', 'medicine', 'other'];
const MAX_PHOTO = 400 * 1024;

function getSettings(db, uid) {
  return db.prepare('SELECT timezone, repeat_minutes, repeat_count, hide_names FROM settings WHERE user_id = ?').get(uid);
}

function updateSettings(db, uid, body) {
  const cur = getSettings(db, uid);
  const next = { ...cur };
  if (body.timezone !== undefined) {
    if (!S.isValidTimeZone(body.timezone)) throw bad('時區格式不正確');
    next.timezone = body.timezone;
  }
  if (body.repeat_minutes !== undefined) {
    const n = Number(body.repeat_minutes);
    if (![5, 10, 15, 30, 60].includes(n)) throw bad('再次提醒間隔需為 5、10、15、30 或 60 分鐘');
    next.repeat_minutes = n;
  }
  if (body.repeat_count !== undefined) {
    const n = Number(body.repeat_count);
    if (!Number.isInteger(n) || n < 0 || n > 5) throw bad('再次提醒次數需介於 0 到 5');
    next.repeat_count = n;
  }
  if (body.hide_names !== undefined) next.hide_names = body.hide_names ? 1 : 0;
  db.prepare('UPDATE settings SET timezone=?, repeat_minutes=?, repeat_count=?, hide_names=? WHERE user_id=?')
    .run(next.timezone, next.repeat_minutes, next.repeat_count, next.hide_names, uid);
  return getSettings(db, uid);
}

function today(db, uid, nowMs = Date.now()) {
  return S.localNow(getSettings(db, uid).timezone, nowMs);
}

function defaultProfileId(db, uid) {
  return db.prepare('SELECT id FROM profiles WHERE user_id = ? ORDER BY id LIMIT 1').get(uid).id;
}

// ---------- 項目 ----------

function validateMed(b, { todayDate }) {
  const name = String(b.name ?? '').trim();
  if (!name) throw bad('請輸入名稱');
  if (name.length > 40) throw bad('名稱最多 40 字');
  const category = CATEGORIES.includes(b.category) ? b.category : 'supplement';

  let photo = b.photo ?? null;
  if (photo !== null) {
    if (typeof photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) throw bad('照片格式不支援');
    if (photo.length > MAX_PHOTO) throw bad('照片太大，請換一張');
  }

  let dose_amount = b.dose_amount === '' || b.dose_amount == null ? null : Number(b.dose_amount);
  if (dose_amount !== null && (!isFinite(dose_amount) || dose_amount <= 0 || dose_amount > 10000)) throw bad('每次用量需為正數');
  const dose_unit = String(b.dose_unit ?? '').trim().slice(0, 10);

  if (!Array.isArray(b.times) || b.times.length === 0) throw bad('請至少設定一個服用時間');
  const times = [...new Set(b.times)].sort();
  if (times.length > 8) throw bad('每天最多 8 個服用時間');
  if (!times.every(S.isValidTime)) throw bad('時間格式需為 HH:MM');

  const freq_type = b.freq_type;
  let weekdays = null, interval_days = null;
  if (freq_type === 'weekly') {
    if (!Array.isArray(b.weekdays) || !b.weekdays.length) throw bad('請選擇至少一個星期');
    weekdays = [...new Set(b.weekdays.map(Number))].sort();
    if (!weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw bad('星期設定不正確');
  } else if (freq_type === 'interval') {
    interval_days = Number(b.interval_days);
    if (!Number.isInteger(interval_days) || interval_days < 2 || interval_days > 90) throw bad('間隔天數需介於 2 到 90');
  } else if (freq_type !== 'daily') throw bad('頻率設定不正確');

  const start_date = b.start_date || todayDate;
  if (!S.isValidDate(start_date)) throw bad('開始日期不正確');
  const end_date = b.end_date || null;
  if (end_date && (!S.isValidDate(end_date) || end_date < start_date)) throw bad('結束日期需晚於開始日期');

  const note = String(b.note ?? '').trim().slice(0, 100);
  const notify = b.notify === undefined ? 1 : (b.notify ? 1 : 0);

  const num = (v, label) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!isFinite(n) || n < 0 || n > 100000) throw bad(`${label}需為 0 以上的數字`);
    return n;
  };
  const stock = num(b.stock, '剩餘數量');
  const restock_threshold = num(b.restock_threshold, '補貨提醒數量');

  return { name, category, photo, dose_amount, dose_unit, times, freq_type, weekdays, interval_days,
    start_date, end_date, note, notify, stock, restock_threshold };
}

function publicMed(m) {
  return {
    id: m.id, name: m.name, category: m.category, photo: m.photo, dose_amount: m.dose_amount, dose_unit: m.dose_unit,
    times: m.times, freq_type: m.freq_type, weekdays: m.weekdays, interval_days: m.interval_days,
    start_date: m.start_date, end_date: m.end_date, note: m.note, notify: m.notify,
    stock: m.stock, restock_threshold: m.restock_threshold, paused: !!m.paused_since, paused_since: m.paused_since,
    low_stock: m.stock != null && m.restock_threshold != null && m.stock <= m.restock_threshold,
  };
}

function allMeds(db, uid) { // 含已刪除，用於歷史紀錄
  return db.prepare('SELECT * FROM meds WHERE user_id = ?').all(uid).map(rowToMed);
}

function getMed(db, uid, id, { includeDeleted = false } = {}) {
  const m = rowToMed(db.prepare('SELECT * FROM meds WHERE id = ? AND user_id = ?').get(Number(id), uid));
  if (!m || (!includeDeleted && m.deleted_date)) throw new HttpError(404, '找不到這個項目');
  return m;
}

function listMeds(db, uid) {
  return allMeds(db, uid).filter((m) => !m.deleted_date)
    .sort((a, b) => (a.paused_since ? 1 : 0) - (b.paused_since ? 1 : 0) || a.times[0].localeCompare(b.times[0]))
    .map(publicMed);
}

function createMed(db, uid, body) {
  const v = validateMed(body, { todayDate: today(db, uid).date });
  const r = db.prepare(`INSERT INTO meds (user_id, profile_id, name, category, photo, dose_amount, dose_unit, times, freq_type,
      weekdays, interval_days, start_date, end_date, note, notify, stock, restock_threshold)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    uid, defaultProfileId(db, uid), v.name, v.category, v.photo, v.dose_amount, v.dose_unit, JSON.stringify(v.times),
    v.freq_type, v.weekdays ? JSON.stringify(v.weekdays) : null, v.interval_days, v.start_date, v.end_date, v.note,
    v.notify, v.stock, v.restock_threshold);
  return publicMed(getMed(db, uid, r.lastInsertRowid));
}

function updateMed(db, uid, id, body) {
  const cur = getMed(db, uid, id);
  const merged = { ...publicMed(cur), ...body };
  const v = validateMed(merged, { todayDate: today(db, uid).date });
  db.prepare(`UPDATE meds SET name=?, category=?, photo=?, dose_amount=?, dose_unit=?, times=?, freq_type=?, weekdays=?,
      interval_days=?, start_date=?, end_date=?, note=?, notify=?, stock=?, restock_threshold=?, updated_at=datetime('now')
      WHERE id=? AND user_id=?`).run(
    v.name, v.category, v.photo, v.dose_amount, v.dose_unit, JSON.stringify(v.times), v.freq_type,
    v.weekdays ? JSON.stringify(v.weekdays) : null, v.interval_days, v.start_date, v.end_date, v.note, v.notify,
    v.stock, v.restock_threshold, cur.id, uid);
  return publicMed(getMed(db, uid, id));
}

function setPaused(db, uid, id, paused) {
  const m = getMed(db, uid, id);
  const d = paused ? (m.paused_since || today(db, uid).date) : null;
  db.prepare("UPDATE meds SET paused_since=?, updated_at=datetime('now') WHERE id=? AND user_id=?").run(d, m.id, uid);
  return publicMed(getMed(db, uid, id));
}

// 刪除採「軟刪除」：從今天起不再排程，但過去的打卡紀錄保留
function deleteMed(db, uid, id) {
  const m = getMed(db, uid, id);
  const d = today(db, uid).date;
  tx(db, () => {
    const hasHistory = db.prepare('SELECT 1 FROM dose_logs WHERE med_id=? LIMIT 1').get(m.id);
    if (!hasHistory && m.start_date >= d) {
      db.prepare('DELETE FROM meds WHERE id=? AND user_id=?').run(m.id, uid);
    } else {
      db.prepare("UPDATE meds SET deleted_date=?, photo=NULL, updated_at=datetime('now') WHERE id=? AND user_id=?").run(d, m.id, uid);
    }
    db.prepare('DELETE FROM snoozes WHERE med_id=?').run(m.id);
  });
  return { ok: true };
}

// ---------- 打卡 ----------

// 某天的劑次 = 依目前排程應服用的 + 曾經記錄過的（排程改過或項目已刪除時，歷史紀錄仍看得到）
function dosesWithHistory(meds, date, logs) {
  const doses = S.dosesForDate(meds, date);
  const seen = new Set(doses.map((x) => `${x.med.id}|${x.time}`));
  const byId = new Map(meds.map((m) => [m.id, m]));
  for (const l of logs) {
    const k = `${l.med_id}|${l.time}`;
    if (seen.has(k) || !byId.has(l.med_id)) continue;
    seen.add(k);
    doses.push({ med: byId.get(l.med_id), time: l.time, slot: S.slotOf(l.time) });
  }
  doses.sort((a, b) => a.time.localeCompare(b.time) || a.med.name.localeCompare(b.med.name));
  return doses;
}

function dayView(db, uid, date, nowMs = Date.now()) {
  if (!S.isValidDate(date)) throw bad('日期不正確');
  const meds = allMeds(db, uid);
  const logs = db.prepare('SELECT med_id, time, status, taken_at FROM dose_logs WHERE user_id=? AND date=?').all(uid, date);
  const doses = dosesWithHistory(meds, date, logs);
  const snz = db.prepare('SELECT med_id, time, until_ms FROM snoozes WHERE user_id=? AND date=? AND until_ms > ?').all(uid, date, nowMs);
  const key = (a, b) => `${a}|${b}`;
  const logMap = new Map(logs.map((l) => [key(l.med_id, l.time), l]));
  const snzMap = new Map(snz.map((s) => [key(s.med_id, s.time), s.until_ms]));
  return {
    date,
    doses: doses.map(({ med, time, slot }) => {
      const l = logMap.get(key(med.id, time));
      return {
        med: { id: med.id, name: med.name, category: med.category, photo: med.photo, dose_amount: med.dose_amount,
          dose_unit: med.dose_unit, note: med.note, deleted: !!med.deleted_date,
          low_stock: med.stock != null && med.restock_threshold != null && med.stock <= med.restock_threshold, stock: med.stock },
        time, slot,
        status: l ? l.status : null,
        taken_at: l ? l.taken_at : null,
        snooze_until: !l && snzMap.has(key(med.id, time)) ? snzMap.get(key(med.id, time)) : null,
      };
    }),
  };
}

function assertScheduled(db, uid, medId, date, time) {
  if (!S.isValidDate(date) || !S.isValidTime(time)) throw bad('日期或時間不正確');
  const m = getMed(db, uid, medId, { includeDeleted: true });
  const t = today(db, uid);
  if (date > t.date) throw bad('還沒到的日子不能先打卡');
  const scheduled = S.occursOn(m, date) && m.times.includes(time);
  if (!scheduled && !db.prepare('SELECT 1 FROM dose_logs WHERE med_id=? AND date=? AND time=?').get(m.id, date, time)) {
    throw bad('這一天沒有安排這個劑次');
  }
  return m;
}

function adjustStock(db, m, delta) {
  if (m.stock == null || !m.dose_amount) return;
  const next = Math.max(0, Math.round((m.stock + delta * m.dose_amount) * 100) / 100);
  db.prepare('UPDATE meds SET stock=? WHERE id=?').run(next, m.id);
  m.stock = next;
}

// status: 'taken' | 'skipped' | null（null = 清除紀錄，回到未確認）
function setDose(db, uid, { med_id, date, time, status, taken_at }) {
  const m = assertScheduled(db, uid, med_id, date, time);
  if (status !== null && !['taken', 'skipped'].includes(status)) throw bad('狀態不正確');
  if (taken_at != null && !S.isValidTime(taken_at)) throw bad('實際服用時間格式需為 HH:MM');
  return tx(db, () => {
    const prev = db.prepare('SELECT status FROM dose_logs WHERE med_id=? AND date=? AND time=?').get(m.id, date, time);
    const wasTaken = prev?.status === 'taken';
    const isTaken = status === 'taken';
    if (status === null) {
      db.prepare('DELETE FROM dose_logs WHERE med_id=? AND date=? AND time=?').run(m.id, date, time);
    } else {
      let at = isTaken ? (taken_at || null) : null;
      if (isTaken && !at) {
        const n = today(db, uid);
        at = n.date === date ? `${String(Math.floor(n.minutes / 60)).padStart(2, '0')}:${String(n.minutes % 60).padStart(2, '0')}` : time;
      }
      db.prepare(`INSERT INTO dose_logs (user_id, med_id, date, time, status, taken_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(med_id, date, time) DO UPDATE SET status=excluded.status, taken_at=excluded.taken_at, recorded_at=datetime('now')`)
        .run(uid, m.id, date, time, status, at);
    }
    db.prepare('DELETE FROM snoozes WHERE med_id=? AND date=? AND time=?').run(m.id, date, time);
    if (isTaken && !wasTaken) adjustStock(db, m, -1);
    if (!isTaken && wasTaken) adjustStock(db, m, +1);
    return { ok: true, stock: m.stock, low_stock: m.stock != null && m.restock_threshold != null && m.stock <= m.restock_threshold };
  });
}

function snoozeDose(db, uid, { med_id, date, time, minutes }, nowMs = Date.now()) {
  const m = assertScheduled(db, uid, med_id, date, time);
  const min = Number(minutes);
  if (![10, 30, 60].includes(min)) throw bad('稍後提醒可選 10、30 或 60 分鐘');
  if (db.prepare('SELECT 1 FROM dose_logs WHERE med_id=? AND date=? AND time=?').get(m.id, date, time)) throw bad('這一劑已經有紀錄了');
  const until = nowMs + min * 60000;
  db.prepare(`INSERT INTO snoozes (user_id, med_id, date, time, until_ms) VALUES (?,?,?,?,?)
    ON CONFLICT(med_id, date, time) DO UPDATE SET until_ms=excluded.until_ms`).run(uid, m.id, date, time, until);
  return { ok: true, snooze_until: until };
}

// ---------- 日曆與統計 ----------

function calendarMonth(db, uid, month, nowMs = Date.now()) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw bad('月份格式需為 YYYY-MM');
  const meds = allMeds(db, uid);
  const t = today(db, uid, nowMs).date;
  const first = `${month}-01`;
  if (!S.isValidDate(first)) throw bad('月份不正確');
  const logs = db.prepare("SELECT med_id, date, time, status FROM dose_logs WHERE user_id=? AND date LIKE ?").all(uid, `${month}-%`);
  const byDay = new Map();
  const logsByDay = new Map();
  for (const l of logs) {
    if (!byDay.has(l.date)) { byDay.set(l.date, new Map()); logsByDay.set(l.date, []); }
    byDay.get(l.date).set(`${l.med_id}|${l.time}`, l.status);
    logsByDay.get(l.date).push(l);
  }
  const days = [];
  for (let d = first; d.startsWith(month); d = S.addDays(d, 1)) {
    const doses = dosesWithHistory(meds, d, logsByDay.get(d) || []);
    const m = byDay.get(d) || new Map();
    let taken = 0, skipped = 0;
    for (const x of doses) {
      const st = m.get(`${x.med.id}|${x.time}`);
      if (st === 'taken') taken++; else if (st === 'skipped') skipped++;
    }
    days.push({ date: d, expected: doses.length, taken, skipped, unconfirmed: doses.length - taken - skipped, future: d > t });
  }
  return { month, today: t, days };
}

// ---------- 匯出 ----------

const STATUS_LABEL = { taken: '已服用', skipped: '略過', null: '未確認' };

function exportCsv(db, uid, from, to) {
  if (!S.isValidDate(from) || !S.isValidDate(to) || from > to) throw bad('日期區間不正確');
  if (S.daysBetween(from, to) > 366) throw bad('一次最多匯出一年');
  const t = today(db, uid).date;
  const end = to > t ? t : to;
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['日期', '預定時間', '名稱', '用量', '狀態', '實際服用時間', '備註']];
  for (let d = from; d <= end; d = S.addDays(d, 1)) {
    for (const x of dayView(db, uid, d).doses) {
      rows.push([d, x.time, x.med.name, x.med.dose_amount != null ? `${x.med.dose_amount}${x.med.dose_unit}` : '',
        STATUS_LABEL[x.status], x.taken_at || '', x.med.note]);
    }
  }
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

// 通知無法使用時的替代方案：匯出成行事曆（含鬧鐘）
function exportIcs(db, uid, host) {
  const st = getSettings(db, uid);
  const meds = allMeds(db, uid).filter((m) => !m.deleted_date && !m.paused_since);
  const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const fold = (s) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//chile-ma//health-checkin//ZH-TW', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:今天吃了嗎？'];
  for (const m of meds) {
    for (const time of m.times) {
      let rule = m.freq_type === 'daily' ? 'FREQ=DAILY'
        : m.freq_type === 'weekly' ? `FREQ=WEEKLY;BYDAY=${m.weekdays.map((d) => BYDAY[d]).join(',')}`
          : `FREQ=DAILY;INTERVAL=${m.interval_days}`;
      if (m.end_date) rule += `;UNTIL=${m.end_date.replace(/-/g, '')}T235959`;
      const title = st.hide_names ? '健康提醒' : `${m.name}${m.dose_amount != null ? ` ${m.dose_amount}${m.dose_unit}` : ''}`;
      lines.push('BEGIN:VEVENT', `UID:med-${m.id}-${time.replace(':', '')}@${host}`, `DTSTAMP:${stamp}`,
        `DTSTART;TZID=${st.timezone}:${m.start_date.replace(/-/g, '')}T${time.replace(':', '')}00`, 'DURATION:PT10M',
        `RRULE:${rule}`, `SUMMARY:${fold(title)}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${fold(title)}`,
        'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  HttpError, getSettings, updateSettings, today, listMeds, getMed, createMed, updateMed, setPaused, deleteMed,
  dayView, setDose, snoozeDose, calendarMonth, exportCsv, exportIcs, allMeds, publicMed,
};
