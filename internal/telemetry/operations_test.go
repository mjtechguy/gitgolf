package telemetry

import (
	"context"
	"math"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func TestOperationsAggregateMetrics(t *testing.T) {
	r, err := New(context.Background(), Config{Logger: zerolog.Nop(), ServiceVersion: "test"})
	if err != nil {
		t.Fatal(err)
	}
	metrics, err := r.OperationsMetrics()
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range metrics {
		if m.Value != nil {
			t.Fatalf("empty metric presented as observed: %s", m.Id)
		}
	}
	r.requests.WithLabelValues("GET", "web", "200").Inc()
	r.requests.WithLabelValues("GET", "web", "503").Inc()
	r.duration.WithLabelValues("GET", "web", "200").Observe(.1)
	r.exports.WithLabelValues("error").Inc()
	metrics, err = r.OperationsMetrics()
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]float64{}
	for _, m := range metrics {
		if m.Value != nil {
			values[m.Id] = *m.Value
		}
		if !strings.HasPrefix(m.Window, "Since process start") {
			t.Fatal("counter scope omitted")
		}
	}
	if values["http.requests"] != 2 || values["http.errors"] != 1 || values["traces.failures"] != 1 {
		t.Fatal(values)
	}
	if values["http.p95"] <= 0 || values["http.p95"] > 100 {
		t.Fatal(values)
	}
}
func TestOperationsHistogramBounds(t *testing.T) {
	for _, fixture := range []struct {
		b  map[float64]uint64
		n  uint64
		ok bool
	}{{map[float64]uint64{}, 0, false}, {map[float64]uint64{.1: 0, math.Inf(1): 1}, 1, false}, {map[float64]uint64{.1: 2, .2: 4}, 4, true}} {
		value, ok := histogramQuantile(fixture.b, fixture.n, .95)
		if ok != fixture.ok || ok && (math.IsNaN(value) || math.IsInf(value, 0)) {
			t.Fatalf("%v %v", value, ok)
		}
	}
}
