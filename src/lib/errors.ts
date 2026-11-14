// تصنيف موحد لأخطاء المزودين — قلب سياسة التبديل التسلسلي (قسم 4.2 من المواصفة)

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// خطأ يرميه أي مزود/خدمة خارجية — status قد يكون كود HTTP أو كود مخصص للمزود
export class ProviderError extends Error {
  constructor(
    public status: number,
    public message: string,
    public networkError = false, // انقطاع شبكة/timeout من جهتنا نحن
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// خطأ معطيات من المستخدم نفسه (موديل مجهول، روابط ناقصة...) — يوقف كل شيء فورًا
export class ParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamsError";
  }
}

// أنماط الرسائل — تُفحص بأحرف صغيرة على نص الرسالة كاملًا
// نفاد الرصيد يُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400
const EXHAUSTED_PATTERNS = [
  "insufficient",
  "quota",
  "balance",
  "credit",
  "out of credits",
  "exhausted",
  "充值",
  "余额不足",
];

const DISABLED_PATTERNS = [
  "invalid api key",
  "invalid_api_key",
  "invalid key",
  "unauthorized",
  "forbidden",
  "authentication",
  "api key not valid",
  "incorrect api key",
];

const PROVIDER_PATTERNS = [
  "model not found",
  "unsupported model",
  "unknown model",
  "model does not exist",
  "not a valid model",
  "no such model",
];

function matches(message: string, patterns: string[]): boolean {
  const m = message.toLowerCase();
  return patterns.some((p) => m.includes(p));
}

// تصنيف خطأ مزود إلى فئة واحدة حسب جدول 4.2:
// disabled → المفتاح مرفوض، يُعطَّل تلقائيًا وينتقل للتالي
// exhausted → نفاد رصيد، يُعلَّم ويبقى في القاعدة وينتقل للتالي
// provider → الموديل غير مدعوم لدى هذا المزود، ينتقل للتالي
// params → خطأ معطيات الطلب، توقف فورًا (تبديل المفاتيح لن يحل شيئًا)
// temporary → 429/5xx/شبكة — انتقل للتالي الآن مع بقاء المفتاح سليمًا
export function classifyProviderError(
  status: number,
  message: string,
  networkError = false,
): ErrorClass {
  const msg = message || "";

  // نفاد الرصيد أولًا — قبل فحص 400 (بعض المزودين يرسلونه بحالة 400)
  if (matches(msg, EXHAUSTED_PATTERNS)) return "exhausted";

  // مفتاح مرفوض
  if (status === 401 || status === 403) return "disabled";
  if (matches(msg, DISABLED_PATTERNS)) return "disabled";

  if (status === 402) return "exhausted";

  // موديل غير مدعوم لدى هذا المزود
  if (matches(msg, PROVIDER_PATTERNS) && [400, 404, 422].includes(status)) return "provider";

  // معطيات الطلب تالفة — فشل حتمي
  if ([400, 404, 422].includes(status)) return "params";

  // أخطاء مؤقتة: 429 أو 5xx أو انقطاع شبكة/timeout
  if (status === 429 || status >= 500 || networkError || status === 0) return "temporary";

  // أي شيء آخر غير متوقع → نعتبره مؤقتًا وننتقل للمفتاح التالي بدل التوقف
  return "temporary";
}

// تصنيف مباشر لكائن خطأ (يشمل أخطاء الشبكة التي لا تحمل status)
export function classifyError(e: unknown): ErrorClass {
  if (e instanceof ProviderError) {
    return classifyProviderError(e.status, e.message, e.networkError);
  }
  // fetch timeout / abort / أي استثناء شبكة → مؤقت
  return "temporary";
}
