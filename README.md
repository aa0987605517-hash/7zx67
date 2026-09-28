# 腳本上傳伺服器

純 Node.js 寫的最小化腳本代管服務，不依賴任何第三方套件、不蒐集使用者個資。

## 功能

- `GET /` — 貼上腳本的前端頁面
- `POST /api/upload` — 接收 `{ "code": "..." }`，存成檔案，回傳 `{ id, rawUrl }`
- `GET /s/:id` — 以純文字回傳腳本內容（給 `loadstring(game:HttpGet(url))()` 使用）

腳本檔案存在 `scripts/` 資料夾內，每個檔案就是您貼上的原始內容，沒有任何額外處理或追蹤。

## 本機測試

```bash
cd server
node server.js
```

預設監聽 `http://localhost:3000`，可用 `PORT` 環境變數更改埠號：

```bash
PORT=8080 node server.js
```

## 部署到您自己的主機

1. 把整個 `server/` 資料夾上傳到您的主機
2. 在主機上執行 `node server.js`（建議用 `pm2` 或 `systemd` 讓它常駐）
3. 用 nginx（或您慣用的反向代理）把網域指到這個埠號，並套用 HTTPS
4. 之後貼上腳本產生的連結，就會是 `https://您的網域/s/xxxx`，可直接被執行器讀取

## 注意事項

- 目前沒有身分驗證，任何知道網址的人都能上傳腳本 — 如果不想公開讓任何人上傳，建議之後加一個簡單的密碼或 API Key 驗證
- 單次腳本內容上限 200KB（可在 `server.js` 的 `MAX_BODY_BYTES` 調整）
- 沒有自動清除機制，腳本會一直留在 `scripts/` 資料夾，請自行視需要清理
