import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PUBLISH_ROOT,
  REVIEW_ROOT,
  ROOT,
  auditVideo,
  ffprobeVideo,
  fileExists,
  publishVideo,
  relativeToRoot,
  runCommand
} from "./capture.mjs";

export const X_DELIVERY_SCHEMA = 1;
export const X_DELIVERY_REVIEW_DIR = path.join(REVIEW_ROOT, "delivery", "x");

const defaultLog = (message) => console.log(`[delivery:x] ${message}`);

function fraction(value) {
  if (typeof value !== "string") return Number(value);
  const [numerator, denominator = "1"] = value.split("/");
  return Number(numerator) / Number(denominator);
}

function even(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function fitInside(width, height, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: even(width * scale), height: even(height * scale) };
}

function mediaStreams(probe, source) {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  if (!video) throw new Error(`${source} has no video stream`);
  if (!audio) throw new Error(`${source} has no audio stream; X delivery expects the finished stereo mix`);
  return { video, audio };
}

function sourceInfo(probe, source) {
  const { video, audio } = mediaStreams(probe, source);
  const fps = fraction(video.avg_frame_rate);
  const duration = Number(probe.format?.duration ?? video.duration);
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`${source} has an invalid frame rate`);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${source} has an invalid duration`);
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps,
    duration,
    video,
    audio
  };
}

function variantConfig(source, id) {
  const fps = Math.min(30, source.fps);
  if (id === "x-1080p30") {
    const dimensions = fitInside(source.width, source.height, 1920, 1080);
    return {
      id,
      label: "X 1080p30",
      experimental: false,
      ...dimensions,
      fps,
      level: "4.1"
    };
  }
  if (id === "x-4k30-experimental") {
    const baseline = fitInside(source.width, source.height, 1920, 1080);
    return {
      id,
      label: "X 2x upscale experiment",
      experimental: true,
      width: even(baseline.width * 2),
      height: even(baseline.height * 2),
      fps,
      level: "5.1"
    };
  }
  throw new Error(`unknown X delivery variant ${JSON.stringify(id)}`);
}

function encodeArgs(inputFile, outputFile, variant) {
  const scale = [
    `fps=${variant.fps}`,
    `scale=${variant.width}:${variant.height}:flags=lanczos+accurate_rnd+full_chroma_int`,
    "setsar=1",
    "format=yuv420p",
    "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709"
  ].join(",");
  return [
    "-hide_banner", "-y",
    "-i", inputFile,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-sn", "-dn",
    "-vf", scale,
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "15",
    "-maxrate", "24M",
    "-bufsize", "48M",
    "-profile:v", "high",
    "-level:v", variant.level,
    "-pix_fmt", "yuv420p",
    "-tag:v", "avc1",
    "-g", String(Math.max(1, Math.round(variant.fps * 2))),
    "-keyint_min", String(Math.max(1, Math.round(variant.fps))),
    "-sc_threshold", "40",
    "-flags", "+cgop",
    "-x264-params", "open-gop=0:force-cfr=1:aq-mode=3",
    "-fps_mode", "cfr",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-colorspace", "bt709",
    "-color_range", "tv",
    "-c:a", "aac",
    "-profile:a", "aac_low",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart",
    outputFile
  ];
}

function parseMetric(output, pattern) {
  const matches = [...output.matchAll(pattern)];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

async function measureSimilarity({ sourceFile, deliveryFile, width, height, fps, ffmpeg }) {
  const graph = [
    `[0:v]fps=${fps},scale=${width}:${height}:flags=lanczos,setpts=PTS-STARTPTS[reference]`,
    `[1:v]fps=${fps},scale=${width}:${height}:flags=lanczos,setpts=PTS-STARTPTS[candidate]`,
    "[reference][candidate]ssim=shortest=1"
  ].join(";");
  const { output } = await runCommand(ffmpeg, [
    "-hide_banner",
    "-i", sourceFile,
    "-i", deliveryFile,
    "-lavfi", graph,
    "-an",
    "-f", "null", "-"
  ], { capture: true, log: () => {} });
  return {
    ssim: parseMetric(output, /SSIM[^\n]*All:([\d.]+)/g),
    note: "Informational only; the experimental export is downscaled before comparison. This does not simulate X's encoder."
  };
}

function assertDeliveryProbe(probe, variant) {
  const { video, audio } = mediaStreams(probe, variant.id);
  const failures = [];
  const fps = fraction(video.avg_frame_rate);
  const totalBitrate = Number(probe.format?.bit_rate);
  if (video.codec_name !== "h264") failures.push(`video codec ${video.codec_name}, expected h264`);
  if (video.profile !== "High") failures.push(`H.264 profile ${video.profile}, expected High`);
  if (video.pix_fmt !== "yuv420p") failures.push(`pixel format ${video.pix_fmt}, expected yuv420p`);
  if (video.sample_aspect_ratio && video.sample_aspect_ratio !== "1:1") failures.push(`sample aspect ratio ${video.sample_aspect_ratio}, expected 1:1`);
  if (video.field_order && video.field_order !== "progressive") failures.push(`scan type ${video.field_order}, expected progressive`);
  if (video.color_primaries !== "bt709" || video.color_transfer !== "bt709" || video.color_space !== "bt709") {
    failures.push("video is not fully tagged BT.709");
  }
  if (video.color_range !== "tv") failures.push(`color range ${video.color_range}, expected tv/limited`);
  if (Number(video.width) !== variant.width || Number(video.height) !== variant.height) {
    failures.push(`dimensions ${video.width}x${video.height}, expected ${variant.width}x${variant.height}`);
  }
  if (!Number.isFinite(fps) || Math.abs(fps - variant.fps) > 1e-6) failures.push(`frame rate ${video.avg_frame_rate}, expected ${variant.fps}`);
  if (audio.codec_name !== "aac" || audio.profile !== "LC") failures.push(`audio ${audio.codec_name}/${audio.profile}, expected AAC-LC`);
  if (Number(audio.sample_rate) !== 48_000 || Number(audio.channels) !== 2) failures.push("audio must be 48 kHz stereo");
  if (Number.isFinite(totalBitrate) && totalBitrate > 25_000_000) failures.push(`mux bitrate ${(totalBitrate / 1_000_000).toFixed(2)} Mbps exceeds 25 Mbps`);
  if (failures.length) throw new Error(`${variant.label} validation failed:\n- ${failures.join("\n- ")}`);
}

async function encodeVariant({ inputFile, outputDir, stem, source, id, ffmpeg, ffprobe, log, force }) {
  const variant = variantConfig(source, id);
  const outputFile = path.join(outputDir, `${stem}-${variant.id}.mp4`);
  const auditFile = path.join(outputDir, `${stem}-${variant.id}.audit.json`);
  const tempFile = path.join(outputDir, `.${stem}-${variant.id}.${process.pid}.tmp.mp4`);
  if (!force && await fileExists(outputFile)) {
    throw new Error(`${relativeToRoot(outputFile)} already exists; pass --force to replace it`);
  }
  await rm(tempFile, { force: true });
  const args = encodeArgs(inputFile, tempFile, variant);
  log(`${variant.label}: ${source.width}x${source.height}@${source.fps} -> ${variant.width}x${variant.height}@${variant.fps}`);
  try {
    await runCommand(ffmpeg, args, { log });
    const probe = await ffprobeVideo(tempFile, { ffprobe });
    assertDeliveryProbe(probe, variant);
    await rename(tempFile, outputFile);
  } catch (error) {
    await rm(tempFile, { force: true });
    throw error;
  }

  const expected = {
    width: variant.width,
    height: variant.height,
    fps: variant.fps,
    duration: source.duration,
    totalFrames: Math.round(source.duration * variant.fps)
  };
  const audit = await auditVideo({ videoFile: outputFile, expected, auditFile, ffmpeg, ffprobe, log });
  if (audit.status === "failed") throw new Error(`${variant.label} technical audit failed; see ${relativeToRoot(auditFile)}`);
  const baseline = fitInside(source.width, source.height, 1920, 1080);
  const similarity = await measureSimilarity({
    sourceFile: inputFile,
    deliveryFile: outputFile,
    width: baseline.width,
    height: baseline.height,
    fps: variant.fps,
    ffmpeg
  });
  const info = await stat(outputFile);
  return {
    ...variant,
    outputFile,
    auditFile,
    bytes: info.size,
    similarity,
    encoder: {
      codec: "libx264",
      preset: "slow",
      crf: 15,
      maxrate: "24M",
      bufsize: "48M",
      closedGop: true,
      gopSeconds: 2,
      pixelFormat: "yuv420p",
      colors: "BT.709 limited",
      audio: "AAC-LC 192k 48kHz stereo"
    }
  };
}

export async function exportXDelivery({
  inputFile,
  reviewDir = X_DELIVERY_REVIEW_DIR,
  publishDir = PUBLISH_ROOT,
  experimental4k = false,
  force = false,
  ffmpeg = process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobe = process.env.FFPROBE_BIN ?? process.env.FFPROBE_PATH ?? "ffprobe",
  log = defaultLog
}) {
  const resolvedInput = path.resolve(ROOT, inputFile);
  if (!(await fileExists(resolvedInput))) throw new Error(`input does not exist: ${relativeToRoot(resolvedInput)}`);
  const resolvedReviewDir = path.resolve(ROOT, reviewDir);
  await mkdir(resolvedReviewDir, { recursive: true });
  const sourceProbe = await ffprobeVideo(resolvedInput, { ffprobe });
  const source = sourceInfo(sourceProbe, relativeToRoot(resolvedInput));
  const sourceStat = await stat(resolvedInput);
  const stem = path.basename(resolvedInput, path.extname(resolvedInput));
  const publishStem = stem.replace(/-(?:master|fast)$/, "");
  const ids = ["x-1080p30", ...(experimental4k ? ["x-4k30-experimental"] : [])];
  const variants = [];
  for (const id of ids) {
    variants.push(await encodeVariant({
      inputFile: resolvedInput,
      outputDir: resolvedReviewDir,
      stem,
      source,
      id,
      ffmpeg,
      ffprobe,
      log,
      force
    }));
  }
  const publishedVariants = [];
  for (const variant of variants) {
    const suffix = variant.experimental ? "upscale-4k30-experimental" : "social-1080p30";
    const published = await publishVideo(variant.outputFile, {
      filename: `${publishStem}-${suffix}.mp4`,
      publishDir,
      log
    });
    publishedVariants.push({ ...variant, publishedFile: published.file });
  }
  const manifestFile = path.join(resolvedReviewDir, `${stem}-x-delivery.json`);
  const report = {
    schema: X_DELIVERY_SCHEMA,
    platform: "X",
    source: {
      file: path.relative(ROOT, resolvedInput),
      bytes: sourceStat.size,
      width: source.width,
      height: source.height,
      fps: source.fps,
      duration: source.duration
    },
    policy: {
      default: "1080p at no more than 30 fps",
      rationale: "Conservative common denominator across X's currently inconsistent public upload specifications; 30 fps spends more of a bitrate-limited transcode on each displayed frame.",
      experimental4k: experimental4k
        ? "Generated only for account-specific A/B testing. X does not publicly promise 4K upload or a superior encode tier."
        : "Not requested. Pass --experimental-4k to generate a 2x Lanczos A/B candidate.",
      overlays: "No delivery-time overlays or text are added."
    },
    variants: publishedVariants.map((variant) => ({
      ...variant,
      outputFile: path.relative(ROOT, variant.outputFile),
      auditFile: path.relative(ROOT, variant.auditFile),
      publishedFile: variant.publishedFile
    }))
  };
  await writeFile(manifestFile, `${JSON.stringify(report, null, 2)}\n`);
  log(`manifest ${relativeToRoot(manifestFile)}`);
  return { ...report, manifestFile, variants: publishedVariants };
}
