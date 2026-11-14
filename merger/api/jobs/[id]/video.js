// GET /api/jobs/{id}/video — بث الناتج بدعم Range (206 + Content-Range) للتقديم/الترجيع
// ?download=1 → تحميل مباشر بترويسة Content-Disposition
const { setCORS, parseRange } = require("../../../lib/util");
const { getJob } = require("../../../lib/db");
const { streamRange, ROW_CHUNK } = require("../../../lib/storage");

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "الطريقة غير مدعومة" }));
  }
  const id = String(req.query.id || "");
  const job = await getJob(id);
  if (!job) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" }));
  }
  if (job.status !== "done" || !job.out_size) {
    res.statusCode = 409;
    return res.end(
      JSON.stringify({
        error: `لا يوجد ناتج بعد — حالة المهمة: ${job.status}`,
        status: job.status,
        progress: job.progress,
      }),
    );
  }

  const size = job.out_size;
  const range = parseRange(req.headers.range, size);
  if (range && range.invalid) {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${size}`);
    return res.end();
  }

  // بلا ترويسة Range → البث الكامل؛ وإلا قصّ المدى المطلوب بالضبط
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");
  if (req.query.download === "1" || req.query.download === "true") {
    res.setHeader("Content-Disposition", `attachment; filename="merged-${id}.mp4"`);
  }
  if (range) {
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
  } else {
    res.statusCode = 200;
    res.setHeader("Content-Length", String(size));
  }

  await streamRange("output_chunks", "job_id = ?", [id], start, end, res);
  res.end();
};
