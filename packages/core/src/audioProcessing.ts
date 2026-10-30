// VAD 响度门控的闭集与选项表（Web 与 React Native 共用）。
//
// settings-11：这张表之前有三份——`packages/ui-shared/src/lib/audioProcessing.ts`
// （Web 用）、`mobile/src/components/AdvancedAudioSettings.tsx`（自拼标签，默认档
// 后缀写成「推荐」而不是「默认」）、`mobile/src/settings/advanced.ts`
// （`normalizeAudioProcessing` 里的裸数组）。移动端够不着 `ui-shared`，所以
// 常量下沉到 core，三处都从这里取。
//
// 纯数据 + 纯函数：不 import react / react-native / DOM。

export type VADLoudnessMode = 'frame_rms' | 'p90_400ms'
/** Integer dBFS values from -55 through -10, validated when restoring settings. */
export type VADLoudnessThresholdDbfs = number
export type FrameRMSLoudnessThresholdDbfs = VADLoudnessThresholdDbfs
export type P90LoudnessThresholdDbfs = VADLoudnessThresholdDbfs

export const VAD_LOUDNESS_MODES: readonly VADLoudnessMode[] = ['frame_rms', 'p90_400ms']
export const VAD_LOUDNESS_MIN_DBFS = -55
export const VAD_LOUDNESS_MAX_DBFS = -10

/** One dB steps, ordered from strict to permissive in both gate pickers. */
const THRESHOLDS: readonly number[] = Array.from(
  { length: VAD_LOUDNESS_MAX_DBFS - VAD_LOUDNESS_MIN_DBFS + 1 },
  (_, index) => VAD_LOUDNESS_MAX_DBFS - index,
)
export const FRAME_RMS_THRESHOLDS = THRESHOLDS
export const P90_THRESHOLDS = THRESHOLDS

export function isVADLoudnessThreshold(value: unknown): value is VADLoudnessThresholdDbfs {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= VAD_LOUDNESS_MIN_DBFS && value <= VAD_LOUDNESS_MAX_DBFS
}

/** 各档的默认值（也是非法落盘值的归位目标）。 */
export const FRAME_RMS_DEFAULT_THRESHOLD: FrameRMSLoudnessThresholdDbfs = -40
export const P90_DEFAULT_THRESHOLD: P90LoudnessThresholdDbfs = -30

/** 阈值后缀（Web 现行文案；`（默认）`/`（推荐）` 各自只挂在本档的默认值上）。 */
const THRESHOLD_NOTES: Record<VADLoudnessMode, Record<number, string>> = {
  frame_rms: { [-35]: '严格', [-40]: '默认', [-45]: '宽松' },
  p90_400ms: { [-20]: '极端', [-25]: '严格', [-30]: '推荐', [-35]: '适中', [-40]: '宽松' },
}

export type LoudnessThresholdOption = { value: string; label: string }

/** 某个门控模式下的阈值选项（`-40 dBFS（默认）`）。 */
export function loudnessThresholdOptions(mode: VADLoudnessMode): LoudnessThresholdOption[] {
  const values: readonly number[] = mode === 'p90_400ms' ? P90_THRESHOLDS : FRAME_RMS_THRESHOLDS
  return values.map((value) => {
    const note = THRESHOLD_NOTES[mode][value]
    return { value: String(value), label: note ? `${value} dBFS（${note}）` : `${value} dBFS` }
  })
}

export const frameRMSLoudnessOptions = loudnessThresholdOptions('frame_rms')
export const p90LoudnessOptions = loudnessThresholdOptions('p90_400ms')

/** 该门控模式下的合法阈值闭集。 */
export function loudnessThresholds(mode: VADLoudnessMode): readonly number[] {
  return mode === 'p90_400ms' ? P90_THRESHOLDS : FRAME_RMS_THRESHOLDS
}

/** 该门控模式下的默认阈值。 */
export function defaultLoudnessThreshold(mode: VADLoudnessMode): number {
  return mode === 'p90_400ms' ? P90_DEFAULT_THRESHOLD : FRAME_RMS_DEFAULT_THRESHOLD
}

export function storedVADLoudnessMode(value: unknown): VADLoudnessMode {
  return value === 'p90_400ms' ? value : 'frame_rms'
}

export function storedFrameRMSThreshold(value: unknown): FrameRMSLoudnessThresholdDbfs {
  return isVADLoudnessThreshold(value) ? value : FRAME_RMS_DEFAULT_THRESHOLD
}

export function storedP90Threshold(value: unknown): P90LoudnessThresholdDbfs {
  return isVADLoudnessThreshold(value) ? value : P90_DEFAULT_THRESHOLD
}
