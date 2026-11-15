// تعطيل/تنشيط يدوي وحذف مفتاح — /api/keys/{id}
import { NextRequest, NextResponse } from "next/server";
import { deleteKey, getKeyById, markKey } from "@/lib/turso";
import { maskKey } from "@/lib/keys";
import { POLLINATIONS_KEY_ID } from "@/lib/providers/pollinations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح" }, { status: 400 });
  }

  const key = await getKeyById(id);
  if (!key) {
    return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  }

  const action = String(body.action || "");
  if (action === "disable") {
    // تعطيل يدوي — المفتاح المعطل هو الوحيد المستثنى من قائمة المحاولة
    await markKey(id, { status: "disabled" });
  } else if (action === "enable") {
    // تنشيط يدوي — مفيد بعد شحن رصيد مفتاح مستنزف
    await markKey(id, { status: "active", lastError: null });
  } else {
    return NextResponse.json({ error: "action يجب أن يكون enable أو disable" }, { status: 400 });
  }

  const updated = await getKeyById(id);
  return NextResponse.json({
    key: updated ? { id: updated.id, status: updated.status } : { id },
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // حماية مفتاح Pollinations المجاني من الحذف — هو مزود مجاني دائم يُعاد زرعه تلقائيًا
  if (id === POLLINATIONS_KEY_ID) {
    return NextResponse.json(
      { error: "مفتاح Pollinations المجاني لا يُحذف — هو مزود مجاني دائم. يمكنك تعطيله إن رغبت." },
      { status: 403 },
    );
  }
  const ok = await deleteKey(id);
  if (!ok) {
    return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
