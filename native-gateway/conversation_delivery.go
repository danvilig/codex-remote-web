package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const deliveryStoreLimit = 8 << 20

type deliveryQueueEntry struct {
	ID               string          `json:"id"`
	ThreadID         string          `json:"threadId"`
	Params           json.RawMessage `json:"params"`
	Text             string          `json:"text"`
	Mentions         json.RawMessage `json:"mentions"`
	Status           string          `json:"status"`
	Version          int             `json:"version"`
	CreatedAt        int64           `json:"createdAt"`
	UpdatedAt        int64           `json:"updatedAt"`
	Error            string          `json:"error,omitempty"`
	WaitTurnID       string          `json:"waitTurnId,omitempty"`
	RequiresResume   bool            `json:"requiresResume,omitempty"`
	SendNow          bool            `json:"sendNow,omitempty"`
	SubmissionStatus string          `json:"submissionStatus,omitempty"`
}

type deliveryQueueRecord struct {
	deliveryQueueEntry
	Owner       *conversationOwner `json:"owner,omitempty"`
	Claim       *conversationOwner `json:"claim,omitempty"`
	Fingerprint string             `json:"fingerprint"`
}

type deliveryQueueState struct {
	Format   int                   `json:"format"`
	Revision int                   `json:"revision"`
	Entries  []deliveryQueueRecord `json:"entries"`
}

type deliveryQueue struct {
	c         *conversation
	directory string
	owner     conversationOwner
	wake      chan struct{}
	completed chan deliveryTurnEvent
	// Integration installs these before serving HTTP or starting queue work.
	resolveCwd         func(string) (string, error)
	resolveAttachments func(context.Context, []string, string, string, bool) ([]workspaceAttachment, error)
}

type deliveryTurn struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type deliveryTurnEvent struct {
	ThreadID string       `json:"threadId"`
	Turn     deliveryTurn `json:"turn"`
}

func newDeliveryQueue(c *conversation) *deliveryQueue {
	return &deliveryQueue{c: c, directory: filepath.Join(c.privateRoot, "remote-web-delivery"), owner: newConversationOwner(), wake: make(chan struct{}, 1), completed: make(chan deliveryTurnEvent, 32)}
}

func deliveryError(code, text string) error { return conversationFailure(code, text) }
func deliveryConflict() error {
	return deliveryError("QUEUE_CONFLICT", "Queue changed. Refresh before trying again.")
}
func deliveryUnconfirmed() error {
	return deliveryError("QUEUE_DELIVERY_UNCONFIRMED", "Another message in this conversation is awaiting delivery confirmation. Check its status before continuing.")
}
func deliveryTerminal(status string) bool { return status == "completed" || status == "cancelled" }

func (q *deliveryQueue) changed(thread string) {
	q.c.publish(map[string]string{"type": "delivery/changed", "threadId": thread})
}

