import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPaseoLaunchEnvironment,
  isPaseoApplicationRunning,
  mergeElectronFlags,
  resolveDefaultPaseoExecutable,
} from "../src/electron-launcher.mjs";

test("Windows default Paseo executable follows LOCALAPPDATA", () => {
  const actual = resolveDefaultPaseoExecutable({
    platform: "win32",
    environment: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
  });

  assert.equal(actual, "C:\\Users\\tester\\AppData\\Local\\Programs\\Paseo\\Paseo.exe");
});

test("Windows process detection recognizes a running Paseo", async () => {
  for (const [stdout, expected] of [["2\r\n", true], ["0\r\n", false]]) {
    const actual = await isPaseoApplicationRunning({
      platform: "win32",
      executeFileImplementation: async () => ({ stdout }),
    });
    assert.equal(actual, expected);
  }
});

test("mergeElectronFlags preserves unrelated flags and owns the local CDP endpoint", () => {
  const result = mergeElectronFlags(
    "--disable-gpu --remote-debugging-port=9000 --remote-debugging-address=0.0.0.0",
    9224,
  );

  assert.equal(
    result,
    "--disable-gpu --remote-debugging-address=127.0.0.1 --remote-debugging-port=9224",
  );
});

test("buildPaseoLaunchEnvironment does not mutate the caller environment", () => {
  const environment = {
    HOME: "/tmp/example-home",
    PASEO_ELECTRON_FLAGS: "--disable-gpu",
  };

  const result = buildPaseoLaunchEnvironment(environment, 9334);

  assert.deepEqual(environment, {
    HOME: "/tmp/example-home",
    PASEO_ELECTRON_FLAGS: "--disable-gpu",
  });
  assert.equal(result.HOME, "/tmp/example-home");
  assert.equal(
    result.PASEO_ELECTRON_FLAGS,
    "--disable-gpu --remote-debugging-address=127.0.0.1 --remote-debugging-port=9334",
  );
});
