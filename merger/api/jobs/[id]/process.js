// POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن داخل الدالة، حتى 300 ثانية)
// نجاح → {"status":"done","videoUrl":...,"size":...,"duration":...,"resolution":...,"expiresAt":...}
// فشل معلن → HTTP 500 + {"error":"..."} — فشل حتمي: تكرار المحاولة يعطي النتيجة نفسها
const { json, setCORS, publicUrl, LIMITS } = require("../../../lib/util");
const { getJob, updateJob, listSources, sourceReceivedBytes } = require("../../../lib/db");
const { mergeSources, cleanupTmp } = require("../../../lib/merge");
const { putBlob, ROW_CHUNK } = require("../../../lib/storage");
const fs = require("fs");
const path = require("path");

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: "الطريقة غير مدعومة — استخدم POST" });
  }

  const id = String(req.query.id || "");
  const job = await getJob(id);
  if (!job) return json(res, 404, { error: "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" });

  // قيد المعالجة فعله → 202 (عملية أخرى تجري الآن)
  if (job.status === "processing") {
    return json(res, 202, { status: "processing", progress: job.progress });
  }
  // اكتملت سابقًا → أعد النتيجة المخزنة كما هي (idempotent)
  if (job.status === "done") {
    const base = publicUrl(req);
    return json(res, 200, {
      status: "done",
      videoUrl: `${base}/api/jobs/${id}/video`,
      downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
      size: job.out_size,
      duration: job.out_duration,
      resolution: job.out_resolution,
      expiresAt: job.expires_at,
    });
  }
  if (job.status === "failed") {
    // فشل حتمي سابق — النتيجة نفسها ستتكرر، لكن نسمح بالمحاولة عند إعادة الرفع
    // نعيد الفشل برسالته المخزنة
    return json(res, 500, { error: job.error || "فشل الدمج سابقًا" });
  }

  // تحقق: ملفات المصدر مكتملة الرفع
  const sources = await listSources(id);
  for (const s of sources) {
    if (s.kind === "file") {
      const got = await sourceReceivedBytes(id, s.seq);
      if (s.size && got !== s.size) {
        return json(res, 409, {
          error: `الملف ${s.name || "رقم " + s.seq} غير مكتمل الرفع (${got}/${s.size} بايت)`,
        });
      }
    }
  }

  await updateJob(id, { status: "processing", progress: 2, error: null });
  const tmpDir = path.join("/tmp", `merge-${id}`);
  const outPath = path.join(tmpDir, "out.mp4");

  try {
    // مصادر مع معرف المهمة والموقع لاستخدامها في التجميع من القاعدة
    const withMeta = sources.map((s) => ({ ...s, jobId: id }));
    const result = await mergeSources(withMeta, tmpDir, outPath, (pct) => {
      // تخزين التقدم فورًا في القاعدة عند كل تغير ملموس
      updateJob(id, { progress: Math.max(2, Math.min(99, pct)) }).catch(() => {});
    });

    // حفظ الناتج في Turso (صفوف 2MB بمفتاح job_id) ثم حذف أجزاء المصادر — الناتج فقط هو المطلوب
    const buf = await fs.promises.readFile(outPath);
    await putBlob("output_chunks", ["job_id"], [id], buf);
    await require("../../../lib/db").db().execute({
      sql: "DELETE FROM source_chunks WHERE job_id = ?",
      args: [id],
    });
    await updateJob(id, {
      status: "done",
      progress: 100,
      out_size: result.size,
      out_duration: result.duration,
      out_resolution: result.resolution,
    });

    const base = publicUrl(req);
    return json(res, 200, {
      status: "done",
      videoUrl: `${base}/api/jobs/${id}/video`,
      downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
      expiresAt: job.expires_at,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateJob(id, { status: "failed", error: msg.slice(0, 500) }).catch(() => {});
    return json(res, 500, { error: msg.slice(0, 500) });
  } finally {
    await cleanupTmp(tmpDir); // نظّف /tmp دائمًا
  }
};
