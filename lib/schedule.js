'use strict';
// 純函式：日期、時區、排程判斷。前後端共用同一套規則（前端有對應的精簡版）。

const SLOTS = [
  { id: 'morning', label: '早上' },
  { id: 'noon', label: '中午' },
  { id: 'evening', label: '晚上' },
  { id: 'bedtime', label: '睡前' },
];

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function dayOfWeek(date) { // 0 = 週日
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

// 取得某時區當下的「本地日期」與「當天第幾分鐘」
function localNow(tz, nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

function slotOf(time) {
  const m = timeToMin(time);
  if (m >= 5 * 60 && m < 11 * 60) return 'morning';
  if (m >= 11 * 60 && m < 16 * 60) return 'noon';
  if (m >= 16 * 60 && m < 21 * 60) return 'evening';
  return 'bedtime';
}

// 這個項目在這一天是否「應該服用」
function occursOn(med, date) {
  if (!med.start_date || date < med.start_date) return false;
  if (med.end_date && date > med.end_date) return false;
  if (med.deleted_date && date >= med.deleted_date) return false;
  if (med.paused_since && date >= med.paused_since) return false;
  switch (med.freq_type) {
    case 'daily': return true;
    case 'weekly': return Array.isArray(med.weekdays) && med.weekdays.includes(dayOfWeek(date));
    case 'interval': {
      const n = Number(med.interval_days) || 1;
      return daysBetween(med.start_date, date) % n === 0;
    }
    default: return false;
  }
}

// 一天中所有應服用的劑次，依時間排序
function dosesForDate(meds, date) {
  const out = [];
  for (const med of meds) {
    if (!occursOn(med, date)) continue;
    for (const time of med.times || []) out.push({ med, time, slot: slotOf(time) });
  }
  out.sort((a, b) => a.time.localeCompare(b.time) || a.med.name.localeCompare(b.med.name));
  return out;
}

module.exports = {
  SLOTS, isValidDate, isValidTime, isValidTimeZone, addDays, daysBetween, dayOfWeek,
  timeToMin, localNow, slotOf, occursOn, dosesForDate,
};
