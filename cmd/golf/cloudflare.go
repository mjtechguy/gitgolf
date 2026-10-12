package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"

	"github.com/mjtechguy/golf-git/internal/cloudflare"
)

func inspectCloudflare(ctx context.Context, args []string, out io.Writer) error {
	const usage = "usage: golf-server cloudflare inspect --account-id ID --namespace NAME [--profile NAME]; use a named cf OAuth profile or set CLOUDFLARE_API_TOKEN"
	if len(args) < 2 || args[1] != "inspect" {
		return errors.New(usage)
	}
	flags := flag.NewFlagSet("cloudflare inspect", flag.ContinueOnError)
	flags.SetOutput(io.Discard) // Invalid arguments may contain secrets; never echo them.
	accountID := flags.String("account-id", "", "selected Cloudflare account")
	namespace := flags.String("namespace", "", "selected Artifacts namespace")
	profile := flags.String("profile", "", "named cf OAuth profile")
	if err := flags.Parse(args[2:]); err != nil || flags.NArg() != 0 {
		return errors.New(usage)
	}
	var report cloudflare.Report
	var err error
	if *profile != "" {
		report, err = cloudflare.InspectProfile(ctx, *accountID, *namespace, *profile)
	} else {
		report, err = cloudflare.Inspect(ctx, *accountID, *namespace, os.Getenv("CLOUDFLARE_API_TOKEN"))
	}
	if err != nil {
		return err
	}
	if err = json.NewEncoder(out).Encode(report); err != nil {
		return errors.New("Cloudflare inspection report could not be written")
	}
	if !report.Accessible() {
		return errors.New("Cloudflare read inspection incomplete; inspect the per-service states")
	}
	return nil
}
