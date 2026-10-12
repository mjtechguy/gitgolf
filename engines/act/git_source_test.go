package actionsengine

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"github.com/nektos/act/pkg/common"
	"github.com/nektos/act/pkg/model"
	act "github.com/nektos/act/pkg/runner"
)

func nativeGitEnvelope(t *testing.T, format string) (protocol.ActionExecutionInput, []byte, map[string][]byte) {
	t.Helper()
	if _, err := os.Stat("/usr/bin/git"); err != nil {
		t.Skip("trusted installed Git unavailable")
	}
	repository := t.TempDir()
	git := func(dir string, input []byte, args ...string) []byte {
		t.Helper()
		command := exec.Command("/usr/bin/git", args...)
		command.Dir = dir
		command.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + dir, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid"}
		command.Stdin = bytes.NewReader(input)
		data, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("native Git %v: %v %s", args, err, data)
		}
		return data
	}
	source := map[string][]byte{"workflow.yml": []byte("name: Native Git\non: workflow_dispatch\njobs:\n  check:\n    runs-on: linux\n    steps:\n      - run: git status --porcelain\n"), "README.md": []byte("exact admitted bytes\n")}
	git(repository, nil, "init", "--quiet", "--template=", "--object-format="+format, ".")
	for name, body := range source {
		if err := os.WriteFile(filepath.Join(repository, name), body, 0644); err != nil {
			t.Fatal(err)
		}
	}
	git(repository, nil, "add", ".")
	git(repository, nil, "commit", "-qm", "root")
	source["README.md"] = []byte("exact admitted child bytes\n")
	os.WriteFile(filepath.Join(repository, "README.md"), source["README.md"], 0644)
	git(repository, nil, "add", "README.md")
	git(repository, nil, "commit", "-qm", "child")
	trim := func(args ...string) string { return strings.TrimSpace(string(git(repository, nil, args...))) }
	h := trim("rev-parse", "HEAD")
	tree := trim("rev-parse", "HEAD^{tree}")
	blob := trim("rev-parse", "HEAD:workflow.yml")
	readme := trim("rev-parse", "HEAD:README.md")
	pack := git(repository, []byte(strings.Join([]string{h, tree, blob, readme}, "\n")+"\n"), "pack-objects", "--stdout")
	prepared := t.TempDir()
	git(prepared, nil, "init", "--quiet", "--template=", "--object-format="+format, ".")
	os.WriteFile(filepath.Join(prepared, ".git", "shallow"), []byte(h+"\n"), 0600)
	receipt := string(git(prepared, pack, "index-pack", "--stdin", "--strict", "--threads=1", "--no-rev-index", "--index-version=2"))
	packID := strings.TrimSuffix(strings.TrimPrefix(receipt, "pack\t"), "\n")
	git(prepared, nil, "update-ref", "--no-deref", "HEAD", h)
	var metadata bytes.Buffer
	writer := tar.NewWriter(&metadata)
	for _, name := range []string{".git/HEAD", ".git/shallow", ".git/objects/pack/pack-" + packID + ".pack", ".git/objects/pack/pack-" + packID + ".idx"} {
		data, err := os.ReadFile(filepath.Join(prepared, name))
		if err != nil {
			t.Fatal(err)
		}
		writer.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0444, Size: int64(len(data))})
		writer.Write(data)
	}
	writer.Close()
	var archive bytes.Buffer
	writer = tar.NewWriter(&archive)
	for _, name := range []string{"README.md", "workflow.yml"} {
		body := source[name]
		writer.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0644, Size: int64(len(body))})
		writer.Write(body)
	}
	writer.Close()
	digest := sha256.Sum256(archive.Bytes())
	m, err := protocol.NewGitSourceManifest(protocol.GitPreparationResult{TreeID: tree, Listing: git(prepared, nil, "ls-tree", "-rz", "--full-tree", h), Metadata: metadata.Bytes()}, archive.Bytes(), hex.EncodeToString(digest[:]), h, "workflow.yml", blob)
	if err != nil {
		t.Fatal(err)
	}
	in := protocol.ActionPlanInput{Catalog: protocol.ActionsCatalog, WorkflowPath: "workflow.yml", WorkflowBlobID: blob, Archive: archive.Bytes(), Event: "workflow_dispatch", Ref: h, Images: map[string]string{"linux": "alpine@sha256:" + strings.Repeat("b", 64)}}
	plan, err := Plan(in)
	if err != nil {
		t.Fatal(err)
	}
	binding := &protocol.JobResourceBinding{Profile: protocol.JobLimitsProfile, Limits: protocol.DefaultJobLimits(), Bound: true, InstanceVersion: "0", PlacementVersion: "0"}
	return protocol.ActionExecutionInput{GitSource: m, Input: in, Plan: plan, CommitID: h, JobResources: binding, TimeoutSeconds: 900}, metadata.Bytes(), source
}

