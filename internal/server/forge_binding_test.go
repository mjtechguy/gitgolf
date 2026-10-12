package server

import "testing"

func TestForgeInstallationBindingRejectsAuthorityReplacement(t *testing.T) {
	db := testDatabase(t)
	c, err := NormalizeForgeConfig(Config{ForgeKind: "forgejo", ForgeInstanceID: "ba09ae45-092f-4b4d-9e17-c6b848e5d95c", ForgeURL: "https://forge.invalid"})
	if err != nil {
		t.Fatal(err)
	}
	if err = BindForgeInstallation(t.Context(), db, c); err != nil {
		t.Fatal(err)
	}
	if err = BindForgeInstallation(t.Context(), db, c); err != nil {
		t.Fatal("restart refused", err)
	}
	for _, change := range []func(*Config){
		func(c *Config) { c.ForgeKind = "gitea" },
		func(c *Config) { c.GiteaURL = "https://elsewhere.invalid" },
		func(c *Config) { c.ForgeInstanceID = "ab09ae45-092f-4b4d-9e17-c6b848e5d95c" },
		func(c *Config) { c.GiteaWorkflowDirs = ".github/workflows" },
	} {
		other := c
		change(&other)
		if BindForgeInstallation(t.Context(), db, other) == nil {
			t.Fatal("authority replacement accepted")
		}
	}
	if err = BindForgeInstallation(t.Context(), db, c); err != nil {
		t.Fatal("rejection changed original binding", err)
	}
}

func TestForgejoCannotAdoptUnmappedLegacyUsers(t *testing.T) {
	db := testDatabase(t)
	if _, err := db.Exec("INSERT INTO golf_users(forge_url,forge_user_id,login) VALUES('https://old.invalid',1,'existing')"); err != nil {
		t.Fatal(err)
	}
	c, err := NormalizeForgeConfig(Config{ForgeKind: "forgejo", ForgeInstanceID: "ba09ae45-092f-4b4d-9e17-c6b848e5d95c", ForgeURL: "https://old.invalid"})
	if err != nil {
		t.Fatal(err)
	}
	if BindForgeInstallation(t.Context(), db, c) == nil {
		t.Fatal("adopted a source user's numeric ID")
	}
	var n int
	if err = db.QueryRow("SELECT count(*) FROM golf_forge_installation").Scan(&n); err != nil || n != 0 {
		t.Fatal("failed binding wrote state", err)
	}
}
