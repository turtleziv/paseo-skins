import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readWatcherLock } from "./watcher-lock.mjs";

const executeFile = promisify(execFile);
const SCHEMA_VERSION = 1;
const STATE_DIRECTORY = ".paseo-skin-loader";
const CONFIGURATION_FILE = "windows-autostart.json";
const STOP_FILE = "windows-guardian.stop";
const STOPPED_FILE = "windows-guardian.stopped";
const LOG_FILE = "windows-autostart.log";
const ENVIRONMENT_NAME = "PASEO_ELECTRON_FLAGS";
const DEFAULT_CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const DEFAULT_GUARDIAN_PATH = fileURLToPath(new URL("./windows-guardian.mjs", import.meta.url));

function powershellLiteral(value) {
  const source = String(value);
  if (/[\r\n\0]/.test(source)) throw new Error("Windows task value contains a control character");
  return `'${source.replaceAll("'", "''")}'`;
}

function taskArguments(guardianPath, configurationPath) {
  if (guardianPath.includes('"') || configurationPath.includes('"')) {
    throw new Error("Windows Guardian paths cannot contain quotes");
  }
  return `"${guardianPath}" "${configurationPath}"`;
}

function scriptHostPath(environment = process.env) {
  return path.win32.join(environment.SystemRoot || environment.WINDIR || "C:\\Windows",
    "System32", "wscript.exe");
}

