package core

// ASRAudioPacket preserves ordering between PCM and ASR-only VAD endpoints.
// SoftEndpoint never denotes a business utterance commit.
type ASRAudioPacket struct {
	Audio        []byte
	SoftEndpoint bool
}
