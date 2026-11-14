// تدفق الدمج — runMerge وrefreshMergeTask (قسم 7.3 من المواصفة)
import { randomUUID } from "node:crypto";
import { ParamsError, ProviderError, classifyError } from "./errors";
import { getTask, insertTask, taskResultUrls, updateTask, type DbTask } from "./turso";
import {
  createMergeJob,
  fireProcess,
  getMergeStatus,
  mergerConfigured,
  MergeFinalError,
} from "./merger";

export interface MergeOptions {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
  onProgress?: (progress: number, total: number, message: string) => void | Promise<void>;
}

const MERGE_MODEL = "video-merger";

// دمج عدة مقاطع في مقطع واحد بالترتيب المطلوب
// ترتيب الروابط: روابط task_ids المكتملة أولًا ثم urls المباشرة بنفس ترتيبها
export async function runMerge(opts: MergeOptions): Promise<DbTask> {
  const videos: string[] = [];
  const failedIds: string[] = [];

  for (const tid of opts.taskIds ?? []) {
    const t = await getTask(tid);
    const urls = t && t.status === "completed" ? taskResultUrls(t) : [];
    if (!urls.length) {
      failedIds.push(`"${tid}" (${!t ? "غير موجودة" : `الحالة: ${t.status}`})`);
      continue;
    }
    videos.push(urls[0]);
  }
  for (const u of opts.urls ?? []) {
    if (typeof u === "string" && u.trim()) videos.push(u.trim());
  }

  // تحقق صارم بعد جمع الروابط
  if (videos.length < 2) {
    let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (failedIds.length) msg += ` معرفات غير صالحة: ${failedIds.join("، ")}.`;
    throw new ParamsError(msg);
  }
  if (videos.length > 10) {
    throw new ParamsError("❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).");
  }
  const bad = videos.filter((v) => !/^https?:\/\//i.test(v));
  if (bad.length) {
    throw new ParamsError("❌ الروابط يجب أن تكون http/https مباشرة وعامة. روابط غير صالحة: " + bad.join("، "));
  }
  if (!mergerConfigured()) {
    throw new ParamsError("❌ خدمة الدمج غير مضبوطة على السيرفر (متغير MERGER_API_BASE مفقود). تواصل مع مدير النظام.");
  }

  // سجّل المهمة في Turso أولًا — حتى لو انقطع الاتصال تبقى قابلة للتتبع
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: MERGE_MODEL,
    type: "merge",
    prompt: `دمج ${videos.length} مقاطع فيديو`,
    params: { videos, processTriggered: false },
    status: "processing",
    progress: 0,
  });

  // أنشئ المهمة لدى خدمة الدمج — أي خطأ معلن منها فشل نهائي فوري (لا إعادة محاولة)
  let jobId: string;
  try {
    const job = await createMergeJob(videos);
    jobId = job.jobId;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateTask(taskId, { status: "failed", errorMessage: `❌ فشل إنشاء مهمة الدمج: ${msg}`.slice(0, 500) });
    return (await getTask(taskId))!;
  }
  await updateTask(taskId, { providerTaskId: jobId, params: { videos, processTriggered: true } });

  // أطلق process خلفيًا وبمرة واحدة فقط (محمي بقفل في الذاكرة)
  fireProcess(jobId);

  // نافذة انتظار (افتراضي 60 ثانية): استعلام كل 3 ثوان مع بث تقدم وتحديث فوري في Turso
  const deadline = Date.now() + Math.max(0, opts.waitSeconds) * 1000;
  while (Date.now() < deadline) {
    const outcome = await pollMergeOnce(taskId, jobId, opts.onProgress);
    if (outcome !== "continue") return (await getTask(taskId))!;
    if (Date.now() + 3000 > deadline) break;
    await sleep(Math.min(3000, Math.max(250, deadline - Date.now())));
  }
  // انتهت النافذة والنتيجة لم تظهر → processing والعميل يتابع بـ get_task
  return (await getTask(taskId))!;
}

// استعلام واحد عن حالة الدمج مع كتابة التحديث في Turso فورًا
async function pollMergeOnce(
  taskId: string,
  jobId: string,
  onProgress?: MergeOptions["onProgress"],
): Promise<"continue" | "completed" | "failed"> {
  let st;
  try {
    st = await getMergeStatus(jobId);
  } catch (e) {
    if (e instanceof MergeFinalError) {
      await updateTask(taskId, { status: "failed", errorMessage: `❌ فشلت المهمة: ${e.message}`.slice(0, 500) });
      return "failed";
    }
    // أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → استمر بالاستعلام
    return "continue";
  }

  if (st.status === "completed") {
    await updateTask(taskId, { status: "completed", progress: 100, resultUrls: st.videoUrl ? [st.videoUrl] : null });
    return "completed";
  }
  if (st.status === "failed") {
    await updateTask(taskId, {
      status: "failed",
      errorMessage: `❌ فشلت المهمة: ${st.error || "فشل الدمج في الخدمة"}`.slice(0, 500),
    });
    return "failed";
  }
  await updateTask(taskId, { progress: st.progress });
  await onProgress?.(st.progress, 100, `جارٍ الدمج… ${st.progress}%`);
  return "continue";
}

// get_task لمهمة دمج — تحديث حي من الخدمة مع إطلاق process عند الحاجة
export async function refreshMergeTask(task: DbTask): Promise<DbTask> {
  if (!mergerConfigured()) return task;

  let params: { videos?: string[]; processTriggered?: boolean } = {};
  try {
    params = JSON.parse(task.params_json || "{}");
  } catch {
    params = {};
  }

  let jobId = task.provider_task_id;
  if (!jobId && params.videos?.length) {
    // المهمة سُجلت لكن لم تُنشأ لدى الخدمة (انقطاع قديم) — أنشئها الآن
    try {
      const job = await createMergeJob(params.videos);
      jobId = job.jobId;
      await updateTask(task.id, { providerTaskId: jobId, params: { ...params, processTriggered: true } });
      fireProcess(jobId);
    } catch {
      await updateTask(task.id, { status: "failed", errorMessage: "❌ فشل إنشاء مهمة الدمج لدى الخدمة" });
      return (await getTask(task.id))!;
    }
  }
  if (!jobId) return task;

  // إن كانت قيد المعالجة ولم يُنفَّذ process بعد فنفّذه الآن (مرة واحدة)
  if (!params.processTriggered) {
    fireProcess(jobId);
    await updateTask(task.id, { params: { ...params, processTriggered: true } });
  }

  await pollMergeOnce(task.id, jobId, undefined);
  return (await getTask(task.id))!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
