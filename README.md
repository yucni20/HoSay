# 今天吃了嗎？— 健康提醒打卡 PWA（第一階段）

溫柔提醒你吃保健食品與藥物的打卡小幫手。手機優先、可加入主畫面、真正的 Web Push 推播與後端排程。

**零外部套件**：只用 Node.js 內建功能（`node:sqlite`、`node:crypto`、`node:http`），不需要 `npm install`。

## 快速開始

```bash
# 需要 Node.js 22.13 以上
VAPID_SUBJECT=mailto:你的信箱 PORT=3000 npm start
# 開啟 http://localhost:3000
```

推播只能在 **HTTPS** 網址（或 localhost）運作，正式使用請部署到有 HTTPS 的主機。

## 部署（任選一個有「持久磁碟」的 Node 主機）

資料存在 SQLite 檔案中，主機必須提供**持久儲存**，否則重新部署會遺失資料。

| 平台 | 設定 |
|---|---|
| Railway | 新增 Volume 掛載到 `/data`，環境變數 `DB_FILE=/data/app.db` |
| Fly.io | `fly volumes create data`，掛載到 `/data`，`DB_FILE=/data/app.db` |
| Render | 付費方案加 Disk 掛載到 `/data`，`DB_FILE=/data/app.db` |
| 自己的 VPS | 用 Caddy / Nginx 提供 HTTPS 反向代理 |

環境變數：

| 變數 | 說明 |
|---|---|
| `VAPID_SUBJECT` | **必填**，例如 `mailto:you@example.com`，推播服務用來聯絡你 |
| `DB_FILE` | 資料庫路徑，預設 `./data/app.db` |
| `PORT` | 預設 3000 |
| `TRUST_PROXY=1` | 在反向代理（Railway/Fly/Render/Nginx）後面時設定，才能正確判斷 HTTPS 與 IP |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 選填。未設定時首次啟動自動產生並存入資料庫。**換金鑰會讓所有裝置需重新開啟通知** |

只能跑**單一個執行個體**（排程與防重複通知依賴同一個資料庫檔）。

## 測試

```bash
npm test                              # 排程規則、API、權限隔離、推播排程（5 組測試）
python3 test/interop/verify_push.py   # 用獨立的 Python 加密庫解開推播內容、驗證 VAPID 簽章
PORT=3100 npm start & python3 test/e2e/e2e.py   # Playwright 手機尺寸端對端測試＋截圖
```

## 架構

```
server.js            HTTP 路由、靜態檔、安全標頭、CSRF 檢查
lib/schedule.js      排程規則（每天／指定星期／間隔天數、時段分類、時區）
lib/service.js       業務邏輯（所有查詢都以 user_id 限定）
lib/scheduler.js     推播排程（每 20 秒掃描）
lib/webpush.js       Web Push 加密（RFC 8291）與 VAPID（RFC 8292）
lib/auth.js          scrypt 密碼雜湊、HttpOnly Session Cookie、登入次數限制
lib/db.js            SQLite 資料表
public/              前端 PWA（app.js、styles.css、sw.js、manifest）
```

### 提醒規則
- 準時提醒一次；未確認時依設定間隔再提醒（0–5 次）
- 按「已服用」或「略過」後，同一劑次不再提醒，並關閉手機上的同時段通知
- 同一時間的多個項目**合併成一則通知**
- 每則通知有唯一鍵記錄於資料庫，伺服器重啟或多次掃描都不會重複發送
- 錯過超過 20 分鐘的提醒不補送（避免停機後一次湧入舊通知）
- 「稍後提醒」期間不打擾，到期提醒一次
- 時間依使用者設定的時區計算；裝置時區不同時，首頁會詢問是否更新
- 通知上有「已服用」「10 分鐘後提醒」按鈕（Android/桌面；iPhone 不支援通知按鈕，點通知會開啟 App）
- 可選擇在通知中隱藏項目名稱

### 安全與隱私
- 密碼以 scrypt 雜湊；Session 只存雜湊值；Cookie 為 HttpOnly + SameSite=Lax（HTTPS 時加 Secure）
- 所有寫入請求需自訂標頭且來源一致（CSRF 防護）
- 每個查詢都限定在登入者自己的資料；測試涵蓋「B 使用者讀不到、改不了 A 的資料」
- 推播端點只接受 Google / Mozilla / Apple / Microsoft 的推播服務網址
- 個人資料 API 不經 Service Worker 快取
- 可永久刪除帳號（連同所有紀錄與照片）

### 用藥安全
- 不提供劑量建議、補服建議或停藥建議，表單中明確提示依醫囑設定
- 同一劑次只會有一筆紀錄，重複按「已服用」不會重複計算，也沒有任何鼓勵多吃的獎勵
- 未打卡顯示為「未確認」，不推定為沒服用；可在日曆補登實際時間

## 狀態

### ✅ 第一階段已完成
帳號、首頁打卡、新增／編輯／暫停／刪除、照片、多時段、三種頻率、起訖日、備註、庫存自動扣除與補貨通知、Web Push 推播與後端排程、Service Worker 離線外殼、PWA Manifest、通知診斷與 iPhone 教學、行事曆（.ics）替代方案、打卡日曆與補登、CSV 匯出、完成動畫與鼓勵語。

### ⚠️ 尚未在真實手機上驗證
開發環境無法連到 Google／Apple 的推播伺服器，因此**實際推播送達手機**這一步還沒驗證過。已驗證的部分：加密與簽章（獨立 Python 實作解密成功）、排程邏輯（自動化測試）、瀏覽器端註冊 Service Worker 與通知權限流程。部署到 HTTPS 後請用「設定 → 傳送測試通知」確認。

### 🔜 第二階段（尚未實作）
健康小花園、成就徽章、連續天數與每週統計、家庭成員切換（資料表已預留 `profiles`）、成就分享卡片、忘記密碼（需要寄信服務）、修改顯示名稱。
