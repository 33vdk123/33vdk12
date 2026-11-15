// خادم MCP — الأدوات الخمس وصياغة الردود العربية (قسم 8 من المواصفة)
// نستخدم SDK الرسمي: McpServer + نقلة Streamable HTTP بمعايير الويب (متوافقة مع Next.js وVercel)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runGeneration, refreshTask, NoKeysError } from "./generation";
import { runMerge } from "./mergeFlow";
import { listRecentTasks, taskResultUrls, taskAttempts, type DbTask } from "./turso";
import { ParamsError } from "./errors";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

// نص الإرشادات الجاهز يُرسل مع initialize — يقرأه نموذج الذكاء الاصطناعي
export const SERVER_INSTRUCTIONS = `AI media generation server (Pollinations.ai free tier + kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Images are served FREE by Pollinations.ai first (no key, no balance consumed); if it is temporarily unavailable the server automatically falls back to kie.ai/CometAPI keys. Videos use kie.ai/CometAPI only.
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys/providers in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// ————— صياغة الردود العربية —————

function formatCompleted(t: DbTask): string {
  const urls = taskResultUrls(t);
  const links = urls.map((u) => `- ${u}`).join("\n");
  if (t.type === "image") {
    return `✅ تم توليد الصورة بنجاح\n\n![image](${urls[0]})\n\nالرابط المباشر: ${urls[0]}`;
  }
  if (t.type === "video") {
    return `✅ تم توليد الفيديو بنجاح\n\nالروابط المباشرة:\n${links}`;
  }
  // الدمج — مع تحذير الحذف بعد 24 ساعة (إلزامي حرفيًا حسب المواصفة)
  return `✅ تم دمج المقاطع بنجاح\n\nالروابط المباشرة:\n${links}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
}

function formatProcessing(t: DbTask): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${t.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function formatFailed(t: DbTask): string {
  return t.error_message || "❌ فشلت المهمة: سبب غير معروف";
}

// صياغة أي مهمة حسب حالتها
function formatTask(t: DbTask): { text: string; isError: boolean } {
  if (t.status === "completed") return { text: formatCompleted(t), isError: false };
  if (t.status === "failed") return { text: formatFailed(t), isError: true };
  return { text: formatProcessing(t), isError: false };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

// ربط بث التقدم الحي مع إشعارات progress (إن زوّد العميل الطلب بـ progressToken)
function progressBridge(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): (progress: number, total: number, message: string) => Promise<void> {
  const token = (extra._meta as { progressToken?: string | number } | undefined)?.progressToken;
  if (token === undefined) return async () => {}; // العميل لا يريد إشعارات — لا شيء
  return async (progress, total, message) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      } as ServerNotification);
    } catch {
      // تجاهل — الإشعارات لا تعطل المهمة أبدًا
    }
  };
}

// ————— بناء الخادم وتسجيل الأدوات الخمس —————

