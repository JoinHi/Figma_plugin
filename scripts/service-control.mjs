import { spawn } from "node:child_process";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pidPath = resolve(projectDir, ".export-service.pid");
const logPath = resolve(projectDir, "export-service.log");
const port = Number(process.env.FIGMA_EXPORT_SERVICE_PORT || 43119);
const healthUrl = `http://localhost:${port}/health`;
const action = process.argv[2] || "status";

if (action === "start") {
  await startService();
} else if (action === "stop") {
  await stopService();
} else if (action === "status") {
  await printStatus();
} else {
  console.error("Usage: node scripts/service-control.mjs <start|stop|status>");
  process.exit(1);
}

async function startService() {
  const existingPid = await readPid();

  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Figma export service is already running. PID: ${existingPid}`);
    console.log(`Health check: ${healthUrl}`);
    return;
  }

  if (await isHealthy()) {
    console.log(`Figma export service is already responding at ${healthUrl}.`);
    return;
  }

  const logStream = createWriteStream(logPath, { flags: "a" });
  await appendFile(logPath, `\n[${new Date().toISOString()}] Starting export service\n`);

  const child = spawn(process.execPath, ["scripts/export-service.mjs"], {
    cwd: projectDir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FIGMA_EXPORT_DIR: process.env.FIGMA_EXPORT_DIR || projectDir,
      FIGMA_EXPORT_SERVICE_HOST: process.env.FIGMA_EXPORT_SERVICE_HOST || "localhost",
      FIGMA_EXPORT_SERVICE_PORT: String(port)
    }
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.unref();

  await writeFile(pidPath, `${child.pid}\n`, "utf8");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isHealthy()) {
      console.log(`Figma export service started. PID: ${child.pid}`);
      console.log(`Health check: ${healthUrl}`);
      console.log(`Log file: ${logPath}`);
      return;
    }

    await sleep(250);
  }

  console.log(`Service process started, but health check did not respond yet. PID: ${child.pid}`);
  console.log(`Check log file: ${logPath}`);
}

async function stopService() {
  const pid = await readPid();

  if (!pid) {
    if (await isHealthy()) {
      console.log(`A service is responding at ${healthUrl}, but no PID file was found.`);
      console.log("If this was started elsewhere, close that terminal or stop that process manually.");
      return;
    }

    console.log("Figma export service is not running.");
    return;
  }

  if (!isProcessRunning(pid)) {
    await rm(pidPath, { force: true });
    console.log("PID file was stale. Figma export service is not running.");
    return;
  }

  process.kill(pid, "SIGTERM");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessRunning(pid)) {
      await rm(pidPath, { force: true });
      console.log("Figma export service stopped.");
      return;
    }

    await sleep(250);
  }

  process.kill(pid, "SIGKILL");
  await rm(pidPath, { force: true });
  console.log("Figma export service was force stopped.");
}

async function printStatus() {
  const pid = await readPid();
  const healthy = await isHealthy();

  if (pid && isProcessRunning(pid)) {
    console.log(`Figma export service process is running. PID: ${pid}`);
  } else {
    console.log("No running service process was found from the PID file.");
  }

  console.log(`Health check ${healthy ? "passed" : "failed"}: ${healthUrl}`);
}

async function readPid() {
  if (!existsSync(pidPath)) {
    return null;
  }

  const value = Number((await readFile(pidPath, "utf8")).trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isHealthy() {
  try {
    const response = await fetch(healthUrl);
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
