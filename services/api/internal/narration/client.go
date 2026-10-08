// Package narration streams ElevenLabs audio through OpenRouter using a server key.
package narration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"time"
)

const Model = "elevenlabs/eleven-v4-turbo"
const Format = "mp3"
const DefaultVoice = "sarah"
const MaxAudioBytes = 8 * 1024 * 1024

type Client struct {
	Key, Voice, URL string
	HTTP            *http.Client
}

func New() *Client {
	voice := os.Getenv("OPENROUTER_TTS_VOICE")
	if voice == "" {
		voice = DefaultVoice
	}
	return &Client{Key: os.Getenv("OPENROUTER_API_KEY"), Voice: voice, URL: "https://openrouter.ai/api/v1/audio/speech", HTTP: &http.Client{Timeout: 25 * time.Second}}
}

func (c *Client) Enabled() bool { return c != nil && c.Key != "" }

func (c *Client) Generate(ctx context.Context, text string, output io.Writer) error {
	if !c.Enabled() {
		return errors.New("narration is not configured")
	}
	body, err := json.Marshal(map[string]string{"model": Model, "input": text, "voice": c.Voice, "response_format": Format})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
	if err != nil {
		return errors.New("invalid narration endpoint")
	}
	req.Header.Set("Authorization", "Bearer "+c.Key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "audio/mpeg")
	req.Header.Set("X-OpenRouter-Title", "Savorly")
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 25 * time.Second}
	}
	response, err := client.Do(req)
	if err != nil {
		return errors.New("narration connection failed")
	}
	defer response.Body.Close()
	// Do not expose provider error bodies or forward JSON/HTML as playable audio.
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("narration provider returned HTTP %d", response.StatusCode)
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "audio/mpeg" {
		return errors.New("narration provider returned an unexpected audio format")
	}
	if response.ContentLength > MaxAudioBytes {
		return errors.New("narration audio is too large")
	}
	// Forward raw MP3 chunks immediately. Cache only after clean HTTP EOF,
	// including the encoder's final bytes; never retry a possibly billed stream.
	buffer := make([]byte, 32*1024)
	total := 0
	for {
		n, readErr := response.Body.Read(buffer)
		if n > 0 {
			if total+n > MaxAudioBytes {
				return errors.New("narration audio is too large")
			}
			written, err := output.Write(buffer[:n])
			if err != nil {
				return err
			}
			if written != n {
				return io.ErrShortWrite
			}
			total += n
		}
		if readErr != nil {
			if readErr != io.EOF {
				return errors.New("narration stream ended before completion")
			}
			if total == 0 {
				return errors.New("narration provider returned no audio")
			}
			return nil
		}
	}
}
