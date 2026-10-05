package runner

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func nativePreparationFixture(t *testing.T, format string, root ...bool) (GitPreparation, string) {
	t.Helper()
	if _, err := os.Stat("/usr/bin/git"); err != nil {
		t.Skip("installed trusted Git unavailable")
	}
	directory := t.TempDir()
	run := func(input []byte, args ...string) []byte {
		t.Helper()
		command := exec.Command("/usr/bin/git", args...)
		command.Dir = directory
		command.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + directory, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid"}
		command.Stdin = bytes.NewReader(input)
		data, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("native Git %v: %v %s", args, err, data)
		}
		return data
	}
	run(nil, "init", "--quiet", "--template=", "--object-format="+format, ".")
	if err := os.WriteFile(filepath.Join(directory, "workflow.yml"), []byte("name: controlled\n"), 0600); err != nil {
		t.Fatal(err)
	}
	run(nil, "add", "workflow.yml")
	run(nil, "commit", "-qm", "parent")
	if err := os.WriteFile(filepath.Join(directory, "README.md"), []byte("controlled source\n"), 0600); err != nil {
		t.Fatal(err)
	}
	run(nil, "add", "README.md")
	run(nil, "commit", "-qm", "exact source")
	trim := func(args ...string) string { return strings.TrimSpace(string(run(nil, args...))) }
	h := trim("rev-parse", "HEAD")
	tree := trim("rev-parse", "HEAD^{tree}")
	if len(root) > 0 && root[0] {
		h = strings.TrimSpace(string(run([]byte("controlled root\n"), "commit-tree", tree)))
	}
	workflow := trim("rev-parse", "HEAD:workflow.yml")
	readme := trim("rev-parse", "HEAD:README.md")
	objects := []string{h, tree, workflow, readme}
	if len(root) > 1 && root[1] {
		objects = append(objects, strings.TrimSpace(string(run([]byte("unreachable private blob\n"), "hash-object", "-w", "--stdin"))))
	}
	pack := run([]byte(strings.Join(objects, "\n")+"\n"), "pack-objects", "--stdout")
	binding := &JobResourceBinding{Profile: JobLimitsProfile, Limits: DefaultJobLimits(), Bound: true, InstanceVersion: "0", PlacementVersion: "0"}
	return GitPreparation{AttemptID: strings.Repeat("a", 32), ImageDigest: "sha256:" + strings.Repeat("b", 64), CommitID: h, WorkflowPath: "workflow.yml", WorkflowBlobID: workflow, Pack: pack, JobResources: binding}, tree
}

// This harness executes actual installed Git and tar in a private directory,
// while Docker lifecycle and inspect are controlled. It is not a Docker proof.
func preparationDocker(t *testing.T, mode string) (string, string) {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 fixture unavailable")
	}
	directory := t.TempDir()
	log := filepath.Join(directory, "calls.jsonl")
	script := filepath.Join(directory, "docker")
	workspace := filepath.Join(directory, "workspace")
	if err = os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]string{"mode": mode, "dir": directory, "log": log, "workspace": workspace, "arch": runtime.GOARCH})
	source := `#!` + python + `
import sys,os,json,subprocess
c=json.loads(` + strconvPython(string(config)) + `)
a=sys.argv[1:]
with open(c['log'],'a') as f: f.write(json.dumps(a)+'\n')
cid='c'*64
state=os.path.join(c['dir'],'state.json')
if a[:2] in [['container','ls'],['volume','ls']]: sys.exit(0)
if a[:2]==['image','inspect']:
 print(json.dumps([{'ID':'sha256:'+'b'*64,'Os':'linux','Architecture':c['arch'],'Config':{'Volumes':{}}}]))
elif a[:2]==['container','create']:
 labels={a[i+1].split('=',1)[0]:a[i+1].split('=',1)[1] for i in range(len(a)-1) if a[i]=='--label'}
 options={v.split('=',1)[0]:v.split('=',1)[1] for v in a if '=' in v}
 row={'Id':cid,'Image':'sha256:'+'b'*64,'Config':{'Labels':labels,'User':'1000:1000','WorkingDir':'/workspace','Entrypoint':['/usr/bin/env'],'Cmd':['-i','PATH=/usr/bin:/bin','HOME=/tmp','/bin/sh','-c','while :; do sleep 3600; done']},'State':{'Running':True},'HostConfig':{'NetworkMode':'none','Privileged':False,'ReadonlyRootfs':True,'Memory':int(options['--memory']),'MemorySwap':int(options['--memory-swap']),'NanoCpus':int(float(options['--cpus'])*1000000000),'PidsLimit':int(options['--pids-limit']),'CapAdd':[],'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],'Binds':[],'Devices':[],'PortBindings':{},'Tmpfs':dict(a[i+1].split(':',1) for i in range(len(a)-1) if a[i]=='--tmpfs'),'Init':True,'RestartPolicy':{'Name':'no'},'LogConfig':{'Type':'none'}},'Mounts':[]}
 if c['mode']=='unsafe': row['HostConfig']['NetworkMode']='host'
 if c['mode']=='owner': row['Config']['Labels']['io.golf.runner.owner']='wrong'
 with open(state,'w') as f: json.dump(row,f)
 with open(os.path.join(c['dir'],'inspect.json'),'w') as f: json.dump(row,f)
 print(cid)
elif a[:2]==['container','inspect']:
 with open(state) as f: print(json.dumps([json.load(f)]))
elif a[:2]==['container','rm']:
 if c['mode']=='cleanup': sys.exit(1)
 os.remove(state)
elif a[:2]==['container','start']: print(cid)
elif a[:2]==['container','exec']:
 if c['mode']=='execfail': sys.exit(1)
 if c['mode']=='cancel':
  import time
  time.sleep(60)
 pos=a.index(cid)+1
 command=a[pos:]
 if command[:2]!=['/usr/bin/env','-i']: sys.exit(2)
 if '/bin/tar' in command and not os.path.exists('/bin/tar'):
  i=command.index('/bin/tar'); command[i]='/usr/bin/tar'; command.insert(i+1,'--format=ustar')
 with open(c['log']+'.stderr','ab') as errors:
  sys.exit(subprocess.call(command,cwd=c['workspace'],stdin=sys.stdin.buffer,stdout=sys.stdout.buffer,stderr=errors))
else: sys.exit(3)
`
	if err = os.WriteFile(script, []byte(source), 0700); err != nil {
		t.Fatal(err)
	}
	return script, log
}
func strconvPython(value string) string { data, _ := json.Marshal(value); return string(data) }

