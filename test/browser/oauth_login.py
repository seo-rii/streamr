"""Exercise native OAuth form navigation against a running OAuth-mode Worker.

Requires Python Playwright and Chromium. Configuration comes from the Worker's
MCP_OAUTH_* environment variables; credentials and OAuth artifacts are not logged.
The external callback is intercepted locally without contacting the OAuth client.
"""

import base64
import hashlib
import json
import os
import re
import secrets
import sys
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import sync_playwright


def main():
    stage = "configuration"
    try:
        resource = os.environ["MCP_OAUTH_RESOURCE"]
        source = urlsplit(resource)
        origin = source.scheme + "://" + source.netloc
        redirect = os.environ["MCP_OAUTH_ALLOWED_REDIRECT_URIS"].split(",")[0].strip()
        callback = urlsplit(redirect)
        callback_origin = callback.scheme + "://" + callback.netloc
        assert callback_origin != origin, "An external callback is required."
        callback_pattern = re.compile(
            "^" + re.escape(callback_origin + callback.path) + r"(?:\?|$)"
        )
        username = os.environ["MCP_OAUTH_LOGIN_USERNAME"]
        password = os.environ["MCP_OAUTH_LOGIN_PASSWORD"]
        scopes = " ".join(dict.fromkeys((
            os.environ.get("MCP_OAUTH_READ_SCOPES", "streamr.read") + " "
            + os.environ.get("MCP_OAUTH_WRITE_SCOPES", "streamr.write")
        ).split()))
        expected_ttl = int(os.environ.get("MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS", "43200"))
        results = []
        with sync_playwright() as playwright:
            stage = "chromium-launch"
            browser = playwright.chromium.launch(headless=True)
            for retry in (False, True):
                scenario = "wrong-password-then-correct" if retry else "correct-password"
                stage = scenario + ":register"
                # Wrangler's local HTTPS listener uses a self-signed certificate.
                context = browser.new_context(
                    ignore_https_errors=source.hostname in {"localhost", "127.0.0.1", "::1"}
                )
                context.set_default_timeout(10_000)
                received = []
                csp_errors = []
                registration = context.request.post(
                    origin + "/register",
                    data=json.dumps({
                        "client_name": "Streamr browser regression",
                        "redirect_uris": [redirect],
                        "token_endpoint_auth_method": "none",
                    }),
                    headers={"Content-Type": "application/json"},
                )
                assert registration.status == 201
                client_id = registration.json()["client_id"]
                verifier = secrets.token_urlsafe(48)
                challenge = base64.urlsafe_b64encode(
                    hashlib.sha256(verifier.encode()).digest()
                ).decode().rstrip("=")
                state = secrets.token_urlsafe(24)
                page = context.new_page()
                # Playwright routing only handles the first URL of a redirect
                # chain. CDP interception also catches the external callback hop.
                devtools = context.new_cdp_session(page)

                def intercept_callback(event):
                    received.append(parse_qs(urlsplit(event["request"]["url"]).query))
                    devtools.send("Fetch.fulfillRequest", {
                        "requestId": event["requestId"], "responseCode": 200,
                        "responseHeaders": [{"name": "Content-Type", "value": "text/plain"}],
                        "body": base64.b64encode(b"Callback reached.").decode(),
                    })

                devtools.on("Fetch.requestPaused", intercept_callback)
                devtools.send("Fetch.enable", {"patterns": [{
                    "urlPattern": callback_origin + callback.path + "*",
                    "requestStage": "Request",
                }]})

                def capture_console(message):
                    if message.type == "error" and "form-action" in message.text:
                        csp_errors.append("form-action")

                page.on("console", capture_console)
                stage = scenario + ":login-page"
                response = page.goto(origin + "/authorize?" + urlencode({
                    "response_type": "code", "client_id": client_id,
                    "redirect_uri": redirect, "resource": resource,
                    "scope": scopes, "state": state,
                    "code_challenge": challenge, "code_challenge_method": "S256",
                }), wait_until="domcontentloaded")
                assert response and response.status == 200
                if retry:
                    stage = scenario + ":wrong-password"
                    page.locator('input[name="username"]').fill(username)
                    page.locator('input[name="password"]').fill(secrets.token_urlsafe(48))
                    page.get_by_role("button", name="Authorize Streamr", exact=True).click()
                    alert = page.get_by_role("alert")
                    alert.wait_for(state="visible")
                    assert "username or password is invalid" in alert.inner_text()

                stage = scenario + ":native-form-redirect"
                page.locator('input[name="username"]').fill(username)
                page.locator('input[name="password"]').fill(password)
                page.get_by_role("button", name="Authorize Streamr", exact=True).click()
                page.wait_for_url(callback_pattern, wait_until="domcontentloaded")
                stage = scenario + ":callback-count"
                assert len(received) == 1
                stage = scenario + ":csp-enforcement"
                assert not csp_errors
                query = received[0]
                stage = scenario + ":callback-state"
                assert query["state"] == [state]
                stage = scenario + ":callback-issuer"
                assert query["iss"] == [origin]
                stage = scenario + ":callback-query"
                for key, values in parse_qs(callback.query).items():
                    assert query[key] == values

                stage = scenario + ":token-exchange"
                token_response = context.request.post(origin + "/token", form={
                    "grant_type": "authorization_code", "code": query["code"][0],
                    "code_verifier": verifier, "redirect_uri": redirect,
                    "client_id": client_id, "resource": resource,
                })
                assert token_response.status == 200
                token = token_response.json()
                assert token["expires_in"] == expected_ttl
                stage = scenario + ":mcp-authentication"
                mcp_response = context.request.post(resource, headers={
                    "Authorization": "Bearer " + token["access_token"],
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                }, data=json.dumps({
                    "jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": {"name": "streamr-browser-regression", "version": "1.0.0"},
                    },
                }))
                assert mcp_response.status == 200
                results.append({
                    "scenario": scenario, "nativeCallbackReached": True,
                    "cspViolations": 0, "tokenExpiresInSeconds": token["expires_in"],
                    "mcpAuthenticated": True,
                })
                context.close()
            browser.close()
        print(json.dumps({"ok": True, "scenarios": results}))
        return 0
    except Exception as error:
        # Playwright errors can contain credentials or codes in request URLs.
        print(json.dumps({"ok": False, "stage": stage, "errorType": type(error).__name__}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
