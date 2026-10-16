#!/usr/bin/env bash
# One-command self-hosted install: fresh clone -> running stack -> signed-in admin.
# Re-running is safe: an existing .env, Forgejo user and Golf account are kept.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

FORGEJO_CONFIG=/var/lib/gitea/custom/conf/app.ini  # Forgejo's upstream path
TOKEN_SCOPES=write:user,write:repository,read:issue,read:organization
DEFAULT_USERNAME=golf-admin
DEFAULT_EMAIL=admin@localhost.localdomain
MIN_DISK_GB=5
SECRETS_DIR=.tmp/local-account

USERNAME=""
EMAIL=""
ASSUME_YES=0
DRY_RUN=0
PROMPT_PASSWORD=0
SKIP_BUILD=0
UNINSTALL=0
READY_TIMEOUT=300
PROJECT_FLAG=""
HTTP_PORT_FLAG=""
FORGE_PORT_FLAG=""
SSH_PORT_FLAG=""

usage() {
	cat <<'EOF'
Usage: ./scripts/install.sh [options]

Installs the self-hosted Golf core (Golf, Forgejo, PostgreSQL) with Docker
Compose and enrolls the first Golf administrator.

  --username NAME      Admin username (3-64 chars: a-z 0-9 . _ -). Default offered: golf-admin
  --email ADDRESS      Admin email. Default offered: admin@localhost.localdomain
  --yes, -y            Non-interactive: accept defaults for anything not given
  --prompt-password    Type the Golf password instead of generating one
  --project NAME       Compose project name (new .env only; default golf-forgejo)
  --http-port PORT     Golf port (new .env only; default 8080)
  --forge-port PORT    Forgejo HTTP port (new .env only; default 3001)
  --ssh-port PORT      Forgejo SSH port (new .env only; default 2222)
  --ready-timeout SEC  Seconds to wait for /readyz (default 300)
  --no-build           Start without rebuilding the Golf image
  --dry-run            Run read-only checks and print the plan; change nothing
  --uninstall          Stop and remove containers; KEEP volumes and .env
  -h, --help           Show this help
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

need_arg() { if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value"; fi; }

while [ $# -gt 0 ]; do
	case "$1" in
	--username) need_arg "$@"; USERNAME=$2; shift 2 ;;
	--email) need_arg "$@"; EMAIL=$2; shift 2 ;;
	--yes | -y) ASSUME_YES=1; shift ;;
	--prompt-password) PROMPT_PASSWORD=1; shift ;;
	--project) need_arg "$@"; PROJECT_FLAG=$2; shift 2 ;;
	--http-port) need_arg "$@"; HTTP_PORT_FLAG=$2; shift 2 ;;
	--forge-port) need_arg "$@"; FORGE_PORT_FLAG=$2; shift 2 ;;
	--ssh-port) need_arg "$@"; SSH_PORT_FLAG=$2; shift 2 ;;
	--ready-timeout) need_arg "$@"; READY_TIMEOUT=$2; shift 2 ;;
	--no-build) SKIP_BUILD=1; shift ;;
	--dry-run) DRY_RUN=1; shift ;;
	--uninstall) UNINSTALL=1; shift ;;
	-h | --help) usage; exit 0 ;;
	*) usage >&2; die "unknown option: $1" ;;
	esac
done

case "$READY_TIMEOUT" in '' | *[!0-9]*) die "--ready-timeout must be a number of seconds" ;; esac

# Effective setting: process environment, then .env, then default (Compose's order).
setting() {
	local name=$1 default=$2 value
	value=$(printenv "$name" 2>/dev/null || true)
	if [ -z "$value" ] && [ -f .env ]; then
		value=$(sed -n "s/^${name}=//p" .env | tail -n 1)
	fi
	printf '%s' "${value:-$default}"
}

load_settings() {
	PROJECT=$(setting COMPOSE_PROJECT_NAME golf-forgejo)
	HTTP_PORT=$(setting GOLF_HTTP_PORT 8080)
	FORGE_PORT=$(setting GOLF_FORGE_HTTP_PORT 3001)
	SSH_PORT=$(setting GOLF_FORGE_SSH_PORT 2222)
	GOLF_URL=$(setting GOLF_PUBLIC_URL "http://localhost:${HTTP_PORT}")
	FORGE_URL=$(setting GOLF_FORGE_PUBLIC_URL "http://localhost:${FORGE_PORT}/")
	FORGE_URL=${FORGE_URL%/}
}

