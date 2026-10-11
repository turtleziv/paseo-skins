import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { flagsForPort, writeWindowsConfiguration } from "../src/windows-autostart.mjs";
import { runWindowsGuardian } from "../src/windows-guardian.mjs";

function configuration(stateRoot, generation = "b".repeat(32)) {
  return {
    schemaVersion: 1,
    installationId: "a".repeat(32),
    generation,
    userSid: "S-1-5-21-42",
    taskName: "PaseoSkins-Guardian-Test",
    cliPath: path.resolve("src/cli.mjs"),
    nodeExecutablePath: process.execPath,
    guardianPath: path.resolve("src/windows-guardian.mjs"),
    logPath: path.join(stateRoot, "windows-autostart.log"),
    remoteDebuggingPort: 9224,
    themeArguments: [],
    ownedFlags: flagsForPort(9224),
  };
}

function fakeWatcher(onStop = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write(value) {
    assert.equal(value, "stop\n");
    onStop();
    setImmediate(() => child.emit("exit", 0, null));
    return true;
  } };
  return child;
}

async function waitUntil(predicate, timeoutMilliseconds = 1_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Guardian state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Guardian waits for Paseo CDP, starts one watcher, and acknowledges a graceful stop", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-guardian-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const current = configuration(stateRoot);
  const configurationPath = path.join(stateRoot, "windows-autostart.json");
  await writeFile(configurationPath, JSON.stringify(current));
  let cdpReady = false;
  let starts = 0;
  const run = runWindowsGuardian(configurationPath, {
    pollIntervalMilliseconds: 5,
    cdpReadyImplementation: async () => cdpReady,
    watcherLockImplementation: async () => ({ active: false }),
    spawnWatcherImplementation: () => {
      starts += 1;
      return fakeWatcher();
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(starts, 0);
  cdpReady = true;
  await waitUntil(() => starts === 1);
  assert.equal(starts, 1);
  await writeFile(path.join(stateRoot, "windows-guardian.stop"), JSON.stringify({
    installationId: current.installationId,
    generation: current.generation,
  }));
  assert.deepEqual(await run, { stopped: true, childStopped: true });
  assert.equal(starts, 1);
  const receipt = JSON.parse(await readFile(path.join(stateRoot, "windows-guardian.stopped"), "utf8"));
  assert.equal(receipt.childStopped, true);
  assert.equal(receipt.generation, current.generation);
});

test("Guardian keeps running while a stop request is only partly written", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-guardian-partial-stop-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const current = configuration(stateRoot);
  const configurationPath = path.join(stateRoot, "windows-autostart.json");
  const stopPath = path.join(stateRoot, "windows-guardian.stop");
  await writeFile(configurationPath, JSON.stringify(current));
  await writeFile(stopPath, '{"installationId":');
  const run = runWindowsGuardian(configurationPath, {
    pollIntervalMilliseconds: 5,
    cdpReadyImplementation: async () => false,
  });
  const outcome = run.then((value) => ({ value }), (error) => ({ error }));
  await waitUntil(async () => {
    try {
      return (await readFile(current.logPath, "utf8")).includes("guardian-stop-request-incomplete");
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }, 5_000);
  await writeFile(stopPath, JSON.stringify({
    installationId: current.installationId,
    generation: current.generation,
  }));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Guardian did not stop")), 1_000);
  });
  let result;
  try {
    result = await Promise.race([outcome, timeout]);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(result, { value: { stopped: true, childStopped: true } });
  assert.match(await readFile(current.logPath, "utf8"), /guardian-stop-request-incomplete/);
});

test("Guardian switches generation through a graceful watcher stop", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-guardian-switch-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const initial = configuration(stateRoot);
  const replacement = configuration(stateRoot, "c".repeat(32));
  const configurationPath = path.join(stateRoot, "windows-autostart.json");
  await writeFile(configurationPath, JSON.stringify(initial));
  let starts = 0;
  let pauseNextReadyCheck = false;
  let resumeReadyCheck = null;
  const run = runWindowsGuardian(configurationPath, {
    pollIntervalMilliseconds: 5,
    cdpReadyImplementation: async () => {
      if (pauseNextReadyCheck) {
        pauseNextReadyCheck = false;
        await new Promise((resolve) => { resumeReadyCheck = resolve; });
      }
      return true;
    },
    watcherLockImplementation: async () => ({ active: false }),
    spawnWatcherImplementation: () => {
      starts += 1;
      return fakeWatcher();
    },
  });
  let current = initial;
  try {
    await waitUntil(() => starts === 1);
    pauseNextReadyCheck = true;
    await waitUntil(() => resumeReadyCheck !== null);
    await writeWindowsConfiguration(configurationPath, replacement);
    current = replacement;
    resumeReadyCheck();
    resumeReadyCheck = null;
    await waitUntil(() => starts === 2);
  } finally {
    resumeReadyCheck?.();
    await writeFile(path.join(stateRoot, "windows-guardian.stop"), JSON.stringify({
      installationId: current.installationId,
      generation: current.generation,
    }));
    await run;
  }
});

