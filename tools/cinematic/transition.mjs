import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const TRANSITION_SECONDS = 1.2;
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 2;
const MIN_OUTPUT_BYTES = 16 * 1024;
const COMMAND_OUTPUT_LIMIT = 2 * 1024 * 1024;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const mix = (from, to, amount) => from + (to - from) * amount;
const smoothstep = (from, to, value) => {
  if (from === to) return value < from ? 0 : 1;
  const t = clamp01((value - from) / (to - from));
  return t * t * (3 - 2 * t);
};

function finiteNumber(value, label, { integer = false, min, max } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number))) {
    throw new TypeError(`${label} must be ${integer ? "an integer" : "a finite number"}.`);
  }
  if (min !== undefined && number < min) {
    throw new RangeError(`${label} must be at least ${min}.`);
  }
  if (max !== undefined && number > max) {
    throw new RangeError(`${label} must be no greater than ${max}.`);
  }
  return number;
}

function requiredPath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty path.`);
  }
  return path.resolve(value);
}

function decimal(value) {
  return Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function appendLimited(current, chunk) {
  const next = current + chunk;
  return next.length <= COMMAND_OUTPUT_LIMIT ? next : next.slice(-COMMAND_OUTPUT_LIMIT);
}

function runCommand(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} could not start (${command}): ${error.message}`, { cause: error }));
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      const details = stderr.trim() || stdout.trim() || "No diagnostic output was produced.";
      reject(new Error(`${label} failed with ${reason}.\n${details}`));
    });
  });
}

function inferFfprobe(ffmpegPath) {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const basename = path.basename(ffmpegPath);
  if (/^ffmpeg(?:\.exe)?$/i.test(basename)) {
    const extension = path.extname(basename);
    const sibling = `ffprobe${extension}`;
    return path.dirname(ffmpegPath) === "." ? sibling : path.join(path.dirname(ffmpegPath), sibling);
  }
  return "ffprobe";
}

function parseRate(rate) {
  if (typeof rate !== "string") return Number.NaN;
  const [numerator, denominator = "1"] = rate.split("/").map(Number);
  return denominator ? numerator / denominator : Number.NaN;
}

