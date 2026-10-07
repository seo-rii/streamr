"""Run the Chromium OAuth regression against an isolated local HTTPS Worker.

Requires Node.js, installed npm dependencies, Python Playwright, and Chromium.
Production credentials and the checkout's .dev.vars/.env files are never loaded.
Temporary credentials are deleted on exit; private process logs remain in ~/logs.
"""

import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("--port must be between 1024 and 65535")

    root = Path(__file__).resolve().parent.parent
    log_dir = Path.home() / "logs"
    log_dir.mkdir(mode=0o700, exist_ok=True)
    log_dir.chmod(0o700)
    worker_fd, worker_log = tempfile.mkstemp(prefix="streamr-ci-worker-", suffix=".log", dir=log_dir)
    browser_fd, browser_log = tempfile.mkstemp(prefix="streamr-ci-browser-", suffix=".log", dir=log_dir)
    worker = None
    browser_exit = None
    stage = "configuration"
    result = {"ok": False}
    try:
        with os.fdopen(worker_fd, "wb") as worker_output, os.fdopen(browser_fd, "wb") as browser_output:
            with tempfile.TemporaryDirectory(prefix="streamr-ci-oauth-") as temporary:
                temporary_path = Path(temporary)
                # Deliberately copy only runtime compatibility settings, not any
                # account, routes, remote bindings, or deployment environment.
                config = json.loads((root / "wrangler.jsonc").read_text())
                local_config = {
                    "name": "streamr-ci-oauth",
                    "main": str(root / config["main"]),
                    "compatibility_date": config["compatibility_date"],
                    "compatibility_flags": config.get("compatibility_flags", []),
                }
                (temporary_path / "wrangler.json").write_text(json.dumps(local_config))
                credentials = {
                    "MCP_API_TOKEN": secrets.token_urlsafe(32),
                    "URL_SIGNING_SECRET": secrets.token_urlsafe(32),
                    "MCP_AUTH_MODE": "oauth",
                    "MCP_OAUTH_RESOURCE": f"https://localhost:{args.port}/mcp",
                    "MCP_OAUTH_SIGNING_SECRET": secrets.token_urlsafe(48),
                    "MCP_OAUTH_LOGIN_USERNAME": "ci-browser",
                    "MCP_OAUTH_LOGIN_PASSWORD": secrets.token_urlsafe(32),
                    "MCP_OAUTH_ALLOWED_REDIRECT_URIS": "https://client.example/oauth/callback",
                    "MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS": "2592000",
                }
                dev_vars = temporary_path / ".dev.vars"
                dev_vars.touch(mode=0o600)
                dev_vars.write_text("\n".join(f"{key}={value}" for key, value in credentials.items()) + "\n")
                # Keep tool/runtime configuration while excluding inherited
                # production credentials, including the local CF_TOKEN alias.
                environment = {
                    key: value for key, value in os.environ.items()
                    if not key.startswith(("MCP_", "CLOUDFLARE_", "CF_", "URL_SIGNING_"))
                }
                environment.update({
                    "CI": "true",
                    "WRANGLER_SEND_METRICS": "false",
                    "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV": "false",
                    "CLOUDFLARE_INCLUDE_PROCESS_ENV": "false",
                })
                stage = "port-availability"
                with socket.socket() as listener:
                    listener.bind(("127.0.0.1", args.port))
                stage = "worker-start"
                worker = subprocess.Popen([
                    "node", str(root / "node_modules/wrangler/bin/wrangler.js"),
                    "dev", "--config", str(temporary_path / "wrangler.json"),
                    "--local", "--local-protocol", "https",
                    "--ip", "127.0.0.1", "--port", str(args.port),
                    "--show-interactive-dev-session", "false",
                ], cwd=temporary_path, env=environment, stdout=worker_output,
                    stderr=subprocess.STDOUT, start_new_session=True)
                # The listener is loopback-only and uses Wrangler's self-signed
                # development certificate. Never disable TLS verification for a
                # deployed endpoint here.
                tls = ssl._create_unverified_context()
                deadline = time.monotonic() + 90
                stage = "worker-readiness"
                while True:
                    if worker.poll() is not None:
                        raise RuntimeError("Local Worker exited before becoming ready")
                    try:
                        with urlopen(f"https://127.0.0.1:{args.port}/healthz", context=tls, timeout=1) as response:
                            if response.status == 200:
                                break
                    except (URLError, TimeoutError, ConnectionError):
                        pass
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Local Worker did not become ready")
                    time.sleep(0.25)
                stage = "browser-regression"
                browser = subprocess.run([
                    sys.executable, str(root / "test/browser/oauth_login.py"),
                ], cwd=temporary_path, env={**environment, **credentials},
                    stdout=browser_output, stderr=subprocess.STDOUT, timeout=120)
                browser_exit = browser.returncode
                if browser_exit != 0:
                    raise RuntimeError("Browser regression failed")
                result = {"ok": True}
    except Exception as error:
        # Do not print exception messages or worker logs: these may contain
        # dynamically generated authorization codes or redirect query strings.
        result = {"ok": False, "stage": stage, "errorType": type(error).__name__}
    finally:
        if worker is not None:
            try:
                os.killpg(worker.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                worker.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(worker.pid, signal.SIGKILL)
                worker.wait(timeout=10)
        result.update({
            "browserExitCode": browser_exit,
            "workerPid": worker.pid if worker else None,
            "workerExitCode": worker.returncode if worker else None,
            "workerLog": worker_log,
            "browserLog": browser_log,
        })
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
