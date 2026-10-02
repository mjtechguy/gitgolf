.PHONY: setup dev build cli test test-integration check fmt vet web-check up down
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
check: fmt vet test web-check
up: setup
	docker compose up -d --build
down:
	docker compose down
