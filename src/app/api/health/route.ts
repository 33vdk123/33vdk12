// GET /api/health — فحص حالة المزودين (بلا قاعدة بيانات)
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // الصور: Pollinations — تحقق من الوصول بـ GET خفيف (ترويسات فقط)
  let imagesReady = false;
  try {
    const res = await fetch("https://image.pollinations.ai/prompt/healthcheck?width=64&height=64&nologo=true", {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "image/*" },
    });
    try { await res.body?.cancel(); } catch {}
    const ct = res.headers.get("content-type") || "";
    imagesReady = res.ok && ct.startsWith("image/");
  } catch {
    imagesReady = false;
  }

  const cometapiConfigured = !!process.env.COMETAPI_KEY;
  const mergerConfigured = /^https?:\/\//.test(process.env.MERGER_API_BASE || "");

  return NextResponse.json({
    ok: imagesReady,
    images: imagesReady ? "ready" : "unavailable",
    video: cometapiConfigured ? "configured" : "not-configured",
    merge: mergerConfigured ? "configured" : "not-configured",
    mcpEndpoint: "/mcp",
    authRequired: !!process.env.MCP_ACCESS_TOKEN,
  });
}
