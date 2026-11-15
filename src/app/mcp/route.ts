// ════════════════════════════════════════════════════════════════════════
// خادم MCP واحد مكتفٍ ذاتياً — بلا قاعدة بيانات، بلا مفاتيح للصور.
//
// المزودون:
//   • الصور: Pollinations.ai (مجاني 100%، بلا تسجيل/مفتاح) — يعمل دائمًا.
//   • الفيديو: CometAPI (اختياري — إن ضُبط COMETAPI_KEY) — توليد متزامن داخل الطلب.
//   • الدمج: خدمة دمج (اختياري — إن ضُبط MERGER_API_BASE).
//
// عديم الحالة (stateless): المهمات غير المتزامنة تُرمّز في task_id مركّب:
//   cometapi:<providerTaskId>  →  get_task يستعلم CometAPI مباشرة
//   merge:<jobId>              →  get_task يستعلم خدمة الدمج مباشرة
// لا حاجة لأي قاعدة بيانات — العميل يحتفظ بالـ task_id ويمرّره لـ get_task.
// ════════════════════════════════════════════════════════════════════════
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// توليد الفيديو قد يأخذ دقائق — نافذة 300 ثانية متوافقة مع خطة Vercel
export const maxDuration = 300;

// ————— متغيرات البيئة الاختيارية —————
const COMETAPI_KEY = process.env.COMETAPI_KEY || "";
const COMETAPI_BASE = "https://api.cometapi.com";
const MERGER_BASE = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");
const POLLINATIONS_MODEL = process.env.POLLINATIONS_IMAGE_MODEL || "flux";

// ————— مساعدات عامة —————
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

// بث التقدم الحي للعميل إن زوّد progressToken
function progressBridge(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): (progress: number, total: number, message: string) => Promise<void> {
  const token = (extra._meta as { progressToken?: string | number } | undefined)?.progressToken;
  if (token === undefined) return async () => {};
  return async (progress, total, message) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      } as ServerNotification);
    } catch {
      // تجاهل — الإشعارات لا تعطل العملية
    }
  };
}

// ════════════════════════════════════════════════════════════════════════
// 1) توليد الصور — Pollinations.ai (مجاني دائمًا، بلا مفتاح)
// ════════════════════════════════════════════════════════════════════════
const ASPECT_RATIOS: Record<string, [number, number]> = {
  auto: [1, 1], "1:1": [1, 1], "3:2": [3, 2], "2:3": [2, 3], "4:3": [4, 3], "3:4": [3, 4],
  "5:4": [5, 4], "4:5": [4, 5], "16:9": [16, 9], "9:16": [9, 16], "2:1": [2, 1], "1:2": [1, 2],
  "21:9": [21, 9], "9:21": [9, 21], "3:1": [3, 1], "1:3": [1, 3],
};

function dimsFor(aspect: string, resolution: string): { width: number; height: number } {
  const [rw, rh] = ASPECT_RATIOS[aspect] ?? [1, 1];
  const base = resolution === "4K" || resolution === "2K" ? 1536 : 1024;
  const landscape = rw >= rh;
  const w = landscape ? base : Math.round((base * rw) / rh);
  const h = landscape ? Math.round((base * rh) / rw) : base;
  const clampEven = (n: number) => Math.max(256, Math.min(2048, n % 2 === 0 ? n : n + 1));
  return { width: clampEven(w), height: clampEven(h) };
}

async function pollinationsImage(
  prompt: string,
  aspect: string,
  resolution: string,
  outputFormat: string,
): Promise<string> {
  if (!prompt) throw new Error("وصف الصورة فارغ");
  const { width, height } = dimsFor(aspect, resolution);
  const seed = Math.floor(Math.random() * 1_000_000);
  const params = new URLSearchParams({
    width: String(width), height: String(height), seed: String(seed),
    nologo: "true", model: POLLINATIONS_MODEL,
  });
  if (["jpeg", "jpg", "webp"].includes(outputFormat)) {
    params.set("format", outputFormat === "jpg" ? "jpeg" : outputFormat);
  }
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
  // التحقق من التوليد بـ GET خفيف — نقرأ الترويسات ثم نلغي الستريم (لا نخزّن بايتات)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Referer: "https://mcp-media-generator.vercel.app", Accept: "image/*" },
    });
    try { await res.body?.cancel(); } catch {}
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.startsWith("image/")) {
      throw new Error("Pollinations: تعذّر التوليد الآن (حد مؤقت أو شبكة)");
    }
    return url;
  } finally {
    clearTimeout(timer);
  }
}

// ════════════════════════════════════════════════════════════════════════
// 2) توليد الفيديو — CometAPI (اختياري، إن ضُبط COMETAPI_KEY)
// ════════════════════════════════════════════════════════════════════════
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

