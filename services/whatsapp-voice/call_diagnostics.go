package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"time"

	waBinary "github.com/polymorfa/hypermeow/binary"
	"github.com/polymorfa/hypermeow/types"
)

// Keep signaling metadata only; raw diagnostic dumps contain media and encryption keys.
type callLogWriter struct{ gateway *gateway }

func (writer callLogWriter) Write(payload []byte) (int, error) {
	var log map[string]any
	if json.Unmarshal(payload, &log) != nil {
		return len(payload), nil
	}
	selected := map[string]any{"at": time.Now().UTC().Format(time.RFC3339Nano)}
	for _, key := range []string{"message", "call_id", "error", "platform", "codec", "event"} {
		if value, ok := log[key].(string); ok {
			if len(value) > 500 {
				value = value[:500]
			}
			selected[key] = value
		}
	}
	if len(selected) > 1 {
		writer.gateway.journal("call.diagnostic", selected)
	}
	return len(payload), nil
}

func (g *gateway) callSignal(kind string, meta types.BasicCallMeta, node *waBinary.Node) {
	sender := fmt.Sprintf("%x", sha256.Sum256([]byte(meta.From.ToNonAD().String())))[:12]
	data := map[string]any{"kind": kind, "call_id": meta.CallID, "sender": sender, "device": meta.From.Device, "at": time.Now().UTC().Format(time.RFC3339Nano)}
	if g.wa != nil {
		data["from_own_account"] = meta.From.ToNonAD() == g.wa.Store.GetLID().ToNonAD() || meta.From.ToNonAD() == g.wa.Store.GetJID().ToNonAD()
	}
	if node != nil {
		for _, key := range []string{"reason", "type", "error", "code", "count"} {
			switch value := node.Attrs[key].(type) {
			case string, int, int32, int64, uint, uint32, uint64, bool:
				if text := fmt.Sprint(value); len(text) < 200 {
					data[key] = text
				}
			}
		}
	}
	g.journal("call.signal", data)
}
