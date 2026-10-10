package contract

import (
	"encoding/json"
	"os"
	"testing"
)

// Vectors are produced by the TS originals (`bun run worker:contract`), so
// these tests fail when a shared helper changes without its Go port.
type vectors struct {
	Ipv6ForInstance []struct {
		Prefix    string  `json:"prefix"`
		RequestID string  `json:"requestId"`
		Want      *string `json:"want"`
	} `json:"ipv6ForInstance"`
	ToDesktopHostname []struct {
		Subdomain string `json:"subdomain"`
		Want      string `json:"want"`
	} `json:"toDesktopHostname"`
	NormalizeIpv6 []struct {
		Input string  `json:"input"`
		Want  *string `json:"want"`
	} `json:"normalizeIpv6"`
	SameIpv6 []struct {
		A    string `json:"a"`
		B    string `json:"b"`
		Want bool   `json:"want"`
	} `json:"sameIpv6"`
	DohHasAaaa []struct {
		Body     json.RawMessage `json:"body"`
		Expected string          `json:"expected"`
		Want     bool            `json:"want"`
	} `json:"dohHasAaaa"`
	SetupErrorOf []struct {
		Step     string `json:"step"`
		ExitCode *int   `json:"exitCode"`
		TimedOut bool   `json:"timedOut"`
		Want     string `json:"want"`
	} `json:"setupErrorOf"`
	IsTransientSetupFailure []struct {
		Error  string `json:"error"`
		Output string `json:"output"`
		Want   bool   `json:"want"`
	} `json:"isTransientSetupFailure"`
	GameAddressOf []struct {
		RecipeID    string  `json:"recipeId"`
		SetupStatus string  `json:"setupStatus"`
		Subdomain   string  `json:"subdomain"`
		Want        *string `json:"want"`
	} `json:"gameAddressOf"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func orEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func TestSharedHelperParity(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Ipv6ForInstance {
		if got := Ipv6ForInstance(c.Prefix, c.RequestID); got != orEmpty(c.Want) {
			t.Errorf("Ipv6ForInstance(%q, %q) = %q, want %q", c.Prefix, c.RequestID, got, orEmpty(c.Want))
		}
	}
	for _, c := range v.ToDesktopHostname {
		if got := ToDesktopHostname(c.Subdomain); got != c.Want {
			t.Errorf("ToDesktopHostname(%q) = %q, want %q", c.Subdomain, got, c.Want)
		}
	}
	for _, c := range v.NormalizeIpv6 {
		if got := NormalizeIpv6(c.Input); got != orEmpty(c.Want) {
			t.Errorf("NormalizeIpv6(%q) = %q, want %q", c.Input, got, orEmpty(c.Want))
		}
	}
	for _, c := range v.SameIpv6 {
		if got := SameIpv6(c.A, c.B); got != c.Want {
			t.Errorf("SameIpv6(%q, %q) = %v, want %v", c.A, c.B, got, c.Want)
		}
	}
	for _, c := range v.DohHasAaaa {
		if got := DohHasAaaa(c.Body, c.Expected); got != c.Want {
			t.Errorf("DohHasAaaa(%s) = %v, want %v", c.Body, got, c.Want)
		}
	}
	for _, c := range v.SetupErrorOf {
		if got := SetupErrorOf(c.Step, c.ExitCode, c.TimedOut); got != c.Want {
			t.Errorf("SetupErrorOf(%q, %v, %v) = %q, want %q", c.Step, c.ExitCode, c.TimedOut, got, c.Want)
		}
	}
	for _, c := range v.IsTransientSetupFailure {
		if got := IsTransientSetupFailure(c.Error, c.Output); got != c.Want {
			t.Errorf("IsTransientSetupFailure(%q, %q) = %v, want %v", c.Error, c.Output, got, c.Want)
		}
	}
	for _, c := range v.GameAddressOf {
		recipe := c.RecipeID
		got := GameAddressOf(&recipe, c.SetupStatus, c.Subdomain)
		if orEmpty(got) != orEmpty(c.Want) {
			t.Errorf("GameAddressOf(%q, %q) = %q, want %q", c.RecipeID, c.SetupStatus, orEmpty(got), orEmpty(c.Want))
		}
	}
}
