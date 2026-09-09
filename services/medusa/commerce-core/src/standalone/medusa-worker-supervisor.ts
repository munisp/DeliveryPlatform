import { createServer } from "http";
import { spawn, type ChildProcess } from "child_process";

const port = (() => {
  const raw = process.env.MEDUSA_WORKER_HEALTH_PORT?.trim() || "9002";
  if (!/^[0-9]+$/.test(raw)) throw new Error("MEDUSA_WORKER_HEALTH_PORT must be an integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    throw new Error("MEDUSA_WORKER_HEALTH_PORT must be between 1024 and 65535");
  }
  return value;
})();

let child: ChildProcess | undefined;
let stopping = false;

const startWorker = (): ChildProcess => {
  const processHandle = spawn("npm", ["run", "start:worker"], {
    env: {
      ...process.env,
      MEDUSA_WORKER_MODE: "worker",
      MEDUSA_ADMIN_DISABLED: "true",
      MEDUSA_PROCESS_ROLE: "worker",
    },
    stdio: "inherit",
  });
  processHandle.once("exit", (code, signal) => {
    child = undefined;
    if (!stopping) {
      process.stderr.write(`medusa worker exited unexpectedly code=${code ?? "null"} signal=${signal ?? "null"}\n`);
      process.exit(1);
    }
  });
  return processHandle;
};

async function main(): Promise<void> {
  child = startWorker();
  const server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/healthz" && child && child.exitCode === null && !stopping) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"ok","role":"worker"}\n');
      return;
    }
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end('{"status":"unavailable","role":"worker"}\n');
  });
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));

  const shutdown = async (): Promise<void> => {
    stopping = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const worker = child;
    if (worker && worker.exitCode === null) {
      worker.kill("SIGTERM");
      const forcedStop = setTimeout(() => worker.kill("SIGKILL"), 30_000);
      await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      clearTimeout(forcedStop);
    }
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void shutdown().then(() => process.exit(0)).catch((error) => {
      process.stderr.write(`medusa worker shutdown failed: ${error instanceof Error ? error.message : "unknown"}\n`);
      process.exit(1);
    }));
  }
}

void main().catch((error) => {
  process.stderr.write(`medusa worker supervisor startup failed: ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exit(1);
});
