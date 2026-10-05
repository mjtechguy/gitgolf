// Package objectstore stores private, hash-verified CI source snapshots through S3.
package objectstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	"github.com/aws/smithy-go/logging"
)

const MaxSourceBytes int64 = 16 << 20
const MaxArtifactBytes int64 = 10 << 20
const operationTimeout = 30 * time.Second

var (
	ErrConfiguration   = errors.New("object storage configuration is invalid")
	ErrUnavailable     = errors.New("object storage is unavailable")
	ErrDenied          = errors.New("object storage access denied")
	ErrNotFound        = errors.New("object storage object or bucket not found")
	ErrIntegrity       = errors.New("object storage content verification failed")
	ErrTooLarge        = errors.New("object storage content exceeds the size limit")
	ErrConflict        = errors.New("object storage key already contains different content")
	keyPattern         = regexp.MustCompile(`^ci-sources/[a-f0-9]{64}\.tar$`)
	artifactKeyPattern = regexp.MustCompile(`^ci-artifacts/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/[a-f0-9]{32}/[a-f0-9]{64}\.tar$`)
	shaPattern         = regexp.MustCompile(`^[a-f0-9]{64}$`)
	prefixPattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]*$`)
	bucketPattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	regionPattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
)

type Config struct {
	Endpoint, Bucket, Region, Prefix           string
	AccessKeyID, SecretAccessKey, SessionToken string
	PathStyle, AllowHTTP                       bool
}

type Store struct {
	client                 *s3.Client
	bucket, prefix, region string
}

// ValidateConfig checks only supplied values; it performs no I/O or credential discovery.
func ValidateConfig(c Config) error {
	if !bucketPattern.MatchString(c.Bucket) || strings.Contains(c.Bucket, "..") || net.ParseIP(c.Bucket) != nil || !regionPattern.MatchString(c.Region) {
		return ErrConfiguration
	}
	if c.Prefix != "" && (len(c.Prefix) > 256 || !prefixPattern.MatchString(c.Prefix) || path.Clean(c.Prefix) != c.Prefix || strings.HasSuffix(c.Prefix, "/")) {
		return ErrConfiguration
	}
	if (c.AccessKeyID == "") != (c.SecretAccessKey == "") || (c.SessionToken != "" && c.AccessKeyID == "") {
		return ErrConfiguration
	}
	if c.Endpoint != "" {
		u, err := url.Parse(c.Endpoint)
		if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" || (u.Path != "" && u.Path != "/") || u.RawPath != "" || (u.Scheme != "https" && !(u.Scheme == "http" && c.AllowHTTP)) {
			return ErrConfiguration
		}
	}
	return nil
}

func New(ctx context.Context, c Config) (*Store, error) {
	if err := ValidateConfig(c); err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.ResponseHeaderTimeout = 15 * time.Second
	client := &http.Client{Transport: transport, Timeout: operationTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	options := []func(*config.LoadOptions) error{
		config.WithRegion(c.Region), config.WithHTTPClient(client), config.WithRetryMaxAttempts(3),
		config.WithLogger(logging.Nop{}),
		config.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
		config.WithResponseChecksumValidation(aws.ResponseChecksumValidationWhenRequired),
	}
	if c.AccessKeyID != "" {
		options = append(options, config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(c.AccessKeyID, c.SecretAccessKey, c.SessionToken)))
	}
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	cfg, err := config.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return nil, safeError(ctx, err)
	}
	sdk := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = nil // An explicit, validated endpoint takes precedence over ambient SDK endpoint overrides.
		if c.Endpoint != "" {
			o.BaseEndpoint = aws.String(c.Endpoint)
		}
		o.UsePathStyle = c.PathStyle
		o.Logger = logging.Nop{}
		o.ClientLogMode = 0
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		o.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	})
	return &Store{client: sdk, bucket: c.Bucket, prefix: c.Prefix, region: c.Region}, nil
}

// ProbeBucket checks authenticated bucket accessibility. It does not prove write,
// conditional-create, retention, durability or recovery capability.
func (s *Store) ProbeBucket(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	_, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)})
	return safeError(ctx, err)
}

// CreateBucket is explicit operator provisioning, never an application write fallback.
func (s *Store) CreateBucket(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	// Avoid reissuing CreateBucket for an existing bucket: AWS us-east-1 can
	// reset its ACL on a repeated successful create.
	if err := s.ProbeBucket(ctx); err == nil {
		return nil
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	input := &s3.CreateBucketInput{Bucket: aws.String(s.bucket)}
	if s.region != "us-east-1" && s.region != "auto" {
		input.CreateBucketConfiguration = &types.CreateBucketConfiguration{LocationConstraint: types.BucketLocationConstraint(s.region)}
	}
	_, err := s.client.CreateBucket(ctx, input)
	if apiCode(err) == "BucketAlreadyOwnedByYou" {
		return s.ProbeBucket(ctx)
	}
	return safeError(ctx, err)
}

func (s *Store) objectKey(key, expectedSHA string) (string, error) {
	if !shaPattern.MatchString(expectedSHA) || !keyPattern.MatchString(key) {
		return "", ErrConfiguration
	}
	if s.prefix != "" {
		return s.prefix + "/" + key, nil
	}
	return key, nil
}

// PutImmutable never deliberately replaces an existing key. Conditional creation
// requires a provider qualified to enforce If-None-Match: *; this is not WORM.
// Readback verifies both successful writes and ambiguous/existing outcomes.
func (s *Store) PutImmutable(ctx context.Context, key string, source []byte, expectedSHA string) error {
	objectKey, err := s.objectKey(key, expectedSHA)
	if err != nil {
		return err
	}
	return s.putImmutableObject(ctx, objectKey, source, expectedSHA, MaxSourceBytes)
}

// Artifact methods admit only an exact run/attempt/content key; ordinary source
// methods retain their original namespace. No public URLs or worker credentials.
func (s *Store) artifactObjectKey(key, expectedSHA string) (string, error) {
	if !shaPattern.MatchString(expectedSHA) || !artifactKeyPattern.MatchString(key) || !strings.HasSuffix(key, "/"+expectedSHA+".tar") {
		return "", ErrConfiguration
	}
	if s.prefix != "" {
		return s.prefix + "/" + key, nil
	}
	return key, nil
}
func (s *Store) PutArtifactImmutable(ctx context.Context, key string, archive []byte, expectedSHA string) error {
	objectKey, err := s.artifactObjectKey(key, expectedSHA)
	if err != nil {
		return err
	}
	return s.putImmutableObject(ctx, objectKey, archive, expectedSHA, MaxArtifactBytes)
}
func (s *Store) GetArtifactVerified(ctx context.Context, key, expectedSHA string, maxBytes int64) ([]byte, error) {
	objectKey, err := s.artifactObjectKey(key, expectedSHA)
	if err != nil {
		return nil, err
	}
	if maxBytes < 1 || maxBytes > MaxArtifactBytes {
		return nil, ErrConfiguration
	}
	return s.getVerifiedObject(ctx, objectKey, expectedSHA, maxBytes)
}
func (s *Store) putImmutableObject(ctx context.Context, objectKey string, source []byte, expectedSHA string, maxBytes int64) error {
	if int64(len(source)) > maxBytes {
		return ErrTooLarge
	}
	if digest(source) != expectedSHA {
		return ErrIntegrity
	}
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	_, putErr := s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey), Body: bytes.NewReader(source), ContentLength: aws.Int64(int64(len(source))), ContentType: aws.String("application/x-tar"), IfNoneMatch: aws.String("*")})
	if ctx.Err() != nil {
		return ctx.Err()
	}
	// Even a successful provider response is not evidence of the object's contents.
	_, readErr := s.getVerifiedObject(ctx, objectKey, expectedSHA, maxBytes)
	if readErr == nil {
		return nil
	}
	if errors.Is(readErr, ErrIntegrity) {
		return ErrConflict
	}
	if putErr != nil {
		return safeError(ctx, putErr)
	}
	return readErr
}

func (s *Store) GetVerified(ctx context.Context, key, expectedSHA string, maxBytes int64) ([]byte, error) {
	objectKey, err := s.objectKey(key, expectedSHA)
	if err != nil {
		return nil, err
	}
	if maxBytes < 1 || maxBytes > MaxSourceBytes {
		return nil, ErrConfiguration
	}
	return s.getVerifiedObject(ctx, objectKey, expectedSHA, maxBytes)
}
func (s *Store) getVerifiedObject(ctx context.Context, objectKey, expectedSHA string, maxBytes int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey)})
	if err != nil {
		return nil, safeError(ctx, err)
	}
	defer out.Body.Close()
	if out.ContentLength != nil && *out.ContentLength > maxBytes {
		return nil, ErrTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(out.Body, maxBytes+1))
	if err != nil {
		return nil, safeError(ctx, err)
	}
	if int64(len(data)) > maxBytes {
		return nil, ErrTooLarge
	}
	if out.ContentLength != nil && *out.ContentLength != int64(len(data)) {
		return nil, ErrIntegrity
	}
	if digest(data) != expectedSHA {
		return nil, ErrIntegrity
	}
	return data, nil
}

func digest(data []byte) string { hash := sha256.Sum256(data); return hex.EncodeToString(hash[:]) }
func apiCode(err error) string {
	var api smithy.APIError
	if errors.As(err, &api) {
		return api.ErrorCode()
	}
	return ""
}
func safeError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	switch apiCode(err) {
	case "AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken", "InvalidToken", "Forbidden":
		return ErrDenied
	case "NoSuchKey", "NoSuchBucket", "NotFound":
		return ErrNotFound
	case "PreconditionFailed", "ConditionalRequestConflict", "BucketAlreadyExists":
		return ErrConflict
	default:
		return ErrUnavailable
	}
}
