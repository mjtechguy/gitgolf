.PHONY: setup dev build cli test test-integration check helm-check fmt vet web-check generate generate-check qualify-git qualify-settings qualify-organization-admin qualify-public-repositories qualify-repository-access qualify-workflow-inspection qualify-instance-admin qualify-account-security qualify-repository-events qualify-automation-grants up down local-up local-stop local-status
REVIEW_ENV = $(if $(wildcard .env.review),--env-file .env.review,)
AGENT_COMPOSE = $(if $(wildcard .env.agents),--env-file .env.agents -f compose.agents.yaml,)
AGENT_SERVICE = $(if $(wildcard .env.agents),agent-worker,)
LOCAL_COMPOSE = docker compose --env-file .env --env-file .env.ci --env-file .env.storage -f compose.yaml -f compose.ci.yaml -f compose.storage.yaml $(AGENT_COMPOSE) $(REVIEW_ENV)
.DEFAULT_GOAL := setup
HTTPS_COMPOSE = $(LOCAL_COMPOSE) --env-file .env.https -f compose.https.yaml
ACTIVE_LOCAL_COMPOSE = $(LOCAL_COMPOSE)
HTTPS_IMAGE ?= $(shell docker inspect $$($(LOCAL_COMPOSE) ps -q golf) --format '{{.Image}}')
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
	python3 scripts/instance-account-disable-smoke.py --image "$(HTTPS_IMAGE)"
qualify-account-security:
	python3 scripts/account-lifecycle-smoke.py --image "$(HTTPS_IMAGE)"
qualify-automation-grants:
	python3 scripts/automation-grants-smoke.py --image "$(HTTPS_IMAGE)"
qualify-repository-events:
	python3 scripts/repository-events-smoke.py --image "$(HTTPS_IMAGE)"
qualify-public-repositories: cli
	python3 scripts/public-repositories-smoke.py --image "$(HTTPS_IMAGE)" --cli bin/golf
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
.PHONY: compatibility-check
compatibility-check:
	python3 scripts/compatibility/inventory.py --check
	python3 -m unittest discover -s scripts/compatibility -p 'test_*.py'
.PHONY: cloudflare-doctor cloudflare-install
# One-command Cloudflare deploy (deploy/alchemy/README.md). Pass flags with ARGS, e.g.
# make cloudflare-install ARGS='--yes --hostname golf.example.com --email you@example.com --content example'
cloudflare-doctor:
	python3 scripts/golf_cloudflare.py doctor $(ARGS)
cloudflare-install:
	python3 scripts/golf_cloudflare.py install $(ARGS)
.PHONY: cloudflare-check
cloudflare-check:
	node cloudflare/forge/capabilities-check.mjs
	node --test web/tests/stale-build.test.ts web/tests/runtime-capabilities.test.ts web/tests/repository-picture.test.ts web/tests/navigation-cache.test.ts web/tests/rpc-fetch.test.ts web/tests/native-api.test.ts web/tests/operations-metrics.test.ts
	node --test cloudflare/forge/*.test.mjs
	node --check cloudflare/forge/prepare.mjs
	node --check cloudflare/forge/prepare-proof.mjs
	node --check cloudflare/forge/ui-check.mjs
	node --check cloudflare/forge/repository-rpc-check.mjs
	node --check cloudflare/forge/ui-assets.mjs
	node --check cloudflare/forge/runtime-check.mjs
	node --check cloudflare/forge/review-runtime-check.mjs
	node --check cloudflare/forge/merge-runtime-check.mjs
	node --check cloudflare/forge/audit-runtime-check.mjs
	node --check cloudflare/forge/demo-check.mjs
	node --test cloudflare/control/worker.test.mjs
	node --check cloudflare/control/prepare.mjs
	node --check cloudflare/control/runtime-check.mjs
	python3 -m unittest discover -s scripts -p 'test_cloudflare_setup.py'
	python3 -m unittest discover -s scripts -p 'test_cloudflare_forge.py'
	python3 -m unittest discover -s scripts -p 'test_cloudflare_demo.py'
	python3 -m unittest discover -s scripts -p 'test_cloudflare_release.py'
	python3 -m unittest discover -s scripts -p 'test_golf_cloudflare.py'
	go test -race ./internal/cli -count=1
	go test -race ./internal/cloudflare ./cmd/golf -run 'TestInspectionBoundary|TestManagementInspectionBoundary|TestResourceClientBoundary|TestProfileInspectionBoundary|TestCloudflareCommand' -count=1
	node --check cloudflare/previews/prepare.mjs
	node --test cloudflare/previews/worker.test.mjs
	node --test cloudflare/qualification/worker.test.mjs
	node --check cloudflare/qualification/prepare.mjs
	node --test cloudflare/agents/*.test.mjs
	node --check cloudflare/agents/src/worker.mjs
	node --check cloudflare/agents/prepare.mjs
	python3 -m py_compile scripts/cloudflare-foundation-smoke.py scripts/cloudflare-product-smoke.py scripts/cloudflare-preview-smoke.py scripts/cloudflare_agents.py scripts/cloudflare-forge-smoke.py scripts/cloudflare_forge.py scripts/cloudflare_demo.py scripts/cloudflare_demo_cleanup.py
	python3 scripts/cloudflare_agents.py
	python3 scripts/cloudflare_registry_check_test.py
.PHONY: cloudflare-setup cloudflare-status cloudflare-stop
cloudflare-setup:
	python3 scripts/cloudflare_setup.py init $(CLOUDFLARE_SETUP_ARGS)
cloudflare-status:
	python3 scripts/cloudflare_setup.py status
cloudflare-stop:
	python3 scripts/cloudflare_setup.py stop
.PHONY: qualify-cloudflare-product
qualify-cloudflare-product:
	python3 scripts/cloudflare-product-smoke.py
check: fmt vet test web-check generate-check engine-check compatibility-check cloudflare-check
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

.PHONY: forgejo-setup forgejo-up forgejo-stop forgejo-qualify
forgejo-setup:
	$(MAKE) setup
forgejo-up: up
forgejo-stop:
	docker compose stop
forgejo-qualify:
	python3 scripts/forgejo-qualify.py --output .tmp/forgejo-qualification/receipt.json
