// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP، متوافقة تمامًا مع بيئة serverless على Vercel
// لا ملفات SQLite محلية إطلاقًا؛ كل شيء عبر العميل الرسمي @libsql/client
import { createClient, type Client, type InValue } from "@libsql/client";
import { POLLINATIONS_KEY_ID, POLLINATIONS_FAKE_KEY } from "./providers/pollinations";

// عميل واحد مشترك يُنشأ كسولًا ويُعاد استخدامه عبر كل الاستدعاءات
let _client: Client | null = null;

export function getDb(): Client {
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

let schemaReady: Promise<void> | null = null;

// إنشاء الجداول عند أول وصول (CREATE TABLE IF NOT EXISTS) — لا حاجة لأداة migrations
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getDb();
      await db.execute(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      // زرع مفتاح Pollinations المجاني تلقائيًا — بلا مفاتيح فعلية، بلا تسجيل.
      // created_at = 1970 ليكون أقدم مفتاح فيُجرَّب أولًا دائمًا (getKeyPool تُرتّب تصاعديًا).
      // INSERT OR IGNORE: إن وُجد من قبل لا يُعاد إدراجه ولا يُعطّل المستخدم.
      await db.execute({
        sql: `INSERT OR IGNORE INTO api_keys (id, provider, label, api_key, status, created_at)
              VALUES (?, 'pollinations', ?, ?, 'active', '1970-01-01 00:00:00')`,
        args: [POLLINATIONS_KEY_ID, "مجاني بلا حد — Pollinations.ai", POLLINATIONS_FAKE_KEY],
      });
    })();
  }
  return schemaReady;
}

// فحص صحة قاعدة البيانات — SELECT 1
export async function dbHealthy(): Promise<boolean> {
  try {
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ————— أنواع الصفوف —————

export interface DbTask {
  id: string;
  provider: string | null; // kie | cometapi | merger
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string; // image | video | merge
  prompt: string;
  params_json: string;
  status: string; // pending | processing | completed | failed
  progress: number; // 0..100
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DbKey {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string; // active | exhausted | disabled
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

// سجل محاولة واحدة (نجاح أو فشل) — يُحفظ داخل attempts_json
export interface TaskAttempt {
  provider: string;
  keyId: string | null;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

// ————— مساعدات تحويل قيم libsql —————

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function rowToTask(r: Record<string, unknown>): DbTask {
  return {
    id: String(r.id),
    provider: str(r.provider),
    provider_task_id: str(r.provider_task_id),
    key_id: str(r.key_id),
    model: String(r.model ?? ""),
    type: String(r.type ?? ""),
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: String(r.status ?? ""),
    progress: num(r.progress),
    result_urls_json: str(r.result_urls_json),
    error_message: str(r.error_message),
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: str(r.completed_at),
  };
}

function rowToKey(r: Record<string, unknown>): DbKey {
  return {
    id: String(r.id),
    provider: String(r.provider ?? ""),
    label: String(r.label ?? ""),
    api_key: String(r.api_key ?? ""),
    status: String(r.status ?? "active"),
    usage_count: num(r.usage_count),
    success_count: num(r.success_count),
    fail_count: num(r.fail_count),
    last_used_at: str(r.last_used_at),
    last_checked_at: str(r.last_checked_at),
    last_error: str(r.last_error),
    created_at: String(r.created_at ?? ""),
  };
}

function parseJsonSafe<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function taskResultUrls(t: DbTask | null | undefined): string[] {
  return t ? parseJsonSafe<string[]>(t.result_urls_json, []) : [];
}

export function taskAttempts(t: DbTask | null | undefined): TaskAttempt[] {
  return t ? parseJsonSafe<TaskAttempt[]>(t.attempts_json, []) : [];
}

// ————— عمليات المهام —————

export interface NewTask {
  id: string;
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  model: string;
  type: string;
  prompt?: string;
  params?: Record<string, unknown>;
  status?: string;
  progress?: number;
}

export async function insertTask(t: NewTask): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
    args: [
      t.id,
      t.provider ?? null,
      t.providerTaskId ?? null,
      t.keyId ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      JSON.stringify(t.params ?? {}),
      t.status ?? "processing",
      t.progress ?? 0,
    ],
  });
}

export async function getTask(id: string): Promise<DbTask | null> {
  await ensureSchema();
  const r = await getDb().execute({ sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1", args: [id] });
  if (!r.rows.length) return null;
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>);
}

export interface TaskPatch {
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  status?: string;
  progress?: number;
  resultUrls?: string[] | null;
  errorMessage?: string | null;
  params?: Record<string, unknown>;
  appendAttempt?: TaskAttempt;
}

// تحديث جزئي للمهمة — يضيف المحاولات إلى attempts_json ويضبط completed_at تلقائيًا عند الاكتمال
export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  await ensureSchema();

  // إلحاق محاولة جديدة بسجل المحاولات
  if (patch.appendAttempt) {
    const current = await getTask(id);
    const attempts = current ? taskAttempts(current) : [];
    attempts.push(patch.appendAttempt);
    await getDb().execute({
      sql: "UPDATE tasks SET attempts_json = ?, updated_at = datetime('now') WHERE id = ?",
      args: [JSON.stringify(attempts.slice(-100)), id], // نحتفظ بآخر 100 محاولة فقط
    });
  }

  const sets: string[] = [];
  const args: InValue[] = [];

  if (patch.provider !== undefined) {
    sets.push("provider = ?");
    args.push(patch.provider);
  }
  if (patch.providerTaskId !== undefined) {
    sets.push("provider_task_id = ?");
    args.push(patch.providerTaskId);
  }
  if (patch.keyId !== undefined) {
    sets.push("key_id = ?");
    args.push(patch.keyId);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "completed") {
      // عند الاكتمال: تضبيط التقدم 100% ووقت الإكمال تلقائيًا
      sets.push("completed_at = datetime('now')");
      if (patch.progress === undefined) sets.push("progress = 100");
    }
  }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    args.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
  }
  if (patch.resultUrls !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(patch.resultUrls === null ? null : JSON.stringify(patch.resultUrls));
  }
  if (patch.errorMessage !== undefined) {
    sets.push("error_message = ?");
    args.push(patch.errorMessage);
  }
  if (patch.params !== undefined) {
    sets.push("params_json = ?");
    args.push(JSON.stringify(patch.params));
  }

  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  args.push(id);
  await getDb().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: string; status?: string },
): Promise<DbTask[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(Math.max(1, Math.min(50, limit)));
  const r = await getDb().execute({ sql, args });
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>));
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const r = await getDb().execute("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status");
  const byStatus: Record<string, number> = {};
  for (const row of r.rows) {
    byStatus[String(row.status)] = Number(row.c);
  }
  return {
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    completed: byStatus["completed"] ?? 0,
    failed: byStatus["failed"] ?? 0,
    processing: (byStatus["processing"] ?? 0) + (byStatus["pending"] ?? 0),
  };
}

