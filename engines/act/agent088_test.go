package actionsengine

import (
	"errors"
	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"github.com/sirupsen/logrus"
	"strings"
	"testing"
)

const agentWorkflow088 = `name: Agent workflow
on: workflow_dispatch
jobs:
  check:
    runs-on: linux
    steps:
      - id: first
        run: echo before
      - id: advice
        uses: golf/agent@v1
        with:
          prompt: Inspect the original snapshot and propose a small improvement.
      - id: after
        run: echo after
`

func TestAgent088NativePlanAndTrustedProducer(t *testing.T) {
	in := testInput(t, agentWorkflow088, nil)
	in.Catalog = protocol.ActionsAgentCatalog
	plan, native, _, e := admit(in)
	if e != nil {
		t.Fatal(e)
	}
	if plan.Jobs[0].Steps[1].AgentPrompt == "" || plan.Catalog != protocol.ActionsAgentCatalog {
		t.Fatal("real source agent step absent")
	}
	prepareNativeAgentSteps(native)
	step := native.Stages[0].Runs[0].Job().Steps[1]
	if step.Uses != "" || step.With != nil || step.Run != "true" {
		t.Fatal("provider credentials could reach native job action")
	}
	for _, catalog := range []string{protocol.ActionsCatalog, protocol.ActionsInputsCatalog} {
		copy := in
		copy.Catalog = catalog
		if _, e := Plan(copy); e == nil {
			t.Fatal("old catalog gained agent authority")
		}
	}
	for _, mutate := range []string{strings.Replace(agentWorkflow088, "golf/agent@v1", "golf/agent@main", 1), strings.Replace(agentWorkflow088, "Inspect the original snapshot and propose a small improvement.", "${{ secrets.PROVIDER }}", 1), strings.Replace(agentWorkflow088, "prompt: Inspect", "connection: secret-account\n          prompt: Inspect", 1)} {
		copy := testInput(t, mutate, nil)
		copy.Catalog = protocol.ActionsAgentCatalog
		if _, e := Plan(copy); e == nil {
			t.Fatal("unsupported dynamic/provider override admitted")
		}
	}
	var frames []protocol.ActionFrame
	o := testObserver(t, func(f protocol.ActionFrame) error { frames = append(frames, f); return nil })
	o.plan.Catalog = protocol.ActionsAgentCatalog
	o.plan.Jobs[0].Steps[0].AgentPrompt = "Inspect"
	o.Fire(nativeEntry("⭐ Run Main first", logrus.Fields{"raw_output": true}))
	if len(frames) != 1 || frames[0].Kind != "log" {
		t.Fatal("source stdout requested managed agent")
	}
	o.Fire(nativeEntry("⭐ Run Main first", logrus.Fields{}))
	if len(frames) != 3 || frames[1].Kind != "step_started" || frames[2].Kind != "agent_requested" || frames[2].EventSequence != 0 || frames[2].Text != "" {
		t.Fatal("native producer did not block on exact step child")
	}
	refused := testObserver(t, func(f protocol.ActionFrame) error {
		if f.Kind == "agent_requested" {
			return errors.New("original child authority revoked")
		}
		return nil
	})
	refused.plan.Catalog = protocol.ActionsAgentCatalog
	refused.plan.Jobs[0].Steps[0].AgentPrompt = "Inspect"
	refused.Fire(nativeEntry("⭐ Run Main first", logrus.Fields{}))
	if refused.err == nil || refused.ctx.Err() == nil || refused.finished[strings.Repeat("a", 32)] {
		t.Fatal("failed child acknowledged native success")
	}
}
