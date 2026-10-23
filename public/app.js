// 今天吃了嗎？— 前端（原生 JS，無框架、無建置步驟）
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const root = $('#root');

const SLOTS = [
  { id: 'morning', label: '早上' }, { id: 'noon', label: '中午' },
  { id: 'evening', label: '晚上' }, { id: 'bedtime', label: '睡前' },
];
const CATS = { supplement: '保健食品', medicine: '藥物', other: '其他' };
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const UNITS = ['顆', '錠', '粒', '包', '匙', '毫升', '滴'];
const NOTE_PRESETS = ['飯前', '飯後', '隨餐', '空腹', '配溫水'];
const CHEERS = [
  '今天也有好好照顧自己，真棒 🌷', '小小的習慣，正在慢慢長大 🌱', '身體會記得你的用心 🍃',
  '今天的小花開了，明天見 🌼', '謝謝你這麼溫柔地對待自己', '完成！給自己一個大大的讚 ✨',
];
const SMALL_CHEERS = ['記好了 ✓', '收到，做得好 🌱', '又前進一小步 🍃', '已記錄，辛苦了'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const state = { me: null, meds: [], day: null, calMonth: null, cal: null, lastComplete: null };

// ---------- 工具 ----------
function slotOf(t) {
  const m = toMin(t);
  if (m >= 300 && m < 660) return 'morning';
  if (m >= 660 && m < 960) return 'noon';
  if (m >= 960 && m < 1260) return 'evening';
  return 'bedtime';
}
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fmtMin = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const tz = () => state.me?.settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
function localNow() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: +g('hour') * 60 + +g('minute') };
}
const fmtClock = (ms) => new Intl.DateTimeFormat('zh-TW', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
function addDays(d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function fmtDate(d, withYear = false) {
  const x = new Date(d + 'T00:00:00Z');
  return `${withYear ? x.getUTCFullYear() + '年' : ''}${x.getUTCMonth() + 1}月${x.getUTCDate()}日 星期${WEEK[x.getUTCDay()]}`;
}
const doseText = (m) => (m.dose_amount != null ? `${+m.dose_amount}${m.dose_unit || ''}` : '');

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'chile-ma' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('目前無法連線，請確認網路後再試一次');
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (res.status === 401 && !path.startsWith('/api/auth/')) { state.me = null; renderAuth(); throw new Error('登入已過期，請重新登入'); }
  if (!res.ok) throw new Error(data?.error || '發生錯誤，請稍後再試');
  return data;
}

function toast(msg, { error = false, action, onAction, ms = 2600 } = {}) {
  const wrap = $('#toasts');
  wrap.innerHTML = `<div class="toast ${error ? 'err' : ''}" role="status">${esc(msg)}${action ? `<button class="btn">${esc(action)}</button>` : ''}</div>`;
  const el = wrap.firstElementChild;
  if (action) el.querySelector('button').onclick = () => { wrap.innerHTML = ''; onAction(); };
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { if (wrap.firstElementChild === el) wrap.innerHTML = ''; }, action ? 5000 : ms);
}
const fail = (e) => toast(e.message || String(e), { error: true });

// ---------- 插畫 ----------
const ICON = {
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20v-7"/><path d="M12 13c0-3.5 2.5-6 6-6 0 3.5-2.5 6-6 6Z"/><path d="M12 15c0-3-2.2-5-5-5 0 3 2.2 5 5 5Z"/><path d="M6 20h12"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="4"/><path d="M8 3v4M16 3v4M3.5 10h17"/><circle cx="12" cy="15" r="1.4" fill="currentColor"/></svg>',
  items: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3" width="10" height="4" rx="1.5"/><path d="M7.5 7h9a1.5 1.5 0 0 1 1.5 1.5V19a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8.5A1.5 1.5 0 0 1 7.5 7Z"/><path d="M6 12h12v5H6"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 6-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v9h14v-9h-1"/></svg>',
  addsq: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
  slot: {
    morning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="4"/><path d="M12 4v2M5 13H3M21 13h-2M6.3 7.3 7.7 8.7M17.7 7.3l-1.4 1.4M4 19h16"/></svg>',
    noon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>',
    evening: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 17h16M7 17a5 5 0 0 1 10 0"/><path d="M12 7v2M5.5 10.5l1.2 1.2M18.5 10.5l-1.2 1.2M6 21h12"/></svg>',
    bedtime: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z"/><path d="M16 4h3l-3 3h3"/></svg>',
  },
  cat: {
    supplement: '<svg viewBox="0 0 32 32" fill="none"><g transform="rotate(-40 16 16)"><path d="M16 10.5h5.5a5.5 5.5 0 0 1 0 11H16Z" fill="currentColor" opacity=".3"/><rect x="5" y="10.5" width="22" height="11" rx="5.5" stroke="currentColor" stroke-width="2"/><path d="M16 10.5v11" stroke="currentColor" stroke-width="2"/></g></svg>',
    medicine: '<svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="9" fill="currentColor" opacity=".2"/><circle cx="16" cy="16" r="9" stroke="currentColor" stroke-width="2"/><path d="M11 16h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    other: '<svg viewBox="0 0 32 32" fill="none"><path d="M16 26V15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16 15c0-5 3.5-8.5 9-8.5 0 5-3.5 8.5-9 8.5Z" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M16 18c0-4-3-7-7.5-7 0 4 3 7 7.5 7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  },
};

// 今日小芽：依完成比例長大（0 → 種子，1 → 開花）
function sproutSVG(ratio, animate) {
  const stage = ratio >= 1 ? 4 : ratio >= 0.67 ? 3 : ratio >= 0.34 ? 2 : ratio > 0 ? 1 : 0;
  const g = animate ? 'class="grow"' : '';
  const stem = stage >= 1 ? `<path d="M56 86 V${[0, 70, 58, 46, 40][stage]}" stroke="#6F8F69" stroke-width="3.2" stroke-linecap="round"/>` : '';
  const leaf1 = stage >= 1 ? '<path d="M56 74c-2-9-10-13-18-12 1 8 8 13 18 12Z" fill="#9DBB96"/>' : '';
  const leaf2 = stage >= 2 ? '<path d="M56 64c2-10 11-14 20-12-1 9-9 14-20 12Z" fill="#8FA98A"/>' : '';
  const leaf3 = stage >= 3 ? '<path d="M56 54c-1-7-7-10-13-9 1 6 6 10 13 9Z" fill="#AFC9A8"/>' : '';
  const bud = stage === 3 ? '<ellipse cx="56" cy="40" rx="5.5" ry="7.5" fill="#F2CBC5"/><path d="M50.5 42c2 3 9 3 11 0" stroke="#8FA98A" stroke-width="2.4" fill="none" stroke-linecap="round"/>' : '';
  const flower = stage === 4 ? `<g>${[0, 72, 144, 216, 288].map((r) => `<ellipse cx="56" cy="27" rx="7" ry="10" fill="#F2CBC5" transform="rotate(${r} 56 36)"/>`).join('')}<circle cx="56" cy="36" r="6" fill="#E9CB8B"/></g>` : '';
  const seed = stage === 0 ? '<ellipse cx="56" cy="85" rx="5" ry="3.5" fill="#B9A27A"/><path d="M56 82c0-3 1.5-5 3.5-6" stroke="#9DBB96" stroke-width="2" stroke-linecap="round" fill="none"/>' : '';
  return `<svg class="sprout" viewBox="0 0 112 112" aria-hidden="true">
    <ellipse cx="56" cy="104" rx="30" ry="4" fill="#E4ECDF"/>
    <g ${g}>${stem}${leaf1}${leaf2}${leaf3}${bud}${flower}${seed}</g>
    <path d="M32 86h48l-5 17a3 3 0 0 1-3 2H40a3 3 0 0 1-3-2l-5-17Z" fill="#E8B9A4"/>
    <rect x="29" y="82" width="54" height="8" rx="4" fill="#DDA48E"/>
  </svg>`;
}

