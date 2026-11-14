package main

import (
	"context"
	waBinary "github.com/polymorfa/hypermeow/binary"
	"github.com/polymorfa/hypermeow/types"
	"path/filepath"
	"strings"
	"testing"
)

func TestCallDiagnosticsExcludeKeysMediaAndAccountIdentifiers(t *testing.T) {
	db, err := openJournal(context.Background(), filepath.Join(t.TempDir(), "events.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	g := &gateway{ctx: context.Background(), db: db}
	writer := callLogWriter{gateway: g}
	payload := []byte(`{"message":"media ended","call_id":"native-call","error":"transport closed","call_key_hex":"secret-key","audio":"private-audio","from":"private-account"}`)
	if n, err := writer.Write(payload); err != nil || n != len(payload) {
		t.Fatal("diagnostic write failed")
	}
	var stored string
	db.QueryRow("SELECT payload FROM desk_events ORDER BY id LIMIT 1").Scan(&stored)
	for _, secret := range []string{"secret-key", "private-audio", "private-account"} {
		if strings.Contains(stored, secret) {
			t.Fatal("diagnostics stored sensitive data")
		}
	}
	if !strings.Contains(stored, "transport closed") {
		t.Fatal("diagnostics omitted actionable error")
	}
	g.callSignal("reject", types.BasicCallMeta{CallID: "native-call", From: types.JID{User: "private-account", Server: "lid", Device: 4}}, &waBinary.Node{Attrs: waBinary.Attrs{"reason": "unsupported", "code": 123, "call-key": "secret-key"}})
	db.QueryRow("SELECT payload FROM desk_events ORDER BY id DESC LIMIT 1").Scan(&stored)
	if strings.Contains(stored, "private-account") || strings.Contains(stored, "secret-key") || !strings.Contains(stored, `"code":"123"`) {
		t.Fatal("signaling diagnostic was unsafe or lost its error code")
	}
}
