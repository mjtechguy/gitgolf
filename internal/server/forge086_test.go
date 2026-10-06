package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type forge086Transport func(*http.Request) (*http.Response, error)

func (f forge086Transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func forge086Response(r *http.Request, status int, v any) *http.Response {
	b, _ := json.Marshal(v)
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(b)), Request: r}
}
func forge086Request[T any](m *T, h http.Header) *connect.Request[T] {
	r := connect.NewRequest(m)
	r.Header().Set("Cookie", h.Get("Cookie"))
	r.Header().Set("Origin", h.Get("Origin"))
	return r
}

const forge086Token = "ghp_owned_fixture_only_01234567890123456789"

func forge086Connection(t *testing.T, f *releasePublicationFixture, ctx context.Context, h http.Header) *golfv1.ProviderConnection {
	t.Helper()
	r, e := f.s.CreateProviderConnection(ctx, forge086Request(&golfv1.CreateProviderConnectionRequest{ConnectionId: randomUUID(), Provider: "github", Name: "Owned GitHub fixture", Token: forge086Token}, h))
	if e != nil {
		t.Fatal(e)
	}
	return r.Msg.Connection
}
func TestProvider086OriginalAndCredentialsPostgres(t *testing.T) {
	for _, private := range []bool{false, true} {
		t.Run(map[bool]string{false: "public", true: "private"}[private], func(t *testing.T) {
			f := newReleasePublicationFixture(t)
			session := f.session(t, "pat")
			ctx, _, h := f.scope(session)
			base := f.s.client.Transport
			if base == nil {
				base = http.DefaultTransport
			}
			var writes atomic.Int32
			var drift atomic.Bool
			f.s.client.Transport = forge086Transport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "api.github.com" {
					if r.Header.Get("Authorization") != "Bearer "+forge086Token || r.Method != "GET" {
						t.Error("provider authorization boundary")
					}
					switch r.URL.Path {
					case "/user":
						return forge086Response(r, 200, map[string]any{"id": 81, "login": "source-owner"}), nil
					case "/repos/source-owner/project":
						return forge086Response(r, 200, map[string]any{"id": 82, "full_name": "source-owner/project", "private": private, "clone_url": "https://github.com/source-owner/project.git", "default_branch": "main"}), nil
					case "/repos/source-owner/project/branches/main":
						head := strings.Repeat("b", 40)
						if drift.Load() {
							head = strings.Repeat("a", 40)
						}
						return forge086Response(r, 200, map[string]any{"name": "main", "commit": map[string]string{"sha": head}}), nil
					}
					t.Error("unexpected provider read", r.URL.Path)
					return forge086Response(r, 404, nil), nil
				}
				if r.URL.Path == "/api/v1/repos/migrate" {
					writes.Add(1)
					var m map[string]any
					json.NewDecoder(r.Body).Decode(&m)
					if m["private"] != true || m["mirror"] != false || m["repo_owner"] != "alice" || m["service"] != "git" {
						t.Error("unsafe import payload")
					}
					if private {
						if m["auth_password"] != forge086Token || m["auth_username"] != "x-access-token" {
							t.Error("private credential missing")
						}
					} else if m["auth_password"] != nil || m["auth_username"] != nil {
						t.Error("public native clone received provider secret")
					}
					return forge086Response(r, 201, map[string]any{"id": 11, "name": "private", "full_name": "alice/private", "private": true, "owner": map[string]any{"id": 42, "login": "alice"}}), nil
				}
				if r.URL.Path == "/api/v1/repos/alice/private" {
					out, err := base.RoundTrip(r)
					if err != nil {
						return out, err
					}
					var v map[string]any
					json.NewDecoder(out.Body).Decode(&v)
					out.Body.Close()
					v["private"] = true
					v["has_packages"] = true
					return forge086Response(r, out.StatusCode, v), nil
				}
				return base.RoundTrip(r)
			})
			c := forge086Connection(t, f, ctx, h)
			var cipher []byte
			if e := f.db.QueryRow("SELECT encrypted_credential FROM golf_provider_connections WHERE id=$1", c.Id).Scan(&cipher); e != nil || bytes.Contains(cipher, []byte(forge086Token)) {
				t.Fatal("provider secret stored cleartext", e)
			}
			p, e := f.s.PreviewProviderImport(ctx, forge086Request(&golfv1.PreviewProviderImportRequest{ConnectionId: c.Id, ConnectionVersion: c.Version, SourceUrl: "https://github.com/source-owner/project"}, h))
			if e != nil {
				t.Fatal(e)
			}
			m := &golfv1.SubmitProviderImportRequest{Preview: p.Msg.Preview, OperationId: randomUUID(), DestinationName: "private"}
			r, e := f.s.SubmitProviderImport(ctx, forge086Request(m, h))
			if e != nil {
				t.Fatal(e)
			}
			if r.Msg.Operation.Phase != 3 || r.Msg.Operation.RepositoryId != "11" {
				t.Fatal("import receipt", r.Msg.Operation)
			}
			replay, e := f.s.SubmitProviderImport(ctx, forge086Request(m, h))
			if e != nil || !proto.Equal(r.Msg.Operation, replay.Msg.Operation) || writes.Load() != 1 {
				t.Fatal("original resubmitted", e)
			}
			changed := proto.Clone(m).(*golfv1.SubmitProviderImportRequest)
			changed.Description = "different"
			if _, e = f.s.SubmitProviderImport(ctx, forge086Request(changed, h)); e == nil {
				t.Fatal("changed original accepted")
			}
			drift.Store(true)
			stale := proto.Clone(m).(*golfv1.SubmitProviderImportRequest)
			stale.OperationId = randomUUID()
			stale.DestinationName = "new-name"
			rejected, e := f.s.SubmitProviderImport(ctx, forge086Request(stale, h))
			if e != nil || rejected.Msg.Operation.Phase != 4 || writes.Load() != 1 {
				t.Fatal("stale preview dispatched", e)
			}
			u, e := f.s.UpdateProviderConnection(ctx, forge086Request(&golfv1.UpdateProviderConnectionRequest{ConnectionId: c.Id, ExpectedVersion: c.Version, Name: c.Name, Revoke: true}, h))
			if e != nil || !u.Msg.Connection.Revoked {
				t.Fatal("revoke", e)
			}
			if _, e = f.s.PreviewProviderImport(ctx, forge086Request(&golfv1.PreviewProviderImportRequest{ConnectionId: c.Id, ConnectionVersion: u.Msg.Connection.Version, SourceUrl: p.Msg.Preview.SourceUrl}, h)); e == nil {
				t.Fatal("revoked provider used")
			}
			if _, e = f.db.Exec("UPDATE golf_provider_connections SET revoked=false,version=version+1 WHERE id=$1", c.Id); e == nil {
				t.Fatal("revoked credential resurrected")
			}
		})
	}
}
func TestProvider086OriginsAndInputs(t *testing.T) {
	for _, s := range []string{"aws", "https://gitlab.example.com", "http://api.github.com"} {
		if _, e := providerOrigin(s); e == nil {
			t.Fatal("arbitrary origin")
		}
	}
	for _, s := range []string{"tiny", strings.Repeat("x", 513), "01234567890123456789\n", "01234567890123456789?"} {
		if providerTokenValid(s) {
			t.Fatal("invalid credential syntax")
		}
	}
}

