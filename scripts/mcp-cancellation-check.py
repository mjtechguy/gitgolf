#!/usr/bin/env python3
"""Check raw stdio cancellation against a disposable HTTP fixture, not Gitea.

Exercises both advertised revisions and the bounded stdio input boundary.
The fixture holds a read until the client closes its socket, making a response
after cancellation observable without a completion/cancellation race. Requires
no late response in either revision; this is bounded compatibility evidence,
not a complete protocol-conformance suite or live-provider qualification.
Legacy ID reuse is deliberately invalid client traffic tested for robustness;
2025-11-25 clients must use fresh IDs throughout a session.
"""
import argparse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import secrets
import select
import socket
import subprocess
import sys
import threading
import time


class Fixture(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, api_token=False):
        super().__init__(("127.0.0.1", 0), Handler)
        self.api_token = api_token
        self.token = 'golf_ro_' + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=') if api_token else secrets.token_hex(24)
        self.cookie = secrets.token_hex(24)
        self.origin = f"http://127.0.0.1:{self.server_port}"
        self.started = threading.Event()
        self.aborted = threading.Event()
        self.logged_out = threading.Event()
        self.release = threading.Event()
        self.failed = threading.Event()
        self.calls = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            assert 0 < length < 4096
            body = json.loads(self.rfile.read(length))
            assert self.headers.get("Origin") == self.server.origin
            assert self.headers.get("Connect-Protocol-Version") == "1"
            assert self.headers.get("Authorization", '') == ('Bearer ' + self.server.token if self.server.api_token else '')
            self.server.calls.append(self.path)
            prefix = "/rpc/golf.v1."
            if self.server.api_token:
                assert not self.headers.get('Cookie')
                assert self.path == prefix + "RepositoryService/ListRepositories"
            elif self.path == prefix + "SessionService/LoginWithGiteaToken":
                assert body == {"token": self.server.token}
                self.reply({"user": {"id": "1"}}, cookie=True)
                return
            if not self.server.api_token:
                assert self.headers.get("Cookie") == "golf_session=" + self.server.cookie
            if self.path == prefix + "SessionService/Logout":
                self.reply({})
                self.server.logged_out.set()
                return
            assert self.path == prefix + "RepositoryService/ListRepositories"
            self.server.started.set()
            # No response is sent. An EOF/reset proves HTTP work was cancelled.
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and not self.server.release.is_set():
                if select.select([self.connection], [], [], 0.05)[0]:
                    try:
                        assert self.connection.recv(1, socket.MSG_PEEK) == b""
                    except ConnectionResetError:
                        pass
                    self.server.aborted.set()
                    break
            self.close_connection = True
        except Exception:
            self.server.failed.set()
            self.close_connection = True

    def reply(self, value, cookie=False):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        if cookie:
            self.send_header("Set-Cookie", "golf_session=" + self.server.cookie + "; Path=/; HttpOnly")
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()


