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

test("Guardian switches generation through a graceful watcher stop", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-guardian-switch-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const initial = configuration(stateRoot);
  const replacement = configuration(stateRoot, "c".repeat(32));
  const configurationPath = path.join(stateRoot, "windows-autostart.json");
  await writeFile(configurationPath, JSON.stringify(initial));
  let starts = 0;
  const run = runWindowsGuardian(configurationPath, {
    pollIntervalMilliseconds: 5,
    cdpReadyImplementation: async () => true,
    watcherLockImplementation: async () => ({ active: false }),
    spawnWatcherImplementation: () => {
      starts += 1;
      return fakeWatcher();
    },
  });
  let current = initial;
  try {
    await waitUntil(() => starts === 1);
    await writeWindowsConfiguration(configurationPath, replacement);
    current = replacement;
    await waitUntil(() => starts === 2);
  } finally {
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