const potEmpty = `<svg viewBox="0 0 150 120" aria-hidden="true"><ellipse cx="75" cy="112" rx="44" ry="5" fill="#E4ECDF"/><path d="M75 82V50" stroke="#6F8F69" stroke-width="3" stroke-linecap="round"/><path d="M75 62c-3-12-14-17-25-15 2 11 11 17 25 15Z" fill="#9DBB96"/><path d="M75 54c3-13 15-18 27-15-2 12-12 18-27 15Z" fill="#8FA98A"/><circle cx="110" cy="30" r="10" fill="#F2CBC5" opacity=".7"/><circle cx="36" cy="26" r="5" fill="#E9CB8B" opacity=".7"/><path d="M45 82h60l-7 24a4 4 0 0 1-4 3H56a4 4 0 0 1-4-3l-7-24Z" fill="#E8B9A4"/><rect x="41" y="77" width="68" height="10" rx="5" fill="#DDA48E"/></svg>`;

function thumb(m, cls = '') {
  if (m.photo) return `<img class="thumb ${cls}" src="${esc(m.photo)}" alt="" loading="lazy">`;
  return `<div class="thumb ${esc(m.category)} ${cls}" aria-hidden="true">${ICON.cat[m.category] || ICON.cat.other}</div>`;
}

// ---------- 版面骨架 ----------
function shell(active, inner) {
  const tabs = [['today', '今天'], ['calendar', '日曆'], ['items', '我的項目'], ['settings', '設定']];
  return `<main class="app view" id="main">${inner}</main>
  <nav class="nav" aria-label="主選單"><div class="nav-inner">
    ${tabs.map(([id, label]) => `<a href="#/${id}" ${active === id ? 'aria-current="page"' : ''}><span class="nav-ico">${ICON[id]}</span>${label}</a>`).join('')}
  </div></nav>`;
}

// ---------- 首頁 ----------
function greeting(min) {
  const name = state.me.display_name ? `，${state.me.display_name}` : '';
  if (min < 300) return `夜深了${name}`;
  if (min < 660) return `早安${name}`;
  if (min < 1080) return `午安${name}`;
  return `晚安${name}`;
}

function doseStatus(d, now) {
  if (d.status === 'taken') return 'taken';
  if (d.status === 'skipped') return 'skipped';
  if (d.snooze_until && d.snooze_until > Date.now()) return 'snoozed';
  if (state.day.date < now.date || (state.day.date === now.date && toMin(d.time) <= now.minutes)) return 'due';
  return 'upcoming';
}

function doseCard(d, now) {
  const st = doseStatus(d, now);
  const k = `data-med="${d.med.id}" data-time="${d.time}"`;
  const meta = [doseText(d.med), d.med.note].filter(Boolean).map(esc).join('<span aria-hidden="true">·</span>');
  let bottom;
  if (st === 'taken') bottom = `<div class="dose-status"><span>✓ 已服用 ${esc(d.taken_at || '')}</span><button class="btn btn-ghost" data-act="edit" ${k}>更改</button></div>`;
  else if (st === 'skipped') bottom = `<div class="dose-status"><span>這次略過了</span><button class="btn btn-ghost" data-act="edit" ${k}>更改</button></div>`;
  else bottom = `${st === 'snoozed' ? `<div class="dose-status"><span>⏰ ${fmtClock(d.snooze_until)} 再提醒你</span></div>` : ''}
    <div class="dose-actions">
      <button class="btn btn-primary" data-act="take" ${k}>已服用</button>
      <button class="btn btn-soft" data-act="snooze" ${k}>稍後提醒</button>
      <button class="btn btn-ghost" data-act="skip" ${k}>略過</button>
    </div>`;
  return `<article class="dose is-${st}">
    ${thumb(d.med)}
    <div><div class="dose-name">${esc(d.med.name)}</div>
      <div class="dose-meta">${meta}${d.med.low_stock ? '<span class="tag blush">快用完了</span>' : ''}${d.med.deleted ? '<span class="tag mute">已刪除</span>' : ''}</div></div>
    <div class="dose-time">${st === 'due' ? `<span class="due">${esc(d.time)}</span>` : esc(d.time)}</div>
    ${bottom}
  </article>`;
}

async function loadDay(date) {
  state.day = await api('GET', `/api/day?date=${date}`);
}

function renderToday({ animate = false } = {}) {
  const now = localNow();
  const day = state.day;
  const doses = day.doses;
  const done = doses.filter((d) => d.status).length;
  const taken = doses.filter((d) => d.status === 'taken').length;
  const ratio = doses.length ? done / doses.length : 0;
  const isToday = day.date === now.date;
  const pending = doses.filter((d) => !d.status).length;

  let head;
  if (!doses.length) head = '';
  else if (done === doses.length) head = `<h2>今天的小花開了 🌷</h2><p>所有項目都確認完成</p>`;
  else if (done === 0) head = `<h2>今天有 ${doses.length} 個小任務</h2><p>每完成一個，小芽就長大一點</p>`;
  else head = `<h2>再 ${pending} 個就完成了</h2><p>小芽正在慢慢長大</p>`;

  const sections = SLOTS.map((s) => {
    const list = doses.filter((d) => d.slot === s.id);
    if (!list.length) return '';
    return `<section class="slot slot-${s.id}" aria-label="${s.label}">
      <div class="slot-head"><span class="slot-ico">${ICON.slot[s.id]}</span><h3>${s.label}</h3>
      <span class="count">${list.filter((d) => d.status).length} / ${list.length}</span></div>
      ${list.map((d) => doseCard(d, now)).join('')}
    </section>`;
  }).join('');

  const banners = [];
  const p = pushSupport();
  if (state.meds.some((m) => m.notify && !m.paused) && !p.subscribed) {
    banners.push(`<div class="banner"><div><b>開啟提醒通知</b>時間到了，手機會提醒你</div><button class="btn" data-act="push-guide">設定</button></div>`);
  }
  const devTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (devTz && devTz !== state.me.settings.timezone && !sessionStorageGet('tz-dismiss')) {
    banners.push(`<div class="banner sage"><div><b>你好像換了時區</b>目前提醒依「${esc(state.me.settings.timezone)}」，要改成「${esc(devTz)}」嗎？</div><button class="btn" data-act="tz-update" data-tz="${esc(devTz)}">更新</button></div>`);
  }

  const body = !state.meds.length && !doses.length
    ? `<div class="empty">${potEmpty}<h2>種下第一顆小種子</h2><p>把每天要吃的保健食品或藥物加進來，<br>時間到了就會提醒你。</p><a class="btn btn-primary" href="#/items?new=1">${ICON.plus.replace('<svg', '<svg width="18" height="18"')}新增項目</a></div>`
    : !doses.length
      ? `<div class="empty"><h2>${isToday ? '今天沒有安排項目' : '這天沒有安排項目'}</h2><p>好好休息，也是照顧自己的一部分。</p></div>`
      : `<div class="card sprout-card">${sproutSVG(ratio, animate)}<div>${head}</div>
          <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${doses.length}" aria-valuenow="${done}" aria-label="今日完成進度"><span style="width:${Math.round(ratio * 100)}%"></span></div>
          <div class="progress-meta"><span>已確認 ${done} / ${doses.length}</span><span>已服用 ${taken}</span></div></div>
        ${sections}`;

  root.innerHTML = shell('today', `
    <header class="topbar"><div><p class="sub">${fmtDate(day.date)}</p><h1>${isToday ? greeting(now.minutes) : '回顧這一天'}</h1></div>
      ${!isToday ? `<a class="btn btn-soft" href="#/today">回到今天</a>` : ''}</header>
    ${banners.join('')}
    ${body}`);
  root.firstElementChild.onclick = onDoseClick;
}

