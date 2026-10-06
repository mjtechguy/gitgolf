package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestLocalAccountOperatorInput(t *testing.T) {
	good := `{"username":"golf-admin","password":"a long private password","forge_token":"private-token","is_instance_admin":true}`
	value, err := readLocalAccountInput(strings.NewReader(good), "create")
	if err != nil || value.Username != "golf-admin" || !value.IsInstanceAdmin {
		t.Fatal("valid create rejected")
	}
	for _, body := range []string{strings.Replace(good, `"username"`, `"email":"admin@example.com","username"`, 1)} {
		if _, err := readLocalAccountInput(strings.NewReader(body), "create"); err != nil {
			t.Fatal("optional email rejected")
		}
	}
	if _, err := readLocalAccountInput(strings.NewReader(`{"username":"golf-admin","email":"admin@example.com"}`), "set-email"); err != nil {
		t.Fatal("set-email rejected")
	}
	if _, err := readLocalAccountInput(strings.NewReader(`{"username":"golf-admin","email":"admin@example.com","password":"secret"}`), "set-email"); err == nil {
		t.Fatal("set-email accepted password")
	}
	cases := []struct{ action, body string }{
		{"create", `{"username":"admin","username":"other"}`},
		{"create", good + ` {}`},
		{"create", `{"username":null,"password":"secret","forge_token":"token","is_instance_admin":true}`},
		{"create", strings.Replace(good, `true`, `"true"`, 1)},
		{"create", strings.Replace(good, `"username"`, `"extra"`, 1)},
		{"disable", good},
		{"enable", good},
		{"create", strings.Repeat("x", 8193)},
	}
	for _, entry := range cases {
		if _, err := readLocalAccountInput(strings.NewReader(entry.body), entry.action); err == nil || strings.Contains(err.Error(), "private-token") {
			t.Fatal("invalid input accepted or secret echoed")
		}
	}
	for _, action := range []string{"create", "reset-password", "disable", "enable", "set-email"} {
		if _, err := parseLocalAccountCommand([]string{"local-account", action}); err != nil {
			t.Fatal("documented action rejected")
		}
	}
	for _, args := range [][]string{{"local-account", "create", "--password", "private-password"}, {"local-account", "create", "secret"}, {"local-account", "create", "--timeout", "0s"}, {"local-account", "delete"}} {
		if _, err := parseLocalAccountCommand(args); err == nil || strings.Contains(err.Error(), "private-password") {
			t.Fatal("invalid argv accepted or echoed")
		}
	}
	var output bytes.Buffer
	if err := runLocalAccount(context.Background(), localAccountOptions{action: "create", timeout: time.Second}, strings.NewReader(`{"password":"private-value"}`), &output); err == nil || strings.Contains(output.String(), "private-value") {
		t.Fatal("input error output leaked credential")
	}
}

func TestLocalAccountStdinCancellation(t *testing.T) {
	input, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := boundedLocalInput(ctx, input); err == nil {
		t.Fatal("blocked input ignored cancellation")
	}
	if _, err := io.WriteString(writer, "data"); err == nil {
		t.Fatal("cancelled stdin remained open")
	}
}

func TestLocalAccountMFARecoveryOperatorInput(t *testing.T) {
	good := `{"username":"golf-admin","account_id":"1","golf_user_id":"2","expected_native_user_id":"42","expected_credential_version":"3","expected_mfa_version":"4","reason":"Console recovery after writer drain","acknowledge_warning":true,"writers_drained":true}`
	if _, e := parseLocalAccountCommand([]string{"local-account", "reset-mfa"}); e != nil {
		t.Fatal("operator action unavailable")
	}
	value, e := readLocalAccountInput(strings.NewReader(good), "reset-mfa")
	if e != nil || value.ExpectedNativeUserID != "42" || !value.WritersDrained || value.AccountID != "1" {
		t.Fatal("operator recovery envelope", e)
	}
	for _, body := range []string{strings.Replace(good, `"account_id":"1",`, "", 1), strings.Replace(good, `"reason":`, `"account_id":"2","reason":`, 1), strings.Replace(good, `"writers_drained":true`, `"writers_drained":null`, 1), strings.Replace(good, `"reason":`, `"forge_token":"private-secret","reason":`, 1), good + ` {}`} {
		if _, e := readLocalAccountInput(strings.NewReader(body), "reset-mfa"); e == nil || strings.Contains(e.Error(), "private-secret") {
			t.Fatal("unsafe console envelope accepted")
		}
	}
	if _, e := readLocalAccountInput(strings.NewReader(good), "reset-password"); e == nil {
		t.Fatal("MFA recovery silently became password reset")
	}
	var output bytes.Buffer
	if e := runLocalAccount(context.Background(), localAccountOptions{action: "reset-mfa", timeout: time.Second}, strings.NewReader(`{"username":"admin","forge_token":"private-secret"}`), &output); e == nil || strings.Contains(output.String(), "private-secret") {
		t.Fatal("operator output exposed secret")
	}
}

func TestLocalAccountOperatorInspectionInput(t *testing.T) {
	if _, e := parseLocalAccountCommand([]string{"local-account", "inspect"}); e != nil {
		t.Fatal("inspection action rejected")
	}
	if _, e := readLocalAccountInput(strings.NewReader(`{"username":"golf-admin"}`), "inspect"); e != nil {
		t.Fatal("readonly inspection input", e)
	}
	if _, e := readLocalAccountInput(strings.NewReader(`{"username":"golf-admin","password":"private-secret"}`), "inspect"); e == nil {
		t.Fatal("inspection accepted password")
	}
}
