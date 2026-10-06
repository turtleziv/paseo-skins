import assert from "node:assert/strict";
import test from "node:test";

import * as integration from "../site/agent-integration.js";

const {
  getAgentPrompt,
  getApplyCommand,
  getInstallCommand,
  SKILL_INSTALL_COMMAND,
  SKILL_INSTALL_COMMAND_WINDOWS,
} = integration;

const theme = {
  id: "morning-mist",
  name: "晨雾山水",
  manifest: "./themes/morning-mist.theme.json",
};
const pageUrl = "https://huangguang1999.github.io/paseo-skins/";

test("agent prompt contains the selected theme, skill, safety boundary, and verification", () => {
  const prompt = getAgentPrompt(theme, pageUrl);

  assert.match(prompt, /晨雾山水/);
  assert.match(prompt, /https:\/\/huangguang1999\.github\.io\/paseo-skins\/SKILL\.md/);
  assert.match(prompt, /themes\/morning-mist\.theme\.json/);
  assert.match(prompt, /doctor/);
  assert.match(prompt, /固定 checkout/);
  assert.match(prompt, /apply morning-mist --persist/);
  assert.match(prompt, /verify/);
  assert.match(prompt, /不要强退或重启/);
});

test("manual and persistent connection commands target the public project", () => {
  const windowsCommand = getApplyCommand(theme, "windows");
  const macCommand = getApplyCommand(theme, "macos");
  assert.match(windowsCommand, /npm\.cmd ci --prefix \$p/);
  assert.match(macCommand, /npm ci --prefix "\$p"/);
  assert.match(windowsCommand, /apply morning-mist --persist/);
  assert.match(macCommand, /apply morning-mist --persist/);
  assert.doesNotMatch(windowsCommand + macCommand, /npx --yes .* --persist/);
  assert.equal(
    getInstallCommand(theme, pageUrl, "macos"),
    "npx --yes github:huangguang1999/paseo-skins start --theme-url " +
      "'https://huangguang1999.github.io/paseo-skins/themes/morning-mist.theme.json'",
  );
  assert.equal(
    getInstallCommand(theme, pageUrl, "windows"),
    "npx.cmd --yes github:huangguang1999/paseo-skins start --theme-url " +
      "'https://huangguang1999.github.io/paseo-skins/themes/morning-mist.theme.json'",
  );
  assert.equal(
    SKILL_INSTALL_COMMAND,
    "npx skills add huangguang1999/paseo-skins --skill paseo-skins -g",
  );
  assert.equal(
    SKILL_INSTALL_COMMAND_WINDOWS,
    "npx.cmd skills add huangguang1999/paseo-skins --skill paseo-skins -g",
  );
});