func TestGitPreparationNativeConsumer(t *testing.T) {
	trace := filepath.Join(t.TempDir(), "ambient-trace")
	t.Setenv("GIT_TRACE", trace)
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "core.hooksPath")
	t.Setenv("GIT_CONFIG_VALUE_0", "/untrusted-hooks")
	t.Setenv("GOLF_CONTROLLER_SECRET", "fixture-secret-never-forward")
	for _, format := range []string{"sha1", "sha256", "sha1-root", "sha256-root"} {
		t.Run(format, func(t *testing.T) {
			p, tree := nativePreparationFixture(t, strings.TrimSuffix(format, "-root"), strings.HasSuffix(format, "-root"))
			docker, log := preparationDocker(t, "")
			e, err := New(Config{WorkerID: "worker", DockerBinary: docker, ApprovedImages: []string{p.ImageDigest}})
			if err != nil {
				calls, _ := os.ReadFile(log)
				diagnostic, _ := os.ReadFile(log + ".stderr")
				t.Fatalf("%v calls=%s stderr=%s", err, calls, diagnostic)
			}
			result, err := e.PrepareGit(context.Background(), p)
			if err != nil {
				calls, _ := os.ReadFile(log)
				diagnostic, _ := os.ReadFile(log + ".stderr")
				t.Fatalf("%v calls=%s stderr=%s", err, calls, diagnostic)
			}
			if result.TreeID != tree || !bytes.Contains(result.Listing, []byte(p.WorkflowBlobID)) || len(result.Metadata) == 0 {
				t.Fatalf("wrong source result %+v", result)
			}
			id, err := gitPackIdentity(p.Pack, p.CommitID)
			if err != nil {
				t.Fatal(err)
			}
			normalized, err := normalizeGitMetadata(result.Metadata, p.Pack, p.CommitID, id)
			if err != nil || !bytes.Equal(normalized, result.Metadata) {
				t.Fatal("metadata was not canonical")
			}
			calls, err := os.ReadFile(log)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(calls, []byte("fixture-secret-never-forward")) || bytes.Contains(result.Metadata, []byte("fixture-secret-never-forward")) {
				t.Fatal("ambient credential reached sandbox or metadata")
			}
			if _, err := os.Stat(trace); !os.IsNotExist(err) {
				t.Fatal("ambient Git tracing was used")
			}
			if !bytes.Contains(calls, []byte("--network=none")) || !bytes.Contains(calls, []byte("--no-rev-index")) || !bytes.Contains(calls, []byte(`"--force"`)) {
				t.Fatal("missing isolation/index/cleanup operations")
			}
		})
	}
}

