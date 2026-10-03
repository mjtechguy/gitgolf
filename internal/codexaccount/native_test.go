package codexaccount

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestPinnedNativeAccount is opt-in: no host account import or inference. The
// deliberately invalid key proves native cache transport, not provider access.
func TestPinnedNativeAccount(t *testing.T) {
	binary := os.Getenv("GOLF_TEST_CODEX_BINARY")
	if binary == "" {
		t.Skip("Set GOLF_TEST_CODEX_BINARY to the trusted pinned native executable")
	}
	if !filepath.IsAbs(binary) {
		t.Fatal("Trusted executable must be absolute")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	versionHome := t.TempDir()
	version := exec.CommandContext(ctx, binary, "--version")
	version.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + versionHome, "CODEX_HOME=" + versionHome}
	output, err := version.Output()
	if err != nil || strings.TrimSpace(string(output)) != "codex-cli 0.160.0" {
		t.Fatal("Pinned native version qualification failed")
	}
	config := Config{Binary: binary, Timeout: 30 * time.Second}
	first, err := New(ctx, config, nil)
	if err != nil {
		t.Fatal("Native account initialization failed")
	}
	defer first.Close()
	account, err := first.Account(ctx, false)
	if err != nil || account.Type != "" {
		t.Fatal("Fresh native home inherited an account")
	}
	if _, err = first.StartLogin(ctx, LoginRequest{Type: "apiKey", APIKey: "sk-golf-invalid-native-proof-aaaaaaaaaaaaaaaaaaaaaaaa"}); err != nil {
		t.Fatal("Native API cache write failed")
	}
	account, err = first.Account(ctx, false)
	if err != nil || account.Type != "apiKey" || account.Email != "" {
		t.Fatal("Native API account projection failed")
	}
	snapshot, err := first.Snapshot()
	if err != nil || len(snapshot) == 0 {
		t.Fatal("Native credential snapshot not an owned private ordinary JSON file")
	}
	firstHome := first.home
	first.Close()
	if _, err = os.Stat(firstHome); !os.IsNotExist(err) {
		t.Fatal("Native private home survived close")
	}
	second, err := New(ctx, config, snapshot)
	if err != nil {
		t.Fatal("Native encrypted-cache roundtrip initialization failed")
	}
	defer second.Close()
	account, err = second.Account(ctx, false)
	if err != nil || account.Type != "apiKey" {
		t.Fatal("Native API account did not survive explicit cache roundtrip")
	}
	if err = second.Logout(ctx); err != nil {
		t.Fatal("Native logout failed")
	}
	snapshot, err = second.Snapshot()
	if err != nil || len(snapshot) != 0 {
		t.Fatal("Native logout retained account credentials")
	}
	account, err = second.Account(ctx, false)
	if err != nil || account.Type != "" {
		t.Fatal("Native account survived logout")
	}
	login, err := second.StartLogin(ctx, LoginRequest{Type: "chatgptDeviceCode"})
	if err != nil || login.VerificationURL != verificationURL || login.LoginID == "" || login.UserCode == "" {
		t.Fatal("Native device challenge issue failed; private details withheld")
	}
	if err = second.CancelLogin(ctx, login.LoginID); err != nil {
		t.Fatal("Native device challenge cancellation failed")
	}
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event, open := <-second.Events():
			if !open {
				t.Fatal("Native transport closed before cancellation confirmation")
			}
			if event.LoginID != login.LoginID {
				continue
			}
			if event.Success {
				t.Fatal("Cancelled challenge unexpectedly authenticated")
			}
			secondHome := second.home
			second.Close()
			if _, err = os.Stat(secondHome); !os.IsNotExist(err) {
				t.Fatal("Restored native private home survived close")
			}
			return
		case <-timer.C:
			t.Fatal("Native cancellation confirmation timed out")
		}
	}
}
