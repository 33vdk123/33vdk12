// طبقة قاعدة البيانات — Turso عبر HTTP (serverless) — كل شيء مخزن فيها: المهام والأجزاء والناتج
const { createClient } = require("@libsql/client");

// عميل كسول — تُنشأ عند أول استخدام حتى تستطيع الاختبارات ضبط env أولًا
let _client = null;
function db() {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

let schemaReady = null;
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const c = db();
      // كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) بمفتاح أساسي مركب
      await c.execute(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          error TEXT,
          out_size INTEGER,
          out_duration REAL,
          out_resolution TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        )
      `);
      await c.execute(`
        CREATE TABLE IF NOT EXISTS sources (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          url TEXT,
          name TEXT,
          size INTEGER,
          mime TEXT,
          PRIMARY KEY (job_id, seq)
        )
      `);
      await c.execute(`
        CREATE TABLE IF NOT EXISTS source_chunks (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          chunk INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, seq, chunk)
        )
      `);
      await c.execute(`
        CREATE TABLE IF NOT EXISTS output_chunks (
          job_id TEXT NOT NULL,
          chunk INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, chunk)
        )
      `);
    })();
  }
  return schemaReady;
}

async function dbHealthy() {
  try {
    await db().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

function rowToJob(r) {
  return {
    id: String(r.id),
    status: String(r.status),
    progress: Number(r.progress || 0),
    error: r.error == null ? null : String(r.error),
    out_size: r.out_size == null ? null : Number(r.out_size),
    out_duration: r.out_duration == null ? null : Number(r.out_duration),
    out_resolution: r.out_resolution == null ? null : String(r.out_resolution),
    created_at: String(r.created_at || ""),
    expires_at: String(r.expires_at || ""),
  };
}

async function createJob(id, expiresAt) {
  await ensureSchema();
  await db().execute({
    sql: "INSERT INTO jobs (id, status, progress, expires_at) VALUES (?, ?, 0, ?)",
    args: [id, "queued", expiresAt],
  });
}

async function getJob(id) {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT * FROM jobs WHERE id = ? LIMIT 1", args: [id] });
  return r.rows.length ? rowToJob(r.rows[0]) : null;
}

async function updateJob(id, patch) {
  await ensureSchema();
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    args.push(v);
  }
  if (!sets.length) return;
  args.push(id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

// حذف شامل: صفوف المهمة من الجداول الأربعة في batch واحد
async function deleteJobRows(id) {
  await ensureSchema();
  await db().batch(
    [
      { sql: "DELETE FROM jobs WHERE id = ?", args: [id] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [id] },
    ],
    "write",
  );
}

// تنظيف كسول/مجدول للمهام المنتهية (24 ساعة)
async function deleteExpired() {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT id FROM jobs WHERE expires_at < datetime('now')",
    args: [],
  });
  let deleted = 0;
  for (const row of r.rows) {
    await deleteJobRows(String(row.id));
    deleted += 1;
  }
  return deleted;
}

async function insertSource(jobId, seq, src) {
  await db().execute({
    sql: "INSERT INTO sources (job_id, seq, kind, url, name, size, mime) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [jobId, seq, src.kind, src.url ?? null, src.name ?? null, src.size ?? null, src.mime ?? null],
  });
}

async function listSources(jobId) {
  const r = await db().execute({
    sql: "SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC",
    args: [jobId],
  });
  return r.rows.map((row) => ({
    seq: Number(row.seq),
    kind: String(row.kind),
    url: row.url == null ? null : String(row.url),
    name: row.name == null ? null : String(row.name),
    size: row.size == null ? null : Number(row.size),
    mime: row.mime == null ? null : String(row.mime),
  }));
}

// حجم الملف المرفوع فعليًا (مجموع أطوال الأجزاء المخزنة)
async function sourceReceivedBytes(jobId, seq) {
  const r = await db().execute({
    sql: "SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM source_chunks WHERE job_id = ? AND seq = ?",
    args: [jobId, seq],
  });
  return Number(r.rows[0]?.n || 0);
}

module.exports = {
  db,
  ensureSchema,
  dbHealthy,
  createJob,
  getJob,
  updateJob,
  deleteJobRows,
  deleteExpired,
  insertSource,
  listSources,
  sourceReceivedBytes,
};