func TestGitPreparationFailsClosed(t *testing.T) {
	p, _ := nativePreparationFixture(t, "sha1")
	for _, mode := range []string{"unsafe", "owner", "cleanup", "execfail", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			docker, log := preparationDocker(t, mode)
			e, _ := New(Config{WorkerID: "worker", DockerBinary: docker, ApprovedImages: []string{p.ImageDigest}})
			ctx := context.Background()
			var cancel context.CancelFunc
			if mode == "cancel" {
				ctx, cancel = context.WithTimeout(ctx, 250*time.Millisecond)
				defer cancel()
			}
			result, err := e.PrepareGit(ctx, p)
			if err == nil || len(result.Metadata) != 0 || len(result.Listing) != 0 || result.TreeID != "" {
				t.Fatalf("partial success on %s: %v", mode, err)
			}
			if mode == "cleanup" || mode == "owner" {
				if !errors.Is(err, ErrCleanup) {
					t.Fatalf("cleanup failure lost: %v", err)
				}
			}
			calls, _ := os.ReadFile(log)
			if mode == "unsafe" && bytes.Contains(calls, []byte("index-pack")) {
				t.Fatal("pack transferred before effective isolation verified")
			}
			if mode != "owner" && !bytes.Contains(calls, []byte(`"--force"`)) {
				t.Fatal("owned container was not forcibly cleaned")
			}
		})
	}
	t.Run("binding", func(t *testing.T) {
		docker, log := preparationDocker(t, "")
		e, _ := New(Config{WorkerID: "worker", DockerBinary: docker, ApprovedImages: []string{p.ImageDigest}})
		p.JobResources = nil
		if _, err := e.PrepareGit(context.Background(), p); !errors.Is(err, ErrInvalidJob) {
			t.Fatal(err)
		}
		if _, err := os.Stat(log); !os.IsNotExist(err) {
			t.Fatal("unbound preparation touched Docker")
		}
	})
}

