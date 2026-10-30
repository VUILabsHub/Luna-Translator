// settings-11：闭集与选项表的唯一真相已下沉到 `@simultrans/core/audioProcessing`
// （移动端够不着 ui-shared，留在这里必然两端漂移）。本文件只做 re-export，保持
// Web 侧既有 import 路径不变。
export {
  defaultLoudnessThreshold,
  FRAME_RMS_DEFAULT_THRESHOLD,
  FRAME_RMS_THRESHOLDS,
  frameRMSLoudnessOptions,
  loudnessThresholdOptions,
  loudnessThresholds,
  P90_DEFAULT_THRESHOLD,
  P90_THRESHOLDS,
  p90LoudnessOptions,
  storedFrameRMSThreshold,
  storedP90Threshold,
  storedVADLoudnessMode,
  VAD_LOUDNESS_MODES,
} from '@simultrans/core/audioProcessing'

export type {
  FrameRMSLoudnessThresholdDbfs,
  LoudnessThresholdOption,
  P90LoudnessThresholdDbfs,
  VADLoudnessMode,
  VADLoudnessThresholdDbfs,
} from '@simultrans/core/audioProcessing'
