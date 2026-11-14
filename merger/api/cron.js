// GET /api/cron — حذف المهام المنتهية (مجدول يوميًا عبر vercel.json crons)
const { json, setCORS } = require("../lib/util");
const { deleteExpired } = require("../lib/db");

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method !== "GET") return json(res, 405, { error: "الطريقة غير مدعومة" });
  try {
    const deleted = await deleteExpired();
    return json(res, 200, { ok: true, deleted });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : "فشل التنظيف" });
  }
};