let sessionStore = {};
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return sessionStore[k]; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { sessionStore[k] = v; } }

function findDose(medId, time) { return state.day.doses.find((d) => d.med.id === medId && d.time === time); }

async function setDose(medId, time, status, taken_at, { quiet = false } = {}) {
  const prev = findDose(medId, time);
  const before = prev ? { status: prev.status, taken_at: prev.taken_at } : null;
  const r = await api('POST', '/api/doses', { med_id: medId, date: state.day.date, time, status, taken_at });
  await loadDay(state.day.date);
  rerender(true);
  closeNotificationsFor(state.day.date, time);
  if (!quiet) {
    const msg = status === 'taken' ? pick(SMALL_CHEERS) : status === 'skipped' ? '已記下這次略過' : '已清除紀錄';
    toast(r.low_stock && status === 'taken' ? `${msg}・剩餘數量不多了，記得補貨` : msg, {
      action: '復原', onAction: () => setDose(medId, time, before?.status ?? null, before?.taken_at, { quiet: true }).catch(fail),
    });
  }
  maybeCelebrate();
}

function maybeCelebrate() {
  const now = localNow();
  const d = state.day;
  if (d.date !== now.date || !d.doses.length) return;
  const complete = d.doses.every((x) => x.status) && d.doses.some((x) => x.status === 'taken');
  if (complete && state.lastComplete === false) celebrate();
  state.lastComplete = complete;
}

