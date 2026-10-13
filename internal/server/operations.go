package server

import (
	"context"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func (s *Server) GetOperationsDashboard(ctx context.Context, req *connect.Request[golfv1.GetOperationsDashboardRequest]) (*connect.Response[golfv1.GetOperationsDashboardResponse], error) {
	credential, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	cookie := s.cookieValue(req.Header())
	if err = s.requireInstanceAdmin(ctx, cookie, credential); err != nil {
		return nil, err
	}
	observed, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	checks, _ := s.dependencyChecks(observed)
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	out := &golfv1.GetOperationsDashboardResponse{RuntimeProfile: s.config.RuntimeProfile, Scope: "instance", GeneratedAt: stamp, Release: "unknown",
		Notices: []string{"Process counters restart with Golf. Latencies are histogram estimates, not browser navigation times.", "Provider billing, storage bytes, runner backlog and organization drilldown are not collected by this snapshot."}}
	for _, d := range []struct{ id, label string }{{"database", "PostgreSQL"}, {"forgejo", s.forgeLabel()}} {
		state, detail := "available", "Readiness check succeeded."
		if checks[d.id] != "ready" {
			state, detail = "degraded", "Readiness check did not succeed."
		}
		out.Services = append(out.Services, &golfv1.OperationsServiceStatus{Id: d.id, Label: d.label, State: state, Source: "Golf readiness probe", CheckedAt: stamp, Detail: detail})
	}
	if s.config.ForgeInstanceID != "" {
		out.Notices = append(out.Notices, "Forge installation: "+s.config.ForgeKind+" / "+s.config.ForgeInstanceID+"; workflow selection: "+s.config.GiteaWorkflowDirs)
	}
	metricsState, traceState := "disabled", "disabled"
	if s.config.Telemetry != nil {
		metricsState = "available"
		version, tracing := s.config.Telemetry.OperationsIdentity()
		if version != "" {
			out.Release = version
		}
		if tracing {
			traceState = "configured"
		}
		out.Metrics, err = s.config.Telemetry.OperationsMetrics()
		if err != nil {
			out.Metrics = nil
			metricsState = "degraded"
			out.Notices = append(out.Notices, "Process metrics could not be gathered.")
		}
	}
	out.Services = append(out.Services, &golfv1.OperationsServiceStatus{Id: "metrics", Label: "Golf metrics", State: metricsState, Source: "Golf process registry", CheckedAt: stamp, Detail: "Aggregate metrics from this Golf process only."}, &golfv1.OperationsServiceStatus{Id: "tracing", Label: "Trace export", State: traceState, Source: "Golf telemetry configuration", Detail: "Configuration does not establish collector delivery."})
	if s.defaultObjectStore != nil {
		out.Services = append(out.Services, &golfv1.OperationsServiceStatus{Id: "object-storage", Label: "Object storage", State: "configured", Source: "Golf runtime configuration", Detail: "Storage health and retained bytes are not probed by this snapshot."})
	}
	for _, d := range []struct {
		id, label string
		enabled   bool
	}{
		{"runners", "Enrolled runners", len(s.runnerKeys) > 0},
		{"agents", "Managed agent execution", s.config.AgentImage != ""},
		{"access", "Cloudflare Access identity bridge", s.accessOIDC != nil},
		{"previews", "Private preview runtime", s.preview != nil},
	} {
		state := "disabled"
		if d.enabled {
			state = "configured"
		}
		out.Services = append(out.Services, &golfv1.OperationsServiceStatus{Id: d.id, Label: d.label, State: state, Source: "Golf runtime configuration", Detail: "Configuration only; execution and provider health are separate observations."})
	}
	for _, d := range []struct{ id, label, unit string }{{"billing.estimated", "Estimated provider spend", "USD"}, {"billing.actual", "Provider billed spend", "USD"}, {"storage.bytes", "Retained storage", "bytes"}} {
		out.Metrics = append(out.Metrics, &golfv1.OperationsMetric{Id: d.id, Label: d.label, State: "unavailable", Source: "Not collected", Unit: d.unit})
	}
	if err = s.requireInstanceAdmin(ctx, cookie, credential); err != nil {
		return nil, err
	}
	return connect.NewResponse(out), nil
}
