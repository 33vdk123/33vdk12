// سجل الموديلات — الأسماء الموحدة كما يراها عميل MCP مع صيغ بديلة ومزودين لكل موديل
// الأسماء قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL، COMETAPI_VIDEO_MODEL، ...)

// Pollinations مزود مجاني بلا مفاتيح — يُجرَّب أولًا للصور، فإن فشل انتقل المنسّق للمزودين المدفوعين.
// لا يدعم الفيديو، لذلك يظهر فقط في قائمة providers لموديل الصورة.
export type ProviderId = "pollinations" | "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  // Partial: الموديلات التي لا يدعمها مزود معيّن (مثل الفيديو لـ Pollinations) لا تحتاج إدخالًا
  providerModel: Partial<Record<ProviderId, string>>; // اسم الموديل كما يُرسل لكل مزود
}

// اسم الموديل لدى Pollinations — قابل للتجاوز بمتغير بيئة (الافتراضي flux عالي الجودة)
const POLLINATIONS_IMAGE_MODEL = process.env.POLLINATIONS_IMAGE_MODEL || "flux";
// اسم الموديل لدى kie — قابل للتجاوز بمتغير بيئة
const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    canonical: KIE_IMAGE_MODEL,
    aliases: ["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"],
    type: "image",
    // الترتيب مهم: Pollinations أولًا (مجاني) ثم kie ثم cometapi
    providers: ["pollinations", "kie", "cometapi"],
    providerModel: {
      pollinations: POLLINATIONS_IMAGE_MODEL,
      kie: KIE_IMAGE_MODEL,
      cometapi: COMETAPI_IMAGE_MODEL,
    },
  },
  {
    canonical: KIE_VIDEO_MODEL,
    aliases: ["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"],
    type: "video",
    // Pollinations لا يدعم الفيديو — غير مدرج هنا
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

// البحث عن موديل بالاسم (canonical أو alias) — غير الحالة ونوّحّد الصيغ
export function resolveModel(name: string): ModelDef | null {
  const clean = (name || "").trim().toLowerCase();
  if (!clean) return null;
  for (const m of MODELS) {
    if (m.canonical.toLowerCase() === clean) return m;
    if (m.aliases.some((a) => a.toLowerCase() === clean)) return m;
  }
  // مطابقة مرنة: توحيد النقاط والشرطات (gpt-image-2.6 ←→ gpt-image-2-6)
  const normalized = clean.replace(/\./g, "-");
  for (const m of MODELS) {
    if (m.canonical.toLowerCase().replace(/\./g, "-") === normalized) return m;
    if (m.aliases.some((a) => a.toLowerCase().replace(/\./g, "-") === normalized)) return m;
  }
  return null;
}

// الموديلات المتاحة للعرض في health والأدوات
export function availableModels(): { canonical: string; type: MediaType; providers: ProviderId[] }[] {
  return MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers }));
}
