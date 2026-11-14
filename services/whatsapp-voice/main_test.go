package main

import (
	"encoding/binary"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/purpshell/meowcaller"
)

func TestPCMSourceFramesAndInterrupt(t *testing.T) {
	var source pcmSource
	encoded := make([]byte, 2*(meowcaller.FrameSamples+1))
	binary.LittleEndian.PutUint16(encoded, 16384)
	binary.LittleEndian.PutUint16(encoded[len(encoded)-2:], 32768)
	if !source.append(encoded) || source.append([]byte{1}) || source.append(make([]byte, 64002)) {
		t.Fatal("accepted invalid or unbounded data, or rejected a valid frame")
	}
	first, err := source.ReadFrame()
	if err != nil || first[0] != 0.5 || len(first) != meowcaller.FrameSamples {
		t.Fatal("PCM was not decoded as a 16 kHz mono frame")
	}
	second, _ := source.ReadFrame()
	if second[0] != 0 || len(source.pcm) != 2 {
		t.Fatal("recent partial audio was consumed before the rest of its frame arrived")
	}
	source.lastAppend = time.Now().Add(-time.Second)
	second, _ = source.ReadFrame()
	if second[0] != -1 || second[1] != 0 {
		t.Fatal("final partial frame was not padded with silence")
	}
	source.append(encoded)
	source.clear()
	after, _ := source.ReadFrame()
	if after[0] != 0 {
		t.Fatal("stale audio remained after interruption")
	}
}

func TestPCMSourceKeepsTwentyMillisecondChunksContiguous(t *testing.T) {
	var source pcmSource
	chunk := make([]byte, 640)
	for i := 0; i < len(chunk); i += 2 {
		binary.LittleEndian.PutUint16(chunk[i:], 8192)
	}
	for i := 0; i < 3; i++ {
		source.append(chunk)
		frame, _ := source.ReadFrame()
		if i < 2 {
			if frame[0] != 0 || len(source.pcm) != (i+1)*640 {
				t.Fatal("short input chunk was padded into audible speech")
			}
		} else {
			for _, sample := range frame {
				if sample != 0.25 {
					t.Fatal("silence was inserted between continuous PCM chunks")
				}
			}
		}
	}
}

func TestGatewayAuthentication(t *testing.T) {
	g := &gateway{secret: strings.Repeat("x", 32)}
	r := httptest.NewRequest("GET", "/status", nil)
	if g.authorized(r) {
		t.Fatal("accepted absent token")
	}
	r.Header.Set("Authorization", "Bearer "+g.secret)
	if !g.authorized(r) {
		t.Fatal("rejected configured token")
	}
}

func TestPersonalCallTargets(t *testing.T) {
	for _, target := range []string{"+12025550123", "12025550123@s.whatsapp.net", "123456789012345@lid"} {
		if !callTargetPattern.MatchString(target) {
			t.Fatalf("rejected individual contact %q", target)
		}
	}
	for _, target := range []string{"", "status@broadcast", "12345@g.us", "12345@untrusted.example", "not-a-phone", "+0000", "123456789012345:0@lid"} {
		if callTargetPattern.MatchString(target) {
			t.Fatalf("accepted invalid or non-normalized target %q", target)
		}
	}
}
