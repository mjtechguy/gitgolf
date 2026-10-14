package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

var (
	errCancelled   = errors.New("cancelled in Golf")
	errTimedOut    = errors.New("task deadline passed")
	errHostStopped = errors.New("host stopped")
	// errTaskGone: Golf no longer accepts the task token (401 after the deadline, 409
	// once the task finished elsewhere, 403 when it was taken away). The host stops and
	// cleans up without a finish, which Golf would refuse.
	errTaskGone = errors.New("Golf no longer accepts this task")
)

type timings struct {
	heartbeat time.Duration // contract: 15 s
	claim     time.Duration // claim poll while below maxConcurrent
	detect    time.Duration // tool re-detection
	log       time.Duration // log flush cadence (contract: about 1 s)
	killGrace time.Duration // SIGTERM → SIGKILL
	tick      time.Duration
}

var defaultTimings = timings{heartbeat: 15 * time.Second, claim: 5 * time.Second, detect: 5 * time.Minute,
	log: time.Second, killGrace: 5 * time.Second, tick: time.Second}

type host struct {
	file     hostFile
	cfg      config
	state    string
	workRoot string
	api      *apiClient
	out      io.Writer
	baseEnv  []string
	t        timings

	outMu     sync.Mutex
	mu        sync.Mutex
	running   map[string]context.CancelCauseFunc
	tools     []toolReport
	detecting bool
	tasks     sync.WaitGroup
}

func newHost(h hostFile, c config, state string, out io.Writer) (*host, error) {
	work := c.WorkRoot
	if work == "" {
		work = filepath.Join(state, "work")
	}
	if err := privateDirectory(work); err != nil {
		return nil, err
	}
	return &host{file: h, cfg: c, state: state, workRoot: work, api: newAPIClient(h.Origin, h.Credential), out: out,
		baseEnv: environ(), t: defaultTimings, running: map[string]context.CancelCauseFunc{}}, nil
}

func (h *host) logf(format string, args ...any) {
	h.outMu.Lock()
	defer h.outMu.Unlock()
	fmt.Fprintf(h.out, "%s %s\n", time.Now().UTC().Format(time.RFC3339), redact(fmt.Sprintf(format, args...), []string{h.file.Credential}))
}

// scrubbedEnv is the environment for tools and detection probes.
func (h *host) scrubbedEnv(secrets []string, extra ...string) []string {
	return toolEnvironment(h.baseEnv, append([]string{h.file.Credential}, secrets...), extra...)
}

func (h *host) detect(ctx context.Context) {
	reports := detectTools(ctx, h.cfg, h.scrubbedEnv(nil), h.workRoot, func(note string) { h.logf("%s", note) })
	h.mu.Lock()
	h.tools, h.detecting = reports, false
	h.mu.Unlock()
}

func (h *host) currentTools() []toolReport {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]toolReport{}, h.tools...)
}

func (h *host) activeCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.running)
}

func (h *host) cancelTask(id string, cause error) {
	h.mu.Lock()
	cancel := h.running[id]
	h.mu.Unlock()
	if cancel != nil {
		cancel(cause)
	}
}