function celebrate() {
  const el = document.createElement('div');
  el.className = 'celebrate';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '今日完成');
  el.innerHTML = `<div class="celebrate-inner">
    <svg viewBox="0 0 200 200" aria-hidden="true"><g class="float">
      <path d="M100 178V100" stroke="#6F8F69" stroke-width="5" stroke-linecap="round"/>
      <path d="M100 150c-4-18-20-26-36-24 2 17 17 26 36 24Z" fill="#9DBB96"/><path d="M100 134c4-19 21-27 38-24-2 18-18 27-38 24Z" fill="#8FA98A"/>
      <g class="petals">${[0, 60, 120, 180, 240, 300].map((r, i) => `<ellipse cx="100" cy="70" rx="14" ry="22" fill="${i % 2 ? '#F2CBC5' : '#F6D9D4'}" transform="rotate(${r} 100 92)"/>`).join('')}</g>
      <circle cx="100" cy="92" r="13" fill="#E9CB8B"/></g>
      <circle class="spark" style="animation-delay:.5s" cx="40" cy="60" r="5" fill="#E9CB8B"/><circle class="spark" style="animation-delay:.7s" cx="166" cy="48" r="4" fill="#F2CBC5"/><circle class="spark" style="animation-delay:.9s" cx="160" cy="120" r="5" fill="#9DBB96"/>
    </svg>
    <h2>今天完成了！</h2><p>${esc(pick(CHEERS))}</p>
    <button class="btn btn-primary btn-block">好的</button></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector('button').onclick = close;
  el.querySelector('button').focus();
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
}

function onDoseClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const medId = Number(b.dataset.med), time = b.dataset.time;
  const act = b.dataset.act;
  if (act === 'take') setDose(medId, time, 'taken').catch(fail);
  else if (act === 'skip') setDose(medId, time, 'skipped').catch(fail);
  else if (act === 'snooze') snoozeSheet(medId, time);
  else if (act === 'edit') editDoseSheet(medId, time);
  else if (act === 'push-guide') pushGuideSheet();
  else if (act === 'tz-update') {
    api('PATCH', '/api/settings', { timezone: b.dataset.tz }).then((s) => { state.me.settings = s; toast('已更新時區'); route(); }).catch(fail);
  }
}

function snoozeSheet(medId, time) {
  const d = findDose(medId, time);
  const now = localNow();
  if (state.day.date !== now.date) return toast('稍後提醒只適用於今天的項目', { error: true });
  openSheet(`${esc(d.med.name)}・稍後提醒`, `<div class="action-list">
    ${[10, 30, 60].map((m) => `<button class="btn btn-soft" data-min="${m}">${m === 60 ? '1 小時' : m + ' 分鐘'}後提醒我</button>`).join('')}
  </div><p class="note-soft">${pushSupport().subscribed ? '時間到了會再推播通知你。' : '尚未開啟通知：到時請回到 App 查看。'}</p>`, (sheet, close) => {
    sheet.querySelectorAll('[data-min]').forEach((b) => b.onclick = async () => {
      try {
        await api('POST', '/api/doses/snooze', { med_id: medId, date: state.day.date, time, minutes: Number(b.dataset.min) });
        close(); await loadDay(state.day.date); rerender(); toast('好的，等等提醒你');
      } catch (e) { fail(e); }
    });
  });
}

function editDoseSheet(medId, time, after, dayObj = state.day) {
  const d = dayObj.doses.find((x) => x.med.id === medId && x.time === time);
  if (!d) return;
  const dayDate = dayObj.date;
  openSheet(`${esc(d.med.name)}・${esc(d.time)}`, `
    <p class="note-soft" style="margin-top:0">${fmtDate(dayDate)}${d.status ? '' : '・尚未記錄'}</p>
    <div class="field"><label for="ta">實際服用時間</label><input class="input" type="time" id="ta" value="${esc(d.taken_at || d.time)}"></div>
    <div class="action-list">
      <button class="btn btn-primary" data-s="taken">${d.status === 'taken' ? '更新服用時間' : '記錄為已服用'}</button>
      ${d.status !== 'skipped' ? '<button class="btn btn-soft" data-s="skipped">記錄為略過</button>' : ''}
      ${d.status ? '<button class="btn btn-blush" data-s="clear">清除紀錄（改回未確認）</button>' : ''}
    </div>
    <p class="note-soft">補登只會更新紀錄，不會重複計算，也不會影響之後的提醒。</p>`, (sheet, close) => {
    sheet.querySelectorAll('[data-s]').forEach((b) => b.onclick = async () => {
      const s = b.dataset.s === 'clear' ? null : b.dataset.s;
      const ta = $('#ta', sheet).value || null;
      try {
        await api('POST', '/api/doses', { med_id: medId, date: dayDate, time, status: s, taken_at: s === 'taken' ? ta : null });
        close();
        closeNotificationsFor(dayDate, time);
        if (state.day && state.day.date === dayDate) await loadDay(dayDate);
        toast('已更新紀錄');
        if (after) after(); else { rerender(); maybeCelebrate(); }
      } catch (e) { fail(e); }
    });
  });
}

// ---------- 底部抽屜 ----------
function openSheet(title, body, setup, foot = '') {
  const prevFocus = document.activeElement;
  const back = document.createElement('div');
  back.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.innerHTML = `<div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="關閉">${ICON.close}</button></div>
    <div class="sheet-body">${body}</div>${foot ? `<div class="sheet-foot">${foot}</div>` : ''}`;
  document.body.append(back, sheet);
  document.body.style.overflow = 'hidden';
  const close = () => { back.remove(); sheet.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.onclick = close;
  sheet.querySelector('[data-close]').onclick = close;
  setup?.(sheet, close);
  setTimeout(() => (sheet.querySelector('input:not([type=file]), button:not([data-close])') || sheet).focus?.(), 50);
  return { sheet, close };
}

function confirmSheet(title, text, okLabel, onOk, danger = true) {
  openSheet(esc(title), `<p style="margin:0 0 18px">${esc(text)}</p>`, (s, close) => {
    s.querySelector('[data-ok]').onclick = async () => { try { await onOk(); close(); } catch (e) { fail(e); } };
    s.querySelector('[data-cancel]').onclick = close;
  }, `<button class="btn btn-soft" data-cancel>取消</button><button class="btn ${danger ? 'btn-blush' : 'btn-primary'}" data-ok>${esc(okLabel)}</button>`);
}

// ---------- 日曆 ----------
function ringSVG(day) {
  if (day.future || !day.expected) return day.expected ? '<span class="ring-dot"><i></i></span>' : '<span class="ring-dot"></span>';
  const r = 9, c = 2 * Math.PI * r;
  const t = day.taken / day.expected, s = day.skipped / day.expected;
  if (day.taken === day.expected) {
    return '<svg class="ring" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="10" fill="#8FA98A"/><path d="m6.8 11.3 2.8 2.7 5.6-5.6" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  return `<svg class="ring" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="${r}" fill="none" stroke="#ECE6D9" stroke-width="3"/>
    <circle cx="11" cy="11" r="${r}" fill="none" stroke="#8FA98A" stroke-width="3" stroke-dasharray="${t * c} ${c}" transform="rotate(-90 11 11)" stroke-linecap="round"/>
    ${s ? `<circle cx="11" cy="11" r="${r}" fill="none" stroke="#E9CB8B" stroke-width="3" stroke-dasharray="0 ${t * c} ${s * c} ${c}" transform="rotate(-90 11 11)"/>` : ''}</svg>`;
}

async function renderCalendar() {
  const now = localNow();
  if (!state.calMonth) state.calMonth = now.date.slice(0, 7);
  state.cal = await api('GET', `/api/calendar?month=${state.calMonth}`);
  const days = state.cal.days;
  const firstDow = new Date(days[0].date + 'T00:00:00Z').getUTCDay();
  const [y, m] = state.calMonth.split('-').map(Number);
  const past = days.filter((d) => !d.future && d.expected);
  const sum = past.reduce((a, d) => ({ e: a.e + d.expected, t: a.t + d.taken, s: a.s + d.skipped }), { e: 0, t: 0, s: 0 });
  const fullDays = past.filter((d) => d.taken + d.skipped === d.expected && d.taken > 0).length;

  root.innerHTML = shell('calendar', `
    <header class="topbar"><div><p class="sub">打卡日曆</p><h1>每一天的小紀錄</h1></div></header>
    <div class="card" style="margin-top:14px">
      <div class="cal-head" style="margin-top:0">
        <button class="icon-btn" data-nav="-1" aria-label="上個月">${ICON.left}</button>
        <h2>${y} 年 ${m} 月</h2>
        <button class="icon-btn" data-nav="1" aria-label="下個月">${ICON.right}</button>
      </div>
      <div class="cal-grid">
        ${WEEK.map((w) => `<div class="cal-dow">${w}</div>`).join('')}
        ${'<div></div>'.repeat(firstDow)}
        ${days.map((d) => `<button class="cal-day ${d.date === now.date ? 'today' : ''}" data-date="${d.date}" ${d.future ? 'disabled' : ''}
          aria-label="${fmtDate(d.date)}，${d.expected ? `已服用 ${d.taken}，略過 ${d.skipped}，未確認 ${d.unconfirmed}` : '沒有安排'}">
          <span>${Number(d.date.slice(8))}</span>${ringSVG(d)}</button>`).join('')}
      </div>
      <div class="legend">
        <span><i class="lg" style="background:#8FA98A"></i>已服用</span>
        <span><i class="lg" style="background:#E9CB8B"></i>略過</span>
        <span><i class="lg" style="background:#ECE6D9"></i>未確認</span>
      </div>
    </div>
    <div class="month-sum">
      <div class="stat"><b>${sum.e ? Math.round((sum.t / sum.e) * 100) : 0}%</b><small>本月服用率</small></div>
      <div class="stat"><b>${fullDays}</b><small>全部完成的天數</small></div>
      <div class="stat"><b>${sum.e - sum.t - sum.s}</b><small>未確認</small></div>
    </div>
    <p class="note-soft">「未確認」只代表那次沒有打卡，不代表你沒有服用。想起來的話，點日期就能補登。</p>`);

  const main = $('#main');
  main.onclick = (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const d = new Date(Date.UTC(y, m - 1 + Number(nav.dataset.nav), 1));
      state.calMonth = d.toISOString().slice(0, 7);
      return renderCalendar().catch(fail);
    }
    const cell = e.target.closest('[data-date]');
    if (cell) dayDetailSheet(cell.dataset.date);
  };
}

async function dayDetailSheet(date) {
  let view;
  try { view = await api('GET', `/api/day?date=${date}`); } catch (e) { return fail(e); }
  const label = { taken: '已服用', skipped: '略過' };
  const body = view.doses.length ? view.doses.map((d) => `
    <button class="card item" data-med="${d.med.id}" data-time="${d.time}" style="padding:12px">
      ${thumb(d.med)}
      <div><div class="dose-name">${esc(d.med.name)}</div>
        <div class="dose-meta"><span>預定 ${esc(d.time)}</span>${d.status === 'taken' && d.taken_at ? `<span>實際 ${esc(d.taken_at)}</span>` : ''}</div></div>
      <span class="tag ${d.status === 'taken' ? '' : d.status === 'skipped' ? 'mute' : 'blush'}" style="${d.status === 'taken' ? 'background:var(--sage-soft);color:var(--sage-deep)' : ''}">${label[d.status] || '未確認'}</span>
    </button>`).join('') + '<p class="note-soft">點一下項目即可補登或修改。</p>'
    : '<p class="note-soft" style="margin-top:0">這天沒有安排項目。</p>';
  const { close } = openSheet(fmtDate(date), body, (sheet, close) => {
    sheet.querySelector('.sheet-body').onclick = (e) => {
      const b = e.target.closest('[data-med]');
      if (!b) return;
      close();
      editDoseSheet(Number(b.dataset.med), b.dataset.time, () => { renderCalendar().then(() => dayDetailSheet(date)).catch(fail); }, view);
    };
  });
  return close;
}

// ---------- 我的項目 ----------
function freqText(m) {
  if (m.freq_type === 'daily') return '每天';
  if (m.freq_type === 'weekly') return m.weekdays.length === 7 ? '每天' : '每週' + m.weekdays.map((d) => WEEK[d]).join('、');
  return `每 ${m.interval_days} 天`;
}

function renderItems() {
  const list = state.meds;
  root.innerHTML = shell('items', `
    <header class="topbar"><div><p class="sub">共 ${list.length} 個項目</p><h1>我的項目</h1></div></header>
    ${list.length ? `<div style="margin-top:14px">${list.map((m) => `
      <button class="card item ${m.paused ? 'paused' : ''}" data-id="${m.id}">
        ${thumb(m)}
        <div><div class="dose-name">${esc(m.name)}</div>
          <div class="dose-meta"><span>${freqText(m)} ${m.times.map(esc).join('、')}</span>${doseText(m) ? `<span>${esc(doseText(m))}</span>` : ''}</div>
          <div class="dose-meta" style="margin-top:4px">
            ${m.paused ? '<span class="tag mute">暫停中</span>' : ''}
            ${!m.notify ? '<span class="tag mute">不通知</span>' : ''}
            ${m.stock != null ? `<span class="tag ${m.low_stock ? 'blush' : ''}">剩 ${+m.stock}${esc(m.dose_unit)}${m.low_stock ? '・該補貨了' : ''}</span>` : ''}
            ${m.end_date ? `<span class="tag mute">到 ${esc(m.end_date.slice(5).replace('-', '/'))}</span>` : ''}
          </div></div>
        ${ICON.chev}
      </button>`).join('')}</div>`
    : `<div class="empty">${potEmpty}<h2>還沒有項目</h2><p>點下方按鈕，新增你的保健食品或藥物。</p></div>`}
    <button class="btn btn-primary fab" data-new>${ICON.plus}新增項目</button>`);
  $('#main').onclick = (e) => {
    if (e.target.closest('[data-new]')) return medForm();
    const b = e.target.closest('[data-id]');
    if (b) medForm(state.meds.find((m) => m.id === Number(b.dataset.id)));
  };
}

async function resizeImage(file) {
  if (!/^image\//.test(file.type)) throw new Error('請選擇圖片檔');
  const bmp = await createImageBitmap(file).catch(() => null);
  const img = bmp || await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('無法讀取這張圖片')); i.src = URL.createObjectURL(file); });
  const size = 320;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const w = img.width, h = img.height, s = Math.min(w, h);
  c.getContext('2d').drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.82);
}

function medForm(med) {
  const isEdit = !!med;
  const today = localNow().date;
  const v = med ? structuredClone(med) : {
    name: '', category: 'supplement', photo: null, dose_amount: 1, dose_unit: '顆', times: ['08:00'], freq_type: 'daily',
    weekdays: [1, 2, 3, 4, 5], interval_days: 2, start_date: today, end_date: '', note: '', notify: true, stock: '', restock_threshold: '',
  };
  if (!v.weekdays) v.weekdays = [1, 2, 3, 4, 5];
  if (!v.interval_days) v.interval_days = 2;

  const body = `<form id="medf" novalidate>
    <div class="field photo-pick">
      <span id="ph">${thumb(v)}</span>
      <div><label class="btn btn-soft" for="photo" style="min-height:40px">選擇照片</label>
        <input type="file" id="photo" accept="image/*" class="sr-only">
        <button type="button" class="btn btn-ghost" id="rmph" ${v.photo ? '' : 'hidden'}>移除</button>
        <p class="hint" style="margin:6px 2px 0">拍下瓶身，比較不會拿錯</p></div>
    </div>
    <div class="field"><label for="name">名稱</label><input class="input" id="name" maxlength="40" value="${esc(v.name)}" placeholder="例如：維他命 D、血壓藥" autocomplete="off"></div>
    <div class="field"><span class="label">分類</span><div class="seg" id="cat">${Object.entries(CATS).map(([k, l]) => `<button type="button" data-v="${k}" aria-pressed="${v.category === k}">${l}</button>`).join('')}</div></div>
    <div class="field"><span class="label">每次用量</span>
      <div class="row"><input class="input" id="amt" type="number" inputmode="decimal" min="0" step="any" value="${esc(v.dose_amount ?? '')}" placeholder="數量" aria-label="數量" style="flex:.8">
      <input class="input" id="unit" list="units" maxlength="10" value="${esc(v.dose_unit)}" placeholder="單位" aria-label="單位"></div>
      <datalist id="units">${UNITS.map((u) => `<option value="${u}">`).join('')}</datalist></div>
    <div class="field"><span class="label">服用時間</span><div id="times"></div>
      <button type="button" class="btn btn-soft" id="addtime" style="min-height:40px">${ICON.plus.replace('<svg', '<svg width="16" height="16"')}再加一個時間</button></div>
    <div class="field"><span class="label">頻率</span>
      <div class="seg" id="freq">${[['daily', '每天'], ['weekly', '指定星期'], ['interval', '間隔天數']].map(([k, l]) => `<button type="button" data-v="${k}" aria-pressed="${v.freq_type === k}">${l}</button>`).join('')}</div>
      <div id="freqx" style="margin-top:10px"></div></div>
    <div class="field"><div class="row">
      <div><label for="sd">開始日期</label><input class="input" type="date" id="sd" value="${esc(v.start_date)}"></div>
      <div><label for="ed">結束日期</label><input class="input" type="date" id="ed" value="${esc(v.end_date || '')}"></div></div>
      <p class="hint">結束日期可留空（長期服用）</p></div>
    <div class="field"><label for="note">備註</label>
      <div class="chips" id="notechips" style="margin-bottom:8px">${NOTE_PRESETS.map((n) => `<button type="button" class="chip" data-n="${n}">${n}</button>`).join('')}</div>
      <input class="input" id="note" maxlength="100" value="${esc(v.note)}" placeholder="例如：飯後、配溫水"></div>
    <div class="card" style="padding:4px 16px;margin-bottom:18px">
      <label class="switch-row"><span><span class="t">開啟提醒通知</span><br><span class="d">時間到會推播提醒</span></span><input type="checkbox" class="switch" id="notify" ${v.notify ? 'checked' : ''}></label></div>
    <div class="field"><span class="label">庫存（選填）</span>
      <div class="row"><div><input class="input" id="stock" type="number" inputmode="decimal" min="0" step="any" value="${esc(v.stock ?? '')}" placeholder="剩餘數量" aria-label="剩餘數量"></div>
      <div><input class="input" id="thr" type="number" inputmode="decimal" min="0" step="any" value="${esc(v.restock_threshold ?? '')}" placeholder="剩幾個時提醒" aria-label="補貨提醒數量"></div></div>
      <p class="hint">每次記錄「已服用」會自動扣除用量；低於提醒數量時會通知你補貨。</p></div>
    <div class="disclaimer">用量與服用方式請依醫師或藥師指示設定。這個 App 只負責提醒與紀錄，不提供用藥建議；漏服或身體不適時，請詢問醫師或藥師。</div>
    ${isEdit ? `<div class="action-list" style="margin-bottom:8px">
      <button type="button" class="btn btn-soft" id="pause">${v.paused ? '恢復這個項目' : '暫停這個項目'}</button>
      <button type="button" class="btn btn-blush" id="del">刪除這個項目</button></div>` : ''}
    <p class="form-error" id="ferr" role="alert"></p>
  </form>`;

  openSheet(isEdit ? '編輯項目' : '新增項目', body, (sheet, close) => {
    const f = $('#medf', sheet);
    const segBind = (id, key, after) => $(`#${id}`, sheet).onclick = (e) => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      v[key] = b.dataset.v;
      $(`#${id}`, sheet).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      after?.();
    };
    const drawTimes = () => {
      $('#times', sheet).innerHTML = v.times.map((t, i) => `<div class="time-row">
        <input class="input" type="time" value="${esc(t)}" data-i="${i}" aria-label="服用時間 ${i + 1}" required>
        <span class="slot-label">${SLOTS.find((s) => s.id === slotOf(t || '08:00')).label}</span>
        ${v.times.length > 1 ? `<button type="button" class="icon-btn" data-rm="${i}" aria-label="移除這個時間" style="width:40px;height:40px">${ICON.close}</button>` : ''}
      </div>`).join('');
    };
    const drawFreq = () => {
      const x = $('#freqx', sheet);
      if (v.freq_type === 'weekly') x.innerHTML = `<div class="chips">${WEEK.map((w, i) => `<button type="button" class="chip round" data-w="${i}" aria-pressed="${v.weekdays.includes(i)}" aria-label="星期${w}">${w}</button>`).join('')}</div>`;
      else if (v.freq_type === 'interval') x.innerHTML = `<div class="row" style="align-items:center"><span style="flex:none">每</span><input class="input" type="number" id="iv" min="2" max="90" value="${esc(v.interval_days)}" style="flex:none;width:90px;text-align:center"><span>天一次（從開始日期算起）</span></div>`;
      else x.innerHTML = '';
    };
    drawTimes(); drawFreq();
    segBind('cat', 'category', () => { if (!v.photo) $('#ph', sheet).innerHTML = thumb(v); });
    segBind('freq', 'freq_type', drawFreq);
    $('#times', sheet).oninput = (e) => { const i = e.target.dataset.i; if (i != null) { v.times[i] = e.target.value; e.target.nextElementSibling.textContent = SLOTS.find((s) => s.id === slotOf(e.target.value || '08:00')).label; } };
    $('#times', sheet).onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { v.times.splice(Number(b.dataset.rm), 1); drawTimes(); } };
    $('#addtime', sheet).onclick = () => {
      if (v.times.length >= 8) return toast('每天最多 8 個時間', { error: true });
      const last = v.times.at(-1) || '08:00';
      v.times.push(fmtMin(Math.min(toMin(last) + 240, 23 * 60))); drawTimes();
    };
    $('#freqx', sheet).onclick = (e) => {
      const b = e.target.closest('[data-w]'); if (!b) return;
      const d = Number(b.dataset.w);
      v.weekdays = v.weekdays.includes(d) ? v.weekdays.filter((x) => x !== d) : [...v.weekdays, d];
      b.setAttribute('aria-pressed', v.weekdays.includes(d));
    };
    $('#notechips', sheet).onclick = (e) => {
      const b = e.target.closest('[data-n]'); if (!b) return;
      const n = $('#note', sheet);
      const parts = n.value.split(/[、,，\s]+/).filter(Boolean);
      n.value = parts.includes(b.dataset.n) ? parts.filter((p) => p !== b.dataset.n).join('、') : [...parts, b.dataset.n].join('、');
    };
    $('#photo', sheet).onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try { v.photo = await resizeImage(file); $('#ph', sheet).innerHTML = thumb(v); $('#rmph', sheet).hidden = false; } catch (err) { fail(err); }
    };
    $('#rmph', sheet).onclick = () => { v.photo = null; $('#ph', sheet).innerHTML = thumb(v); $('#rmph', sheet).hidden = true; };

    const save = async () => {
      const payload = {
        name: $('#name', sheet).value, category: v.category, photo: v.photo,
        dose_amount: $('#amt', sheet).value, dose_unit: $('#unit', sheet).value,
        times: v.times.filter(Boolean), freq_type: v.freq_type, weekdays: v.weekdays,
        interval_days: Number($('#iv', sheet)?.value || v.interval_days),
        start_date: $('#sd', sheet).value, end_date: $('#ed', sheet).value || null,
        note: $('#note', sheet).value, notify: $('#notify', sheet).checked,
        stock: $('#stock', sheet).value, restock_threshold: $('#thr', sheet).value,
      };
      const err = $('#ferr', sheet);
      err.textContent = '';
      const btn = sheet.querySelector('[data-save]');
      btn.disabled = true;
      try {
        if (isEdit) await api('PATCH', `/api/meds/${med.id}`, payload);
        else await api('POST', '/api/meds', payload);
        close();
        toast(isEdit ? '已儲存變更' : '新增好了 🌱');
        await refreshData(); route();
        if (!isEdit && payload.notify && !pushSupport().subscribed && !sessionStorageGet('push-asked')) {
          sessionStorageSet('push-asked', '1');
          setTimeout(() => { if (!document.querySelector('.sheet')) pushGuideSheet(); }, 500);
        }
      } catch (e) { err.textContent = e.message; err.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      finally { btn.disabled = false; }
    };
    f.onsubmit = (e) => { e.preventDefault(); save(); };
    sheet.querySelector('[data-save]').onclick = save;
    if (isEdit) {
      $('#pause', sheet).onclick = async () => {
        try {
          await api('POST', `/api/meds/${med.id}/pause`, { paused: !med.paused });
          close(); toast(med.paused ? '已恢復，會重新提醒' : '已暫停，暫時不會出現在今天的清單'); await refreshData(); route();
        } catch (e) { fail(e); }
      };
      $('#del', sheet).onclick = () => { close(); confirmSheet('刪除這個項目？', `「${med.name}」之後不會再提醒。過去的打卡紀錄會保留在日曆中。`, '刪除', async () => {
        await api('DELETE', `/api/meds/${med.id}`); toast('已刪除'); await refreshData(); route();
      }); };
    }
  }, `<button class="btn btn-soft" data-close-foot>取消</button><button class="btn btn-primary" data-save>${isEdit ? '儲存' : '新增'}</button>`);
  const foot = document.querySelector('[data-close-foot]');
  if (foot) foot.onclick = () => document.querySelector('.sheet [data-close]').click();
}

