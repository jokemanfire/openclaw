package security

import (
	_ "embed"
	"encoding/json"
)

//go:embed default-policy-android.json
var defaultPolicyJSON []byte

var defaultProtectedTools = []string{
	"exec", "bash", "nodes", "read", "write", "edit", "apply_patch",
	"cron", "gateway", "sessions_spawn", "sessions_send", "subagents",
}

func LoadPolicy(raw json.RawMessage) (*Policy, error) {
	doc, err := parsePolicy(defaultPolicyJSON)
	if err != nil {
		return nil, err
	}
	p := compilePolicy(doc)

	if len(raw) > 0 {
		var cfg PluginConfig
		if err := json.Unmarshal(raw, &cfg); err == nil {
			if cfg.Mode != "" {
				p.Mode = cfg.Mode
			}
			if len(cfg.Policy) > 0 {
				custom, err := parsePolicy(cfg.Policy)
				if err != nil {
					return nil, err
				}
				p = compilePolicy(custom)
			}
		} else {
			custom, err := parsePolicy(raw)
			if err != nil {
				return nil, err
			}
			p = compilePolicy(custom)
		}
	}

	if len(p.ProtectedTools) == 0 {
		p.ProtectedTools = append([]string(nil), defaultProtectedTools...)
	}
	return p, nil
}

func parsePolicy(data []byte) (*nativePolicyDocument, error) {
	var doc nativePolicyDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	return &doc, nil
}

func compilePolicy(doc *nativePolicyDocument) *Policy {
	p := &Policy{
		ProtectedTools:        doc.ProtectedTools,
		Mode:                  doc.Mode,
		Path:                  doc.Path,
		PathDetection:         doc.PathDetection,
		CommandRules:          doc.Tools.Exec.Shell.CommandRules,
		CommandWhiteDetection: doc.CommandWhiteDetection,
		InternalHosts:         doc.Tools.Exec.Shell.InternalHosts,
		InternalSuffix:        doc.Tools.Exec.Shell.InternalHostSuffixes,
		PowerShell:            doc.Tools.Exec.PowerShell,
		ToolPolicy: ToolPolicy{
			Named: map[string]namedActions{
				"gateway":   doc.Tools.Gateway,
				"subagents": doc.Tools.Subagents,
				"nodes":     doc.Tools.Nodes,
			},
			Cron:          doc.Tools.Cron,
			SessionsSpawn: doc.Tools.SessionsSpawn,
			SessionsSend:  doc.Tools.SessionsSend,
		},
	}
	for i := range p.CommandRules {
		if p.CommandRules[i].Action == "" {
			p.CommandRules[i].Action = DecisionAsk
		}
	}
	return p
}

func (p *Policy) Protects(tool string) bool {
	if p == nil {
		return false
	}
	for _, name := range p.ProtectedTools {
		if name == tool {
			return true
		}
	}
	return false
}
