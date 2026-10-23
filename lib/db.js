'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
  repeat_minutes INTEGER NOT NULL DEFAULT 15,
  repeat_count INTEGER NOT NULL DEFAULT 2,
  hide_names INTEGER NOT NULL DEFAULT 0
);

-- 家庭成員（第一階段每個帳號一位「我」，資料表先預留）
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meds (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'supplement',
  photo TEXT,
  dose_amount REAL,
  dose_unit TEXT NOT NULL DEFAULT '',
  times TEXT NOT NULL,              -- JSON ["08:00","20:00"]
  freq_type TEXT NOT NULL,          -- daily | weekly | interval
  weekdays TEXT,                    -- JSON [1,3,5]
  interval_days INTEGER,
  start_date TEXT NOT NULL,
  end_date TEXT,
  note TEXT NOT NULL DEFAULT '',
  notify INTEGER NOT NULL DEFAULT 1,
  stock REAL,
  restock_threshold REAL,
  paused_since TEXT,
  deleted_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS meds_user ON meds(user_id);

CREATE TABLE IF NOT EXISTS dose_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  med_id INTEGER NOT NULL REFERENCES meds(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('taken','skipped')),
  taken_at TEXT,                    -- 使用者回報的實際服用時間（本地時間 HH:MM）
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (med_id, date, time)       -- 同一劑次只會有一筆：重複按「已服用」不會重複計
);
CREATE INDEX IF NOT EXISTS logs_user_date ON dose_logs(user_id, date);

CREATE TABLE IF NOT EXISTS snoozes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  med_id INTEGER NOT NULL REFERENCES meds(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  until_ms INTEGER NOT NULL,
  PRIMARY KEY (med_id, date, time)
);

CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0
);

-- 已送出的通知鍵：防止同一時段重複通知（伺服器重啟、多次排程掃描都不會重送）
CREATE TABLE IF NOT EXISTS notif_log (
  key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  sent_at INTEGER NOT NULL
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function rowToMed(r) {
  if (!r) return null;
  return {
    ...r,
    times: JSON.parse(r.times),
    weekdays: r.weekdays ? JSON.parse(r.weekdays) : null,
    notify: !!r.notify,
  };
}

module.exports = { openDb, tx, rowToMed };