if [ -f .env ]; then
	for flag in "$PROJECT_FLAG" "$HTTP_PORT_FLAG" "$FORGE_PORT_FLAG" "$SSH_PORT_FLAG"; do
		[ -z "$flag" ] || { note ".env exists; --project/--*-port flags are ignored (edit .env instead)."; break; }
	done
else
	[ -z "$PROJECT_FLAG" ] || export COMPOSE_PROJECT_NAME=$PROJECT_FLAG
	[ -z "$HTTP_PORT_FLAG" ] || export GOLF_HTTP_PORT=$HTTP_PORT_FLAG
	[ -z "$FORGE_PORT_FLAG" ] || export GOLF_FORGE_HTTP_PORT=$FORGE_PORT_FLAG
	[ -z "$SSH_PORT_FLAG" ] || export GOLF_FORGE_SSH_PORT=$SSH_PORT_FLAG
fi
load_settings

compose() { docker compose -p "$PROJECT" "$@"; }

if [ "$UNINSTALL" = 1 ]; then
	info "Stopping project ${PROJECT} (containers and network only)"
	if [ "$DRY_RUN" = 1 ]; then
		note "would run: docker compose -p ${PROJECT} down"
	else
		compose down
	fi
	note "Data is kept: named volumes, .env and ${SECRETS_DIR}/."
	note "Start again with ./scripts/install.sh (or docker compose up -d)."
	note "To DESTROY all Golf/Forgejo/PostgreSQL data permanently (no undo), back up first, then run:"
	note "  docker compose -p ${PROJECT} down --volumes && rm .env"
	exit 0
fi

# ---------------------------------------------------------------- preflight
FAILURES=0
fail_check() {
	FAILURES=$((FAILURES + 1))
	printf '  FAIL %s\n       fix: %s\n' "$1" "$2" >&2
}
ok_check() { printf '  ok   %s\n' "$1"; }

