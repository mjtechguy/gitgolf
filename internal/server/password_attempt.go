package server

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

// A private reservation owns one charged account attempt in one exact window.
// The global ceiling is never refunded. Saturated account counters retain all
// charges: decrementing capped overflow could erase another failed guess.
type localPasswordAttempt struct {
	bucket   int16
	resetsAt time.Time
	spent    atomic.Bool
}

func (s *Server) reserveLocalPasswordAttempt(ctx context.Context, username string) (*localPasswordAttempt, error) {
	if s.db == nil {
		return nil, errStorageUnavailable
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, errStorageUnavailable
	}
	defer tx.Rollback()
	q := database.New(s.db).WithTx(tx)
	global, err := q.ConsumeLocalLoginLimit(ctx, database.ConsumeLocalLoginLimitParams{Bucket: 0, MaxAttempts: 120, WindowSeconds: 60})
	if err != nil {
		return nil, errStorageUnavailable
	}
	// ponytail: fixed1024 username buckets can collide; success releases only its
	// own reservation, never resets a colliding account's failed-attempt bucket.
	bucket := localLoginBucket(username)
	account, err := q.ConsumeReservedLocalLoginLimit(ctx, database.ConsumeReservedLocalLoginLimitParams{Bucket: bucket, MaxAttempts: 10, WindowSeconds: 300})
	if err != nil {
		return nil, errStorageUnavailable
	}
	if err = tx.Commit(); err != nil {
		return nil, errStorageUnavailable
	}
	if global > 120 || account.Attempts > 10 {
		return nil, errLocalRateLimited
	}
	if global < 1 || account.Attempts < 1 || account.ResetsAt.IsZero() {
		return nil, errStorageUnavailable
	}
	return &localPasswordAttempt{bucket: bucket, resetsAt: account.ResetsAt}, nil
}

func (s *Server) releaseLocalPasswordAttempt(ctx context.Context, reservation *localPasswordAttempt) error {
	if s.db == nil || reservation == nil || reservation.bucket < 1 || reservation.bucket > 1024 || reservation.resetsAt.IsZero() || !reservation.spent.CompareAndSwap(false, true) {
		return errStorageUnavailable
	}
	// No retry on SQL failure, cancellation, window replacement or saturation.
	// Zero changed rows conservatively retain the charge, never clear a window.
	_, err := database.New(s.db).ReleaseReservedLocalLoginLimit(ctx, database.ReleaseReservedLocalLoginLimitParams{Bucket: reservation.bucket, ResetsAt: reservation.resetsAt, MaxAttempts: 10})
	if err != nil {
		return errStorageUnavailable
	}
	return nil
}

func (s *Server) verifyLocalPasswordAttempt(ctx context.Context, username, password, encoded string) (bool, error) {
	reservation, err := s.reserveLocalPasswordAttempt(ctx, username)
	if err != nil {
		return false, err
	}
	correct, err := verifyLocalPassword(ctx, password, encoded)
	if err != nil || !correct {
		return false, err
	}
	if err = s.releaseLocalPasswordAttempt(ctx, reservation); err != nil {
		return false, err
	}
	return true, nil
}
