package server

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/mjtechguy/golf-git/internal/telemetry"
)

func (s *Server) observeHTTP(next http.Handler, webEnabled bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request *telemetry.Request
		if s.config.Telemetry != nil {
			route := "not_found"
			switch {
			case r.URL.Path == "/healthz", r.URL.Path == "/readyz", r.URL.Path == "/auth/forgejo/callback", r.URL.Path == "/rpc", strings.HasPrefix(r.URL.Path, "/rpc/"):
				// StartRequest checks its generated procedure/fixed-route allowlist;
				// unknown RPC paths never become telemetry labels.
				route = r.URL.Path
			case webEnabled && r.Method == http.MethodGet && r.URL.Path != "/api" && !strings.HasPrefix(r.URL.Path, "/api/"):
				route = "web"
			}
			ctx, started := s.config.Telemetry.StartRequest(r.Context(), r.Method, route)
			request = started
			r = r.WithContext(ctx)
			w.Header().Set("X-Request-ID", request.ID)
		}
		observed := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		aborted := false
		hijacked := false
		defer func() {
			if request != nil {
				status := observed.Status()
				if status == 0 && !aborted && !hijacked {
					status = http.StatusOK
				}
				request.End(status)
			}
		}()
		defer func() {
			if value := recover(); value != nil {
				if value == http.ErrAbortHandler || observed.Status() != 0 || hijacked {
					aborted = true
					// A committed response cannot become a 500. Abort its stream
					// without exposing the panic value or net/http's stack dump.
					panic(http.ErrAbortHandler)
				}
				http.Error(observed, "Internal server error.", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(withObservedStreaming(observed, &hijacked), r)
	})
}

type observedHijacker struct {
	hijacker http.Hijacker
	hijacked *bool
}

func (h observedHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, buffer, err := h.hijacker.Hijack()
	if err == nil {
		*h.hijacked = true
	}
	return connection, buffer, err
}

type observedFlusher struct {
	writer  middleware.WrapResponseWriter
	flusher http.Flusher
}

func (f observedFlusher) Flush() {
	// Chi's wrapper otherwise marks the header written while leaving Status=0.
	// Flushing commits an implicit 200, even with no response body.
	if f.writer.Status() == 0 {
		f.writer.WriteHeader(http.StatusOK)
	}
	f.flusher.Flush()
}

// Reuse chi's native optional-interface selection. Track implicit flush status
// and successful hijacks; HTTP/2 push, optimized copying and Unwrap stay intact.
func withObservedStreaming(w middleware.WrapResponseWriter, hijacked *bool) http.ResponseWriter {
	f, ok := w.(http.Flusher)
	if !ok {
		if h, ok := w.(http.Hijacker); ok {
			return struct {
				middleware.WrapResponseWriter
				http.Hijacker
			}{w, observedHijacker{h, hijacked}}
		}
		return w
	}
	flush := observedFlusher{writer: w, flusher: f}
	if h, ok := w.(http.Hijacker); ok {
		if copy, ok := w.(io.ReaderFrom); ok {
			return struct {
				middleware.WrapResponseWriter
				http.Flusher
				http.Hijacker
				io.ReaderFrom
			}{w, flush, observedHijacker{h, hijacked}, copy}
		}
		return struct {
			middleware.WrapResponseWriter
			http.Flusher
			http.Hijacker
		}{w, flush, observedHijacker{h, hijacked}}
	}
	if p, ok := w.(http.Pusher); ok {
		return struct {
			middleware.WrapResponseWriter
			http.Flusher
			http.Pusher
		}{w, flush, p}
	}
	return struct {
		middleware.WrapResponseWriter
		http.Flusher
	}{w, flush}
}
