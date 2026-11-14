// GET /api/config — الحدود العامة والإصدار (تُستخدم لفحص الجهوزية)
const { json, setCORS, LIMITS } = require("../lib/util");
const { dbHealthy } = require("../lib/db");

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method !== "GET") return json(res, 405, { error: "الطريقة غير مدعومة" });
  const healthy = await dbHealthy().catch(() => false);
  return json(res, 200, {
    ok: healthy,
    version: LIMITS.version,
    maxSources: LIMITS.maxSources,
    sourceMaxMB: Math.round(LIMITS.sourceMaxBytes / 1048576),
    outputMaxMB: Math.round(LIMITS.outputMaxBytes / 1048576),
    maxTotalDurationSec: LIMITS.maxTotalDurationSec,
    uploadChunkBytes: LIMITS.uploadChunkBytes,
    retentionHours: 24,
  });
};
