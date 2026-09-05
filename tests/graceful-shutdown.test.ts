import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import net from "node:net";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

describe("Graceful Shutdown (P0.2)", () => {
  it("exits cleanly with code 0 on SIGTERM", async () => {
    const port = await getFreePort();
    const env = { ...process.env };
    delete env.VITEST;
    env.ADMIN_API_KEY = "test-key";
    env.BINANCE_MCP_AUTH_TOKEN = "test-token";
    env.DATABASE_PATH = ":memory:";
    env.PORT = String(port);
    env.NODE_ENV = "production";
    env.B402_PAY_TO = "0x0000000000000000000000000000000000000001";
    env.PAYMENTS_ENABLED = "false";

    const child = spawn("node_modules/.bin/tsx", ["src/index.ts"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrOutput = "";
    child.stderr.on("data", (data) => {
      stderrOutput += data.toString();
    });

    try {
      // Poll the health endpoint until the server is ready (robust against stdout buffering)
      let started = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const _res = await fetch(`http://localhost:${port}/health`);
          // Any HTTP response means the server is listening (200 = healthy, 503 = unhealthy deps)
          started = true;
          break;
        } catch {
          // Server not ready yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(started, "Server should start and respond to /health").toBe(true);

      // Send SIGTERM
      child.kill("SIGTERM");

      const exitCode = await new Promise<number | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 15_000);
        child.on("exit", (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      expect(exitCode, `Expected exit code 0, got ${exitCode}.\nStderr:\n${stderrOutput}`).toBe(0);
    } finally {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
  }, 35_000);
});