port_free() {
	python3 - "$1" <<'PY'
import socket, sys
s = socket.socket()
# Like Docker, ignore TIME_WAIT leftovers; a live listener still fails the bind.
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(('127.0.0.1', int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
}

stack_running() {
	[ -n "$(compose ps -q --status running golf 2>/dev/null || true)" ]
}

preflight() {
	info "Checking prerequisites"
	case "$(uname -m)" in
	x86_64 | amd64 | aarch64 | arm64) ok_check "architecture $(uname -m)" ;;
	*) fail_check "unsupported architecture $(uname -m)" "use an amd64 or arm64 host" ;;
	esac
	if command -v python3 >/dev/null 2>&1; then ok_check "python3"; else
		fail_check "python3 not found" "install Python 3 (e.g. apt install python3, brew install python)"
	fi
	if command -v curl >/dev/null 2>&1; then ok_check "curl"; else
		fail_check "curl not found" "install curl (e.g. apt install curl)"
	fi
	if ! command -v docker >/dev/null 2>&1; then
		fail_check "docker not found" "install Docker Engine or Docker Desktop: https://docs.docker.com/engine/install/"
		return
	fi
	if docker info >/dev/null 2>&1; then ok_check "Docker daemon reachable"; else
		fail_check "cannot reach the Docker daemon" "start Docker (systemctl start docker / open Docker Desktop) and make sure your user can run 'docker info' (docker group or rootless context)"
		return
	fi
	local version
	if version=$(docker compose version --short 2>/dev/null); then
		case "$version" in
		v1.* | 1.*) fail_check "Docker Compose $version is too old" "install the Compose v2 plugin: https://docs.docker.com/compose/install/linux/" ;;
		*) ok_check "Docker Compose $version" ;;
		esac
	else
		fail_check "'docker compose' (v2 plugin) not available" "install the Compose v2 plugin: https://docs.docker.com/compose/install/linux/"
	fi
	if docker buildx version >/dev/null 2>&1; then ok_check "BuildKit (buildx)"; else
		fail_check "BuildKit/buildx not available" "install the docker-buildx plugin: https://docs.docker.com/build/install-buildx/"
	fi
	if [ "$DOCKER_BUILDKIT" = 0 ] 2>/dev/null; then
		fail_check "DOCKER_BUILDKIT=0 disables BuildKit" "unset DOCKER_BUILDKIT"
	fi
	local root avail_kb
	for root in "$ROOT" "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"; do
		if [ -z "$root" ] || [ ! -d "$root" ]; then continue; fi
		avail_kb=$(df -Pk "$root" | awk 'NR==2 {print $4}')
		if [ -n "$avail_kb" ] && [ "$avail_kb" -lt $((MIN_DISK_GB * 1024 * 1024)) ]; then
			fail_check "less than ${MIN_DISK_GB} GiB free on $root" "free disk space (docker system prune removes unused images)"
		else
			ok_check "disk space on $root"
		fi
	done
	if command -v python3 >/dev/null 2>&1; then
		local owner
		owner=$(docker ps --filter "label=com.docker.compose.project=${PROJECT}" \
			--format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u | head -n 1)
		if [ -n "$owner" ] && [ "$owner" != "$ROOT" ]; then
			fail_check "Compose project ${PROJECT} is already running from ${owner}" "use that checkout, or install this one under another name with --project NAME and free ports (before .env exists)"
		elif stack_running; then
			ok_check "project ${PROJECT} already running; port checks skipped"
		else
			local port name
			for pair in "Golf:$HTTP_PORT" "Forgejo HTTP:$FORGE_PORT" "Forgejo SSH:$SSH_PORT"; do
				name=${pair%:*}; port=${pair##*:}
				if port_free "$port"; then ok_check "port $port ($name) free"; else
					fail_check "port $port ($name) is in use" "stop whatever uses it, or start fresh with --http-port/--forge-port/--ssh-port (before .env exists) or set GOLF_HTTP_PORT/GOLF_FORGE_HTTP_PORT/GOLF_FORGE_SSH_PORT in .env"
				fi
			done
		fi
	fi
}

DOCKER_BUILDKIT=${DOCKER_BUILDKIT:-}
preflight
if [ "$FAILURES" -gt 0 ]; then
	[ "$DRY_RUN" = 1 ] || die "$FAILURES prerequisite check(s) failed; fix them and re-run."
	note "(dry run: continuing despite $FAILURES failed check(s))"
fi

# ------------------------------------------------------------ admin identity
USERNAME_RE='^[a-z0-9][a-z0-9._-]{2,63}$'
interactive() { [ "$ASSUME_YES" = 0 ] && [ -t 0 ]; }

ask() { # ask VAR "prompt" default
	local answer
	if interactive; then
		read -r -p "$2 [$3]: " answer || true
		printf -v "$1" '%s' "${answer:-$3}"
	elif [ "$ASSUME_YES" = 1 ]; then
		printf -v "$1" '%s' "$3"
	else
		die "no terminal for prompts: pass --username and --email, or --yes to accept defaults"
	fi
}

[ -n "$USERNAME" ] || ask USERNAME "Golf admin username" "$DEFAULT_USERNAME"
[ -n "$EMAIL" ] || ask EMAIL "Admin email" "$DEFAULT_EMAIL"
USERNAME=$(printf '%s' "$USERNAME" | tr '[:upper:]' '[:lower:]')
EMAIL=$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]')
printf '%s' "$USERNAME" | grep -Eq "$USERNAME_RE" ||
	die "username must be 3-64 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit"
case "$USERNAME" in
admin | api | assets | user | org | explore | login | repo | -) die "'$USERNAME' is reserved by Forgejo; choose another (e.g. golf-admin)" ;;
esac
printf '%s' "$EMAIL" | grep -Eq '^[^@[:space:]]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' ||
	die "email must look like name@example.com (a dotted domain is required)"

if [ "$DRY_RUN" = 1 ]; then
	cat <<EOF
