# MCP Media Generator + Video Merger

مشروعان في مستودع واحد:

1. **خادم MCP لتوليد الوسائط** (جذر المستودع — Next.js + TypeScript): توليد صور وفيديو بالذكاء الاصطناعي عبر kie.ai (وCometAPI) مع **تبديل تسلسلي صارم للمفاتيح** عند أي خطأ أو نفاد رصيد، ودمج مقاطع الفيديو، ولوحة إدارة عربية RTL.
2. **خدمة دمج الفيديوهات** (مجلد `merger/` — Node.js خالص على Vercel Serverless): موقع + API عام لدمج حتى 10 مقاطع في MP4 عالي الجودة داخل الدالة نفسها بـ ffmpeg، والتخزين كاملًا في Turso.

**القاعدة الذهبية: لا تُنزَّل أي وسائط على سيرفرنا إطلاقًا** — نرسل الروابط للمزودين ونخزّن روابط النتائج فقط. مفاتيح API تُخفى دائمًا (`maskKey`) ولا تُعاد كاملة في أي استجابة.

---

## 1) البنية

```
├── src/lib/turso.ts          طبقة Turso (جداول tasks وapi_keys + كل العمليات)
├── src/lib/keys.ts           المفاتيح: الترتيب التسلسلي الصارم + الإخفاء
├── src/lib/errors.ts         تصنيف الأخطاء الموحد (disabled/exhausted/provider/params/temporary)
├── src/lib/models.ts         سجل MODELS مع صيغ بديلة ومزودين لكل موديل
├── src/lib/providers/        محولات المزودين: kie.ts (مقاس فعليًا) و cometapi.ts
├── src/lib/generation.ts     منسق التوليد + التبديل الصامت بنفس task_id
├── src/lib/mergeFlow.ts      تدفق الدمج (runMerge / refreshMergeTask)
├── src/lib/merger.ts         عميل خدمة الدمج v2
├── src/lib/mcpServer.ts      الأدوات الخمس وصياغة الردود العربية
├── src/app/mcp/route.ts      نقلة Streamable HTTP (وضع stateless متوافق مع serverless)
├── src/app/api/…             /api/health + /api/keys + /api/tasks
├── src/app/page.tsx          لوحة الإدارة العربية RTL (3 بطاقات)
└── merger/
    ├── api/…                 7 نقاط نهاية Serverless
    ├── lib/…                 قاعدة البيانات + التخزين المجزأ 2MB + محرك ffmpeg
    ├── public/index.html     واجهة الموقع (RTL داكنة، سحب وإفلات، تقدم حي)
    ├── dev-server.js         خادم تطوير يحاكي Vercel محليًا
    └── scripts/              اختبار وحدات + اختبار HTTP كامل
```

### الموديلان المدمجان (مثبتان كما هما)

| canonical | النوع | المزودون |
|---|---|---|
| `gpt-image-2-6/flare-text-to-image` | image | kie + cometapi |
| `grok-imagine-video-1-5-preview` | video | kie + cometapi |

الصيغ البديلة بالنقاط (`gpt-image-2.6/...`) تُقبل وتُوحَّد تلقائيًا، والأسماء قابلة للتجاوز بمتغيرات البيئة (`KIE_IMAGE_MODEL`، `KIE_VIDEO_MODEL`، `COMETAPI_IMAGE_MODEL`، `COMETAPI_VIDEO_MODEL`).

---

## 2) النشر على Vercel خطوة بخطوة

> تحتاج: مستودع GitHub هذا + قاعدة Turso جاهزة (الرابط والتوكن عندك) + حساب Vercel.

### الخطوة 1 — إنشاء قاعدة Turso (إن لم تكن جاهزة)

```bash
turso db create <name>
turso db show <name> --url      # → TURSO_DATABASE_URL
turso db tokens create <name>   # → TURSO_AUTH_TOKEN
```

### الخطوة 2 — نشر خدمة الدمج أولًا (مشروع الدمج)

