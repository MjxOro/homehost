package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/MjxOro/homehost/apps/worker/internal/contract"
)

const cfAPI = "https://api.cloudflare.com/client/v4"

// Cloudflare is the DNS implementation: per-box AAAA records through the
// Cloudflare API, visibility through Cloudflare DoH.
type Cloudflare struct {
	token  string
	client *http.Client

	mu    sync.Mutex
	zones map[string]zone // zone name -> zone
}

var _ DNS = (*Cloudflare)(nil)

func NewCloudflare(token string) *Cloudflare {
	return &Cloudflare{
		token:  token,
		client: &http.Client{Timeout: 30 * time.Second},
		zones:  map[string]zone{},
	}
}

func (c *Cloudflare) do(ctx context.Context, method, endpoint string, body any, out any) (int, error) {
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		payload = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, cfAPI+endpoint, payload)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if out == nil {
		_, _ = io.Copy(io.Discard, res.Body)
		return res.StatusCode, nil
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return res.StatusCode, fmt.Errorf("cf %s %s: decode: %w", method, endpoint, err)
	}
	return res.StatusCode, nil
}

// zone is a Cloudflare zone: its id and the authoritative nameservers.
type zone struct {
	id          string
	nameServers []string
}

// zoneOf finds the apex zone owning name: Cloudflare has no parent lookup,
// so probe from the longest suffix down (dev.homehost.risktozero.sh ->
// homehost.risktozero.sh -> risktozero.sh) and cache the winner.
func (c *Cloudflare) zoneOf(ctx context.Context, name string) (zone, error) {
	var parts []string
	for _, p := range strings.Split(name, ".") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	for i := 0; i <= len(parts)-2; i++ {
		candidate := strings.Join(parts[i:], ".")
		c.mu.Lock()
		cached, ok := c.zones[candidate]
		c.mu.Unlock()
		if ok {
			return cached, nil
		}
		var body struct {
			Result []struct {
				ID          string   `json:"id"`
				Name        string   `json:"name"`
				NameServers []string `json:"name_servers"`
			} `json:"result"`
		}
		status, err := c.do(ctx, http.MethodGet, "/zones?"+url.Values{"name": {candidate}}.Encode(), nil, &body)
		if err != nil {
			return zone{}, err
		}
		if status < 200 || status > 299 {
			return zone{}, fmt.Errorf("cf zones failed: %d", status)
		}
		for _, r := range body.Result {
			if r.Name == candidate && r.ID != "" {
				z := zone{id: r.ID, nameServers: r.NameServers}
				c.mu.Lock()
				c.zones[candidate] = z
				c.mu.Unlock()
				return z, nil
			}
		}
	}
	return zone{}, errors.New("cf zone not found")
}

type dnsRecord struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

func (c *Cloudflare) aaaaRecords(ctx context.Context, zone, name string) ([]dnsRecord, error) {
	var body struct {
		Result []dnsRecord `json:"result"`
	}
	query := url.Values{"type": {"AAAA"}, "name": {name}}.Encode()
	if _, err := c.do(ctx, http.MethodGet, "/zones/"+zone+"/dns_records?"+query, nil, &body); err != nil {
		return nil, err
	}
	return body.Result, nil
}

func (c *Cloudflare) EnsureAAAA(ctx context.Context, name, ipv6 string) error {
	z, err := c.zoneOf(ctx, name)
	if err != nil {
		return err
	}
	records, err := c.aaaaRecords(ctx, z.id, name)
	if err != nil {
		return err
	}
	for _, r := range records {
		if contract.SameIpv6(r.Content, ipv6) {
			return nil
		}
	}
	status, err := c.do(ctx, http.MethodPost, "/zones/"+z.id+"/dns_records", map[string]any{
		"type":    "AAAA",
		"name":    name,
		"content": ipv6,
		"ttl":     120,
		"proxied": false,
	}, nil)
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("cf AAAA create failed: %d", status)
	}
	return nil
}

func (c *Cloudflare) DeleteAAAA(ctx context.Context, name string) error {
	z, err := c.zoneOf(ctx, name)
	if err != nil {
		return err
	}
	records, err := c.aaaaRecords(ctx, z.id, name)
	if err != nil {
		return err
	}
	for _, r := range records {
		if r.ID == "" {
			continue
		}
		status, err := c.do(ctx, http.MethodDelete, "/zones/"+z.id+"/dns_records/"+r.ID, nil, nil)
		if err != nil {
			return err
		}
		if status < 200 || status > 299 {
			return fmt.Errorf("cf AAAA delete failed: %d", status)
		}
	}
	return nil
}

// Visible reports whether Cloudflare DoH (not the host's resolvers) answers
// name with ipv6. It asks DoH only once the zone's authoritative nameservers
// serve the exact address: until the new record propagates they answer with
// the zone's wildcard (*.homehost -> edge host), and a resolver that sees
// that answer caches it for the wildcard's TTL, which outlasts the whole
// readiness budget.
func (c *Cloudflare) Visible(ctx context.Context, name, ipv6 string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	z, err := c.zoneOf(ctx, name)
	if err != nil {
		return false, err
	}
	if published, err := publishedAuthoritatively(ctx, z.nameServers, name, ipv6); !published {
		return false, err
	}
	endpoint := "https://cloudflare-dns.com/dns-query?" + url.Values{"name": {name}, "type": {"AAAA"}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Accept", "application/dns-json")
	res, err := c.client.Do(req)
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return false, nil
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return false, err
	}
	return contract.DohHasAaaa(body, ipv6), nil
}

// publishedAuthoritatively asks the zone's own nameservers, which answer
// from the zone itself and cache nothing, whether name already serves ipv6.
func publishedAuthoritatively(ctx context.Context, nameServers []string, name, ipv6 string) (bool, error) {
	lastErr := errors.New("cf zone has no name servers")
	for _, ns := range nameServers {
		resolver := &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, network, net.JoinHostPort(ns, "53"))
			},
		}
		ips, err := resolver.LookupIP(ctx, "ip6", name+".")
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			return false, nil
		}
		if err != nil {
			lastErr = err
			continue
		}
		for _, ip := range ips {
			if contract.SameIpv6(ip.String(), ipv6) {
				return true, nil
			}
		}
		return false, nil
	}
	return false, lastErr
}
