// منسق التوليد — runGeneration وrefreshTask (قسم 6 من المواصفة)
// القاعدة الذهبية: التبديل التسلسلي الصامت — نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا.
import { randomUUID } from "node:crypto";
import { ADAPTERS } from "./providers";
import { resolveModel, type ModelDef, type ProviderId } from "./models";
import { classifyError, ParamsError } from "./errors";
import { getKeyPool, maskKey } from "./keys";
import {
  getKeyById,
  bumpKeyCounters,
  markKey,
  getTask,
  insertTask,
  updateTask,
  type DbTask,
  type TaskAttempt,
} from "./turso";
import { refreshMergeTask } from "./mergeFlow";

const POLL_INTERVAL_MS = 3000;
// بتهدئة ~45 ثانية حتى لا نضغط المزودين عند إعادة المحاولة مع كل get_task
const RETRY_COOLDOWN_MS = 45_000;

export interface GenerateOptions {
  type: "image" | "video";
  model: string;
  prompt: string;
  params: Record<string, unknown>; // كل معطيات الطلب الأصلية (لإعادة الإنشاء عند التبديل)
  waitSeconds: number;
  onProgress?: (progress: number, total: number, message: string) => void | Promise<void>;
}

// لا توجد مفاتيح نهائيًا — رد no_keys الصريح
export class NoKeysError extends Error {
  constructor(modelCanonical: string) {
    super(`❌ لا توجد مفاتيح نشطة لخدمة ${modelCanonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// بناء input المزود من معطيات الأداة — نُسقط "auto" من aspect_ratio/background
// لأن بعض المزودين يرفضونها، ونبقي الباقي كما ورد
function buildProviderInput(def: ModelDef, params: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (k === "wait_seconds") continue;
    if (v === "auto" && (k === "aspect_ratio" || k === "background")) continue;
    input[k] = v;
  }
  return input;
}

// فشل المهمة لدى المزود — إن طابقت رسالته أنماط مشكلات مفتاح/رصيد فننتقل للمفتاح التالي (4.3.2)
function keyFailureClass(msg: string): "exhausted" | "disabled" | null {
  const m = (msg || "").toLowerCase();
  if (/insufficient|balance|credit|quota|充值|余额|out of credits|exhausted/.test(m)) return "exhausted";
  if (/unauthorized|invalid api key|invalid_api_key|forbidden|authentication|\b401\b|\b402\b/.test(m)) return "disabled";
  return null;
}

function attemptOf(
  provider: string,
  keyId: string | null,
  keyLabel: string,
  ok: boolean,
  errorClass?: string,
  error?: string,
): TaskAttempt {
  return {
    provider,
    keyId,
    keyLabel,
    ok,
    errorClass,
    error: error?.slice(0, 300),
    at: new Date().toISOString(),
  };
}

// جرّب المرشحين بالترتيب حتى نجاح الإنشاء (قسم 4.3.1)
// كل محاولة تُسجَّل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا
async function tryCreateOnKeys(taskId: string, def: ModelDef, opts: GenerateOptions): Promise<"created" | "failed" | "processing"> {
  // تُجلب من جديد في كل مرة — المفتاح الذي عُطّل للتو خرج تلقائيًا من القائمة
  const pool = await getKeyPool(def.providers);

  for (const key of pool) {
    const providerId = key.provider as ProviderId;
    const adapter = ADAPTERS[providerId];
    if (!adapter) continue; // مزود غير معروف — تجاهل أمانًا

    const input = buildProviderInput(def, opts.params);
    const modelForProvider = def.providerModel[providerId] || def.canonical;

    try {
      if (def.type === "image" && adapter.createImageSync) {
        // توليد صور متزامن — النتيجة فورية
        const { urls } = await adapter.createImageSync(key.api_key, { ...input, __model: modelForProvider });
        await bumpKeyCounters(key.id, true);
        if (!urls.length) {
          await updateTask(taskId, {
            status: "failed",
            errorMessage: "❌ فشلت المهمة: أعاد المزود صورة بدون رابط مباشر قابل للاستخدام",
            appendAttempt: attemptOf(key.provider, key.id, key.label || maskKey(key.api_key), false, "provider", "no direct url"),
          });
          return "failed";
        }
        await updateTask(taskId, {
          provider: key.provider,
          keyId: key.id,
          status: "completed",
          progress: 100,
          resultUrls: urls,
          appendAttempt: attemptOf(key.provider, key.id, key.label || maskKey(key.api_key), true),
        });
        return "created";
      }

      // مهمة غير متزامنة — سجّل معرف المزود وانتقل للنافذة
      const { providerTaskId } = await adapter.createTask(key.api_key, modelForProvider, input);
      await bumpKeyCounters(key.id, true);
      await updateTask(taskId, {
        provider: key.provider,
        providerTaskId,
        keyId: key.id,
        appendAttempt: attemptOf(key.provider, key.id, key.label || maskKey(key.api_key), true),
      });
      return "created";
    } catch (e) {
      const cls = classifyError(e);
      const errText = e instanceof Error ? e.message : String(e);
      await bumpKeyCounters(key.id, false, errText.slice(0, 200));
      await updateTask(taskId, {
        appendAttempt: attemptOf(key.provider, key.id, key.label || maskKey(key.api_key), false, cls, errText),
      });

      if (cls === "disabled") {
        // مفتاح مرفوض → علّمه disabled تلقائيًا → انتقل للمفتاح التالي
        await markKey(key.id, { status: "disabled", lastError: errText.slice(0, 200) });
      } else if (cls === "exhausted") {
        // نفاد رصيد → علّمه exhausted (يبقى في القاعدة) → انتقل للتالي
        await markKey(key.id, { status: "exhausted", lastError: errText.slice(0, 200) });
      } else if (cls === "params") {
        // خطأ معطيات — توقف فورًا؛ تبديل المفاتيح لن يحل خطأ معطيات
        await updateTask(taskId, {
          status: "failed",
          errorMessage: `❌ فشلت المهمة: خطأ في معطيات الطلب (${errText})`.slice(0, 500),
        });
        return "failed";
      }
      // provider | temporary | exhausted | disabled → انتقل للمرشح التالي
    }
  }

  // فشل الإنشاء على كل المفاتيح: تبقى المهمة processing (ليست failed) بانتظار مفتاح صالح
  await updateTask(taskId, { errorMessage: "بانتظار توفر مفتاح صالح…" });
  return "processing";
}

// استعلام واحد عن حالة المهمة من المزود — يعالج التبديل في منتصف المهمة أيضًا
async function pollOnce(taskId: string, def: ModelDef, opts: GenerateOptions): Promise<"continue" | "completed" | "failed"> {
  const task = await getTask(taskId);
  if (!task || !task.provider_task_id || !task.provider || !task.key_id) return "continue";

  const providerId = task.provider as ProviderId;
  const adapter = ADAPTERS[providerId];
  if (!adapter) return "continue";
  const key = await getKeyById(task.key_id);
  if (!key) {
    // حُذف المفتاح يدويًا أثناء المهمة → أعد الإنشاء على بقية المفاتيح بنفس task_id
    await updateTask(taskId, { provider: null, providerTaskId: null, keyId: null });
    return "continue";
  }

  try {
    const res = await adapter.checkTask(key.api_key, task.provider_task_id);

    if (res.status === "processing") {
      const p = res.progress ?? task.progress;
      if (res.progress !== undefined && res.progress > task.progress) {
        await updateTask(taskId, { progress: res.progress });
      }
      await opts.onProgress?.(p, 100, `قيد التوليد… ${p}%`);
      return "continue";
    }

    if (res.status === "completed") {
      await bumpKeyCounters(key.id, true);
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        resultUrls: res.urls ?? null,
        appendAttempt: attemptOf(task.provider, key.id, key.label || maskKey(key.api_key), true),
      });
      return "completed";
    }

    // فشل معلن من المزود — إن طابقت أنماط مفتاح/رصيد أعد الإنشاء بنفس task_id
    const msg = res.error || "";
    const kf = keyFailureClass(msg);
    await bumpKeyCounters(key.id, false, msg.slice(0, 200));
    await updateTask(taskId, {
      appendAttempt: attemptOf(task.provider, key.id, key.label || maskKey(key.api_key), false, kf ?? "provider", msg),
    });
    if (kf) {
      await markKey(key.id, { status: kf, lastError: msg.slice(0, 200) });
      // استئناف نفس المهمة بنفس task_id على المفتاح التالي — العميل يرى «قيد المعالجة» فقط
      await updateTask(taskId, { provider: null, providerTaskId: null, keyId: null });
      return "continue";
    }
    // فشل حقيقي (انتهاك سياسة/معطيات) → failed نهائي
    await updateTask(taskId, {
      status: "failed",
      errorMessage: `❌ فشلت المهمة: ${msg}`.slice(0, 500),
    });
    return "failed";
  } catch (e) {
    const cls = classifyError(e);
    const errText = e instanceof Error ? e.message : String(e);
    await bumpKeyCounters(key.id, false, errText.slice(0, 200));
    await updateTask(taskId, {
      appendAttempt: attemptOf(task.provider, key.id, key.label || maskKey(key.api_key), false, cls, errText),
    });

    if (cls === "disabled" || cls === "exhausted") {
      // فشل في منتصف المهمة بسبب مفتاح/رصيد → تبديل تلقائي فوري بنفس task_id
      await markKey(key.id, { status: cls, lastError: errText.slice(0, 200) });
      await updateTask(taskId, { provider: null, providerTaskId: null, keyId: null });
      return "continue";
    }
    if (cls === "params") {
      await updateTask(taskId, {
        status: "failed",
        errorMessage: `❌ فشلت المهمة: خطأ في معطيات الاستعلام (${errText})`.slice(0, 500),
      });
      return "failed";
    }
    // temporary/provider أثناء الاستعلام → استمر حتى انتهاء النافذة
    return "continue";
  }
}

// حلقة التنفيذ: إنشاء أولًا ثم استعلام داخل نافذة الانتظار مع إعادة الإنشاء عند التبديل
async function runLoop(taskId: string, def: ModelDef, opts: GenerateOptions): Promise<void> {
  const deadline = Date.now() + Math.max(0, opts.waitSeconds) * 1000;

  // 1) الإنشاء دائمًا أولًا — حتى مع نافذة 0 تظل المهمة مسجلة لدى المزود وقابلة للمتابعة
  const created = await tryCreateOnKeys(taskId, def, opts);
  if (created === "failed") return;
  let task = await getTask(taskId);
  if (!task || !task.provider_task_id) return; // فشل على كل المفاتيح → processing بانتظار مفتاح

  // 2) نافذة الانتظار: استعلام كل 3 ثوان مع بث التقدم
  while (Date.now() < deadline) {
    const outcome = await pollOnce(taskId, def, opts);
    if (outcome === "completed" || outcome === "failed") return;

    // هل ما زلنا لدينا مهمة مزود بعد أي تبديل؟
    task = await getTask(taskId);
    if (!task || task.status === "completed" || task.status === "failed") return;
    if (!task.provider_task_id) {
      // أُعيد الترشح بعد تبديل في منتصف المهمة
      const r = await tryCreateOnKeys(taskId, def, opts);
      if (r === "failed") return;
      task = await getTask(taskId);
      if (!task || !task.provider_task_id) return; // لا مفاتيح متاحة الآن → processing
    }

    if (Date.now() + POLL_INTERVAL_MS > deadline) break;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(250, deadline - Date.now())));
  }
  // انتهت النافذة والنتيجة لم تظهر → processing مع task_id والعميل يتابع بـ get_task
}

// نقطة الدخول لأداتي generate_image وgenerate_video
export async function runGeneration(opts: GenerateOptions): Promise<DbTask> {
  const def = resolveModel(opts.model);
  if (!def) {
    // موديل مجهول → خطأ معطيات فوري
    throw new ParamsError(`❌ موديل غير معروف: ${opts.model}. المتاح: ${"gpt-image-2-6/flare-text-to-image"} (صور)، ${"grok-imagine-video-1-5-preview"} (فيديو).`);
  }
  if (def.type !== opts.type) {
    throw new ParamsError(`❌ الموديل ${def.canonical} مخصص لـ ${def.type === "image" ? "الصور" : "الفيديو"} وليس ${opts.type === "image" ? "الصور" : "الفيديو"}.`);
  }

  const pool = await getKeyPool(def.providers);
  if (!pool.length) {
    // رد no_keys — بلا إنشاء مهمة إطلاقًا
    throw new NoKeysError(def.canonical);
  }

  // سجّل المهمة في Turso قبل أي نداء خارجي
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: def.canonical,
    type: opts.type,
    prompt: opts.prompt,
    params: opts.params,
    status: "processing",
    progress: 0,
  });

  await runLoop(taskId, def, opts);
  return (await getTask(taskId))!;
}

// خيارات مشتقة من مهمة مخزنة (لإعادة المحاولة عبر get_task)
function optionsFromTask(task: DbTask): GenerateOptions {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(task.params_json || "{}") as Record<string, unknown>;
  } catch {
    params = {};
  }
  return {
    type: task.type === "video" ? "video" : "image",
    model: task.model,
    prompt: task.prompt,
    params,
    waitSeconds: 0,
  };
}

// refreshTask — يحدّث المهمة الجارية حية من المزود (أو من خدمة الدمج) ثم يعيد الصياغة العربية
export async function refreshTask(taskId: string): Promise<DbTask | null> {
  let task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  if (task.type === "merge") {
    return await refreshMergeTask(task);
  }

  const def = resolveModel(task.model);
  if (!def) return task;

  if (!task.provider_task_id) {
    // أُعيدت المحاولة تلقائيًا مع كل استدعاء get_task — بعد بتهدئة ~45 ثانية
    const lastMs = Date.parse(task.updated_at.replace(" ", "T") + "Z") || 0;
    if (Date.now() - lastMs < RETRY_COOLDOWN_MS) return task;
    await tryCreateOnKeys(task.id, def, optionsFromTask(task));
    task = await getTask(task.id);
    if (!task || !task.provider_task_id || task.status !== "processing") return task;
  }

  await pollOnce(task.id, def, optionsFromTask(task));
  return await getTask(task.id);
}
