// Package contract is the worker's view of @homehost/shared: the generated
// contract.json (plans, recipes, setup rules, stream profiles) plus Go ports
// of the pure helpers the worker needs. Regenerate with `bun run
// worker:contract`; testdata/vectors.json pins the ports to the TS originals.
package contract

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

//go:embed contract.json
var contractJSON []byte

type DesktopConfig struct {
	Env      string `json:"env"`
	User     string `json:"user"`
	Display  string `json:"display"`
	KasmPort int    `json:"kasmPort"`
	VncPort  int    `json:"vncPort"`
	WebPort  int    `json:"webPort"`
}

type Plan struct {
	ID       string         `json:"id"`
	Kind     string         `json:"kind"`
	Image    string         `json:"image"`
	CPU      int            `json:"cpu"`
	MemoryMb int            `json:"memoryMb"`
	DiskGb   int            `json:"diskGb"`
	Desktop  *DesktopConfig `json:"desktop"`
}

type Recipe struct {
	// Eula names the license the owner must accept; nil when none.
	Eula *string `json:"eula"`
	Game bool    `json:"game"`
}

type SetupStep struct {
	ID        string `json:"id"`
	TimeoutMs int64  `json:"timeoutMs"`
}

type SetupPlan struct {
	Steps []SetupStep `json:"steps"`
	// HeapMb is the JVM heap for Minecraft recipes; nil without a JVM.
	HeapMb *int `json:"heapMb"`
}

type StreamProfile struct {
	FrameRate          int    `json:"frameRate"`
	DynamicQualityMin  int    `json:"dynamicQualityMin"`
	DynamicQualityMax  int    `json:"dynamicQualityMax"`
	VideoTime          int    `json:"videoTime"`
	VideoArea          int    `json:"videoArea"`
	TreatLossless      int    `json:"treatLossless"`
	MaxVideoResolution string `json:"maxVideoResolution"`
	VideoScaling       int    `json:"videoScaling"`
}

type pattern struct {
	Source string `json:"source"`
	Flags  string `json:"flags"`
}

type document struct {
	Plans                 []Plan                           `json:"plans"`
	Recipes               map[string]Recipe                `json:"recipes"`
	SetupPlans            map[string]map[string]*SetupPlan `json:"setupPlans"`
	SetupStepAttempts     int                              `json:"setupStepAttempts"`
	SetupExitCodes        map[string]int                   `json:"setupExitCodes"`
	SetupStepDefaultError map[string]string                `json:"setupStepDefaultError"`
	SetupTransientOutput  []pattern                        `json:"setupTransientOutput"`
	MinecraftPort         int                              `json:"minecraftPort"`
	StreamProfiles        map[string]StreamProfile         `json:"streamProfiles"`
}

var (
	doc       document
	transient []*regexp.Regexp

	// SetupStepAttempts is how often one step runs when its output shows a
	// transient failure.
	SetupStepAttempts int
	// MinecraftPort is the Minecraft Java listen port players reach.
	MinecraftPort int
	// SetupExitCodes maps setup error codes to the exit codes step scripts use.
	SetupExitCodes map[string]int
)

func init() {
	if err := json.Unmarshal(contractJSON, &doc); err != nil {
		panic(fmt.Sprintf("contract.json: %v", err))
	}
	for _, p := range doc.SetupTransientOutput {
		re, err := compileJSRegexp(p)
		if err != nil {
			panic(fmt.Sprintf("contract.json transient pattern %q: %v", p.Source, err))
		}
		transient = append(transient, re)
	}
	SetupStepAttempts = doc.SetupStepAttempts
	MinecraftPort = doc.MinecraftPort
	SetupExitCodes = doc.SetupExitCodes
}

// compileJSRegexp maps a JS RegExp to RE2. Only the `i` flag is used.
func compileJSRegexp(p pattern) (*regexp.Regexp, error) {
	prefix := ""
	for _, f := range p.Flags {
		switch f {
		case 'i':
			prefix = "(?i)"
		default:
			return nil, fmt.Errorf("unsupported flag %q", f)
		}
	}
	return regexp.Compile(prefix + p.Source)
}

// PlanByID returns the catalog plan, or nil for an unknown id.
func PlanByID(id string) *Plan {
	for i := range doc.Plans {
		if doc.Plans[i].ID == id {
			return &doc.Plans[i]
		}
	}
	return nil
}

// RecipeByID returns the catalog recipe, or nil for an unknown id.
func RecipeByID(id string) *Recipe {
	r, ok := doc.Recipes[id]
	if !ok {
		return nil
	}
	return &r
}

// PlanSetup is what the worker runs for a stored recipe on a plan; nil when
// the recipe has nothing to install (not installable, unknown, no steps).
func PlanSetup(recipeID, planID string) *SetupPlan {
	return doc.SetupPlans[recipeID][planID]
}

// SharpStreamProfile is the KasmVNC profile baked into desktop VMs.
func SharpStreamProfile() StreamProfile {
	return doc.StreamProfiles["sharp"]
}

// SetupErrorOf is the stable error code for a failed step run. A nil
// exitCode means the process never reported one.
func SetupErrorOf(step string, exitCode *int, timedOut bool) string {
	if timedOut {
		return "timeout"
	}
	if exitCode != nil {
		for code, exit := range doc.SetupExitCodes {
			if *exitCode == exit {
				return code
			}
		}
	}
	return doc.SetupStepDefaultError[step]
}

