import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  collectWindowsAutostartStatus,
  installWindowsAutostart,
  uninstallWindowsAutostart,
} from "../src/windows-autostart.mjs";
import { collectAutostartStatus, installAutostart, uninstallAutostart } from "../src/autostart.mjs";

const execFileAsync = promisify(execFile);

function fakeWindowsSystem() {
  let flags = null;
  let task = null;
  let registrations = 0;
  return {
    identity: async () => ({ name: "TESTPC\\tester", sid: "S-1-5-21-42" }),
    getUserFlags: async () => flags,
    setUserFlags: async (value) => { flags = value; },
    getTask: async () => task,
    registerTask: async (specification) => {
      registrations += 1;
      task = {
        name: specification.taskName,
        description: specification.description,
        execute: specification.taskExecutablePath ?? specification.nodeExecutablePath,
        arguments: specification.arguments,
        state: "Ready",
      };
    },
    startTask: async () => { task.state = "Running"; },
    unregisterTask: async () => { task = null; },
    setExternalFlags: (value) => { flags = value; },
    get registrations() { return registrations; },
    get flags() { return flags; },
    get task() { return task; },
  };
}

async function fixture(context) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-windows-autostart-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  return {
    stateRoot,
    system: fakeWindowsSystem(),
    taskName: "PaseoSkins-Guardian-Test",
    cliPath: path.resolve("src/cli.mjs"),
    nodeExecutablePath: process.execPath,
    guardianPath: path.resolve("src/windows-guardian.mjs"),
    remoteDebuggingPort: 9224,
    themeArguments: [],
    watcherLockImplementation: async () => ({ active: false, record: null, error: null }),
  };
}