func TestPackage086NamespaceOriginalAndDownloadsPostgres(t *testing.T) {
	for _, mode := range []string{"private", "public-ack", "limited-private", "public-private", "lost-upload", "lost-link", "tamper-download"} {
		t.Run(mode, func(t *testing.T) {
			f := newReleasePublicationFixture(t)
			session := f.session(t, "pat")
			ctx, _, h := f.scope(session)
			base := f.s.client.Transport
			if base == nil {
				base = http.DefaultTransport
			}
			var puts, links atomic.Int32
			var pkg *nativePackage
			data := []byte("bounded real package bytes\n")
			repo := Repository{ID: 11, Name: "private", FullName: "alice/private", HTMLURL: "https://forge.invalid/alice/private", DefaultBranch: "main"}
			owner := User{ID: 42, Login: "alice"}
			visibility := "private"
			private := true
			if mode == "public-ack" {
				visibility = "public"
				private = false
			}
			if mode == "public-private" {
				visibility = "public"
			}
			if mode == "limited-private" {
				visibility = "limited"
			}
			f.s.client.Transport = forge086Transport(func(r *http.Request) (*http.Response, error) {
				switch r.URL.Path {
				case "/api/v1/users/alice":
					return forge086Response(r, 200, map[string]any{"id": 42, "login": "alice", "visibility": visibility}), nil
				case "/api/v1/repos/alice/private":
					out, e := base.RoundTrip(r)
					if e != nil {
						return out, e
					}
					var row map[string]any
					json.NewDecoder(out.Body).Decode(&row)
					out.Body.Close()
					row["private"] = private
					row["has_packages"] = true
					return forge086Response(r, out.StatusCode, row), nil
				case "/api/v1/packages/alice/generic/useful":
					if pkg == nil {
						return forge086Response(r, 200, []any{}), nil
					}
					return forge086Response(r, 200, []nativePackage{*pkg}), nil
				case "/api/packages/alice/generic/useful/1.0/fixture.txt":
					if r.Method == "PUT" {
						puts.Add(1)
						b, _ := io.ReadAll(r.Body)
						if !bytes.Equal(b, data) {
							t.Error("changed upload")
						}
						pkg = &nativePackage{ID: 71, Name: "useful", Type: "generic", Version: "1.0", Created: "2026-10-05T12:00:00Z", Owner: &owner, Creator: &owner}
						status := 201
						if mode == "lost-upload" {
							status = 500
						}
						return forge086Response(r, status, nil), nil
					}
					body := data
					if mode == "tamper-download" {
						body = []byte("bad")
					}
					return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
				case "/api/v1/packages/alice/generic/useful/-/link/private":
					links.Add(1)
					if mode == "lost-link" {
						return forge086Response(r, 500, nil), nil
					}
					pkg.Repository = &repo
					return forge086Response(r, 201, nil), nil
				case "/api/v1/packages/alice/generic/useful/1.0":
					if pkg == nil {
						return forge086Response(r, 404, nil), nil
					}
					return forge086Response(r, 200, pkg), nil
				case "/api/v1/packages/alice/generic/useful/1.0/files":
					size := int64(len(data))
					return forge086Response(r, 200, []nativeGenericFile{{ID: 72, Name: "fixture.txt", Size: &size, SHA256: releasePublicationTextHash(string(data))}}), nil
				}
				return base.RoundTrip(r)
			})
			access, e := f.s.GetPackagePublicationAccess(ctx, forge086Request(&golfv1.GetPackagePublicationAccessRequest{Repository: pullKey, RepositoryId: "11"}, h))
			if e != nil {
				t.Fatal(e)
			}
			if mode == "limited-private" || mode == "public-private" {
				if access.Msg.Allowed {
					t.Fatal("private package exposed via namespace")
				}
				return
			}
			m := &golfv1.SubmitPackagePublicationRequest{Repository: pullKey, RepositoryId: "11", OwnerId: "42", AccessRevision: access.Msg.Access.Revision, OperationId: randomUUID(), PackageName: "useful", Version: "1.0", FileName: "fixture.txt", Content: data, PublicNamespaceAcknowledged: mode == "public-ack"}
			r, e := f.s.SubmitPackagePublication(ctx, forge086Request(m, h))
			if e != nil {
				t.Fatal(e)
			}
			want := golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED
			if mode == "lost-upload" || mode == "lost-link" || mode == "tamper-download" {
				want = 2
			}
			if r.Msg.Operation.Phase != want {
				t.Fatal("publication receipt", r.Msg.Operation)
			}
			replay, e := f.s.SubmitPackagePublication(ctx, forge086Request(m, h))
			if e != nil || !proto.Equal(r.Msg.Operation, replay.Msg.Operation) || puts.Load() != 1 {
				t.Fatal("original publication resent", e)
			}
			var activities int
			if e := f.db.QueryRow("SELECT count(*) FROM golf_repository_activity WHERE forge_url=$1 AND repository_id=11 AND topic='source'", f.s.config.GiteaURL).Scan(&activities); e != nil {
				t.Fatal(e)
			}
			if (want == 2 && activities != 0) || (want == 3 && activities != 1) {
				t.Fatal("publication activity must occur only once on success", activities)
			}
			if want == 2 {
				if mode == "lost-upload" && links.Load() != 0 {
					t.Fatal("failed upload linked")
				}
				next := proto.Clone(m).(*golfv1.SubmitPackagePublicationRequest)
				next.OperationId = randomUUID()
				if _, e = f.s.SubmitPackagePublication(ctx, forge086Request(next, h)); e == nil || puts.Load() != 1 {
					t.Fatal("unknown publication bypassed")
				}
				return
			}
			wire, e := packageWire(*pkg, repo, 42)
			if e != nil {
				t.Fatal(e)
			}
			dl, e := f.s.DownloadGenericPackageFile(ctx, forge086Request(&golfv1.DownloadGenericPackageFileRequest{Repository: pullKey, RepositoryId: "11", Package: wire, FileId: "72"}, h))
			if e != nil || !bytes.Equal(dl.Msg.Content, data) {
				t.Fatal("download", e)
			}
			changed := proto.Clone(m).(*golfv1.SubmitPackagePublicationRequest)
			changed.Content = []byte("other")
			if _, e = f.s.SubmitPackagePublication(ctx, forge086Request(changed, h)); e == nil {
				t.Fatal("changed original accepted")
			}
		})
	}
}

