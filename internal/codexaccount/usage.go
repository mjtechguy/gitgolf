package codexaccount

import (
	"context"
	"math"
	"sort"
)

// Preserve missing provider values; an absent balance never means zero.
type QuotaWindow struct {
	UsedPercent *float64 `json:"usedPercent"`
	Duration    *uint32  `json:"windowDurationMins"`
	ResetsAt    *int64   `json:"resetsAt"`
}
type QuotaBucket struct {
	ID        string       `json:"limitId"`
	Name      *string      `json:"limitName"`
	Plan      *string      `json:"planType"`
	Primary   *QuotaWindow `json:"primary"`
	Secondary *QuotaWindow `json:"secondary"`
}
type Usage struct {
	Buckets      []QuotaBucket
	BankedResets *uint32
}

func (p *Process) Usage(ctx context.Context) (Usage, error) {
	var result struct {
		Single  *QuotaBucket           `json:"rateLimits"`
		Buckets map[string]QuotaBucket `json:"rateLimitsByLimitId"`
		Resets  *struct {
			Count *uint32 `json:"availableCount"`
		} `json:"rateLimitResetCredits"`
	}
	if err := p.request(ctx, "account/rateLimits/read", nil, &result); err != nil {
		return Usage{}, err
	}
	if len(result.Buckets) > 64 {
		return Usage{}, ErrUnavailable
	}
	u := Usage{}
	if len(result.Buckets) > 0 {
		ids := make([]string, 0, len(result.Buckets))
		for id := range result.Buckets {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			b := result.Buckets[id]
			if b.ID != "" && b.ID != id {
				return Usage{}, ErrUnavailable
			}
			b.ID = id
			u.Buckets = append(u.Buckets, b)
		}
	} else if result.Single != nil {
		u.Buckets = append(u.Buckets, *result.Single)
	}
	for _, b := range u.Buckets {
		if len(b.ID) > 128 || b.Name != nil && len(*b.Name) > 256 || b.Plan != nil && len(*b.Plan) > 128 {
			return Usage{}, ErrUnavailable
		}
		for _, w := range []*QuotaWindow{b.Primary, b.Secondary} {
			if w != nil && (w.UsedPercent == nil || math.IsNaN(*w.UsedPercent) || math.IsInf(*w.UsedPercent, 0) || *w.UsedPercent < 0 || *w.UsedPercent > 1000 || w.ResetsAt != nil && (*w.ResetsAt < 0 || *w.ResetsAt > 253402300799)) {
				return Usage{}, ErrUnavailable
			}
		}
	}
	if result.Resets != nil {
		u.BankedResets = result.Resets.Count
	}
	if len(u.Buckets) == 0 && u.BankedResets == nil {
		return Usage{}, ErrUnavailable
	}
	return u, nil
}
