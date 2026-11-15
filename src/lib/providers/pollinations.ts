// مزود Pollinations.ai — مجاني بالكامل، بلا مفاتيح API، بلا تسجيل، بلا حدود صارمة.
// يدعم الصور فقط (لا فيديو). يُسجَّل كمزود أول للصور في models.ts فيُجرَّب تلقائياً
// قبل kie/cometapi — فإن نجح أعطى صورة مجانية فورية، وإن فشل (شبكة/حد مؤقت)
// رمى ProviderError مؤقتًا فينتقل المنسّق للمزود التالي دون تعطيله (يبقى دائمًا متاحًا).
//
// آلية العمل: Pollinations يولّد الصورة عند نداء GET للرابط نفسه:
//   https://image.pollinations.ai/prompt/{encoded}?width=&height=&seed=&nologo=true&model=flux
// الرابط هو نفسه نتيجة الإخراج — لا نخزّن البايتات على سيرفرنا إطلاقًا، نكتشف
// بـ GET أن التوليد تم (200 + content-type صورة) ثم نُرجع الرابط نفسه للمستخدم.
// البايتات تُستهلَك من جهتنا بالكامل عبر cancel للستريم بعد قراءة الترويسات فقط.
import { ProviderError } from "../errors";
import type { ProviderAdapter } from "./types";

const BASE = "https://image.pollinations.ai/prompt";

// اسم الموديل لدى Pollinations — قابل للتجاوز بمتغير بيئة
const POLLINATIONS_IMAGE_MODEL = process.env.POLLINATIONS_IMAGE_MODEL || "flux";

// المعرّف الثابت للمفتاح المجاني المزروع في القاعدة — يُستخدم لحمايته من الحذف
export const POLLINATIONS_KEY_ID = "pollinations-free";
// قيمة مفتاح وهمية ثابتة (لا تُستخدم فعليًا في النداءات — Pollinations بلا مفاتيح)
export const POLLINATIONS_FAKE_KEY = "free-no-key-required";

// نسب العرض/الارتفاع المدعومة — نحوّلها إلى أبعاد بكسل ملموسة
const ASPECT_RATIOS: Record<string, [number, number]> = {
  auto: [1, 1],
  "1:1": [1, 1],
  "3:2": [3, 2],
  "2:3": [2, 3],
  "4:3": [4, 3],
  "3:4": [3, 4],
  "5:4": [5, 4],
  "4:5": [4, 5],
  "16:9": [16, 9],
  "9:16": [9, 16],
  "2:1": [2, 1],
  "1:2": [1, 2],
  "21:9": [21, 9],
  "9:21": [9, 21],
  "3:1": [3, 1],
  "1:3": [1, 3],
};

// قاعدة الحجم حسب الدقة المطلوبة — Pollinations يحدّ الأبعاد بحدود معقولة
// نكتفي بـ 1024 للدقة العادية و2048 للعالية (4K قد يُرفض أو يبطئ كثيرًا)
function baseSizeFor(resolution: unknown): number {
  if (resolution === "4K" || resolution === "2K") return 1536;
  return 1024;
}

// حساب أبعاد زوجية من النسبة والقاعدة (Pollinations يتطلب أحيانًا أبعادًا زوجية)
function dimsFor(aspect: unknown, resolution: unknown): { width: number; height: number } {
  const [rw, rh] = ASPECT_RATIOS[String(aspect || "auto")] ?? [1, 1];
  const base = baseSizeFor(resolution);
  // نحافظ على أكبر بُعد = base ونحسب الآخر بالنسبة
  const landscape = rw >= rh;
  const width = landscape ? base : Math.round((base * rw) / rh);
  const height = landscape ? Math.round((base * rh) / rw) : base;
  // ضمان أرقام زوجية ومحصورة بين 256 و2048
  const clampEven = (n: number) => Math.max(256, Math.min(2048, n % 2 === 0 ? n : n + 1));
  return { width: clampEven(width), height: clampEven(height) };
}

// معرّف عشوائي قصير لإجبار توليد صورة جديدة في كل نداء (تجاوز الكاش عند الرغبة)
function randSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

// التحقق من وصول الصورة بنداء GET قصير — نقرأ الترويسات فقط ثم نلغي الستريم
// لا نخزّن البايتات إطلاقًا. إن أعاد 200 + content-type صورة → التوليد تم بنجاح.
async function verifyImage(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Pollinations يمنح أولوية أعلى لطلبات بـ Referer ويسمح بـ nologo للطلبات المشروعة
        Referer: "https://mcp-media-generator.vercel.app",
        Accept: "image/*",
      },
    });
    // نلغي جسم الاستجابة فورًا بعد قراءة الترويسات — لا نستهلك البايتات
    try {
      await res.body?.cancel();
    } catch {
      // تجاهل — إلغاء الستريم لا يعطل العملية
    }
    if (!res.ok) return false;
    const ct = String(res.headers.get("content-type") || "");
    return ct.startsWith("image/");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const pollinationsAdapter: ProviderAdapter = {
  // الصور متزامنة — نبني الرابط، نتحقق من توليده بـ GET خفيف، ثم نُعيد الرابط نفسه
  async createImageSync(_key, input) {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (!prompt) {
      // خطأ معطيات — يوقف المنسّق فورًا (تبديل المفاتيح لن يحل وصفًا فارغًا)
      throw new ProviderError(400, "وصف الصورة فارغ — لا يمكن توليد صورة بدون prompt");
    }

    const { width, height } = dimsFor(input.aspect_ratio, input.resolution);
    const seed = randSeed();
    const model = POLLINATIONS_IMAGE_MODEL;

    const params = new URLSearchParams({
      width: String(width),
      height: String(height),
      seed: String(seed),
      nologo: "true",
      model,
    });

    // تنسيق الإخراج إن طُلب ومختلف عن الافتراضي (png)
    const fmt = typeof input.output_format === "string" ? input.output_format : "";
    if (fmt && ["jpeg", "jpg", "webp"].includes(fmt)) {
      params.set("format", fmt === "jpg" ? "jpeg" : fmt);
    }

    const url = `${BASE}/${encodeURIComponent(prompt)}?${params.toString()}`;

    // التحقق من التوليد بـ GET خفيف (مهلة 75 ثانية — التوليد قد يأخذ وقتًا على الطبقة المجانية)
    const ok = await verifyImage(url, 75_000);
    if (!ok) {
      // فشل مؤقت (شبكة/حد/خادم مشغول) — رمِّ كـ temporary فينتقل المنسّق للمزود التالي
      // دون تعطيل Pollinations (يبقى نشطًا للمحاولات القادمة)
      throw new ProviderError(503, "Pollinations: تعذّر التوليد الآن (حد مؤقت أو شبكة)", true);
    }
    return { urls: [url] };
  },

  // Pollinations لا يدعم المهام غير المتزامنة — createTask/checkTask غير مستخدمة للصور
  // (المنسّق يستخدم createImageSync للصور). نوفّر implementات وهمية آمنة تحسبًا لأي نداء.
  async createTask() {
    throw new ProviderError(400, "Pollinations يدعم الصور المتزامنة فقط — لا مهام غير متزامنة");
  },
  async checkTask() {
    return { status: "failed", error: "Pollinations لا يدعم متابعة المهام" };
  },
};