function hiddenTaskArguments(configuration, configurationPath) {
  const launcherPath = path.join(path.dirname(configuration.guardianPath), "windows-guardian-launch.vbs");
  const values = [launcherPath, configuration.nodeExecutablePath, configuration.guardianPath,
    configurationPath, configuration.logPath];
  if (values.some((value) => /["\r\n\0]/.test(value))) {
    throw new Error("Windows Guardian paths cannot contain quotes or control characters");
  }
  return `/b /nologo ${values.map((value) => `"${value}"`).join(" ")}`;
}

function powershellPath(environment) {
  return path.win32.join(
    environment.SystemRoot || environment.WINDIR || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
}

export function createWindowsSystem({
  environment = process.env,
  executeFileImplementation = executeFile,
} = {}) {
  const executable = powershellPath(environment);
  const run = async (body) => {
    const { stdout } = await executeFileImplementation(
      executable,
      ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${body}`],
      { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
  };
  return {
    async identity() {
      return JSON.parse(await run(
        "[pscustomobject]@{name=[Security.Principal.WindowsIdentity]::GetCurrent().Name;" +
        "sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress",
      ));
    },
    async getUserFlags() {
      const output = await run(
        `$v=[Environment]::GetEnvironmentVariable('${ENVIRONMENT_NAME}','User'); ` +
        "if($null -eq $v){Write-Output 'null'}else{ConvertTo-Json -InputObject $v -Compress}",
      );
      return JSON.parse(output);
    },
    async setUserFlags(value) {
      await run(
        `[Environment]::SetEnvironmentVariable('${ENVIRONMENT_NAME}',` +
        `${value === null ? "$null" : powershellLiteral(value)},'User')`,
      );
    },
    async getTask(taskName) {
      const output = await run(
        `try {$t=Get-ScheduledTask -TaskName ${powershellLiteral(taskName)} -TaskPath '\\' -ErrorAction Stop; ` +
        "[pscustomobject]@{name=$t.TaskName;description=$t.Description;state=[string]$t.State;" +
        "execute=$t.Actions[0].Execute;arguments=$t.Actions[0].Arguments} | ConvertTo-Json -Compress} " +
        "catch {if($_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound)" +
        "{Write-Output 'null'}else{throw}}",
      );
      return JSON.parse(output);
    },
    async registerTask(specification) {
      const body = [
        `$action=New-ScheduledTaskAction -Execute ${powershellLiteral(specification.taskExecutablePath)}` +
          ` -Argument ${powershellLiteral(specification.arguments)}` +
          ` -WorkingDirectory ${powershellLiteral(specification.stateRoot)}`,
        `$trigger=New-ScheduledTaskTrigger -AtLogOn -User ${powershellLiteral(specification.userName)}`,
        `$principal=New-ScheduledTaskPrincipal -UserId ${powershellLiteral(specification.userName)}` +
          " -LogonType Interactive -RunLevel Limited",
        "$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew" +
          " -ExecutionTimeLimit (New-TimeSpan -Seconds 0)" +
          " -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DisallowHardTerminate" +
          " -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
        `Register-ScheduledTask -TaskName ${powershellLiteral(specification.taskName)}` +
          " -TaskPath '\\' -Action $action -Trigger $trigger -Principal $principal" +
          ` -Settings $settings -Description ${powershellLiteral(specification.description)}` +
          " -ErrorAction Stop | Out-Null",
      ].join("; ");
      await run(body);
    },
    async startTask(taskName) {
      await run(`Start-ScheduledTask -TaskName ${powershellLiteral(taskName)} -TaskPath '\\' -ErrorAction Stop`);
    },
    async unregisterTask(taskName) {
      await run(`Unregister-ScheduledTask -TaskName ${powershellLiteral(taskName)} -TaskPath '\\' -Confirm:$false -ErrorAction Stop`);
    },
  };
}

function validateThemeArguments(themeArguments) {
  if (!Array.isArray(themeArguments) || !themeArguments.every((argument) => typeof argument === "string")) {
    throw new Error("Windows autostart theme arguments must be strings");
  }
  if (themeArguments.length === 0) return themeArguments;
  if (themeArguments.length !== 2 || !["--theme", "--theme-url"].includes(themeArguments[0])) {
    throw new Error("Windows autostart theme arguments have an invalid shape");
  }
  if (themeArguments[0] === "--theme" && !path.isAbsolute(themeArguments[1])) {
    throw new Error("Windows autostart theme manifest must be absolute");
  }
  if (themeArguments[0] === "--theme-url") {
    const url = new URL(themeArguments[1]);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("Windows autostart theme URL must be credential-free HTTPS");
    }
  }
  return themeArguments;
}

export function validateWindowsConfiguration(configuration) {
  if (
    !configuration ||
    configuration.schemaVersion !== SCHEMA_VERSION ||
    !/^[0-9a-f]{32}$/.test(configuration.installationId ?? "") ||
    !/^[0-9a-f]{32}$/.test(configuration.generation ?? "") ||
    !/^S-\d+(?:-\d+)+$/.test(configuration.userSid ?? "") ||
    !/^[A-Za-z0-9-]{1,128}$/.test(configuration.taskName ?? "") ||
    !["cliPath", "nodeExecutablePath", "guardianPath", "logPath"].every(
      (key) => typeof configuration[key] === "string" && path.isAbsolute(configuration[key]),
    ) ||
    !Number.isInteger(configuration.remoteDebuggingPort) ||
    configuration.remoteDebuggingPort < 1024 ||
    configuration.remoteDebuggingPort > 65535 ||
    configuration.ownedFlags !== flagsForPort(configuration.remoteDebuggingPort)
  ) {
    throw new Error("Windows autostart configuration has an invalid schema");
  }
  validateThemeArguments(configuration.themeArguments);
  return configuration;
}

export function flagsForPort(remoteDebuggingPort) {
  if (!Number.isInteger(remoteDebuggingPort) || remoteDebuggingPort < 1024 || remoteDebuggingPort > 65535) {
    throw new Error("Invalid Windows autostart CDP port");
  }
  return `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${remoteDebuggingPort}`;
}

async function readConfiguration(configurationPath) {
  try {
    return validateWindowsConfiguration(JSON.parse(await readFile(configurationPath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readReceipt(receiptPath) {
  try {
    return JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeWindowsConfiguration(configurationPath, value) {
  const temporaryPath = `${configurationPath}.${randomBytes(8).toString("hex")}.bqtmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(temporaryPath, configurationPath);
      return;
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
          attempt === 4) throw error;
      await delay(10 * (2 ** attempt));
    }
  }
}

async function appendEvent(stateRoot, event, details = "") {
  await appendFile(path.join(stateRoot, LOG_FILE),
    `${new Date().toISOString()} ${event}${details ? ` ${details}` : ""}\n`);
}

function ownedTask(task, configuration, configurationPath) {
  const sameIdentity = Boolean(
    task &&
    task.name === configuration.taskName &&
    task.description === `Paseo Skins Guardian ${configuration.installationId}`,
  );
  return sameIdentity && (hiddenTask(task, configuration, configurationPath) ||
    (path.normalize(task.execute).toLowerCase() ===
      path.normalize(configuration.nodeExecutablePath).toLowerCase() &&
      task.arguments === taskArguments(configuration.guardianPath, configurationPath)));
}

function hiddenTask(task, configuration, configurationPath) {
  return path.normalize(task.execute).toLowerCase() === path.normalize(scriptHostPath()).toLowerCase() &&
    task.arguments === hiddenTaskArguments(configuration, configurationPath);
}

function paths(stateRoot) {
  return {
    configurationPath: path.join(stateRoot, CONFIGURATION_FILE),
    stopPath: path.join(stateRoot, STOP_FILE),
    stoppedPath: path.join(stateRoot, STOPPED_FILE),
    logPath: path.join(stateRoot, LOG_FILE),
  };
}

async function ownerState({ stateRoot, system, taskName }) {
  const identity = await system.identity();
  if (!/^S-\d+(?:-\d+)+$/.test(identity.sid ?? "") || typeof identity.name !== "string") {
    throw new Error("Could not identify the current Windows user");
  }
  const name = taskName ?? `PaseoSkins-Guardian-${identity.sid}`;
  if (!/^[A-Za-z0-9-]{1,128}$/.test(name)) throw new Error("Invalid Windows Guardian task name");
  const files = paths(stateRoot);
  const [configuration, task, userFlags] = await Promise.all([
    readConfiguration(files.configurationPath),
    system.getTask(name),
    system.getUserFlags(),
  ]);
  if (configuration && (configuration.userSid !== identity.sid || configuration.taskName !== name)) {
    throw new Error("Windows autostart configuration belongs to another user or task");
  }
  return { identity, name, files, configuration, task, userFlags };
}

export async function collectWindowsAutostartStatus({
  stateRoot = path.join(os.homedir(), STATE_DIRECTORY),
  taskName = null,
  system = createWindowsSystem(),
} = {}) {
  const state = await ownerState({ stateRoot, taskName, system });
  const ownsTask = state.configuration
    ? ownedTask(state.task, state.configuration, state.files.configurationPath)
    : false;
  return {
    supported: true,
    cdpEnvLoaded: Boolean(state.configuration && state.userFlags === state.configuration.ownedFlags),
    guardianLoaded: ownsTask,
    guardianRunning: ownsTask && state.task.state === "Running",
    cdpEnvLabel: ENVIRONMENT_NAME,
    guardianLabel: state.name,
    configurationPath: state.files.configurationPath,
    logPath: state.files.logPath,
    problem: state.task && !ownsTask ? "Guardian task is not owned by this installation" : null,
  };
}

export async function installWindowsAutostart({
  remoteDebuggingPort,
  themeArguments = [],
  cliPath = DEFAULT_CLI_PATH,
  nodeExecutablePath = process.execPath,
  guardianPath = DEFAULT_GUARDIAN_PATH,
  stateRoot = path.join(os.homedir(), STATE_DIRECTORY),
  taskName = null,
  system = createWindowsSystem(),
} = {}) {
  const ownedFlags = flagsForPort(remoteDebuggingPort);
  validateThemeArguments(themeArguments);
  for (const filePath of [cliPath, nodeExecutablePath, guardianPath]) {
    if (!path.isAbsolute(filePath)) throw new Error("Windows Guardian executable paths must be absolute");
  }
  const state = await ownerState({ stateRoot, taskName, system });
  if (state.task && (!state.configuration || !ownedTask(state.task, state.configuration, state.files.configurationPath))) {
    throw new Error("An existing Guardian task is not owned by this installation");
  }
  if (state.task && !hiddenTask(state.task, state.configuration, state.files.configurationPath)) {
    throw new Error("Visible legacy Guardian task must be removed with autostart uninstall before reinstalling");
  }
  if (!state.configuration && state.userFlags !== null) {
    throw new Error("An existing PASEO_ELECTRON_FLAGS value is not owned by this installation");
  }
  if (state.configuration && state.userFlags !== state.configuration.ownedFlags) {
    throw new Error("PASEO_ELECTRON_FLAGS changed outside this installation");
  }
  await mkdir(stateRoot, { mode: 0o700, recursive: true });
  const sameConfiguration = Boolean(
    state.configuration &&
    state.configuration.remoteDebuggingPort === remoteDebuggingPort &&
    state.configuration.cliPath === cliPath &&
    state.configuration.nodeExecutablePath === nodeExecutablePath &&
    state.configuration.guardianPath === guardianPath &&
    JSON.stringify(state.configuration.themeArguments) === JSON.stringify(themeArguments),
  );
  if (sameConfiguration && state.task) {
    if (state.task.state !== "Running") await system.startTask(state.name);
    await appendEvent(stateRoot, "install-skip", "configuration already active");
    return { installed: true, alreadyConfigured: true, taskName: state.name,
      configurationPath: state.files.configurationPath, logPath: state.files.logPath };
  }
  const next = validateWindowsConfiguration({
    schemaVersion: SCHEMA_VERSION,
    installationId: state.configuration?.installationId ?? randomBytes(16).toString("hex"),
    generation: randomBytes(16).toString("hex"),
    userSid: state.identity.sid,
    taskName: state.name,
    cliPath,
    nodeExecutablePath,
    guardianPath,
    logPath: state.files.logPath,
    remoteDebuggingPort,
    themeArguments,
    ownedFlags,
  });
  const firstInstall = !state.configuration;
  let registered = false;
  let changedFlags = false;
  let wroteConfiguration = false;
  try {
    if (state.userFlags !== ownedFlags) {
      await system.setUserFlags(ownedFlags);
      changedFlags = true;
      if (await system.getUserFlags() !== ownedFlags) throw new Error("Windows user CDP environment did not persist");
    }
    await writeWindowsConfiguration(state.files.configurationPath, next);
    wroteConfiguration = true;
    if (!state.task) {
      await system.registerTask({
        taskName: state.name,
        userName: state.identity.name,
        nodeExecutablePath,
        taskExecutablePath: scriptHostPath(),
        stateRoot,
        arguments: hiddenTaskArguments(next, state.files.configurationPath),
        description: `Paseo Skins Guardian ${next.installationId}`,
      });
      registered = true;
    }
    if (!state.task || state.task.state !== "Running") await system.startTask(state.name);
    await appendEvent(stateRoot, firstInstall ? "install" : "reconfigure",
      `port=${remoteDebuggingPort} task=${state.name}`);
    return { installed: true, alreadyConfigured: false, taskName: state.name,
      configurationPath: state.files.configurationPath, logPath: state.files.logPath };
  } catch (error) {
    if (registered) await system.unregisterTask(state.name).catch(() => {});
    if (wroteConfiguration) {
      if (state.configuration) await writeWindowsConfiguration(state.files.configurationPath, state.configuration).catch(() => {});
      else await unlink(state.files.configurationPath).catch(() => {});
    }
    if (changedFlags) await system.setUserFlags(state.userFlags).catch(() => {});
    await appendEvent(stateRoot, "install-failed", error.message).catch(() => {});
    throw error;
  }
}

export async function uninstallWindowsAutostart({
  stateRoot = path.join(os.homedir(), STATE_DIRECTORY),
  taskName = null,
  system = createWindowsSystem(),
  watcherLockImplementation = readWatcherLock,
  stopTimeoutMilliseconds = 15_000,
  pollIntervalMilliseconds = 250,
} = {}) {
  const state = await ownerState({ stateRoot, taskName, system });
  if (!state.configuration) {
    if (state.task) throw new Error("Existing Guardian task has no ownership record");
    return { uninstalled: true, alreadyAbsent: true, removed: [] };
  }
  if (state.task && !ownedTask(state.task, state.configuration, state.files.configurationPath)) {
    throw new Error("Guardian task changed outside this installation");
  }
  if (state.userFlags !== state.configuration.ownedFlags) {
    throw new Error("PASEO_ELECTRON_FLAGS changed outside this installation");
  }
  if (state.task?.state === "Running") {
    const request = {
      installationId: state.configuration.installationId,
      generation: state.configuration.generation,
    };
    await writeFile(state.files.stopPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    await appendEvent(stateRoot, "stop-requested", `task=${state.name}`);
    const deadline = Date.now() + stopTimeoutMilliseconds;
    let stopped = false;
    while (Date.now() < deadline) {
      const [task, receipt] = await Promise.all([
        system.getTask(state.name),
        readReceipt(state.files.stoppedPath),
      ]);
      if (task?.state !== "Running" &&
        receipt?.installationId === request.installationId &&
        receipt?.generation === request.generation &&
        receipt?.childStopped === true) {
        stopped = true;
        break;
      }
      await delay(pollIntervalMilliseconds);
    }
    if (!stopped) {
      await appendEvent(stateRoot, "stop-timeout", `task=${state.name}`);
      throw new Error("Windows Guardian did not acknowledge a clean stop");
    }
  }
  const watcher = await watcherLockImplementation(state.configuration.remoteDebuggingPort);
  if (watcher.active) {
    throw new Error("A watcher is still active; stop it cleanly before removing Windows autostart");
  }
  if (watcher.error) {
    throw new Error(`Watcher ownership could not be checked: ${watcher.error}`);
  }
  if (state.task) await system.unregisterTask(state.name);
  await system.setUserFlags(null);
  if (await system.getUserFlags() !== null) {
    throw new Error("Windows user CDP environment was not removed");
  }
  await unlink(state.files.configurationPath);
  await unlink(state.files.stopPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await unlink(state.files.stoppedPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await appendEvent(stateRoot, "uninstall", `task=${state.name}`);
  return { uninstalled: true, alreadyAbsent: false, removed: [state.name, ENVIRONMENT_NAME,
    state.files.configurationPath], logPath: state.files.logPath };
}