test("Guardian stops an idle watcher when Paseo closes and restarts it when Paseo returns", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-guardian-idle-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const current = configuration(stateRoot);
  const configurationPath = path.join(stateRoot, "windows-autostart.json");
  await writeFile(configurationPath, JSON.stringify(current));
  let cdpReady = true;
  let starts = 0;
  let stops = 0;
  const run = runWindowsGuardian(configurationPath, {
    pollIntervalMilliseconds: 5,
    cdpReadyImplementation: async () => cdpReady,
    watcherLockImplementation: async () => ({ active: false }),
    spawnWatcherImplementation: () => {
      starts += 1;
      return fakeWatcher(() => { stops += 1; });
    },
  });
  try {
    await waitUntil(() => starts === 1);
    cdpReady = false;
    await waitUntil(() => stops === 1);
    assert.equal(starts, 1);
    const logPath = path.join(stateRoot, "windows-autostart.log");
    await waitUntil(async () => (await readFile(logPath, "utf8")).includes(
      "guardian-wait waiting for Paseo loopback CDP"));
    const idleLog = await readFile(logPath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(await readFile(logPath, "utf8"), idleLog);
    cdpReady = true;
    await waitUntil(() => starts === 2);
  } finally {
    await writeFile(path.join(stateRoot, "windows-guardian.stop"), JSON.stringify({
      installationId: current.installationId,
      generation: current.generation,
    }));
    await run;
  }
  assert.equal(stops, 2);
});

async function logIncludes(logPath, text) {
  try {
    return (await readFile(logPath, "utf8")).includes(text);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function requestStop(stateRoot, current, run) {
  await writeFile(path.join(stateRoot, "windows-guardian.stop"), JSON.stringify({
    installationId: current.installationId,
    generation: current.generation,
  }));
  return run;
}

test("Guardian honours a stop request while a port check is still pending", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-guardian-pending-port-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const current = configuration(stateRoot);
  const configurationPath = path.join(stateRoot, "windows-autostart.json");
  await writeFile(configurationPath, JSON.stringify(current));
  let started = false;
  const run = runWindowsGuardian(configurationPath, {
    pollIntervalMilliseconds: 5,
    portCheckIntervalMilliseconds: 0,
    cdpReadyImplementation: async () => false,
    portListenerImplementation: () => {
      started = true;
      return new Promise(() => {});
    },
  });
  await waitUntil(() => started);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Guardian blocked on the port check")), 1_000);
  });
  try {
    assert.deepEqual(await Promise.race([requestStop(stateRoot, current, run), timeout]),
      { stopped: true, childStopped: true });
  } finally {
    clearTimeout(timer);
  }
});

test("Guardian logs a failed port check instead of reporting a clean port", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-guardian-failed-port-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const current = configuration(stateRoot);
  const configurationPath = path.join(stateRoot, "windows-autostart.json");
  await writeFile(configurationPath, JSON.stringify(current));
  const run = runWindowsGuardian(configurationPath, {
    pollIntervalMilliseconds: 5,
    portCheckIntervalMilliseconds: 0,
    cdpReadyImplementation: async () => false,
    portListenerImplementation: async () => { throw new Error("NetTCPIP unavailable"); },
  });
  try {
    await waitUntil(() => logIncludes(current.logPath, "port check failed: NetTCPIP unavailable"));
  } finally {
    await requestStop(stateRoot, current, run);
  }
});

test("Guardian re-checks the port holder when the configured port changes", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-guardian-port-switch-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const initial = configuration(stateRoot);
  const replacement = { ...configuration(stateRoot, "c".repeat(32)),
    remoteDebuggingPort: 9300, ownedFlags: flagsForPort(9300) };
  const configurationPath = path.join(stateRoot, "windows-autostart.json");
  await writeFile(configurationPath, JSON.stringify(initial));
  let current = initial;
  const run = runWindowsGuardian(configurationPath, {
    pollIntervalMilliseconds: 5,
    portCheckIntervalMilliseconds: 60_000,
    cdpReadyImplementation: async () => false,
    portListenerImplementation: async (port) =>
      (port === 9224 ? { pid: 28084, alive: false, name: null } : null),
  });
  try {
    await waitUntil(() => logIncludes(current.logPath, "exited process 28084"));
    await writeWindowsConfiguration(configurationPath, replacement);
    current = replacement;
    await waitUntil(() => logIncludes(current.logPath, "guardian-wait waiting for Paseo loopback CDP"));
  } finally {
    await requestStop(stateRoot, current, run);
  }
});

test("Guardian logs which process holds the CDP port while Paseo CDP is unreachable", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-guardian-held-port-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const current = configuration(stateRoot);
  const configurationPath = path.join(stateRoot, "windows-autostart.json");
  await writeFile(configurationPath, JSON.stringify(current));
  let listener = { pid: 28084, alive: false, name: null };
  let checks = 0;
  const run = runWindowsGuardian(configurationPath, {
    pollIntervalMilliseconds: 5,
    portCheckIntervalMilliseconds: 0,
    cdpReadyImplementation: async () => false,
    portListenerImplementation: async (port) => {
      assert.equal(port, 9224);
      checks += 1;
      return listener;
    },
  });
  try {
    await waitUntil(async () => {
      try {
        return /guardian-wait .*9224.*28084/.test(await readFile(current.logPath, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
    listener = null;
    await waitUntil(async () => (await readFile(current.logPath, "utf8")).includes(
      "guardian-wait waiting for Paseo loopback CDP"));
    assert.ok(checks >= 2);
  } finally {
    await writeFile(path.join(stateRoot, "windows-guardian.stop"), JSON.stringify({
      installationId: current.installationId,
      generation: current.generation,
    }));
    await run;
  }
});