async function cometapiCreateTask(
  input: Record<string, unknown>,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(`${COMETAPI_BASE}/v1/video/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${COMETAPI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: COMETAPI_VIDEO_MODEL, input }),
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const msg = String(body.error || body.message || `HTTP ${res.status}`);
      throw new Error(`CometAPI إنشاء مهمة: ${msg}`);
    }
    const id = String(body.task_id ?? (body.data as Record<string, unknown>)?.task_id ?? "");
    if (!id) throw new Error("CometAPI: استجابة بلا معرف مهمة");
    return id;
  } finally {
    clearTimeout(timer);
  }
}

async function cometapiCheckTask(taskId: string): Promise<{
  status: "processing" | "completed" | "failed";
  url?: string;
  error?: string;
  progress: number;
}> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(`${COMETAPI_BASE}/v1/video/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${COMETAPI_KEY}` },
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const d = (body.data ?? body) as Record<string, unknown>;
    const status = String(d?.status ?? "").toLowerCase();
    const url = d?.video_url ?? d?.url;
    if (["success", "completed", "complete", "succeeded", "finished", "done"].includes(status)) {
      return { status: "completed", url: typeof url === "string" ? url : undefined, progress: 100 };
    }
    if (["fail", "failed", "error", "cancelled"].includes(status)) {
      return { status: "failed", error: String(d?.error || body.error || "فشل التوليد"), progress: 0 };
    }
    return { status: "processing", progress: 50 };
  } finally {
    clearTimeout(timer);
  }
}

// ════════════════════════════════════════════════════════════════════════
// 3) دمج الفيديو — خدمة الدمج (اختياري، إن ضُبط MERGER_API_BASE)
// ════════════════════════════════════════════════════════════════════════
async function mergerCreateJob(videos: string[]): Promise<string> {
  const res = await fetch(`${MERGER_BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.error) throw new Error(String(body.error || `HTTP ${res.status}`));
  if (!body.jobId) throw new Error("خدمة الدمج: استجابة بلا jobId");
  // أطلق المعالجة خلفيًا (مرة واحدة)
  void fetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(String(body.jobId))}/process`, {
    method: "POST",
    signal: AbortSignal.timeout(320_000),
  }).catch(() => {});
  return String(body.jobId);
}

async function mergerCheckJob(jobId: string): Promise<{
  status: "processing" | "completed" | "failed";
  url?: string;
  error?: string;
  progress: number;
}> {
  const res = await fetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) {
    return { status: "failed", error: "مهمة الدمج غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)", progress: 0 };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { status: "failed", error: String(body.error || `HTTP ${res.status}`), progress: 0 };
  if (body.error && !body.status) return { status: "failed", error: String(body.error), progress: 0 };
  const raw = String(body.status ?? "").toLowerCase();
  const pr = Number(body.progress ?? 0);
  const progress = Math.max(0, Math.min(100, Math.round(pr <= 1 ? pr * 100 : pr)));
  if (["error", "failed", "failure", "cancelled"].includes(raw)) {
    return { status: "failed", error: String(body.error || "فشل الدمج"), progress };
  }
  if (["done", "completed", "complete", "success", "succeeded", "finished"].includes(raw)) {
    const url = (typeof body.videoUrl === "string" && body.videoUrl) ||
      (typeof body.downloadUrl === "string" && body.downloadUrl) ||
      `${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}/video`;
    return { status: "completed", url, progress: 100 };
  }
  return { status: "processing", progress };
}

// ════════════════════════════════════════════════════════════════════════
// بناء خادم MCP وتسجيل الأدوات الخمس
// ════════════════════════════════════════════════════════════════════════
const SERVER_INFO = { name: "media-generator-mcp", version: "2.0.0" } as const;

const SERVER_INSTRUCTIONS = `AI media generation server (v2.0 — simplified, stateless, no database).
Images: FREE via Pollinations.ai (no key, no signup) — always works.
Video: via CometAPI (optional — works only if COMETAPI_KEY env is set on the server).
Merge: via merging service (optional — works only if MERGER_API_BASE env is set).
Workflow: call generate_image (free, returns the image URL immediately). For video, call generate_video — if it finishes within the wait window you get the URL directly; otherwise you get a task_id like "cometapi:abc123" — call get_task with it every ~10s until completed. Same for merge_videos (task_id like "merge:xyz").
get_task accepts composite task_ids: "cometapi:<id>" or "merge:<id>". list_media returns nothing (stateless mode).`;

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // ————— 1) generate_image — Pollinations مجاني —————
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image via Pollinations.ai — FREE, no API key needed, always works. Returns the image URL directly. Detailed prompts give better results.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
      },
    },
    async (args) => {
      try {
        const url = await pollinationsImage(args.prompt, args.aspect_ratio, args.resolution, args.output_format);
        return textResult(`✅ تم توليد الصورة بنجاح (مجاني عبر Pollinations.ai)\n\n![image](${url})\n\nالرابط المباشر: ${url}`);
      } catch (e) {
        return textResult(`❌ فشل توليد الصورة: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    },
  );

  // ————— 2) generate_video — CometAPI (اختياري) —————
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video via CometAPI. Requires COMETAPI_KEY to be set on the server (otherwise returns a clear message). Returns the video URL if finished within the wait window, otherwise a task_id like 'cometapi:<id>' — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      if (!COMETAPI_KEY) {
        return textResult(
          "❌ توليد الفيديو غير مُفعّل — لم يُضبط المتغير COMETAPI_KEY على السيرفر.\n\n" +
          "لتفعيله: سجّل في cometapi.com (بريد فقط، بلا بطاقة)، أنشئ مفتاح API، ثم أضفه كمتغير بيئة COMETAPI_KEY في إعدادات Vercel.\n\n" +
          "الصور تعمل مجانًا الآن عبر generate_image.",
          true,
        );
      }
      const onProgress = progressBridge(extra);
      try {
        const input: Record<string, unknown> = {
          prompt: args.prompt,
          aspect_ratio: args.aspect_ratio === "auto" ? undefined : args.aspect_ratio,
          resolution: args.resolution,
          enable_audio: args.enable_audio,
          duration: args.duration,
        };
        if (args.image_url) input.image_url = args.image_url;
        // احذف القيم undefined
        for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];

        const providerTaskId = await cometapiCreateTask(input);
        await onProgress(10, 100, "تم إنشاء المهمة لدى CometAPI");

        // استعلام داخل نافذة الانتظار
        const deadline = Date.now() + args.wait_seconds * 1000;
        while (Date.now() < deadline) {
          const r = await cometapiCheckTask(providerTaskId);
          if (r.status === "completed" && r.url) {
            await onProgress(100, 100, "اكتمل التوليد");
            return textResult(`✅ تم توليد الفيديو بنجاح\n\nالروابط المباشرة:\n- ${r.url}`);
          }
          if (r.status === "failed") {
            return textResult(`❌ فشل توليد الفيديو: ${r.error || "سبب غير معروف"}`, true);
          }
          await onProgress(r.progress, 100, `قيد التوليد… ${r.progress}%`);
          if (Date.now() + 3000 > deadline) break;
          await sleep(3000);
        }
        // انتهت النافذة دون اكتمال → أعد task_id مركّب للمتابعة
        return textResult(
          `⏳ المهمة قيد المعالجة — task_id: cometapi:${providerTaskId}\n\n` +
          `تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
        );
      } catch (e) {
        return textResult(`❌ فشل توليد الفيديو: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    },
  );

  // ————— 3) merge_videos — خدمة الدمج (اختياري) —————
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several video clips into one final video in the given order. Requires MERGER_API_BASE to be set on the server. Pass 'urls' (direct video links) — 2 to 10 items. Returns the merged video URL if finished within the wait window, otherwise a task_id like 'merge:<id>'. Note: merged files are deleted after ~24 hours — download promptly.",
      inputSchema: {
        urls: z.array(z.string()).min(2).max(10).describe("Public direct video URLs, 2–10 items, in merge order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      if (!/^https?:\/\//.test(MERGER_BASE)) {
        return textResult(
          "❌ الدمج غير مُفعّل — لم يُضبط المتغير MERGER_API_BASE على السيرفر.\n\n" +
          "لتفعيله: انشر خدمة الدمج وأضف رابطها كمتغير MERGER_API_BASE في Vercel.",
          true,
        );
      }
      const onProgress = progressBridge(extra);
      try {
        if (args.urls.length < 2 || args.urls.length > 10) {
          return textResult("❛ الدمج يتطلب 2 إلى 10 مقاطع", true);
        }
        const jobId = await mergerCreateJob(args.urls);
        await onProgress(15, 100, "تم إنشاء مهمة الدمج");

        const deadline = Date.now() + args.wait_seconds * 1000;
        while (Date.now() < deadline) {
          const r = await mergerCheckJob(jobId);
          if (r.status === "completed" && r.url) {
            await onProgress(100, 100, "اكتمل الدمج");
            return textResult(
              `✅ تم دمج المقاطع بنجاح\n\nالروابط المباشرة:\n- ${r.url}\n\n` +
              `⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — نزّله سريعًا.`,
            );
          }
          if (r.status === "failed") {
            return textResult(`❌ فشل الدمج: ${r.error || "سبب غير معروف"}`, true);
          }
          await onProgress(r.progress, 100, `قيد الدمج… ${r.progress}%`);
          if (Date.now() + 3000 > deadline) break;
          await sleep(3000);
        }
        return textResult(`⏳ الدمج قيد المعالجة — task_id: merge:${jobId}\n\nتابع بـ get_task كل ~10 ثوانٍ.`);
      } catch (e) {
        return textResult(`❌ فشل الدمج: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    },
  );

  // ————— 4) get_task — استعلام مباشر عبر task_id مركّب —————
  server.registerTool(
    "get_task",
    {
      description:
        "Track a task by its composite task_id. For video: 'cometapi:<id>' (returned by generate_video). For merge: 'merge:<id>' (returned by merge_videos). Polls the provider directly — no database. Poll every ~10 seconds until completed.",
      inputSchema: {
        task_id: z.string().describe("Composite task_id: 'cometapi:<id>' or 'merge:<id>'."),
      },
    },
    async (args) => {
      const tid = args.task_id || "";
      try {
        if (tid.startsWith("cometapi:")) {
          if (!COMETAPI_KEY) return textResult("❌ COMETAPI_KEY غير مضبوط — لا يمكن متابعة مهمة الفيديو", true);
          const id = tid.slice("cometapi:".length);
          const r = await cometapiCheckTask(id);
          if (r.status === "completed" && r.url) {
            return textResult(`✅ تم توليد الفيديو بنجاح\n\nالروابط المباشرة:\n- ${r.url}`);
          }
          if (r.status === "failed") {
            return textResult(`❌ فشل توليد الفيديو: ${r.error || "سبب غير معروف"}`, true);
          }
          return textResult(`⏳ المهمة قيد المعالجة — task_id: ${tid}\n\nالتقدم: ${r.progress}%\nتابع بـ get_task كل ~10 ثوانٍ.`);
        }
        if (tid.startsWith("merge:")) {
          if (!/^https?:\/\//.test(MERGER_BASE)) return textResult("❌ MERGER_API_BASE غير مضبوط", true);
          const id = tid.slice("merge:".length);
          const r = await mergerCheckJob(id);
          if (r.status === "completed" && r.url) {
            return textResult(
              `✅ تم دمج المقاطع بنجاح\n\nالروابط المباشرة:\n- ${r.url}\n\n⚠️ ملف الدمج يُحذف بعد ~24 ساعة — نزّله سريعًا.`,
            );
          }
          if (r.status === "failed") {
            return textResult(`❌ فشل الدمج: ${r.error || "سبب غير معروف"}`, true);
          }
          return textResult(`⏳ الدمج قيد المعالجة — task_id: ${tid}\n\nالتقدم: ${r.progress}%\nتابع بـ get_task كل ~10 ثوانٍ.`);
        }
        return textResult(
          `❌ صيغة task_id غير صالحة: ${tid}\n\nالصيغ المقبولة: 'cometapi:<id>' أو 'merge:<id>' — تُعاد من generate_video أو merge_videos.`,
          true,
        );
      } catch (e) {
        return textResult(`❌ خطأ في الاستعلام: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    },
  );

  // ————— 5) list_media — عديم الحالة —————
  server.registerTool(
    "list_media",
    {
      description: "In stateless mode (no database), no history is kept. This tool returns a note explaining that. Use generate_image / generate_video to create new media.",
      inputSchema: {},
    },
    async () => {
      return textResult(
        "ℹ️ النسخة الحالية عديمة الحالة (بلا قاعدة بيانات) — لا يُحتفظ بسجل للوسائط السابقة.\n\n" +
        "استخدم generate_image (مجاني فورًا عبر Pollinations) أو generate_video لإنشاء وسائط جديدة.\n" +
        "لتتبع مهمة جارية استخدم get_task مع الـ task_id المركّب الذي أعاده generate_video أو merge_videos.",
      );
    },
  );

  return server;
}

// ════════════════════════════════════════════════════════════════════════
// نقلة Streamable HTTP — عديمة الجلسة (متوافقة مع Vercel serverless)
// ════════════════════════════════════════════════════════════════════════
function authorized(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  return (req.headers.get("authorization") || "") === `Bearer ${token}`;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: MCP_ACCESS_TOKEN required" }, id: null }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

async function handleWithTransport(req: Request, parsedBody?: unknown): Promise<Response> {
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return await transport.handleRequest(req, { parsedBody: parsedBody as never });
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) return unauthorized();
  let parsedBody: unknown;
  try {
    parsedBody = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  return await handleWithTransport(req, parsedBody);
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return unauthorized();
  return await handleWithTransport(req);
}

export async function DELETE(req: Request): Promise<Response> {
  if (!authorized(req)) return unauthorized();
  return await handleWithTransport(req);
}
