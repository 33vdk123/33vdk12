// خادم تطوير محلي يحاكي بيئة Vercel:
// - يحمّل .env يدويًا (بلا مكتبات)
// - يحلّل المسارات الديناميكية ويضعها في req.query مثل Vercel (/api/jobs/<id> → req.query.id)
// - يخدم public/ ثابتًا ويعيد توجيه /api إلى دوال serverless نفسها
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// — تحميل .env يدويًا (لا نطغى على متغيرات موجودة) —
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
})();

const apiJobs = require("./api/jobs.js");
const apiJobId = require("./api/jobs/[id].js");
const apiProcess = require("./api/jobs/[id]/process.js");
const apiVideo = require("./api/jobs/[id]/video.js");
const apiUpload = require("./api/upload.js");
const apiConfig = require("./api/config.js");
const apiCron = require("./api/cron.js");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function setQuery(req, extra) {
  const parsed = url.parse(req.url, true);
  req.query = Object.assign({}, parsed.query, extra || {});
  req.url = parsed.pathname + (parsed.search || "");
}

const server = http.createServer(async (req, res) => {
  const pathname = url.parse(req.url, true).pathname;

  try {
    // — واجهة ثابتة —
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      let file = pathname === "/" ? "/index.html" : pathname;
      const abs = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        res.statusCode = 200;
        res.setHeader("Content-Type", MIME[path.extname(abs)] || "application/octet-stream");
        return fs.createReadStream(abs).pipe(res);
      }
      res.statusCode = 404;
      return res.end("Not Found");
    }

    // — توجيه API مع تحليل المسارات الديناميكية إلى req.query (كما تفعل Vercel) —
    let m;
    if ((m = pathname.match(/^\/api\/jobs\/([^/]+)\/video$/))) {
      setQuery(req, { id: m[1] });
      return await apiVideo(req, res);
    }
    if ((m = pathname.match(/^\/api\/jobs\/([^/]+)\/process$/))) {
      setQuery(req, { id: m[1] });
      return await apiProcess(req, res);
    }
    if ((m = pathname.match(/^\/api\/jobs\/([^/]+)$/))) {
      setQuery(req, { id: m[1] });
      return await apiJobId(req, res);
    }
    if (pathname === "/api/jobs") {
      setQuery(req, {});
      return await apiJobs(req, res);
    }
    if (pathname === "/api/upload") {
      setQuery(req, {});
      return await apiUpload(req, res);
    }
    if (pathname === "/api/config") {
      setQuery(req, {});
      return await apiConfig(req, res);
    }
    if (pathname === "/api/cron") {
      setQuery(req, {});
      return await apiCron(req, res);
    }

    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "المسار غير موجود" }));
  } catch (e) {
    console.error("DEV SERVER ERROR:", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
    }
    res.end(JSON.stringify({ error: e.message || "خطأ داخلي" }));
  }
});

const port = Number(process.env.PORT || 3001);
server.listen(port, () => {
  console.log(`✅ خادم تطوير الدمج يعمل على http://localhost:${port}`);
});