func TestProvider086CredentialRotationPostgres(t *testing.T) {
	f := newReleasePublicationFixture(t)
	session := f.session(t, "pat")
	ctx, _, h := f.scope(session)
	base := f.s.client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	f.s.client.Transport = forge086Transport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.github.com" {
			return forge086Response(r, 200, map[string]any{"id": 81, "login": "source-owner"}), nil
		}
		return base.RoundTrip(r)
	})
	c := forge086Connection(t, f, ctx, h)
	keys := rotationKeys(t, f.s.config)
	status, e := KeyStatus(ctx, f.db, keys)
	if e != nil || countKeyUses(status, "legacy") != 2 {
		t.Fatal("provider omitted from key inventory", e)
	}
	mustActivate(t, f.db, keys)
	result, e := RotateCredentials(ctx, f.db, keys, 1, 5)
	if e != nil || !result.Complete || countKeyUses(result.Status, "legacy") != 0 {
		t.Fatal("provider rotation", e)
	}
	r, e := scanProviderConnection(f.db.QueryRow("SELECT "+providerConnectionColumns+" FROM golf_provider_connections WHERE id=$1", c.Id))
	if e != nil || r.KeyID != "next" || r.Version != 1 {
		t.Fatal("rotation changed authority", e)
	}
	f.s.keyring = keys
	secret, e := f.s.providerSecret(r)
	if e != nil || secret != forge086Token {
		t.Fatal("rotation cannot decrypt", e)
	}
	r.Binding = bytes.Repeat([]byte{1}, 32)
	if _, e = f.s.providerSecret(r); e == nil {
		t.Fatal("foreign binding accepted")
	}
	for _, query := range []string{"DELETE FROM golf_provider_connections", "UPDATE golf_provider_connection_events SET action=action", "DELETE FROM golf_provider_import_operations", "TRUNCATE golf_package_publication_events"} {
		if _, e = f.db.Exec(query); e == nil {
			t.Fatal("immutable provider/package evidence mutable", query)
		}
	}
}

