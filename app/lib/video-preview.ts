const PREVIEW_CANDIDATE_TIMES = [0.5, 1, 1.5, 2, 3, 4, 6, 8, 10];
const BLACK_MEAN_LUMINANCE = 20;
const FRAME_PAINT_TIMEOUT_MS = 400;
const SEEK_TIMEOUT_MS = 4000;
const METADATA_TIMEOUT_MS = 15000;

type CancelCheck = () => boolean;

function waitForPaintedFrame(video: HTMLVideoElement) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, FRAME_PAINT_TIMEOUT_MS);
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => finish());
    }
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

function seekVideo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("seeked", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, SEEK_TIMEOUT_MS);
    video.addEventListener("seeked", finish, { once: true });
    try {
      video.currentTime = time;
    } catch {
      finish();
    }
  });
}

export function waitForMetadata(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("error", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, METADATA_TIMEOUT_MS);
    video.addEventListener("loadedmetadata", finish, { once: true });
    video.addEventListener("error", finish, { once: true });
  });
}

export async function ensureFrameAt(video: HTMLVideoElement, time: number, isCancelled?: CancelCheck) {
  if (isCancelled?.()) return;
  const duration = video.duration;
  const target = Number.isFinite(duration) && duration > 0
    ? Math.min(Math.max(0, time), Math.max(0, duration - 0.05))
    : Math.max(0, time);
  const hasFrame = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  const atTarget = Math.abs(video.currentTime - target) < 0.04;
  if (!atTarget || !hasFrame) {
    await seekVideo(video, !atTarget ? target : Math.max(target, 0.001));
  }
  if (isCancelled?.()) return;
  await waitForPaintedFrame(video);
}

function meanFrameLuminance(video: HTMLVideoElement) {
  const width = Math.min(48, video.videoWidth || 0);
  const height = Math.min(48, video.videoHeight || 0);
  if (!width || !height || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let total = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      total += pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
    }
    return total / (pixels.length / 4);
  } catch {
    return null;
  }
}

export async function pickVideoPreviewTime(video: HTMLVideoElement, isCancelled?: CancelCheck) {
  await ensureFrameAt(video, 0, isCancelled);
  if (isCancelled?.()) return 0;
  const firstLuminance = meanFrameLuminance(video);
  if (firstLuminance === null) return 0;
  if (firstLuminance >= BLACK_MEAN_LUMINANCE) return 0;

  const duration = video.duration;
  const candidates = PREVIEW_CANDIDATE_TIMES.filter(
    (time) => !Number.isFinite(duration) || duration <= 0 || time < duration - 0.25,
  );
  let best = { time: 0, luminance: firstLuminance };
  for (const time of candidates) {
    if (isCancelled?.()) return 0;
    await ensureFrameAt(video, time, isCancelled);
    if (isCancelled?.()) return 0;
    const luminance = meanFrameLuminance(video);
    if (luminance === null) continue;
    if (luminance >= BLACK_MEAN_LUMINANCE) return time;
    if (luminance > best.luminance) best = { time, luminance };
  }
  return best.time;
}

export async function applyVideoPreviewTime(video: HTMLVideoElement, isCancelled?: CancelCheck) {
  const time = await pickVideoPreviewTime(video, isCancelled);
  if (isCancelled?.()) return time;
  await ensureFrameAt(video, time, isCancelled);
  return time;
}

export function playPreviewFromStart(video: HTMLVideoElement) {
  try {
    video.currentTime = 0;
  } catch {
    /* empty */
  }
  void video.play().catch(() => undefined);
}

export function resetPreviewFrame(video: HTMLVideoElement, time: number) {
  video.pause();
  try {
    video.currentTime = time;
  } catch {
    /* empty */
  }
}

export function stopVideoPreview(video: HTMLVideoElement) {
  video.pause();
}
