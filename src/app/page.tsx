"use client";

// لوحة الإدارة العربية RTL — ثلاث بطاقات: مدير المفاتيح، لوحة المهام، ربط السيرفر
// تتحدث تلقائيًا كل ~5 ثوانٍ بدون إعادة تحميل الصفحة
import { useCallback, useEffect, useRef, useState } from "react";

// ————— أنواع بيانات الواجهة —————

interface HealthInfo {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

interface KeyInfo {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface TaskInfo {
  id: string;
  type: string;
  status: string;
  model: string;
  provider: string | null;
  progress: number;
  prompt: string;
  urls: string[];
  errorMessage: string | null;
  attemptsCount: number;
  createdAt: string;
}

interface TasksResponse {
  stats: { total: number; completed: number; failed: number; processing: number };
  tasks: TaskInfo[];
}

const TOOLS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي — تُعاد رابطًا جاهزًا أو task_id للمتابعة" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي — image-to-video اختياري" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد نهائي بالترتيب المعطى" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وعرض روابط النتائج" },
  { name: "list_media", desc: "استرجاع أحدث الصور/الفيديوهات المخزنة بروابطها دون إعادة توليد" },
];

// ————— مساعدات عرض —————

const providerLabel: Record<string, string> = { kie: "kie.ai", cometapi: "CometAPI" };