// run is the host loop: heartbeat every 15 s, claim while below maxConcurrent, run each
// task in its own goroutine. It returns when ctx ends (after stopping running tasks) or
// when Golf rejects the host credential.
func (h *host) run(ctx context.Context) error {
	lock, err := os.OpenFile(filepath.Join(h.state, "host.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return errors.New("another golf-agent-host run is using this state directory")
	}
	if !h.cfg.KeepWork {
		entries, _ := os.ReadDir(h.workRoot)
		for _, e := range entries {
			if uuidPattern.MatchString(e.Name()) {
				_ = os.RemoveAll(filepath.Join(h.workRoot, e.Name()))
			}
		}
	}
	h.logf("host %s (%s) starting against %s; max %d concurrent task(s)", h.file.Name, h.file.UUID, h.file.Origin, h.cfg.MaxConcurrent)
	h.detecting = true
	h.detect(ctx)
	for _, t := range h.currentTools() {
		signed := "unknown"
		if t.SignedIn != nil {
			signed = fmt.Sprint(*t.SignedIn)
		}
		h.logf("tool %s %s, signed in: %s", t.Tool, t.Version, signed)
	}

	taskCtx, stopTasks := context.WithCancelCause(context.Background())
	defer stopTasks(errHostStopped)
	var (
		now           = time.Now()
		nextHeartbeat = now
		nextClaim     = now
		nextDetect    = now.Add(h.t.detect)
		claimBackoff  = h.t.claim
		hostState     = "ACTIVE"
		claimID       string
		fatal         error
	)
	ticker := time.NewTicker(h.t.tick)
	defer ticker.Stop()
	for fatal == nil {
		now = time.Now()
		if !now.Before(nextHeartbeat) {
			resp, err := h.heartbeat(ctx)
			switch {
			case err == nil:
				nextHeartbeat = now.Add(h.t.heartbeat)
				if resp.State != "" && resp.State != hostState {
					h.logf("host state %s", resp.State)
					hostState = resp.State
				}
				for _, id := range resp.Cancel {
					h.cancelTask(id, errCancelled)
				}
			case statusOf(err) == http.StatusUnauthorized:
				fatal = errors.New("Golf rejected the host credential (deleted or rotated); register again")
			default:
				h.logf("heartbeat failed: %v", err)
				nextHeartbeat = now.Add(5 * time.Second)
			}
		}
		if !now.Before(nextDetect) {
			nextDetect = now.Add(h.t.detect)
			h.mu.Lock()
			if !h.detecting {
				h.detecting = true
				go h.detect(ctx)
			}
			h.mu.Unlock()
		}
		if fatal == nil && hostState == "ACTIVE" && h.activeCount() < h.cfg.MaxConcurrent && !now.Before(nextClaim) && ctx.Err() == nil {
			if claimID == "" {
				claimID = newUUID()
			}
			task, err := h.claim(ctx, claimID)
			switch {
			case err == nil:
				// A response arrived; the next claim is a new one.
				claimID, claimBackoff = "", h.t.claim
				if task == nil {
					nextClaim = now.Add(h.t.claim)
					break
				}
				nextClaim = now
				h.startTask(taskCtx, *task)
			case statusOf(err) == http.StatusUnauthorized:
				fatal = errors.New("Golf rejected the host credential (deleted or rotated); register again")
			case statusOf(err) == http.StatusForbidden:
				// Disabled host: stop claiming until a heartbeat reports ACTIVE again.
				claimID = ""
				hostState = "DISABLED"
				h.logf("claim refused: %v", err)
			default:
				// Keep the claimId: a retried claim returns the same task.
				h.logf("claim failed: %v", err)
				nextClaim = now.Add(claimBackoff)
				claimBackoff = min(claimBackoff*2, time.Minute)
			}
		}
		select {
		case <-ctx.Done():
			fatal = errHostStopped
		case <-ticker.C:
		}
	}
	stopTasks(errHostStopped)
	h.tasks.Wait()
	h.logf("host stopped")
	if fatal == errHostStopped {
		return nil
	}
	return fatal
}

func (h *host) heartbeat(ctx context.Context) (heartbeatResponse, error) {
	var resp heartbeatResponse
	tools := h.currentTools()
	if len(tools) > 8 {
		tools = tools[:8]
	}
	if tools == nil {
		tools = []toolReport{}
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	err := h.api.post(cctx, "/native/agent-host/heartbeat", "", map[string]any{"tools": tools}, &resp)
	return resp, err
}

func (h *host) claim(ctx context.Context, claimID string) (*claimedTask, error) {
	var resp struct {
		Task *claimedTask `json:"task"`
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := h.api.post(cctx, "/native/agent-host/claim", "", map[string]string{"claimId": claimID}, &resp); err != nil {
		return nil, err
	}
	return resp.Task, nil
}

func (h *host) startTask(parent context.Context, t claimedTask) {
	ctx, cancel := context.WithCancelCause(parent)
	h.mu.Lock()
	if h.running[t.ID] != nil {
		// A claim is retried only when no answer arrived, so this cannot be a task the
		// host already started; refuse to run one task twice regardless.
		h.mu.Unlock()
		cancel(nil)
		h.logf("task %s: already running here; ignoring the duplicate claim", t.ID)
		return
	}
	h.running[t.ID] = cancel
	h.mu.Unlock()
	h.tasks.Add(1)
	go func() {
		defer h.tasks.Done()
		defer func() {
			h.mu.Lock()
			delete(h.running, t.ID)
			h.mu.Unlock()
			cancel(nil)
		}()
		h.runTask(ctx, t)
	}()
}
