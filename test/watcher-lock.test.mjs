import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireWatcherLock, getProcessStart, readWatcherLock } from "../src/watcher-lock.mjs";

test("Windows process start lookup uses a fixed PowerShell executable and numeric PID", async () => {
  const calls = [];
  const start = await getProcessStart(4242, {
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    executeFileImplementation: async (...argumentsList) => {
      calls.push(argumentsList);
      return { stdout: "123456789\r\n" };
    },
  });
  assert.equal(start, "123456789");
  assert.equal(calls[0][0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.match(calls[0][1].at(-1), /Get-Process -Id 4242/);
  assert.match(calls[0][1].at(-1), /StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.equal(calls[0][2].windowsHide, true);
});

test("Windows process start lookup rejects nonnumeric PIDs before invoking PowerShell", async () => {
  let invoked = false;
  const start = await getProcessStart("1; Write-Output injected", {
    platform: "win32",
    executeFileImplementation: async () => {
      invoked = true;
      return { stdout: "123" };
    },
  });
  assert.equal(start, null);
  assert.equal(invoked, false);
});

test("watcher lock prevents competing processes and releases cleanly", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-watcher-lock-"));
  context.after(() => rm(stateRoot, { force: true, recursive: true }));
  const lock = await acquireWatcherLock(
    { remoteDebuggingPort: 19224, themeId: "aurora-ridge" },
    { stateRoot },
  );
  const status = await readWatcherLock(19224, { stateRoot });
  assert.equal(status.active, true);
  assert.equal(status.record.themeId, "aurora-ridge");
  await assert.rejects(
    () => acquireWatcherLock(
      { remoteDebuggingPort: 19224, themeId: "tokyo-rain" },
      { stateRoot },
    ),
    /already active/,
  );
  await lock.release();
  assert.equal((await readWatcherLock(19224, { stateRoot })).active, false);
});

test("watcher lock replaces a stale owner", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-watcher-stale-"));
  context.after(() => rm(stateRoot, { force: true, recursive: true }));
  await writeFile(path.join(stateRoot, "watcher-19225.lock"), JSON.stringify({
    schemaVersion: 1,
    nonce: "0".repeat(32),
    pid: 999999,
    processStart: null,
    port: 19225,
    themeId: "stale-theme",
    createdAt: new Date(0).toISOString(),
  }), { mode: 0o600 });
  const lock = await acquireWatcherLock(
    { remoteDebuggingPort: 19225, themeId: "fresh-theme" },
    { stateRoot },
  );
  assert.equal(lock.record.themeId, "fresh-theme");
  await lock.release();
});

test("Windows watcher lock records process start identity", { skip: process.platform !== "win32" }, async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-watcher-win-start-"));
  context.after(() => rm(stateRoot, { force: true, recursive: true }));
  const lock = await acquireWatcherLock(
    { remoteDebuggingPort: 19226, themeId: "win-start" },
    { stateRoot },
  );
  try {
    assert.match(lock.record.processStart, /^\d+$/);
    assert.equal((await readWatcherLock(19226, { stateRoot })).active, true);
  } finally {
    await lock.release();
  }
});
