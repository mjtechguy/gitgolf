package server

import (
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/codexaccount"
	"time"
)

func codexUsageWire(u codexaccount.Usage) *golfv1.CodexUsage {
	v := &golfv1.CodexUsage{Available: true, CheckedAt: time.Now().UTC().Format(time.RFC3339Nano), BankedResets: u.BankedResets}
	window := func(w *codexaccount.QuotaWindow) *golfv1.CodexQuotaWindow {
		if w == nil {
			return nil
		}
		r := &golfv1.CodexQuotaWindow{UsedPercent: *w.UsedPercent, WindowDurationMins: w.Duration}
		if w.ResetsAt != nil {
			r.ResetsAt = time.Unix(*w.ResetsAt, 0).UTC().Format(time.RFC3339)
		}
		return r
	}
	for _, b := range u.Buckets {
		r := &golfv1.CodexQuotaBucket{Id: b.ID, Primary: window(b.Primary), Secondary: window(b.Secondary)}
		if b.Name != nil {
			r.Name = *b.Name
		}
		if b.Plan != nil {
			r.PlanType = *b.Plan
		}
		v.Buckets = append(v.Buckets, r)
	}
	return v
}
