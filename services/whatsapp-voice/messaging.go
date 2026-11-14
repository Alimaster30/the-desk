package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	wa "github.com/polymorfa/hypermeow"
	"github.com/polymorfa/hypermeow/proto/waE2E"
	"github.com/polymorfa/hypermeow/types"
	"github.com/polymorfa/hypermeow/types/events"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func (g *gateway) journal(kind string, data any) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.loggedOut {
		return
	}
	payload, err := json.Marshal(map[string]any{"type": kind, "data": data})
	if err == nil {
		_, err = g.db.ExecContext(g.ctx, "INSERT INTO desk_events(payload) VALUES (?)", string(payload))
	}
	if err != nil {
		g.syncError = "Message synchronization failed; reconnect to retry."
	}
}

func wireMessage(chat, id, sender, name string, fromMe bool, timestamp uint64, message *waE2E.Message) map[string]any {
	encoded, _ := protojson.Marshal(message)
	return map[string]any{"key": map[string]any{"remoteJid": chat, "id": id, "fromMe": fromMe, "participant": sender}, "pushName": name, "messageTimestamp": timestamp, "message": json.RawMessage(encoded)}
}

func (g *gateway) onEvent(event any) {
	switch evt := event.(type) {
	case *events.CallOffer:
		g.callSignal("offer", evt.BasicCallMeta, evt.Data)
	case *events.CallAccept:
		g.callSignal("accept", evt.BasicCallMeta, evt.Data)
	case *events.CallPreAccept:
		g.callSignal("preaccept", evt.BasicCallMeta, evt.Data)
	case *events.CallReject:
		g.callSignal("reject", evt.BasicCallMeta, evt.Data)
	case *events.CallTransport:
		g.callSignal("transport", evt.BasicCallMeta, nil)
	case *events.CallTerminate:
		g.callSignal("terminate", evt.BasicCallMeta, evt.Data)
	case *events.CallRelayLatency:
		g.callSignal("relay", evt.BasicCallMeta, nil)
	case *events.Message:
		message := wireMessage(evt.Info.Chat.String(), evt.Info.ID, evt.Info.Sender.String(), evt.Info.PushName, evt.Info.IsFromMe, uint64(evt.Info.Timestamp.Unix()), evt.Message)
		if !evt.Info.IsGroup && !evt.Info.IsFromMe && evt.Info.SenderAlt.Server == "s.whatsapp.net" {
			message["key"].(map[string]any)["remoteJidAlt"] = evt.Info.SenderAlt.ToNonAD().String()
		}
		g.journal("messages.upsert", map[string]any{"type": "notify", "messages": []any{message}})
	case *events.HistorySync:
		for _, chat := range evt.Data.GetConversations() {
			g.journal("chats.upsert", []any{map[string]any{"id": chat.GetID(), "name": chat.GetName()}})
			batch := []any{}
			for _, entry := range chat.GetMessages() {
				message := entry.GetMessage()
				key := message.GetKey()
				batch = append(batch, wireMessage(chat.GetID(), key.GetID(), key.GetParticipant(), message.GetPushName(), key.GetFromMe(), message.GetMessageTimestamp(), message.GetMessage()))
				if len(batch) == 100 {
					g.journal("messages.upsert", map[string]any{"type": "append", "messages": batch})
					batch = []any{}
				}
			}
			if len(batch) > 0 {
				g.journal("messages.upsert", map[string]any{"type": "append", "messages": batch})
			}
		}
	case *events.LoggedOut:
		g.mu.Lock()
		g.loggedOut = true
		g.mu.Unlock()
	}
}

