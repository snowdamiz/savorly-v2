package narration

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"
)

// Hub fans one generation out to concurrent listeners. A stopped player never
// stalls generation or another listener; completed audio is persisted by work.
type Hub struct {
	mu      sync.Mutex
	streams map[string]*Stream
	active  int
}

type Stream struct {
	mu      sync.Mutex
	data    []byte
	changed chan struct{}
	done    bool
	err     error
}

func (h *Hub) Start(ctx context.Context, key string, work func(context.Context, *Stream) error) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.streams == nil {
		h.streams = make(map[string]*Stream)
	}
	if h.streams[key] != nil {
		return nil
	}
	if h.active >= 4 || len(h.streams) >= 32 {
		return errors.New("narration is busy")
	}
	s := &Stream{changed: make(chan struct{})}
	h.streams[key] = s
	h.active++
	go func() {
		ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
		defer cancel()
		err := work(ctx, s)
		s.mu.Lock()
		s.done, s.err = true, err
		close(s.changed)
		s.mu.Unlock()
		h.mu.Lock()
		h.active--
		h.mu.Unlock()
		// Briefly retain failures too, so repeated taps don't repeatedly charge.
		time.AfterFunc(30*time.Second, func() {
			h.mu.Lock()
			delete(h.streams, key)
			h.mu.Unlock()
		})
	}()
	return nil
}

func (h *Hub) Get(key string) *Stream {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.streams[key]
}

func (s *Stream) Write(data []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.data)+len(data) > MaxAudioBytes {
		return 0, errors.New("narration audio is too large")
	}
	s.data = append(s.data, data...)
	close(s.changed)
	s.changed = make(chan struct{})
	return len(data), nil
}

func (s *Stream) Bytes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.data...)
}

func (s *Stream) Reader(ctx context.Context) io.ReadCloser {
	ctx, cancel := context.WithCancel(ctx)
	return &reader{stream: s, ctx: ctx, cancel: cancel}
}

type reader struct {
	stream *Stream
	ctx    context.Context
	cancel context.CancelFunc
	offset int
}

func (r *reader) Close() error { r.cancel(); return nil }
func (r *reader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for {
		if err := r.ctx.Err(); err != nil {
			return 0, err
		}
		s := r.stream
		s.mu.Lock()
		if r.offset < len(s.data) {
			n := copy(p, s.data[r.offset:])
			r.offset += n
			s.mu.Unlock()
			return n, nil
		}
		done, err, changed := s.done, s.err, s.changed
		s.mu.Unlock()
		if done {
			if err != nil {
				return 0, err
			}
			return 0, io.EOF
		}
		select {
		case <-changed:
		case <-r.ctx.Done():
			return 0, r.ctx.Err()
		}
	}
}
