const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");

const key = fs.readFileSync(process.env.MOCK_TLS_KEY || "/certs/key.pem");
const cert = fs.readFileSync(process.env.MOCK_TLS_CERT || "/certs/cert.pem");

function edgeHandler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const suspicious = url.searchParams.get("probe")?.includes("OR 1=1") || req.headers["user-agent"]?.includes("sqlmap");
  if (suspicious) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ blocked: true, enforcement: "mock-waf" }));
  }
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", source: "controlled-mock-edge" }));
  }
  if (url.pathname === "/realms/switchos/.well-known/openid-configuration") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ issuer: "https://localhost/realms/switchos", authorization_endpoint: "https://localhost/realms/switchos/protocol/openid-connect/auth" }));
  }
  res.writeHead(404, { "content-type": "application/json" });
  return res.end(JSON.stringify({ error: "not_found" }));
}

http.createServer((req, res) => {
  res.writeHead(308, { location: `https://localhost${req.url}` });
  res.end();
}).listen(80, "0.0.0.0");

https.createServer({ key, cert }, edgeHandler).listen(443, "0.0.0.0");

for (const port of [7233, 9092, 9093]) {
  net.createServer((socket) => socket.end()).listen(port, "0.0.0.0");
}

console.log("controlled mock dependency server listening on 80, 443, 7233, 9092, 9093");