// Actual installed Git behind a controlled CLI is a source consumer check,
// not proof of a native Docker image, daemon, UID or resource quota.
func gitConsumerDocker(t *testing.T, mode string, source map[string][]byte) (string, string) {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 fixture unavailable")
	}
	directory := t.TempDir()
	job := filepath.Join(directory, "job")
	os.Mkdir(job, 0700)
	for name, body := range source {
		os.WriteFile(filepath.Join(job, name), body, 0644)
	}
	log := filepath.Join(directory, "calls")
	data, _ := json.Marshal(map[string]string{"mode": mode, "job": job, "log": log})
	literal, _ := json.Marshal(string(data))
	script := `#!` + python + `
import sys,json,os,subprocess,tarfile,io,time
c=json.loads(` + string(literal) + `)
a=sys.argv[1:]
with open(c['log'],'a') as f: f.write(json.dumps(a)+'\n')
if a[0]=='cp':
 if c['mode']=='copyfail': sys.exit(1)
 with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:') as archive:
  for member in archive:
   if not member.isfile() or not member.name.startswith('.git/') or '..' in member.name.split('/'): sys.exit(2)
   dest=os.path.join(c['job'],member.name);os.makedirs(os.path.dirname(dest),exist_ok=True)
   with open(dest,'wb') as f: f.write(archive.extractfile(member).read())
   os.chmod(dest,member.mode)
elif a[0]=='exec':
 if c['mode']=='cancel': time.sleep(60)
 pos=a.index('c'*64)+1
 command=a[pos:]
 if c['mode']=='nogit' and '/usr/bin/git' in command: sys.exit(127)
 if '/bin/tar' in command and '-xf' in command:
  if c['mode']=='copyfail': sys.exit(1)
  command[command.index('-C')+1]=c['job']
 with open(c['log']+'.stderr','ab') as errors:
  sys.exit(subprocess.call(command,cwd=c['job'],stdin=sys.stdin.buffer,stdout=sys.stdout.buffer,stderr=errors))
else: sys.exit(3)
`
	os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700)
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	return job, log
}
func readGitFixture(t *testing.T, in protocol.ActionExecutionInput, metadata []byte) *engineGitSource {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "git-source.tar"), metadata, 0600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	s, err := readEngineGitSource(root, in)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestGitSourceEngineNativeMaterialization(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			in, metadata, source := nativeGitEnvelope(t, format)
			s := readGitFixture(t, in, metadata)
			job, log := gitConsumerDocker(t, "", source)
			trace := filepath.Join(t.TempDir(), "ambient-trace")
			t.Setenv("GIT_TRACE", trace)
			t.Setenv("GIT_CONFIG_COUNT", "1")
			t.Setenv("GIT_CONFIG_KEY_0", "core.hooksPath")
			t.Setenv("GIT_CONFIG_VALUE_0", "/untrusted-hooks")
			t.Setenv("GOLF_PRIVATE_CONTROLLER_KEY", "test-key-not-forwarded")
			id := strings.Repeat("c", 64)
			if err := s.transfer(t.Context(), id); err != nil {
				t.Fatal(err)
			}
			if err := s.verifyJob(t.Context(), id); err != nil {
				calls, _ := os.ReadFile(log)
				stderr, _ := os.ReadFile(log + ".stderr")
				t.Fatalf("native verification: %v calls=%s stderr=%s", err, calls, stderr)
			}
			config, err := os.ReadFile(filepath.Join(job, ".git", "config"))
			if err != nil || bytes.Contains(config, []byte("remote")) || bytes.Contains(config, []byte("credential")) {
				t.Fatal("nonfixed config or missing metadata")
			}
			if _, err = os.Stat(filepath.Join(job, ".git", "index")); err != nil {
				t.Fatal("native index not created")
			}
			for name, want := range source {
				got, err := os.ReadFile(filepath.Join(job, name))
				if err != nil || !bytes.Equal(got, want) {
					t.Fatal("materialization changed original working bytes")
				}
			}
			if _, err = os.Stat(trace); !os.IsNotExist(err) {
				t.Fatal("ambient trace config reached Git")
			}
			calls, _ := os.ReadFile(log)
			if bytes.Contains(calls, []byte("test-key-not-forwarded")) || bytes.Contains(calls, []byte("checkout")) {
				t.Fatal("credential or checkout entered trusted preparation")
			}
		})
	}
}

