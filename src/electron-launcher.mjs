import { execFile, spawn } from "node:child_process";
import { access, constants as fileSystemConstants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export function resolveDefaultPaseoExecutable({
  platform = process.platform,
  environment = process.env,
} = {}) {
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA || path.win32.join(
      environment.USERPROFILE || os.homedir(), "AppData", "Local",
    );
    return path.win32.join(localAppData, "Programs", "Paseo", "Paseo.exe");
  }
  return "/Applications/Paseo.app/Contents/MacOS/Paseo";
}

export const DEFAULT_PASEO_EXECUTABLE = resolveDefaultPaseoExecutable();

export function mergeElectronFlags(existingFlags, remoteDebuggingPort) {
  const tokens = String(existingFlags ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter(
      (token) =>
        !token.startsWith("--remote-debugging-address=") &&
        !token.startsWith("--remote-debugging-port="),
    );

  tokens.push("--remote-debugging-address=127.0.0.1");
  tokens.push(`--remote-debugging-port=${remoteDebuggingPort}`);
  return tokens.join(" ");
}

export function buildPaseoLaunchEnvironment(environment, remoteDebuggingPort) {
  return {
    ...environment,
    PASEO_ELECTRON_FLAGS: mergeElectronFlags(environment.PASEO_ELECTRON_FLAGS, remoteDebuggingPort),
  };
}

export async function isPaseoApplicationRunning({
  paseoExecutable = DEFAULT_PASEO_EXECUTABLE,
  executeFileImplementation = executeFile,
  platform = process.platform,
  environment = process.env,
} = {}) {
  if (platform === "win32") {
    const systemRoot = environment.SystemRoot || environment.WINDIR || "C:\\Windows";
    const powershellExecutable = path.win32.join(
      systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
    );
    const { stdout } = await executeFileImplementation(
      powershellExecutable,
      ["-NoProfile", "-NonInteractive", "-Command", "@(Get-Process -Name Paseo -ErrorAction SilentlyContinue).Count"],
      { timeout: 2_000, windowsHide: true },
    );
    const processCount = stdout.trim();
    if (!/^\d+$/.test(processCount)) {
      throw new Error("Could not read the Paseo process count on Windows");
    }
    return Number(processCount) > 0;
  }
  const { stdout } = await executeFileImplementation("/bin/ps", ["-axo", "command="]);
  return stdout
    .split("\n")
    .map((command) => command.trim())
    .some((command) => command === paseoExecutable || command.startsWith(`${paseoExecutable} `));
}

export async function launchPaseoWithCdp({
  remoteDebuggingPort,
  paseoExecutable = DEFAULT_PASEO_EXECUTABLE,
  environment = process.env,
  spawnImplementation = spawn,
} = {}) {
  await access(paseoExecutable, fileSystemConstants.X_OK);

  const childProcess = spawnImplementation(paseoExecutable, [], {
    detached: true,
    env: buildPaseoLaunchEnvironment(environment, remoteDebuggingPort),
    stdio: "ignore",
  });
  childProcess.unref();
  return childProcess.pid;
}
