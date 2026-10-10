package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	zones map[string]string // zone name -> zone id
}

var _ DNS = (*Cloudflare)(nil)

func NewCloudflare(token string) *Cloudflare {
	return &Cloudflare{
		token:  token,
		client: &http.Client{Timeout: 30 * time.Second},
		zones:  map[string]string{},
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

// zoneOf finds the apex zone owning name: Cloudflare has no parent lookup,
// so probe from the longest suffix down (dev.homehost.risktozero.sh ->
// homehost.risktozero.sh -> risktozero.sh) and cache the winner.
func (c *Cloudflare) zoneOf(ctx context.Context, name string) (string, error) {
	var parts []string
	for _, p := range strings.Split(name, ".") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	for i := 0; i <= len(parts)-2; i++ {
		candidate := strings.Join(parts[i:], ".")
		c.mu.Lock()
		cached := c.zones[candidate]
		c.mu.Unlock()
		if cached != "" {
			return cached, nil
		}
		var body struct {
			Result []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"result"`
		}
		status, err := c.do(ctx, http.MethodGet, "/zones?"+url.Values{"name": {candidate}}.Encode(), nil, &body)
		if err != nil {
			return "", err
		}
		if status < 200 || status > 299 {
			return "", fmt.Errorf("cf zones failed: %d", status)
		}
		for _, r := range body.Result {
			if r.Name == candidate && r.ID != "" {
				c.mu.Lock()
				c.zones[candidate] = r.ID
				c.mu.Unlock()
				return r.ID, nil
			}
		}
	}
	return "", errors.New("cf zone not found")
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
	zone, err := c.zoneOf(ctx, name)
	if err != nil {
		return err
	}
	records, err := c.aaaaRecords(ctx, zone, name)
	if err != nil {
		return err
	}
	for _, r := range records {
		if contract.SameIpv6(r.Content, ipv6) {
			return nil
		}
	}
	status, err := c.do(ctx, http.MethodPost, "/zones/"+zone+"/dns_records", map[string]any{
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
	zone, err := c.zoneOf(ctx, name)
	if err != nil {
		return err
	}
	records, err := c.aaaaRecords(ctx, zone, name)
	if err != nil {
		return err
	}
	for _, r := range records {
		if r.ID == "" {
			continue
		}
		status, err := c.do(ctx, http.MethodDelete, "/zones/"+zone+"/dns_records/"+r.ID, nil, nil)
		if err != nil {
			return err
		}
		if status < 200 || status > 299 {
			return fmt.Errorf("cf AAAA delete failed: %d", status)
		}
	}
	return nil
}

// Visible asks Cloudflare DoH, not the host's resolvers. Only called after
// EnsureAAAA, so the lookup cannot negative-cache the name.
func (c *Cloudflare) Visible(ctx context.Context, name, ipv6 string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
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