==> Plan (dry run; nothing was changed)
    project:   ${PROJECT}
    1. $([ -f .env ] && echo ".env exists: keep it unchanged" || echo "./scripts/init-env.sh: write a private mode-0600 .env")
    2. docker compose -p ${PROJECT} up -d$([ "$SKIP_BUILD" = 1 ] || echo " --build")
    3. wait up to ${READY_TIMEOUT}s for ${GOLF_URL}/readyz (via 127.0.0.1:${HTTP_PORT})
    4. if Golf account '${USERNAME}' exists: skip enrollment
       else: create Forgejo admin '${USERNAME}' <${EMAIL}> unless present,
             generate a Forgejo token (scopes ${TOKEN_SCOPES}),
             $([ "$PROMPT_PASSWORD" = 1 ] && echo "prompt for" || echo "generate") a Golf password,
             enroll through 'golf local-account create' with a temporary 0600 JSON in ${SECRETS_DIR}/
    5. print Golf ${GOLF_URL}, Forgejo ${FORGE_URL} and stop/start/upgrade commands
EOF
	exit 0
fi

# ------------------------------------------------------------------ install
if [ -f .env ]; then
	info ".env exists; keeping it unchanged"
else
	info "Creating private .env"
	./scripts/init-env.sh
	load_settings
fi

info "Starting project ${PROJECT} (the first build takes several minutes)"
if [ "$SKIP_BUILD" = 1 ]; then compose up -d; else compose up -d --build; fi

failure_hints() {
	printf '\nNext steps:\n' >&2
	printf '  docker compose -p %s ps\n' "$PROJECT" >&2
	printf '  docker compose -p %s logs --tail=80 golf forgejo postgres\n' "$PROJECT" >&2
	printf 'Then re-run ./scripts/install.sh; it resumes safely.\n' >&2
}

info "Waiting for ${GOLF_URL}/readyz (timeout ${READY_TIMEOUT}s)"
READY_URL="http://127.0.0.1:${HTTP_PORT}/readyz"
start=$(date +%s)
while :; do
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$READY_URL" || true)
	[ "$code" = 200 ] && break
	elapsed=$(($(date +%s) - start))
	if [ "$elapsed" -ge 15 ] && ! stack_running; then
		printf '\n' >&2
		compose logs --tail=20 golf >&2 || true
		failure_hints
		die "the golf container stopped; see its log above"
	fi
	if [ "$elapsed" -ge "$READY_TIMEOUT" ]; then
		printf '\n' >&2
		failure_hints
		die "Golf did not become ready within ${READY_TIMEOUT}s (last HTTP status: ${code:-none})"
	fi
	printf '\r    waiting... %ss (HTTP %s)' "$elapsed" "${code:-000}"
	sleep 3
done
printf '\r    ready after %ss                 \n' "$(($(date +%s) - start))"

# --------------------------------------------------------------- enrollment
mkdir -p "$SECRETS_DIR"
chmod 700 .tmp "$SECRETS_DIR" 2>/dev/null || true
ENROLL_FILE=""
cleanup() { [ -z "$ENROLL_FILE" ] || rm -f "$ENROLL_FILE"; }
trap cleanup EXIT INT TERM

local_account() { # local_account ACTION < json
	compose exec -T golf golf local-account "$1"
}

json_state() {
	python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("state",""))
except Exception: print("")'
}

PASSWORD_FILE=""
info "Checking for Golf account '${USERNAME}'"
inspect=$(printf '{"username":"%s"}' "$USERNAME" | local_account inspect 2>&1 || true)
if [ "$(printf '%s' "$inspect" | json_state)" = complete ]; then
	note "Golf account '${USERNAME}' already exists; enrollment skipped."
	ACCOUNT_STATUS=existing