// ---------- 推播通知 ----------
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushState = { subscribed: false, endpoint: null, error: null };

function pushSupport() {
  const checks = [
    { ok: window.isSecureContext, label: '使用安全連線（HTTPS）', fix: '請用 https:// 開頭的網址開啟' },
    { ok: 'serviceWorker' in navigator, label: '瀏覽器支援背景程式（Service Worker）', fix: '請改用最新版 Chrome、Safari、Edge 或 Firefox' },
    { ok: 'PushManager' in window && 'Notification' in window, label: '瀏覽器支援推播通知', fix: isIOS() ? (isStandalone() ? '需要 iOS 16.4 以上，請更新系統' : '在 iPhone 上，需要先「加入主畫面」再從主畫面開啟') : '這個瀏覽器不支援推播，請改用 Chrome、Edge、Firefox 或 Safari' },
  ];
  if (isIOS()) checks.splice(2, 0, { ok: isStandalone(), label: '已從主畫面開啟（iPhone 必要條件）', fix: '請依下方步驟加入主畫面，再從主畫面的圖示開啟' });
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  checks.push({ ok: perm === 'granted', label: '已允許通知權限', fix: perm === 'denied' ? '你先前選擇了「不允許」，需要到系統或瀏覽器設定中重新允許（見下方說明）' : '按下方「開啟通知」並選擇「允許」' });
  checks.push({ ok: pushState.subscribed, label: '這台裝置已登記接收提醒', fix: pushState.error || '按下方「開啟通知」' });
  return { checks, perm, subscribed: pushState.subscribed, canTry: checks.slice(0, isIOS() ? 4 : 3).every((c) => c.ok) && perm !== 'denied' };
}

