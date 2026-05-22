package regression

import (
	"esec-shield-daemon-edge/security"
	"testing"
)

func TestHistoricalRustRegressionCases(t *testing.T) {
	policy, err := security.LoadPolicy(nil)
	if err != nil {
		t.Fatalf("LoadPolicy: %v", err)
	}

	report := Run(policy)
	if len(report.Mismatches) == 0 {
		return
	}

	limit := len(report.Mismatches)
	if limit > 20 {
		limit = 20
	}
	for i := 0; i < limit; i++ {
		m := report.Mismatches[i]
		t.Errorf("%s (%s): %s; sample=%q", m.Case.ID, m.Case.Tool, m.Message, m.Case.Sample)
	}
	if len(report.Mismatches) > limit {
		t.Errorf("... and %d more mismatches", len(report.Mismatches)-limit)
	}
	t.Fatalf("historical Rust regression failed: mode=%s passed=%d total=%d mismatches=%d", report.Mode, report.Passed, report.Total, len(report.Mismatches))
}
