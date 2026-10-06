import assert from "node:assert/strict";
import test from "node:test";

import { getApplyCommand, resolveCatalogTheme } from "../site/common.js";

const catalog = {
  themes: [
    { id: "first-theme", name: "First" },
    { id: "second-theme", name: "Second" },
  ],
};

test("catalog theme resolution is strict by default", () => {
  assert.equal(resolveCatalogTheme(catalog, "second-theme").summary.id, "second-theme");
  assert.throws(() => resolveCatalogTheme(catalog, "missing-theme"), /未找到主题/);
});

test("catalog theme resolution reports explicit fallback", () => {
  const result = resolveCatalogTheme(catalog, "missing-theme", { fallbackToFirst: true });
  assert.equal(result.summary.id, "first-theme");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.requestedThemeId, "missing-theme");
});

test("Windows apply command boots a durable checkout before installing Guardian", () => {
  const command = getApplyCommand("morning-mist", "windows");
  assert.match(command, /Join-Path \$HOME 'paseo-skins'/);
  assert.match(command, /git clone https:\/\/github\.com\/huangguang1999\/paseo-skins\.git/);
  assert.match(command, /npm\.cmd ci --prefix \$p/);
  assert.match(command, /git -C \$p remote get-url origin/);
  assert.match(command, /node \(Join-Path \$p 'src\/cli\.mjs'\) apply morning-mist --persist/);
  assert.doesNotMatch(command, /npx/);
});

test("macOS apply command boots a durable checkout before installing Guardian", () => {
  const command = getApplyCommand("morning-mist", "macos");
  assert.match(command, /\$HOME\/paseo-skins/);
  assert.match(command, /git clone https:\/\/github\.com\/huangguang1999\/paseo-skins\.git/);
  assert.match(command, /npm ci --prefix "\$p"/);
  assert.match(command, /git -C "\$p" remote get-url origin/);
  assert.match(command, /node "\$p\/src\/cli\.mjs" apply morning-mist --persist/);
  assert.doesNotMatch(command, /npx/);
});

test("apply command rejects shell input in catalog identifiers", () => {
  assert.throws(() => getApplyCommand("morning-mist; echo unsafe", "windows"), /主题 ID/);
});
