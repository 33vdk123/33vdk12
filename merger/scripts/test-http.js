// اختبار HTTP كامل ضد خادم التطوير — قاعدة file: محلية نظيفة (لا يلمس Turso الإنتاجية)
// يغطي: إنشاء من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع) → حذف → 404 → JSON تالف → حدود
process.env.TURSO_DATABASE_URL = "file:/tmp/merger-httptest.db";
process.env.TURSO_AUTH_TOKEN = "local-test-token";
process.env.PORT = "3101";
process.env.FFMPEG_PRESET = "ultrafast"; // تسريع اختبار الترميز فقط — الإنتاج يستخدم الافتراضي

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const ffmpegPath = require("ffmpeg-static");

const BASE = "http://127.0.0.1:3101";
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`✅ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.log(`❌ ${name}${extra ? " — " + extra : ""}`); }
}

function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, BASE);
    const r = http.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

function runFfmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300)))));
    p.on("error", reject);
  });
}

// خادم ملفات محلي يحاكي روابط فيديو عامة
function serveFiles(dir, port) {
  const server = http.createServer((rq, rs) => {
    const f = path.join(dir, rq.url.replace("/", ""));
    if (fs.existsSync(f)) { rs.setHeader("Content-Length", fs.statSync(f).size); fs.createReadStream(f).pipe(rs); }
    else { rs.statusCode = 404; rs.end(); }
  });
  return new Promise((ok2) => server.listen(port, "127.0.0.1", () => ok2(server)));
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await req("GET", "/api/config"); if (r.status === 200) return JSON.parse(r.body); } catch {}
    await new Promise((z) => setTimeout(z, 500));
  }
  throw new Error("خادم التطوير لم يجهز");
}

async function main() {
  // — تجهيز: خادم التطوير + فيديوهان اختباريان + خادم ملفات —
  const devServer = spawn(process.execPath, [path.join(__dirname, "..", "dev-server.js")], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  devServer.stderr.on("data", (c) => process.stderr.write("[dev] " + c));
  const cfg = await waitForServer();
  ok("GET /api/config يعمل", cfg.ok === true && cfg.maxSources === 10 && cfg.version === "1.0.0", `maxSources=${cfg.maxSources}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merger-http-"));
  const bin = ffmpegPath;
  const v1 = path.join(dir, "v1.mp4");
  const v2 = path.join(dir, "v2.mp4");
  const v3 = path.join(dir, "v3.mp4");
  await runFfmpeg(bin, ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p", "-y", v1]);
  await runFfmpeg(bin, ["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", v2]);
  await runFfmpeg(bin, ["-f", "lavfi", "-i", "testsrc=size=480x360:rate=25:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", v3]);
  const fileServer = await serveFiles(dir, 3948);
  const u1 = "http://127.0.0.1:3948/v1.mp4";
  const u2 = "http://127.0.0.1:3948/v2.mp4";
  ok("تجهيز ملفات الاختبار", fs.existsSync(v1) && fs.existsSync(v2) && fs.existsSync(v3));

  // — حالات الخطأ أولاً —
  let r = await req("POST", "/api/jobs", Buffer.from("{bad json"), { "Content-Type": "application/json" });
  ok("JSON تالف → 400", r.status === 400, JSON.parse(r.body).error);

  r = await req("POST", "/api/jobs", JSON.stringify({ videos: [] }));
  ok("قائمة فارغة → 400", r.status === 400);

  r = await req("POST", "/api/jobs", JSON.stringify({ videos: Array.from({ length: 11 }, (_, i) => u1) }));
  ok("11 مقطعًا → 400", r.status === 400, JSON.parse(r.body).error);

  r = await req("POST", "/api/jobs", JSON.stringify({ videos: ["ftp://x/y.mp4"] }));
  ok("رابط غير http → 400", r.status === 400);

  r = await req("GET", "/api/jobs/doesnotexist");
  ok("مهمة غير موجودة → 404", r.status === 404);

  r = await req("POST", "/api/jobs/doesnotexist/process");
  ok("process لمهمة غير موجودة → 404", r.status === 404);

  r = await req("PUT", "/api/jobs");
  ok("طريقة خاطئة → 405", r.status === 405);

  r = await req("POST", "/api/upload?job=nope&seq=1&chunk=0", Buffer.alloc(10));
  ok("رفع لمهمة غير موجودة → 404", r.status === 404);

  // جزء أكبر من 4MB على مهمة حقيقية → 413
  r = await req("POST", "/api/jobs", JSON.stringify({ sources: [{ kind: "file", name: "big.mp4", size: 20 * 1024 * 1024, mime: "video/mp4" }] }));
  const bigJob = JSON.parse(r.body);
  r = await req("POST", `/api/upload?job=${bigJob.jobId}&seq=1&chunk=0`, Buffer.alloc(4 * 1024 * 1024 + 100), { "Content-Type": "application/octet-stream" });
  ok("جزء أكبر من 4MB → 413", r.status === 413, `got ${r.status}`);
  await req("DELETE", `/api/jobs/${bigJob.jobId}`);

  // — مهمة روابط: إنشاء → حالة → دمج → بث Range → حذف —
  r = await req("POST", "/api/jobs", JSON.stringify({ videos: [u1, u2] }));
  const job = JSON.parse(r.body);
  ok("إنشاء مهمة من روابط → 201", r.status === 201 && job.jobId && job.status === "queued" && job.statusUrl && job.processUrl && job.expiresAt, job.jobId);

  r = await req("GET", `/api/jobs/${job.jobId}`);
  ok("حالة المهمة queued", JSON.parse(r.body).status === "queued");

  r = await req("POST", `/api/jobs/${job.jobId}/process`);
  const done = JSON.parse(r.body);
  ok("process → 200 done", r.status === 200 && done.status === "done" && done.videoUrl && done.size > 0, `${done.resolution || "?"} ${done.size}B`);

  ok("الدقة = أكبر دقة مدخل (640x360)", done.resolution === "640x360", done.resolution);
  ok("المدة ≈ مجموع المدد (5ث)", Math.abs((done.duration || 0) - 5) < 1.5, String(done.duration));
  ok("videoUrl/downloadUrl على نطاق الخدمة", done.videoUrl.startsWith(BASE) && !done.videoUrl.includes("127.0.0.1:3948"), done.videoUrl);

  // بث كامل 200
  r = await req("GET", `/api/jobs/${job.jobId}/video`);
  ok("بث كامل → 200 بطول صحيح", r.status === 200 && Number(r.headers["content-length"]) === done.size, `${r.body.length}B`);
  ok("Accept-Ranges: bytes", r.headers["accept-ranges"] === "bytes");

  // Range 206
  r = await req("GET", `/api/jobs/${job.jobId}/video`, null, { Range: "bytes=0-99" });
  ok("Range 0-99 → 206 + Content-Range", r.status === 206 && r.headers["content-range"] === `bytes 0-99/${done.size}` && r.body.length === 100, r.headers["content-range"]);

  r = await req("GET", `/api/jobs/${job.jobId}/video`, null, { Range: `bytes=${done.size - 50}-` });
  ok("Range لاحق → 206", r.status === 206 && r.headers["content-range"] === `bytes ${done.size - 50}-${done.size - 1}/${done.size}` && r.body.length === 50);

  r = await req("GET", `/api/jobs/${job.jobId}/video`, null, { Range: "bytes=999999999-" });
  ok("Range خارج النطاق → 416", r.status === 416);

  // download=1
  r = await req("GET", `/api/jobs/${job.jobId}/video?download=1`);
  ok("?download=1 → Content-Disposition", (r.headers["content-disposition"] || "").includes("attachment"));

  // process مرة ثانية على مهمة مكتملة → نفس النتيجة (idempotent)
  r = await req("POST", `/api/jobs/${job.jobId}/process`);
  ok("process ثانية على مكتملة → 200", r.status === 200 && JSON.parse(r.body).status === "done");

  // — مهمة مختلطة (رابط + ملف مرفوع بأجزاء) —
  const f1 = fs.readFileSync(v3);
  r = await req("POST", "/api/jobs", JSON.stringify({ sources: [{ kind: "url", url: u1 }, { kind: "file", name: "v3.mp4", size: f1.length, mime: "video/mp4" }] }));
  const mixed = JSON.parse(r.body);
  ok("مهمة مختلطة → 201 uploading", r.status === 201 && mixed.status === "uploading" && Array.isArray(mixed.uploads) && mixed.uploads.length === 1, mixed.jobId);

  const up = mixed.uploads[0];
  const CHUNK = up.uploadChunkBytes; // 4MB
  const nChunks = Math.ceil(f1.length / CHUNK);
  let uploadOk = true;
  for (let k = 0; k < nChunks; k++) {
    const part = f1.subarray(k * CHUNK, Math.min((k + 1) * CHUNK, f1.length));
    const ur = await req("POST", `/api/upload?job=${mixed.jobId}&seq=${up.seq}&chunk=${k}`, part, { "Content-Type": "application/octet-stream" });
    if (ur.status !== 200) { uploadOk = false; break; }
  }
  ok(`رفع الملف بأجزاء ${nChunks} × 4MB`, uploadOk);

  r = await req("GET", `/api/jobs/${mixed.jobId}`);
  ok("بعد اكتمال الرفع → queued", JSON.parse(r.body).status === "queued");

  r = await req("POST", `/api/jobs/${mixed.jobId}/process`);
  const mixedDone = JSON.parse(r.body);
  ok("دمج مختلط → done", r.status === 200 && mixedDone.status === "done", mixedDone.resolution);
  ok("دقة المختلط = أكبر دقة (320x240 + 480x360 → 480x360)", mixedDone.resolution === "480x360", mixedDone.resolution);

  // — مهمة ملف ناقص الرفع → 409 —
  r = await req("POST", "/api/jobs", JSON.stringify({ sources: [{ kind: "file", name: "p.mp4", size: 10 * 1024 * 1024, mime: "video/mp4" }] }));
  const partial = JSON.parse(r.body);
  await req("POST", `/api/upload?job=${partial.jobId}&seq=1&chunk=0`, Buffer.alloc(1024 * 1024), { "Content-Type": "application/octet-stream" });
  r = await req("POST", `/api/jobs/${partial.jobId}/process`);
  ok("رفع ناقص → process يرفض 409", r.status === 409, JSON.parse(r.body).error);

  // — cron —
  r = await req("GET", "/api/cron");
  ok("GET /api/cron يعمل", r.status === 200 && JSON.parse(r.body).ok === true);

  // — حذف شامل ثم 404 —
  r = await req("DELETE", `/api/jobs/${job.jobId}`);
  ok("حذف شامل → 200", r.status === 200 && JSON.parse(r.body).ok === true);
  r = await req("GET", `/api/jobs/${job.jobId}`);
  ok("بعد الحذف → 404", r.status === 404);
  r = await req("GET", `/api/jobs/${job.jobId}/video`);
  ok("بث بعد الحذف → 404", r.status === 404);

  // تنظيف بقية مهام الاختبار
  await req("DELETE", `/api/jobs/${mixed.jobId}`);
  await req("DELETE", `/api/jobs/${partial.jobId}`);

  fileServer.close();
  devServer.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync("/tmp/merger-httptest.db", { force: true });

  console.log(`\n=== النتيجة: ${passed} ناجح / ${failed} فاشل ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("CRASH:", e); process.exit(1); });