func (g *gateway) eventLog(w http.ResponseWriter, r *http.Request) {
	after, err := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if err != nil || after < 0 {
		http.Error(w, "Invalid event cursor.", 400)
		return
	}
	rows, err := g.db.QueryContext(r.Context(), "SELECT id,payload FROM desk_events WHERE id>? ORDER BY id LIMIT 100", after)
	if err != nil {
		http.Error(w, "Event history unavailable.", 503)
		return
	}
	defer rows.Close()
	result := []any{}
	for rows.Next() {
		var id int64
		var payload string
		if rows.Scan(&id, &payload) != nil {
			http.Error(w, "Event history unavailable.", 503)
			return
		}
		result = append(result, map[string]any{"id": id, "event": json.RawMessage(payload)})
	}
	if rows.Err() != nil {
		http.Error(w, "Event history unavailable.", 503)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

type messageRequest struct {
	JID        string `json:"jid"`
	Text       string `json:"text"`
	Attachment *struct {
		Kind     string `json:"kind"`
		Name     string `json:"name"`
		Mimetype string `json:"mimetype"`
		Data     []byte `json:"data"`
	} `json:"attachment"`
}

func (g *gateway) sendMessage(w http.ResponseWriter, r *http.Request) {
	var input messageRequest
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8*1024*1024)).Decode(&input) != nil {
		http.Error(w, "Invalid message.", 400)
		return
	}
	jid, err := types.ParseJID(input.JID)
	if err != nil || jid.User == "" || (jid.Server != "s.whatsapp.net" && jid.Server != "lid" && jid.Server != "g.us") || len(input.Text) > 16000 {
		http.Error(w, "Invalid message destination.", 400)
		return
	}
	if !g.wa.IsLoggedIn() || !g.wa.IsConnected() {
		http.Error(w, "Reconnect WhatsApp before sending.", 409)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 70*time.Second)
	defer cancel()
	message := &waE2E.Message{Conversation: proto.String(input.Text)}
	if file := input.Attachment; file != nil {
		if len(file.Data) == 0 || len(file.Data) > 5*1024*1024 || (file.Kind != "image" && file.Kind != "document" && file.Kind != "sticker") {
			http.Error(w, "Invalid attachment.", 400)
			return
		}
		mediaType := wa.MediaImage
		if file.Kind == "document" {
			mediaType = wa.MediaDocument
		}
		uploaded, err := g.wa.Upload(ctx, file.Data, mediaType)
		if err != nil {
			http.Error(w, "WhatsApp did not accept the upload.", 502)
			return
		}
		message = &waE2E.Message{}
		switch file.Kind {
		case "image":
			message.ImageMessage = &waE2E.ImageMessage{URL: &uploaded.URL, DirectPath: &uploaded.DirectPath, MediaKey: uploaded.MediaKey, FileEncSHA256: uploaded.FileEncSHA256, FileSHA256: uploaded.FileSHA256, FileLength: &uploaded.FileLength, Mimetype: &file.Mimetype, Caption: &input.Text}
		case "sticker":
			message.StickerMessage = &waE2E.StickerMessage{URL: &uploaded.URL, DirectPath: &uploaded.DirectPath, MediaKey: uploaded.MediaKey, FileEncSHA256: uploaded.FileEncSHA256, FileSHA256: uploaded.FileSHA256, FileLength: &uploaded.FileLength, Mimetype: &file.Mimetype}
		case "document":
			message.DocumentMessage = &waE2E.DocumentMessage{URL: &uploaded.URL, DirectPath: &uploaded.DirectPath, MediaKey: uploaded.MediaKey, FileEncSHA256: uploaded.FileEncSHA256, FileSHA256: uploaded.FileSHA256, FileLength: &uploaded.FileLength, Mimetype: &file.Mimetype, Caption: &input.Text, FileName: &file.Name}
		}
	}
	sent, err := g.wa.SendMessage(ctx, jid, message)
	if err != nil {
		http.Error(w, "WhatsApp did not confirm the message. Review the conversation before retrying.", 502)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"key": map[string]string{"id": sent.ID}})
}

func (g *gateway) avatar(w http.ResponseWriter, r *http.Request) {
	jid, err := types.ParseJID(r.URL.Query().Get("jid"))
	if err != nil {
		http.Error(w, "Invalid contact.", 400)
		return
	}
	info, err := g.wa.GetProfilePictureInfo(r.Context(), jid, &wa.GetProfilePictureParams{Preview: true})
	if err != nil || info == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"url": info.URL})
}

func (g *gateway) logout(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	g.loggedOut = true
	g.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	remote := true
	if g.wa.Store.ID != nil {
		if err := g.wa.Logout(ctx); err != nil {
			remote = false
			g.wa.Disconnect()
			if err = g.wa.Store.Delete(context.Background()); err != nil {
				http.Error(w, "Could not clear linked-device credentials.", 500)
				return
			}
		}
	}
	g.wa.Disconnect()
	if _, err := g.db.Exec("DELETE FROM desk_events"); err != nil {
		http.Error(w, "Could not clear cached events.", 500)
		return
	}
	g.mu.Lock()
	g.qr = ""
	g.expiry = time.Time{}
	g.loggedOut = true
	g.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "remoteLogout": remote})
}

func openJournal(ctx context.Context, path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err == nil {
		_, err = db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS desk_events(id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL)")
	}
	if err != nil {
		if db != nil {
			db.Close()
		}
		return nil, fmt.Errorf("message event store: %w", err)
	}
	return db, nil
}
