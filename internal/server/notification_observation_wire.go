package server

import (
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"strconv"
	"time"
)

func wireEmailConfigurationObservation(s emailConfigurationStatus) *golfv1.EmailConfigurationObservation {
	out := &golfv1.EmailConfigurationObservation{ObservedAt: s.ObservedAt.UTC().Format(time.RFC3339Nano), Configured: s.Configured, TransportId: s.TransportID, TransportVersion: strconv.FormatInt(s.TransportVersion, 10), ActivationGeneration: strconv.FormatInt(s.ActivationGeneration, 10), ConnectedWorkers: uint32(s.ConnectedWorkers), RecentlyActiveWorkers: uint32(s.RecentlyActiveWorkers)}
	if s.LastWorkerActivity != nil {
		out.LastWorkerActivity = s.LastWorkerActivity.UTC().Format(time.RFC3339Nano)
	}
	if d := s.LatestDelivery; d != nil {
		out.LatestDelivery = &golfv1.EmailDeliveryEvidence{CreatedAt: d.CreatedAt.UTC().Format(time.RFC3339Nano), State: d.State, Attempts: uint32(d.Attempts), SmtpStatus: uint32(d.SMTPStatus), RelayAccepted: d.RelayAccepted, PossibleDuplicate: d.PossibleDuplicate}
		if d.CompletedAt != nil {
			out.LatestDelivery.CompletedAt = d.CompletedAt.UTC().Format(time.RFC3339Nano)
		}
	}
	return out
}
