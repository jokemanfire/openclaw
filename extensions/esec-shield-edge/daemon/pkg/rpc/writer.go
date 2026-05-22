package rpc

import (
	"encoding/json"
	"io"
	"sync"
)

// Writer wraps stdout with mutex for concurrent-safe JSON writes.
// Multiple goroutines may respond simultaneously - serialization is required.
type Writer struct {
	w   io.Writer
	mu  sync.Mutex
	enc *json.Encoder
}

func NewWriter(w io.Writer) *Writer {
	return &Writer{
		w:   w,
		enc: json.NewEncoder(w),
	}
}

func (w *Writer) Write(msg any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.enc.Encode(msg)
}
