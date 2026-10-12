package worker

import (
	"encoding/json"
	"time"
)

// phaseTimer splits one job attempt into named phases for the internal
// provisioning benchmark: finishJob stores them in provision_jobs.timings and
// scripts/provision-bench.ts reports them. A nil timer records nothing.
type phaseTimer struct {
	queuedMs int64
	started  time.Time
	last     time.Time
	phases   []phaseTiming
}

type phaseTiming struct {
	Name string `json:"name"`
	Ms   int64  `json:"ms"`
}

type jobTimings struct {
	Attempt  int           `json:"attempt"`
	QueuedMs int64         `json:"queued_ms"`
	TotalMs  int64         `json:"total_ms"`
	Phases   []phaseTiming `json:"phases"`
}

func newPhaseTimer(queued time.Duration) *phaseTimer {
	now := time.Now()
	return &phaseTimer{queuedMs: queued.Milliseconds(), started: now, last: now}
}

// mark closes the phase that began at the previous mark (or at the lease).
func (t *phaseTimer) mark(name string) {
	if t == nil {
		return
	}
	now := time.Now()
	t.phases = append(t.phases, phaseTiming{Name: name, Ms: now.Sub(t.last).Milliseconds()})
	t.last = now
}

// add records a duration measured inside a phase (one readiness check of a
// gate) without moving the mark.
func (t *phaseTimer) add(name string, d time.Duration) {
	if t == nil {
		return
	}
	t.phases = append(t.phases, phaseTiming{Name: name, Ms: d.Milliseconds()})
}

// json is the provision_jobs.timings value: nil (SQL NULL) without a timer.
func (t *phaseTimer) json(attempt int) ([]byte, error) {
	if t == nil {
		return nil, nil
	}
	return json.Marshal(jobTimings{
		Attempt:  attempt,
		QueuedMs: t.queuedMs,
		TotalMs:  time.Since(t.started).Milliseconds(),
		Phases:   t.phases,
	})
}
