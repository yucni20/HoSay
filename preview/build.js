// 產生單一檔案的預覽版 HTML：node preview/build.js > preview/preview.html
const fs = require('fs');
const path = require('path');
const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

let app = pub('app.js');
const swap = (from, to) => { if (!app.includes(from)) throw new Error('build: pattern not found: ' + from.slice(0, 60)); app = app.replace(from, to); };
swap("if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')", "if (false) navigator.serviceWorker.register('/sw.js')");
swap('async function syncPushState() {', 'async function syncPushState() { return;');
swap('async function enablePush() {', "async function enablePush() { throw new Error('這是預覽版，無法開啟真正的通知。部署到正式網址後就能使用。');");
swap('location.href = `/api/export.csv?from=${f}&to=${t}`;', "toast('預覽版無法下載檔案，正式版才可以');");
swap("const fail = (e) =>", "window.__previewToast = (m) => toast(m);\nconst fail = (e) =>");

const css = pub('styles.css') + `
.preview-bar { background: var(--sage-deep); color: #fff; font-family: var(--font); font-size: 13px; line-height: 1.5;
  padding: 8px max(16px, env(safe-area-inset-right, 0px)) 8px max(16px, env(safe-area-inset-left, 0px));
  display: flex; gap: 10px; align-items: center; justify-content: center; flex-wrap: wrap; text-align: center; }
.preview-bar button { color: #fff; text-decoration: underline; text-underline-offset: 3px; font-size: 13px; }
`;

const html = `<title>今天吃了嗎？</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Huninn&display=swap">
<style>${css}</style>
<div class="preview-bar" role="note"><span>預覽版・示範資料，不會發送通知</span><button type="button" id="preview-reset">重設示範資料</button></div>
<div id="root"><div class="boot" aria-live="polite">載入中…</div></div>
<script>${fs.readFileSync(path.join(__dirname, 'mock.js'), 'utf8')}</script>
<script>${app}</script>
`;
process.stdout.write(html);
