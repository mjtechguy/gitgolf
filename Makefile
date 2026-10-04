.PHONY: setup dev build cli test test-integration check helm-check fmt vet web-check generate generate-check qualify-git qualify-settings qualify-organization-admin qualify-public-repositories qualify-repository-access qualify-workflow-inspection qualify-instance-admin qualify-account-security qualify-repository-events qualify-automation-grants up down local-up local-stop local-status
REVIEW_ENV = $(if $(wildcard .env.review),--env-file .env.review,)
AGENT_COMPOSE = $(if $(wildcard .env.agents),--env-file .env.agents -f compose.agents.yaml,)
AGENT_SERVICE = $(if $(wildcard .env.agents),agent-worker,)
LOCAL_COMPOSE = docker compose --env-file .env --env-file .env.ci --env-file .env.storage -f compose.yaml -f compose.ci.yaml -f compose.storage.yaml $(AGENT_COMPOSE) $(REVIEW_ENV)
.DEFAULT_GOAL := setup
HTTPS_COMPOSE = $(LOCAL_COMPOSE) --env-file .env.https -f compose.https.yaml
ACTIVE_LOCAL_COMPOSE = $(LOCAL_COMPOSE)
HTTPS_IMAGE ?= $(shell docker inspect golf-golf-1 --format '{{.Image}}')
.PHONY: local-https-up local-https-stop local-https-status local-https-certificate qualify-https
local-https-up: ACTIVE_LOCAL_COMPOSE = $(HTTPS_COMPOSE)
local-https-up: .env.https local-up
	$(HTTPS_COMPOSE) up -d caddy
local-https-stop:
	$(HTTPS_COMPOSE) stop
local-https-status:
	$(HTTPS_COMPOSE) ps
local-https-certificate:
	mkdir -p .tmp/https
	$(HTTPS_COMPOSE) cp caddy:/data/caddy/pki/authorities/local/root.crt .tmp/https/root.crt
qualify-https:
	python3 scripts/https-compose-smoke.py --image "$(HTTPS_IMAGE)"
setup:
	./scripts/init-env.sh
dev: local-up
build:
	go build -o bin/golf-server ./cmd/golf
	go build -o bin/golf ./cmd/golfctl
	npm --prefix web ci
	npm --prefix web run build
cli:
	go build -o bin/golf ./cmd/golfctl
.PHONY: qualify-pull-workspace
qualify-pull-workspace:
	python3 scripts/pull-workspace-smoke.py

.PHONY: qualify-pull-mutations
qualify-pull-mutations:
	python3 scripts/pull-mutations-smoke.py

.PHONY: qualify-pull-reviews qualify-pull-review-native qualify-protected-boundary
qualify-pull-reviews:
	python3 scripts/pull-review-mutations-smoke.py
qualify-pull-review-native:
	python3 scripts/pull-review-native-probe.py
.PHONY: qualify-pull-review-comments qualify-pull-review-comments-native
qualify-pull-review-comments: cli
	python3 scripts/pull-review-comments-smoke.py
qualify-pull-review-comments-native:
	python3 scripts/pull-review-comments-native-probe.py
qualify-protected-boundary:
	python3 -m unittest discover -s scripts/protected-boundary -p 'test_*.py'
	python3 scripts/protected-boundary/qualify.py

.PHONY: qualify-issue-updates
qualify-issue-updates:
	python3 scripts/issue-updates-smoke.py
qualify-git: cli
	python3 scripts/smoke.py --cli bin/golf
	python3 scripts/git-access-smoke.py
qualify-settings:
	python3 scripts/repository-settings-smoke.py
qualify-organization-admin:
	python3 scripts/organization-admin-smoke.py
qualify-repository-access:
	python3 scripts/repository-access-smoke.py
qualify-workflow-inspection:
	python3 scripts/workflow-config-smoke.py
qualify-instance-admin:
	python3 scripts/instance-account-disable-smoke.py --image golf-golf:latest
qualify-account-security:
	python3 scripts/account-lifecycle-smoke.py --image golf-golf:latest
qualify-automation-grants:
	python3 scripts/automation-grants-smoke.py --image golf-golf:latest
qualify-repository-events:
	python3 scripts/repository-events-smoke.py --image golf-golf:latest
qualify-public-repositories: cli
	python3 scripts/public-repositories-smoke.py --image golf-golf:latest --cli bin/golf
test:
	go test ./...
test-integration:
	@test -n "$$GOLF_TEST_DATABASE_URL" || (echo 'Set GOLF_TEST_DATABASE_URL to an isolated test database'; exit 1)
	go test -race ./... -count=1
fmt:
	@test -z "$$(gofmt -l cmd internal)" || (gofmt -l cmd internal; exit 1)
vet:
	go vet ./...
web-check:
	npm --prefix web run check
generate:
	./scripts/generate.sh
generate-check:
	./scripts/generate.sh --check
# The maintained engine is a separate module, outside root go test ./....
.PHONY: engine-check
engine-check:
	python3 engines/act/verify_upstream_source.py
	go -C engines/act vet ./...
	go -C engines/act test ./...
	go -C engines/act/third_party/act test ./pkg/runner
check: fmt vet test web-check generate-check engine-check
helm-check:
	python3 deploy/helm/golf/check.py
up: setup
	docker compose up -d --build
down:
	docker compose down
local-up: setup
	python3 scripts/init-ci-env.py
	python3 scripts/init-storage-env.py
	$(ACTIVE_LOCAL_COMPOSE) stop runner $(AGENT_SERVICE)
	$(ACTIVE_LOCAL_COMPOSE) up -d --build golf rustfs
	$(ACTIVE_LOCAL_COMPOSE) exec -T golf golf objectstore initialize
	$(ACTIVE_LOCAL_COMPOSE) build runner $(AGENT_SERVICE)
	$(ACTIVE_LOCAL_COMPOSE) up -d --no-build runner $(AGENT_SERVICE)
local-stop:
	$(LOCAL_COMPOSE) stop
local-status:
	$(LOCAL_COMPOSE) ps

.PHONY: local-agents-up
local-agents-up: local-up
	docker build -f Dockerfile.codex -t golf-codex-task:0.160.0 .
	python3 scripts/init-agent-env.py
	$(MAKE) local-up

.PHONY: qualify-path-history
qualify-path-history: cli
	python3 scripts/path-history-smoke.py

.PHONY: qualify-pull-diff-binding qualify-pull-inline-native qualify-reviewer-publication-native
qualify-pull-diff-binding: cli
	python3 scripts/pull-diff-binding-smoke.py
qualify-pull-inline-native:
	python3 scripts/pull-inline-write-native-probe.py
qualify-reviewer-publication-native:
	python3 scripts/reviewer-publication-native-proof.py

.PHONY: qualify-pull-review-drafts qualify-pull-review-drafts-browser
qualify-pull-review-drafts:
	python3 scripts/pull-review-drafts-smoke.py --stack-root "$(CURDIR)"
qualify-pull-review-drafts-browser:
	python3 scripts/pull-review-drafts-smoke.py --stack-root "$(CURDIR)" --browser

.PHONY: qualify-pull-inline-publication-native qualify-pull-inline-publication-browser
qualify-pull-inline-publication-native:
	python3 scripts/pull-inline-review-publication-native-proof.py --stack-root "$(CURDIR)"
qualify-pull-inline-publication-browser:
	python3 scripts/pull-inline-review-publication-smoke.py --stack-root "$(CURDIR)"

.PHONY: qualify-source-identity
qualify-source-identity: cli
	python3 scripts/source-identity-smoke.py --stack-root "$(CURDIR)" --cli bin/golf
