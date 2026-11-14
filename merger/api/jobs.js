// POST /api/jobs — إنشاء مهمة دمج
// يقبل {"videos":["url1","url2"]} أو {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
const crypto = require("crypto");
const { json, setCORS, readRawBody, sqliteDate, publicUrl, LIMITS } = require("../lib/util");
const { createJob, insertSource, deleteExpired } = require("../lib/db");

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: "الطريقة غير مدعومة — استخدم POST" });
  }

  let body;
  try {
    const raw = await readRawBody(req, 1024 * 1024);
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch (e) {
    if (e.code === 413) return json(res, 413, { error: "حجم الطلب كبير جدًا" });
    return json(res, 400, { error: "JSON تالف — تأكد من صحة جسم الطلب" });
  }

  // دعم الشكلين: videos (روابط) أو sources (روابط + ملفات)
  let sources = [];
  if (Array.isArray(body.videos)) {
    sources = body.videos.map((u) => ({ kind: "url", url: String(u || "").trim() }));
  } else if (Array.isArray(body.sources)) {
    sources = body.sources.map((s) => ({
      kind: s.kind === "file" ? "file" : "url",
      url: s.url ? String(s.url).trim() : null,
      name: s.name ? String(s.name).slice(0, 200) : null,
      size: s.size ? Number(s.size) : null,
      mime: s.mime ? String(s.mime).slice(0, 100) : null,
    }));
  }
  sources = sources.filter((s) => (s.kind === "url" && s.url) || (s.kind === "file" && s.size));

  if (!sources.length) {
    return json(res, 400, { error: "لم تُمرر أي مصادر — أرسل videos أو sources غير فارغة" });
  }
  if (sources.length > LIMITS.maxSources) {
    return json(res, 400, { error: `أقصى عدد مقاطع للدمج هو ${LIMITS.maxSources}` });
  }
  for (const s of sources) {
    if (s.kind === "url" && !/^https?:\/\//i.test(s.url)) {
      return json(res, 400, { error: `الرابط يجب أن يكون http/https مباشرًا وعامًا: ${s.url.slice(0, 60)}` });
    }
    if (s.kind === "file") {
      if (!s.size || s.size <= 0) return json(res, 400, { error: "حجم الملف المرفوع غير صالح" });
      if (s.size > LIMITS.sourceMaxBytes) {
        return json(res, 413, { error: `حجم الملف يتجاوز الحد (${Math.round(LIMITS.sourceMaxBytes / 1048576)}MB)` });
      }
    }
  }

  // تنظيف كسول للمهام المنتهية (24 ساعة) قبل الإنشاء
  try {
    await deleteExpired();
  } catch {
    // التنظيف لا يعطل الإنشاء أبدًا
  }

  const id = crypto.randomBytes(6).toString("hex"); // 12 حرفًا مثل wkucdefoxwvd
  const expiresAt = sqliteDate(Date.now() + 24 * 3600 * 1000);
  await createJob(id, expiresAt);
  for (let i = 0; i < sources.length; i++) {
    await insertSource(id, i + 1, sources[i]);
  }

  const base = publicUrl(req);
  const hasFiles = sources.some((s) => s.kind === "file");
  const status = hasFiles ? "uploading" : "queued";
  await require("../lib/db").updateJob(id, { status });

  const response = {
    jobId: id,
    status,
    statusUrl: `${base}/api/jobs/${id}`,
    processUrl: `${base}/api/jobs/${id}/process`,
    expiresAt,
  };
  if (hasFiles) {
    response.uploads = sources
      .map((s, i) => ({ s, seq: i + 1 }))
      .filter(({ s }) => s.kind === "file")
      .map(({ s, seq }) => ({
        seq,
        uploadUrl: `${base}/api/upload?job=${id}&seq=${seq}`,
        uploadChunkBytes: LIMITS.uploadChunkBytes,
      }));
  }
  return json(res, 201, response);
};