func TestWiki086OrdinaryUnitWriterPostgres(t *testing.T) {
	for _, grant := range []string{"write", "read", "site-admin-only"} {
		t.Run(grant, func(t *testing.T) {
			f := newReleasePublicationFixture(t)
			base := f.s.client.Transport
			if base == nil {
				base = http.DefaultTransport
			}
			f.s.client.Transport = forge086Transport(func(r *http.Request) (*http.Response, error) {
				switch r.URL.Path {
				case "/api/v1/repos/alice/private":
					out, e := base.RoundTrip(r)
					if e != nil {
						return out, e
					}
					var row map[string]any
					json.NewDecoder(out.Body).Decode(&row)
					out.Body.Close()
					row["permissions"] = map[string]bool{"admin": false, "push": grant != "read", "pull": true}
					return forge086Response(r, 200, row), nil
				case "/api/v1/repos/alice/private/collaborators/bob/permission":
					permission := grant
					if grant == "site-admin-only" {
						permission = "admin"
					}
					return forge086Response(r, 200, map[string]any{"permission": permission, "user": User{ID: 43, Login: "bob"}}), nil
				case "/api/v1/repos/alice/private/collaborators/bob":
					status := 204
					if grant == "site-admin-only" {
						status = 404
					}
					return forge086Response(r, status, nil), nil
				}
				return base.RoundTrip(r)
			})
			session, e := f.s.createSession(context.Background(), User{ID: 43, Login: "bob"}, "pat", "other-pat", "")
			if e != nil {
				t.Fatal(e)
			}
			ctx := context.WithValue(context.Background(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "other-pat"})
			_, _, h := f.scope(session)
			r, e := f.s.GetRepositoryWikiWriteContext(ctx, forge086Request(&golfv1.GetRepositoryWikiWriteContextRequest{Repository: pullKey, RepositoryId: "11"}, h))
			if grant == "write" {
				if e != nil || !r.Msg.CanWrite || r.Msg.Access.CanManage {
					t.Fatal("ordinary wiki writer mislabeled as administrator", e)
				}
			} else if e == nil {
				t.Fatal("non-writer admitted")
			}
		})
	}
}
func TestMirror086CompletionPostgres(t *testing.T) {
	for _, mode := range []string{"completed", "queued", "wrong-head", "source-drift"} {
		t.Run(mode, func(t *testing.T) {
			f := newReleasePublicationFixture(t)
			session := f.session(t, "pat")
			ctx, _, h := f.scope(session)
			base := f.s.client.Transport
			if base == nil {
				base = http.DefaultTransport
			}
			updated := "2026-10-06T03:00:00Z"
			var writes atomic.Int32
			var remoteReads atomic.Int32
			head := strings.Repeat("b", 40)
			f.s.client.Transport = forge086Transport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "api.github.com" {
					if r.Header.Get("Authorization") != "" {
						t.Error("mirror observation forwarded credential")
					}
					if r.URL.Path == "/repos/owned/project" {
						return forge086Response(r, 200, map[string]any{"id": 82, "private": false, "clone_url": "https://github.com/owned/project.git", "default_branch": "main"}), nil
					}
					remote := head
					if mode == "source-drift" && remoteReads.Add(1) > 1 {
						remote = strings.Repeat("a", 40)
					}
					return forge086Response(r, 200, map[string]any{"name": "main", "commit": map[string]string{"sha": remote}}), nil
				}
				switch r.URL.Path {
				case "/api/v1/repos/alice/private":
					out, e := base.RoundTrip(r)
					if e != nil {
						return out, e
					}
					var row map[string]any
					json.NewDecoder(out.Body).Decode(&row)
					out.Body.Close()
					row["mirror"] = true
					row["mirror_interval"] = "1h0m0s"
					row["original_url"] = "https://github.com/owned/project.git"
					row["mirror_updated"] = updated
					return forge086Response(r, 200, row), nil
				case "/api/v1/repos/alice/private/mirror-sync":
					writes.Add(1)
					if mode != "queued" {
						updated = "2026-10-06T03:00:02Z"
					}
					return forge086Response(r, 200, nil), nil
				case "/api/v1/repos/alice/private/branches/main":
					native := head
					if mode == "wrong-head" {
						native = strings.Repeat("a", 40)
					}
					return forge086Response(r, 200, map[string]any{"name": "main", "commit": map[string]string{"id": native}}), nil
				}
				return base.RoundTrip(r)
			})
			_, configuration, e := f.s.mirrorAuthority(ctx, session.Value, forgeCredential{Kind: "pat", Token: "pull-pat"}, keyFrom(pullKey), "11", "42")
			if e != nil {
				t.Fatal(e)
			}
			m := &golfv1.SubmitRepositoryMirrorOperationRequest{Repository: pullKey, RepositoryId: "11", OwnerId: "42", OperationId: randomUUID(), ExpectedConfigurationRevision: mirrorRevision(configuration), Kind: 2}
			r, e := f.s.SubmitRepositoryMirrorOperation(ctx, forge086Request(m, h))
			if e != nil || r.Msg.Operation.Phase != 3 {
				t.Fatal("sync acceptance", e, r)
			}
			o, e := f.s.GetMirrorSyncObservation(ctx, forge086Request(&golfv1.GetMirrorSyncObservationRequest{Repository: pullKey, RepositoryId: "11", OwnerId: "42", OperationId: m.OperationId}, h))
			if mode == "source-drift" {
				if e == nil {
					t.Fatal("unstable remote reported")
				}
				return
			}
			if e != nil || o.Msg.CompletionObserved != (mode == "completed") {
				t.Fatal("completion observation", e, o)
			}
			if writes.Load() != 1 {
				t.Fatal("observation resent sync")
			}
			if _, e = f.db.Exec("UPDATE golf_mirror_sync_baselines SET native_updated_at=native_updated_at"); e == nil {
				t.Fatal("baseline mutable")
			}
		})
	}
}

