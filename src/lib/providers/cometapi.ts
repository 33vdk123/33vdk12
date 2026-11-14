// مزود CometAPI — المزود الثاني
// الصور: نقطة متوافقة مع OpenAI تعيد الرابط فورًا (متزامن).
// الفيديو: نقطة مهام غير متزامنة بنمط create/check.
// ملاحظة: لا يوجد مفتاح CometAPI في بيئة الاختبار الحالية، لذا فهذا الملف
// مبني على التوثيق العام ولم يُختبَر بنداء حقيقي — عند إضافة مفتاح فعلي
// راقب أول نداءين وعدّل المسارات إن اختلفت وفق توثيق api.cometapi.com الرسمي.
import { ProviderError } from "../errors";
import type { CheckResult, ProviderAdapter } from "./types";

const BASE = "https://api.cometapi.com";

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
    throw new ProviderError(0, e instanceof Error ? e.message : "network error", true);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (!res.ok) {
    const msg =
      (typeof body.error === "string" ? body.error : null) ??
      (typeof body.message === "string" ? body.message : null) ??
      text.slice(0, 300) ??
      `HTTP ${res.status}`;
    throw new ProviderError(res.status, msg);
  }
  return body as T;
}

// استخراج رسالة خطأ من أجسام استجابة متنوعة الشكل
function errOf(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object" && typeof (body.error as { message?: unknown }).message === "string") {
    return (body.error as { message: string }).message;
  }
  if (typeof body.message === "string") return body.message;
  return fallback;
}

export const cometapiAdapter: ProviderAdapter = {
  // الصور متزامنة — تعيد الروابط فورًا
  async createImageSync(key, input) {
    const body = await call<{
      data?: { url?: string; b64_json?: string }[];
    }>(
      `${BASE}/v1/images/generations`,
      key,
      {
        method: "POST",
        body: JSON.stringify({
          model: input.__model,
          prompt: input.prompt,
          n: 1,
          size: "auto",
        }),
      },
      180_000,
    );
    const urls: string[] = [];
    for (const item of body?.data ?? []) {
      if (typeof item?.url === "string" && item.url) urls.push(item.url);
    }
    // لا يمكننا استضافة وسائط على سيرفرنا إطلاقًا، لذا b64_json بدون رابط يُرفض
    return { urls };
  },

  async createTask(key, model, input) {
    const body = await call<{ task_id?: string; data?: { task_id?: string; taskId?: string } }>(
      `${BASE}/v1/video/tasks`,
      key,
      { method: "POST", body: JSON.stringify({ model, input }) },
      120_000,
    );
    const id = body?.task_id ?? body?.data?.task_id ?? body?.data?.taskId;
    if (!id) throw new ProviderError(500, "استجابة إنشاء مهمة CometAPI بلا معرف");
    return { providerTaskId: id };
  },

  async checkTask(key, providerTaskId) {
    const body = await call<{
      status?: string;
      video_url?: string;
      url?: string;
      error?: string;
      data?: { status?: string; video_url?: string; url?: string; error?: string };
    }>(
      `${BASE}/v1/video/tasks/${encodeURIComponent(providerTaskId)}`,
      key,
      { method: "GET" },
      30_000,
    );
    const d = (body?.data ?? body) as typeof body & { data?: unknown };
    const status = String(d?.status ?? "").toLowerCase();
    const url = d?.video_url ?? d?.url;
    if (["success", "completed", "complete", "succeeded", "finished", "done"].includes(status)) {
      return typeof url === "string" && url
        ? { status: "completed", urls: [url] }
        : { status: "failed", error: "اكتملت المهمة لدى CometAPI بدون رابط فيديو" };
    }
    if (["fail", "failed", "error", "cancelled"].includes(status)) {
      return { status: "failed", error: errOf(body, "فشل التوليد لدى CometAPI") };
    }
    return { status: "processing", progress: 50 };
  },
};