const keyStatusLabel: Record<string, { text: string; cls: string }> = {
  active: { text: "نشط", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" },
  exhausted: { text: "مستنزف", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40" },
  disabled: { text: "معطل", cls: "bg-slate-500/15 text-slate-400 border-slate-500/40" },
};

const taskStatusLabel: Record<string, { text: string; cls: string }> = {
  processing: { text: "جارية", cls: "bg-sky-500/15 text-sky-300 border-sky-500/40" },
  pending: { text: "بانتظار", cls: "bg-sky-500/15 text-sky-300 border-sky-500/40" },
  completed: { text: "مكتملة", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" },
  failed: { text: "فاشلة", cls: "bg-rose-500/15 text-rose-300 border-rose-500/40" },
};

const taskTypeLabel: Record<string, string> = { image: "🖼️ صورة", video: "🎬 فيديو", merge: "🔗 دمج" };

function fmtTime(s: string | null): string {
  if (!s) return "—";
  const d = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (Number.isNaN(d)) return s;
  return new Date(d).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ————— الصفحة —————

export default function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [tasksData, setTasksData] = useState<TasksResponse | null>(null);
  const [mcpUrl, setMcpUrl] = useState("");
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [copied, setCopied] = useState<string | null>(null);

  // نموذج إضافة مفتاح
  const [newProvider, setNewProvider] = useState("kie");
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [h, k, t] = await Promise.all([
        fetch("/api/health").then((r) => r.json()),
        fetch("/api/keys").then((r) => r.json()),
        fetch("/api/tasks?limit=20").then((r) => r.json()),
      ]);
      setHealth(h as HealthInfo);
      setKeys(((k as { keys: KeyInfo[] }).keys) ?? []);
      setTasksData(t as TasksResponse);
    } catch {
      // تجاهل أخطاء الشبكة العابرة — التحديث التالي يعيد المحاولة
    }
  }, []);

  useEffect(() => {
    setMcpUrl(`${window.location.origin}/mcp`);
    void loadAll();
    const id = setInterval(() => void loadAll(), 5000);
    return () => clearInterval(id);
  }, [loadAll]);

  async function copyText(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // المتصفح رفض الوصول للحافظة
    }
  }

  async function addKey() {
    setBusy(true);
    setKeyMsg(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: newProvider, api_key: newKey.trim(), label: newLabel.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setKeyMsg({ text: data.error || "تعذر إضافة المفتاح", ok: false });
      } else {
        setKeyMsg({ text: "✅ تمت إضافة المفتاح بنجاح — سيُجرَّب أولًا في المهام القادمة", ok: true });
        setNewKey("");
        setNewLabel("");
        void loadAll();
      }
    } catch {
      setKeyMsg({ text: "خطأ في الاتصال بالسيرفر", ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function toggleKey(id: string, status: string) {
    await fetch(`/api/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: status === "disabled" ? "enable" : "disable" }),
    });
    void loadAll();
  }

  async function removeKey(id: string) {
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    void loadAll();
  }

  // ————— JSON جاهز للنسخ حسب التبويب —————

  const serverEntry: Record<string, unknown> = { url: mcpUrl };
  if (health?.authRequired) {
    serverEntry.headers = { Authorization: "Bearer <MCP_ACCESS_TOKEN>" };
  }

  const chatgptJson = JSON.stringify({ mcpServers: { "media-generator": serverEntry } }, null, 2);
  const claudeJson = JSON.stringify(
    { mcpServers: { "media-generator": { ...serverEntry, type: "http" } } },
    null,
    2,
  );
  const cursorJson = JSON.stringify({ mcpServers: { "media-generator": serverEntry } }, null, 2);

  const activeJson = tab === "chatgpt" ? chatgptJson : tab === "claude" ? claudeJson : cursorJson;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 space-y-8">
      {/* ————— الهيدر ————— */}
      <header className="rounded-2xl border border-slate-800 bg-gradient-to-l from-slate-900 via-slate-900 to-indigo-950/60 p-6 shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white">
              🎨 MCP Media Generator
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — لوحة إدارة عربية
            </p>
          </div>
          <div className="flex items-center gap-2">
            {health && (
              <>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold ${
                    health.ok
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${health.ok ? "bg-emerald-400" : "bg-rose-400"}`} />
                  {health.ok ? "Turso متصل" : "غير متصل"}
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold ${
                    health.merger.healthy
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                  }`}
                >
                  خدمة الدمج: {health.merger.healthy ? "جاهزة" : "غير مضبوطة"}
                </span>
                {health.authRequired && (
                  <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs font-bold text-violet-300">
                    /mcp محمي بـ Bearer token
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      {/* ————— أ) مدير المفاتيح ————— */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-bold text-white">🔑 مدير المفاتيح</h2>

        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr_1.4fr_auto]">
          <select
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
          >
            <option value="kie">kie.ai</option>
            <option value="cometapi">CometAPI</option>
          </select>
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="تسمية اختيارية (مثال: حساب رئيسي)"
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="ألصق مفتاح API هنا"
            type="password"
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <button
            onClick={() => void addKey()}
            disabled={busy || !newKey.trim()}
            className="rounded-lg bg-cyan-600 px-5 py-2 text-sm font-bold text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "جارٍ الإضافة…" : "إضافة مفتاح"}
          </button>
        </div>

        {keyMsg && (
          <p className={`mb-4 text-sm ${keyMsg.ok ? "text-emerald-300" : "text-rose-300"}`}>{keyMsg.text}</p>
        )}

        <p className="mb-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-3 py-2 text-xs leading-6 text-cyan-200">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري
          تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </p>

        {keys.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">لا توجد مفاتيح بعد — أضف أول مفتاح أعلاه.</p>
        ) : (
          <ul className="space-y-3">
            {keys.map((k, i) => {
              const st = keyStatusLabel[k.status] ?? keyStatusLabel.disabled;
              return (
                <li
                  key={k.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3"
                >
                  <span className="rounded-md bg-slate-800 px-2 py-1 text-xs font-bold text-slate-300">
                    #{i + 1}
                  </span>
                  <span className="rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1 text-xs font-bold text-slate-200">
                    {providerLabel[k.provider] ?? k.provider}
                  </span>
                  <code className="min-w-40 rounded bg-slate-800/60 px-2 py-1 font-mono text-xs text-slate-300" dir="ltr">
                    {k.masked}
                  </code>
                  <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${st.cls}`}>{st.text}</span>
                  {k.label && <span className="text-xs text-slate-400">{k.label}</span>}
                  <span className="text-xs text-slate-400" title="استخدام / نجاح / فشل">
                    استخدام {k.usageCount} · نجاح {k.successCount} · فشل {k.failCount}
                  </span>
                  {k.lastError && (
                    <span className="max-w-64 truncate text-xs text-rose-300/80" title={k.lastError}>
                      آخر خطأ: {k.lastError}
                    </span>
                  )}
                  <span className="ms-auto flex items-center gap-2">
                    <button
                      onClick={() => void toggleKey(k.id, k.status)}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-bold text-slate-300 transition hover:bg-slate-800"
                    >
                      {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                    </button>
                    <button
                      onClick={() => void removeKey(k.id)}
                      className="rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-bold text-rose-300 transition hover:bg-rose-500/10"
                    >
                      حذف
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ————— ب) لوحة المهام ————— */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-lg">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-white">📋 لوحة المهام</h2>
          {tasksData && (
            <div className="flex flex-wrap gap-2 text-xs font-bold">
              <span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-slate-300">
                إجمالي {tasksData.stats.total}
              </span>
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-emerald-300">
                مكتملة {tasksData.stats.completed}
              </span>
              <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-3 py-1 text-rose-300">
                فاشلة {tasksData.stats.failed}
              </span>
              <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-3 py-1 text-sky-300">
                جارية {tasksData.stats.processing}
              </span>
            </div>
          )}
        </div>

        {!tasksData || tasksData.tasks.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            لا توجد مهام بعد — المهمة الأولى ستظهر هنا تلقائيًا.
          </p>
        ) : (
          <ul className="space-y-3">
            {tasksData.tasks.map((t) => {
              const st = taskStatusLabel[t.status] ?? taskStatusLabel.processing;
              return (
                <li key={t.id} className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-slate-200">{taskTypeLabel[t.type] ?? t.type}</span>
                    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${st.cls}`}>{st.text}</span>
                    <span className="font-mono text-xs text-slate-500" dir="ltr">
                      {t.model}
                    </span>
                    <span className="text-xs text-slate-500">⏱ {fmtTime(t.createdAt)}</span>
                    {t.attemptsCount > 1 && (
                      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-bold text-amber-300">
                        محاولات: {t.attemptsCount}
                      </span>
                    )}
                    <span className="font-mono text-xs text-slate-600" dir="ltr" title={t.id}>
                      {t.id.slice(0, 8)}…
                    </span>
                  </div>
                  {t.prompt && <p className="mt-1.5 text-xs leading-6 text-slate-400">{t.prompt}</p>}
                  {t.status === "processing" && (
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-l from-cyan-500 to-violet-500 transition-all duration-500"
                        style={{ width: `${Math.max(4, t.progress)}%` }}
                      />
                    </div>
                  )}
                  {t.status === "completed" && t.urls.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {t.urls.map((u, i) => (
                        <a
                          key={i}
                          href={u}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300 transition hover:bg-emerald-500/20"
                        >
                          {t.type === "image" ? "🖼️ فتح الصورة" : "▶️ فتح الفيديو"} {t.urls.length > 1 ? `(${i + 1})` : ""}
                        </a>
                      ))}
                    </div>
                  )}
                  {t.status === "failed" && t.errorMessage && (
                    <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-1.5 text-xs leading-6 text-rose-300">
                      {t.errorMessage}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ————— ج) ربط السيرفر ————— */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-bold text-white">🔌 ربط السيرفر بأي عميل MCP</h2>

        <div className="mb-4 flex items-center gap-2">
          <input
            readOnly
            value={mcpUrl}
            dir="ltr"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-cyan-300"
          />
          <button
            onClick={() => void copyText(mcpUrl, "url")}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white transition hover:bg-slate-600"
          >
            {copied === "url" ? "✅ تم النسخ" : "نسخ الرابط"}
          </button>
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          {(
            [
              ["chatgpt", "ChatGPT / GPT Agents"],
              ["claude", "Claude Desktop"],
              ["cursor", "Cursor / Windsurf / Cline"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-lg px-4 py-1.5 text-xs font-bold transition ${
                tab === id
                  ? "bg-cyan-600 text-white"
                  : "border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="relative">
          <pre className="code-block overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-slate-300">
            {activeJson}
          </pre>
          <button
            onClick={() => void copyText(activeJson, `json-${tab}`)}
            className="absolute left-3 top-3 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-bold text-slate-200 transition hover:bg-slate-700"
          >
            {copied === `json-${tab}` ? "✅ تم" : "نسخ"}
          </button>
        </div>

        {tab === "chatgpt" && (
          <p className="mt-2 text-xs leading-6 text-slate-400">
            في ChatGPT: <b>Settings → Connectors → Create</b> → Custom MCP server — ضع الرابط أعلاه في
            «Server URL» ثم احفظ.
          </p>
        )}
        {tab === "claude" && (
          <p className="mt-2 text-xs leading-6 text-slate-400">
            الصق الكود في ملف <code dir="ltr">claude_desktop_config.json</code> ثم أعد تشغيل التطبيق.
          </p>
        )}
        {tab === "cursor" && (
          <p className="mt-2 text-xs leading-6 text-slate-400">
            الصق الكود في <code dir="ltr">mcp.json</code> (Cursor: Settings → MCP → Add new global MCP server).
          </p>
        )}

        {/* رقائق الأدوات الخمس */}
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-bold text-slate-300">الأدوات الخمس المتاحة على السيرفر</h3>
          <div className="flex flex-wrap gap-2">
            {TOOLS.map((tool) => (
              <div
                key={tool.name}
                className="rounded-xl border border-violet-500/30 bg-violet-500/5 px-3 py-2"
                title={tool.desc}
              >
                <code className="text-xs font-bold text-violet-300" dir="ltr">
                  {tool.name}
                </code>
                <p className="mt-1 max-w-72 text-[11px] leading-5 text-slate-400">{tool.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ملاحظة كهرمانية */}
        <div className="mt-5 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-xs leading-6 text-amber-200">
          ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر <b>task_id</b> فورًا، ويتابَع تلقائيًا بـ{" "}
          <b>get_task</b> كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء
          الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية. ومهام الدمج تُحذف
          ملفاتها من خدمة الدمج بعد ~24 ساعة — نزّلها سريعًا.
        </div>
      </section>

      <footer className="pb-6 text-center text-xs text-slate-600">
        MCP Media Generator v1.2.0 — مفاتيحك مخفية دائمًا ولا تُعاد كاملة في أي استجابة.
      </footer>
    </main>
  );
}