func (q *deliveryQueue) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *deliveryQueue) transaction(edit func(*deliveryQueueState) (bool, error)) error {
	release, err := lockConversation(q.directory, "write.lock", q.owner.Host, 5*time.Second)
	if err != nil {
		return err
	}
	defer release()
	path := filepath.Join(q.directory, "queue.json")
	state := deliveryQueueState{Format: 1, Entries: []deliveryQueueRecord{}}
	data, err := readConversationPrivate(path, deliveryStoreLimit)
	if err == nil {
		if json.Unmarshal(data, &state) != nil || state.Format != 1 || state.Entries == nil || len(state.Entries) > 1000 {
			return deliveryError("QUEUE_STORAGE_UNSAFE", "Invalid delivery queue state")
		}
		seen := make(map[string]bool, len(state.Entries))
		for _, entry := range state.Entries {
			if seen[entry.ID] || !submissionUUID.MatchString(entry.ID) || entry.ThreadID == "" {
				return deliveryError("QUEUE_STORAGE_UNSAFE", "Invalid delivery queue identity")
			}
			seen[entry.ID] = true
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return deliveryError("QUEUE_STORAGE_UNSAFE", "Unsafe delivery queue state")
	}
	changed, err := edit(&state)
	if err != nil || !changed {
		return err
	}
	state.Revision++
	terminal := 0
	for _, item := range state.Entries {
		if deliveryTerminal(item.Status) {
			terminal++
		}
	}
	state.Entries = slices.DeleteFunc(state.Entries, func(item deliveryQueueRecord) bool {
		if terminal <= 100 || !deliveryTerminal(item.Status) {
			return false
		}
		terminal--
		return true
	})
	data, err = json.Marshal(state)
	if err != nil {
		return err
	}
	if len(data) > deliveryStoreLimit {
		return deliveryError("QUEUE_STORAGE_FULL", "Delivery queue storage limit reached")
	}
	return writeDesktopFile(path, data)
}

func (q *deliveryQueue) recover(state *deliveryQueueState) bool {
	changed := false
	for i := range state.Entries {
		entry := &state.Entries[i]
		if deliveryTerminal(entry.Status) || entry.Owner == nil || entry.Owner.alive(q.owner.Host) {
			continue
		}
		if entry.SubmissionStatus == "unknown" || entry.Status == "sending" || entry.Status == "unknown" {
			entry.Status, entry.Error = "unknown", "Delivery could not be confirmed. It was not replayed."
		} else {
			entry.Status, entry.Error = "paused", "The gateway stopped. Resume this queued message to continue."
		}
		entry.Claim, entry.Owner = nil, nil
		entry.Version++
		changed = true
	}
	return changed
}

func (q *deliveryQueue) list(thread string) ([]deliveryQueueEntry, error) {
	var snapshot []deliveryQueueRecord
	if err := q.transaction(func(state *deliveryQueueState) (bool, error) {
		changed := q.recover(state)
		snapshot = append(snapshot, state.Entries...)
		return changed, nil
	}); err != nil {
		return nil, err
	}
	settled := make(map[string]string)
	for _, entry := range snapshot {
		if entry.Status != "unknown" || (thread != "" && thread != entry.ThreadID) {
			continue
		}
		receipt, err := q.c.submissions.get(entry.ID)
		if err != nil {
			return nil, err
		}
		if receipt != nil && (receipt.Status == "accepted" || receipt.Status == "rejected") {
			settled[entry.ID] = receipt.Status
		}
	}
	if len(settled) != 0 {
		if err := q.transaction(func(state *deliveryQueueState) (bool, error) {
			dirty := false
			pause := make(map[string]bool)
			for i := range state.Entries {
				e := &state.Entries[i]
				status := settled[e.ID]
				if status == "" || e.Status != "unknown" {
					continue
				}
				e.Status, e.SubmissionStatus = "failed", status
				if status == "accepted" {
					e.Status = "completed"
					pause[e.ThreadID] = true
				}
				e.Version++
				dirty = true
			}
			for i := range state.Entries {
				e := &state.Entries[i]
				if e.Status == "queued" && pause[e.ThreadID] {
					e.Status, e.RequiresResume = "paused", true
					e.Version++
				}
			}
			snapshot = slices.Clone(state.Entries)
			return dirty, nil
		}); err != nil {
			return nil, err
		}
	}
	entries := []deliveryQueueEntry{}
	for _, e := range snapshot {
		if !deliveryTerminal(e.Status) && (thread == "" || thread == e.ThreadID) {
			entries = append(entries, e.deliveryQueueEntry)
		}
	}
	return entries, nil
}

func deliveryThreadBlocked(state *deliveryQueueState, thread, except string, receipts []submissionReceipt) bool {
	for _, e := range state.Entries {
		if e.ID != except && e.ThreadID == thread && (e.Status == "sending" || e.Status == "unknown") {
			return true
		}
	}
	for _, r := range receipts {
		if r.ID != except && r.ThreadID == thread {
			return true
		}
	}
	return false
}

type deliveryMutation struct {
	ID            string          `json:"id"`
	ThreadID      string          `json:"threadId"`
	Params        json.RawMessage `json:"params"`
	Text          *string         `json:"text"`
	Mentions      json.RawMessage `json:"mentions"`
	Version       int             `json:"version"`
	Paused        bool            `json:"paused"`
	Direction     int             `json:"direction"`
	AttachmentIDs []string        `json:"attachmentIds"`
}

func deliveryFingerprint(payload deliveryMutation) string {
	var data bytes.Buffer
	data.WriteString(`{"threadId":`)
	writeConversationJSONString(&data, payload.ThreadID)
	data.WriteString(`,"params":`)
	_ = json.Compact(&data, payload.Params)
	if payload.Text != nil {
		data.WriteString(`,"text":`)
		writeConversationJSONString(&data, *payload.Text)
	}
	if payload.Mentions != nil {
		data.WriteString(`,"mentions":`)
		_ = json.Compact(&data, payload.Mentions)
	}
	data.WriteByte('}')
	return conversationHash(data.Bytes())
}

func (q *deliveryQueue) mutate(ctx context.Context, action string, raw json.RawMessage) (deliveryQueueEntry, error) {
	var payload deliveryMutation
	if json.Unmarshal(raw, &payload) != nil || !submissionUUID.MatchString(payload.ID) {
		return deliveryQueueEntry{}, deliveryError("QUEUE_INVALID", "Invalid queued message")
	}
	var receipts []submissionReceipt
	var added deliveryQueueRecord
	var edited deliveryQueueEdit
	switch action {
	case "edit":
		var err error
		edited, err = q.prepareEdit(ctx, payload)
		if err != nil {
			return deliveryQueueEntry{}, err
		}
	case "pause", "cancel":
	case "resume", "sendNow", "reorder":
		var err error
		receipts, err = q.c.submissions.listPending("")
		if err != nil {
			return deliveryQueueEntry{}, err
		}
	case "enqueue":
		var params map[string]json.RawMessage
		var thread, cwd string
		var input []json.RawMessage
		if len(raw) > 256<<10 || payload.ThreadID == "" || len(payload.ThreadID) > 200*4 || json.Unmarshal(payload.Params, &params) != nil || json.Unmarshal(params["threadId"], &thread) != nil || thread != payload.ThreadID || json.Unmarshal(params["input"], &input) != nil || len(input) == 0 {
			return deliveryQueueEntry{}, deliveryError("QUEUE_INVALID", "Invalid queued message")
		}
		if params["cwd"] != nil && json.Unmarshal(params["cwd"], &cwd) != nil {
			return deliveryQueueEntry{}, deliveryError("QUEUE_INVALID", "Invalid project")
		}
		stored := payload.Params
		if cwd != "" {
			if q.resolveCwd == nil {
				return deliveryQueueEntry{}, deliveryError("QUEUE_INVALID", "Project resolution is unavailable")
			}
			var err error
			cwd, err = q.resolveCwd(cwd)
			if err != nil {
				return deliveryQueueEntry{}, err
			}
			params["cwd"] = conversationObject(cwd)
			stored = conversationObject(params)
		}
		mentions := payload.Mentions
		var collected []struct {
			ID     string `json:"id"`
			Source string `json:"source"`
		}
		if json.Unmarshal(mentions, &collected) != nil || collected == nil {
			mentions = json.RawMessage(`[]`)
		}
		attachmentIDs := make(map[string]bool)
		for _, m := range collected {
			if m.Source == "attachment" {
				attachmentIDs[m.ID] = true
			}
		}
		for _, item := range input {
			var image struct {
				Type string `json:"type"`
				Path string `json:"path"`
			}
			if json.Unmarshal(item, &image) == nil && image.Type == "localImage" && image.Path != "" {
				if id := q.attachmentID(image.Path); id != "" {
					attachmentIDs[id] = true
				}
			}
		}
		if len(attachmentIDs) != 0 {
			if q.resolveAttachments == nil {
				return deliveryQueueEntry{}, deliveryError("QUEUE_INVALID", "Attachment binding is unavailable")
			}
			if cwd == "" {
				result, err := q.c.request(ctx, "thread/read", conversationObject(map[string]any{"threadId": thread, "includeTurns": false}))
				if err != nil {
					return deliveryQueueEntry{}, err
				}
				var reply struct {
					Thread struct{ Cwd string } `json:"thread"`
				}
				if json.Unmarshal(result, &reply) != nil || reply.Thread.Cwd == "" {
					return deliveryQueueEntry{}, deliveryError("QUEUE_INVALID", "Attachment project is unavailable")
				}
				cwd = reply.Thread.Cwd
			}
			ids := make([]string, 0, len(attachmentIDs))
			for id := range attachmentIDs {
				ids = append(ids, id)
			}
			if _, err := q.resolveAttachments(ctx, ids, cwd, thread, true); err != nil {
				return deliveryQueueEntry{}, err
			}
		}
		text := ""
		if payload.Text != nil {
			text = *payload.Text
		}
		status := "queued"
		if payload.Paused {
			status = "paused"
		}
		now := time.Now().UnixMilli()
		added = deliveryQueueRecord{deliveryQueueEntry: deliveryQueueEntry{ID: payload.ID, ThreadID: thread, Params: stored, Text: text, Mentions: mentions, Status: status, Version: 1, CreatedAt: now, UpdatedAt: now}, Owner: &q.owner, Fingerprint: deliveryFingerprint(payload)}
	default:
		return deliveryQueueEntry{}, deliveryError("QUEUE_INVALID", "Unsupported queue action")
	}
	var result deliveryQueueEntry
	err := q.transaction(func(state *deliveryQueueState) (bool, error) {
		changed := q.recover(state)
		index := slices.IndexFunc(state.Entries, func(e deliveryQueueRecord) bool { return e.ID == payload.ID })
		if action == "enqueue" {
			if index >= 0 {
				existing := state.Entries[index]
				if existing.Fingerprint != added.Fingerprint {
					return false, deliveryConflict()
				}
				result = existing.deliveryQueueEntry
				return changed, nil
			}
			perThread, total := 0, 0
			for _, e := range state.Entries {
				if !deliveryTerminal(e.Status) {
					total++
					if e.ThreadID == added.ThreadID {
						perThread++
					}
				}
			}
			if perThread >= 20 || total >= 200 {
				return false, deliveryError("QUEUE_FULL", "Queue is full")
			}
			state.Entries = append(state.Entries, added)
			result = added.deliveryQueueEntry
			return true, nil
		}
		if index < 0 {
			return false, deliveryConflict()
		}
		entry := &state.Entries[index]
		if entry.Version != payload.Version || deliveryTerminal(entry.Status) || (entry.Claim != nil && action != "cancel" && action != "pause" && action != "edit") || entry.Status == "sending" || entry.Status == "unknown" {
			return false, deliveryConflict()
		}
		if (action == "resume" || action == "sendNow" || action == "reorder") && deliveryThreadBlocked(state, entry.ThreadID, entry.ID, receipts) {
			return false, deliveryUnconfirmed()
		}
		entry.Version++
		entry.UpdatedAt = time.Now().UnixMilli()
		switch action {
		case "cancel":
			entry.Status, entry.Claim = "cancelled", nil
		case "pause":
			entry.Status, entry.Claim = "paused", nil
		case "resume", "sendNow":
			if entry.SubmissionStatus != "" {
				return false, deliveryError("QUEUE_INVALID", "Create a new message after a rejected submission.")
			}
			entry.Status, entry.Owner, entry.Error, entry.RequiresResume, entry.SendNow = "queued", &q.owner, "", false, action == "sendNow"
			entry.WaitTurnID = ""
			if entry.SendNow {
				moving := *entry
				state.Entries = slices.Delete(state.Entries, index, index+1)
				first := slices.IndexFunc(state.Entries, func(e deliveryQueueRecord) bool { return e.ThreadID == moving.ThreadID && !deliveryTerminal(e.Status) })
				if first < 0 {
					first = len(state.Entries)
				}
				state.Entries = slices.Insert(state.Entries, first, moving)
				entry = &state.Entries[first]
			}
		case "edit":
			if entry.SubmissionStatus != "" {
				return false, deliveryConflict()
			}
			// The attachment lock is nonblocking. Cleanup can hold it while
			// reading this queue, so binding must never wait for that lock.
			if edited.bind != nil {
				if err := edited.bind(); err != nil {
					return false, err
				}
			}
			entry.Text, entry.Mentions, entry.Params, entry.Claim = edited.Text, edited.Mentions, edited.Params, nil
		case "reorder":
			if payload.Direction != -1 && payload.Direction != 1 {
				return false, deliveryError("QUEUE_INVALID", "Invalid queue order")
			}
			other := index + payload.Direction
			for other >= 0 && other < len(state.Entries) && (state.Entries[other].ThreadID != entry.ThreadID || deliveryTerminal(state.Entries[other].Status)) {
				other += payload.Direction
			}
			if other < 0 || other >= len(state.Entries) || state.Entries[other].Claim != nil || state.Entries[other].Status == "sending" || state.Entries[other].Status == "unknown" {
				return false, deliveryConflict()
			}
			state.Entries[other].Version++
			state.Entries[index], state.Entries[other] = state.Entries[other], state.Entries[index]
			entry = &state.Entries[other]
		}
		result = entry.deliveryQueueEntry
		return true, nil
	})
	if err == nil {
		q.changed(result.ThreadID)
		q.signal()
	}
	return result, err
}

type deliveryQueueEdit struct {
	deliveryQueueEntry
	bind func() error
}

func (q *deliveryQueue) prepareEdit(ctx context.Context, payload deliveryMutation) (deliveryQueueEdit, error) {
	var entry deliveryQueueEdit
	if payload.Text == nil || len(*payload.Text) > 128<<10 || len(payload.AttachmentIDs) > 20 {
		return entry, deliveryError("QUEUE_INVALID", "Invalid queued message edit")
	}
	if err := q.transaction(func(state *deliveryQueueState) (bool, error) {
		for _, current := range state.Entries {
			if current.ID == payload.ID && current.Version == payload.Version && !deliveryTerminal(current.Status) && current.Status != "sending" && current.Status != "unknown" && current.SubmissionStatus == "" {
				entry.deliveryQueueEntry = current.deliveryQueueEntry
				return false, nil
			}
		}
		return false, deliveryConflict()
	}); err != nil {
		return entry, err
	}

	var params map[string]json.RawMessage
	var input []map[string]json.RawMessage
	var mentions []json.RawMessage
	if json.Unmarshal(entry.Params, &params) != nil || json.Unmarshal(params["input"], &input) != nil {
		return entry, deliveryError("QUEUE_INVALID", "This message cannot be edited safely")
	}
	_ = json.Unmarshal(entry.Mentions, &mentions)
	seen := make(map[string]bool)
	for _, item := range mentions {
		var mention struct{ ID, Source string }
		if json.Unmarshal(item, &mention) == nil && mention.Source == "attachment" {
			seen[mention.ID] = true
		}
	}
	for _, item := range input {
		var kind, path string
		_ = json.Unmarshal(item["type"], &kind)
		if kind == "localImage" && json.Unmarshal(item["path"], &path) == nil {
			if id := q.attachmentID(path); id != "" {
				seen[id] = true
			}
		}
	}
	var ids []string
	for _, id := range payload.AttachmentIDs {
		if !submissionUUID.MatchString(id) {
			return entry, deliveryError("QUEUE_INVALID", "Invalid queued message edit")
		}
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}

	var cwd string
	var images []workspaceAttachment
	if len(ids) != 0 {
		if len(seen) > 20 || q.resolveAttachments == nil {
			return entry, deliveryError("QUEUE_INVALID", "Invalid queued message edit")
		}
		_ = json.Unmarshal(params["cwd"], &cwd)
		if cwd == "" {
			result, err := q.c.request(ctx, "thread/read", conversationObject(map[string]any{"threadId": entry.ThreadID, "includeTurns": false}))
			if err != nil {
				return entry, err
			}
			var reply struct {
				Thread struct{ Cwd string } `json:"thread"`
			}
			if json.Unmarshal(result, &reply) != nil || reply.Thread.Cwd == "" {
				return entry, deliveryError("QUEUE_INVALID", "Attachment project is unavailable")
			}
			cwd = reply.Thread.Cwd
		}
		var err error
		images, err = q.resolveAttachments(ctx, ids, cwd, entry.ThreadID, false)
		if err != nil {
			return entry, err
		}
		if len(images) != len(ids) || slices.ContainsFunc(images, func(image workspaceAttachment) bool { return !image.Image }) {
			return entry, deliveryError("QUEUE_INVALID", "Queued attachments must be images")
		}
	}

	firstIndex := -1
	var original string
	old := strings.TrimSpace(entry.Text)
	for i, item := range input {
		var kind string
		_ = json.Unmarshal(item["type"], &kind)
		if kind == "text" {
			firstIndex = i
			if json.Unmarshal(item["text"], &original) != nil {
				return entry, deliveryError("QUEUE_INVALID", "This message cannot be edited safely")
			}
			break
		}
	}
	if old != "" && old != original && !strings.HasPrefix(original, old+"\n") {
		return entry, deliveryError("QUEUE_INVALID", "This message cannot be edited safely")
	}
	text := strings.TrimSpace(*payload.Text)
	appendText := func(line string) {
		if line != "" {
			if text != "" {
				text += "\n"
			}
			text += line
		}
	}
	appendText(strings.TrimPrefix(original[len(old):], "\n"))
	for _, image := range images {
		var name bytes.Buffer
		writeConversationJSONString(&name, image.Name)
		appendText("Attached file " + name.String() + ": " + image.Path)
		input = append(input, map[string]json.RawMessage{"type": conversationObject("localImage"), "path": conversationObject(image.Path)})
		mentions = append(mentions, conversationObject(map[string]string{"id": image.ID, "source": "attachment", "title": image.Name, "icon": "image"}))
	}
	if firstIndex >= 0 {
		item := input[firstIndex]
		var elements []json.RawMessage
		_ = json.Unmarshal(item["text_elements"], &elements)
		if text != original && len(elements) != 0 {
			return entry, deliveryError("QUEUE_INVALID", "This message cannot be edited safely")
		}
		if text == "" {
			input = slices.Delete(input, firstIndex, firstIndex+1)
		} else {
			item["text"] = conversationObject(text)
		}
	} else if text != "" {
		input = slices.Insert(input, 0, map[string]json.RawMessage{"type": conversationObject("text"), "text": conversationObject(text), "text_elements": json.RawMessage("[]")})
	}
	if mentions == nil {
		mentions = []json.RawMessage{}
	}
	params["input"] = conversationObject(input)
	entry.Params, entry.Text, entry.Mentions = conversationObject(params), *payload.Text, conversationObject(mentions)
	if len(input) == 0 || len(entry.Params)+len(conversationObject(entry.Text))+len(entry.Mentions) > 256<<10 {
		return entry, deliveryError("QUEUE_INVALID", "Invalid queued message edit")
	}
	if len(ids) != 0 {
		threadID := entry.ThreadID
		entry.bind = func() error {
			_, err := q.resolveAttachments(ctx, ids, cwd, threadID, true)
			return err
		}
	}
	return entry, nil
}

func (q *deliveryQueue) attachmentID(path string) string {
	rel, err := filepath.Rel(filepath.Join(q.c.privateRoot, "remote-web-attachments"), path)
	parts := strings.Split(rel, string(filepath.Separator))
	if err == nil && len(parts) == 2 && submissionUUID.MatchString(parts[0]) {
		return parts[0]
	}
	return ""
}

func (q *deliveryQueue) protectedAttachmentIDs() (map[string]bool, error) {
	result := make(map[string]bool)
	err := q.transaction(func(state *deliveryQueueState) (bool, error) {
		for _, entry := range state.Entries {
			if deliveryTerminal(entry.Status) {
				continue
			}
			var mentions []struct{ ID, Source string }
			_ = json.Unmarshal(entry.Mentions, &mentions)
			for _, m := range mentions {
				if m.Source == "attachment" {
					result[m.ID] = true
				}
			}
			var params struct{ Input []struct{ Type, Path string } }
			_ = json.Unmarshal(entry.Params, &params)
			for _, item := range params.Input {
				if item.Type == "localImage" {
					if id := q.attachmentID(item.Path); id != "" {
						result[id] = true
					}
				}
			}
		}
		return false, nil
	})
	return result, err
}

func decodeDeliveryCurrent(result json.RawMessage) deliveryTurn {
	var reply struct {
		Thread struct{ Turns []deliveryTurn }
	}
	if json.Unmarshal(result, &reply) != nil || len(reply.Thread.Turns) == 0 {
		return deliveryTurn{}
	}
	turns := reply.Thread.Turns
	for i := len(turns) - 1; i >= 0; i-- {
		if turns[i].Status == "inProgress" {
			return turns[i]
		}
	}
	return turns[len(turns)-1]
}

func (q *deliveryQueue) currentTurn(ctx context.Context, thread string) (deliveryTurn, error) {
	result, err := q.c.request(ctx, "thread/read", conversationObject(map[string]any{"threadId": thread, "includeTurns": true}))
	if err != nil {
		return deliveryTurn{}, err
	}
	return decodeDeliveryCurrent(result), nil
}

func (q *deliveryQueue) updateClaim(id string, fn func(*deliveryQueueRecord) bool) (*deliveryQueueEntry, error) {
	var result *deliveryQueueEntry
	err := q.transaction(func(state *deliveryQueueState) (bool, error) {
		for i := range state.Entries {
			entry := &state.Entries[i]
			if entry.ID == id && entry.Claim != nil && entry.Claim.Instance == q.owner.Instance {
				if fn(entry) {
					entry.Version++
					entry.UpdatedAt = time.Now().UnixMilli()
				}
				result = &entry.deliveryQueueEntry
				return true, nil
			}
		}
		return false, nil
	})
	if err == nil && result != nil {
		q.changed(result.ThreadID)
	}
	return result, err
}

func (q *deliveryQueue) dispatch(ctx context.Context, entry deliveryQueueRecord, conn *nativeConn) {
	available := func() bool { return ctx.Err() == nil && q.c.bridge.current() == conn }
	wait := func(turn deliveryTurn) {
		_, _ = q.updateClaim(entry.ID, func(item *deliveryQueueRecord) bool {
			changed := item.Status != "waiting" || item.WaitTurnID != turn.ID
			item.Status, item.WaitTurnID, item.Claim = "waiting", turn.ID, nil
			return changed
		})
	}
	fail := func(err error) {
		_, _ = q.updateClaim(entry.ID, func(item *deliveryQueueRecord) bool {
			if item.Status == "sending" {
				item.Status, item.Error = "unknown", "Delivery could not be confirmed. It was not replayed."
			} else {
				item.Status, item.Error = "failed", err.Error()
			}
			item.Claim = nil
			return true
		})
	}
	if !available() {
		_, _ = q.updateClaim(entry.ID, func(item *deliveryQueueRecord) bool { item.Status, item.Claim = "paused", nil; return true })
		return
	}
	turn, err := q.currentTurn(ctx, entry.ThreadID)
	if err != nil {
		fail(err)
		return
	}
	if !entry.SendNow && turn.Status == "inProgress" {
		wait(turn)
		return
	}
	if !entry.SendNow && entry.WaitTurnID != "" && turn.ID == entry.WaitTurnID && turn.Status != "completed" {
		_, _ = q.updateClaim(entry.ID, func(item *deliveryQueueRecord) bool { item.Status, item.Claim = "paused", nil; return true })
		return
	}
	resumed, err := q.c.request(ctx, "thread/resume", conversationObject(map[string]string{"threadId": entry.ThreadID}))
	if err != nil {
		fail(err)
		return
	}
	turn = decodeDeliveryCurrent(resumed)
	if turn.Status != "inProgress" {
		turn, err = q.currentTurn(ctx, entry.ThreadID)
		if err != nil {
			fail(err)
			return
		}
	}
	if !entry.SendNow && turn.Status == "inProgress" {
		wait(turn)
		return
	}
	latest, err := q.updateClaim(entry.ID, func(item *deliveryQueueRecord) bool { item.Status = "sending"; return true })
	if err != nil || latest == nil || !available() {
		return
	}
	var params map[string]json.RawMessage
	if json.Unmarshal(entry.Params, &params) != nil || params == nil {
		fail(deliveryError("QUEUE_INVALID", "Invalid queued parameters"))
		return
	}
	steer := entry.SendNow && turn.Status == "inProgress"
	method := "turn/start"
	if steer {
		method = "turn/steer"
		params = map[string]json.RawMessage{"threadId": conversationObject(entry.ThreadID), "input": params["input"], "expectedTurnId": conversationObject(turn.ID)}
	}
	params["clientUserMessageId"] = conversationObject(entry.ID)
	input, err := parseSubmission(method, conversationObject(params))
	if err != nil {
		fail(err)
		return
	}
	var guarded deliveryTurn
	receipt, err := q.c.submissions.submit(ctx, input, func() (bool, error) {
		if !available() {
			return false, nil
		}
		receipts, err := q.c.submissions.listPending(entry.ThreadID)
		if err != nil {
			return false, err
		}
		blocked := false
		if err := q.transaction(func(state *deliveryQueueState) (bool, error) {
			blocked = deliveryThreadBlocked(state, entry.ThreadID, entry.ID, receipts)
			return false, nil
		}); err != nil || blocked {
			return false, err
		}
		guarded, err = q.currentTurn(ctx, entry.ThreadID)
		if err != nil || !available() {
			return false, err
		}
		if steer {
			return guarded.Status == "inProgress" && guarded.ID == turn.ID, nil
		}
		return guarded.Status != "inProgress", nil
	})
	if err != nil {
		fail(err)
		return
	}
	_, _ = q.updateClaim(entry.ID, func(item *deliveryQueueRecord) bool {
		switch receipt.Status {
		case "accepted":
			item.Status = "completed"
		case "rejected":
			item.Status = "failed"
		case "deferred":
			item.Status = "waiting"
			if guarded.Status == "inProgress" {
				item.WaitTurnID = guarded.ID
			}
		default:
			item.Status = "unknown"
		}
		if receipt.Error != nil {
			item.Error = receipt.Error.Message
		}
		if receipt.Status != "deferred" {
			item.SubmissionStatus = receipt.Status
		}
		item.Claim, item.SendNow = nil, false
		return true
	})
}

func (q *deliveryQueue) tick(ctx context.Context, conn *nativeConn) {
	receipts, err := q.c.submissions.listPending("")
	if err != nil || ctx.Err() != nil || q.c.bridge.current() != conn {
		return
	}
	var ready []deliveryQueueRecord
	if err := q.transaction(func(state *deliveryQueueState) (bool, error) {
		if ctx.Err() != nil || q.c.bridge.current() != conn {
			return false, nil
		}
		dirty := q.recover(state)
		seen := make(map[string]bool)
		for i := range state.Entries {
			entry := &state.Entries[i]
			if seen[entry.ThreadID] || deliveryTerminal(entry.Status) {
				continue
			}
			seen[entry.ThreadID] = true
			if len(ready) >= 8 || (entry.Status != "queued" && entry.Status != "waiting") || entry.Claim != nil || entry.RequiresResume || deliveryThreadBlocked(state, entry.ThreadID, entry.ID, receipts) {
				continue
			}
			if entry.Owner != nil && entry.Owner.Instance != q.owner.Instance && entry.Owner.alive(q.owner.Host) {
				continue
			}
			entry.Owner, entry.Claim = &q.owner, &q.owner
			ready = append(ready, *entry)
			dirty = true
		}
		return dirty, nil
	}); err != nil {
		return
	}
	var workers sync.WaitGroup
	for _, entry := range ready {
		workers.Go(func() { q.dispatch(ctx, entry, conn) })
	}
	workers.Wait()
}

func (q *deliveryQueue) observeCompletion(raw json.RawMessage) {
	var event deliveryTurnEvent
	if json.Unmarshal(raw, &event) != nil || event.ThreadID == "" || event.Turn.ID == "" {
		return
	}
	select {
	case q.completed <- event:
	default:
		// If dispatch is saturated, fail closed for this connection rather
		// than letting a cancelled turn silently release the next message.
		if conn := q.c.bridge.current(); conn != nil {
			conn.close()
		}
	}
}

func (q *deliveryQueue) processCompletion(event deliveryTurnEvent) {
	if event.Turn.Status != "completed" {
		_ = q.transaction(func(state *deliveryQueueState) (bool, error) {
			dirty := false
			for i := range state.Entries {
				e := &state.Entries[i]
				if e.ThreadID == event.ThreadID && e.WaitTurnID == event.Turn.ID && e.Status == "waiting" {
					e.Status, e.Claim = "paused", nil
					e.Version++
					dirty = true
				}
			}
			return dirty, nil
		})
	}
	q.changed(event.ThreadID)
}

func (q *deliveryQueue) pauseOwned() {
	_ = q.transaction(func(state *deliveryQueueState) (bool, error) {
		dirty := false
		for i := range state.Entries {
			e := &state.Entries[i]
			if e.Owner == nil || e.Owner.Instance != q.owner.Instance || deliveryTerminal(e.Status) || e.Status == "paused" || e.Status == "unknown" {
				continue
			}
			if e.Status == "sending" {
				e.Status = "unknown"
			} else {
				e.Status = "paused"
			}
			e.Version++
			e.Claim = nil
			dirty = true
		}
		return dirty, nil
	})
	q.changed("")
}

func (q *deliveryQueue) run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	defer q.pauseOwned()
	var previous *nativeConn
	var running <-chan struct{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-q.wake:
		case event := <-q.completed:
			q.processCompletion(event)
		case <-running:
			running = nil
			continue
		}
		conn := q.c.bridge.current()
		if previous != nil && conn != previous {
			q.pauseOwned()
		}
		previous = conn
		if running == nil && conn != nil {
			done := make(chan struct{})
			running = done
			go func() { defer close(done); q.tick(ctx, conn) }()
		}
	}
}

