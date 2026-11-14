package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	wa "github.com/polymorfa/hypermeow"
	"github.com/polymorfa/hypermeow/proto/waE2E"
	"github.com/polymorfa/hypermeow/store/sqlstore"
	"github.com/polymorfa/hypermeow/types"
	"github.com/polymorfa/hypermeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestMessageWireFormat(t *testing.T) {
	message := wireMessage("123@lid", "message-1", "sender@lid", "Customer", false, 123, &waE2E.Message{Conversation: proto.String("hello")})
	encoded, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if json.Unmarshal(encoded, &parsed) != nil || parsed["message"].(map[string]any)["conversation"] != "hello" || parsed["key"].(map[string]any)["remoteJid"] != "123@lid" {
		t.Fatal("message bridge changed identity or content")
	}
}

func TestEventJournalCursorAndLogout(t *testing.T) {
	ctx := context.Background()
	path := filepath.ToSlash(filepath.Join(t.TempDir(), "session.db"))
	db, err := openJournal(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	devices, err := sqlstore.New(ctx, "sqlite", path+"?_pragma=foreign_keys(1)", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer devices.Close()
	device, err := devices.GetFirstDevice(ctx)
	if err != nil {
		t.Fatal(err)
	}
	g := &gateway{ctx: ctx, db: db, wa: wa.NewClient(device, nil)}
	g.journal("messages.upsert", map[string]string{"text": "private"})
	g.journal("chats.upsert", []any{})
	response := httptest.NewRecorder()
	g.eventLog(response, httptest.NewRequest("GET", "/events?after=1", nil))
	var entries []map[string]any
	if json.Unmarshal(response.Body.Bytes(), &entries) != nil || len(entries) != 1 || entries[0]["id"].(float64) != 2 {
		t.Fatal("event cursor replay is incorrect")
	}
	response = httptest.NewRecorder()
	g.logout(response, httptest.NewRequest("POST", "/logout", nil))
	if response.Code != 200 {
		t.Fatalf("logout failed: %s", response.Body.String())
	}
	g.journal("messages.upsert", map[string]string{"text": "late"})
	var count int
	db.QueryRow("SELECT count(*) FROM desk_events").Scan(&count)
	if count != 0 {
		t.Fatal("old events survived logout or late events repopulated them")
	}
}

func TestSendRejectsInvalidInputBeforeNetwork(t *testing.T) {
	g := &gateway{}
	for _, body := range []string{`{`, `{"jid":"status@broadcast","text":"no"}`, `{"jid":"invalid","text":"no"}`} {
		response := httptest.NewRecorder()
		g.sendMessage(response, httptest.NewRequest("POST", "/send", strings.NewReader(body)))
		if response.Code != 400 {
			t.Fatal("invalid message reached the WhatsApp transport")
		}
	}
}

func TestLIDMessageRetainsPhoneIdentityForOrderCommands(t *testing.T) {
	db, err := openJournal(context.Background(), filepath.Join(t.TempDir(), "events.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	g := &gateway{ctx: context.Background(), db: db}
	g.onEvent(&events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: types.JID{User: "123", Server: "lid"}, SenderAlt: types.JID{User: "12025550123", Server: "s.whatsapp.net"}}, ID: "command-1", Timestamp: time.Now()}, Message: &waE2E.Message{Conversation: proto.String("CONFIRM ORDER-1")}})
	var payload string
	if db.QueryRow("SELECT payload FROM desk_events").Scan(&payload) != nil {
		t.Fatal("message not journaled")
	}
	if !strings.Contains(payload, `"remoteJidAlt":"12025550123@s.whatsapp.net"`) {
		t.Fatal("LID message lost its phone identity")
	}
}