func TestGitSourceEngineNativeRefusals(t *testing.T) {
	original, metadata, source := nativeGitEnvelope(t, "sha1")
	for _, mode := range []string{"tree", "workflow", "source", "nogit", "copyfail", "cancel", "existing", "symlink"} {
		t.Run(mode, func(t *testing.T) {
			in := original
			manifest := *original.GitSource
			in.GitSource = &manifest
			s := readGitFixture(t, in, metadata)
			job, log := gitConsumerDocker(t, mode, source)
			if mode == "existing" {
				os.Mkdir(filepath.Join(job, ".git"), 0700)
			}
			if mode == "symlink" {
				os.Symlink(filepath.Join(t.TempDir(), "foreign"), filepath.Join(job, ".git"))
			}
			if mode == "tree" {
				s.manifest.TreeID = strings.Repeat("0", 40)
			}
			if mode == "workflow" {
				s.manifest.WorkflowBlobID = s.manifest.CommitID
			}
			if mode == "source" {
				os.WriteFile(filepath.Join(job, "README.md"), []byte("changed working tree\n"), 0644)
			}
			ctx := context.Background()
			var cancel context.CancelFunc
			if mode == "cancel" {
				ctx, cancel = context.WithTimeout(ctx, 100*time.Millisecond)
				defer cancel()
			}
			err := s.transfer(ctx, strings.Repeat("c", 64))
			if err == nil {
				err = s.verifyJob(ctx, strings.Repeat("c", 64))
			}
			if !errors.Is(err, ErrExecution) {
				t.Fatalf("native refusal missing %s: %v", mode, err)
			}

			calls, _ := os.ReadFile(log)
			expected := map[string]string{"tree": "^{tree}", "workflow": ":workflow.yml", "source": "status", "nogit": "rev-parse"}[mode]
			if expected != "" && !bytes.Contains(calls, []byte(expected)) {
				t.Fatal("negative did not reach intended native identity boundary")
			}
			if mode == "copyfail" && bytes.Contains(calls, []byte("/usr/bin/git")) {
				t.Fatal("copy failure proceeded to native Git")
			}
			if (mode == "existing" || mode == "symlink") && bytes.Contains(calls, []byte(`"cp"`)) {
				t.Fatal("metadata merged into preexisting .git")
			}
			if mode == "cancel" && ctx.Err() == nil {
				t.Fatal("cancellation was not exercised")
			}
		})
	}
}

