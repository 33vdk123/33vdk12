// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB octet-stream)
// الجسم 4MB يُقسَّم داخليًا إلى صفين 2MB (حد صفوف Turso) — وإعادة رفع نفس الجزء تستبدله بأمان
const { json, setCORS, readRawBody, LIMITS } = require("../lib/util");
const { getJob, updateJob, db, ensureSchema } = require("../lib/db");
const { ROW_CHUNK } = require("../lib/storage");

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: "الطريقة غير مدعومة — استخدم POST" });
  }

  const jobId = String(req.query.job || "");
  const seq = Number(req.query.seq);
  const chunk = Number(req.query.chunk);
  if (!jobId || !Number.isInteger(seq) || !Number.isInteger(chunk) || chunk < 0) {
    return json(res, 400, { error: "معاملات الرفع ناقصة أو تالفة — المطلوب job وseq وchunk" });
  }

  const job = await getJob(jobId);
  if (!job) return json(res, 404, { error: "المهمة غير موجودة" });
  if (job.status === "processing" || job.status === "done") {
    return json(res, 409, { error: `المهمة قيد التنفيذ أو مكتملة — لا يمكن الرفع الآن (الحالة: ${job.status})` });
  }

  let body;
  try {
    body = await readRawBody(req, LIMITS.uploadChunkBytes);
  } catch (e) {
    if (e.code === 413) return json(res, 413, { error: `حجم الجزء يتجاوز ${LIMITS.uploadChunkBytes / 1048576}MB` });
    return json(res, 400, { error: "تعذر قراءة جسم الطلب" });
  }
  if (!body.length) return json(res, 400, { error: "الجزء فارغ" });

  await ensureSchema();
  // الجزء الواحد (حتى 4MB) → صفان 2MB على الأكثر: chunk*2 و chunk*2+1
  const rows = Math.ceil(body.length / ROW_CHUNK);
  for (let i = 0; i < rows; i++) {
    const part = body.subarray(i * ROW_CHUNK, Math.min((i + 1) * ROW_CHUNK, body.length));
    await db().execute({
      sql: "INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)",
      args: [jobId, seq, chunk * 2 + i, part],
    });
  }

  // هل اكتمل هذا المصدر؟ وهل اكتملت كل المصادر؟ → قائمة الانتظار
  const { listSources, sourceReceivedBytes } = require("../lib/db");
  const sources = await listSources(jobId);
  const received = await sourceReceivedBytes(jobId, seq);
  let allDone = true;
  for (const s of sources) {
    if (s.kind !== "file") continue;
    const got = await sourceReceivedBytes(jobId, s.seq);
    if (!s.size || got < s.size) allDone = false;
  }
  if (allDone && sources.some((s) => s.kind === "file") && job.status === "uploading") {
    await updateJob(jobId, { status: "queued", progress: 0 });
  }

  return json(res, 200, { ok: true, seq, chunk, received, sourceComplete: !!(sources.find((s) => s.seq === seq)?.size && received >= sources.find((s) => s.seq === seq).size), jobReady: allDone });
};
