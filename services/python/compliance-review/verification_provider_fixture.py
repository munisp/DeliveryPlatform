from __future__ import annotations

import hashlib
import hmac
import json
import os
import ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.getenv("FIXTURE_PROVIDER_HMAC_SECRET", "")


class FixtureHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/evidence/verify":
            self.send_error(404)
            return
        content_length = int(self.headers.get("content-length", "0"))
        request_body = self.rfile.read(content_length)
        try:
            payload = json.loads(request_body)
            reference = str(payload["external_reference"])
            outcome = "rejected" if reference.startswith("reject-") else "verified"
            response = json.dumps({"outcome": outcome, "reference": f"fixture-{reference}"}, separators=(",", ":")).encode("utf-8")
        except (KeyError, ValueError, json.JSONDecodeError):
            self.send_error(400)
            return
        signature = hmac.new(SECRET.encode("utf-8"), response, hashlib.sha256).hexdigest()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(response)))
        self.send_header("x-compliance-provider-signature", signature)
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format: str, *args) -> None:
        return


if __name__ == "__main__":
    if len(SECRET) < 32:
        raise SystemExit("FIXTURE_PROVIDER_HMAC_SECRET must contain at least 32 bytes")
    server = ThreadingHTTPServer(("127.0.0.1", int(os.getenv("PORT", "8135"))), FixtureHandler)
    certificate = os.getenv("TLS_CERT", "").strip()
    private_key = os.getenv("TLS_KEY", "").strip()
    if bool(certificate) != bool(private_key):
        raise SystemExit("TLS_CERT and TLS_KEY must be supplied together")
    if certificate:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate, private_key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()