function b64ToBytes(b64) { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }

const swReady = (ms = 4000) => Promise.race([
  navigator.serviceWorker.ready,
  new Promise((_, rej) => setTimeout(() => rej(new Error('背景程式（Service Worker）尚未啟動，請重新整理頁面')), ms)),
]);

async function syncPushState() {
  pushState.subscribed = false;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) return;
  try {
    const reg = await swReady();
    const sub = await reg.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
      const { publicKey } = await api('GET', '/api/push/public-key');
      const cur = sub.options?.applicationServerKey ? btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : publicKey;
      if (cur !== publicKey) { await sub.unsubscribe(); return; } // 伺服器金鑰換了 → 需重新訂閱
      await api('POST', '/api/push/subscribe', sub.toJSON()); // 確保伺服器端與此裝置同步（例如換帳號登入）
      pushState.subscribed = true; pushState.endpoint = sub.endpoint;
    }
  } catch (e) { pushState.error = e.message; }
}

async function enablePush() {
  const s = pushSupport();
  if (!s.canTry) throw new Error(s.checks.find((c) => !c.ok)?.fix || '這台裝置目前無法開啟通知');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? '你選擇了不允許通知。需要提醒的話，請到設定中重新允許。' : '還沒有允許通知');
  const reg = await swReady(10000);
  const { publicKey } = await api('GET', '/api/push/public-key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }); }
    catch (e) { pushState.error = '推播服務登記失敗：' + (e.message || e.name); throw new Error(pushState.error); }
  }
  await api('POST', '/api/push/subscribe', sub.toJSON());
  pushState.subscribed = true; pushState.endpoint = sub.endpoint; pushState.error = null;
}