else
	case "$inspect" in
	*"resource not found"*) ;;
	*) printf '%s\n' "$inspect" >&2; failure_hints; die "could not inspect Golf local accounts" ;;
	esac
	forgejo_admin() { compose exec -T forgejo forgejo --config "$FORGEJO_CONFIG" admin user "$@"; }
	forgejo_users=$(forgejo_admin list) || die "could not list Forgejo users"
	if printf '%s\n' "$forgejo_users" | awk -v u="$USERNAME" 'NR>1 && $2==u {found=1} END {exit !found}'; then
		note "Forgejo user '${USERNAME}' already exists; reusing it."
	else
		info "Creating Forgejo administrator '${USERNAME}'"
		# Golf signs in with its own password; the random native password is not shown.
		forgejo_admin create --username "$USERNAME" --email "$EMAIL" --admin \
			--random-password --must-change-password=false >/dev/null ||
			die "Forgejo user creation failed (is '${USERNAME}' or '${EMAIL}' already taken in Forgejo?)"
	fi

	info "Generating a scoped Forgejo token (${TOKEN_SCOPES})"
	TOKEN=$(forgejo_admin generate-access-token --username "$USERNAME" \
		--token-name "golf-$(date +%Y%m%d%H%M%S)" --scopes "$TOKEN_SCOPES" --raw | tr -d '\r\n')
	[ -n "$TOKEN" ] || die "Forgejo returned no token"

	if [ "$PROMPT_PASSWORD" = 1 ]; then
		[ -t 0 ] || die "--prompt-password needs a terminal"
		while :; do
			read -r -s -p "Golf password for ${USERNAME} (15+ characters): " GOLF_PASSWORD; printf '\n'
			read -r -s -p "Repeat password: " again; printf '\n'
			[ "$GOLF_PASSWORD" = "$again" ] || { note "Passwords differ; try again."; continue; }
			[ "${#GOLF_PASSWORD}" -ge 15 ] && break
			note "Use at least 15 characters."
		done
		unset again
	else
		GOLF_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
	fi

	umask 077
	ENROLL_FILE="${SECRETS_DIR}/enrollment-$$.json"
	GOLF_USERNAME="$USERNAME" GOLF_EMAIL="$EMAIL" GOLF_PASSWORD="$GOLF_PASSWORD" GOLF_FORGE_TOKEN="$TOKEN" \
		python3 -c 'import json, os
print(json.dumps({"username": os.environ["GOLF_USERNAME"], "email": os.environ["GOLF_EMAIL"],
    "password": os.environ["GOLF_PASSWORD"], "forge_token": os.environ["GOLF_FORGE_TOKEN"],
    "is_instance_admin": True}))' >"$ENROLL_FILE"
	unset TOKEN

	info "Enrolling Golf administrator '${USERNAME}'"
	result=$(local_account create <"$ENROLL_FILE" 2>&1 || true)
	rm -f "$ENROLL_FILE"; ENROLL_FILE=""
	if [ "$(printf '%s' "$result" | json_state)" != complete ]; then
		printf '%s\n' "$result" >&2
		failure_hints
		die "Golf enrollment failed"
	fi
	if [ "$PROMPT_PASSWORD" = 0 ]; then
		PASSWORD_FILE="${SECRETS_DIR}/${PROJECT}-${USERNAME}-password.txt"
		printf '%s\n' "$GOLF_PASSWORD" >"$PASSWORD_FILE"
		chmod 600 "$PASSWORD_FILE"
	fi
	unset GOLF_PASSWORD
	ACCOUNT_STATUS=created
fi

# ------------------------------------------------------------------ summary
cat <<EOF

Golf is running.

  Golf:      ${GOLF_URL}
  Admin:     ${USERNAME} ($( [ "$ACCOUNT_STATUS" = created ] && echo "new" || echo "existing account, unchanged"))
EOF
if [ -n "$PASSWORD_FILE" ]; then
	cat <<EOF
  Password:  saved to ${ROOT}/${PASSWORD_FILE} (mode 0600)
             Move it into a password manager, then delete that file.
EOF
fi
cat <<EOF
  Forgejo:   ${FORGE_URL} (Git over SSH on localhost:${SSH_PORT})

  Stop:      docker compose -p ${PROJECT} stop
  Start:     docker compose -p ${PROJECT} start
  Upgrade:   git pull && docker compose -p ${PROJECT} up -d --build
  Logs:      docker compose -p ${PROJECT} logs --tail=80 golf forgejo
  Remove:    ./scripts/install.sh --uninstall   (keeps volumes and .env)

Back up .env together with the named volumes; never add --volumes to a routine restart.
EOF
