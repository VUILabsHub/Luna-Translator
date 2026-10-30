package qwenasr

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"simultrans/core"
)

const (
	primaryAudioBuffer          = 16
	sourceAudioBuffer           = 256
	primaryEventBuffer          = 32
	sourceReconnectAttempts     = 5
	sourceReconnectInitialDelay = 250 * time.Millisecond
	sourceReconnectMaxDelay     = 2 * time.Second
	// Gateway model and translation cursors can differ by one encoded audio
	// frame because they are measured on separate output paths.
	modelOutputDoneCursorToleranceMs = int64(40)
)

func isSourceTranscriptEvent(event core.Event) bool {
	switch event.Type {
	case "source_delta", "source_update", "source_done":
		return true
	default:
		return false
	}
}

type SidecarProvider struct {
	Primary                          core.Provider
	Source                           core.Provider
	GateSourceWithPrimaryVAD         bool
	SourceVADPreRollMs               int64
	SourceVADPostRollMs              int64
	SourceVADSilenceCommitMs         int64
	SourceVADCommitFromModelInterval bool
	OnError                          func(error)
	Recorder                         core.EventRecorder
}

func (p SidecarProvider) shouldGateSourceWithPrimaryVAD(_ core.SessionConfig) bool {
	return p.GateSourceWithPrimaryVAD
}

type primarySourceResolution struct {
	fallback    bool
	acknowledge chan struct{}
}

func isSourceVADEvent(event core.Event) bool {
	switch event.Type {
	case "source_vad_state", "source_vad_segment", "source_vad_commit", "source_vad_audio":
		return true
	default:
		return false
	}
}

func vadUtteranceID(epoch int) string {
	if epoch <= 0 {
		return ""
	}
	return fmt.Sprintf("vad-%d", epoch)
}

func (p SidecarProvider) sourceVADCommitThresholdMs(config core.SessionConfig) int64 {
	if p.SourceVADCommitFromModelInterval &&
		(config.Qwen3ModelIntervalMs == 1000 || config.Qwen3ModelIntervalMs == 2000) {
		return int64(config.Qwen3ModelIntervalMs)
	}
	return p.SourceVADSilenceCommitMs
}

// sourceVADCommitTracker reconciles the primary engine's source-audio cursor
// instead of guessing a strong VAD boundary with a backend wall-clock timer.
// The next speech_start is definitive: when it starts before endpoint+threshold
// the engine never reached silence_threshold, so the existing utterance stays
// open; otherwise the prior utterance is committed immediately before the new
// speech event is forwarded.
type sourceVADCommitTracker struct {
	thresholdMs int64
	pending     core.Event
}

type speechCursorTarget struct {
	startMs     int64
	speechEpoch int
	utteranceID string
}

type sourceAudioTimeline struct {
	startMs    int64
	endMs      int64
	hasStartMs bool
	hasEndMs   bool
}

func mergeSourceAudioTimeline(current sourceAudioTimeline, startMs, endMs *int64) sourceAudioTimeline {
	if startMs != nil && *startMs >= 0 && (!current.hasStartMs || *startMs < current.startMs) {
		current.startMs = *startMs
		current.hasStartMs = true
	}
	if endMs != nil && *endMs >= 0 && (!current.hasEndMs || *endMs > current.endMs) {
		current.endMs = *endMs
		current.hasEndMs = true
	}
	return current
}

func attachSourceAudioTimeline(event core.Event, timeline sourceAudioTimeline) core.Event {
	hasCompleteEventTimeline := event.StartMs != nil && event.EndMs != nil &&
		*event.StartMs >= 0 && *event.EndMs > *event.StartMs
	if event.Type != "source_done" || hasCompleteEventTimeline || !timeline.hasStartMs ||
		!timeline.hasEndMs || timeline.endMs <= timeline.startMs {
		return event
	}
	startMs, endMs := timeline.startMs, timeline.endMs
	event.StartMs = &startMs
	event.EndMs = &endMs
	return event
}

type modelOutputTargetHint struct {
	target   speechCursorTarget
	snapshot string
}

// sourceTranscriptAssociation keeps every continuous, non-gated ASR item on
// the VAD utterance that owned its first preview. Qwen may interleave a new
// item's preview before an older item's completed event, so association is
// keyed by the provider's stable item ID rather than one global current item.
// Items that have no preview claim the oldest unconsumed VAD target; this is a
// provider-event FIFO, not a frontend transcript-array position.
type sourceTranscriptAssociation struct {
	itemTargets         map[string]speechCursorTarget
	anonymousItemTarget speechCursorTarget
	availableTargets    []speechCursorTarget
	targetIndexByID     map[string]int
	consumedTargets     map[string]bool
	committed           string
	textByUtterance     map[string]string
}

type translationTranscriptUnit struct {
	id             string
	text           string
	eventSnapshot  string
	startMs        *int64
	endMs          *int64
	firstSeenOrder int
}

type modelOutputAnchor struct {
	snapshot    string
	speechEpoch int
	valid       bool
}

type modelOutputSnapshot struct {
	authoritative bool
	text          string
	speechEpoch   int
	endMs         int64
	hasEndMs      bool
	version       int
}

type modelOutputDoneMarker struct {
	text        string
	speechEpoch int
	endMs       int64
	hasEndMs    bool
}

type modelOutputBoundaryState struct {
	committedSpeechEpoch int
	coveredVersion       int
	pendingDone          []modelOutputDoneMarker
}

// modelOutputTranscriptAssociation converts a session-cumulative model
// snapshot into an utterance-local preview only when the boundary is proven by
// an exact snapshot prefix. Each utterance keeps the snapshot that existed
// before its first model output. If an older utterance finishes after the next
// speech_start, that exact snapshot may still advance the next utterance's
// anchor until its own first output arrives.
//
// A prefix mismatch deliberately produces no EpochText. Guessing with sentence
// counts, punctuation, or a longest-common-prefix would move revised text across
// Gateway VAD boundaries; translation_done remains the authoritative fallback.
type modelOutputTranscriptAssociation struct {
	anchorsByUtterance           map[string]modelOutputAnchor
	epochByUtterance             map[string]int
	predecessorByUtterance       map[string]string
	successorByUtterance         map[string]string
	previewEmittedByUtterance    map[string]bool
	latestOutputEpochByUtterance map[string]int
	latestSnapshotByUtterance    map[string]modelOutputSnapshot
	boundaryByUtterance          map[string]*modelOutputBoundaryState
	finalizedSnapshotByUtterance map[string]modelOutputSnapshot
	utteranceOrder               []string
	pendingEvents                []core.Event
}

