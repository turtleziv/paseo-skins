#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  isCdpAvailable,
  isPaseoApplicationTarget,
  listCdpTargets,
  validateCdpWebSocketUrl,
} from "./cdp-client.mjs";
import {
  createWindowsSystem,
  diagnoseCdpPort,
  validateWindowsConfiguration,
} from "./windows-autostart.mjs";
import { readWatcherLock } from "./watcher-lock.mjs";

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readConfiguration(configurationPath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return validateWindowsConfiguration(await readJson(configurationPath));
    } catch (error) {
      const transient = error instanceof SyntaxError ||
        error.message === "Windows autostart configuration has an invalid schema";
      if (!transient || attempt === 4) throw error;
      await delay(10);
    }
  }
}

async function paseoCdpReady(port) {
  try {
    if (!(await isCdpAvailable(port))) return false;
    const targets = await listCdpTargets(port);
    return targets.some((target) => {
      if (!isPaseoApplicationTarget(target)) return false;
      try {
        validateCdpWebSocketUrl(target, port);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function launchWatcher(configuration) {
  return spawn(configuration.nodeExecutablePath, [
    configuration.cliPath,
    "inject",
    "--port",
    String(configuration.remoteDebuggingPort),
    ...configuration.themeArguments,
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

function matchesRequest(request, configuration) {
  return request?.installationId === configuration.installationId &&
    request?.generation === configuration.generation;
}

export async function runWindowsGuardian(configurationPath, {
  pollIntervalMilliseconds = 2_000,
  stopTimeoutMilliseconds = 10_000,
  cdpReadyImplementation = paseoCdpReady,
  watcherLockImplementation = readWatcherLock,
  spawnWatcherImplementation = launchWatcher,
  portListenerImplementation = async () => null,
  socketHoldersImplementation = async () => [],
  portCheckIntervalMilliseconds = 30_000,
} = {}) {
  if (!path.isAbsolute(configurationPath)) throw new Error("Guardian configuration path must be absolute");
  const stateRoot = path.dirname(configurationPath);
  const stopPath = path.join(stateRoot, "windows-guardian.stop");
  const receiptPath = path.join(stateRoot, "windows-guardian.stopped");
  let active = null;
  let lastWaitingReason = null;
  let incompleteStopRequest = false;
  // The owner query runs in the background so a slow PowerShell never delays stop requests;
  // each poll reads the latest settled answer for the current port.
  let portHolder = null;
  let portHolderPort = null;
  let pendingPortCheck = null;
  let lastPortCheck = -Infinity;
  // The holder lookup is a heavy PowerShell sweep and an orphaned listener keeps the same
  // inheritors, so one answer per orphaned listener is reused. Stopping aborts a pending lookup
  // so its child process cannot keep the Guardian task running.
  const lookupAbort = new AbortController();
  const holderCache = new Map();
  const findHolders = async (port, options) => {
    const key = `${port}:${options.ownerPid}`;
    if (holderCache.has(key)) return holderCache.get(key);
    const holders = await socketHoldersImplementation(port, { ...options, signal: lookupAbort.signal });
    holderCache.set(key, holders);
    return holders;
  };
  const checkPortHolder = (port) => {
    if (port !== portHolderPort) {
      portHolder = null;
      portHolderPort = port;
      lastPortCheck = -Infinity;
    }
    if (!pendingPortCheck && Date.now() - lastPortCheck >= portCheckIntervalMilliseconds) {
      lastPortCheck = Date.now();
      const check = diagnoseCdpPort(port, {
        getPortListener: portListenerImplementation,
        findSocketHolders: findHolders,
      })
        .catch((error) => `waiting for Paseo loopback CDP (port check failed: ${error.message})`)
        .then((holder) => {
          if (portHolderPort === port) portHolder = holder;
        })
        .finally(() => {
          if (pendingPortCheck === check) pendingPortCheck = null;
        });
      pendingPortCheck = check;
    }
    return portHolder;
  };
  const log = async (event, details = "") => {
    const configuration = await readConfiguration(configurationPath);
    await appendFile(configuration.logPath,
      `${new Date().toISOString()} guardian-${event}${details ? ` ${details}` : ""}\n`);
  };
  const stopChild = async () => {
    if (!active) return;
    const current = active;
    if (current.alive) {
      current.child.stdin.write("stop\n");
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Watcher did not acknowledge stdin stop")),
          stopTimeoutMilliseconds);
      });
      let result;
      try {
        result = await Promise.race([current.exited, timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (result.code !== 0) throw new Error(`Watcher exited with code ${result.code}`);
    }
    active = null;
  };

  await log("start", `pid=${process.pid}`);
  try {
    return await guardianLoop();
  } finally {
    lookupAbort.abort();
  }

  async function guardianLoop() {
    for (;;) {
      const configuration = await readConfiguration(configurationPath);
      if (active && active.generation !== configuration.generation) {
        await log("reconfigure", `generation=${configuration.generation}`);
        await stopChild();
      }
      let request;
      try {
        request = await readJson(stopPath);
        incompleteStopRequest = false;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (!incompleteStopRequest) await log("stop-request-incomplete");
        incompleteStopRequest = true;
        request = null;
      }
      if (matchesRequest(request, configuration)) {
        await stopChild();
        await writeFile(receiptPath, `${JSON.stringify({
          installationId: configuration.installationId,
          generation: configuration.generation,
          childStopped: true,
          stoppedAt: new Date().toISOString(),
        })}\n`, { mode: 0o600 });
        await log("stopped", `generation=${configuration.generation}`);
        return { stopped: true, childStopped: true };
      }
      if (active && !active.alive) {
        await log("watcher-exit", `code=${active.result?.code ?? "unknown"}`);
        active = null;
      }
      const cdpReady = await cdpReadyImplementation(configuration.remoteDebuggingPort);
      if (active && !cdpReady) {
        await log("cdp-lost", "stopping watcher");
        await stopChild();
      }
      if (!active) {
        let reason = null;
        if (!cdpReady) {
          reason = checkPortHolder(configuration.remoteDebuggingPort) ??
            "waiting for Paseo loopback CDP";
        } else {
          portHolderPort = null;
          const watcher = await watcherLockImplementation(configuration.remoteDebuggingPort);
          if (watcher.active) reason = "another watcher owns the port";
          else if (watcher.error) reason = `watcher lock cannot be read: ${watcher.error}`;
        }
        if (reason) {
          if (reason !== lastWaitingReason) await log("wait", reason);
          lastWaitingReason = reason;
        } else {
          const child = spawnWatcherImplementation(configuration);
          const current = { child, generation: configuration.generation, alive: true, result: null };
          current.exited = new Promise((resolve, reject) => {
            child.once("exit", (code, signal) => {
              current.alive = false;
              current.result = { code, signal };
              resolve(current.result);
            });
            child.once("error", (error) => {
              current.alive = false;
              reject(error);
            });
          });
          current.exited.catch(() => {});
          for (const stream of [child.stdout, child.stderr]) {
            stream?.on("data", (chunk) => {
              appendFile(configuration.logPath, chunk).catch(() => {});
            });
          }
          active = current;
          lastWaitingReason = null;
          await log("watcher-start", `pid=${child.pid ?? "test"} port=${configuration.remoteDebuggingPort}`);
        }
      }
      await delay(pollIntervalMilliseconds);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const system = createWindowsSystem();
  runWindowsGuardian(process.argv[2], {
    portListenerImplementation: (port) => system.getPortListener(port),
    socketHoldersImplementation: (port, options) => system.findSocketHolders(port, options),
  }).catch((error) => {
    process.stderr.write(`[paseo-skin] Guardian failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
