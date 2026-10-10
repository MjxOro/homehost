// Command homehost-worker is the host-side provisioning loop. It runs under
// systemd on the Incus host (infra/worker/homehost-worker.service) with the
// repo checkout as its working directory.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/MjxOro/homehost/apps/worker/internal/incus"
	"github.com/MjxOro/homehost/apps/worker/internal/worker"
)

func main() {
	logger := log.New(os.Stderr, "", 0)
	if err := run(logger); err != nil {
		logger.Fatal(err)
	}
}

func envInt(name string, fallback int) (int, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", name, err)
	}
	return n, nil
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func run(logger *log.Logger) error {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	ints := map[string]int{
		"WORKER_POLL_MS":            2000,
		"WORKER_PROVISION_ATTEMPTS": 5,
		"WORKER_TEARDOWN_ATTEMPTS":  25,
		"WORKER_POWER_ATTEMPTS":     5,
		"WORKER_BOOT_TIMEOUT_MS":    240000,
		"WORKER_READY_TIMEOUT_MS":   120000,
		"WORKER_SETUP_ATTEMPTS":     3,
	}
	for name, fallback := range ints {
		n, err := envInt(name, fallback)
		if err != nil {
			return err
		}
		ints[name] = n
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	cfg := worker.Config{
		PollInterval:      time.Duration(ints["WORKER_POLL_MS"]) * time.Millisecond,
		ProvisionAttempts: ints["WORKER_PROVISION_ATTEMPTS"],
		TeardownAttempts:  ints["WORKER_TEARDOWN_ATTEMPTS"],
		PowerAttempts:     ints["WORKER_POWER_ATTEMPTS"],
		SetupAttempts:     ints["WORKER_SETUP_ATTEMPTS"],
		BootTimeout:       time.Duration(ints["WORKER_BOOT_TIMEOUT_MS"]) * time.Millisecond,
		ReadyTimeout:      time.Duration(ints["WORKER_READY_TIMEOUT_MS"]) * time.Millisecond,
		IPv6Prefix:        os.Getenv("IPV6_PREFIX"),
		Env:               envOr("WORKER_ENV", "prod"),
		BaseDomain:        os.Getenv("WORKER_BASE_DOMAIN"),
		// Route files live in the checkout: the worker's cwd is the repo root.
		RoutesDir: filepath.Join(cwd, "infra", "traefik", "routes"),
	}

	poolCfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return fmt.Errorf("DATABASE_URL: %w", err)
	}
	poolCfg.MaxConns = 4
	db, err := pgxpool.NewWithConfig(context.Background(), poolCfg)
	if err != nil {
		return err
	}
	defer db.Close()

	instances, err := incus.Connect()
	if err != nil {
		return err
	}
	var dns worker.DNS
	if token := os.Getenv("CF_DNS_API_TOKEN"); token != "" {
		dns = worker.NewCloudflare(token)
	}

	w := worker.New(cfg, db, instances, dns, logger)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		w.Shutdown()
	}()
	return w.Run()
}