func (association *modelOutputTranscriptAssociation) observeTarget(target speechCursorTarget) {
	utteranceID := strings.TrimSpace(target.utteranceID)
	if utteranceID == "" || target.speechEpoch <= 0 {
		return
	}
	if association.anchorsByUtterance == nil {
		association.anchorsByUtterance = make(map[string]modelOutputAnchor)
		association.epochByUtterance = make(map[string]int)
		association.predecessorByUtterance = make(map[string]string)
		association.successorByUtterance = make(map[string]string)
		association.previewEmittedByUtterance = make(map[string]bool)
		association.latestOutputEpochByUtterance = make(map[string]int)
		association.latestSnapshotByUtterance = make(map[string]modelOutputSnapshot)
		association.boundaryByUtterance = make(map[string]*modelOutputBoundaryState)
		association.finalizedSnapshotByUtterance = make(map[string]modelOutputSnapshot)
	}
	if target.speechEpoch > association.epochByUtterance[utteranceID] {
		association.epochByUtterance[utteranceID] = target.speechEpoch
	}
	if _, exists := association.anchorsByUtterance[utteranceID]; !exists {
		// An empty anchor is proven only for the first utterance in a session.
		// Later utterances may use only the finalized snapshot of their immediate
		// predecessor; skipping an unfinished utterance would move its entire text
		// into a later bilingual row.
		predecessor := ""
		if len(association.utteranceOrder) > 0 {
			predecessor = association.utteranceOrder[len(association.utteranceOrder)-1]
			association.successorByUtterance[predecessor] = utteranceID
		}
		association.predecessorByUtterance[utteranceID] = predecessor
		association.utteranceOrder = append(association.utteranceOrder, utteranceID)
		finalized, finalizedOK := association.finalizedSnapshotByUtterance[predecessor]
		association.anchorsByUtterance[utteranceID] = modelOutputAnchor{
			snapshot:    finalized.text,
			speechEpoch: finalized.speechEpoch,
			valid:       predecessor == "" || finalizedOK,
		}
	}
	if association.boundaryByUtterance[utteranceID] == nil {
		association.boundaryByUtterance[utteranceID] = &modelOutputBoundaryState{}
	}
}

func (association *modelOutputTranscriptAssociation) prepare(event core.Event) core.Event {
	switch event.Type {
	case "source_vad_commit":
		association.observeCommit(event)
		return event
	case "translation_done":
		association.observeDone(event)
		return event
	}
	if event.Type != "model_output" || strings.TrimSpace(event.UtteranceID) == "" || event.SpeechEpoch <= 0 {
		return event
	}
	target := speechCursorTarget{
		utteranceID: event.UtteranceID,
		speechEpoch: event.SpeechEpoch,
	}
	association.observeTarget(target)
	snapshot := strings.TrimSpace(event.Text)
	if snapshot == "" {
		return event
	}
	if event.SpeechEpoch < association.latestOutputEpochByUtterance[event.UtteranceID] {
		// Short pauses may advance speechEpoch while retaining one VAD utterance.
		// Once that utterance has emitted a newer epoch, a delayed older snapshot
		// must not roll the visible preview back.
		event.EpochText = ""
		return event
	}
	association.latestOutputEpochByUtterance[event.UtteranceID] = event.SpeechEpoch
	previous := association.latestSnapshotByUtterance[event.UtteranceID]
	version := previous.version + 1
	if previous.version > 0 && previous.text == snapshot {
		// Reliable relays may replay the same cumulative snapshot with a refreshed
		// cursor. It is the same logical model version and must not revoke a proven
		// predecessor boundary or consume another done marker.
		version = previous.version
	}
	current := modelOutputSnapshot{
		text: snapshot, speechEpoch: event.SpeechEpoch, version: version,
		authoritative: event.ModelOutputAuthoritative,
	}
	if event.EndMs != nil {
		current.endMs = *event.EndMs
		if previous.hasEndMs && previous.version == version && previous.endMs > current.endMs {
			current.endMs = previous.endMs
		}
		current.hasEndMs = true
	} else if previous.version == version && previous.hasEndMs {
		current.endMs = previous.endMs
		current.hasEndMs = true
	}
	if current.version > previous.version {
		association.invalidateFinalizedRevision(event.UtteranceID, current)
	}
	association.latestSnapshotByUtterance[event.UtteranceID] = current
	association.coverPendingDone(event.UtteranceID, current)
	association.tryFinalize(event.UtteranceID)
	anchor := association.validatedAnchor(event.UtteranceID)
	if strings.TrimSpace(event.EpochText) == "" && anchor.valid {
		switch {
		case anchor.snapshot == "":
			event.EpochText = snapshot
		case snapshot == anchor.snapshot:
			event.EpochText = ""
		case strings.HasPrefix(snapshot, anchor.snapshot):
			event.EpochText = strings.TrimSpace(strings.TrimPrefix(snapshot, anchor.snapshot))
		}
	}
	if strings.TrimSpace(event.EpochText) != "" {
		association.previewEmittedByUtterance[event.UtteranceID] = true
	}

	return event
}

func (association *modelOutputTranscriptAssociation) validatedAnchor(utteranceID string) modelOutputAnchor {
	anchor := association.anchorsByUtterance[utteranceID]
	predecessor := association.predecessorByUtterance[utteranceID]
	if predecessor == "" {
		return anchor
	}
	finalized, finalizedOK := association.finalizedSnapshotByUtterance[predecessor]
	latest, latestOK := association.latestSnapshotByUtterance[predecessor]
	if !finalizedOK || !latestOK || finalized.version != latest.version ||
		anchor.snapshot != finalized.text {
		anchor.valid = false
	}
	return anchor
}

func (association *modelOutputTranscriptAssociation) invalidateFinalizedRevision(
	utteranceID string,
	current modelOutputSnapshot,
) {
	finalized, ok := association.finalizedSnapshotByUtterance[utteranceID]
	if !ok || current.version <= finalized.version {
		return
	}
	delete(association.finalizedSnapshotByUtterance, utteranceID)
	association.invalidateSuccessorChain(utteranceID)
}

func (association *modelOutputTranscriptAssociation) invalidateSuccessorChain(utteranceID string) {
	successor := association.successorByUtterance[utteranceID]
	if successor == "" || association.predecessorByUtterance[successor] != utteranceID {
		return
	}
	association.anchorsByUtterance[successor] = modelOutputAnchor{}
	if association.previewEmittedByUtterance[successor] {
		association.pendingEvents = append(association.pendingEvents, core.Event{
			Type: "model_output_reset", UtteranceID: successor,
			SpeechEpoch: association.epochByUtterance[successor],
		})
	}
	association.previewEmittedByUtterance[successor] = false
	if _, finalized := association.finalizedSnapshotByUtterance[successor]; finalized {
		delete(association.finalizedSnapshotByUtterance, successor)
		association.invalidateSuccessorChain(successor)
	}
}

func (association *modelOutputTranscriptAssociation) observeCommit(event core.Event) {
	utteranceID := strings.TrimSpace(event.UtteranceID)
	if utteranceID == "" || event.SpeechEpoch <= 0 {
		return
	}
	association.observeTarget(speechCursorTarget{
		utteranceID: utteranceID,
		speechEpoch: event.SpeechEpoch,
	})
	boundary := association.boundaryByUtterance[utteranceID]
	if event.SpeechEpoch > boundary.committedSpeechEpoch {
		boundary.committedSpeechEpoch = event.SpeechEpoch
	}
	association.tryFinalize(utteranceID)
}