// IsTransientSetupFailure reports apt/dpkg lock and network blips worth
// re-running the same step for.
func IsTransientSetupFailure(code, output string) bool {
	if code != "apt_failed" && code != "download_failed" {
		return false
	}
	for _, re := range transient {
		if re.MatchString(output) {
			return true
		}
	}
	return false
}

// GameAddressOf is the players' address once a game recipe finished setup.
func GameAddressOf(recipeID *string, setupStatus, subdomain string) *string {
	if setupStatus != "done" || recipeID == nil {
		return nil
	}
	r := RecipeByID(*recipeID)
	if r == nil || !r.Game {
		return nil
	}
	return &subdomain
}

var (
	prefixPattern = regexp.MustCompile(`^[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){3}$`)
	uuidHex       = regexp.MustCompile(`^[0-9a-f]{32}$`)
	ipv6Text      = regexp.MustCompile(`^[0-9a-f:]+$`)
	ipv6Group     = regexp.MustCompile(`^[0-9a-f]{1,4}$`)
)

// Ipv6ForInstance is the stable public address of one box inside the routed
// /64, derived from the request UUID. Reserved interface IDs (::1, ::2,
// ::ffff) are skipped by bumping the last group. Empty when no usable prefix
// is configured (v4-only hosts) or the id is not a UUID.
func Ipv6ForInstance(prefix, requestID string) string {
	clean := strings.TrimRight(strings.TrimSpace(prefix), ":")
	if !prefixPattern.MatchString(clean) {
		return ""
	}
	hex := strings.ReplaceAll(requestID, "-", "")
	if !uuidHex.MatchString(hex) {
		return ""
	}
	tail := hex[16:]
	groups := []string{tail[0:4], tail[4:8], tail[8:12], tail[12:16]}
	last, _ := strconv.ParseUint(groups[3], 16, 32)
	if last == 0x0001 || last == 0x0002 || last == 0xffff {
		groups[3] = fmt.Sprintf("%04x", last+1)
	}
	return clean + ":" + strings.Join(groups, ":")
}

// ToDesktopHostname appends `-vnc` to the first DNS label, truncating the
// label to 59 characters so it stays within the 63-character limit.
func ToDesktopHostname(subdomain string) string {
	label, rest := subdomain, ""
	if dot := strings.IndexByte(subdomain, '.'); dot != -1 {
		label, rest = subdomain[:dot], subdomain[dot:]
	}
	base := "srv"
	if label != "" {
		base = truncateUTF16(label, 59)
	}
	return base + "-vnc" + rest
}

// truncateUTF16 mirrors String.prototype.slice(0, n) for the ASCII labels
// subdomains are made of; it never splits a multi-byte rune.
func truncateUTF16(s string, n int) string {
	count := 0
	for i, r := range s {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if count+width > n {
			return s[:i]
		}
		count += width
	}
	return s
}

// NormalizeIpv6 is the fully expanded, lowercase form of a plain IPv6
// address, or "" when the text is not one (embedded IPv4, zones and brackets
// are rejected).
func NormalizeIpv6(input string) string {
	text := strings.ToLower(strings.TrimSpace(input))
	if !ipv6Text.MatchString(text) {
		return ""
	}
	halves := strings.Split(text, "::")
	if len(halves) > 2 {
		return ""
	}
	parse := func(part string) ([]string, bool) {
		if part == "" {
			return nil, true
		}
		groups := strings.Split(part, ":")
		for _, g := range groups {
			if !ipv6Group.MatchString(g) {
				return nil, false
			}
		}
		return groups, true
	}
	head, ok := parse(halves[0])
	if !ok {
		return ""
	}
	var tail []string
	if len(halves) == 2 {
		if tail, ok = parse(halves[1]); !ok {
			return ""
		}
	}
	compressed := len(halves) == 2
	count := len(head) + len(tail)
	if (compressed && count > 7) || (!compressed && count != 8) {
		return ""
	}
	all := append([]string{}, head...)
	for i := 0; compressed && i < 8-count; i++ {
		all = append(all, "0")
	}
	all = append(all, tail...)
	for i, g := range all {
		all[i] = strings.Repeat("0", 4-len(g)) + g
	}
	return strings.Join(all, ":")
}

// SameIpv6 reports whether two spellings name the same address. Invalid
// text never matches.
func SameIpv6(a, b string) bool {
	left := NormalizeIpv6(a)
	return left != "" && left == NormalizeIpv6(b)
}

const dnsTypeAAAA = 28

// DohHasAaaa reports whether a Cloudflare DoH JSON body answers an AAAA
// query with the expected address.
func DohHasAaaa(body []byte, expected string) bool {
	var doc struct {
		Status *json.RawMessage `json:"Status"`
		Answer *json.RawMessage `json:"Answer"`
	}
	if json.Unmarshal(body, &doc) != nil || doc.Status == nil || doc.Answer == nil {
		return false
	}
	var status float64
	if json.Unmarshal(*doc.Status, &status) != nil || status != 0 {
		return false
	}
	var answers []json.RawMessage
	if json.Unmarshal(*doc.Answer, &answers) != nil {
		return false
	}
	for _, raw := range answers {
		var record struct {
			Type *json.RawMessage `json:"type"`
			Data *json.RawMessage `json:"data"`
		}
		if json.Unmarshal(raw, &record) != nil || record.Type == nil || record.Data == nil {
			continue
		}
		var typ float64
		var data string
		if json.Unmarshal(*record.Type, &typ) != nil || json.Unmarshal(*record.Data, &data) != nil {
			continue
		}
		if typ == dnsTypeAAAA && SameIpv6(data, expected) {
			return true
		}
	}
	return false
}
