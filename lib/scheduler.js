'use strict';
// 後端排程：每次掃描找出「該通知且尚未通知過」的劑次，同一時段合併成一則推播。
const S = require('./schedule');
const { rowToMed } = require('./db');
const { sendNotification } = require('./webpush');

const STALE_MIN = 20; // 錯過超過 20 分鐘的提醒不再補送（例如伺服器停機後重啟），避免半夜一次湧入舊通知

const fmtTime = (min) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// 純計算：回傳 [{ userId, key, payload }]，並不寫入資料庫
function computeDue(db, nowMs) {
  const users = db.prepare(`SELECT DISTINCT s.user_id, s.timezone, s.repeat_minutes, s.repeat_count, s.hide_names
    FROM settings s JOIN push_subs p ON p.user_id = s.user_id`).all();
  const out = [];
  for (const u of users) {
    const now = S.localNow(u.timezone, nowMs);
    const meds = db.prepare('SELECT * FROM meds WHERE user_id=? AND deleted_date IS NULL').all(u.user_id).map(rowToMed);
    if (!meds.length) continue;
    const logged = new Set();
    const snoozed = new Map();
    for (const date of [S.addDays(now.date, -1), now.date]) {
      for (const l of db.prepare('SELECT med_id, time FROM dose_logs WHERE user_id=? AND date=?').all(u.user_id, date)) logged.add(`${l.med_id}|${date}|${l.time}`);
      for (const s of db.prepare('SELECT med_id, time, until_ms FROM snoozes WHERE user_id=? AND date=?').all(u.user_id, date)) snoozed.set(`${s.med_id}|${date}|${s.time}`, s.until_ms);
    }
    const groups = new Map(); // key → { date, time, kind, meds: [] }
    const add = (key, info, med) => {
      if (!groups.has(key)) groups.set(key, { ...info, meds: [] });
      groups.get(key).meds.push(med);
    };

    // 昨天（offset -1440）與今天，讓 23:50 的劑次在跨夜後仍能再次提醒
    for (const [date, offset] of [[S.addDays(now.date, -1), -1440], [now.date, 0]]) {
      for (const { med, time } of S.dosesForDate(meds, date)) {
        if (!med.notify) continue;
        const k = `${med.id}|${date}|${time}`;
        if (logged.has(k)) continue; // 已服用或略過 → 不再提醒
        const sched = offset + S.timeToMin(time);
        const snz = snoozed.get(k);
        if (snz !== undefined) {
          // 使用者按了「稍後提醒」：只在到期時提醒一次，到期前不打擾
          if (snz <= nowMs && nowMs - snz < STALE_MIN * 60000) {
            add(`dose|${u.user_id}|${date}|${time}|snz${snz}`, { date, time, kind: 'snooze' }, med);
          }
          continue;
        }
        // 第 0 次 = 準時提醒；之後依設定間隔再提醒 repeat_count 次
        let attempt = -1;
        for (let i = 0; i <= u.repeat_count; i++) {
          const fire = sched + i * u.repeat_minutes;
          if (fire <= now.minutes && now.minutes - fire < STALE_MIN) attempt = i;
        }
        if (attempt >= 0) add(`dose|${u.user_id}|${date}|${time}|${attempt}`, { date, time, kind: attempt ? 'repeat' : 'first' }, med);
      }
    }

    for (const [key, g] of groups) {
      const names = g.meds.map((m) => m.name);
      const title = g.kind === 'first' ? `${g.time} 該照顧自己囉 🌱` : `${g.time} 的項目還沒確認喔`;
      const body = u.hide_names
        ? `有 ${names.length} 個項目等你確認`
        : names.slice(0, 4).join('、') + (names.length > 4 ? ` 等 ${names.length} 項` : '');
      out.push({
        userId: u.user_id, key,
        payload: {
          type: 'dose', title, body, tag: `dose-${g.date}-${g.time}`,
          data: { date: g.date, time: g.time, medIds: g.meds.map((m) => m.id), url: `/?date=${g.date}` },
        },
      });
    }

    // 補貨提醒：每天 09:00 後最多一次
    if (now.minutes >= 9 * 60) {
      for (const m of meds) {
        if (m.paused_since || m.stock == null || m.restock_threshold == null || m.stock > m.restock_threshold) continue;
        out.push({
          userId: u.user_id, key: `restock|${m.id}|${now.date}`,
          payload: {
            type: 'restock', title: '記得補貨喔 🛒',
            body: u.hide_names ? '有項目的數量快用完了' : `${m.name} 剩 ${m.stock}${m.dose_unit || ''}`,
            tag: `restock-${m.id}`, data: { url: '/#/items' },
          },
        });
      }
    }
  }
  return out;
}

function createScheduler({ db, getVapid, log = console, send = sendNotification, intervalMs = 20000 }) {
  let timer = null;
  let running = false;

  async function deliver(userId, payload, topic) {
    const subs = db.prepare('SELECT * FROM push_subs WHERE user_id=?').all(userId);
    let delivered = 0;
    for (const sub of subs) {
      try {
        const r = await send(sub, payload, getVapid(), { topic, ttl: payload.type === 'dose' ? 3600 : 6 * 3600 });
        if (r.statusCode >= 200 && r.statusCode < 300) {
          delivered++;
          db.prepare("UPDATE push_subs SET last_ok_at=datetime('now'), fail_count=0 WHERE id=?").run(sub.id);
        } else if (r.statusCode === 404 || r.statusCode === 410) {
          db.prepare('DELETE FROM push_subs WHERE id=?').run(sub.id); // 訂閱已失效（解除安裝、取消權限）
        } else {
          db.prepare('UPDATE push_subs SET fail_count=fail_count+1 WHERE id=?').run(sub.id);
          log.warn?.(`[push] ${r.statusCode} ${r.body}`);
        }
      } catch (e) {
        db.prepare('UPDATE push_subs SET fail_count=fail_count+1 WHERE id=?').run(sub.id);
        log.warn?.(`[push] error ${e.message}`);
      }
    }
    return delivered;
  }

  async function tick(nowMs = Date.now()) {
    if (running) return [];
    running = true;
    const sent = [];
    try {
      for (const n of computeDue(db, nowMs)) {
        // 先寫入通知鍵再送：即使同時有兩個掃描，也只有一個能寫入成功
        const r = db.prepare('INSERT OR IGNORE INTO notif_log (key, user_id, sent_at) VALUES (?,?,?)').run(n.key, n.userId, nowMs);
        if (!r.changes) continue;
        await deliver(n.userId, n.payload, n.payload.tag);
        sent.push(n.key);
      }
      db.prepare('DELETE FROM notif_log WHERE sent_at < ?').run(nowMs - 3 * 86400000);
      db.prepare('DELETE FROM snoozes WHERE until_ms < ?').run(nowMs - 86400000);
    } catch (e) {
      log.error?.('[scheduler]', e);
    } finally { running = false; }
    return sent;
  }

  return {
    tick, deliver,
    start() { if (!timer) { timer = setInterval(() => tick(), intervalMs); timer.unref?.(); tick(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { computeDue, createScheduler, fmtTime };
