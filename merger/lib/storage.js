// طبقة التخزين — تقسيم Blobs إلى صفوف 2MB (حد HTTP في Turso) وقراؤها صفحات من 8 صفوف
const { db, ensureSchema } = require("./db");

// حجم صف التخزين — يجب أن يبقى تحت حد Turso HTTP
const ROW_CHUNK = 2 * 1024 * 1024;

// تخزين Buffer في جدول أجزاء بمفتاح مركب — idCols: أعمدة المفتاح قبل chunk (مثال ["job_id"] أو ["job_id","seq"])
async function putBlob(table, idCols, idVals, data) {
  await ensureSchema();
  const allCols = [...idCols, "chunk", "data"];
  const baseSql = `INSERT OR REPLACE INTO ${table} (${allCols.join(", ")}) VALUES (${allCols.map(() => "?").join(", ")})`;
  const rowCount = Math.ceil(data.length / ROW_CHUNK);
  for (let i = 0; i < rowCount; i++) {
    const part = data.subarray(i * ROW_CHUNK, Math.min((i + 1) * ROW_CHUNK, data.length));
    await db().execute({ sql: baseSql, args: [...idVals, i, part] });
  }
  // نظّف أي صفوف قديمة زائدة إن كانت الكتابة أقصر من سابقتها
  if (idCols.length) {
    const delSql = `DELETE FROM ${table} WHERE ${idCols.map((c) => `${c} = ?`).join(" AND ")} AND chunk >= ?`;
    await db().execute({ sql: delSql, args: [...idVals, rowCount] });
  } else {
    await db().execute({ sql: `DELETE FROM ${table} WHERE chunk >= ?`, args: [rowCount] });
  }
}

// قراءة صفحات من 8 صفوف (16MB لكل صفحة) وتجميعها كاملة — للاستخدام عند التجميع/الاختبار
async function readBlob(table, whereSql, whereArgs) {
  await ensureSchema();
  const parts = [];
  let offset = 0;
  const pageSize = 8;
  // نجلب صفحة صفحة حتى تنتهي الصفوف
  for (;;) {
    const r = await db().execute({
      sql: `SELECT chunk, data FROM ${table} WHERE ${whereSql} ORDER BY chunk ASC LIMIT ${pageSize} OFFSET ${offset}`,
      args: whereArgs,
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      const d = row.data;
      parts.push(typeof d === "string" ? Buffer.from(d, "base64") : Buffer.from(d));
    }
    if (r.rows.length < pageSize) break;
    offset += pageSize;
  }
  return Buffer.concat(parts);
}

// قارئ متدفق بصفحات — يحوّل صفوف الـ Blobs إلى stream مع تقليم أول/آخر جزء حسب المدى المطلوب (Range)
async function streamRange(table, whereSql, whereArgs, start, end, res) {
  await ensureSchema();
  const firstChunk = Math.floor(start / ROW_CHUNK);
  const lastChunk = Math.floor(end / ROW_CHUNK);
  let pos = firstChunk;
  while (pos <= lastChunk) {
    const pageEnd = Math.min(pos + 8 - 1, lastChunk);
    const r = await db().execute({
      sql: `SELECT chunk, data FROM ${table} WHERE ${whereSql} AND chunk BETWEEN ? AND ? ORDER BY chunk ASC`,
      args: [...whereArgs, pos, pageEnd],
    });
    for (const row of r.rows) {
      const chunkIdx = Number(row.chunk);
      const buf = typeof row.data === "string" ? Buffer.from(row.data, "base64") : Buffer.from(row.data);
      const chunkStart = chunkIdx * ROW_CHUNK;
      const chunkEnd = chunkStart + buf.length - 1;
      // تقليم أول/آخر جزء حسب المدى
      const from = Math.max(start, chunkStart);
      const to = Math.min(end, chunkEnd);
      if (to >= from) {
        const slice = buf.subarray(from - chunkStart, to - chunkStart + 1);
        if (!res.write(slice)) {
          // backpressure — انتظر حتى يُفرغ المخزن
          await new Promise((ok) => res.once("drain", ok));
        }
      }
    }
    if (r.rows.length < pageEnd - pos + 1) break; // صفوف أقل من المتوقع — توقف
    pos = pageEnd + 1;
  }
}

module.exports = { ROW_CHUNK, putBlob, readBlob, streamRange };
