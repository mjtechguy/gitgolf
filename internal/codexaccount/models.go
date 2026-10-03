package codexaccount

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
)

// Discovery reports harness catalog support, never paid inference entitlement.
type Model struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Reasoning []string `json:"reasoning"`
	Source    string   `json:"source"`
}

func ModelToken(s string) bool {
	if len(s) == 0 || len(s) > 256 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_/.:", c)) {
			return false
		}
	}
	return true
}
func (p *Process) Models(ctx context.Context) ([]Model, error) {
	var out []Model
	cursor := ""
	for page := 0; page < 8; page++ {
		var result struct {
			Data []struct {
				Model       string `json:"model"`
				DisplayName string `json:"displayName"`
				Hidden      bool   `json:"hidden"`
				Efforts     []struct {
					Effort string `json:"reasoningEffort"`
				} `json:"supportedReasoningEfforts"`
			} `json:"data"`
			Next *string `json:"nextCursor"`
		}
		params := map[string]any{"limit": 100, "includeHidden": false}
		if cursor != "" {
			params["cursor"] = cursor
		}
		if e := p.request(ctx, "model/list", params, &result); e != nil {
			return nil, e
		}
		for _, m := range result.Data {
			if m.Hidden {
				continue
			}
			v := Model{ID: m.Model, Name: m.DisplayName, Source: "native Codex model/list"}
			for _, eff := range m.Efforts {
				v.Reasoning = append(v.Reasoning, eff.Effort)
			}
			out = append(out, v)
		}
		if result.Next == nil || *result.Next == "" {
			return validateModels(out)
		}
		if *result.Next == cursor || len(*result.Next) > 2048 {
			return nil, ErrUnavailable
		}
		cursor = *result.Next
	}
	return nil, ErrUnavailable
}
func validateModels(models []Model) ([]Model, error) {
	if len(models) == 0 || len(models) > 500 {
		return nil, ErrUnavailable
	}
	seen := map[string]bool{}
	for _, m := range models {
		if !ModelToken(m.ID) || len(m.Name) > 256 || seen[m.ID] || len(m.Reasoning) > 32 {
			return nil, ErrUnavailable
		}
		seen[m.ID] = true
		for _, r := range m.Reasoning {
			if !ModelToken(r) {
				return nil, ErrUnavailable
			}
		}
	}
	return models, nil
}
func (p *Native) Models(ctx context.Context) ([]Model, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.harness == "claude-code" {
		return []Model{{ID: "default", Name: "Claude account default", Source: "documented Claude alias"}, {ID: "sonnet", Name: "Claude Sonnet alias", Reasoning: []string{"low", "medium", "high", "xhigh"}, Source: "documented Claude alias; effort support requires runtime verification"}, {ID: "opus", Name: "Claude Opus alias", Reasoning: []string{"low", "medium", "high", "xhigh"}, Source: "documented Claude alias; effort support requires runtime verification"}, {ID: "haiku", Name: "Claude Haiku alias", Source: "documented Claude alias"}}, nil
	}
	data, e := p.modelOutput(ctx, "models", p.provider, "--verbose")
	if e != nil {
		return nil, e
	}
	rest := strings.TrimSpace(string(data))
	var models []Model
	for rest != "" {
		line, remaining, ok := strings.Cut(rest, "\n")
		if !ok || !strings.HasPrefix(line, p.provider+"/") {
			return nil, ErrUnavailable
		}
		var row struct {
			ID       string                     `json:"id"`
			Name     string                     `json:"name"`
			Provider string                     `json:"providerID"`
			Variants map[string]json.RawMessage `json:"variants"`
		}
		decoder := json.NewDecoder(strings.NewReader(remaining))
		if decoder.Decode(&row) != nil || row.Provider != p.provider || line != p.provider+"/"+row.ID {
			return nil, ErrUnavailable
		}
		m := Model{ID: line, Name: row.Name, Source: "native OpenCode catalog; entitlement unverified"}
		for key, value := range row.Variants {
			var flags struct {
				Disabled bool `json:"disabled"`
			}
			if json.Unmarshal(value, &flags) != nil {
				return nil, ErrUnavailable
			}
			if !flags.Disabled {
				m.Reasoning = append(m.Reasoning, key)
			}
		}
		sort.Strings(m.Reasoning)
		models = append(models, m)
		rest = strings.TrimSpace(remaining[decoder.InputOffset():])
	}
	return validateModels(models)
}
