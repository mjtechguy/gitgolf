package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"math"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"strconv"
	"strings"

	"github.com/mjtechguy/golf-git/internal/telemetry"
	"github.com/rs/zerolog"
)

func observabilityConfig(logger zerolog.Logger) (telemetry.Config, string, string, error) {
	config := telemetry.Config{Logger: logger, OTLPEndpoint: os.Getenv("GOLF_OTLP_HTTP_ENDPOINT"), SampleRatio: 0.1, ServiceVersion: "development"}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" {
				config.ServiceVersion = setting.Value
			}
		}
	}
	if value := os.Getenv("GOLF_OTLP_INSECURE"); value != "" {
		if value != "true" && value != "false" {
			return config, "", "", errors.New("GOLF_OTLP_INSECURE must be true or false")
		}
		config.OTLPInsecure = value == "true"
	}
	if value := os.Getenv("GOLF_TRACE_SAMPLE_RATIO"); value != "" {
		ratio, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(ratio) || math.IsInf(ratio, 0) || ratio < 0 || ratio > 1 {
			return config, "", "", errors.New("GOLF_TRACE_SAMPLE_RATIO must be between zero and one")
		}
		config.SampleRatio = ratio
	}
	address, token := os.Getenv("GOLF_METRICS_ADDR"), os.Getenv("GOLF_METRICS_TOKEN")
	if address != "" {
		_, port, err := net.SplitHostPort(address)
		number, parseErr := strconv.Atoi(port)
		if err != nil || parseErr != nil || number < 1 || number > 65535 {
			return config, "", "", errors.New("GOLF_METRICS_ADDR must be a valid host:port")
		}
		if len(token) < 32 || len(token) > 256 || strings.ContainsFunc(token, func(r rune) bool { return r < 33 || r > 126 }) {
			return config, "", "", errors.New("enabled metrics require a 32–256 byte printable GOLF_METRICS_TOKEN without spaces")
		}
	}
	return config, address, token, nil
}

func privateMetrics(next http.Handler, token string) http.Handler {
	expected := sha256.Sum256([]byte("Bearer " + token))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.URL.Path != "/metrics" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		headers := r.Header.Values("Authorization")
		provided := sha256.Sum256([]byte(r.Header.Get("Authorization")))
		if len(headers) != 1 || subtle.ConstantTimeCompare(expected[:], provided[:]) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
