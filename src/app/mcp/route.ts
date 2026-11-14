// مسار /mcp — نقلة Streamable HTTP حسب مواصفة MCP عبر SDK الرسمي
// نستخدم WebStandardStreamableHTTPServerTransport مباشرة (يعمل مع Request/Response
// الأصلية في Next.js App Router دون أي محول Node) في وضع عديم الجلسة (stateless)
// لأن بيئة serverless على Vercel لا تحافظ على جلسات بين الاستدعاءات.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "@/lib/mcpServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة انتظار الأدوات قد تصل 240 ثانية — الحد الأعلى متوافق مع خطة Vercel الحالية
export const maxDuration = 300;

// حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Bearer token على /mcp
function authorized(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  const header = req.headers.get("authorization") || "";
  return header === `Bearer ${token}`;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: MCP_ACCESS_TOKEN مطلوب على /mcp" },
      id: null,
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

// دورة حياة عديمة الجلسة: خادم ونقل جديدان لكل طلب — كل طلب مستقل تمامًا
async function handleWithTransport(req: Request, parsedBody?: unknown): Promise<Response> {
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — متوافق مع Vercel serverless
  });
  await server.connect(transport);
  return await transport.handleRequest(req, { parsedBody: parsedBody as never });
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) return unauthorized();

  // نقرأ الجسم مرة واحدة ونمرره parsedBody كي لا يعيد النقل قراءة stream مستهلك
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

// GET: قناة SSE مستقلة للإشعارات — في وضع stateless يرد النقل 405 بنفسه
export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return unauthorized();
  return await handleWithTransport(req);
}

// DELETE: إنهاء جلسة — لا جلسات في وضع stateless، والنقل يرد بالشكل المناسب
export async function DELETE(req: Request): Promise<Response> {
  if (!authorized(req)) return unauthorized();
  return await handleWithTransport(req);
}

