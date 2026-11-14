// طبقة المفاتيح — الترتيب التسلسلي الصارم (قلب المشروع، قسم 4.1)
// أول مفتاح أُضيف يُجرَّب أولًا ثم الثاني ثم الثالث… — ليس round-robin وليس الأقل استخدامًا
import { getDb, ensureSchema, type DbKey } from "./turso";
import type { ProviderId } from "./models";
import type { InValue } from "@libsql/client";

// تجلب كل المفاتيح غير المعطّلة لهذه المزودات بترتيب الإضافة بالضبط:
// ORDER BY created_at ASC, id ASC
// المفتاح المستنزف (exhausted) يبقى في القائمة والقاعدة ولا يُستبعد —
// الاستثناء الوحيد هو التعطيل اليدوي/التلقائي (disabled)
export async function getKeyPool(providers: ProviderId[]): Promise<DbKey[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const args: InValue[] = [...providers];
  const r = await getDb().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args,
  });
  return r.rows.map((row) => row as unknown as DbKey);
}

// إخفاء المفتاح إلزاميًا في كل الاستجابات والسجلات — لا يُعاد المفتاح الكامل أبدًا
// مفاتيح قصيرة (≤12 حرفًا): أول 3 + •••• — وإلا أول 7 + •••••••• + آخر 4
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) {
    return key.slice(0, 3) + "••••";
  }
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}
