// GET /api/jobs/{id} — الحالة والتقدم والرابط عند الاكتمال
// DELETE /api/jobs/{id} — حذف فوري شامل
const { json, setCORS, publicUrl } = require("../../lib/util");
const { getJob, deleteJobRows } = require("../../lib/db");

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  const id = String(req.query.id || "");
  if (!id) return json(res, 400, { error: "معرف المهمة مفقود" });

  if (req.method === "DELETE") {
    const job = await getJob(id);
    if (!job) return json(res, 404, { error: "المهمة غير موجودة" });
    await deleteJobRows(id); // jobs + sources + source_chunks + output_chunks في batch واحد
    return json(res, 200, { ok: true, deleted: id });
  }
  if (req.method !== "GET") {
    return json(res, 405, { error: "الطريقة غير مدعومة" });
  }

  const job = await getJob(id);
  if (!job) return json(res, 404, { error: "المهمة غير موجودة" });

  const base = publicUrl(req);
  const out = {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    expiresAt: job.expires_at,
  };
  if (job.status === "done") {
    out.videoUrl = `${base}/api/jobs/${id}/video`;
    out.downloadUrl = `${base}/api/jobs/${id}/video?download=1`;
    out.size = job.out_size;
    out.duration = job.out_duration;
    out.resolution = job.out_resolution;
  }
  if (job.status === "failed") out.error = job.error || "فشل غير معروف";
  return json(res, 200, out);
};