// ————— عمليات المفاتيح —————

export interface NewKey {
  id: string;
  provider: string;
  label?: string;
  apiKey: string;
}

export async function insertKey(k: NewKey): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [k.id, k.provider, k.label ?? "", k.apiKey],
  });
}

export async function findKeyByValue(provider: string, apiKey: string): Promise<DbKey | null> {
  await ensureSchema();
  const r = await getDb().execute({
    sql: "SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  if (!r.rows.length) return null;
  return rowToKey(r.rows[0] as unknown as Record<string, unknown>);
}

// القائمة الكاملة للواجهة — مرتبة بترتيب الإضافة
export async function listKeys(): Promise<DbKey[]> {
  await ensureSchema();
  const r = await getDb().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return r.rows.map((row) => rowToKey(row as unknown as Record<string, unknown>));
}

export async function getKeyById(id: string): Promise<DbKey | null> {
  await ensureSchema();
  const r = await getDb().execute({ sql: "SELECT * FROM api_keys WHERE id = ? LIMIT 1", args: [id] });
  if (!r.rows.length) return null;
  return rowToKey(r.rows[0] as unknown as Record<string, unknown>);
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const r = await getDb().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return r.rowsAffected > 0;
}

// تعطيل/تنشيط يدوي أو تغيير حالة المفتاح مع آخر خطأ
export async function markKey(
  id: string,
  patch: { status?: string; lastError?: string | null },
): Promise<void> {
  await ensureSchema();
  const sets: string[] = ["last_checked_at = datetime('now')"];
  const args: InValue[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (patch.lastError !== undefined) {
    sets.push("last_error = ?");
    args.push(patch.lastError);
  }
  args.push(id);
  await getDb().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
}

// عدّادات المفتاح تُحدَّث دائمًا مع كل محاولة (نجاح أو فشل)
export async function bumpKeyCounters(id: string, ok: boolean, error?: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `UPDATE api_keys
          SET usage_count = usage_count + 1,
              success_count = success_count + ?,
              fail_count = fail_count + ?,
              last_used_at = datetime('now'),
              last_error = ?
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, error ?? null, id],
  });
}
