package server

import (
	"bytes"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

func managedPacket(s string) []byte { return []byte(fmt.Sprintf("%04x%s", len(s)+4, s)) }
func managedReceive(ref string) []byte {
	return bytes.Join([][]byte{managedPacket(strings.Repeat("1", 40) + " " + strings.Repeat("2", 40) + " " + ref + "\x00 report-status side-band-64k agent=git/2.39.5"), []byte("0000PACK\x00\x00\x00\x02\x00\x00\x00\x00")}, nil)
}
func TestManagedGitRouteClassifier(t *testing.T) {
	for _, tc := range []struct {
		method, path, content string
		valid                 bool
	}{
		{"GET", "/git/alice/repo.git/info/refs?service=git-upload-pack", "", true},
		{"POST", "/git/alice/repo.git/git-receive-pack", "application/x-git-receive-pack-request", true},
		{"GET", "/git/alice/repo.git/info/refs?service=git-upload-pack&service=git-upload-pack", "", false},
		{"GET", "/git/alice/repo.git/info/refs?service=git-upload-pack&token=x", "", false},
		{"POST", "/git/alice/repo.wiki.git/git-receive-pack", "application/x-git-receive-pack-request", false},
		{"POST", "/git/alice/repo.git/git-upload-archive", "application/x-git-upload-archive-request", false},
		{"POST", "/git/alice/repo.git/git-receive-pack", "application/x-git-receive-pack-request; charset=utf-8", false},
		{"GET", "/git/alice/repo.git/HEAD", "", false},
		{"GET", "/git/alice%2frepo.git/info/refs?service=git-upload-pack", "", false},
		{"GET", "/git/alice/repo.git//info/refs?service=git-upload-pack", "", false},
		{"OPTIONS", "/git/alice/repo.git/info/refs?service=git-upload-pack", "", false},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			r.Header.Set("Authorization", "Basic irrelevant")
			r.Header.Set("Content-Type", tc.content)
			_, err := classifyGitTransport(r)
			if (err == nil) != tc.valid {
				t.Fatal("route admission", err)
			}
		})
	}
}
func TestManagedReceiveCommandsAndDigest(t *testing.T) {
	wire := managedReceive("refs/heads/feature/topic")
	got, e := receiveRequest(wire)
	if e != nil || len(got.Commands) != 1 || got.Commands[0].Ref != "refs/heads/feature/topic" || !got.Sideband {
		t.Fatal("pinned send-pack non-LF command shape", e)
	}
	// Same effect with the spec's optional LF and different agent metadata is not a new operation.
	changed := bytes.Replace(wire, []byte("agent=git/2.39.5"), []byte("agent=git/2.39.6"), 1)
	alt, e := receiveRequest(changed)
	if e != nil || alt.Digest != got.Digest {
		t.Fatal("transport metadata created duplicate effect identity", e)
	}
	for _, ref := range []string{"refs/for/main", "refs/pull/1/head", "refs/heads/a..b", "refs/heads/x.lock", "refs/tags/../x"} {
		if _, e := receiveRequest(managedReceive(ref)); e == nil {
			t.Fatal("admitted unsupported ref", ref)
		}
	}
	for _, cap := range []string{"push-options", "report-status-v2", "push-cert", "session-id=untrusted"} {
		wire := managedPacket(strings.Repeat("1", 40) + " " + strings.Repeat("2", 40) + " refs/heads/main\x00 report-status " + cap)
		wire = append(wire, []byte("0000PACK\x00\x00\x00\x02\x00\x00\x00\x00")...)
		if _, e := receiveRequest(wire); e == nil {
			t.Fatal("admitted unsupported capability", cap)
		}
	}
	duplicate := append(managedPacket(strings.Repeat("1", 40)+" "+strings.Repeat("2", 40)+" refs/heads/main\x00 report-status"), managedPacket(strings.Repeat("3", 40)+" "+strings.Repeat("4", 40)+" refs/heads/main")...)
	duplicate = append(duplicate, []byte("0000PACK\x00\x00\x00\x02\x00\x00\x00\x00")...)
	if _, e := receiveRequest(duplicate); e == nil {
		t.Fatal("ambiguous duplicate ref")
	}
}
func TestManagedReceiveIndependentStatus(t *testing.T) {
	req, e := receiveRequest(managedReceive("refs/heads/topic"))
	if e != nil {
		t.Fatal(e)
	}
	inner := append(managedPacket("unpack ok\n"), managedPacket("ok refs/heads/topic\n")...)
	inner = append(inner, []byte("0000")...)
	// Native sideband boundaries may cut through the inner report packet framing.
	result := append(managedPacket("\x02private progress is discarded"), managedPacket("\x01"+string(inner[:7]))...)
	result = append(result, managedPacket("\x01"+string(inner[7:]))...)
	result = append(result, []byte("0000")...)
	report, e := receiveReport(result, req)
	if e != nil || report.Accepted != 1 || report.Rejected != 0 {
		t.Fatal("complete independent report", e)
	}
	for _, bad := range [][]byte{result[:len(result)-1], append(result, []byte("extra")...), managedPacket("\x03fatal\n"), append(managedPacket("\x01"+string(managedPacket("unpack ok\n"))+string(managedPacket("ok refs/heads/other\n"))+"0000"), []byte("0000")...)} {
		if _, e := receiveReport(bad, req); e == nil {
			t.Fatal("unverified report released receive reservation")
		}
	}
	req.Sideband = false
	ng := append(managedPacket("unpack ok\n"), managedPacket("ng refs/heads/topic native rejection reason\n")...)
	ng = append(ng, []byte("0000")...)
	report, e = receiveReport(ng, req)
	if e != nil || report.Rejected != 1 {
		t.Fatal("explicit rejected command", e)
	}
}

func TestManagedReceiveBindsRelevantCapabilities(t *testing.T) {
	base := managedReceive("refs/heads/topic")
	original, e := receiveRequest(base)
	if e != nil {
		t.Fatal(e)
	}
	row := strings.Repeat("1", 40) + " " + strings.Repeat("2", 40) + " refs/heads/topic\x00 report-status side-band-64k atomic agent=git/2.39.5"
	changed := append(managedPacket(row), []byte("0000PACK\x00\x00\x00\x02\x00\x00\x00\x00")...)
	atomic, e := receiveRequest(changed)
	if e != nil || atomic.Digest == original.Digest {
		t.Fatal("atomic semantics not bound", e)
	}
	mismatch := append(managedPacket(strings.Replace(row, "atomic", "object-format=sha256", 1)), []byte("0000PACK\x00\x00\x00\x02\x00\x00\x00\x00")...)
	if _, e := receiveRequest(mismatch); e == nil {
		t.Fatal("mismatched object format admitted")
	}
	for _, ref := range []string{"refs/tags/topic", "refs/heads/topic"} {
		r, _ := receiveRequest(managedReceive(ref))
		if ordinaryGitUpdate(r) != (ref == "refs/heads/topic") {
			t.Fatal("ordinary branch gate")
		}
		r.Commands[0].Old = strings.Repeat("0", 40)
		if ordinaryGitUpdate(r) {
			t.Fatal("new ref admitted")
		}
		r.Commands[0].Old = strings.Repeat("1", 40)
		r.Commands[0].New = strings.Repeat("0", 40)
		if ordinaryGitUpdate(r) {
			t.Fatal("ref deletion admitted")
		}
	}
}
