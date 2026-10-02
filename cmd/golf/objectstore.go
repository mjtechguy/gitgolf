package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"time"

	"github.com/mjtechguy/golf-git/internal/objectstore"
)

func initializeObjectStore(ctx context.Context, args []string, out io.Writer) error {
	if len(args) != 2 || args[1] != "initialize" {
		return errors.New("usage: golf objectstore initialize; connection credentials must come from operator environment")
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	store, err := objectstore.New(ctx, serverConfig().ObjectStoreConfig)
	if err != nil {
		return errors.New("object storage configuration is invalid")
	}
	if err = store.CreateBucket(ctx); err != nil {
		return errors.New("object bucket provisioning failed; inspect the configured destination before retrying")
	}
	probe := []byte("Golf private object-store activation probe v1\n")
	sum := sha256.Sum256(probe)
	sha := hex.EncodeToString(sum[:])
	if err = store.PutImmutable(ctx, "ci-sources/"+sha+".tar", probe, sha); err != nil {
		return errors.New("object storage write/read verification failed")
	}
	_, err = io.WriteString(out, "Object bucket is accessible and controlled source write/read verification passed.\n")
	return err
}
