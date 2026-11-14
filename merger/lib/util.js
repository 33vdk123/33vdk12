// أدوات مشتركة: استجابات JSON، CORS، قراءة الجسم الثنائي، تحليل Range، الحدود
const LIMITS = {
  maxSources: Number(process.env.MAX_SOURCES || 10),
  sourceMaxBytes: Number(process.env.SOURCE_MAX_MB || 200) * 1024 * 1024,
  outputMaxBytes: Number(process.env.OUTPUT_MAX_MB || 150) * 1024 * 1024,
  maxTotalDurationSec: Number(process.env.MAX_TOTAL_DURATION_SEC || 600),
  uploadChunkBytes: 4 * 1024 * 1024, // حد حجم الطلب في Vercel ≈ 4.5MB → نجزّئ الرفع 4MB
  version: "1.0.0",
};

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
}

function json(res, code, obj) {
  setCORS(res);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

// قراءة الجسم الخام بحد أقصى — يُعيد Buffer أو يرمي كود 413
// عند التجاوز: نرفض فورًا ونتجاهل بقية البيانات (بدون قطع الاتصال) ليصل رد 413 للعميل
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      total += c.length;
      if (total > maxBytes) {
        aborted = true;
        const err = new Error("حجم الطلب يتجاوز الحد المسموح");
        err.code = 413;
        reject(err);
        req.resume(); // تجاهل بقية الجسم كي يُغلق الطلب بنظام
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (!aborted) reject(e);
    });
  });
}

// تحليل ترويسة Range: bytes=start-end → {start, end} أو null إن غابت/تالفة
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start = m[1] === "" ? NaN : parseInt(m[1], 10);
  let end = m[2] === "" ? NaN : parseInt(m[2], 10);
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    // bytes=-N → آخر N بايت
    const n = end;
    if (n <= 0) return { start: 0, end: size - 1, suffix: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start > end || start >= size) return { invalid: true };
  end = Math.min(end, size - 1);
  return { start, end };
}

// صيغة تاريخ متوافقة مع datetime('now') في SQLite — حتى تعمل المقارنات النصية للانتهاء
function sqliteDate(ms) {
  const d = new Date(ms === undefined ? Date.now() : ms);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function publicUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}

module.exports = { LIMITS, setCORS, json, readRawBody, parseRange, sqliteDate, publicUrl };
