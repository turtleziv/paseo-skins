#!/usr/bin/env node

import { auditRendererStyles } from "../src/renderer-style-audit.mjs";
import { buildStageBlackGoldInjectionSource } from "../src/stage-black-gold-skin.mjs";
import { loadTheme } from "../src/theme-loader.mjs";

function printHelp() {
  console.log(`Paseo renderer style audit

Usage:
  npm run audit:renderer -- [--port <number>] [--include-development-targets]
  npm run audit:renderer -- --cold-inject --theme <manifest> [--port <number>]

The audit safely visits supported Paseo pages, checks visible text contrast,
hover enter/exit behavior, persistent inline backgrounds, and workspace action
scrims, then restores the original route and sidebar scroll position.
Cold injection removes the skin on each target page, injects the validated
theme again, and verifies the result before taking the page snapshot.

Keep the Paseo window visible and foregrounded so native hover events can run.
The command prints JSON and exits non-zero when a check fails.`);
}

function parseArguments(argumentsList) {
  const options = {
    coldInjectEachPage: false,
    includeDevelopmentTargets: false,
    remoteDebuggingPort: 9224,
    themeManifest: null,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true, ...options };
    }
    if (argument === "--include-development-targets") {
      options.includeDevelopmentTargets = true;
      continue;
    }
    if (argument === "--cold-inject") {
      options.coldInjectEachPage = true;
      continue;
    }
    if (argument === "--theme") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--theme requires a manifest path");
      options.themeManifest = value;
      index += 1;
      continue;
    }
    if (argument === "--port") {
      const value = argumentsList[index + 1];
      if (!value) throw new Error("--port requires a value");
      options.remoteDebuggingPort = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (
    !Number.isInteger(options.remoteDebuggingPort) ||
    options.remoteDebuggingPort < 1024 ||
    options.remoteDebuggingPort > 65535
  ) {
    throw new Error(`Invalid CDP port: ${options.remoteDebuggingPort}`);
  }
  if (options.coldInjectEachPage && !options.themeManifest) {
    throw new Error("--cold-inject requires --theme");
  }
  if (!options.coldInjectEachPage && options.themeManifest) {
    throw new Error("--theme requires --cold-inject");
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else {
    const loadedTheme = options.coldInjectEachPage
      ? await loadTheme(options.themeManifest)
      : null;
    const report = await auditRendererStyles({
      ...options,
      expectedThemeId: loadedTheme?.theme.id ?? null,
      injectionSource: loadedTheme
        ? buildStageBlackGoldInjectionSource({
          heroImageDataUrl: loadedTheme.image.dataUrl,
          theme: loadedTheme.theme,
        })
        : null,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.pass) process.exitCode = 1;
  }
} catch (error) {
  console.error(`[paseo-skin] ${error.message}`);
  process.exitCode = 1;
}