func (association *modelOutputTranscriptAssociation) observeDone(event core.Event) {
	utteranceID := strings.TrimSpace(event.UtteranceID)
	if utteranceID == "" || event.SpeechEpoch <= 0 {
		return
	}
	association.observeTarget(speechCursorTarget{
		utteranceID: utteranceID,
		speechEpoch: event.SpeechEpoch,
	})
	marker := modelOutputDoneMarker{
		text: strings.TrimSpace(event.Text), speechEpoch: event.SpeechEpoch,
	}
	if event.EndMs != nil {
		marker.endMs = *event.EndMs
		marker.hasEndMs = true
	}
	boundary := association.boundaryByUtterance[utteranceID]
	snapshot, hasSnapshot := association.latestSnapshotByUtterance[utteranceID]
	if hasSnapshot && doneCoversCurrentSnapshot(marker, snapshot) {
		boundary.coveredVersion = snapshot.version
	} else {
		// Delivery can be reversed. A done that arrives before its model output is
		// consumed once, and only by an exact epoch+cursor or exact-text match.
		boundary.pendingDone = append(boundary.pendingDone, marker)
	}
	association.tryFinalize(utteranceID)
}

func doneCoversCurrentSnapshot(marker modelOutputDoneMarker, snapshot modelOutputSnapshot) bool {
	if marker.speechEpoch != snapshot.speechEpoch {
		return false
	}
	if marker.hasEndMs && snapshot.hasEndMs &&
		marker.endMs+modelOutputDoneCursorToleranceMs >= snapshot.endMs {
		return true
	}
	return marker.text != "" && canonicalModelSnapshot(marker.text) == canonicalModelSnapshot(snapshot.text)
}

func pendingDoneMatchesSnapshot(marker modelOutputDoneMarker, snapshot modelOutputSnapshot) bool {
	if marker.speechEpoch != snapshot.speechEpoch {
		return false
	}
	if marker.hasEndMs && snapshot.hasEndMs &&
		absInt64(marker.endMs-snapshot.endMs) <= modelOutputDoneCursorToleranceMs {
		return true
	}
	return marker.text != "" && canonicalModelSnapshot(marker.text) == canonicalModelSnapshot(snapshot.text)
}