func TestGitSourceEngineFixedFileAndLegacyBoundary(t *testing.T) {
	in, metadata, _ := nativeGitEnvelope(t, "sha1")
	if s, err := loadEngineGitSource(protocol.ActionExecutionInput{}); err != nil || s != nil {
		t.Fatal("legacy nil changed")
	}
	for _, mode := range []string{"missing", "symlink", "oversize", "changed", "binding", "manifest", "archive"} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			root, err := os.OpenRoot(directory)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			p := filepath.Join(directory, "git-source.tar")
			changed := in
			manifest := *in.GitSource
			changed.GitSource = &manifest
			switch mode {
			case "missing":
			case "symlink":
				target := filepath.Join(t.TempDir(), "foreign")
				os.WriteFile(target, metadata, 0600)
				os.Symlink(target, p)
			case "oversize":
				file, _ := os.Create(p)
				file.Truncate(protocol.GitSourceMetadataLimit + 1)
				file.Close()
			default:
				body := metadata
				if mode == "changed" {
					body = append(append([]byte(nil), metadata...), byte(1))
				}
				os.WriteFile(p, body, 0600)
			}
			if mode == "binding" {
				changed.JobResources = nil
			}
			if mode == "manifest" {
				changed.GitSource.Profile = "other"
			}
			if mode == "archive" {
				changed.Plan.ArchiveSHA256 = strings.Repeat("0", 64)
			}
			if _, err = readEngineGitSource(root, changed); !errors.Is(err, ErrExecution) {
				t.Fatalf("invalid fixed file %s accepted", mode)
			}
		})
	}
}

func TestGitSourceEngineTransferFailureWithholdsSetupAck(t *testing.T) {
	in, metadata, _ := nativeGitEnvelope(t, "sha1")
	s := readGitFixture(t, in, metadata)
	directory := t.TempDir()
	var rows []inspected
	if json.Unmarshal([]byte(diagnosticJobReceipt(t, "")), &rows) != nil {
		t.Fatal("fixture")
	}
	rows[0].HostConfig.ReadonlyRootfs = true
	rows[0].HostConfig.Tmpfs = map[string]string{"/tmp": jobTemporaryTmpfs}
	raw, _ := json.Marshal(rows)
	receipt := string(raw)
	volumes := map[string]any{}
	for _, mount := range rows[0].Mounts {
		name := filepath.Base(filepath.Dir(mount.Source))
		volumes[name] = []map[string]any{{"Name": name, "Driver": "local", "Scope": "local", "Mountpoint": mount.Source, "Options": jobVolumeOptions(mount.Destination), "Labels": map[string]string{"io.golf.actions.job-disk": jobDiskProfile}}}
	}
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	script := "#!/bin/sh\ncase \"$1\" in ps) printf '%s' '" + strings.Repeat("a", 64) + "';; inspect) printf '%s' " + quote(receipt) + ";; exec) exit 0;; cp) if [ \"$2\" = '-' ]; then exit 9; fi;; *) exit 9;; esac\n"
	volumeScript := ""
	for name, row := range volumes {
		value, _ := json.Marshal(row)
		volumeScript += name + ") printf '%s' " + quote(string(value)) + ";;"
	}
	script = strings.Replace(script, "case \"$1\" in ", "case \"$1\" in volume) case \"$3\" in "+volumeScript+" *) exit 9;; esac;; ", 1)
	os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700)
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	o := testObserver(t, func(protocol.ActionFrame) error { t.Fatal("metadata failure authorized progress"); return nil })
	o.gitSource = s
	o.started = map[string]bool{}
	o.resolved = map[string]string{"linux": "sha256:" + strings.Repeat("b", 64)}
	ctx := act.WithJobLoggerFactory(o.ctx, o)
	ctx = act.WithJobLogger(ctx, "check", "check", &act.Config{}, new([]string), map[string]interface{}{})
	native := common.NewFieldExecutor("stepid", []string{"--setup-job"}, common.NewFieldExecutor("stepResult", model.StepStatusSuccess, common.NewInfoExecutor("Success - Set up job")))
	if err := native(ctx); err != nil {
		t.Fatal(err)
	}
	if ExecutionFailureStage(o.err) != "engine_job_source_transfer" || o.ctx.Err() == nil || len(o.started) != 0 || len(o.prepared) != 0 {
		t.Fatal("metadata failure escaped source/setup barrier")
	}
}
