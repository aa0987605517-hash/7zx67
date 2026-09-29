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
const { saveScript, loadScript, deleteScript, listScripts, USE_GIST } = require("./storage");

const PORT = process.env.PORT || 3000;
const ROUTE_PREFIX = "7zx67"; // 連結路徑前綴，例如 /7zx67/xxxx
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 200 * 1024; // 200KB 上限，避免濫用
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // 未設定時不啟用登入保護（本機測試用）

function isAuthorized(req) {
  if (!ADMIN_PASSWORD) return true; // 沒設密碼就不擋（本機開發方便）
  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return user === ADMIN_USER && pass === ADMIN_PASSWORD;
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Script Manager"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("Authentication required");
  return false;
}

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

  // 執行器讀取腳本的路徑保持公開，其餘所有路徑（管理頁面、上傳、清單、編輯、停用）都需要登入
  const isPublicScriptRoute =
    req.method === "GET" &&
    new RegExp(`^/${ROUTE_PREFIX}/[A-Za-z0-9_-]+$`).test(url.pathname);
  if (!isPublicScriptRoute && !requireAuth(req, res)) {
    return;
  }

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

      const customName = payload && payload.name;
      let id;
      if (customName !== undefined && customName !== null && customName !== "") {
        if (typeof customName !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(customName)) {
          sendJson(res, 400, { error: "自訂名稱只能包含英數字、底線、連字號，長度 1~64" });
          return;
        }
        if (customName.toLowerCase() === "readme") {
          sendJson(res, 400, { error: "這個名稱是保留字，請換一個" });
          return;
        }
        id = customName;
      } else {
        id = safeId();
      }

      const proceed = () => {
        saveScript(id, code)
          .then(() => {
            const proto = req.headers["x-forwarded-proto"] || url.protocol.replace(":", "");
            const rawUrl = `${proto}://${req.headers.host}/${ROUTE_PREFIX}/${id}`;
            sendJson(res, 200, { id, rawUrl });
          })
          .catch(() => {
            sendJson(res, 500, { error: "儲存失敗" });
          });
      };

      if (customName) {
        loadScript(id).then((existing) => {
          if (existing !== null) {
            sendJson(res, 409, { error: "這個名稱已經被使用，請換一個" });
            return;
          }
          proceed();
        });
      } else {
        proceed();
      }
    });
    return;
  }

  // 列出所有已上傳的腳本 ID
  if (req.method === "GET" && url.pathname === "/api/scripts") {
    listScripts()
      .then((ids) => sendJson(res, 200, { ids }))
      .catch(() => sendJson(res, 500, { error: "讀取清單失敗" }));
    return;
  }

  // 取得單一腳本內容（供編輯用，管理介面專用，不受 User-Agent 限制）
  const manageMatch = url.pathname.match(/^\/api\/scripts\/([A-Za-z0-9_-]+)$/);
  if (req.method === "GET" && manageMatch) {
    loadScript(manageMatch[1]).then((code) => {
      if (code === null) {
        sendJson(res, 404, { error: "找不到這個腳本" });
        return;
      }
      sendJson(res, 200, { id: manageMatch[1], code });
    });
    return;
  }

  // 更新既有腳本內容
  if (req.method === "PUT" && manageMatch) {
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
      saveScript(manageMatch[1], code)
        .then(() => sendJson(res, 200, { id: manageMatch[1], updated: true }))
        .catch(() => sendJson(res, 500, { error: "更新失敗" }));
    });
    return;
  }

  // 停用（刪除）指定的腳本
  if (req.method === "POST" && url.pathname === "/api/disable") {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendJson(res, 400, { error: "請求格式錯誤，需為 JSON" });
        return;
      }
      const id = payload && payload.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
        sendJson(res, 400, { error: "無效的腳本 ID" });
        return;
      }
      deleteScript(id)
        .then(() => sendJson(res, 200, { id, disabled: true }))
        .catch(() => sendJson(res, 500, { error: "停用失敗" }));
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
      res.end("別看了小臭寶");
      return;
    }

    const id = match[1];
    loadScript(id).then((data) => {
      if (data === null) {
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
  console.log(`儲存模式： ${USE_GIST ? "GitHub Gist（持久化）" : "本機檔案（伺服器重啟會遺失）"}`);
});
