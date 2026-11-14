// GET /api/tasks — أحدث المهام + الإحصائيات للوحة المهام
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats, taskResultUrls, taskAttempts } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.max(1, Math.min(50, Number(sp.get("limit") ?? 20) || 20));
  const type = sp.get("type") ?? undefined;
  const status = sp.get("status") ?? undefined;

  const [stats, tasks] = await Promise.all([
    taskStats(),
    listRecentTasks(limit, {
      type: type && ["image", "video", "merge"].includes(type) ? type : undefined,
      status: status && ["pending", "processing", "completed", "failed"].includes(status) ? status : undefined,
    }),
  ]);

  return NextResponse.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      model: t.model,
      provider: t.provider,
      progress: t.progress,
      prompt: t.prompt.length > 90 ? t.prompt.slice(0, 90) + "…" : t.prompt,
      urls: taskResultUrls(t),
      errorMessage: t.error_message,
      attemptsCount: taskAttempts(t).length,
      createdAt: t.created_at,
      completedAt: t.completed_at,
    })),
  });
}