func canonicalModelSnapshot(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func absInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

func (association *modelOutputTranscriptAssociation) coverPendingDone(
	utteranceID string,
	snapshot modelOutputSnapshot,
) {
	boundary := association.boundaryByUtterance[utteranceID]
	for index, marker := range boundary.pendingDone {
		if !pendingDoneMatchesSnapshot(marker, snapshot) {
			continue
		}
		boundary.coveredVersion = snapshot.version
		boundary.pendingDone = append(boundary.pendingDone[:index], boundary.pendingDone[index+1:]...)
		return
	}
}

func (association *modelOutputTranscriptAssociation) tryFinalize(utteranceID string) {
	snapshot, ok := association.latestSnapshotByUtterance[utteranceID]
	if !ok {
		return
	}
	boundary := association.boundaryByUtterance[utteranceID]
	if boundary == nil || boundary.committedSpeechEpoch < snapshot.speechEpoch ||
		(!snapshot.authoritative && boundary.coveredVersion != snapshot.version) {
		return
	}
	if finalized, exists := association.finalizedSnapshotByUtterance[utteranceID]; exists && finalized.version == snapshot.version {
		return
	}
	predecessor := association.predecessorByUtterance[utteranceID]
	if predecessor != "" {
		anchor := association.validatedAnchor(utteranceID)
		if !anchor.valid || (snapshot.text != anchor.snapshot && !strings.HasPrefix(snapshot.text, anchor.snapshot)) {
			return
		}
	}
	association.finalizedSnapshotByUtterance[utteranceID] = snapshot
	successor := association.successorByUtterance[utteranceID]
	if successor == "" || association.predecessorByUtterance[successor] != utteranceID {
		return
	}
	association.anchorsByUtterance[successor] = modelOutputAnchor{
		snapshot: snapshot.text, speechEpoch: snapshot.speechEpoch, valid: true,
	}
	association.queueRefreshedPreview(successor)
	association.tryFinalize(successor)
}

func (association *modelOutputTranscriptAssociation) queueRefreshedPreview(utteranceID string) {
	snapshot, ok := association.latestSnapshotByUtterance[utteranceID]
	if !ok {
		return
	}
	anchor := association.validatedAnchor(utteranceID)
	if !anchor.valid || anchor.snapshot == "" || snapshot.text == anchor.snapshot ||
		!strings.HasPrefix(snapshot.text, anchor.snapshot) {
		return
	}
	localText := strings.TrimSpace(strings.TrimPrefix(snapshot.text, anchor.snapshot))
	if localText == "" {
		return
	}
	event := core.Event{
		Type: "model_output", Text: snapshot.text, EpochText: localText,
		ModelOutputAuthoritative: snapshot.authoritative,
		ModelOutputStable:        snapshot.authoritative,
		UtteranceID:              utteranceID, SpeechEpoch: snapshot.speechEpoch,
	}
	if snapshot.hasEndMs {
		endMs := snapshot.endMs
		event.EndMs = &endMs
	}
	association.pendingEvents = append(association.pendingEvents, event)
	association.previewEmittedByUtterance[utteranceID] = true
}

func (association *modelOutputTranscriptAssociation) drainPendingEvents() []core.Event {
	if len(association.pendingEvents) == 0 {
		return nil
	}
	events := association.pendingEvents
	association.pendingEvents = nil
	return events
}

// translationTranscriptAssociation turns provider-final segment text into an
// explicit utterance-local snapshot. Unlike model_output.Text, SegmentText is
// not a revisable session-wide prefix, so it is safe to aggregate by the
// utterance ID assigned by the source-audio cursor.
type translationTranscriptAssociation struct {
	unitsByUtterance      map[string][]translationTranscriptUnit
	baseByUtterance       map[string]string
	seenDoneByUtterance   map[string]map[string]bool
	retiredIDsByUtterance map[string]map[string]bool
}

func translationDoneKey(event core.Event) string {
	return strings.TrimSpace(event.SegmentID) + "\x00" +
		strings.TrimSpace(event.SegmentText) + "\x00" + strings.TrimSpace(event.Text)
}

func (association *translationTranscriptAssociation) epochText(utteranceID string) string {
	text := association.baseByUtterance[utteranceID]
	for _, unit := range association.unitsByUtterance[utteranceID] {
		text = joinTranscript(text, unit.text)
	}
	return text
}

func (association *translationTranscriptAssociation) prepare(event core.Event) core.Event {
	if (event.Type != "translation" && event.Type != "translation_done") ||
		strings.TrimSpace(event.UtteranceID) == "" {
		return event
	}
	segmentID := strings.TrimSpace(event.SegmentID)
	if len(event.ReplaceSegmentIDs) > 0 {
		if association.retiredIDsByUtterance == nil {
			association.retiredIDsByUtterance = make(map[string]map[string]bool)
		}
		if association.retiredIDsByUtterance[event.UtteranceID] == nil {
			association.retiredIDsByUtterance[event.UtteranceID] = make(map[string]bool)
		}
		for _, id := range event.ReplaceSegmentIDs {
			if id = strings.TrimSpace(id); id != "" && id != segmentID {
				association.retiredIDsByUtterance[event.UtteranceID][id] = true
			}
		}
	}
	if explicit := strings.TrimSpace(event.EpochText); explicit != "" {
		if association.baseByUtterance == nil {
			association.baseByUtterance = make(map[string]string)
		}
		association.baseByUtterance[event.UtteranceID] = explicit
		if association.unitsByUtterance != nil {
			delete(association.unitsByUtterance, event.UtteranceID)
		}
		return event
	}
	segmentText := strings.TrimSpace(event.SegmentText)
	if segmentText == "" {
		return event
	}
	if segmentID == "" {
		event.EpochText = segmentText
		return event
	}
	if association.retiredIDsByUtterance[event.UtteranceID][segmentID] {
		// A replaced provider segment is obsolete for the rest of this
		// utterance. Forward only the current aggregate so a delayed retry
		// cannot resurrect text that an explicit replacement removed.
		event.SegmentID = ""
		event.SegmentText = ""
		event.EpochText = association.epochText(event.UtteranceID)
		return event
	}
	if event.Type == "translation_done" {
		if association.seenDoneByUtterance == nil {
			association.seenDoneByUtterance = make(map[string]map[string]bool)
		}
		if association.seenDoneByUtterance[event.UtteranceID] == nil {
			association.seenDoneByUtterance[event.UtteranceID] = make(map[string]bool)
		}
		key := translationDoneKey(event)
		if association.seenDoneByUtterance[event.UtteranceID][key] {
			event.SegmentID = ""
			event.SegmentText = ""
			event.EpochText = association.epochText(event.UtteranceID)
			return event
		}
		association.seenDoneByUtterance[event.UtteranceID][key] = true
	}
	if association.unitsByUtterance == nil {
		association.unitsByUtterance = make(map[string][]translationTranscriptUnit)
	}
	units := append([]translationTranscriptUnit(nil), association.unitsByUtterance[event.UtteranceID]...)
	replacementOrder := -1
	var replacementStartMs *int64
	var replacementEndMs *int64
	if len(event.ReplaceSegmentIDs) > 0 {
		replaced := make(map[string]bool, len(event.ReplaceSegmentIDs))
		for _, id := range event.ReplaceSegmentIDs {
			replaced[strings.TrimSpace(id)] = true
		}
		retained := units[:0]
		for _, unit := range units {
			if replaced[unit.id] {
				if replacementOrder < 0 {
					replacementOrder = unit.firstSeenOrder
					replacementStartMs = unit.startMs
					replacementEndMs = unit.endMs
				}
				continue
			}
			retained = append(retained, unit)
		}
		units = retained
	}
	nextOrder := 0
	for _, current := range units {
		if current.firstSeenOrder >= nextOrder {
			nextOrder = current.firstSeenOrder + 1
		}
	}
	unit := translationTranscriptUnit{
		id: segmentID, text: segmentText, eventSnapshot: strings.TrimSpace(event.Text),
		startMs: event.StartMs, endMs: event.EndMs, firstSeenOrder: nextOrder,
	}
	if replacementOrder >= 0 {
		unit.firstSeenOrder = replacementOrder
		if unit.startMs == nil {
			unit.startMs = replacementStartMs
		}
		if unit.endMs == nil {
			unit.endMs = replacementEndMs
		}
	}
	if event.Type == "translation" {
		unitIndex := -1
		for index := range units {
			if units[index].id == segmentID {
				unitIndex = index
				break
			}
		}
		if unitIndex >= 0 {
			unit.firstSeenOrder = units[unitIndex].firstSeenOrder
			if unit.startMs == nil {
				unit.startMs = units[unitIndex].startMs
			}
			units[unitIndex] = unit
		} else {
			units = append(units, unit)
		}
	} else {
		// translation_done is an immutable stable increment. Providers may emit
		// several word increments with one playback segment ID; replacements must
		// be explicit through ReplaceSegmentIDs.
		duplicate := false
		for _, current := range units {
			if current.id == unit.id && current.text == unit.text && current.eventSnapshot == unit.eventSnapshot {
				duplicate = true
				break
			}
		}
		if !duplicate {
			units = append(units, unit)
		}
	}
	sort.SliceStable(units, func(left, right int) bool {
		if units[left].startMs != nil && units[right].startMs != nil && *units[left].startMs != *units[right].startMs {
			return *units[left].startMs < *units[right].startMs
		}
		return units[left].firstSeenOrder < units[right].firstSeenOrder
	})
	association.unitsByUtterance[event.UtteranceID] = units
	event.EpochText = association.epochText(event.UtteranceID)
	return event
}

func (association *sourceTranscriptAssociation) observeTarget(target speechCursorTarget) {
	if target.utteranceID == "" || target.speechEpoch <= 0 {
		return
	}
	if association.targetIndexByID == nil {
		association.targetIndexByID = make(map[string]int)
	}
	if index, ok := association.targetIndexByID[target.utteranceID]; ok {
		association.availableTargets[index] = target
		return
	}
	association.targetIndexByID[target.utteranceID] = len(association.availableTargets)
	association.availableTargets = append(association.availableTargets, target)
}

func (association *sourceTranscriptAssociation) consume(target speechCursorTarget) speechCursorTarget {
	if target.utteranceID == "" || target.speechEpoch <= 0 {
		return speechCursorTarget{}
	}
	if association.consumedTargets == nil {
		association.consumedTargets = make(map[string]bool)
	}
	association.consumedTargets[target.utteranceID] = true
	return target
}

func (association *sourceTranscriptAssociation) consumeOldest() speechCursorTarget {
	for _, target := range association.availableTargets {
		if association.consumedTargets[target.utteranceID] {
			continue
		}
		return association.consume(target)
	}
	return speechCursorTarget{}
}

func (association *sourceTranscriptAssociation) prepare(
	event core.Event,
	fallback speechCursorTarget,
) (core.Event, bool) {
	if !isSourceTranscriptEvent(event) {
		return event, true
	}
	itemID := strings.TrimSpace(event.SegmentID)
	target := speechCursorTarget{}
	usedAnonymousTarget := false
	if utteranceID := strings.TrimSpace(event.UtteranceID); utteranceID != "" {
		target = speechCursorTarget{speechEpoch: event.SpeechEpoch, utteranceID: utteranceID}
	} else if itemID != "" && association.itemTargets != nil {
		target = association.itemTargets[itemID]
	} else if itemID == "" {
		target = association.anonymousItemTarget
	}
	if target.utteranceID == "" && event.Type == "source_done" &&
		association.anonymousItemTarget.utteranceID != "" {
		target = association.anonymousItemTarget
		usedAnonymousTarget = true
	}
	if target.utteranceID == "" {
		if event.Type == "source_done" {
			target = association.consumeOldest()
		}
		if target.utteranceID == "" {
			target = association.consume(fallback)
		}
		if target.utteranceID == "" {
			target = association.consumeOldest()
		}
	}
	if target.utteranceID == "" || target.speechEpoch <= 0 {
		return event, false
	}
	target = association.consume(target)
	if itemID != "" {
		if association.itemTargets == nil {
			association.itemTargets = make(map[string]speechCursorTarget)
		}
		association.itemTargets[itemID] = target
	} else {
		association.anonymousItemTarget = target
	}
	event.UtteranceID = target.utteranceID
	event.SpeechEpoch = target.speechEpoch

	localText := strings.TrimSpace(event.EpochText)
	providedEpochText := localText != ""
	if localText == "" {
		localText = strings.TrimSpace(event.SegmentText)
	}
	if localText == "" {
		localText = committedTranscriptPart(association.committed, event.Text, event.Text)
	}
	if localText == "" {
		localText = strings.TrimSpace(event.Text)
	}
	if !providedEpochText {
		if association.textByUtterance == nil {
			association.textByUtterance = make(map[string]string)
		}
		localText = appendTranscript(association.textByUtterance[target.utteranceID], localText)
	}
	event.EpochText = localText

	if event.Type == "source_done" {
		if association.textByUtterance == nil {
			association.textByUtterance = make(map[string]string)
		}
		association.textByUtterance[target.utteranceID] = localText
		if text := strings.TrimSpace(event.Text); text != "" {
			association.committed = text
		}
		if itemID == "" || usedAnonymousTarget {
			association.anonymousItemTarget = speechCursorTarget{}
		}
	}
	return event, true
}

func (tracker *sourceVADCommitTracker) observe(event core.Event) *core.Event {
	if event.Type == "source_vad_commit" {
		tracker.pending = core.Event{}
		return nil
	}
	if event.Type == "source_vad_state" && event.State == "silence_threshold" &&
		event.SpeechEpoch > 0 {
		pending := tracker.pending
		tracker.pending = core.Event{}
		utteranceID := event.UtteranceID
		if utteranceID == "" {
			utteranceID = pending.UtteranceID
		}
		endMs := event.EndMs
		if endMs == nil && pending.EndMs != nil && tracker.thresholdMs > 0 {
			value := *pending.EndMs + tracker.thresholdMs
			endMs = &value
		}
		return &core.Event{
			Type: "source_vad_commit", State: "silence_threshold",
			UtteranceID: utteranceID, SpeechEpoch: event.SpeechEpoch, EndMs: endMs,
		}
	}
	if event.Type != "source_vad_state" || event.State != "speech_endpoint" ||
		event.EndMs == nil || event.SpeechEpoch <= 0 {
		return nil
	}
	tracker.pending = event
	return nil
}

func (tracker *sourceVADCommitTracker) before(event core.Event) *core.Event {
	if event.Type != "source_vad_state" || event.State != "speech_start" {
		return nil
	}
	pending := tracker.pending
	tracker.pending = core.Event{}
	if tracker.thresholdMs <= 0 || pending.EndMs == nil || event.StartMs == nil ||
		*event.StartMs < *pending.EndMs+tracker.thresholdMs {
		return nil
	}
	endMs := *pending.EndMs + tracker.thresholdMs
	return &core.Event{
		Type: "source_vad_commit", State: "silence_threshold",
		UtteranceID: pending.UtteranceID, SpeechEpoch: pending.SpeechEpoch,
		EndMs: &endMs,
	}
}

type resettableSourceResult struct {
	committed string
	err       error
}

type reportedSourceError struct{ err error }

func (err *reportedSourceError) Error() string { return err.err.Error() }
func (err *reportedSourceError) Unwrap() error { return err.err }

type resettableSourceSession struct {
	audio       chan []byte
	packets     chan core.ASRAudioPacket
	done        chan resettableSourceResult
	epoch       atomic.Int64
	utteranceID string
}

func runResettableSource(
	ctx context.Context,
	source core.Provider,
	config core.SessionConfig,
	packets <-chan sourceVADPacket,
	events chan<- core.Event,
) error {
	committed := ""
	var session *resettableSourceSession
	var lastReportedErr error
	reconnectFailures := 0
	retryAt := time.Time{}
	retryDelay := sourceReconnectInitialDelay
	reportFailure := func(err error) error {
		if err == nil || errors.Is(err, context.Canceled) {
			return err
		}
		lastReportedErr = err
		reconnectFailures++
		retryAt = time.Now().Add(retryDelay)
		retryDelay = min(retryDelay*2, sourceReconnectMaxDelay)
		event := core.Event{Type: "asr_error", Error: fmt.Sprintf("ASR 会话中断，正在自动重连（%d/%d）：%v", reconnectFailures, sourceReconnectAttempts, err)}
		select {
		case events <- event:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	waitForRetry := func() error {
		if retryAt.IsZero() || !time.Now().Before(retryAt) {
			return nil
		}
		timer := time.NewTimer(time.Until(retryAt))
		defer timer.Stop()
		select {
		case <-timer.C:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	markRecovered := func() {
		lastReportedErr = nil
		reconnectFailures = 0
		retryAt = time.Time{}
		retryDelay = sourceReconnectInitialDelay
	}
	finish := func() error {
		if session == nil {
			return nil
		}
		if session.packets != nil {
			close(session.packets)
		} else {
			close(session.audio)
		}
		result := <-session.done
		committed = result.committed
		session = nil
		if result.err == nil {
			markRecovered()
		}
		return result.err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case packet, ok := <-packets:
			if !ok {
				if err := finish(); err != nil {
					return err
				}
				if lastReportedErr != nil {
					return &reportedSourceError{err: lastReportedErr}
				}
				return nil
			}
			if packet.reset {
				if err := finish(); err != nil && !errors.Is(err, context.Canceled) {
					if reportErr := reportFailure(err); reportErr != nil {
						return reportErr
					}
				}
				continue
			}
			if packet.softEndpoint && (session == nil || session.packets == nil) {
				continue
			}
			if !packet.softEndpoint && (len(packet.audio) == 0 || packet.speechEpoch <= 0 || strings.TrimSpace(packet.utteranceID) == "") {
				continue
			}
			for {
				if reconnectFailures >= sourceReconnectAttempts {
					return &reportedSourceError{err: lastReportedErr}
				}
				if session == nil {
					if packet.softEndpoint {
						break
					}
					if err := waitForRetry(); err != nil {
						return err
					}
					session = startResettableSourceSession(
						ctx, source, config, events, committed, packet.startMs,
						packet.speechEpoch, packet.utteranceID,
					)
				}
				session.epoch.Store(int64(packet.speechEpoch))
				select {
				case result := <-session.done:
					committed = result.committed
					session = nil
					resultErr := result.err
					if resultErr == nil {
						resultErr = errors.New("ASR 会话意外结束")
					}
					if err := reportFailure(resultErr); err != nil {
						return err
					}
					continue
				default:
				}
				select {
				case session.audio <- packet.audio:
				case session.packets <- core.ASRAudioPacket{Audio: packet.audio, SoftEndpoint: packet.softEndpoint}:
				case result := <-session.done:
					committed = result.committed
					session = nil
					resultErr := result.err
					if resultErr == nil {
						resultErr = errors.New("ASR 会话意外结束")
					}
					if err := reportFailure(resultErr); err != nil {
						return err
					}
					continue
				case <-ctx.Done():
					return ctx.Err()
				}
				break
			}
		}
	}
}

func startResettableSourceSession(
	ctx context.Context,
	source core.Provider,
	config core.SessionConfig,
	events chan<- core.Event,
	committed string,
	baseMs int64,
	epoch int,
	utteranceID string,
) *resettableSourceSession {
	session := &resettableSourceSession{
		// Keep buffering in the upstream packet queue. A send here must mean
		// the provider accepted the packet, otherwise a failed session can
		// silently retain audio that should be retried on the next session.
		audio:       make(chan []byte),
		done:        make(chan resettableSourceResult, 1),
		utteranceID: utteranceID,
	}
	session.epoch.Store(int64(epoch))
	endpointSource, supportsEndpoints := source.(interface {
		RunWithEndpoints(context.Context, core.SessionConfig, <-chan core.ASRAudioPacket, chan<- core.Event) error
	})
	if supportsEndpoints {
		session.audio = nil
		session.packets = make(chan core.ASRAudioPacket)
	}
	go func() {
		localEvents := make(chan core.Event, primaryEventBuffer)
		providerDone := make(chan error, 1)
		go func() {
			if supportsEndpoints {
				providerDone <- endpointSource.RunWithEndpoints(ctx, config, session.packets, localEvents)
			} else {
				providerDone <- source.Run(ctx, config, session.audio, localEvents)
			}
		}()
		sessionPrefix := committed
		latestCommitted := committed
		for {
			select {
			case <-ctx.Done():
				session.done <- resettableSourceResult{committed: latestCommitted, err: ctx.Err()}
				return
			case event := <-localEvents:
				rewritten, nextCommitted := rewriteSegmentedSourceEvent(
					event, sessionPrefix, baseMs, int(session.epoch.Load()), session.utteranceID,
				)
				if nextCommitted != "" {
					latestCommitted = nextCommitted
				}
				select {
				case events <- rewritten:
				case <-ctx.Done():
					session.done <- resettableSourceResult{committed: latestCommitted, err: ctx.Err()}
					return
				}
			case err := <-providerDone:
				for {
					select {
					case event := <-localEvents:
						rewritten, nextCommitted := rewriteSegmentedSourceEvent(
							event, sessionPrefix, baseMs, int(session.epoch.Load()), session.utteranceID,
						)
						if nextCommitted != "" {
							latestCommitted = nextCommitted
						}
						select {
						case events <- rewritten:
						case <-ctx.Done():
							err = ctx.Err()
						}
					default:
						session.done <- resettableSourceResult{committed: latestCommitted, err: err}
						return
					}
				}
			}
		}
	}()
	return session
}

func rewriteSegmentedSourceEvent(
	event core.Event,
	committed string,
	baseMs int64,
	epoch int,
	utteranceID string,
) (core.Event, string) {
	if !isSourceTranscriptEvent(event) {
		return event, ""
	}
	localText := strings.TrimSpace(event.Text)
	event.EpochText = localText
	event.Text = appendTranscript(committed, localText)
	event.SpeechEpoch = epoch
	event.UtteranceID = utteranceID
	if segmentID := strings.TrimSpace(event.SegmentID); segmentID != "" {
		event.SegmentID = utteranceID + ":" + segmentID
	}
	if event.StartMs != nil {
		value := *event.StartMs + baseMs
		event.StartMs = &value
	}
	if event.EndMs != nil {
		value := *event.EndMs + baseMs
		event.EndMs = &value
	}
	if event.Type == "source_done" {
		return event, event.Text
	}
	return event, ""
}

func (p SidecarProvider) Name() string {
	if p.Primary == nil {
		return ""
	}
	return p.Primary.Name()
}

func (p SidecarProvider) Ready() bool {
	return p.Primary != nil && p.Primary.Ready()
}

func (p SidecarProvider) Run(
	ctx context.Context,
	config core.SessionConfig,
	audio <-chan []byte,
	events chan<- core.Event,
) error {
	if p.Primary == nil {
		return errors.New("ASR 旁路缺少主供应商")
	}
	if p.Source == nil || !p.Source.Ready() {
		return p.Primary.Run(ctx, config, audio, events)
	}

	sourceCtx, cancelSource := context.WithCancel(ctx)
	defer cancelSource()
	primaryAudio := make(chan []byte, primaryAudioBuffer)
	sourceAudio := make(chan []byte, sourceAudioBuffer)
	sourceInput := sourceAudio
	var sourceVADSegments chan core.Event
	var gatedSourceAudio chan sourceVADPacket
	preRollMs := p.SourceVADPreRollMs
	if preRollMs <= 0 {
		preRollMs = 160
	}
	postRollMs := p.SourceVADPostRollMs
	if postRollMs <= 0 {
		postRollMs = 320
	}
	if p.shouldGateSourceWithPrimaryVAD(config) {
		sourceInput = make(chan []byte, sourceAudioBuffer)
		sourceVADSegments = make(chan core.Event, primaryEventBuffer)
		gatedSourceAudio = make(chan sourceVADPacket, sourceAudioBuffer)
		go runSourceVADAudioGate(
			sourceCtx, sourceInput, sourceVADSegments, gatedSourceAudio,
			preRollMs, postRollMs, config.ASRUseFilteredAudio,
		)
	}
	commitThresholdMs := p.sourceVADCommitThresholdMs(config)
	var vadCommitTracker *sourceVADCommitTracker
	// The synthetic commit also defines the browser-visible bilingual row
	// boundary. It is required even when the sidecar ASR consumes continuous,
	// non-gated audio and therefore has no sourceVADSegments channel to reset.
	if commitThresholdMs > 0 {
		vadCommitTracker = &sourceVADCommitTracker{thresholdMs: commitThresholdMs}
	}
	primaryEvents := make(chan core.Event, primaryEventBuffer)
	primaryDone := make(chan error, 1)
	sourceDone := make(chan error, 1)
	var directSourceEvents chan core.Event
	if gatedSourceAudio == nil {
		directSourceEvents = make(chan core.Event)
	}
	go func() {
		primaryDone <- p.Primary.Run(ctx, config, primaryAudio, primaryEvents)
		close(primaryEvents)
	}()
	go func() {
		if gatedSourceAudio != nil {
			sourceDone <- runResettableSource(sourceCtx, p.Source, config, gatedSourceAudio, events)
			return
		}
		err := p.Source.Run(sourceCtx, config, sourceAudio, directSourceEvents)
		close(directSourceEvents)
		sourceDone <- err
	}()
	primaryEventsDone := make(chan *core.Event, 1)
	primarySourceResolved := make(chan primarySourceResolution)
	go func() {
		var finished *core.Event
		sidecarOwnsSource := true
		retainPendingSource := true
		var pendingSource []core.Event
		deliverEvents := true
		currentSpeechEpoch := 0
		activeUtteranceID := ""
		pendingModelUtteranceID := ""
		lastOutputUtteranceID := ""
		directSourceAssociation := sourceTranscriptAssociation{}
		var pendingDirectSource []core.Event
		// model_output can finish after the next speech_start. Keep both the
		// provider epoch and its source-audio cursor so late output can still be
		// routed back to the utterance whose audio produced it.
		utteranceBySpeechEpoch := make(map[int]string)
		speechTargetByUtterance := make(map[string]speechCursorTarget)
		sourceAudioTimelineByUtterance := make(map[string]sourceAudioTimeline)
		var speechCursorTargets []speechCursorTarget
		translationTargets := make(map[string]speechCursorTarget)
		var pendingModelTargetHints []modelOutputTargetHint
		modelOutputTranscript := modelOutputTranscriptAssociation{}
		translationTranscript := translationTranscriptAssociation{}
		rememberSpeechTarget := func(epoch int, utteranceID string, startMs *int64) {
			if epoch <= 0 || utteranceID == "" {
				return
			}
			utteranceBySpeechEpoch[epoch] = utteranceID
			target := speechCursorTarget{speechEpoch: epoch, utteranceID: utteranceID}
			if previous, ok := speechTargetByUtterance[utteranceID]; ok {
				target.startMs = previous.startMs
			}
			if startMs == nil || *startMs < 0 {
				speechTargetByUtterance[utteranceID] = target
				modelOutputTranscript.observeTarget(target)
				directSourceAssociation.observeTarget(target)
				return
			}
			target.startMs = *startMs
			speechTargetByUtterance[utteranceID] = target
			speechCursorTargets = append(speechCursorTargets, target)
			modelOutputTranscript.observeTarget(target)
			directSourceAssociation.observeTarget(target)
		}
		rememberSourceAudioTimeline := func(utteranceID string, startMs, endMs *int64) {
			if utteranceID == "" {
				return
			}
			sourceAudioTimelineByUtterance[utteranceID] = mergeSourceAudioTimeline(
				sourceAudioTimelineByUtterance[utteranceID], startMs, endMs,
			)
		}
		attachAssociatedSourceTimeline := func(event core.Event) core.Event {
			return attachSourceAudioTimeline(event, sourceAudioTimelineByUtterance[event.UtteranceID])
		}
		modelTarget := func(event core.Event) (string, int) {
			if event.SpeechEpoch > 0 {
				if target := utteranceBySpeechEpoch[event.SpeechEpoch]; target != "" {
					return target, event.SpeechEpoch
				}
			}
			if event.EndMs != nil {
				for index := len(speechCursorTargets) - 1; index >= 0; index-- {
					target := speechCursorTargets[index]
					if target.startMs <= *event.EndMs {
						return target.utteranceID, target.speechEpoch
					}
				}
			}
			return "", 0
		}
		sourceTarget := func(event core.Event) speechCursorTarget {
			if utteranceID := strings.TrimSpace(event.UtteranceID); utteranceID != "" && event.SpeechEpoch > 0 {
				return speechCursorTarget{speechEpoch: event.SpeechEpoch, utteranceID: utteranceID}
			}
			if utteranceID, epoch := modelTarget(event); utteranceID != "" && epoch > 0 {
				return speechCursorTarget{speechEpoch: epoch, utteranceID: utteranceID}
			}
			for _, utteranceID := range []string{activeUtteranceID, pendingModelUtteranceID, lastOutputUtteranceID} {
				if target, ok := speechTargetByUtterance[utteranceID]; ok {
					return target
				}
			}
			return speechCursorTarget{}
		}
		prepare := func(event core.Event) core.Event {
			switch event.Type {
			case "source_vad_state":
				if event.SpeechEpoch > 0 {
					currentSpeechEpoch = event.SpeechEpoch
				}
				if event.State == "speech_start" {
					if activeUtteranceID == "" {
						activeUtteranceID = vadUtteranceID(currentSpeechEpoch)
					}
					rememberSpeechTarget(currentSpeechEpoch, activeUtteranceID, event.StartMs)
					// A pending model target only covers output that arrives after a
					// strong VAD commit but before the next speech starts. A forced
					// generation can legitimately produce no new token; without
					// clearing it here, the first token from the next utterance is
					// incorrectly appended to the committed pair.
					pendingModelUtteranceID = ""
				}
				event.UtteranceID = activeUtteranceID
				rememberSourceAudioTimeline(event.UtteranceID, event.StartMs, event.EndMs)
			case "source_vad_segment":
				if event.SpeechEpoch > 0 {
					currentSpeechEpoch = event.SpeechEpoch
				}
				event.UtteranceID = activeUtteranceID
				rememberSpeechTarget(currentSpeechEpoch, activeUtteranceID, nil)
				rememberSourceAudioTimeline(event.UtteranceID, event.StartMs, event.EndMs)
			case "source_vad_audio":
				if event.SpeechEpoch > 0 {
					currentSpeechEpoch = event.SpeechEpoch
				}
				event.UtteranceID = activeUtteranceID
				rememberSpeechTarget(currentSpeechEpoch, activeUtteranceID, event.StartMs)
			case "source_vad_commit":
				if event.SpeechEpoch > 0 {
					currentSpeechEpoch = event.SpeechEpoch
				}
				if event.UtteranceID == "" {
					event.UtteranceID = activeUtteranceID
				}
				rememberSpeechTarget(currentSpeechEpoch, event.UtteranceID, nil)
				rememberSourceAudioTimeline(event.UtteranceID, event.StartMs, event.EndMs)
				pendingModelUtteranceID = event.UtteranceID
				activeUtteranceID = ""
			case "model_output":
				target, outputSpeechEpoch := modelTarget(event)
				if target == "" && event.SpeechEpoch <= 0 && event.EndMs == nil {
					snapshot := canonicalModelSnapshot(event.Text)
					for index := len(pendingModelTargetHints) - 1; index >= 0; index-- {
						hint := pendingModelTargetHints[index]
						if snapshot == "" || snapshot != hint.snapshot {
							continue
						}
						target = hint.target.utteranceID
						outputSpeechEpoch = hint.target.speechEpoch
						pendingModelTargetHints = append(
							pendingModelTargetHints[:index], pendingModelTargetHints[index+1:]...,
						)
						break
					}
				}
				if target != "" && target == pendingModelUtteranceID {
					pendingModelUtteranceID = ""
				}
				if target == "" {
					target = pendingModelUtteranceID
					if target != "" {
						pendingModelUtteranceID = ""
					} else if activeUtteranceID != "" {
						target = activeUtteranceID
					} else {
						target = lastOutputUtteranceID
					}
					outputSpeechEpoch = currentSpeechEpoch
				}
				event.UtteranceID = target
				event.SpeechEpoch = outputSpeechEpoch
				if target != "" {
					lastOutputUtteranceID = target
				}
			case "translation", "translation_delta", "translation_update", "translation_done":
				target, outputSpeechEpoch := modelTarget(event)
				if target == "" {
					target = lastOutputUtteranceID
					if target == "" {
						target = activeUtteranceID
					}
					outputSpeechEpoch = currentSpeechEpoch
				}
				event.UtteranceID = target
				event.SpeechEpoch = outputSpeechEpoch
				if segmentID := strings.TrimSpace(event.SegmentID); segmentID != "" && target != "" {
					translationTargets[segmentID] = speechCursorTarget{
						speechEpoch: outputSpeechEpoch, utteranceID: target,
					}
				}
				if event.Type == "translation_done" && target != "" {
					if snapshot := canonicalModelSnapshot(event.Text); snapshot != "" {
						pendingModelTargetHints = append(pendingModelTargetHints, modelOutputTargetHint{
							target: speechCursorTarget{
								speechEpoch: outputSpeechEpoch, utteranceID: target,
							},
							snapshot: snapshot,
						})
						if len(pendingModelTargetHints) > 8 {
							pendingModelTargetHints = pendingModelTargetHints[len(pendingModelTargetHints)-8:]
						}
					}
				}
			case "audio", "audio_done":
				if target, ok := translationTargets[strings.TrimSpace(event.SegmentID)]; ok {
					event.UtteranceID = target.utteranceID
					event.SpeechEpoch = target.speechEpoch
				} else {
					event.UtteranceID = lastOutputUtteranceID
					if event.UtteranceID == "" {
						event.UtteranceID = activeUtteranceID
					}
					event.SpeechEpoch = currentSpeechEpoch
				}
			default:
				if isSourceTranscriptEvent(event) && activeUtteranceID != "" {
					event.UtteranceID = activeUtteranceID
					event.SpeechEpoch = currentSpeechEpoch
				}
			}
			event = modelOutputTranscript.prepare(event)
			event = translationTranscript.prepare(event)
			return event
		}
		deliver := func(event core.Event) {
			if !deliverEvents || ctx.Err() != nil {
				deliverEvents = false
				return
			}
			select {
			case events <- event:
			case <-ctx.Done():
				deliverEvents = false
			}
		}
		forward := func(event core.Event) {
			if p.Recorder != nil && isSourceVADEvent(event) && event.Type != "source_vad_audio" {
				p.Recorder.Record(config.SessionID, event)
			}
			if isSourceVADEvent(event) && sourceVADSegments != nil {
				select {
				case sourceVADSegments <- event:
				case <-ctx.Done():
				}
			}
			if event.Type == "source_vad_audio" {
				// Keep the model-input PCM available to the server archive. The
				// WebSocket handler consumes it without sending it to the browser.
				deliver(event)
				return
			}
			if event.Type == "state" && event.State == "finished" {
				copied := event
				finished = &copied
				return
			}
			if sidecarOwnsSource && isSourceTranscriptEvent(event) {
				if retainPendingSource {
					pendingSource = append(pendingSource, event)
				}
				return
			}
			deliver(event)
		}
		flushDirectSource := func(force bool) {
			if len(pendingDirectSource) == 0 {
				return
			}
			remaining := pendingDirectSource[:0]
			for _, event := range pendingDirectSource {
				prepared, ok := directSourceAssociation.prepare(event, sourceTarget(event))
				if ok {
					deliver(attachAssociatedSourceTimeline(prepared))
					continue
				}
				if force {
					deliver(event)
					continue
				}
				remaining = append(remaining, event)
			}
			pendingDirectSource = remaining
		}
		primaryEventChannel := (<-chan core.Event)(primaryEvents)
		directSourceEventChannel := (<-chan core.Event)(directSourceEvents)
		sourceResolutionChannel := (<-chan primarySourceResolution)(primarySourceResolved)
		for primaryEventChannel != nil || directSourceEventChannel != nil || sourceResolutionChannel != nil {
			select {
			case resolution := <-sourceResolutionChannel:
				if resolution.fallback {
					sidecarOwnsSource = false
					for _, event := range pendingSource {
						forward(event)
					}
				}
				pendingSource = nil
				retainPendingSource = false
				sourceResolutionChannel = nil
				close(resolution.acknowledge)
			case event, ok := <-primaryEventChannel:
				if !ok {
					primaryEventChannel = nil
					continue
				}
				if vadCommitTracker != nil {
					if commit := vadCommitTracker.before(event); commit != nil {
						forward(prepare(*commit))
					}
				}
				event = prepare(event)
				var immediateCommit *core.Event
				if vadCommitTracker != nil {
					immediateCommit = vadCommitTracker.observe(event)
				}
				forward(event)
				if immediateCommit != nil {
					forward(prepare(*immediateCommit))
				}
				for _, pendingEvent := range modelOutputTranscript.drainPendingEvents() {
					forward(pendingEvent)
				}
				flushDirectSource(false)
			case event, ok := <-directSourceEventChannel:
				if !ok {
					directSourceEventChannel = nil
					continue
				}
				prepared, associated := directSourceAssociation.prepare(event, sourceTarget(event))
				if !associated {
					pendingDirectSource = append(pendingDirectSource, event)
					continue
				}
				deliver(attachAssociatedSourceTimeline(prepared))
			}
		}
		flushDirectSource(true)
		if sourceVADSegments != nil {
			close(sourceVADSegments)
		}
		primaryEventsDone <- finished
	}()
	resolvePrimarySource := func(fallback bool) {
		acknowledge := make(chan struct{})
		primarySourceResolved <- primarySourceResolution{
			fallback:    fallback,
			acknowledge: acknowledge,
		}
		<-acknowledge
	}

	sourceActive := true
	sourceClosed := false
	stopSource := func(err error) {
		if !sourceActive {
			return
		}
		sourceActive = false
		if !sourceClosed {
			close(sourceInput)
			sourceClosed = true
		}
		failed := err != nil && !errors.Is(err, context.Canceled)
		resolvePrimarySource(failed)
		if failed {
			var reported *reportedSourceError
			alreadyReported := errors.As(err, &reported)
			failureEvent := core.Event{Type: "asr_error", Error: err.Error()}
			if p.Recorder != nil {
				p.Recorder.Record(config.SessionID, failureEvent)
			}
			if p.OnError != nil {
				p.OnError(err)
			}
			if !alreadyReported {
				select {
				case events <- failureEvent:
				case <-ctx.Done():
				}
			}
		}
	}
	finishPrimary := func(emitFinished bool) {
		finished := <-primaryEventsDone
		if !emitFinished || finished == nil {
			return
		}
		select {
		case events <- *finished:
		case <-ctx.Done():
		}
	}
	finishCanceled := func() error {
		cancelSource()
		if sourceActive {
			sourceErr := <-sourceDone
			stopSource(sourceErr)
		}
		<-primaryDone
		finishPrimary(false)
		return ctx.Err()
	}

	for {
		select {
		case err := <-primaryDone:
			cancelSource()
			if sourceActive {
				sourceErr := <-sourceDone
				stopSource(sourceErr)
			}
			finishPrimary(err == nil)
			return err
		case err := <-sourceDone:
			stopSource(err)
		case chunk, ok := <-audio:
			if !ok {
				close(primaryAudio)
				if sourceActive && !sourceClosed {
					close(sourceInput)
					sourceClosed = true
				}
				primaryErr := <-primaryDone
				if sourceActive {
					sourceErr := <-sourceDone
					stopSource(sourceErr)
				}
				finishPrimary(primaryErr == nil)
				return primaryErr
			}
			select {
			case primaryAudio <- chunk:
			case err := <-primaryDone:
				cancelSource()
				if sourceActive {
					sourceErr := <-sourceDone
					stopSource(sourceErr)
				}
				finishPrimary(err == nil)
				return err
			case <-ctx.Done():
				return finishCanceled()
			}
			if !sourceActive {
				continue
			}
			select {
			case sourceInput <- chunk:
			case err := <-sourceDone:
				stopSource(err)
			default:
				cancelSource()
				sourceErr := <-sourceDone
				if sourceErr == nil || errors.Is(sourceErr, context.Canceled) {
					sourceErr = errors.New("Qwen ASR 旁路音频缓冲已满")
				}
				stopSource(sourceErr)
			}
		case <-ctx.Done():
			return finishCanceled()
		}
	}
}