test("Windows install creates a current-user Guardian and uninstall restores prior state", async (context) => {
  const options = await fixture(context);
  const installed = await installWindowsAutostart(options);
  assert.equal(installed.installed, true);
  assert.match(options.system.flags, /--remote-debugging-address=127\.0\.0\.1 --remote-debugging-port=9224/);
  assert.equal(options.system.registrations, 1);
  assert.equal(options.system.task.state, "Running");

  const configured = JSON.parse(await readFile(installed.configurationPath, "utf8"));
  assert.equal(configured.remoteDebuggingPort, 9224);
  assert.equal(configured.taskName, options.taskName);
  assert.match(configured.installationId, /^[0-9a-f]{32}$/);
  const status = await collectWindowsAutostartStatus(options);
  assert.equal(status.supported, true);
  assert.equal(status.cdpEnvLoaded, true);
  assert.equal(status.guardianLoaded, true);
  assert.equal(status.guardianRunning, true);

  options.system.getTask = async () => {
    try {
      const request = JSON.parse(await readFile(path.join(options.stateRoot, "windows-guardian.stop"), "utf8"));
      if (options.system.task && request.installationId === configured.installationId) {
        options.system.task.state = "Ready";
        await writeFile(path.join(options.stateRoot, "windows-guardian.stopped"),
          JSON.stringify({ ...request, childStopped: true }));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return options.system.task;
  };
  const removed = await uninstallWindowsAutostart({
    ...options,
    pollIntervalMilliseconds: 5,
    stopTimeoutMilliseconds: 500,
  });
  assert.equal(removed.uninstalled, true);
  assert.equal(options.system.flags, null);
  assert.equal(options.system.task, null);
  assert.equal((await collectWindowsAutostartStatus(options)).guardianLoaded, false);
});

test("Windows logon task uses a windowless script host for its Guardian action", async (context) => {
  const options = await fixture(context);
  await installWindowsAutostart(options);
  const task = options.system.task;
  assert.equal(path.win32.basename(task.execute).toLowerCase(), "wscript.exe");
  assert.match(task.arguments, /^\/b \/nologo /i);
  assert.match(task.arguments, /windows-guardian-launch\.vbs/i);
  assert.ok(task.arguments.includes(`"${options.nodeExecutablePath}"`));
  assert.ok(task.arguments.includes(`"${options.guardianPath}"`));
});

test("Windows hidden launcher restarts a failed Guardian and exits after a clean stop", {
  skip: process.platform !== "win32",
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-hidden-launcher-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "child-runs.bqtmp");
  const childScript = path.join(root, "child.mjs");
  const logPath = path.join(root, "launcher.log.bqtmp");
  await writeFile(childScript,
    `import { readFile, writeFile } from "node:fs/promises";\n` +
    `let runs = 0;\n` +
    `try { runs = Number(await readFile(process.argv[2], "utf8")); }\n` +
    `catch (error) { if (error.code !== "ENOENT") throw error; }\n` +
    `await new Promise((resolve) => setTimeout(resolve, 150));\n` +
    `await writeFile(process.argv[2], String(runs + 1));\n` +
    `process.exit(runs === 0 ? 7 : 0);\n`);
  const scriptHost = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const launcher = path.resolve("src/windows-guardian-launch.vbs");
  await execFileAsync(scriptHost, ["/b", "/nologo", launcher,
    process.execPath, childScript, marker, logPath],
  { timeout: 5_000, windowsHide: true });
  assert.equal(await readFile(marker, "utf8"), "2");
  const log = await readFile(logPath, "utf8");
  assert.match(log, /launcher-start/);
  assert.match(log, /launcher-exit code=7/);
  assert.match(log, /launcher-restart/);
  assert.match(log, /launcher-exit code=0/);
});

test("Windows installer recognizes a legacy visible task and requires a clean migration", async (context) => {
  const options = await fixture(context);
  const installed = await installWindowsAutostart(options);
  options.system.task.execute = options.nodeExecutablePath;
  options.system.task.arguments = `"${options.guardianPath}" "${installed.configurationPath}"`;
  options.system.task.state = "Ready";
  const status = await collectWindowsAutostartStatus(options);
  assert.equal(status.guardianLoaded, true);
  await assert.rejects(() => installWindowsAutostart(options), /Visible legacy Guardian task/);
  assert.equal(options.system.task.execute, options.nodeExecutablePath);
  const removed = await uninstallWindowsAutostart(options);
  assert.equal(removed.uninstalled, true);
  assert.equal(options.system.task, null);
  assert.equal(options.system.flags, null);
});

test("Windows install refuses a pre-existing user CDP setting without ownership", async (context) => {
  const options = await fixture(context);
  options.system.setExternalFlags("--disable-gpu");
  await assert.rejects(() => installWindowsAutostart(options), /existing PASEO_ELECTRON_FLAGS/);
  assert.equal(options.system.registrations, 0);
  assert.equal(options.system.flags, "--disable-gpu");
});

test("Windows reinstall switches configuration without registering a second task", async (context) => {
  const options = await fixture(context);
  await installWindowsAutostart(options);
  const result = await installWindowsAutostart({
    ...options,
    themeArguments: ["--theme", path.resolve("assets/stage-black-gold.theme.json")],
  });
  const configured = JSON.parse(await readFile(result.configurationPath, "utf8"));
  assert.deepEqual(configured.themeArguments, ["--theme", path.resolve("assets/stage-black-gold.theme.json")]);
  assert.equal(options.system.registrations, 1);
  assert.equal(options.system.task.state, "Running");
});

test("Windows uninstall preserves a user value changed outside this installer", async (context) => {
  const options = await fixture(context);
  await installWindowsAutostart(options);
  options.system.setExternalFlags("--disable-gpu");
  await assert.rejects(() => uninstallWindowsAutostart(options), /changed outside/);
  assert.equal(options.system.flags, "--disable-gpu");
  assert.equal(options.system.task.state, "Running");
});

test("Windows uninstall refuses to orphan an active watcher after Guardian stops", async (context) => {
  const options = await fixture(context);
  await installWindowsAutostart(options);
  options.system.task.state = "Ready";
  await assert.rejects(() => uninstallWindowsAutostart({
    ...options,
    watcherLockImplementation: async () => ({ active: true, record: { pid: 1234 } }),
  }), /watcher is still active/);
  assert.equal(options.system.flags, "--remote-debugging-address=127.0.0.1 --remote-debugging-port=9224");
  assert.ok(options.system.task);
});

test("public autostart dispatches Windows install, status, and uninstall", async (context) => {
  const options = await fixture(context);
  const selected = { ...options, platform: "win32" };
  const installed = await installAutostart(selected);
  assert.equal(installed.installed, true);
  assert.equal((await collectAutostartStatus(selected)).guardianLoaded, true);
  options.system.task.state = "Ready";
  assert.equal((await uninstallAutostart(selected)).uninstalled, true);
});