async function disablePush() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await swReady();
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  pushState.subscribed = false;
}

function iosGuide() {
  return `<ol class="steps">
    <li><span>用 <b>Safari</b> 開啟這個網址（其他 App 內建的瀏覽器無法加入主畫面）</span></li>
    <li><span>點下方的分享按鈕 ${ICON.share}</span></li>
    <li><span>往下滑，選擇「加入主畫面」${ICON.addsq}</span></li>
    <li><span>回到主畫面，點「今天吃了嗎？」圖示開啟</span></li>
    <li><span>到「設定」按「開啟通知」，選擇「允許」</span></li>
  </ol><p class="note-soft">需要 iOS 16.4 以上。若之前按過「不允許」：到 iPhone「設定」→「通知」→「今天吃了嗎？」重新開啟。</p>`;
}

function pushGuideSheet() {
  const s = pushSupport();
  const deniedHelp = s.perm === 'denied' ? `<div class="banner" style="margin-top:4px"><div><b>通知權限被關閉了</b>${isIOS() ? 'iPhone「設定」→「通知」→「今天吃了嗎？」→ 允許通知' : '點網址列左側的圖示 →「通知」→ 改成「允許」，再重新整理頁面'}</div></div>` : '';
  openSheet('開啟提醒通知', `
    <p style="margin-top:0">開啟後，就算關掉 App，時間到了手機也會跳出提醒。</p>
    <ul class="diag">${s.checks.map((c) => `<li class="${c.ok ? 'ok' : 'no'}"><span class="ic">${c.ok ? '✓' : '!'}</span><span>${esc(c.label)}${c.ok ? '' : `<br><small style="color:var(--ink-2)">${esc(c.fix)}</small>`}</span></li>`).join('')}</ul>
    ${deniedHelp}
    ${isIOS() && !isStandalone() ? `<h3 style="font-size:16px;margin:16px 0 0">iPhone 加入主畫面步驟</h3>${iosGuide()}` : ''}
    <p class="form-error" id="perr" role="alert"></p>
    ${s.subscribed ? '<button class="btn btn-soft btn-block" id="ptest">傳送一則測試通知</button>'
      : `<button class="btn btn-primary btn-block" id="pon" ${s.canTry ? '' : 'disabled'}>開啟通知</button>`}
    <h3 style="font-size:15px;margin:22px 0 4px">無法開啟通知的話</h3>
    <p class="note-soft" style="margin-top:0">可以把提醒匯入手機行事曆（內含鬧鐘提示），或每天打開 App 查看「今天」頁面。</p>
    <a class="btn btn-soft btn-block" href="/api/reminders.ics" download>下載行事曆提醒（.ics）</a>`, (sheet, close) => {
    const err = $('#perr', sheet);
    const on = $('#pon', sheet);
    if (on) on.onclick = async () => {
      on.disabled = true; err.textContent = '';
      try { await enablePush(); close(); toast('通知已開啟 🔔'); rerender(); await api('POST', '/api/push/test').catch(() => {}); }
      catch (e) { err.textContent = e.message; on.disabled = false; }
    };
    const t = $('#ptest', sheet);
    if (t) t.onclick = async () => {
      try { await api('POST', '/api/push/test'); toast('已送出，請看看通知'); } catch (e) { err.textContent = e.message; }
    };
  });
}

async function closeNotificationsFor(date, time) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const list = await reg?.getNotifications({ tag: `dose-${date}-${time}` });
    const stillPending = state.day?.date === date && state.day.doses.some((d) => d.time === time && !d.status);
    if (!stillPending) list?.forEach((n) => n.close());
  } catch { /* 不支援時略過 */ }
}

