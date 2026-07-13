import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ffprobeVideo, fileExists, relativeToRoot, runCommand } from "./capture.mjs";

export const TWITTER_SUMMER_TRANSITIONS = Object.freeze([
  Object.freeze({ id: "foam-crest", duration: 0.6, xfade: "smoothup", description: "The surf's whitewater rises into the bridge deck." }),
  Object.freeze({ id: "cable-slice", duration: 0.7, xfade: "hlslice", description: "Golden Gate suspenders cut the frame into the Presidio canopy." }),
  Object.freeze({ id: "feather-iris", duration: 0.8, xfade: "circleopen", description: "The phoenix feather fan opens into the Palace rotunda." }),
  Object.freeze({ id: "sun-flare-burn", duration: 0.7, xfade: "fadewhite", description: "A physical sun alignment burns through to the Embarcadero." }),
  Object.freeze({ id: "speed-tunnel", duration: 0.8, xfade: "zoomin", description: "The car's vanishing point pulls into the hoverboard macro." }),
  Object.freeze({ id: "petal-scatter", duration: 0.7, xfade: "dissolve", description: "Broad floral colors scatter into blue-hour water highlights." }),
  Object.freeze({ id: "constellation-burst", duration: 0.7, xfade: "radial", description: "Firework points sweep radially into the night skyline finale." })
]);

function fraction(value) {
  if (typeof value !== "string") return Number(value);
  const [numerator, denominator = "1"] = value.split("/");
  return Number(numerator) / Number(denominator);
}

function decimal(value) {
  return Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function buildFilter({ width, height, fps, clipDuration }) {
  const filters = [];
  const normalizeVideo = [
    `fps=${fps}:round=near`,
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    "settb=AVTB",
    "setpts=PTS-STARTPTS",
    "format=yuv444p"
  ].join(",");
  const normalizeAudio = "aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS";
  for (let index = 0; index < 8; index += 1) {
    filters.push(`[${index}:v:0]${normalizeVideo}[v${index}]`);
    filters.push(`[${index}:a:0]${normalizeAudio}[a${index}]`);
  }

  let videoLabel = "v0";
  let audioLabel = "a0";
  let combinedDuration = clipDuration;
  const offsets = [];
  for (let index = 0; index < TWITTER_SUMMER_TRANSITIONS.length; index += 1) {
    const transition = TWITTER_SUMMER_TRANSITIONS[index];
    const offset = Number((combinedDuration - transition.duration).toFixed(6));
    offsets.push(offset);
    const nextVideo = `vx${index + 1}`;
    const nextAudio = `ax${index + 1}`;
    filters.push(
      `[${videoLabel}][v${index + 1}]xfade=transition=${transition.xfade}:duration=${decimal(transition.duration)}:offset=${decimal(offset)}[${nextVideo}]`
    );
    filters.push(
      `[${audioLabel}][a${index + 1}]acrossfade=d=${decimal(transition.duration)}:c1=qsin:c2=qsin[${nextAudio}]`
    );
    videoLabel = nextVideo;
    audioLabel = nextAudio;
    combinedDuration += clipDuration - transition.duration;
  }
  const finalDuration = Number(combinedDuration.toFixed(6));
  filters.push(
    `[${videoLabel}]trim=duration=${decimal(finalDuration)},setpts=PTS-STARTPTS,format=yuv420p,` +
    "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[video]"
  );
  filters.push(`[${audioLabel}]atrim=duration=${decimal(finalDuration)},asetpts=PTS-STARTPTS[audio]`);
  return { graph: filters.join(";"), duration: finalDuration, offsets };
}

async function validateClips(clips, { width, height, fps, ffprobe }) {
  if (!Array.isArray(clips) || clips.length !== 8) throw new Error("Summer assembly requires exactly eight shot clips");
  const probes = [];
  for (const clip of clips) {
    if (!(await fileExists(clip))) throw new Error(`missing shot clip ${relativeToRoot(clip)}`);
    const probe = await ffprobeVideo(clip, { ffprobe });
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    if (!video || !audio) throw new Error(`${relativeToRoot(clip)} must contain video and audio`);
    if (Number(video.width) !== width || Number(video.height) !== height) throw new Error(`${relativeToRoot(clip)} resolution is not ${width}x${height}`);
    if (Math.abs(fraction(video.avg_frame_rate) - fps) > 1e-6) throw new Error(`${relativeToRoot(clip)} frame rate is not ${fps}`);
    const duration = Number(probe.format?.duration);
    if (Math.abs(duration - 7.5) > 1 / fps) throw new Error(`${relativeToRoot(clip)} duration ${duration} is not 7.5s`);
    probes.push(probe);
  }
  return probes;
}

export async function assembleTwitterSummer({
  clips,
  outputFile,
  width = 1920,
  height = 1080,
  fps = 60,
  ffmpeg = process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobe = process.env.FFPROBE_BIN ?? process.env.FFPROBE_PATH ?? "ffprobe",
  log = (message) => console.log(`[twitter-summer] ${message}`)
}) {
  const resolvedClips = clips.map((clip) => path.resolve(clip));
  const resolvedOutput = path.resolve(outputFile);
  await validateClips(resolvedClips, { width, height, fps, ffprobe });
  const { graph, duration, offsets } = buildFilter({ width, height, fps, clipDuration: 7.5 });
  if (Math.abs(duration - 55) > 1e-9) throw new Error(`transition math produced ${duration}s, expected exactly 55s`);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  const temporary = `${resolvedOutput}.${process.pid}.tmp.mp4`;
  await rm(temporary, { force: true });
  const inputs = resolvedClips.flatMap((clip) => ["-i", clip]);
  log(`assembly: seven motivated transitions -> ${relativeToRoot(resolvedOutput)}`);
  try {
    await runCommand(ffmpeg, [
      "-hide_banner", "-y",
      ...inputs,
      "-filter_complex", graph,
      "-map", "[video]",
      "-map", "[audio]",
      "-frames:v", String(Math.round(duration * fps)),
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", "15",
      "-profile:v", "high",
      "-level:v", "4.2",
      "-pix_fmt", "yuv420p",
      "-tag:v", "avc1",
      "-g", String(fps * 2),
      "-keyint_min", String(fps),
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
      "-b:a", "256k",
      "-ar", "48000",
      "-ac", "2",
      "-movflags", "+faststart",
      temporary
    ], { log });
    await rename(temporary, resolvedOutput);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const info = await stat(resolvedOutput);
  return {
    file: relativeToRoot(resolvedOutput),
    bytes: info.size,
    duration,
    fps,
    totalFrames: Math.round(duration * fps),
    offsets,
    transitions: TWITTER_SUMMER_TRANSITIONS.map((transition, index) => ({ ...transition, offset: offsets[index] }))
  };
}
