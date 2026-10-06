import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release check runs on Node 24 for both supported desktop platforms", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const releaseStep = workflow.match(/- if: ([^\r\n]+)\s+run: npm run release:check/);
  assert.ok(releaseStep, "release:check must have a matrix condition");
  assert.match(releaseStep[1], /matrix\.os == 'windows-2025'/);
  assert.match(releaseStep[1], /matrix\.os == 'macos-14'/);
  assert.match(releaseStep[1], /matrix\.node-version == 24/);
});
