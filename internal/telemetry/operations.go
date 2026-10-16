package telemetry

import (
	"math"
	"sort"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// OperationsMetrics exposes fixed aggregate dimensions, never private labels.
func (r *Runtime) OperationsMetrics() ([]*golfv1.OperationsMetric, error) {
	families, err := r.registry.Gather()
	if err != nil {
		return nil, err
	}
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	window := "Since process start " + r.started.UTC().Format(time.RFC3339Nano)
	definitions := []struct{ id, label, name string }{
		{"http.requests", "HTTP requests", "golf_http_requests_total"},
		{"http.errors", "HTTP server errors", "golf_http_requests_total"},
		{"forge.requests", "Forgejo requests", "golf_forge_requests_total"},
		{"database.queries", "Database queries", "golf_database_queries_total"},
		{"traces.failures", "Failed trace export batches", "golf_telemetry_trace_exports_total"},
	}
	metrics := make([]*golfv1.OperationsMetric, 0, 20)
	for _, d := range definitions {
		var value float64
		observed := false
		for _, family := range families {
			if family.GetName() != d.name {
				continue
			}
			for _, m := range family.Metric {
				if m.Counter == nil {
					continue
				}
				observed = true
				include := true
				if d.id == "http.errors" || d.id == "traces.failures" {
					include = false
					for _, l := range m.Label {
						if d.id == "http.errors" && l.GetName() == "status" && len(l.GetValue()) == 3 && l.GetValue()[0] == '5' {
							include = true
						}
						if d.id == "traces.failures" && l.GetName() == "outcome" && l.GetValue() == "error" {
							include = true
						}
					}
				}
				if include {
					value += m.Counter.GetValue()
				}
			}
		}
		metric := &golfv1.OperationsMetric{Id: d.id, Label: d.label, Unit: "count", Source: "Golf process registry", ObservedAt: stamp, Window: window, State: "unknown"}
		if observed && !math.IsNaN(value) && !math.IsInf(value, 0) {
			metric.Value = &value
			metric.State = "available"
		}
		metrics = append(metrics, metric)
	}
	for _, d := range []struct{ id, label, name string }{
		{"http", "HTTP handler", "golf_http_request_duration_seconds"},
		{"forge", "Forgejo response headers", "golf_forge_request_duration_seconds"},
		{"database", "Database operation", "golf_database_query_duration_seconds"},
	} {
		buckets := map[float64]uint64{}
		var count uint64
		for _, family := range families {
			if family.GetName() != d.name {
				continue
			}
			for _, m := range family.Metric {
				if m.Histogram == nil {
					continue
				}
				count += m.Histogram.GetSampleCount()
				for _, b := range m.Histogram.Bucket {
					buckets[b.GetUpperBound()] += b.GetCumulativeCount()
				}
			}
		}
		for _, q := range []struct {
			suffix   string
			quantile float64
		}{{"p50", .5}, {"p95", .95}, {"p99", .99}} {
			metric := &golfv1.OperationsMetric{Id: d.id + "." + q.suffix, Label: d.label + " " + q.suffix, Unit: "ms", Source: "Golf histogram estimate", ObservedAt: stamp, Window: window, State: "unknown"}
			if value, ok := histogramQuantile(buckets, count, q.quantile); ok {
				value *= 1000
				metric.Value = &value
				metric.State = "available"
			}
			metrics = append(metrics, metric)
		}
	}
	return metrics, nil
}

func histogramQuantile(buckets map[float64]uint64, count uint64, q float64) (float64, bool) {
	if count == 0 {
		return 0, false
	}
	bounds := make([]float64, 0, len(buckets))
	for bound := range buckets {
		bounds = append(bounds, bound)
	}
	sort.Float64s(bounds)
	var lower float64
	var previous uint64
	rank := q * float64(count)
	for _, bound := range bounds {
		cumulative := buckets[bound]
		if float64(cumulative) >= rank && cumulative > previous && !math.IsInf(bound, 0) && !math.IsNaN(bound) {
			value := lower + (bound-lower)*(rank-float64(previous))/float64(cumulative-previous)
			return value, !math.IsInf(value, 0) && !math.IsNaN(value)
		}
		lower, previous = bound, cumulative
	}
	// Observations outside the largest finite bucket have no bounded estimate.
	return 0, false
}

func (r *Runtime) OperationsIdentity() (string, bool) {
	version := r.version
	if version == "" {
		version = "development"
	}
	return version, r.provider != nil
}