func TestProvider086UnknownNeverResendsPostgres(t *testing.T) {
	f := newReleasePublicationFixture(t)
	session := f.session(t, "pat")
	ctx, _, h := f.scope(session)
	base := f.s.client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	var calls atomic.Int32
	f.s.client.Transport = forge086Transport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.github.com" {
			switch r.URL.Path {
			case "/user":
				return forge086Response(r, 200, map[string]any{"id": 81, "login": "source-owner"}), nil
			case "/repos/source-owner/project":
				return forge086Response(r, 200, map[string]any{"id": 82, "full_name": "source-owner/project", "private": true, "clone_url": "https://github.com/source-owner/project.git", "default_branch": "main"}), nil
			default:
				return forge086Response(r, 200, map[string]any{"name": "main", "commit": map[string]string{"sha": strings.Repeat("b", 40)}}), nil
			}
		}
		if r.URL.Path == "/api/v1/repos/migrate" {
			calls.Add(1)
			return forge086Response(r, 503, nil), nil
		}
		return base.RoundTrip(r)
	})
	c := forge086Connection(t, f, ctx, h)
	p, e := f.s.PreviewProviderImport(ctx, forge086Request(&golfv1.PreviewProviderImportRequest{ConnectionId: c.Id, ConnectionVersion: c.Version, SourceUrl: "https://github.com/source-owner/project"}, h))
	if e != nil {
		t.Fatal(e)
	}
	m := &golfv1.SubmitProviderImportRequest{Preview: p.Msg.Preview, OperationId: randomUUID(), DestinationName: "unknown-private"}
	r, e := f.s.SubmitProviderImport(ctx, forge086Request(m, h))
	if e != nil || r.Msg.Operation.Phase != 2 {
		t.Fatal("unknown import", e)
	}
	again, e := f.s.SubmitProviderImport(ctx, forge086Request(m, h))
	if e != nil || !proto.Equal(r.Msg.Operation, again.Msg.Operation) || calls.Load() != 1 {
		t.Fatal("unknown native import resent", e)
	}
	next := proto.Clone(m).(*golfv1.SubmitProviderImportRequest)
	next.OperationId = randomUUID()
	next.DestinationName = "bypass-attempt"
	if _, e = f.s.SubmitProviderImport(ctx, forge086Request(next, h)); e == nil || calls.Load() != 1 {
		t.Fatal("unknown import admission bypassed")
	}
}