export function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential multi-key failover across every active key). Returns the image URL directly if finished within the wait window; otherwise returns a task_id — call get_task with it every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z
          .enum(["auto", "transparent", "opaque"])
          .default("auto")
          .describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      try {
        const task = await runGeneration({
          type: "image",
          model: args.model,
          prompt: args.prompt,
          params: {
            prompt: args.prompt,
            model: args.model,
            aspect_ratio: args.aspect_ratio,
            resolution: args.resolution,
            background: args.background,
            output_format: args.output_format,
          },
          waitSeconds: args.wait_seconds,
          onProgress: progressBridge(extra),
        });
        const f = formatTask(task);
        return textResult(f.text, f.isError);
      } catch (e) {
        return textResult(errToArabic(e), true);
      }
    },
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio — dialogue/effects/music; optional image-to-video). Videos take minutes: a short wait with live progress streaming, then a task_id — track it with get_task every ~10 seconds until completed.",
      inputSchema: {
        prompt: z
          .string()
          .max(4096)
          .describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z
          .string()
          .optional()
          .describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      try {
        const params: Record<string, unknown> = {
          prompt: args.prompt,
          model: args.model,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          enable_audio: args.enable_audio,
          duration: args.duration,
        };
        if (args.image_url) params.image_url = args.image_url;
        const task = await runGeneration({
          type: "video",
          model: args.model,
          prompt: args.prompt,
          params,
          waitSeconds: args.wait_seconds,
          onProgress: progressBridge(extra),
        });
        const f = formatTask(task);
        return textResult(f.text, f.isError);
      } catch (e) {
        return textResult(errToArabic(e), true);
      }
    },
  );

  // 3) merge_videos
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several clips into one final video in the given order. Pass 'urls' (public direct video links — like the links returned by generate_video) or 'task_ids' (COMPLETED video generation tasks; their result URLs are merged in this order). Merging is usually fast: a short wait with progress streaming, then a merge task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        // ملاحظة: حدود 2-10 تُفرض في runMerge برسائل عربية صحيحة،
        // وليس بمخطط تحقق صارم يعطي رسائل إنجليزية من الـ SDK قبل وصول المعالج
        urls: z
          .array(z.string())
          .optional()
          .describe(
            "Public direct video URLs (http/https), 2–10 items, in merge order — the first clip starts the final video. Maximum 10 clips (merging service accepts 10 max).",
          ),
        task_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Alternative to urls: task_ids of COMPLETED video generation tasks, 2–10 items, in merge order — their result URLs are merged in this order. Maximum 10.",
          ),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      try {
        const task = await runMerge({
          urls: args.urls,
          taskIds: args.task_ids,
          waitSeconds: args.wait_seconds,
          onProgress: progressBridge(extra),
        });
        const f = formatTask(task);
        return textResult(f.text, f.isError);
      } catch (e) {
        return textResult(errToArabic(e), true);
      }
    },
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes live from the provider/merging service while in progress). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().describe("The task_id returned by generate_image / generate_video / merge_videos."),
      },
    },
    async (args) => {
      const task = await refreshTask(args.task_id);
      if (!task) {
        return textResult(`❌ لا توجد مهمة بهذا المعرّف: ${args.task_id}. تحقق من task_id أو استخدم list_media لعرض المهام المخزنة.`, true);
      }
      const f = formatTask(task);
      return textResult(f.text, f.isError);
    },
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      description:
        "List the most recent images/videos/merges stored in the database with their result URLs (no regeneration) — use it to recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit, { type: args.type, status: args.status });
      if (!tasks.length) {
        return textResult("لا توجد وسائط مخزنة بعد — استخدم generate_image أو generate_video أولًا.");
      }
      const lines = tasks.map((t, i) => {
        const urls = taskResultUrls(t);
        const kind = t.type === "image" ? "🖼️ صورة" : t.type === "video" ? "🎬 فيديو" : "🔗 دمج";
        const st = t.status === "completed" ? "مكتملة" : t.status === "failed" ? "فاشلة" : "جارية";
        const urlLine = urls.length ? `\n   الروابط: ${urls.join(" ، ")}` : "";
        const errLine = t.status === "failed" && t.error_message ? `\n   الخطأ: ${t.error_message}` : "";
        return `${i + 1}. ${kind} — ${st} — ${t.created_at} — ${t.model} — المهمة: ${t.id}${urlLine}${errLine}`;
      });
      return textResult(`📚 آخر الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n\n")}`);
    },
  );

  return server;
}

// رسائل الأخطاء العربية للعميل — دون أي ذكر لمفاتيح أو رصيد (التبديل صامت تمامًا)
function errToArabic(e: unknown): string {
  if (e instanceof ParamsError || e instanceof NoKeysError) {
    return e.message;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return `❌ خطأ غير متوقع أثناء التنفيذ: ${msg.slice(0, 200)}`;
}

// عدد المحاولات لكل مهمة — يُعرض في لوحة المهام (مساعد للواجهة)
export function attemptsCount(t: DbTask): number {
  return taskAttempts(t).length;
}
