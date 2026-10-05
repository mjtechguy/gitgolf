package server

import (
	"connectrpc.com/connect"
	"context"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"net/http"
)

// Specific public RPC messages preserve one shared domain operation; copying
// headers retains the managed cookie/Origin boundary in direct service calls.
func deploymentRequest[T any](message *T, headers http.Header) *connect.Request[T] {
	r := connect.NewRequest(message)
	for k, v := range headers {
		r.Header()[k] = v
	}
	return r
}
func (s *Server) CreateRepositoryDeployment(ctx context.Context, r *connect.Request[golfv1.CreateRepositoryDeploymentRequest]) (*connect.Response[golfv1.CreateRepositoryDeploymentResponse], error) {
	v, e := s.createRepositoryDeployment(ctx, r)
	if e != nil {
		return nil, deploymentError(e)
	}
	return connect.NewResponse(&golfv1.CreateRepositoryDeploymentResponse{Deployment: v.Msg.Deployment}), nil
}
func (s *Server) GetRepositoryDeployment(ctx context.Context, r *connect.Request[golfv1.GetRepositoryDeploymentRequest]) (*connect.Response[golfv1.GetRepositoryDeploymentResponse], error) {
	v, e := s.getRepositoryDeployment(ctx, deploymentRequest(&golfv1.RepositoryDeploymentRequest{Target: r.Msg.Target, DeploymentId: r.Msg.DeploymentId}, r.Header()))
	if e != nil {
		return nil, deploymentError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryDeploymentResponse{Deployment: v.Msg.Deployment}), nil
}
func (s *Server) ReviewRepositoryDeployment(ctx context.Context, r *connect.Request[golfv1.ReviewRepositoryDeploymentRequest]) (*connect.Response[golfv1.ReviewRepositoryDeploymentResponse], error) {
	v, e := s.reviewRepositoryDeployment(ctx, r)
	if e != nil {
		return nil, deploymentError(e)
	}
	return connect.NewResponse(&golfv1.ReviewRepositoryDeploymentResponse{Deployment: v.Msg.Deployment}), nil
}
func (s *Server) ActivateRepositoryDeployment(ctx context.Context, r *connect.Request[golfv1.ActivateRepositoryDeploymentRequest]) (*connect.Response[golfv1.ActivateRepositoryDeploymentResponse], error) {
	v, e := s.activateRepositoryDeployment(ctx, deploymentRequest(&golfv1.RepositoryDeploymentRequest{Target: r.Msg.Target, DeploymentId: r.Msg.DeploymentId}, r.Header()))
	if e != nil {
		return nil, deploymentError(e)
	}
	return connect.NewResponse(&golfv1.ActivateRepositoryDeploymentResponse{Deployment: v.Msg.Deployment}), nil
}
func (s *Server) RevokeRepositoryDeployment(ctx context.Context, r *connect.Request[golfv1.RevokeRepositoryDeploymentRequest]) (*connect.Response[golfv1.RevokeRepositoryDeploymentResponse], error) {
	v, e := s.revokeRepositoryDeployment(ctx, deploymentRequest(&golfv1.RepositoryDeploymentRequest{Target: r.Msg.Target, DeploymentId: r.Msg.DeploymentId}, r.Header()))
	if e != nil {
		return nil, deploymentError(e)
	}
	return connect.NewResponse(&golfv1.RevokeRepositoryDeploymentResponse{Deployment: v.Msg.Deployment}), nil
}
