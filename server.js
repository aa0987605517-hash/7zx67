// 極簡腳本代管伺服器：
// - POST /api/upload        { code: "..." }  -> { id, rawUrl }
// - GET  /7zx67/:id                          -> 純文字回傳腳本內容（供執行器 loadstring/HttpGet 使用）
// - GET  /                             -> 貼上腳本的前端頁面
//
// 部署：node server.js（預設監聽 PORT 環境變數或 3000）
// 請自行在您的主機上設定網域、反向代理（nginx）與 HTTPS。

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROUTE_PREFIX = "7zx67"; // 連結路徑前綴，例如 /7zx67/xxxx
const SCRIPTS_DIR = path.join(__dirname, "scripts");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 200 * 1024; // 200KB 上限，避免濫用

if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

function safeId() {
  return crypto.randomBytes(6).toString("base64url");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 貼上腳本的前端頁面
  if (req.method === "GET" && url.pathname === "/") {
    serveStatic(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    return;
  }

  // 上傳腳本
  if (req.method === "POST" && url.pathname === "/api/upload") {
    let size = 0;
    const chunks = [];
    let aborted = false;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        sendJson(res, 413, { error: "腳本內容過大（上限 200KB）" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendJson(res, 400, { error: "請求格式錯誤，需為 JSON" });
        return;
      }

      const code = payload && payload.code;
      if (typeof code !== "string" || code.trim().length === 0) {
        sendJson(res, 400, { error: "腳本內容不可為空" });
        return;
      }

      const id = safeId();
      const filePath = path.join(SCRIPTS_DIR, `${id}.lua`);
      fs.writeFile(filePath, code, "utf8", (err) => {
        if (err) {
          sendJson(res, 500, { error: "儲存失敗" });
          return;
        }
        const proto = req.headers["x-forwarded-proto"] || url.protocol.replace(":", "");
        const rawUrl = `${proto}://${req.headers.host}/${ROUTE_PREFIX}/${id}`;
        sendJson(res, 200, { id, rawUrl });
      });
    });
    return;
  }

  // 讀取腳本原始內容
  const match = url.pathname.match(
    new RegExp(`^/${ROUTE_PREFIX}/([A-Za-z0-9_-]+)$`)
  );
  if (req.method === "GET" && match) {
    // Roblox 執行器的 HttpGet/HttpService 請求 User-Agent 帶有 "Roblox"，
    // 一般瀏覽器直接打開連結不會有這個字樣，藉此擋掉瀏覽器直接檢視原始碼。
    const ua = (req.headers["user-agent"] || "").toLowerCase();
    if (!ua.includes("roblox")) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const id = match[1];
    const filePath = path.join(SCRIPTS_DIR, `${id}.lua`);
    fs.readFile(filePath, "utf8", (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("找不到這個腳本");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`腳本代管伺服器已啟動： http://localhost:${PORT}`);
});
