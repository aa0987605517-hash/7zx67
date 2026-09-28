// 儲存層：用 GitHub Gist 做持久化儲存（您現有的 GitHub 帳號，不需要額外註冊新服務）。
// 沒有設定 GITHUB_TOKEN / GIST_ID 時，退回本機檔案系統
// （方便本機開發測試，但部署在 Render 免費方案上會在重啟後遺失，僅供測試）。

const fs = require("fs");
const https = require("https");
const path = require("path");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID = process.env.GIST_ID;
const USE_GIST = Boolean(GITHUB_TOKEN && GIST_ID);

const SCRIPTS_DIR = path.join(__dirname, "scripts");
if (!USE_GIST && !fs.existsSync(SCRIPTS_DIR)) {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
}

function githubRequest(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = https.request(
      {
        hostname: "api.github.com",
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "User-Agent": "roblox-script-server",
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data || "{}") });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function saveScript(id, code) {
  if (USE_GIST) {
    const res = await githubRequest("PATCH", `/gists/${GIST_ID}`, {
      files: { [`${id}.lua`]: { content: code } },
    });
    if (res.status >= 300) {
      throw new Error(`Gist 更新失敗: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return;
  }
  return new Promise((resolve, reject) => {
    fs.writeFile(path.join(SCRIPTS_DIR, `${id}.lua`), code, "utf8", (err) =>
      err ? reject(err) : resolve()
    );
  });
}

async function loadScript(id) {
  if (USE_GIST) {
    const res = await githubRequest("GET", `/gists/${GIST_ID}`);
    if (res.status >= 300) return null;
    const file = res.body.files && res.body.files[`${id}.lua`];
    if (!file) return null;
    if (file.truncated && file.raw_url) {
      return new Promise((resolve, reject) => {
        https
          .get(file.raw_url, (r) => {
            let data = "";
            r.on("data", (c) => (data += c));
            r.on("end", () => resolve(data));
          })
          .on("error", reject);
      });
    }
    return file.content;
  }
  return new Promise((resolve) => {
    fs.readFile(path.join(SCRIPTS_DIR, `${id}.lua`), "utf8", (err, data) => {
      resolve(err ? null : data);
    });
  });
}

async function deleteScript(id) {
  if (USE_GIST) {
    const res = await githubRequest("PATCH", `/gists/${GIST_ID}`, {
      files: { [`${id}.lua`]: null },
    });
    if (res.status >= 300) {
      throw new Error(`Gist 刪除失敗: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return;
  }
  return new Promise((resolve) => {
    fs.unlink(path.join(SCRIPTS_DIR, `${id}.lua`), () => resolve());
  });
}

module.exports = { saveScript, loadScript, deleteScript, USE_GIST };
