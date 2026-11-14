// عميل خدمة دمج الفيديو — Video Merger API v2
// بلا مفاتيح أو توثيق؛ العنوان من MERGER_API_BASE. روابط فقط — لا تنزيل أي وسائط إلى سيرفرنا.
// القواعد الدفاعية (7.2): تحليل حالة متسامح، progress كسري ×100، error بلا status = فشل فوري.
import { ProviderError } from "./errors";

const BASE = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");

export function mergerConfigured(): boolean {
  return /^https?:\/\//.test(BASE);
}

export function mergerBase(): string {
  return BASE || "(غير مضبوط)";
}

// خطأ معلن من خدمة الدمج (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة (قاعدة 7.3.5)
export class MergeFinalError extends Error {}

// قفل في الذاكرة: process يُطلق مرة واحدة لكل مهمة حتى لا يتزامن مع get_task (7.3.3)
const processInFlight = new Set<string>();

export interface MergeJobCreated {
  jobId: string;
  status?: string;
  statusUrl?: string;
  processUrl?: string;
  expiresAt?: string;
}

// POST /api/jobs — إنشاء مهمة دمج
export async function createMergeJob(videos: string[]): Promise<MergeJobCreated> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // خطأ شبكة من جهتنا نحن → مؤقت (يستمر بالاستعلام حتى انتهاء النافذة)
    throw new ProviderError(0, e instanceof Error ? e.message : "network error", true);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.error) {
    throw new MergeFinalError(String(body.error || `HTTP ${res.status}`));
  }
  if (!body.jobId) throw new MergeFinalError("استجابة إنشاء مهمة الدمج بلا jobId");
  return body as unknown as MergeJobCreated;
}

// POST /api/jobs/{id}/process — يُطلق خلفيًا وبمرة واحدة فقط (يستغرق ~10-15 ثانية عادة)
export function fireProcess(jobId: string): void {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void (async () => {
    try {
      await fetch(`${BASE}/api/jobs/${encodeURIComponent(jobId)}/process`, {
        method: "POST",
        signal: AbortSignal.timeout(320_000),
      });
    } catch {
      // تجاهل — الاستعلام اللاحق عبر GET سيتكفل بالمتابعة، وrefreshMergeTask يعيد الإطلاق عند الحاجة
    } finally {
      setTimeout(() => processInFlight.delete(jobId), 30_000);
    }
  })();
}

export interface MergeStatus {
  status: "processing" | "completed" | "failed";
  progress: number; // 0..100
  videoUrl?: string;
  error?: string;
}

const DONE_STATES = ["done", "completed", "complete", "success", "succeeded", "finished"];
const FAILED_STATES = ["error", "failed", "failure", "cancelled"];

// GET /api/jobs/{jobId} — حالة المهمة مع تحليل دفاعي
export async function getMergeStatus(jobId: string): Promise<MergeStatus> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/jobs/${encodeURIComponent(jobId)}`, {
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ProviderError(0, e instanceof Error ? e.message : "network error", true);
  }

  // 404 → فشل نهائي: حُذفت أو انتهت صلاحيتها (الملفات تُحذف بعد 24 ساعة)
  if (res.status === 404) {
    throw new MergeFinalError("مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // خطأ HTTP معلن من الخدمة → فشل نهائي فوري بلا إعادة محاولة
    throw new MergeFinalError(String(body.error || `HTTP ${res.status}`));
  }
  // قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا
  if (body.error && !body.status) {
    throw new MergeFinalError(String(body.error));
  }

  const raw = String(body.status ?? "").toLowerCase();
  const progressRaw = Number(body.progress ?? 0);
  // progress يأتي أحيانًا كسرًا 0..1 → اضربه في 100
  const progress = Number.isFinite(progressRaw)
    ? Math.max(0, Math.min(100, Math.round(progressRaw <= 1 ? progressRaw * 100 : progressRaw)))
    : 0;

  if (FAILED_STATES.includes(raw)) {
    return { status: "failed", progress, error: String(body.error || "فشل الدمج في الخدمة") };
  }
  if (DONE_STATES.includes(raw)) {
    // فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط رابط البث المباشر
    const videoUrl =
      (typeof body.videoUrl === "string" && body.videoUrl) ||
      (typeof body.downloadUrl === "string" && body.downloadUrl) ||
      `${BASE}/api/jobs/${encodeURIComponent(jobId)}/video`;
    return { status: "completed", progress: 100, videoUrl };
  }
  return { status: "processing", progress };
}

// فحص جهوزية الخدمة — GET /api/config بمهلة 4 ثوانٍ
export async function checkMergerHealth(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const res = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(4_000) });
    return res.ok;
  } catch {
    return false;
  }
}