func (c *conversation) run(ctx context.Context) {
	var sessions sync.WaitGroup
	sessions.Go(func() { c.sideChats.run(ctx) })
	if c.scheduler != nil {
		sessions.Go(func() { c.scheduler.run(ctx) })
	}
	if c.notifier != nil {
		sessions.Go(func() { c.notifier.run(ctx) })
	}
	if c.delivery != nil {
		c.delivery.run(ctx)
	}
	sessions.Wait()
}

func (c *conversation) deliveryRPC(ctx context.Context, method string, raw json.RawMessage) (json.RawMessage, error) {
	if c.delivery == nil {
		return nil, deliveryError("QUEUE_STORAGE_UNSAFE", "A private Codex state directory is required")
	}
	var params struct {
		Action   string          `json:"action"`
		ThreadID string          `json:"threadId"`
		Payload  json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return nil, deliveryError("QUEUE_INVALID", "Invalid queue request")
	}
	if method == "host/delivery/list" {
		entries, err := c.delivery.list(params.ThreadID)
		if err != nil {
			return nil, err
		}
		return marshalConversation(map[string]any{"entries": entries})
	}
	entry, err := c.delivery.mutate(ctx, params.Action, params.Payload)
	if err != nil {
		return nil, err
	}
	return marshalConversation(entry)
}
