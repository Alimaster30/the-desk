package main

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	wa "github.com/polymorfa/hypermeow"
	"github.com/polymorfa/hypermeow/proto/waCompanionReg"
	"github.com/polymorfa/hypermeow/store"
	"github.com/polymorfa/hypermeow/store/sqlstore"
	"github.com/purpshell/meowcaller"
	"github.com/rs/zerolog"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

var callTargetPattern = regexp.MustCompile(`^(\+[1-9][0-9]{7,14}|[1-9][0-9]{7,14}@s\.whatsapp\.net|[0-9]{1,20}@lid)$`)

type pcmSource struct {
	mu         sync.Mutex
	pcm        []byte
	lastAppend time.Time
}

func (s *pcmSource) append(pcm []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(pcm)%2 != 0 || len(s.pcm)+len(pcm) > 64000 {
		return false
	}
	s.pcm = append(s.pcm, pcm...)
	s.lastAppend = time.Now()
	return true
}

func (s *pcmSource) clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pcm = nil
}

func (s *pcmSource) Close() error { s.clear(); return nil }

func (s *pcmSource) ReadFrame() ([]float32, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	frame := make([]float32, meowcaller.FrameSamples)
	// Keep recent partial chunks together instead of inserting silence into speech.
	if len(s.pcm) < len(frame)*2 && time.Since(s.lastAppend) < 120*time.Millisecond {
		return frame, nil
	}
	n := min(len(s.pcm)/2, len(frame))
	for i := range n {
		frame[i] = float32(int16(binary.LittleEndian.Uint16(s.pcm[i*2:]))) / 32768
	}
	s.pcm = s.pcm[n*2:]
	return frame, nil
}

type gateway struct {
	ctx       context.Context
	wa        *wa.Client
	calls     *meowcaller.Client
	secret    string
	active    chan struct{}
	mu        sync.RWMutex
	qr        string
	expiry    time.Time
	db        *sql.DB
	loggedOut bool
	syncError string
}

func (g *gateway) authorized(r *http.Request) bool {
	return subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+g.secret)) == 1
}

func (g *gateway) status(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.wa.IsLoggedIn() && g.wa.IsConnected() {
		owner := ""
		if g.wa.Store.ID != nil {
			owner = g.wa.Store.ID.ToNonAD().String()
		}
		json.NewEncoder(w).Encode(map[string]any{"state": "ready", "owner": map[string]string{"id": owner, "name": g.wa.Store.PushName}, "error": g.syncError})
	} else if g.loggedOut {
		json.NewEncoder(w).Encode(map[string]string{"state": "logged_out"})
	} else if g.qr != "" && time.Now().Before(g.expiry) {
		json.NewEncoder(w).Encode(map[string]string{"state": "qr", "qr": g.qr})
	} else {
		json.NewEncoder(w).Encode(map[string]any{"state": "disconnected", "hasSession": g.wa.Store.ID != nil})
	}
}