// ---------- 設定 ----------
function renderSettings() {
  const st = state.me.settings;
  const s = pushSupport();
  const devTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = [...new Set([st.timezone, devTz, 'Asia/Taipei', 'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Sydney', 'Europe/London', 'America/Los_Angeles', 'America/New_York'].filter(Boolean))];
  const today = localNow().date;
  root.innerHTML = shell('settings', `
    <header class="topbar"><div><p class="sub">${esc(state.me.email)}</p><h1>設定</h1></div></header>

    <section class="group"><h2>提醒通知</h2><div class="card">
      <div class="set-row"><div><div class="t">這台裝置的通知</div><div class="d">${s.subscribed ? '已開啟' : s.perm === 'denied' ? '權限被關閉' : '尚未開啟'}・帳號共 ${state.me.push_devices} 台裝置</div></div>
        ${s.subscribed ? '<button class="btn btn-soft" data-a="push-off">關閉</button>' : '<button class="btn btn-primary" data-a="push-guide">開啟</button>'}</div>
      ${s.subscribed ? '<div class="set-row"><div class="t">測試通知</div><button class="btn btn-soft" data-a="push-test">傳送</button></div>' : ''}
      <div class="set-row"><div><div class="t">沒確認時再提醒</div><div class="d">直到按下「已服用」或「略過」</div></div>
        <select class="input" data-set="repeat_count" aria-label="再提醒次數">${[0, 1, 2, 3, 5].map((n) => `<option value="${n}" ${st.repeat_count === n ? 'selected' : ''}>${n ? n + ' 次' : '不再提醒'}</option>`).join('')}</select></div>
      <div class="set-row"><div class="t">再提醒間隔</div>
        <select class="input" data-set="repeat_minutes" aria-label="再提醒間隔">${[5, 10, 15, 30, 60].map((n) => `<option value="${n}" ${st.repeat_minutes === n ? 'selected' : ''}>${n} 分鐘</option>`).join('')}</select></div>
      <label class="set-row"><div><div class="t">通知中隱藏項目名稱</div><div class="d">鎖定畫面不顯示藥名，保護隱私</div></div><input type="checkbox" class="switch" data-set="hide_names" ${st.hide_names ? 'checked' : ''}></label>
      <div class="set-row"><div><div class="t">時區</div><div class="d">提醒時間依這個時區計算</div></div>
        <select class="input" data-set="timezone" aria-label="時區" style="max-width:52%">${zones.map((z) => `<option ${z === st.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div>
      <div class="set-row"><div><div class="t">iPhone 設定教學</div><div class="d">加入主畫面與開啟通知</div></div><button class="btn btn-soft" data-a="ios">查看</button></div>
      <div class="set-row"><div><div class="t">匯入手機行事曆</div><div class="d">無法使用推播時的替代方式</div></div><a class="btn btn-soft" href="/api/reminders.ics" download>下載</a></div>
    </div></section>

    <section class="group"><h2>紀錄</h2><div class="card">
      <div class="set-row stack"><div class="t">匯出服用紀錄（CSV，可用 Excel 開啟）</div>
        <div class="row" style="margin-top:8px"><input class="input" type="date" id="exf" value="${addDays(today, -29)}" aria-label="開始日期"><input class="input" type="date" id="ext" value="${today}" aria-label="結束日期"></div>
        <button class="btn btn-soft" data-a="export" style="margin-top:10px">匯出</button></div>
    </div></section>

    <section class="group"><h2>帳號與隱私</h2><div class="card">
      <div class="set-row"><div><div class="t">名稱</div><div class="d">${esc(state.me.display_name || '未設定')}</div></div></div>
      <div class="set-row"><div class="t">登出</div><button class="btn btn-soft" data-a="logout">登出</button></div>
      <div class="set-row"><div><div class="t">刪除帳號</div><div class="d">永久刪除所有項目與紀錄</div></div><button class="btn btn-blush" data-a="delete">刪除</button></div>
    </div>
    <p class="note-soft">你的項目與紀錄只有你登入的帳號看得到。這個 App 只負責提醒與紀錄，不提供用藥建議；如有疑問請詢問醫師或藥師。</p></section>`);

  const main = $('#main');
  main.onchange = async (e) => {
    const k = e.target.dataset.set; if (!k) return;
    const val = e.target.type === 'checkbox' ? e.target.checked : (k === 'timezone' ? e.target.value : Number(e.target.value));
    try { state.me.settings = await api('PATCH', '/api/settings', { [k]: val }); toast('已儲存'); } catch (err) { fail(err); renderSettings(); }
  };
  main.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    try {
      if (a === 'push-guide') pushGuideSheet();
      else if (a === 'push-off') { await disablePush(); toast('這台裝置不再接收通知'); await refreshMe(); renderSettings(); }
      else if (a === 'push-test') { await api('POST', '/api/push/test'); toast('已送出，請看看通知'); }
      else if (a === 'ios') openSheet('iPhone 設定教學', iosGuide());
      else if (a === 'export') {
        const f = $('#exf').value, t = $('#ext').value;
        if (!f || !t || f > t) return toast('請選擇正確的日期區間', { error: true });
        location.href = `/api/export.csv?from=${f}&to=${t}`;
      } else if (a === 'logout') {
        confirmSheet('要登出嗎？', '登出後，這台裝置將不再收到提醒通知。', '登出', async () => {
          await disablePush().catch(() => {});
          await api('POST', '/api/auth/logout'); state.me = null; renderAuth();
        }, false);
      } else if (a === 'delete') deleteAccountSheet();
    } catch (err) { fail(err); }
  };
}

function deleteAccountSheet() {
  openSheet('永久刪除帳號', `<p style="margin-top:0">所有項目、照片、打卡紀錄與通知設定都會被永久刪除，無法復原。</p>
    <div class="field"><label for="dpw">輸入密碼確認</label><input class="input" type="password" id="dpw" autocomplete="current-password"></div>
    <p class="form-error" id="derr" role="alert"></p>`, (s, close) => {
    s.querySelector('[data-ok]').onclick = async () => {
      try {
        await disablePush().catch(() => {});
        await api('DELETE', '/api/me', { password: $('#dpw', s).value });
        close(); state.me = null; renderAuth(); toast('帳號已刪除');
      } catch (e) { $('#derr', s).textContent = e.message; }
    };
    s.querySelector('[data-cancel]').onclick = close;
  }, '<button class="btn btn-soft" data-cancel>取消</button><button class="btn btn-blush" data-ok>永久刪除</button>');
}

// ---------- 登入／註冊 ----------
function renderAuth(mode = 'login') {
  root.innerHTML = `<main class="auth view">
    <div class="auth-hero">${potEmpty}<h1>今天吃了嗎？</h1><p>溫柔提醒，陪你養成照顧自己的習慣</p></div>
    <div class="seg" id="amode" style="margin-bottom:18px">
      <button type="button" data-m="login" aria-pressed="${mode === 'login'}">登入</button>
      <button type="button" data-m="register" aria-pressed="${mode === 'register'}">建立帳號</button></div>
    <form id="authf" novalidate>
      ${mode === 'register' ? '<div class="field"><label for="dn">怎麼稱呼你（選填）</label><input class="input" id="dn" maxlength="20" autocomplete="nickname"></div>' : ''}
      <div class="field"><label for="em">Email</label><input class="input" id="em" type="email" autocomplete="email" inputmode="email" required></div>
      <div class="field"><label for="pw">密碼</label><input class="input" id="pw" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="8" required>
        ${mode === 'register' ? '<p class="hint">至少 8 個字元</p>' : ''}</div>
      <p class="form-error" id="aerr" role="alert"></p>
      <button class="btn btn-primary btn-block" type="submit">${mode === 'login' ? '登入' : '建立帳號'}</button>
    </form>
    <p class="privacy-note">你的保健與用藥紀錄只屬於你，<br>其他使用者無法看到。</p>
  </main><div id="toasts" class="toast-wrap"></div>`;
  $('#amode').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) renderAuth(b.dataset.m); };
  $('#authf').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]'); btn.disabled = true;
    try {
      const body = { email: $('#em').value, password: $('#pw').value };
      if (mode === 'register') Object.assign(body, { display_name: $('#dn').value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      await api('POST', `/api/auth/${mode}`, body);
      await boot();
    } catch (err) { $('#aerr').textContent = err.message; btn.disabled = false; }
  };
}

// ---------- 路由 ----------
async function refreshMe() { state.me = await api('GET', '/api/me'); }
async function refreshData() { [state.meds] = await Promise.all([api('GET', '/api/meds'), refreshMe()]); }

function ensureToasts() { if (!$('#toasts')) document.body.insertAdjacentHTML('beforeend', '<div id="toasts" class="toast-wrap"></div>'); }

function rerender(animate) {
  const tab = (location.hash.slice(2) || 'today').split('?')[0];
  if (tab === 'today' && state.day) renderToday({ animate });
}

async function route() {
  if (!state.me) return;
  ensureToasts();
  const [tab, qs] = (location.hash.slice(2) || 'today').split('?');
  const params = new URLSearchParams(qs || '');
  try {
    if (tab === 'calendar') await renderCalendar();
    else if (tab === 'items') { renderItems(); if (params.get('new')) { history.replaceState(null, '', '#/items'); medForm(); } }
    else if (tab === 'settings') renderSettings();
    else {
      const date = params.get('date') && params.get('date') <= localNow().date ? params.get('date') : localNow().date;
      await loadDay(date);
      state.lastComplete = state.day.doses.length ? state.day.doses.every((d) => d.status) && state.day.doses.some((d) => d.status === 'taken') : null;
      renderToday();
    }
    window.scrollTo(0, 0);
  } catch (e) { fail(e); }
}

async function boot() {
  try {
    await refreshData();
  } catch (e) {
    if (!state.me) { if (!/登入/.test(e.message)) renderAuthWithError(e); return; }
  }
  // 從通知點進來：/?date=YYYY-MM-DD
  const qd = new URLSearchParams(location.search).get('date');
  if (qd) { history.replaceState(null, '', `/#/today?date=${qd}`); }
  await syncPushState();
  route();
}

function renderAuthWithError(e) {
  root.innerHTML = `<main class="auth"><div class="empty">${potEmpty}<h2>暫時連不上</h2><p>${esc(e.message)}</p><button class="btn btn-primary" id="retry">重新連線</button></div></main>`;
  $('#retry').onclick = boot;
}

window.addEventListener('hashchange', route);
// 回到 App 時更新（例如跨過午夜、或從通知按了「已服用」）
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.me && !document.querySelector('.sheet')) route(); });
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'doses-updated' && state.me) route(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => { pushState.error = 'Service Worker 註冊失敗：' + e.message; });
boot();