1. أدخل [vercel.com/new](https://vercel.com/new) واختر مستودع `33vdk12`.
2. قبل الضغط على Deploy: افتح **Root Directory** واختر `merger`.
3. في **Environment Variables** أضف:
   - `TURSO_DATABASE_URL` = رابط قاعدة Turso
   - `TURSO_AUTH_TOKEN` = توكن Turso
4. اضغط **Deploy**. بعد الانتهاء انسخ رابط المشروع (مثل `https://video-merger-xxx.vercel.app`) — ستحتاجه في الخطوة 3.
5. جرّب: `curl https://<رابط-الدمج>/api/config` — يجب أن يعيد `"ok":true`.

### الخطوة 3 — نشر تطبيق MCP (جذر المستودع)

1. [vercel.com/new](https://vercel.com/new) مرة ثانية → اختر نفس المستودع → **اسم مشروع مختلف** (مثل `mcp-media-generator`).
2. اترك **Root Directory فارغًا** (الجذر) — سيكتشف Vercel إطار Next.js تلقائيًا.
3. في **Environment Variables** أضف:
   - `TURSO_DATABASE_URL` = رابط قاعدة Turso
   - `TURSO_AUTH_TOKEN` = توكن Turso
   - `MERGER_API_BASE` = رابط مشروع الدمج من الخطوة 2
   - (اختياري) `MCP_ACCESS_TOKEN` = أي قيمة سرية لحماية `/mcp` بمصادقة Bearer
4. اضغط **Deploy**، ثم جرّب: `curl https://<رابط-التطبيق>/api/health` — يجب أن يظهر `"ok":true` و `"merger":{"healthy":true}`.

### ملاحظات مهمة عن خطة Vercel

- مدة الدالة مضبوطة على `maxDuration: 300` في `merger/vercel.json` وفي `src/app/mcp/route.ts` — تعمل على الخطة المجانية **مع تفعيل Fluid Compute** (الافتراضي للمشاريع الجديدة). إن ظهر خطأ نشر عن المدة فاجعل القيمة `60` في الملفين.
- رفع الملفات من الواجهة يتم أجزاء 4MB (حد الطلب في Vercel ≈ 4.5MB) مع إعادة محاولة ×3 تلقائيًا.
- تخزين Turso المجاني ~5GB — ملفات الدمج تُحذف تلقائيًا بعد 24 ساعة (تنظيف كسول + Cron يومي)، فلا تتراكم.

### الخطوة 4 — إضافة مفاتيح API

1. افتح رابط تطبيق MCP → لوحة الإدارة العربية تظهر مباشرة.
2. في بطاقة **مدير المفاتيح**: اختر المزود (`kie.ai`) + ألصق المفتاح + أضف.
3. **أضف عدة مفاتيح لكل مزود** — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف. المفتاح المستنزف يبقى في القاعدة ويعود للعمل بعد شحن رصيده (أو تنشيطه يدويًا).

---

## 3) ربط أي عميل MCP

نقطة السيرفر: `https://<رابط-التطبيق>/mcp`

- **ChatGPT / GPT Agents**: Settings → Connectors → Create → Custom MCP server → ضع الرابط في «Server URL». الصيغة: `{"mcpServers":{"media-generator":{"url":"<MCP_URL>"}}}`
- **Claude Desktop**: في `claude_desktop_config.json`: `{"mcpServers":{"media-generator":{"type":"http","url":"<MCP_URL>"}}}`
- **Cursor / Windsurf / Cline**: في `mcp.json` بنفس الصيغة الأولى.

اللوحة تعرض هذه الصيغ جاهزة للنسخ في بطاقة «ربط السيرفر» مع الرابط الحقيقي.

### الأدوات الخمس

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة — تعيد الرابط جاهزًا إن اكتملت خلال نافذة الانتظار وإلا `task_id` |
| `generate_video` | فيديو بصوت متزامن أصلي (image-to-video اختياري) — يحتاج دقائق |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` أو `task_ids` |
| `get_task` | تتبع أي مهمة — يحدّث من المزود/خدمة الدمج حيًا |
| `list_media` | استرجاع الوسائط المخزنة بروابطها دون إعادة توليد |

**سلوك المتابعة:** الفيديو يعيد `task_id` فورًا مع بث تقدم حي (Progress notifications)، ويتابعه النموذج بـ `get_task` كل ~10 ثوانٍ حتى يكتمل ويُعرض الرابط ويتوقف. مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة ~45 ثانية) — لو شُحن رصيد أي مفتاح تكتمل من نفسها. نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا.

---

## 4) متغيرات البيئة

| المتغير | المشروع | إلزامي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | الاثنان | ✅ | رابط قاعدة Turso (`libsql://…`) |
| `TURSO_AUTH_TOKEN` | الاثنان | ✅ | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | تطبيق MCP | ✅ | رابط خدمة الدمج بعد نشرها (مثل `https://video-merger-xxx.vercel.app`) |
| `MCP_ACCESS_TOKEN` | تطبيق MCP | — | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | تطبيق MCP | — | تجاوز اسم الموديل لدى kie |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | تطبيق MCP | — | تجاوز اسم الموديل لدى CometAPI |
| `MAX_SOURCES` | الدمج | — | أقصى عدد مقاطع (افتراضي 10) |
| `SOURCE_MAX_MB` / `OUTPUT_MAX_MB` | الدمج | — | حد المصدر 200 / الناتج 150 |
| `MAX_TOTAL_DURATION_SEC` | الدمج | — | مجموع المدد (افتراضي 600) |
| `FFMPEG_PRESET` | الدمج | — | preset الترميز (افتراضي medium) |

**`.env*` مستثنى في `.gitignore` منذ أول commit — لا أسرار في Git إطلاقًا.**

---

## 5) توثيق API خدمة الدمج

مفتوح للجميع، بلا تسجيل، CORS مفتوح، الأخطاء بصيغة `{"error":"..."}`:

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة: `{"videos":["رابط1","رابط2"]}` أو `{"sources":[{"kind":"url","url":…},{"kind":"file","name":…,"size":…,"mime":…}]}` → `201` مع `jobId/statusUrl/processUrl/expiresAt` (+ `uploads[]` عند وجود ملفات) |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB octet-stream) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا → `{"status":"done","videoUrl":…,"size":…,"duration":…,"resolution":…}` · قيد المعالجة → `202` · فشل → `500 {"error"}` |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم 0–100 + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث MP4 بدعم Range (206)، و`?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل |
| `GET` | `/api/config` | الحدود العامة + version (تُستخدم لفحص الجهوزية) |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي `0 3 * * *`) |

```bash
# دمج مقطعين
curl -X POST https://<merger>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://example.com/clip2.mp4"]}'

# تنفيذ ثم متابعة
curl -X POST https://<merger>/api/jobs/<id>/process
curl https://<merger>/api/jobs/<id>
```

**محرك الدمج:** ffprobe لكل مصدر ← scale + pad لأكبر دقة (حد 1920×1080 وأبعاد زوجية) + fps=30 + setsar=1 + yuv420p ← concat — مصدر بلا صوت يُعطى مسارًا صامتًا بنفس مدته بدل الفشل ← libx264 CRF 18 + AAC 192k/44.1kHz + +faststart. التقدم يُخزَّن في القاعدة (0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال). الناتج MP4 (H.264 + AAC) حتى 1080p — بلا معاملات resolution/fps (المخرج ثابت).

---

## 6) التشغيل والاختبار محليًا

```bash
# تطبيق MCP
npm install
cp .env.example .env.local   # ثم ضع القيم الحقيقية
npm run dev                  # http://localhost:3000

# خدمة الدمج
cd merger
npm install
cp .env.example .env         # ثم ضع القيم الحقيقية
npm run dev                  # http://localhost:3001

# اختبارات الدمج (قاعدة file: محلية نظيفة لا تلمس Turso الإنتاجية)
npm run test:unit            # 17 اختبارًا: الدمج + التخزين sha256 + Range + الحدود
npm run test:http            # 34 اختبارًا: كل مسارات API + رفع مجزأ + حذف شامل
```

### ما الذي جرى اختباره فعليًا أثناء البناء

1. توليد صورة e2e بمفتاح حقيقي → رابط صورة يعمل ✓
2. توليد فيديو e2e → رابط MP4 يعمل ✓
3. التبديل التسلسلي: مفتاح خاطئ أولًا ثم صحيح → المهمة اكتملت على الثاني، الخاطئ أصبح `disabled`، ولم يصل العميل أي ذكر للمفاتيح ✓
4. `tools/list` يعرض الأدوات الخمس بمخططات صحيحة ✓
5. `merge_videos` رفض مقطعًا واحدًا و11 مقطعًا برسائل عربية صحيحة ✓
6. دمج مقطعين عامين حقيقيين → MP4 نهائي على نطاق خدمة الدمج (8.07 ثانية، 736×400، h264+aac) يُشغَّل ويدعم Range ✓
7. دمج عبر `task_ids` يحل روابط المهام بالترتيب ✓
8. `list_media` يعيد المهام المخزنة مرتبة من الأحدث ✓
9. الواجهة: إضافة/تعطيل/حذف مفتاح + لوحة مهام تتحدث تلقائيًا + JSON ربط لكل تبويب، كلها RTL ✓

---

## 7) الأمان

- لا تُنزَّل وسائط على السيرفر — روابط فقط في قاعدة البيانات.
- المفاتيح مُقنَّعة في كل الاستجابات (`ABCD123••••••••WXYZ`) ولا يُعاد المفتاح الكامل أبدًا.
- رسائل الخطأ للعميل لا تذكر مفاتيح أو أرصدة — التبديل صامت تمامًا.
- ملفات الدمج تُحذف من الخدمة بعد 24 ساعة، ومهام الاختبار تُنظَّف من القاعدة.
- `.env*` في `.gitignore` — ضع أسرارك في Vercel → Environment Variables فقط.
