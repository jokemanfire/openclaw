package debug

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"time"

	"go.uber.org/zap"
)

// Server debug server
//
// debug server用来暴露程序的一些调试/观测接口
// 使用方法 kill -10 <pid>
//
// curl --unix-socket debug.sock http://unix/debug/xxx
type Server struct {
	log *zap.Logger
	Mux *http.ServeMux
	srv *http.Server
}

func (srv *Server) Start(addr string) {
	_ = os.Remove(addr)
	l, err := net.Listen("unix", addr)
	if err != nil {
		srv.log.Warn("start http server failed", zap.String("addr", addr), zap.Error(err))
		return
	}
	defer func() { _ = l.Close() }()

	if srv.srv == nil {
		srv.srv = newDebugHTTPServer(srv.Mux)
	}

	srv.log.Info("start debug server...")
	if err = srv.srv.Serve(l); !errors.Is(err, http.ErrServerClosed) {
		srv.log.Warn("debug server serve failed", zap.Error(err))
	} else {
		srv.log.Info("debug server closed")
	}
}

func (srv *Server) stop() {
	const timeout = 3 * time.Second
	if srv.srv != nil {
		ctx, cancel := context.WithTimeout(context.TODO(), timeout)
		defer cancel()
		_ = srv.srv.Shutdown(ctx)
		srv.srv = nil
	}
}

func (srv *Server) Shutdown() {
	if srv != nil {
		srv.stop()
	}
}

func formatBytes(val uint64) string {
	const base10 = 10
	units := []string{" bytes", "KB", "MB", "GB", "TB", "PB"}
	var i int
	var target uint64
	for i = range units {
		target = 1 << uint(base10*(i+1))
		if val < target {
			break
		}
	}
	if i > 0 {
		const k = 1024
		return fmt.Sprintf("%0.2f%s (%d bytes)", float64(val)/(float64(target)/k), units[i], val)
	}
	return fmt.Sprintf("%d bytes", val)
}

// memoryStats show runtime memstats
// https://github.com/google/gops/blob/master/agent/agent.go#L217
func memoryStats(w http.ResponseWriter, _ *http.Request) {
	fprintfln := func(format string, args ...any) {
		fmt.Fprintf(w, format+"\n", args...)
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	fprintfln("======== summary ========")
	fprintfln("Alloc: %s", formatBytes(mem.Alloc))
	fprintfln("TotalAlloc: %s\n", formatBytes(mem.TotalAlloc))
	fprintfln("Sys: %v", formatBytes(mem.Sys))
	fprintfln("Lookups: %d", mem.Lookups)
	fprintfln("Mallocs: %d", mem.Mallocs)
	fprintfln("Frees: %d", mem.Frees)
	fprintfln("======== heap ========")
	fprintfln("Alloc: %s", formatBytes(mem.HeapAlloc))
	fprintfln("Sys: %s", formatBytes(mem.HeapSys))
	fprintfln("Idle: %s", formatBytes(mem.HeapIdle))
	fprintfln("Inuse: %s", formatBytes(mem.HeapInuse))
	fprintfln("Released: %s", formatBytes(mem.HeapReleased))
	fprintfln("Objects: %d", mem.HeapObjects)
	fprintfln("======== stack ========")
	fprintfln("Inuse: %s", formatBytes(mem.StackInuse))
	fprintfln("Sys: %s", formatBytes(mem.StackSys))
	fprintfln("======== others ========")
	fprintfln("MSpanInuse: %s", formatBytes(mem.MSpanInuse))
	fprintfln("MSpanSys: %s", formatBytes(mem.MSpanSys))
	fprintfln("MCacheInuse: %s", formatBytes(mem.MCacheInuse))
	fprintfln("MCacheSys: %s", formatBytes(mem.MCacheSys))
	fprintfln("OtherSys: %s", formatBytes(mem.OtherSys))
	fprintfln("======== gc ========")
	fprintfln("GCSys: %s", formatBytes(mem.GCSys))
	fprintfln("NextGC: when HeapAlloc >= %s", formatBytes(mem.NextGC))
	lastGC := "-"
	if mem.LastGC != 0 {
		lastGC = fmt.Sprint(time.Unix(0, int64(mem.LastGC)))
	}
	fprintfln("LastGC: %s", lastGC)
	fprintfln("PauseTotalNs: %v", time.Duration(mem.PauseTotalNs))
	fprintfln("PauseNs: %v", mem.PauseNs[(mem.NumGC+255)%256])
	fprintfln("PauseEnd: %v", mem.PauseEnd[(mem.NumGC+255)%256])
	fprintfln("NumGC: %d", mem.NumGC)
	fprintfln("NumForcedGC: %d", mem.NumForcedGC)
	fprintfln("GCCPUFraction: %v", mem.GCCPUFraction)
	fprintfln("EnableGC: %t", mem.EnableGC)
	fprintfln("DebugGC: %t", mem.DebugGC)
}

func gcStats(w http.ResponseWriter, _ *http.Request) {
	var gc debug.GCStats
	debug.ReadGCStats(&gc)
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "%+#v\n", gc)
}

func forceFree(w http.ResponseWriter, _ *http.Request) {
	debug.FreeOSMemory()
	w.WriteHeader(http.StatusOK)
}

func setMemLimit(w http.ResponseWriter, r *http.Request) {
	type memLimit struct {
		Limit int64 `json:"limit,string"`
	}
	var v memLimit
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(err.Error()))
		return
	}

	limit := debug.SetMemoryLimit(v.Limit)
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "limit(before): %d\n", limit)
}

func memLimit(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		setMemLimit(w, r)
	case http.MethodGet:
		limit := debug.SetMemoryLimit(-1)
		fmt.Fprintf(w, "limit: %d\n", limit)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func setGCPercent(w http.ResponseWriter, r *http.Request) {
	percent, err := strconv.ParseInt(r.FormValue("percent"), 10, 64)
	if percent <= 0 || percent > 100 || err != nil {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintf(w, "invalid gc percent %d\n", percent)
		return
	}

	debug.SetGCPercent(int(percent))
	fmt.Fprintf(w, "gc percent %d\n", percent)
}

func newDebugHTTPServer(mux *http.ServeMux) *http.Server {
	const (
		readTimeout  = 5 * time.Second
		writeTimeout = time.Minute
	)
	return &http.Server{
		Handler:           mux,
		ReadTimeout:       readTimeout,
		ReadHeaderTimeout: readTimeout >> 1,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       time.Minute,
	}
}

func NewServer(log *zap.Logger) *Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.HandleFunc("/debug/mem/stat", memoryStats)
	mux.HandleFunc("/debug/mem/free", forceFree)
	mux.HandleFunc("/debug/mem/limit", memLimit)
	mux.HandleFunc("/debug/gc/stat", gcStats)
	mux.HandleFunc("/debug/gc/percent", setGCPercent)

	srv := newDebugHTTPServer(mux)
	return &Server{log: log, Mux: mux, srv: srv}
}

func (srv *Server) Reload(addr string) {
	srv.stop()
	if addr != "" {
		go srv.Start(addr)
	}
}
