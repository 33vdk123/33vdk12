// مزود kie.ai — Jobs API الموحد
// الشكل أدناه مأخوذ من نداءات حقيقية مقاسة فعليًا (وليس مختلَقًا):
//   POST /api/v1/jobs/createTask  → {"code":200,"msg":"success","data":{"taskId":"...","recordId":"..."}}
//   GET  /api/v1/jobs/recordInfo  → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//         "resultJson":"{\"resultUrls\":[\"https://...\"]}", "failMsg":...}}
// انتبه: resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا.
import { ProviderError } from "../errors";
import type { CheckResult, ProviderAdapter } from "./types";

const BASE = "https://api.kie.ai/api/v1/jobs";

// نداء موحد يرمي ProviderError عند أي فشل (HTTP أو كود المزود الداخلي)
async function call<T>(url: string, key: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (e) {
    // انقطاع شبكة أو timeout من جهتنا → خطأ مؤقت
    throw new ProviderError(0, e instanceof Error ? e.message : "network error", true);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: { code?: number; msg?: string; data?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }

  if (!res.ok) {
    // فشل على مستوى HTTP — نمرر الحالة والرسالة للتصنيف
    throw new ProviderError(res.status, body.msg || text.slice(0, 300) || `HTTP ${res.status}`);
  }
  // kie قد يعيد HTTP 200 مع كود داخلي != 200 (401/402/400...)
  const code = typeof body.code === "number" ? body.code : res.status;
  if (code !== 200) {
    throw new ProviderError(code, body.msg || `kie error code ${code}`);
  }
  return body as T;
}

// استخراج روابط النتائج من نص resultJson (JSON داخل JSON)
export function parseKieResultUrls(resultJson: string | null | undefined): string[] {
  if (!resultJson) return [];
  try {
    const inner = JSON.parse(resultJson) as { resultUrls?: string[]; url?: string };
    if (Array.isArray(inner.resultUrls) && inner.resultUrls.length) return inner.resultUrls;
    if (typeof inner.url === "string" && inner.url) return [inner.url];
  } catch {
    // نتيجة نصية غير متوقعة — نتجاهل
  }
  return [];
}

// kie لا يرسل نسبة تقدم — نقدّرها من الحالة لتغذية شريط التقدم والرسائل الحية
function estimateProgress(state: string): number {
  switch (state) {
    case "waiting":
      return 8;
    case "queuing":
      return 20;
    case "generating":
      return 55;
    default:
      return 30;
  }
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, model, input) {
    const body = await call<{ data: { taskId: string } }>(
      `${BASE}/createTask`,
      key,
      { method: "POST", body: JSON.stringify({ model, input }) },
      120_000,
    );
    if (!body?.data?.taskId) {
      throw new ProviderError(500, "استجابة createTask من kie.ai بلا taskId");
    }
    return { providerTaskId: body.data.taskId };
  },

  async checkTask(key, providerTaskId) {
    const body = await call<{
      data: { state: string; resultJson?: string; failMsg?: string | null; failCode?: unknown };
    }>(
      `${BASE}/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      key,
      { method: "GET" },
      30_000,
    );
    const rec = body?.data;
    if (!rec) throw new ProviderError(500, "استجابة recordInfo بلا بيانات");

    switch (rec.state) {
      case "success": {
        const urls = parseKieResultUrls(rec.resultJson);
        if (!urls.length) {
          // نجح المزود لكن بلا روابط — نعامله كفشل حقيقي برسالة واضحة
          return { status: "failed", error: "أعاد المزود المهمة مكتملة لكن بدون روابط نتائج" };
        }
        return { status: "completed", urls };
      }
      case "fail":
        return { status: "failed", error: rec.failMsg || "فشل التوليد لدى المزود" };
      default:
        // waiting | queuing | generating → قيد المعالجة
        return { status: "processing", progress: estimateProgress(rec.state) };
    }
  },
};
