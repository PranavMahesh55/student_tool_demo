const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const root = path.join(__dirname, "..");
const host = "127.0.0.1";
const firstPort = Number(process.env.VITE_PORT || process.env.PORT || 5173);

function bin(name) {
  return path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findOpenPort(startPort) {
  for (let port = startPort; port < startPort + 60; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`Could not find an open local port from ${startPort} to ${startPort + 59}.`);
}

function waitForUrl(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    function check() {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for ${url}.`));
          return;
        }
        setTimeout(check, 150);
      });
    }

    check();
  });
}

function startProcess(command, args, env = {}) {
  return spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}

(async () => {
  const port = await findOpenPort(firstPort);
  const rendererUrl = `http://${host}:${port}`;
  let electron = null;
  let shuttingDown = false;

  const vite = startProcess(bin("vite"), ["--host", host, "--port", String(port), "--strictPort"]);

  function shutdown(signal = "SIGTERM") {
    if (shuttingDown) return;
    shuttingDown = true;
    if (electron && !electron.killed) electron.kill(signal);
    if (!vite.killed) vite.kill(signal);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  vite.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (electron && !electron.killed) electron.kill("SIGTERM");
    process.exit(code ?? (signal ? 1 : 0));
  });

  await waitForUrl(rendererUrl);
  electron = startProcess(bin("electron"), ["."], {
    ELECTRON_RENDERER_URL: rendererUrl,
    NODE_ENV: "development",
  });

  electron.on("exit", (code, signal) => {
    if (!shuttingDown) {
      shuttingDown = true;
      if (!vite.killed) vite.kill("SIGTERM");
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