func TestGitPreparationMetadataRefusals(t *testing.T) {
	p, _ := nativePreparationFixture(t, "sha1")
	docker, _ := preparationDocker(t, "")
	e, _ := New(Config{WorkerID: "worker", DockerBinary: docker, ApprovedImages: []string{p.ImageDigest}})
	result, err := e.PrepareGit(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := gitPackIdentity(p.Pack, p.CommitID)
	for _, mode := range []string{"extra", "duplicate", "link", "changedpack", "changedindex", "changedhead", "trailing", "alias"} {
		t.Run(mode, func(t *testing.T) {
			reader := tar.NewReader(bytes.NewReader(result.Metadata))
			var b bytes.Buffer
			writer := tar.NewWriter(&b)
			for {
				header, err := reader.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(reader)
				if err != nil {
					t.Fatal(err)
				}
				if header.Name == ".git/HEAD" {
					if mode == "changedhead" {
						data[0] ^= 1
					}
					if mode == "link" {
						header.Typeflag = tar.TypeSymlink
						header.Linkname = "/tmp/escape"
						header.Size = 0
						data = nil
					}
					if mode == "alias" {
						header.Name = "./.git/HEAD"
					}
				}
				if mode == "changedpack" && strings.HasSuffix(header.Name, ".pack") {
					data[12] ^= 1
				}
				if mode == "changedindex" && strings.HasSuffix(header.Name, ".idx") {
					data[12] ^= 1
				}
				if err = writer.WriteHeader(header); err != nil {
					t.Fatal(err)
				}
				if _, err = writer.Write(data); err != nil {
					t.Fatal(err)
				}
				if mode == "duplicate" && header.Name == ".git/HEAD" {
					writer.WriteHeader(header)
					writer.Write(data)
				}
			}
			if mode == "extra" {
				writer.WriteHeader(&tar.Header{Name: ".git/config", Typeflag: tar.TypeReg, Mode: 0600, Size: 1})
				writer.Write([]byte("x"))
			}
			writer.Close()
			if mode == "trailing" {
				b.WriteString("x")
			}
			if _, err = normalizeGitMetadata(b.Bytes(), p.Pack, p.CommitID, id); !errors.Is(err, ErrSource) {
				t.Fatalf("metadata %s accepted: %v", mode, err)
			}
		})
	}
	pack := append([]byte(nil), p.Pack...)
	pack[12] ^= 1
	if _, err = gitPackIdentity(pack, p.CommitID); !errors.Is(err, ErrSource) {
		t.Fatal("bad checksum accepted")
	}
}

func TestGitPreparationEffectiveIsolation(t *testing.T) {
	p, _ := nativePreparationFixture(t, "sha1")
	p.JobResources.Limits = JobLimits{250, "67108864", 16, 5}
	docker, log := preparationDocker(t, "execfail")
	e, _ := New(Config{WorkerID: "worker", DockerBinary: docker, ApprovedImages: []string{p.ImageDigest}})
	e.PrepareGit(context.Background(), p)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(log), "inspect.json"))
	if err != nil {
		t.Fatal(err)
	}
	var base gitPreparationInspect
	if json.Unmarshal(data, &base) != nil {
		t.Fatal("invalid fixture inspect")
	}
	owner := base.Config.Labels[ownerLabel]
	if !validGitPreparationContainer(base, base.ID, p.ImageDigest, "worker", p.AttemptID, owner, p.JobResources.Limits) {
		t.Fatal("lower admitted limits not preserved")
	}
	cases := map[string]func(*gitPreparationInspect){
		"memory":       func(r *gitPreparationInspect) { r.HostConfig.Memory = 268435456 },
		"swap":         func(r *gitPreparationInspect) { r.HostConfig.MemorySwap = -1 },
		"cpu":          func(r *gitPreparationInspect) { r.HostConfig.NanoCpus = 1000000000 },
		"pids":         func(r *gitPreparationInspect) { r.HostConfig.PidsLimit = nil },
		"network":      func(r *gitPreparationInspect) { r.HostConfig.NetworkMode = "host" },
		"privileged":   func(r *gitPreparationInspect) { r.HostConfig.Privileged = true },
		"rootwrite":    func(r *gitPreparationInspect) { r.HostConfig.ReadonlyRootfs = false },
		"rootuser":     func(r *gitPreparationInspect) { r.Config.User = "0" },
		"capabilities": func(r *gitPreparationInspect) { r.HostConfig.CapAdd = []string{"SYS_ADMIN"} },
		"privileges":   func(r *gitPreparationInspect) { r.HostConfig.SecurityOpt = nil },
		"hostmount":    func(r *gitPreparationInspect) { r.HostConfig.Binds = []string{"/:/host"} },
		"dockerSocket": func(r *gitPreparationInspect) {
			r.Mounts = append(r.Mounts, struct{ Type, Destination string }{"bind", "/var/run/docker.sock"})
		},
		"disk":    func(r *gitPreparationInspect) { r.HostConfig.Tmpfs["/workspace"] = "rw" },
		"owner":   func(r *gitPreparationInspect) { r.Config.Labels[ownerLabel] = "foreign" },
		"command": func(r *gitPreparationInspect) { r.Config.Cmd = []string{"untrusted"} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			var row gitPreparationInspect
			json.Unmarshal(data, &row)
			mutate(&row)
			if validGitPreparationContainer(row, base.ID, p.ImageDigest, "worker", p.AttemptID, owner, p.JobResources.Limits) {
				t.Fatal("unsafe effective container accepted")
			}
		})
	}
}

func TestGitPreparationNativeInputRefusals(t *testing.T) {
	original, _ := nativePreparationFixture(t, "sha1")
	for _, mode := range []string{"workflow", "decoder", "count", "unreachable"} {
		t.Run(mode, func(t *testing.T) {
			p := original
			if mode == "unreachable" {
				p, _ = nativePreparationFixture(t, "sha1", false, true)
			}
			p.Pack = append([]byte(nil), p.Pack...)
			if mode == "workflow" {
				p.WorkflowBlobID = p.CommitID
			}
			if mode == "decoder" {
				p.Pack[12] = 0
			}
			if mode == "count" {
				binary.BigEndian.PutUint32(p.Pack[8:12], 8195)
			}
			if mode == "decoder" || mode == "count" {
				checksum := sha1.Sum(p.Pack[:len(p.Pack)-20])
				copy(p.Pack[len(p.Pack)-20:], checksum[:])
			}
			docker, log := preparationDocker(t, "")
			e, _ := New(Config{WorkerID: "worker", DockerBinary: docker, ApprovedImages: []string{p.ImageDigest}})
			result, err := e.PrepareGit(context.Background(), p)
			if err == nil || len(result.Metadata) != 0 || len(result.Listing) != 0 || result.TreeID != "" {
				t.Fatalf("invalid native source %s accepted", mode)
			}
			calls, _ := os.ReadFile(log)
			if mode == "count" {
				if len(calls) != 0 {
					t.Fatal("oversized object count reached Docker")
				}
			} else if !bytes.Contains(calls, []byte("index-pack")) || !bytes.Contains(calls, []byte(`"--force"`)) {
				t.Fatal("native validation or cleanup was not exercised")
			}
		})
	}
}
