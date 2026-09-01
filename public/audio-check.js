export const AUDIO_CHECK_AMBIENT_MS = 2_500;
export const AUDIO_CHECK_SPEECH_MS = 4_000;

const SILENCE_RMS = 0.0015;
const QUIET_SPEECH_RMS = 0.015;
const NOISY_AMBIENT_RMS = 0.012;
const CLIPPING_PEAK = 0.98;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function percentile(values, position) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * position));
  return sorted[index];
}

function finiteLevels(frames, key) {
  return frames
    .map((frame) => Number(frame?.[key]))
    .filter((value) => Number.isFinite(value) && value >= 0);
}

export function formatDbfs(value) {
  if (!Number.isFinite(value) || value <= 0) return '−∞ dBFS';
  return `${Math.round(20 * Math.log10(value))} dBFS`;
}

export function analyzeAudioCheck({ ambientFrames = [], speechFrames = [] } = {}) {
  const ambientLevels = finiteLevels(ambientFrames, 'rms');
  const speechLevels = finiteLevels(speechFrames, 'rms');
  const speechPeaks = finiteLevels(speechFrames, 'peak');
  const ambientRms = percentile(ambientLevels, 0.8);
  const speechRms = percentile(speechLevels, 0.75);
  const speechPeak = speechPeaks.length ? Math.max(...speechPeaks) : 0;
  const clippingFrames = speechPeaks.filter((peak) => peak >= CLIPPING_PEAK).length;
  const clippingRatio = clippingFrames / Math.max(1, speechPeaks.length);
  const snrRatio = ambientRms > 0 ? speechRms / ambientRms : Infinity;

  const silent = speechRms < SILENCE_RMS;
  const clipped = !silent && (speechPeak >= 0.995 || clippingRatio >= 0.05);
  const noisy = !silent && (ambientRms >= NOISY_AMBIENT_RMS || snrRatio < 4);
  const quiet = !silent && speechRms < QUIET_SPEECH_RMS;

  let outcome = 'good';
  if (silent) outcome = 'silent';
  else if (clipped) outcome = 'clipped';
  else if (noisy) outcome = 'noisy';
  else if (quiet) outcome = 'quiet';

  // Keep the gate above ordinary room tone, but never so high that it is likely
  // to trim the tested voice. The recommendation is opt-in; the user's manual
  // setting remains untouched until they apply it.
  const recommendedGate = silent
    ? null
    : clamp(Math.round(Math.min(Math.max(0.002, ambientRms * 1.7), speechRms * 0.45) * 1000), 1, 60);

  const copy = {
    good: {
      summary: '收音状态良好',
      guidance: '可以采用建议门限后开始字幕；开场后仍可随时手动调整。',
    },
    quiet: {
      summary: '语音偏小',
      guidance: '请靠近麦克风，或改用领夹麦、蓝牙耳机麦克风后再测一次。',
    },
    noisy: {
      summary: '背景噪声偏高',
      guidance: '请靠近麦克风、换一个输入设备，或改用领夹麦／蓝牙耳机麦克风。',
    },
    clipped: {
      summary: '输入过响，可能失真',
      guidance: '请调低系统输入音量、稍微远离麦克风，或换一个输入设备后再测。',
    },
    silent: {
      summary: '没有检测到可用语音',
      guidance: '请确认麦克风未静音并选对输入设备；靠近麦克风说话后再测一次。',
    },
  }[outcome];

  return {
    outcome,
    ...copy,
    recommendedGate,
    metrics: {
      ambientRms,
      speechRms,
      speechPeak,
      clippingRatio,
      snrRatio,
    },
    reports: {
      level: silent ? '无信号' : quiet ? '偏小' : clipped ? '过响' : '合适',
      noise: noisy ? '偏高' : '正常',
      clipping: clipped ? '检测到削波' : '未检测到',
      silence: silent ? '检测到静音' : '未检测到',
    },
  };
}