def check(binary, version, case="cancel", api_token=False):
    fixture = Fixture(api_token)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    # Do not inherit owner credentials, proxies, Golf configuration or SDK flags.
    env = {name: value for name, value in os.environ.items()
           if name in ("PATH", "HOME", "TMPDIR", "SYSTEMROOT")}
    env['GOLF_URL'] = fixture.origin
    env['GOLF_API_TOKEN' if api_token else 'GOLF_GITEA_TOKEN'] = fixture.token
    process = subprocess.Popen([str(binary), "mcp"], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    messages = queue.Queue()
    observed = []
    read_finished = threading.Event()
    expected_exit = 0

    def read():
        try:
            for line in iter(lambda: process.stdout.readline(1 << 20), b""):
                assert line.endswith(b"\n") and len(line) < 1 << 20
                assert fixture.token.encode() not in line and fixture.cookie.encode() not in line
                message = json.loads(line)
                assert message.get("jsonrpc") == "2.0"
                messages.put(message)
        except Exception:
            messages.put({"fixture_failure": True})
        finally:
            read_finished.set()

    threading.Thread(target=read, daemon=True).start()

    def send(method, params, request_id=None):
        params = dict(params)
        if version == "2026-07-28" and request_id is not None:
            params["_meta"] = {
                "io.modelcontextprotocol/protocolVersion": version,
                "io.modelcontextprotocol/clientInfo": {"name": "golf-cancellation-check", "version": "1"},
                "io.modelcontextprotocol/clientCapabilities": {},
            }
        message = {"jsonrpc": "2.0", "method": method, "params": params}
        if request_id is not None:
            message["id"] = request_id
        process.stdin.write(json.dumps(message, separators=(",", ":")).encode() + b"\n")
        process.stdin.flush()

    def receive(request_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            message = messages.get(timeout=max(0.01, deadline - time.monotonic()))
            assert not message.get("fixture_failure")
            observed.append(message)
            if message.get("id") == request_id:
                return message
        raise AssertionError("response deadline")

    try:
        if version == "2026-07-28":
            send("server/discover", {}, 1)
            discovery = receive(1)
        else:
            send("initialize", {"protocolVersion": version, "capabilities": {},
                                "clientInfo": {"name": "golf-cancellation-check", "version": "1"}}, 1)
            discovery = receive(1)
            assert discovery["result"]["protocolVersion"] == version
            send("notifications/initialized", {})
        assert "error" not in discovery
        send("tools/list", {}, 2)
        assert any(tool["name"] == "golf_repo_list" for tool in receive(2)["result"]["tools"])
        assert not fixture.calls
        if case in ("batch", "oversized"):
            if case == "batch":
                data = [{"jsonrpc": "2.0", "id": index, "method": "tools/list", "params": {}}
                        for index in (90, 91)]
            else:
                data = {"jsonrpc": "2.0", "id": 90, "method": "tools/list", "params": {"pad": "x" * (65 << 10)}}
            expected_exit = 1
            try:
                process.stdin.write(json.dumps(data).encode() + b"\n")
                process.stdin.flush()
            except BrokenPipeError:
                pass
            assert process.wait(timeout=3) == expected_exit
            assert read_finished.wait(1)
            assert messages.empty() and not fixture.calls
            return {"protocol": version, "case": case, "rejected_before_authentication": True}
        send("tools/call", {"name": "golf_repo_list", "arguments": {}}, 3)
        assert fixture.started.wait(5), "read did not start"
        started = time.monotonic()
        if case == "duplicate_id":
            expected_exit = 1
            send("tools/list", {}, 3)
        else:
            send("notifications/cancelled", {"requestId": 3, "reason": "fixture cancellation"})
        assert fixture.aborted.wait(3), "HTTP read was not cancelled"
        if not api_token:
            assert fixture.logged_out.wait(3), "temporary session was not closed"
        else:
            assert not fixture.logged_out.is_set(), "bearer flow attempted a logout"
        if case == "duplicate_id":
            assert process.wait(timeout=3) == expected_exit
            assert read_finished.wait(1)
            assert messages.empty() and len(fixture.calls) == (1 if api_token else 3) and not fixture.failed.is_set()
            return {"protocol": version, "case": case, "rejected": True,
                    "http_cancelled": True, "session_closed": not api_token, "bearer_only": api_token}
        # A subsequent RPC proves the connection remains usable after cleanup.
        send("tools/list", {}, 4)
        assert "result" in receive(4)
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            try:
                observed.append(messages.get(timeout=deadline - time.monotonic()))
            except queue.Empty:
                break
        assert not fixture.failed.is_set()
        assert len(fixture.calls) == (1 if api_token else 3), "unexpected RPC or authentication retry"
        responses = [message for message in observed if message.get("id") == 3]
        assert not responses, "response sent after cancellation"
        # Unknown and completed cancellations must not poison a later request
        # that uses the same ID. Repetition exercises SDK asynchronous dispatch.
        for request_id in range(100, 116):
            send("notifications/cancelled", {"requestId": request_id})
            send("tools/list", {}, request_id)
            assert "result" in receive(request_id)
            send("notifications/cancelled", {"requestId": request_id})
            send("tools/list", {}, request_id)
            assert "result" in receive(request_id)
        send("tools/list", {}, 3)
        assert "result" in receive(3), "cancelled request ID remained reserved"
        return {"protocol": version, "case": case, "http_cancelled": True,
                "session_closed": not api_token, "bearer_only": api_token, "connection_usable": True,
                "post_cancel_response": False, "unknown_completed_cancellation_reuse": True,
                "cleanup_seconds": round(time.monotonic() - started, 3)}
    finally:
        fixture.release.set()
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass
        forced = False
        try:
            process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            forced = True
            process.kill()
            process.wait(timeout=3)
        diagnostic = process.stderr.read(65536)
        fixture.shutdown()
        fixture.server_close()
        assert fixture.token.encode() not in diagnostic and fixture.cookie.encode() not in diagnostic
        assert not forced and process.returncode == expected_exit, "stdio did not shut down with expected status"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, default=Path("bin/golf"))
    parser.add_argument("--api-token-mode", action='store_true', help='exercise direct Golf bearer reads without login/logout')
    args = parser.parse_args()
    for version in ("2025-11-25", "2026-07-28"):
        for case in ("cancel", "batch", "oversized", "duplicate_id"):
            try:
                result = check(args.cli.resolve(strict=True), version, case, args.api_token_mode)
            except Exception:
                print(f"FAIL: {version} {case}; fixture diagnostics withheld.", file=sys.stderr)
                return 1
            print(json.dumps(result, sort_keys=True), flush=True)
    print("PASS: both revisions suppress cancelled replies, preserve ID reuse and reject forbidden frames; " +
          ("API bearer calls create no sessions." if args.api_token_mode else "PAT sessions are cleaned up."))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("FAIL: bounded MCP cancellation fixture failed; diagnostics withheld.", file=sys.stderr)
        sys.exit(1)