async function probeMedia(ffprobe, mediaPath) {
  const { stdout } = await runCommand(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size:stream=index,codec_type,width,height,avg_frame_rate,r_frame_rate,duration,sample_rate,channels,color_range,color_space,color_transfer,color_primaries",
      "-of",
      "json",
      mediaPath,
    ],
    `ffprobe ${path.basename(mediaPath)}`,
  );

  let result;
  try {
    result = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON for ${mediaPath}.`, { cause: error });
  }

  const video = result.streams?.find((stream) => stream.codec_type === "video");
  const audio = result.streams?.find((stream) => stream.codec_type === "audio");
  const streamDuration = Number(video?.duration);
  const formatDuration = Number(result.format?.duration);
  const duration = Number.isFinite(streamDuration) && streamDuration > 0
    ? streamDuration
    : formatDuration;

  if (!video || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Expected a readable video stream with a positive duration in ${mediaPath}.`);
  }

  return {
    duration,
    video,
    audio,
    format: result.format ?? {},
    frameRate: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function makeMotes(width, height) {
  const random = seededRandom(0xe1d0_5eed);
  return Array.from({ length: 34 }, (_, index) => ({
    index,
    phase: random() * Math.PI * 2,
    start: random() * 0.24,
    orbitX: width * mix(0.055, 0.19, random()),
    orbitY: height * mix(0.05, 0.17, random()),
    size: height * mix(0.004, 0.012, random()),
    depth: mix(0.55, 1.3, random()),
    twinkle: mix(1.7, 4.8, random()),
  }));
}

function colorMix(from, to, amount) {
  const t = clamp01(amount);
  const channel = (index) => Math.round(mix(from[index], to[index], t));
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
}

function moteState(mote, progress, width, height) {
  const local = clamp01((progress - mote.start) / (1 - mote.start));
  const gather = smoothstep(0.18, 0.82, progress);
  const centerX = mix(width * 0.13, width * 0.53, smoothstep(0.05, 0.82, progress));
  const centerY = mix(height * 0.71, height * 0.47, smoothstep(0.08, 0.84, progress));
  const angle = mote.phase + local * Math.PI * (3.2 + mote.depth) - progress * 2.4;
  const contraction = mix(1, 0.13, gather);
  const x = centerX + Math.cos(angle) * mote.orbitX * contraction;
  const y = centerY + Math.sin(angle) * mote.orbitY * contraction;
  const morph = smoothstep(0.25, 0.67, progress);
  const radius = mote.size * mix(0.42, 1.9, morph) * (0.8 + mote.depth * 0.18);
  const entrance = smoothstep(mote.start, mote.start + 0.09, progress);
  const exit = 1 - smoothstep(0.77, 0.97, progress);
  const shimmer = 0.78 + 0.22 * Math.sin((progress * mote.twinkle + mote.phase) * Math.PI * 2);
  const alpha = clamp01(entrance * exit * shimmer);
  return { x, y, radius, morph, alpha, angle };
}

function heroState(progress, width, height) {
  const diagonal = Math.hypot(width, height);
  const raw = clamp01((progress - 0.31) / 0.49);
  const travel = smoothstep(0, 1, raw);
  const approach = raw ** 3.65;
  return {
    raw,
    x: mix(-width * 0.08, width * 0.53, travel),
    y: mix(height * 0.76, height * 0.47, travel) - Math.sin(raw * Math.PI) * height * 0.075,
    radius: mix(height * 0.034, diagonal * 1.18, approach),
    rotation: -24 + raw * 118,
    alpha: smoothstep(0.3, 0.39, progress) * (1 - smoothstep(0.79, 0.95, progress)),
  };
}

function overlaySvg({ width, height, progress, motes }) {
  const hero = heroState(progress, width, height);
  const morph = smoothstep(0.25, 0.68, progress);
  const moteColor = colorMix([54, 238, 255], [194, 238, 66], morph);
  const trailAlpha = smoothstep(0, 0.12, progress) * (1 - smoothstep(0.67, 0.86, progress));
  const trailWidth = Math.max(3, height * 0.006);
  const impact = 1 - clamp01(Math.abs(progress - 0.79) / 0.085);
  const heroStroke = Math.max(2, hero.radius * 0.035);
  const heroSeam = Math.max(2, hero.radius * 0.026);

  const moteMarkup = motes.map((mote) => {
    const state = moteState(mote, progress, width, height);
    if (state.alpha <= 0.002) return "";
    const glowRadius = state.radius * mix(2.6, 1.7, state.morph);
    const seamOpacity = state.morph * state.alpha * smoothstep(height * 0.008, height * 0.018, state.radius);
    const seamRadius = state.radius * 0.62;
    return `
      <g opacity="${decimal(state.alpha)}">
        <circle cx="${decimal(state.x)}" cy="${decimal(state.y)}" r="${decimal(glowRadius)}"
          fill="${moteColor}" fill-opacity="0.28" filter="url(#moteGlow)"/>
        <circle cx="${decimal(state.x)}" cy="${decimal(state.y)}" r="${decimal(state.radius)}"
          fill="${moteColor}" stroke="rgba(255,255,255,0.55)" stroke-width="${decimal(Math.max(0.75, state.radius * 0.09))}"/>
        <path d="M ${decimal(state.x - seamRadius)} ${decimal(state.y - seamRadius * 0.45)}
          C ${decimal(state.x - seamRadius * 0.15)} ${decimal(state.y - seamRadius * 0.05)},
            ${decimal(state.x + seamRadius * 0.15)} ${decimal(state.y + seamRadius * 0.05)},
            ${decimal(state.x + seamRadius)} ${decimal(state.y + seamRadius * 0.45)}"
          fill="none" stroke="#fff9cf" stroke-opacity="${decimal(seamOpacity)}"
          stroke-width="${decimal(Math.max(0.7, state.radius * 0.11))}" stroke-linecap="round"/>
      </g>`;
  }).join("");

  const heroMarkup = hero.raw > 0 && hero.alpha > 0.002 ? `
    <g opacity="${decimal(hero.alpha)}" transform="rotate(${decimal(hero.rotation)} ${decimal(hero.x)} ${decimal(hero.y)})">
      <circle cx="${decimal(hero.x)}" cy="${decimal(hero.y)}" r="${decimal(hero.radius * 1.07)}"
        fill="#c8ff45" fill-opacity="0.42" filter="url(#heroGlow)"/>
      <circle cx="${decimal(hero.x)}" cy="${decimal(hero.y)}" r="${decimal(hero.radius)}"
        fill="url(#heroBall)" stroke="#ecff9a" stroke-width="${decimal(heroStroke)}"/>
      <g clip-path="url(#heroClip)">
        <path d="M ${decimal(hero.x - hero.radius * 0.88)} ${decimal(hero.y - hero.radius * 0.58)}
          C ${decimal(hero.x - hero.radius * 0.28)} ${decimal(hero.y - hero.radius * 0.18)},
            ${decimal(hero.x - hero.radius * 0.28)} ${decimal(hero.y + hero.radius * 0.18)},
            ${decimal(hero.x - hero.radius * 0.88)} ${decimal(hero.y + hero.radius * 0.58)}"
          fill="none" stroke="#fffbd1" stroke-width="${decimal(heroSeam)}"/>
        <path d="M ${decimal(hero.x + hero.radius * 0.88)} ${decimal(hero.y - hero.radius * 0.58)}
          C ${decimal(hero.x + hero.radius * 0.28)} ${decimal(hero.y - hero.radius * 0.18)},
            ${decimal(hero.x + hero.radius * 0.28)} ${decimal(hero.y + hero.radius * 0.18)},
            ${decimal(hero.x + hero.radius * 0.88)} ${decimal(hero.y + hero.radius * 0.58)}"
          fill="none" stroke="#fffbd1" stroke-width="${decimal(heroSeam)}"/>
      </g>
    </g>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <filter id="moteGlow" x="-250%" y="-250%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="${decimal(Math.max(2, height * 0.006))}"/>
        </filter>
        <filter id="heroGlow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="${decimal(Math.max(4, height * 0.018))}"/>
        </filter>
        <linearGradient id="plumeTrail" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color="#34eeff" stop-opacity="0"/>
          <stop offset="0.34" stop-color="#34eeff"/>
          <stop offset="1" stop-color="#c2ee42" stop-opacity="0.9"/>
        </linearGradient>
        <radialGradient id="heroBall" cx="35%" cy="28%" r="78%">
          <stop offset="0" stop-color="#f4ff9b"/>
          <stop offset="0.42" stop-color="#c7ee43"/>
          <stop offset="1" stop-color="#76a90d"/>
        </radialGradient>
        <clipPath id="heroClip">
          <circle cx="${decimal(hero.x)}" cy="${decimal(hero.y)}" r="${decimal(Math.max(0, hero.radius * 0.98))}"/>
        </clipPath>
      </defs>
      <path d="M ${decimal(width * 0.015)} ${decimal(height * 0.73)}
        C ${decimal(width * 0.17)} ${decimal(height * 0.9)},
          ${decimal(width * 0.34)} ${decimal(height * 0.22)},
          ${decimal(Math.max(width * 0.18, hero.x))} ${decimal(hero.y)}"
        fill="none" stroke="url(#plumeTrail)" stroke-width="${decimal(trailWidth)}"
        stroke-linecap="round" stroke-dasharray="${decimal(trailWidth * 1.1)} ${decimal(trailWidth * 2.3)}"
        stroke-dashoffset="${decimal(-progress * width * 0.11)}" opacity="${decimal(trailAlpha * 0.62)}"
        filter="url(#moteGlow)"/>
      ${moteMarkup}
      ${heroMarkup}
      <circle cx="${decimal(width * 0.53)}" cy="${decimal(height * 0.47)}"
        r="${decimal(mix(height * 0.05, height * 0.64, impact))}"
        fill="none" stroke="#f8ffd8" stroke-width="${decimal(Math.max(2, height * 0.008 * impact))}"
        stroke-opacity="${decimal(impact * 0.68)}" filter="url(#heroGlow)"/>
      <rect width="${width}" height="${height}" fill="#f7ffe4" fill-opacity="${decimal(impact * 0.12)}"/>
    </svg>`;
}

function maskSvg({ width, height, progress, motes }) {
  const hero = heroState(progress, width, height);
  const globalReveal = smoothstep(0.78, 0.985, progress);
  const baseLevel = Math.round(globalReveal * 255);
  const feather = Math.max(2, height * 0.0055);
  const discMarkup = motes.map((mote) => {
    const state = moteState(mote, progress, width, height);
    const reveal = state.alpha * smoothstep(0.3, 0.68, progress) * (1 - globalReveal);
    if (reveal <= 0.003) return "";
    return `<circle cx="${decimal(state.x)}" cy="${decimal(state.y)}"
      r="${decimal(state.radius * mix(1.5, 3.1, state.morph))}"
      fill="white" fill-opacity="${decimal(reveal * 0.88)}"/>`;
  }).join("");
  const heroReveal = smoothstep(0.34, 0.49, progress) * (1 - smoothstep(0.86, 1, progress));

  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <filter id="feather" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="${decimal(feather)}"/>
        </filter>
      </defs>
      <rect width="${width}" height="${height}" fill="rgb(${baseLevel},${baseLevel},${baseLevel})"/>
      <g filter="url(#feather)">
        ${discMarkup}
        <circle cx="${decimal(hero.x)}" cy="${decimal(hero.y)}" r="${decimal(hero.radius)}"
          fill="white" fill-opacity="${decimal(heroReveal)}"/>
      </g>
    </svg>`;
}

async function generateTransitionFrames({ assetsDir, width, height, fps, frameCount }) {
  const overlayPattern = path.join(assetsDir, "overlay-%05d.png");
  const maskPattern = path.join(assetsDir, "mask-%05d.png");
  const motes = makeMotes(width, height);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const progress = frameCount === 1 ? 1 : frame / (frameCount - 1);
    const suffix = String(frame).padStart(5, "0");
    const overlayPath = path.join(assetsDir, `overlay-${suffix}.png`);
    const maskPath = path.join(assetsDir, `mask-${suffix}.png`);
    const overlay = overlaySvg({ width, height, progress, motes });
    const mask = maskSvg({ width, height, progress, motes });

    // Render sequentially: it bounds peak memory even for UHD output while keeping
    // every generated frame byte-for-byte deterministic for a given configuration.
    await sharp(Buffer.from(overlay), { density: 72, limitInputPixels: false })
      .ensureAlpha()
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(overlayPath);
    await sharp(Buffer.from(mask), { density: 72, limitInputPixels: false })
      .removeAlpha()
      .greyscale()
      .png({ compressionLevel: 9, palette: true })
      .toFile(maskPath);
  }

  return { overlayPattern, maskPattern };
}

function wavBuffer(frameCount, sampleAtFrame) {
  const bytesPerSample = 2;
  const blockAlign = AUDIO_CHANNELS * bytesPerSample;
  const dataBytes = frameCount * blockAlign;
  const buffer = Buffer.allocUnsafe(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(AUDIO_CHANNELS, 22);
  buffer.writeUInt32LE(AUDIO_SAMPLE_RATE, 24);
  buffer.writeUInt32LE(AUDIO_SAMPLE_RATE * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const samples = sampleAtFrame(frame);
    for (let channel = 0; channel < AUDIO_CHANNELS; channel += 1) {
      const sample = Math.max(-1, Math.min(1, samples[channel] ?? samples[0] ?? 0));
      const integer = sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767);
      buffer.writeInt16LE(integer, offset);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

async function writeSilentWav(filePath, duration) {
  const frames = Math.max(1, Math.round(duration * AUDIO_SAMPLE_RATE));
  await writeFile(filePath, wavBuffer(frames, () => [0, 0]));
}

async function materializeAudio({ ffmpeg, sourcePath, hasAudio, duration, outputPath }) {
  if (!hasAudio) {
    await writeSilentWav(outputPath, duration);
    return;
  }

  const targetDuration = decimal(duration);
  await runCommand(
    ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-map",
      "0:a:0",
      "-vn",
      "-af",
      `aresample=${AUDIO_SAMPLE_RATE}:async=1:first_pts=0,apad=whole_dur=${targetDuration},atrim=duration=${targetDuration},asetpts=N/SR/TB`,
      "-ar",
      String(AUDIO_SAMPLE_RATE),
      "-ac",
      String(AUDIO_CHANNELS),
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    `audio normalization for ${path.basename(sourcePath)}`,
  );
}

async function writeTransitionSound(filePath, duration) {
  const frameCount = Math.max(1, Math.round(duration * AUDIO_SAMPLE_RATE));
  const random = seededRandom(0x51a7_cafe);
  const sparkleRandom = seededRandom(0x8bad_f00d);
  const sparkles = Array.from({ length: 15 }, () => ({
    start: mix(0.09, 0.7, sparkleRandom()) * duration,
    length: mix(0.07, 0.2, sparkleRandom()),
    frequency: mix(1_350, 5_800, sparkleRandom()),
    sweep: mix(350, 2_200, sparkleRandom()),
    pan: mix(-0.9, 0.9, sparkleRandom()),
    phase: sparkleRandom() * Math.PI * 2,
    gain: mix(0.035, 0.105, sparkleRandom()),
  }));
  const impactTime = duration * 0.79;
  let noiseState = 0;

  const audio = wavBuffer(frameCount, (frame) => {
    const time = frame / AUDIO_SAMPLE_RATE;
    const progress = time / duration;
    const noise = random() * 2 - 1;
    const cutoff = mix(0.025, 0.4, smoothstep(0.05, 0.82, progress));
    noiseState += (noise - noiseState) * cutoff;
    const whooshEnvelope = smoothstep(0.015, 0.18, progress)
      * (1 - smoothstep(0.78, 1, progress));
    const whooshPan = Math.sin(progress * Math.PI * 3.2) * 0.72;
    const tonalPhase = Math.PI * 2 * (155 * time + 780 * time * time);
    const tonal = Math.sin(tonalPhase) * whooshEnvelope * 0.055;
    const whoosh = noiseState * whooshEnvelope * mix(0.1, 0.31, progress) + tonal;
    let left = whoosh * Math.sqrt((1 - whooshPan) * 0.5);
    let right = whoosh * Math.sqrt((1 + whooshPan) * 0.5);

    for (const sparkle of sparkles) {
      const age = time - sparkle.start;
      if (age < 0 || age > sparkle.length) continue;
      const envelope = Math.sin(Math.PI * age / sparkle.length) ** 2 * Math.exp(-age * 7.5);
      const phase = sparkle.phase + Math.PI * 2
        * (sparkle.frequency * age + sparkle.sweep * age * age * 0.5);
      const sample = Math.sin(phase) * envelope * sparkle.gain;
      left += sample * Math.sqrt((1 - sparkle.pan) * 0.5);
      right += sample * Math.sqrt((1 + sparkle.pan) * 0.5);
    }

    const impactAge = time - impactTime;
    if (impactAge >= 0) {
      const impactEnvelope = Math.exp(-impactAge * 11.5);
      const bassPhase = Math.PI * 2 * (92 * impactAge - 25 * impactAge * impactAge);
      const click = (random() * 2 - 1) * Math.exp(-impactAge * 58) * 0.2;
      const impact = Math.sin(bassPhase) * impactEnvelope * 0.38 + click;
      left += impact;
      right += impact;
    }

    // Gentle saturation keeps the generated stem safe before it reaches the
    // final mix limiter while retaining the impact's low-end weight.
    return [Math.tanh(left * 1.15) * 0.82, Math.tanh(right * 1.15) * 0.82];
  });

  await writeFile(filePath, audio);
}

function videoFilters({ width, height, fps, hoverFrames, dogFrames, transitionFrames }) {
  const hoverPreFrames = hoverFrames - transitionFrames;
  const pointClock = `setpts=N/(${fps}*TB)`;
  const scaleAndPad = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
  ].join(",");

  return [
    `[0:v:0]fps=${fps}:round=near,${scaleAndPad},format=yuv444p,split=2[hoverPreSource][hoverTailSource]`,
    `[hoverPreSource]trim=end_frame=${hoverPreFrames},${pointClock}[hoverPre]`,
    `[hoverTailSource]trim=start_frame=${hoverPreFrames}:end_frame=${hoverFrames},${pointClock}[hoverTail]`,
    `[1:v:0]fps=${fps}:round=near,${scaleAndPad},format=yuv444p,split=2[dogHeadSource][dogPostSource]`,
    `[dogHeadSource]trim=end_frame=${transitionFrames},${pointClock}[dogHead]`,
    `[dogPostSource]trim=start_frame=${transitionFrames}:end_frame=${dogFrames},${pointClock}[dogPost]`,
    `[3:v:0]fps=${fps}:round=near,scale=${width}:${height}:flags=neighbor,format=gray,trim=end_frame=${transitionFrames},${pointClock}[revealMask]`,
    `[hoverTail][dogHead][revealMask]maskedmerge,format=yuv444p[maskedTransition]`,
    `[2:v:0]fps=${fps}:round=near,scale=${width}:${height}:flags=lanczos,format=rgba,trim=end_frame=${transitionFrames},${pointClock}[transitionOverlay]`,
    `[maskedTransition][transitionOverlay]overlay=0:0:shortest=1:eof_action=pass:format=auto,format=yuv444p[transitionVideo]`,
    `[hoverPre][transitionVideo][dogPost]concat=n=3:v=1:a=0,format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[videoOut]`,
  ];
}

function audioFilters({ hoverDuration, dogDuration, transitionDuration, outputDuration }) {
  const transitionOffsetMs = Math.round((hoverDuration - transitionDuration) * 1_000);
  return [
    `[4:a:0]atrim=duration=${decimal(hoverDuration)},asetpts=N/SR/TB[hoverAudio]`,
    `[5:a:0]atrim=duration=${decimal(dogDuration)},asetpts=N/SR/TB[dogAudio]`,
    `[hoverAudio][dogAudio]acrossfade=d=${decimal(transitionDuration)}:c1=qsin:c2=qsin[crossfadedAudio]`,
    `[6:a:0]atrim=duration=${decimal(transitionDuration)},asetpts=N/SR/TB,volume=0.74,adelay=${transitionOffsetMs}:all=1,apad=whole_dur=${decimal(outputDuration)},atrim=duration=${decimal(outputDuration)}[transitionSound]`,
    `[crossfadedAudio][transitionSound]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:attack=5:release=50[audioOut]`,
  ];
}

async function validateOutput({ ffmpeg, ffprobe, outputPath, width, height, fps, expectedDuration }) {
  const file = await stat(outputPath);
  if (!file.isFile() || file.size < MIN_OUTPUT_BYTES) {
    throw new Error(`Rendered output is unexpectedly small (${file.size} bytes): ${outputPath}`);
  }

  const probe = await probeMedia(ffprobe, outputPath);
  if (Number(probe.video.width) !== width || Number(probe.video.height) !== height) {
    throw new Error(
      `Output dimensions are ${probe.video.width}x${probe.video.height}; expected ${width}x${height}.`,
    );
  }
  if (!probe.audio) {
    throw new Error("Combined output does not contain the required audio stream.");
  }
  if (Number.isFinite(probe.frameRate) && Math.abs(probe.frameRate - fps) > 0.05) {
    throw new Error(`Output frame rate is ${probe.frameRate}; expected ${fps}.`);
  }
  const colorTags = {
    color_primaries: probe.video.color_primaries,
    color_transfer: probe.video.color_transfer,
    color_space: probe.video.color_space,
  };
  const invalidColorTags = Object.entries(colorTags)
    .filter(([, value]) => value !== "bt709")
    .map(([key, value]) => `${key}=${value ?? "unset"}`);
  if (invalidColorTags.length > 0) {
    throw new Error(`Output is missing complete BT.709 color signaling (${invalidColorTags.join(", ")}).`);
  }
  const durationTolerance = Math.max(0.16, 3 / fps);
  if (Math.abs(probe.duration - expectedDuration) > durationTolerance) {
    throw new Error(
      `Output duration is ${probe.duration.toFixed(3)}s; expected ${expectedDuration.toFixed(3)}s `
      + `(tolerance ${durationTolerance.toFixed(3)}s).`,
    );
  }

  await runCommand(
    ffmpeg,
    ["-v", "error", "-i", outputPath, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"],
    "full output decode validation",
  );

  return { probe, bytes: file.size };
}

/**
 * Combines two complete cinematic clips with the deterministic “plume-to-play”
 * transition. The clips overlap by approximately 1.2 seconds, so the resulting
 * duration is hoverboard + dog park - transition.
 */
export async function combineCinematics({
  hoverboardPath,
  dogParkPath,
  outputPath,
  workDir,
  fps,
  width,
  height,
  ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg",
} = {}) {
  const hoverboard = requiredPath(hoverboardPath, "hoverboardPath");
  const dogPark = requiredPath(dogParkPath, "dogParkPath");
  const output = requiredPath(outputPath, "outputPath");
  const workspace = requiredPath(workDir, "workDir");
  const targetFps = finiteNumber(fps, "fps", { integer: true, min: 1, max: 240 });
  const targetWidth = finiteNumber(width, "width", { integer: true, min: 16, max: 8_192 });
  const targetHeight = finiteNumber(height, "height", { integer: true, min: 16, max: 8_192 });
  if (typeof ffmpeg !== "string" || ffmpeg.trim() === "") {
    throw new TypeError("ffmpeg must be a non-empty executable path or command name.");
  }
  if (output === hoverboard || output === dogPark) {
    throw new Error("outputPath must not overwrite either source cinematic.");
  }
  const outputExtension = path.extname(output).toLowerCase();
  if (outputExtension !== ".mp4" && outputExtension !== ".mov") {
    throw new Error("outputPath must end in .mp4 or .mov for H.264/AAC delivery.");
  }

  await Promise.all([
    access(hoverboard, fsConstants.R_OK),
    access(dogPark, fsConstants.R_OK),
    mkdir(workspace, { recursive: true }),
    mkdir(path.dirname(output), { recursive: true }),
  ]);

  const ffprobe = inferFfprobe(ffmpeg);
  const [hoverProbe, dogProbe] = await Promise.all([
    probeMedia(ffprobe, hoverboard),
    probeMedia(ffprobe, dogPark),
  ]);

  const transitionFrames = Math.max(2, Math.round(TRANSITION_SECONDS * targetFps));
  const transitionDuration = transitionFrames / targetFps;
  const hoverFrames = Math.max(1, Math.round(hoverProbe.duration * targetFps));
  const dogFrames = Math.max(1, Math.round(dogProbe.duration * targetFps));
  if (hoverFrames <= transitionFrames || dogFrames <= transitionFrames) {
    throw new Error(
      `Both clips must be longer than the ${transitionDuration.toFixed(3)}s transition `
      + `(hoverboard ${hoverProbe.duration.toFixed(3)}s, dog park ${dogProbe.duration.toFixed(3)}s).`,
    );
  }

  const hoverDuration = hoverFrames / targetFps;
  const dogDuration = dogFrames / targetFps;
  const outputDuration = (hoverFrames + dogFrames - transitionFrames) / targetFps;
  const assetsDir = await mkdtemp(path.join(workspace, "plume-to-play-"));
  const hoverAudioPath = path.join(assetsDir, "hoverboard-audio.wav");
  const dogAudioPath = path.join(assetsDir, "dog-park-audio.wav");
  const transitionAudioPath = path.join(assetsDir, "plume-to-play-fx.wav");
  const temporaryOutput = path.join(
    path.dirname(output),
    `.${path.basename(output, outputExtension)}.partial-${process.pid}-${Date.now()}${outputExtension}`,
  );

  try {
    const [{ overlayPattern, maskPattern }] = await Promise.all([
      generateTransitionFrames({
        assetsDir,
        width: targetWidth,
        height: targetHeight,
        fps: targetFps,
        frameCount: transitionFrames,
      }),
      materializeAudio({
        ffmpeg,
        sourcePath: hoverboard,
        hasAudio: Boolean(hoverProbe.audio),
        duration: hoverDuration,
        outputPath: hoverAudioPath,
      }),
      materializeAudio({
        ffmpeg,
        sourcePath: dogPark,
        hasAudio: Boolean(dogProbe.audio),
        duration: dogDuration,
        outputPath: dogAudioPath,
      }),
      writeTransitionSound(transitionAudioPath, transitionDuration),
    ]);

    const filters = [
      ...videoFilters({
        width: targetWidth,
        height: targetHeight,
        fps: targetFps,
        hoverFrames,
        dogFrames,
        transitionFrames,
      }),
      ...audioFilters({ hoverDuration, dogDuration, transitionDuration, outputDuration }),
    ].join(";");

    await runCommand(
      ffmpeg,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        hoverboard,
        "-i",
        dogPark,
        "-thread_queue_size",
        "512",
        "-framerate",
        String(targetFps),
        "-start_number",
        "0",
        "-i",
        overlayPattern,
        "-thread_queue_size",
        "512",
        "-framerate",
        String(targetFps),
        "-start_number",
        "0",
        "-i",
        maskPattern,
        "-i",
        hoverAudioPath,
        "-i",
        dogAudioPath,
        "-i",
        transitionAudioPath,
        "-filter_complex",
        filters,
        "-map",
        "[videoOut]",
        "-map",
        "[audioOut]",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "14",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-fps_mode",
        "cfr",
        "-r",
        String(targetFps),
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        String(AUDIO_SAMPLE_RATE),
        "-t",
        decimal(outputDuration),
        "-movflags",
        "+faststart",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-metadata",
        "comment=plume-to-play deterministic cinematic transition",
        temporaryOutput,
      ],
      "plume-to-play cinematic composition",
    );

    const validation = await validateOutput({
      ffmpeg,
      ffprobe,
      outputPath: temporaryOutput,
      width: targetWidth,
      height: targetHeight,
      fps: targetFps,
      expectedDuration: outputDuration,
    });

    await rm(output, { force: true });
    await rename(temporaryOutput, output);

    return Object.freeze({
      outputPath: output,
      workDir: workspace,
      assetsDir,
      duration: validation.probe.duration,
      expectedDuration: outputDuration,
      transitionDuration,
      transitionFrames,
      width: targetWidth,
      height: targetHeight,
      fps: targetFps,
      bytes: validation.bytes,
      sourceAudio: {
        hoverboard: Boolean(hoverProbe.audio),
        dogPark: Boolean(dogProbe.audio),
      },
    });
  } catch (error) {
    await rm(temporaryOutput, { force: true }).catch(() => {});
    const wrapped = new Error(
      `Unable to combine cinematics. Generated transition assets were retained at ${assetsDir}.\n${error.message}`,
      { cause: error },
    );
    wrapped.assetsDir = assetsDir;
    throw wrapped;
  }
}
