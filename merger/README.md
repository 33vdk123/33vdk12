# خدمة دمج الفيديوهات — Video Merger API

موقع + API عام لدمج حتى **10 مقاطع** في فيديو **MP4 واحد عالي الجودة** (H.264 + AAC، حتى 1080p، CRF 18)، مبني بـ **Node.js خالص** (بلا Next.js أو خطوة بناء) يعمل على **Vercel Serverless**، والتخزين كاملًا في **Turso** (المهام + أجزاء الملفات + الناتج Blobs).

- الملفات تُحذف تلقائيًا بعد **24 ساعة** (`expiresAt` في الاستجابات).
- **بلا مفاتيح أو توثيق** — API مفتوح مع CORS مفتوح والأخطاء بصيغة `{"error":"..."}`.
- رفع الملفات أجزاء **4MB** (حد طلب Vercel ≈ 4.5MB) مع إعادة محاولة ×3 من الواجهة.
- بث الناتج يدعم **Range (206)** ليعمل التقديم/الترجيع في المشغل.

## النشر على Vercel

1. Vercel → Import المستودع → **Root Directory = `merger`**.
2. متغيرات البيئة (إلزاميان): `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` — من `turso db show <name> --url` و `turso db tokens create <name>`.
3. Deploy. اختبر: `curl https://<رابطك>/api/config` → `"ok":true`.

> إن ظهر خطأ نشر بسبب المدة، اجعل `maxDuration` من `vercel.json` قيمة `60` (خطة Hobby بدون Fluid Compute). الخطة المجانية مع Fluid تدعم 300.

## التشغيل محليًا

```bash
npm install
cp .env.example .env      # ضع متغيري Turso
npm run dev               # http://localhost:3001 — خادم يحاكي Vercel (يحل المسارات الديناميكية إلى req.query)
npm run test:unit         # 17 اختبارًا (قاعدة file: محلية نظيفة)
npm run test:http         # 34 اختبارًا كاملًا ضد خادم التطوير
```

## توثيق API

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة — `{"videos":["رابط1","رابط2"]}` أو `{"sources":[{"kind":"url","url":…},{"kind":"file","name":…,"size":…,"mime":…}]}` → `201 {"jobId","status","statusUrl","processUrl","expiresAt"}` (+`uploads[]` و`uploadChunkBytes` عند وجود ملفات) |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء ملف (ثنائي ≤4MB، `Content-Type: application/octet-stream`) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا (متزامن ~10-60ث) → `{"status":"done","videoUrl","downloadUrl","size","duration","resolution","expiresAt"}` · قيد المعالجة `202` · فشل `500 {"error"}` (فشل حتمي: المصدر يرفض التحميل مثلًا) |
| `GET` | `/api/jobs/<id>` | الحالة `queued|uploading|processing|done|failed` + `progress` 0–100 + `videoUrl/downloadUrl/error` عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث MP4 بدعم Range (206 + Content-Range) · `?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل (المهمة + المصادر + كل الأجزاء في batch واحد) |
| `GET` | `/api/config` | الحدود + version |
| `GET` | `/api/cron` | حذف المهام المنتهية — مجدول يوميًا في `vercel.json` (`0 3 * * *`) |

### مثال curl كامل

```bash
# 1) إنشاء مهمة من روابط
curl -X POST https://<merger>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
# → 201 {"jobId":"wkucdefoxwvd","status":"queued",...}

# 2) تنفيذ الدمج
curl -X POST https://<merger>/api/jobs/wkucdefoxwvd/process
# → {"status":"done","videoUrl":"https://<merger>/api/jobs/wkucdefoxwvd/video","size":737059,"duration":8.07,"resolution":"736x400",...}

# 3) المشاهدة/التحميل (يدعم Range)
curl -O "https://<merger>/api/jobs/wkucdefoxwvd/video?download=1"
```

### رموز الأخطاء

`400` مدخلات تالفة · `404` غير موجود · `405` طريقة خاطئة · `409` حالة غير مناسبة (ملف ناقص الرفع / لا ناتج بعد) · `413` تجاوز الحجم · `416` مدى Range خارج النطاق · `500` فشل دمج معلن.

## الحدود (قابلة للضبط بمتغيرات البيئة)

| الحد | الافتراضي |
|---|---|
| عدد المقاطع | 10 |
| حجم كل مصدر | 200MB |
| حجم الناتج | 150MB |
| مجموع مدد المقاطع | 600 ثانية |
| حجم جزء الرفع | 4MB |
| مدة الدالة | 300 ثانية |
| الاحتفاظ بالملفات | 24 ساعة |

## محرك الدمج (جودة عالية إلزامية)

- ffprobe لكل مصدر: الدقة، fps، المدة، وجود صوت.
- توحيد عبر filter_complex: `scale` + `pad` إلى **أكبر دقة بين المدخلات** (حد أقصى 1920×1080، أبعاد زوجية)، `fps=30`، `setsar=1`، `format=yuv420p`، ثم `concat=n=:v=1:a=1`.
- مصدر بلا صوت → مسار صامت `anullsrc` بنفس مدته بدل أن يفشل الدمج.
- الترميز: libx264 **CRF 18** + AAC 192k/44100Hz + `+faststart` — الناتج يعمل فورًا على الويب.
- التقدم يُقرأ من `-progress pipe:1` ويُخزَّن في القاعدة (0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال).
- ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة → `ensureExecutable` ينسخه إلى /tmp بصلاحية 755.
- كل Blob يُقسَّم صفوفًا 2MB (حد HTTP في Turso) ويُقرأ بصفحات من 8 صفوف؛ بث الفيديو يقلّم أول/آخر جزء حسب المدى المطلوب.
- لا نظام ملفات دائم — /tmp فقط أثناء المعالجة ويُنظَّف في `finally`.
