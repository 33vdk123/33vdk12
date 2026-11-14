// محرك الدمج — ffmpeg داخل الدالة نفسها بجودة عالية إلزامية
// توحيد كل المصادر: scale + pad لأكبر دقة (حد 1920×1080 وأبعاد زوجية)، fps=30،
// setsar=1، format=yuv420p، ثم concat — والمصدر بلا صوت يُعطى مسارًا صامتًا بدل الفشل.
// الترميز: libx264 CRF 18 + AAC 192k/44100Hz + +faststart → MP4 فوري التشغيل على الويب.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const { LIMITS } = require("./util");
const { ROW_CHUNK, readBlob } = require("./storage");

// ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة — ننسخه إلى /tmp بصلاحية 755 عند الحاجة
async function ensureExecutable(bin) {
  const target = path.join(os.tmpdir(), path.basename(bin));
  try {
    await fs.promises.access(target, fs.constants.X_OK);
    return target;
  } catch {
    await fs.promises.copyFile(bin, target);
    await fs.promises.chmod(target, 0o755);
    return target;
  }
}

// استعلام ffprobe كـ JSON — الدقة، المدة، معدل الإطارات، وجود صوت
function probe(bin, filePath) {
  return new Promise((resolve, reject) => {
    execFileSafe(bin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath])
      .then((out) => {
        try {
          const data = JSON.parse(out);
          const v = (data.streams || []).find((s) => s.codec_type === "video");
          const a = (data.streams || []).find((s) => s.codec_type === "audio");
          if (!v) {
            reject(new Error("المصدر لا يحتوي مسار فيديو صالح"));
            return;
          }
          let fps = 30;
          if (v.r_frame_rate && v.r_frame_rate.includes("/")) {
            const [n, d] = v.r_frame_rate.split("/").map(Number);
            if (d > 0 && n > 0) fps = n / d;
          }
          resolve({
            width: v.width,
            height: v.height,
            fps: Number.isFinite(fps) ? fps : 30,
            duration: Number(v.duration || data.format?.duration || 0),
            hasAudio: !!a,
          });
        } catch (e) {
          reject(new Error("تعذر تحليل بيانات المصدر: " + e.message));
        }
      })
      .catch(reject);
  });
}

function execFileSafe(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-400) || `exit ${code}`))));
    p.on("error", reject);
  });
}

// تنزيل مصدر URL إلى /tmp مع فرض حد الحجم أثناء التنزيل (بمعدّل بايتات) وتقدم 0..1
async function downloadSource(url, dest, capBytes, onPart) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`فشل تنزيل المصدر (HTTP ${res.status}) — قد يرفض المصدر التحميل`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > capBytes) {
    throw new Error(`حجم المصدر (${Math.round(len / 1048576)}MB) يتجاوز الحد (${Math.round(capBytes / 1048576)}MB)`);
  }
  const out = fs.createWriteStream(dest);
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > capBytes) {
      out.destroy();
      throw new Error(`حجم المصدر يتجاوز الحد (${Math.round(capBytes / 1048576)}MB)`);
    }
    if (!out.write(Buffer.from(value))) {
      await new Promise((ok) => out.once("drain", ok));
    }
    if (onPart) onPart(value.byteLength, len);
  }
  await new Promise((ok) => out.end(ok));
  if (got === 0) throw new Error("المصدر فارغ أو لا يمكن تنزيله");
  return got;
}

// تجميع مصدر مرفوع من صفوف source_chunks (صفحات من 8 صفوف) إلى ملف في /tmp
async function assembleFromDb(jobId, seq, dest) {
  const buf = await readBlob("source_chunks", "job_id = ? AND seq = ?", [jobId, seq]);
  await fs.promises.writeFile(dest, buf);
  return buf.length;
}

// تشغيل ffmpeg مع قراءة تقدم out_time_us من -progress pipe:1
function runFfmpeg(bin, args, totalDurationSec, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let errTail = "";
    let buf = "";
    p.stdout.on("data", (c) => {
      buf += c.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && totalDurationSec > 0 && onProgress) {
          const sec = Number(m[1]) / 1e6;
          onProgress(Math.max(0, Math.min(1, sec / totalDurationSec)));
        }
      }
    });
    p.stderr.on("data", (c) => {
      errTail = (errTail + c.toString()).slice(-600);
    });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("فشل الترميز: " + errTail.slice(-300)))));
    p.on("error", reject);
  });
}