func (g *gateway) call(w http.ResponseWriter, r *http.Request) {
	phone := r.Header.Get("X-Call-Destination")
	if !callTargetPattern.MatchString(phone) {
		http.Error(w, "Invalid destination.", http.StatusBadRequest)
		return
	}
	if !g.wa.IsLoggedIn() || !g.wa.IsConnected() {
		http.Error(w, "Voice device is not linked.", http.StatusServiceUnavailable)
		return
	}
	select {
	case g.active <- struct{}{}:
		defer func() { <-g.active }()
	default:
		http.Error(w, "Voice device is busy.", http.StatusConflict)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64000)
	duration := 90 * time.Second
	if r.Header.Get("X-Call-Mode") == "manual" {
		duration = time.Hour
	}
	ctx, cancel := context.WithTimeout(g.ctx, duration)
	defer cancel()
	var source pcmSource
	emit := func(event string, reasons ...string) {
		write, release := context.WithTimeout(ctx, 2*time.Second)
		defer release()
		eventData := map[string]string{"event": event}
		if len(reasons) > 0 {
			eventData["reason"] = reasons[0]
		}
		payload, _ := json.Marshal(eventData)
		if conn.Write(write, websocket.MessageText, payload) != nil {
			cancel()
		}
	}
	go func() {
		defer cancel()
		for {
			kind, payload, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if kind == websocket.MessageBinary {
				if !source.append(payload) {
					emit("error", "WhatsApp playback buffer overflowed or received invalid PCM.")
					return
				}
			} else if string(payload) == `{"event":"clear"}` {
				source.clear()
			}
		}
	}()
	dialCtx, release := context.WithTimeout(ctx, 20*time.Second)
	handle, err := g.calls.Call(dialCtx, phone)
	release()
	if err != nil {
		emit("error")
		return
	}
	defer handle.Hangup()
	defer handle.Receive(nil)
	g.journal("call.attempt", map[string]any{"attempt": r.Header.Get("X-Call-Attempt"), "call_id": handle.ID(), "at": time.Now().UTC().Format(time.RFC3339Nano)})
	var ready, ended sync.Once
	onReady := func() {
		ready.Do(func() { g.journal("call.media_ready", map[string]string{"call_id": handle.ID()}); emit("answered") })
	}
	onEnd := func(reason string) { ended.Do(func() { emit("ended", reason); cancel() }) }
	emit("ringing")
	handle.OnReady(onReady)
	handle.OnEnd(onEnd)
	handle.Play(&source)
	handle.Receive(meowcaller.SinkFunc(func(frame []float32) {
		pcm := make([]byte, 2*len(frame))
		for i, sample := range frame {
			binary.LittleEndian.PutUint16(pcm[i*2:], uint16(int16(max(-1, min(sample, 32767.0/32768))*32768)))
		}
		write, release := context.WithTimeout(ctx, time.Second)
		defer release()
		if conn.Write(write, websocket.MessageBinary, pcm) != nil {
			cancel()
		}
	}))
	if handle.State() == meowcaller.CallPhaseActive {
		onReady()
	}
	if handle.State() == meowcaller.CallPhaseEnded {
		onEnd("Call ended before media became ready.")
	}
	<-ctx.Done()
}

func run(ctx context.Context) error {
	secret := strings.TrimSpace(os.Getenv("WHATSAPP_VOICE_TOKEN"))
	if len(secret) < 32 {
		return errors.New("set WHATSAPP_VOICE_TOKEN to at least 32 characters")
	}
	if err := os.MkdirAll("data/whatsapp-voice", 0700); err != nil {
		return err
	}
	session, err := filepath.Abs("data/whatsapp-voice/session.db")
	if err != nil {
		return err
	}
	store.DeviceProps.Os = proto.String("Desk")
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_CHROME.Enum()
	store.DeviceProps.RequireFullSync = proto.Bool(true)
	database, err := sqlstore.New(ctx, "sqlite", filepath.ToSlash(session)+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)", nil)
	if err != nil {
		return err
	}
	defer database.Close()
	device, err := database.GetFirstDevice(ctx)
	if err != nil {
		return err
	}
	client := wa.NewClient(device, nil)
	defer client.Disconnect()
	g := &gateway{ctx: ctx, wa: client, secret: secret, active: make(chan struct{}, 1)}
	g.db, err = openJournal(ctx, filepath.ToSlash(session))
	if err != nil {
		return err
	}
	defer g.db.Close()
	client.AddEventHandler(g.onEvent)
	g.calls = meowcaller.NewClient(client, meowcaller.WithLogger(zerolog.New(callLogWriter{gateway: g}).Level(zerolog.InfoLevel)))
	if device.ID == nil {
		codes, err := client.GetQRChannel(ctx)
		if err != nil {
			return err
		}
		go func() {
			for code := range codes {
				g.mu.Lock()
				g.qr, g.expiry = code.Code, time.Now().Add(code.Timeout)
				g.mu.Unlock()
			}
		}()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", g.status)
	mux.HandleFunc("GET /call", g.call)
	mux.HandleFunc("GET /events", g.eventLog)
	mux.HandleFunc("POST /send", g.sendMessage)
	mux.HandleFunc("GET /avatar", g.avatar)
	mux.HandleFunc("POST /logout", g.logout)
	server := &http.Server{
		Addr: "127.0.0.1:8795", ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !g.authorized(r) {
				http.Error(w, "Forbidden.", http.StatusForbidden)
				return
			}
			mux.ServeHTTP(w, r)
		}),
	}
	go func() { <-ctx.Done(); server.Close() }()
	// Hypermeow uses this context for the entire linked session, including QR pairing.
	if err := client.ConnectContext(ctx); err != nil {
		return err
	}
	log.Print("WhatsApp voice gateway listening on loopback. Pair under Admin → WhatsApp.")
	return server.ListenAndServe()
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
