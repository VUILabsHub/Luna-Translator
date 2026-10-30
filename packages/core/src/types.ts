// Shared display-unit type moved from frontend/src/types/history.ts.
export type TranslationDisplayUnit = {
  id: string
  text: string
  /** Provider ordinal used to restore deterministic order after out-of-order delivery. */
  providerIndex?: number
  // Provider playout segment ids attributed to this sentence. On WebRTC the
  // display unit id is an ordinal (`webrtc-translation-sentence-N`) that never
  // equals the playback marker's provider segment id, so highlight matching
  // falls back to membership here. Optional/absent on the WebSocket path, where
  // the unit id already equals the playing segment id.
  memberIds?: string[]
}
