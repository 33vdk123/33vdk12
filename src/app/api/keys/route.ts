// إدارة المفاتيح للواجهة — القائمة الكاملة مع إخفاء المفاتيح دائمًا (maskKey)
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { findKeyByValue, insertKey, listKeys, type DbKey } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS = ["kie", "cometapi"];

// لا يُعاد المفتاح الكامل في أي استجابة — مُقنَّع دائمًا
function publicKey(k: DbKey) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    masked: maskKey(k.api_key),
    status: k.status,
    usageCount: k.usage_count,
    successCount: k.success_count,
    failCount: k.fail_count,
    lastUsedAt: k.last_used_at,
    lastCheckedAt: k.last_checked_at,
    lastError: k.last_error,
    createdAt: k.created_at,
  };
}

export async function GET() {
  const keys = await listKeys();
  return NextResponse.json({ keys: keys.map(publicKey) });
}

export async function POST(req: NextRequest) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح" }, { status: 400 });
  }

  const provider = String(body.provider || "").trim();
  const apiKey = String(body.api_key || "").trim();
  const label = String(body.label || "").trim().slice(0, 100);

  if (!PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
  }
  if (apiKey.length < 8) {
    return NextResponse.json({ error: "المفتاح قصير جدًا — أدخل مفتاح API صالحًا" }, { status: 400 });
  }

  // رفض التكرار لنفس المزود
  const existing = await findKeyByValue(provider, apiKey);
  if (existing) {
    return NextResponse.json(
      { error: "هذا المفتاح مضاف مسبقًا لنفس المزود — لا يمكن تكرار المفتاح" },
      { status: 409 },
    );
  }

  const id = randomUUID();
  await insertKey({ id, provider, label, apiKey });
  const created = await findKeyByValue(provider, apiKey);
  return NextResponse.json({ key: created ? publicKey(created) : { id } }, { status: 201 });
}
