// Utility to detect best available video codec (VP8 or H264)
import type { DebugMode } from '../types/config';

export function getBestVideoCodec(debug?: DebugMode): "VP8" | "H264" {
  const video = document.createElement("video");

  const isComponentDebug = (d?: DebugMode) => d === 'components' || d === 'all';
  const shouldLog = isComponentDebug(debug);

  // Detect Safari/iOS
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

  if (isSafari || isIOS) {
    if (video.canPlayType("video/mp4; codecs=avc1.42E01E")) {
      if (shouldLog) console.log("[DEBUG VoiceClient] Detected platform: Safari/iOS → Using H264");
      return "H264";
    } else {
      if (shouldLog) console.warn("[DEBUG VoiceClient] Safari/iOS cannot play H264? Defaulting to VP8");
      return "VP8";
    }
  }

  // For other platforms, prefer VP8
  if (video.canPlayType("video/webm; codecs=vp8")) {
    if (shouldLog) console.log("[DEBUG VoiceClient] Detected platform: Non-Safari → Using VP8");
    return "VP8";
  } else if (video.canPlayType("video/mp4; codecs=avc1.42E01E")) {
    if (shouldLog) console.log("[DEBUG VoiceClient] VP8 not supported, falling back to H264");
    return "H264";
  }

  // Fallback
  if (shouldLog) console.warn("[DEBUG VoiceClient] No supported codec detected, defaulting to VP8");
  return "VP8";
}
