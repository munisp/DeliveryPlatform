import { createServer } from "node:http";

if (process.env.NODE_ENV !== "test") {
  throw new Error("lifecycle_email_sink_requires_test_mode");
}

const port = Number.parseInt(process.env.TEST_EMAIL_SINK_PORT ?? "8099", 10);
const expectedToken = process.env.TEST_INTERNAL_TOKEN ?? "";
if (expectedToken.length < 32) {
  throw new Error("lifecycle_email_sink_requires_strong_test_token");
}

const messages = [];

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/messages") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ messages }));
    return;
  }

  if (request.method !== "POST" || request.url !== "/dispatch") {
    response.writeHead(404).end();
    return;
  }

  if (request.headers["x-internal-service-token"] !== expectedToken) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ accepted: false }));
    return;
  }

  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  if (payload.type !== "generic_email" || !payload.recipient?.email || !payload.payload?.message) {
    response.writeHead(422, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ accepted: false }));
    return;
  }

  messages.push({
    recipient: payload.recipient.email,
    subject: payload.payload.subject,
    message: payload.payload.message,
    requestId: request.headers["x-request-id"] ?? null,
  });
  response.writeHead(202, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    accepted: true,
    requestId: request.headers["x-request-id"] ?? "lifecycle-test-email",
    results: [{ success: true, channel: "email", messageId: `test-email-${messages.length}`, provider: "local-test-sink" }],
  }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`lifecycle-email-sink listening on ${port}\n`);
});
