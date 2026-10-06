package server

import (
	"bytes"
	"connectrpc.com/connect"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"
)

func orgLabelWire(row forgeDiscussionLabel) (*golfv1.DiscussionLabel, error) {
	b, _ := json.Marshal([]forgeDiscussionLabel{row})
	m, e := discussionMetadata(forgeDiscussionMetadata{Labels: b})
	if e != nil || len(m.Labels) != 1 {
		return nil, errInvalidForgeResponse
	}
	return m.Labels[0], nil
}
func (s *Server) orgLabelAuthority(ctx context.Context, session string, token forgeCredential, name, id string, write bool) (actor User, org forgeOrganization, e error) {
	e = s.withForgeCaller(ctx, session, token, func(user User) error {
		actor = user
		return s.withOrganization(ctx, session, token, name, func(current forgeOrganization) error {
			org = current
			if id != "" && strconv.FormatInt(org.ID, 10) != id {
				return errOrganizationAdminConflict
			}
			if write {
				owner, e := s.organizationOwner(ctx, token, org, user)
				if e != nil {
					return e
				}
				if !owner {
					return forgeError{http.StatusForbidden}
				}
			}
			return nil
		})
	})
	return
}
func (s *Server) ListOrganizationLabels(ctx context.Context, req *connect.Request[golfv1.ListOrganizationLabelsRequest]) (*connect.Response[golfv1.ListOrganizationLabelsResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	m := req.Msg
	page, limit, e := pagination(pageFrom(m.Page))
	if e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	session := s.cookieValue(req.Header())
	actor, org, e := s.orgLabelAuthority(ctx, session, token, m.Organization, "", false)
	if e != nil {
		return nil, rpcError(e)
	}
	result := &golfv1.ListOrganizationLabelsResponse{OrganizationId: strconv.FormatInt(org.ID, 10), Page: &golfv1.PageResponse{}}
	result.CanManage, e = s.organizationOwner(ctx, token, org, actor)
	if e != nil {
		return nil, rpcError(e)
	}
	e = s.withNativePageSize(ctx, token, limit, func(span uint32) error {
		path := "/orgs/" + org.Name + "/labels?" + pageQuery(page, span).Encode()
		var rows []forgeDiscussionLabel
		headers, e := s.forge(ctx, http.MethodGet, path, token, nil, &rows)
		if e != nil {
			return e
		}
		if rows == nil || len(rows) > int(span) {
			return errInvalidForgeResponse
		}
		seen := map[int64]bool{}
		for _, r := range rows {
			if seen[r.ID] {
				return errInvalidForgeResponse
			}
			seen[r.ID] = true
			wire, e := orgLabelWire(r)
			if e != nil {
				return e
			}
			result.Labels = append(result.Labels, &golfv1.OrganizationLabel{Label: wire, Revision: labelRevision(wire)})
		}
		result.Page.NextPage = nextPage(headers, page)
		var repeat []forgeDiscussionLabel
		if _, e = s.forge(ctx, http.MethodGet, path, token, nil, &repeat); e != nil {
			return e
		}
		if !reflect.DeepEqual(rows, repeat) {
			return errOrganizationAdminConflict
		}
		return nil
	})
	if e == nil {
		_, _, e = s.orgLabelAuthority(ctx, session, token, m.Organization, result.OrganizationId, false)
	}
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(result), nil
}
func validateOrgLabel(m *golfv1.SubmitOrganizationLabelOperationRequest) error {
	if !validOrganizationName(m.Organization) || !creationKey.MatchString(m.OperationId) || m.Kind < 1 || m.Kind > 3 {
		return invalid("Bind the organization and original label operation UUID.")
	}
	if _, e := discussionID(m.OrganizationId); e != nil {
		return e
	}
	if m.Kind == 1 {
		if m.LabelId != "" || m.ExpectedRevision != "" {
			return invalid("Creation does not adopt an existing label.")
		}
	} else {
		if _, e := discussionID(m.LabelId); e != nil {
			return e
		}
		if !validAccessRevision(m.ExpectedRevision) {
			return invalid("Bind the original label revision.")
		}
	}
	if m.Kind == 3 {
		if m.Name != "" || m.Color != "" || m.Description != "" || m.Exclusive || m.Archived {
			return invalid("Deletion accepts only original identity.")
		}
		return nil
	}
	if !pullTitle(m.Name) || len(m.Name) > 255 || !discussionText(m.Description, 4096) || len(m.Color) != 6 || strings.ContainsFunc(m.Color, func(r rune) bool { return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') }) {
		return invalid("Use a trimmed label name, lowercase six-digit color and description up to4096 bytes.")
	}
	return nil
}
func orgLabelFingerprint(m *golfv1.SubmitOrganizationLabelOperationRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitOrganizationLabelOperationRequest)
	c.OperationId = ""
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	h := sha256.Sum256(b)
	return h[:]
}

type orgLabelRecord struct {
	ID, UserID, ActorID, OrgID, LabelID, ResultID   int64
	Forge, Operation, Org, Revision, Phase, Failure string
	Kind                                            int32
	Fingerprint                                     []byte
}

const orgLabelColumns = `id,user_id,forge_url,actor_id,operation_id,organization,organization_id,kind,label_id,expected_revision,input_fingerprint,phase,result_label_id,failure_code`

func scanOrgLabel(row interface{ Scan(...any) error }) (r orgLabelRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.Forge, &r.ActorID, &r.Operation, &r.Org, &r.OrgID, &r.Kind, &r.LabelID, &r.Revision, &r.Fingerprint, &r.Phase, &r.ResultID, &r.Failure)
	return
}
func orgLabelOperationWire(r orgLabelRecord) *golfv1.OrganizationLabelOperation {
	wire := &golfv1.OrganizationLabelOperation{Contract: "golf.organization.label-operation.v1", OperationId: r.Operation, ActorId: strconv.FormatInt(r.ActorID, 10), Organization: r.Org, OrganizationId: strconv.FormatInt(r.OrgID, 10), Kind: golfv1.OrganizationLabelOperationKind(r.Kind), ExpectedRevision: r.Revision, InputSha256: hex.EncodeToString(r.Fingerprint), Phase: golfv1.RepositoryReleasePublicationPhase(golfv1.RepositoryReleasePublicationPhase_value["REPOSITORY_RELEASE_PUBLICATION_PHASE_"+r.Phase]), FailureCode: r.Failure}
	if r.LabelID > 0 {
		wire.LabelId = strconv.FormatInt(r.LabelID, 10)
	}
	if r.ResultID > 0 {
		wire.ResultLabelId = strconv.FormatInt(r.ResultID, 10)
	}
	return wire
}
func lockOrgLabel(ctx context.Context, tx *sql.Tx, forge string, id int64) error {
	_, e := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1||'/organization-label/'||$2::text,0))`, forge, strconv.FormatInt(id, 10))
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}
func (s *Server) orgLabelPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitOrganizationLabelOperationRequest) error {
	_, _, e := s.orgLabelAuthority(ctx, session, token, m.Organization, m.OrganizationId, true)
	if e != nil {
		return e
	}
	if m.Kind == 1 {
		return nil
	}
	var row forgeDiscussionLabel
	if _, e = s.forge(ctx, http.MethodGet, "/orgs/"+m.Organization+"/labels/"+m.LabelId, token, nil, &row); e != nil {
		return e
	}
	wire, e := orgLabelWire(row)
	if e != nil {
		return e
	}
	if wire.Id != m.LabelId || labelRevision(wire) != m.ExpectedRevision {
		return errOrganizationAdminConflict
	}
	return nil
}
func (s *Server) GetOrganizationLabelOperation(ctx context.Context, req *connect.Request[golfv1.GetOrganizationLabelOperationRequest]) (*connect.Response[golfv1.GetOrganizationLabelOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if !validOrganizationName(m.Organization) || !creationKey.MatchString(m.OperationId) {
		return nil, rpcError(invalid("Inspect an original organization label operation."))
	}
	if _, e = discussionID(m.OrganizationId); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r orgLabelRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanOrgLabel(s.db.QueryRowContext(ctx, `SELECT `+orgLabelColumns+` FROM golf_organization_label_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e == nil && (r.Org != m.Organization || strconv.FormatInt(r.OrgID, 10) != m.OrganizationId) {
		e = errOrganizationAdminConflict
	}
	if e == nil {
		actor, _, f := s.orgLabelAuthority(ctx, session, token, r.Org, m.OrganizationId, true)
		e = f
		if e == nil && actor.ID != r.ActorID {
			e = errUnauthenticated
		}
	}
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetOrganizationLabelOperationResponse{Operation: orgLabelOperationWire(r)}), nil
}
func (s *Server) SubmitOrganizationLabelOperation(ctx context.Context, req *connect.Request[golfv1.SubmitOrganizationLabelOperationRequest]) (*connect.Response[golfv1.SubmitOrganizationLabelOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateOrgLabel(m); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, _, e := s.orgLabelAuthority(ctx, session, token, m.Organization, m.OrganizationId, true)
	if e != nil {
		return nil, rpcError(e)
	}
	orgID, _ := discussionID(m.OrganizationId)
	labelID := int64(0)
	if m.LabelId != "" {
		labelID, _ = discussionID(m.LabelId)
	}
	fingerprint := orgLabelFingerprint(m)
	var r orgLabelRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if e := lockOrgLabel(ctx, tx, s.config.GiteaURL, orgID); e != nil {
			return e
		}
		var e error
		r, e = scanOrgLabel(tx.QueryRowContext(ctx, `SELECT `+orgLabelColumns+` FROM golf_organization_label_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(r.Fingerprint, fingerprint) {
				return errOrganizationAdminConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanOrgLabel(tx.QueryRowContext(ctx, `INSERT INTO golf_organization_label_operations(user_id,forge_url,actor_id,operation_id,organization,organization_id,kind,label_id,expected_revision,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING `+orgLabelColumns, c.UserID, s.config.GiteaURL, actor.ID, m.OperationId, m.Organization, orgID, int32(m.Kind), labelID, m.ExpectedRevision, fingerprint))
		if e != nil {
			return errStorageUnavailable
		}
		fresh = true
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	if fresh {
		phase := "DISPATCH_UNKNOWN"
		failure := ""
		if e = s.orgLabelPreflight(ctx, session, token, m); e != nil {
			phase = "REJECTED"
			failure = "preflight_refused"
		}
		e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
			if e := lockOrgLabel(ctx, tx, r.Forge, r.OrgID); e != nil {
				return e
			}
			if c.UserID != r.UserID {
				return errUnauthenticated
			}
			_, _, e := s.orgLabelAuthority(ctx, session, token, r.Org, m.OrganizationId, true)
			if e != nil {
				return e
			}
			r, e = scanOrgLabel(tx.QueryRowContext(ctx, `UPDATE golf_organization_label_operations SET phase=$1,failure_code=$2 WHERE id=$3 AND phase='RESERVED' RETURNING `+orgLabelColumns, phase, failure, r.ID))
			if e != nil {
				return errStorageUnavailable
			}
			return nil
		})
		if e != nil {
			return nil, rpcError(e)
		}
		if phase == "DISPATCH_UNKNOWN" {
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				if e := lockOrgLabel(ctx, tx, r.Forge, r.OrgID); e != nil {
					return e
				}
				if c.UserID != r.UserID {
					return errUnauthenticated
				}
				if e := s.orgLabelPreflight(ctx, session, token, m); e != nil {
					return e
				}
				path := "/orgs/" + m.Organization + "/labels"
				method := http.MethodPost
				status := http.StatusCreated
				var payload any = map[string]any{"name": m.Name, "color": m.Color, "description": m.Description, "exclusive": m.Exclusive, "is_archived": m.Archived}
				var receipt forgeDiscussionLabel
				var output any = &receipt
				if m.Kind != 1 {
					path += "/" + m.LabelId
					method = http.MethodPatch
					status = http.StatusOK
				}
				if m.Kind == 3 {
					method = http.MethodDelete
					status = http.StatusNoContent
					payload = nil
					output = nil
				}
				if _, e := s.forgeJSON(ctx, method, path, token, payload, output, status); e != nil {
					return nil
				}
				resultID := int64(0)
				if m.Kind == 3 {
					var after forgeDiscussionLabel
					_, e := s.forge(ctx, http.MethodGet, path, token, nil, &after)
					var native forgeError
					if !errors.As(e, &native) || native.status != http.StatusNotFound {
						return nil
					}
				} else {
					wire, e := orgLabelWire(receipt)
					if e != nil || m.Kind == 2 && wire.Id != m.LabelId || wire.Name != m.Name || wire.Color != m.Color || wire.Description != m.Description || wire.Exclusive != m.Exclusive || wire.Archived != m.Archived {
						return nil
					}
					var after forgeDiscussionLabel
					if _, e = s.forge(ctx, http.MethodGet, "/orgs/"+m.Organization+"/labels/"+wire.Id, token, nil, &after); e != nil {
						return nil
					}
					current, e := orgLabelWire(after)
					if e != nil || labelRevision(current) != labelRevision(wire) {
						return nil
					}
					resultID = receipt.ID
				}
				current, _, e := s.orgLabelAuthority(ctx, session, token, r.Org, m.OrganizationId, true)
				if e != nil || current.ID != r.ActorID {
					return nil
				}
				r, e = scanOrgLabel(tx.QueryRowContext(ctx, `UPDATE golf_organization_label_operations SET phase='SUCCEEDED',result_label_id=$1 WHERE id=$2 AND phase='DISPATCH_UNKNOWN' RETURNING `+orgLabelColumns, resultID, r.ID))
				if e != nil {
					return errStorageUnavailable
				}
				return nil
			})
			if e != nil {
				return nil, rpcError(e)
			}
		}
	}
	current, _, e := s.orgLabelAuthority(ctx, session, token, r.Org, m.OrganizationId, true)
	if e != nil {
		return nil, rpcError(e)
	}
	if current.ID != r.ActorID {
		return nil, rpcError(errUnauthenticated)
	}
	return connect.NewResponse(&golfv1.SubmitOrganizationLabelOperationResponse{Operation: orgLabelOperationWire(r)}), nil
}
