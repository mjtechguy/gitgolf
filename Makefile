.PHONY: setup dev build cli test test-integration check helm-check fmt vet web-check generate generate-check qualify-git qualify-settings qualify-organization-admin qualify-public-repositories qualify-repository-access qualify-workflow-inspection qualify-instance-admin qualify-account-security qualify-repository-events up down
setup:
	./scripts/init-env.sh
dev: up
build:
	go build -o bin/golf-server ./cmd/golf
	go build -o bin/golf ./cmd/golfctl
	npm --prefix web ci
	npm --prefix web run build
cli:
	go build -o bin/golf ./cmd/golfctl
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
check: fmt vet test web-check generate-check
helm-check:
	python3 deploy/helm/golf/check.py
up: setup
	docker compose up -d --build
down:
	docker compose down
