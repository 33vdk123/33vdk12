// GET /api/health — فحص صحة السيرفر وقاعدة البيانات وخدمة الدمج
import { NextResponse } from "next/server";
import { dbHealthy, ensureSchema } from "@/lib/turso";
import { availableModels } from "@/lib/models";
import { checkMergerHealth, mergerBase, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  try {
    await ensureSchema();
    dbOk = await dbHealthy();
  } catch {
    dbOk = false;
  }

  // merger.healthy = فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ
  const mergerHealthy = mergerConfigured() ? await checkMergerHealth() : false;

  return NextResponse.json({
    ok: dbOk,
    database: dbOk ? "turso-connected" : "turso-error",
    mcpEndpoint: "/mcp",
    models: availableModels(),
    merger: { base: mergerConfigured() ? mergerBase() : "", healthy: mergerHealthy },
    authRequired: !!process.env.MCP_ACCESS_TOKEN,
  });
}