// الدمج الكامل: تنزيل/تجميع المصادر ← توحيد وترميز ← التحقق من الحدود
// onProgress(pct 0..100) — 0-40 سحب المصادر، 40-90 ترميز، 100 اكتمال
async function mergeSources(sources, tmpDir, outPath, onProgress) {
  await fs.promises.mkdir(tmpDir, { recursive: true });

  // — 1) سحب المصادر (0-40) —
  const localPaths = [];
  const n = sources.length;
  const perSource = 40 / n;
  for (let i = 0; i < n; i++) {
    const s = sources[i];
    const dest = path.join(tmpDir, `src_${i}.mp4`);
    let base = i * perSource;
    if (s.kind === "url") {
      await downloadSource(s.url, dest, LIMITS.sourceMaxBytes, (bytes, len) => {
        const frac = len > 0 ? Math.min(1, bytes / len) : 0;
        onProgress(Math.round(base + frac * perSource));
      });
    } else {
      const got = await assembleFromDb(s.jobId, s.seq, dest);
      if (s.size && got !== s.size) {
        throw new Error(`الملف المرفوع غير مكتمل (${got} من ${s.size} بايت)`);
      }
      if (got > LIMITS.sourceMaxBytes) {
        throw new Error(`حجم المصدر يتجاوز الحد (${Math.round(LIMITS.sourceMaxBytes / 1048576)}MB)`);
      }
    }
    localPaths.push(dest);
    onProgress(Math.round((i + 1) * perSource));
  }

  // — 2) فحص كل مصدر بـ ffprobe والحدود —
  const ffprobeBin = await ensureExecutable(ffprobePath);
  const infos = [];
  let totalDuration = 0;
  for (const p of localPaths) {
    const info = await probe(ffprobeBin, p);
    totalDuration += info.duration;
    if (totalDuration > LIMITS.maxTotalDurationSec) {
      throw new Error(
        `مجموع مدد المقاطع (${Math.round(totalDuration)} ثانية) يتجاوز الحد (${LIMITS.maxTotalDurationSec} ثانية)`,
      );
    }
    infos.push(info);
  }

  // — 3) بناء مرشحات التوحيد —
  const maxW = Math.min(1920, Math.max(...infos.map((s) => s.width))) & ~1; // أبعاد زوجية
  const maxH = Math.min(1080, Math.max(...infos.map((s) => s.height))) & ~1;
  const silentIdx = n; // مدخل anullsrc إضافي واحد يخدم كل المصادر الصامتة

  const chains = [];
  for (let i = 0; i < n; i++) {
    chains.push(
      `[${i}:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease,pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`,
    );
    if (infos[i].hasAudio) {
      chains.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`);
    } else {
      // مصدر بلا صوت → مسار صامت بنفس مدته بدل أن يفشل الدمج
      chains.push(`[${silentIdx}:a]atrim=duration=${infos[i].duration.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    }
  }
  const concatIn = infos.map((_, i) => `[v${i}][a${i}]`).join("");
  chains.push(`${concatIn}concat=n=${n}:v=1:a=1[vout][aout]`);

  // — 4) الترميز (40-90) —
  const ffmpegBin = await ensureExecutable(ffmpegPath);
  const args = ["-hide_banner", "-y", "-progress", "pipe:1", "-nostats"];
  for (const p of localPaths) args.push("-i", p);
  args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  args.push(
    "-filter_complex",
    chains.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    process.env.FFMPEG_PRESET || "medium",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    "-movflags",
    "+faststart",
    outPath,
  );
  await runFfmpeg(ffmpegBin, args, infos.reduce((a, b) => a + b.duration, 0), (frac) => {
    onProgress(Math.round(40 + frac * 50));
  });

  // — 5) التحقق من الناتج وحدوده —
  const size = (await fs.promises.stat(outPath)).size;
  if (size > LIMITS.outputMaxBytes) {
    throw new Error(`حجم الناتج (${Math.round(size / 1048576)}MB) يتجاوز الحد (${Math.round(LIMITS.outputMaxBytes / 1048576)}MB)`);
  }
  const outInfo = await probe(ffprobeBin, outPath);
  onProgress(100);
  return {
    size,
    duration: outInfo.duration,
    resolution: `${outInfo.width}x${outInfo.height}`,
    hasAudio: outInfo.hasAudio,
  };
}

// تنظيف مجلد /tmp المؤقت — في finally دائمًا (لا نظام ملفات دائم في serverless)
async function cleanupTmp(tmpDir) {
  try {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // تجاهل
  }
}

module.exports = { ensureExecutable, probe, downloadSource, assembleFromDb, mergeSources, cleanupTmp, ROW_CHUNK };
