// Google OAuth 登入保護（只允許 ALLOWED_EMAIL 指定的 Google 帳號存取管理頁面）。
// 沒設定 GOOGLE_CLIENT_ID/SECRET 時完全不啟用保護（本機開發方便）。

const https = require("https");
const crypto = require("crypto");

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-insecure-secret";
const AUTH_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && ALLOWED_EMAIL);

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function makeSessionCookie(email) {
  const expires = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `${email}.${expires}`;
  const sig = sign(payload);
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

function verifySessionCookie(cookieValue) {
  if (!cookieValue) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, sig] = parts;
  let payload;
  try {
    payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (sign(payload) !== sig) return null;
  const dotIndex = payload.lastIndexOf(".");
  const email = payload.slice(0, dotIndex);
  const expires = Number(payload.slice(dotIndex + 1));
  if (!expires || Date.now() > expires) return null;
  return email;
}

function getCookie(req, name) {
  const header = req.headers["cookie"];
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function isAuthorized(req) {
  if (!AUTH_ENABLED) return true;
  const session = getCookie(req, "session");
  const email = verifySessionCookie(session);
  return email === ALLOWED_EMAIL;
}

function redirectUriFor(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}/auth/google/callback`;
}

function handleLogin(req, res) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUriFor(req),
    response_type: "code",
    scope: "openid email",
    access_type: "online",
    prompt: "select_account",
  });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  res.end();
}

function postForm(hostname, path, formData) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formData).toString();
    const req = https.request(
      {
        hostname,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getJson(hostname, path) {
  return new Promise((resolve, reject) => {
    https
      .get({ hostname, path }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

async function handleCallback(req, res, url) {
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Missing authorization code");
    return;
  }

  try {
    const tokenRes = await postForm("oauth2.googleapis.com", "/token", {
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUriFor(req),
      grant_type: "authorization_code",
    });

    if (!tokenRes.id_token) {
      throw new Error("No id_token returned");
    }

    const info = await getJson(
      "oauth2.googleapis.com",
      `/tokeninfo?id_token=${encodeURIComponent(tokenRes.id_token)}`
    );

    if (!info.email || info.email_verified !== "true") {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Google account email is not verified.");
      return;
    }

    if (info.email !== ALLOWED_EMAIL) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Access denied. Signed in as ${info.email}, which is not authorized.`);
      return;
    }

    const cookieValue = makeSessionCookie(info.email);
    res.writeHead(302, {
      "Set-Cookie": `session=${encodeURIComponent(cookieValue)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
        SESSION_MAX_AGE_MS / 1000
      )}; Path=/`,
      Location: "/",
    });
    res.end();
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Login failed: " + err.message);
  }
}

function handleLogout(req, res) {
  res.writeHead(302, {
    "Set-Cookie": "session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/",
    Location: "/",
  });
  res.end();
}

function requireAuth(req, res, isApi) {
  if (isAuthorized(req)) return true;
  if (!AUTH_ENABLED) return true;
  if (isApi) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not signed in" }));
  } else {
    res.writeHead(302, { Location: "/login" });
    res.end();
  }
  return false;
}

module.exports = {
  AUTH_ENABLED,
  isAuthorized,
  requireAuth,
  handleLogin,
  handleCallback,
  handleLogout,
};
