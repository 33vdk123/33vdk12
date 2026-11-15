// صفحة حالة بسيطة — لا قاعدة بيانات، لا إدارة مفاتيح.
// الصور مجانية دائمًا (Pollinations). الفيديو/الدمج اختياريان.
"use client";

import { useEffect, useState } from "react";

interface Health {
  ok: boolean;
  images: string;
  video: string;
  merge: string;
  mcpEndpoint: string;
  authRequired: boolean;
}

const TOOLS = [
  { name: "generate_image", desc: "توليد صورة مجانية فورًا عبر Pollinations.ai — بلا مفتاح", free: true },
  { name: "generate_video", desc: "توليد فيديو عبر CometAPI — يتطلب COMETAPI_KEY", free: false },
  { name: "merge_videos", desc: "دمج مقاطع فيديو — يتطلب MERGER_API_BASE", free: false },
  { name: "get_task", desc: "تتبع مهمة جارية بمعرّفها المركّب", free: false },
  { name: "list_media", desc: "عديم الحالة — لا سجل محفوظ", free: false },
];

export default function Home() {
  const [h, setH] = useState<Health | null>(null);
  const [mcpUrl, setMcpUrl] = useState("");

  useEffect(() => {
    setMcpUrl(`${window.location.origin}/mcp`);
    fetch("/api/health").then((r) => r.json()).then(setH).catch(() => {});
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 space-y-8">
      <header className="rounded-2xl border border-slate-800 bg-gradient-to-l from-slate-900 to-indigo-950/60 p-6">
        <h1 className="text-2xl font-extrabold text-white">🎨 MCP Media Generator v2.0</h1>
        <p className="mt-1 text-sm text-slate-400">
          نسخة مبسّطة عديمة الحالة — صور مجانية دائمًا، فيديو/دمج اختياري
        </p>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
        <h2 className="mb-4 text-lg font-bold text-white">🔌 ربط السيرفر</h2>
        <div className="flex items-center gap-2">
          <input readOnly value={mcpUrl} dir="ltr" className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-cyan-300" />
          <button
            onClick={() => navigator.clipboard.writeText(mcpUrl)}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white hover:bg-slate-600"
          >
            نسخ
          </button>
        </div>
        <pre className="mt-3 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-slate-300" dir="ltr">
{JSON.stringify({ mcpServers: { "media-generator": { url: mcpUrl, ...(h?.authRequired ? { headers: { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } } : {}) } } }, null, 2)}
        </pre>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
        <h2 className="mb-4 text-lg font-bold text-white">📊 حالة المزودين</h2>
        {h ? (
          <ul className="space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${h.images === "ready" ? "bg-emerald-400" : "bg-rose-400"}`} />
              <span className="text-slate-300">الصور (Pollinations):</span>
              <span className={h.images === "ready" ? "text-emerald-300" : "text-rose-300"}>
                {h.images === "ready" ? "✅ مجاني وجاهز" : "❌ غير متاح"}
              </span>
            </li>
            <li className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${h.video === "configured" ? "bg-emerald-400" : "bg-amber-400"}`} />
              <span className="text-slate-300">الفيديو (CometAPI):</span>
              <span className={h.video === "configured" ? "text-emerald-300" : "text-amber-300"}>
                {h.video === "configured" ? "✅ مفعّل (COMETAPI_KEY مضبوط)" : "⚠️ غير مفعّل — أضف COMETAPI_KEY"}
              </span>
            </li>
            <li className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${h.merge === "configured" ? "bg-emerald-400" : "bg-amber-400"}`} />
              <span className="text-slate-300">الدمج:</span>
              <span className={h.merge === "configured" ? "text-emerald-300" : "text-amber-300"}>
                {h.merge === "configured" ? "✅ مفعّل" : "⚠️ غير مفعّل — أضف MERGER_API_BASE"}
              </span>
            </li>
          </ul>
        ) : (
          <p className="text-sm text-slate-500">جارٍ التحقق…</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
        <h2 className="mb-4 text-lg font-bold text-white">🛠️ الأدوات الخمس</h2>
        <div className="grid gap-2">
          {TOOLS.map((t) => (
            <div key={t.name} className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-2">
              <code className="text-sm font-bold text-violet-300" dir="ltr">{t.name}</code>
              {t.free && <span className="ms-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-300">مجاني</span>}
              <p className="mt-1 text-xs text-slate-400">{t.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-xs leading-6 text-emerald-200">
        🆓 <b>الصور تعمل الآن مجانًا</b> — نادرًا ما يحتاج الذكاء الاصطناعي لأكثر من generate_image.
        للفيديو: سجّل في cometapi.com (بريد فقط بلا بطاقة)، أنشئ مفتاحًا، وأضفه كـ COMETAPI_KEY في Vercel.
      </p>

      <footer className="pb-6 text-center text-xs text-slate-600">v2.0 — مبسّط وعديم الحالة</footer>
    </main>
  );
}
