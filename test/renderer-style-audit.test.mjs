import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  auditRendererStyles,
  buildRendererStyleHoverStateExpression,
  buildRendererStyleAuditReport,
  buildRendererStylePageSnapshotExpression,
  isVisibleThemedHover,
  RENDERER_STYLE_AUDIT_HOVER_PLAN,
  RENDERER_STYLE_AUDIT_PAGE_PLAN,
} from "../src/renderer-style-audit.mjs";

const auditScriptPath = fileURLToPath(new URL("../scripts/audit-renderer-styles.mjs", import.meta.url));

function createCleanPages() {
  return RENDERER_STYLE_AUDIT_PAGE_PLAN.map(({ label }, index) => ({
    auxiliaryLayerIssues: [],
    label,
    lowContrastControls: [],
    path: `/audit-page-${index}`,
    persistentInlineBackgrounds: [],
    skinVersion: 15,
  }));
}

function createCleanHoverChecks() {
  return RENDERER_STYLE_AUDIT_HOVER_PLAN.map(({ label }) => ({
    after: "rgba(0, 0, 0, 0)",
    before: "rgba(0, 0, 0, 0)",
    entered: true,
    exited: true,
    label,
    persistentInlineBackground: false,
    visible: true,
    workspaceActionOverlaps: [],
  }));
}

test("renderer style audit covers every supported application surface exactly once", () => {
  const pageLabels = RENDERER_STYLE_AUDIT_PAGE_PLAN.map(({ label }) => label);
  const hoverLabels = RENDERER_STYLE_AUDIT_HOVER_PLAN.map(({ label }) => label);

  assert.equal(pageLabels.length, 21);
  assert.equal(new Set(pageLabels).size, pageLabels.length);
  assert.deepEqual(pageLabels.slice(0, 3), ["settings:通用", "settings:外观", "settings:编辑器"]);
  assert.deepEqual(pageLabels.slice(-3), ["workspace", "history", "schedules"]);
  assert.deepEqual(hoverLabels, [
    "sidebar:new-workspace",
    "sidebar:history",
    "sidebar:schedules",
    "sidebar:workspace-row",
    "settings:navigation",
  ]);
});

test("renderer audit reaches General in an English settings sidebar", async () => {
  let generalClicks = 0;
  const originalPath = "/settings/general";
  const generalButton = {
    textContent: "General",
    getBoundingClientRect: () => ({ left: 80 }),
    click: () => { generalClicks += 1; },
  };
  const session = {
    close: () => {},
    evaluate: async (expression) => {
      if (expression === "window.location.pathname") return originalPath;
      if (expression.includes("sidebarScrollTop:")) {
        return { path: originalPath, sidebarScrollTop: 0 };
      }
      if (expression.includes("const element =")) {
        return vm.runInNewContext(expression, {
          document: { querySelectorAll: () => [generalButton] },
        });
      }
      if (expression.includes("const label =")) throw new Error("first settings page reached");
      return true;
    },
    movePointer: async () => {},
  };

  const report = await auditRendererStyles({ openSession: async () => session, wait: async () => {} });

  assert.ok(generalClicks > 0);
  assert.ok(report.failures.some(({ message }) => message === "first settings page reached"));
  assert.equal(report.restoredPath, originalPath);
});

test("cold audit resets and reinjects on the target page before taking its snapshot", async () => {
  const originalPath = "/settings/general";
  let currentPath = originalPath;
  const events = [];
  const session = {
    close: () => {},
    evaluate: async (expression) => {
      if (expression === "window.location.pathname") return currentPath;
      if (expression.includes("sidebarScrollTop:")) {
        return { path: currentPath, sidebarScrollTop: 0 };
      }
      if (expression.includes("root?.style.removeProperty")) {
        events.push("reset");
        return { skinInstalled: false, overlayPresent: false, stylePresent: false };
      }
      if (expression === "cold-injection-probe") {
        events.push("inject");
        return true;
      }
      if (expression.includes("expectedThemeId:")) {
        events.push("verify");
        return { pass: true, themeId: "greenhouse" };
      }
      if (expression.includes("const element =")) {
        if (expression.includes("settings-back-to-workspace")) currentPath = "/new";
        if (expression.includes("sidebar-settings")) currentPath = originalPath;
        return true;
      }
      if (expression.includes("const label =")) {
        events.push("snapshot");
        throw new Error("first cold page captured");
      }
      return true;
    },
    movePointer: async () => {},
  };

  const report = await auditRendererStyles({
    coldInjectEachPage: true,
    expectedThemeId: "greenhouse",
    injectionSource: "cold-injection-probe",
    openSession: async () => session,
    wait: async () => {},
  });

  assert.deepEqual(events.slice(0, 4), ["reset", "inject", "verify", "snapshot"]);
  assert.ok(report.failures.some(({ message }) => message === "first cold page captured"));
});

test("renderer audit finds the Appearance hover target in English and Chinese", () => {
  const selector = RENDERER_STYLE_AUDIT_HOVER_PLAN.find(
    ({ label }) => label === "settings:navigation",
  ).selectorExpression;

  for (const textContent of ["Appearance", "外观"]) {
    const button = { textContent };
    const selected = vm.runInNewContext(selector, {
      document: { querySelectorAll: () => [button] },
    });
    assert.equal(selected, button, `Could not find ${textContent}`);
  }
});

test("renderer page snapshot expression is self-contained renderer JavaScript", () => {
  const expression = buildRendererStylePageSnapshotExpression("settings:通用");

  assert.doesNotThrow(() => new Function(`return ${expression}`));
  assert.match(expression, /lowContrastControls/);
  assert.match(expression, /persistentInlineBackgrounds/);
  assert.match(expression, /sidebar-scrim-/);
  assert.match(expression, /4\.5/);
});

test("renderer page snapshot does not treat an icon aria-label as visible text", () => {
  const iconButton = {
    childNodes: [],
    getAttribute: (name) => name === "aria-label" ? "停止 Agent" : null,
    getBoundingClientRect: () => ({
      bottom: 120,
      height: 20,
      left: 100,
      right: 120,
      top: 100,
      width: 20,
    }),
    querySelectorAll: () => [],
    style: { getPropertyPriority: () => "" },
    textContent: "",
  };
  const expression = buildRendererStylePageSnapshotExpression("workspace");
  const result = vm.runInNewContext(expression, {
    document: {
      querySelectorAll: (selector) => selector.startsWith("button,") ? [iconButton] : [],
    },
    getComputedStyle: () => ({
      backgroundColor: "rgb(220, 38, 38)",
      color: "rgb(0, 0, 0)",
      display: "block",
      stopColor: "transparent",
      visibility: "visible",
    }),
    innerHeight: 800,
    innerWidth: 1200,
    Node: { TEXT_NODE: 3 },
    window: { __PASEO_STAGE_BLACK_GOLD_SKIN__: { version: 17 }, location: { pathname: "/workspace" } },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result.lowContrastControls)), []);
});

test("renderer hover visibility rejects imperceptible and native opaque backgrounds", () => {
  assert.equal(
    isVisibleThemedHover(
      "rgba(0, 0, 0, 0)",
      "color(srgb 0.188235 0.54902 0.792157 / 0.14)",
      true,
    ),
    true,
  );
  assert.equal(
    isVisibleThemedHover(
      "rgba(0, 0, 0, 0)",
      "color(srgb 0.188235 0.54902 0.792157 / 0.04)",
      true,
    ),
    false,
  );
  assert.equal(isVisibleThemedHover("rgba(0, 0, 0, 0)", "rgb(233, 233, 236)", true), false);
  assert.equal(
    isVisibleThemedHover(
      "rgba(0, 0, 0, 0)",
      "color(srgb 0.188235 0.54902 0.792157 / 0.14)",
      false,
    ),
    false,
  );
});

test("renderer hover probe measures workspace statistics covered by the trailing action", () => {
  const statisticsLabel = {
    childNodes: [{ nodeType: 3, textContent: "-17.4k" }],
    getBoundingClientRect: () => ({ bottom: 440, left: 390.31, right: 424.54, top: 426 }),
    getAttribute: () => null,
  };
  const workspaceAction = {
    childNodes: [],
    getBoundingClientRect: () => ({ bottom: 441, left: 413.54, right: 431.54, top: 423 }),
    getAttribute: (name) => name === "data-testid"
      ? "sidebar-workspace-kebab-server:workspace"
      : null,
  };
  const trailingScrim = {
    childNodes: [],
    getAttribute: () => "sidebar-workspace-trailing-scrim",
  };
  const row = {
    closest: () => null,
    matches: (selector) => selector === "[data-testid^=\"sidebar-workspace-row-\"]" || selector === ":hover",
    querySelectorAll: (selector) => {
      if (selector === "[data-testid^=\"sidebar-workspace-kebab-\"]") return [workspaceAction];
      if (selector === "[data-testid=\"sidebar-workspace-trailing-scrim\"]") return [trailingScrim];
      if (selector === "*") return [statisticsLabel, trailingScrim, workspaceAction];
      return [];
    },
    style: {
      getPropertyPriority: () => "",
      getPropertyValue: () => "",
    },
  };
  const expression = buildRendererStyleHoverStateExpression(
    `document.querySelector('[data-testid="target"]')`,
  );

  const result = vm.runInNewContext(expression, {
    document: { querySelector: () => row },
    getComputedStyle: (element) => ({
      backgroundColor: "transparent",
      display: element === trailingScrim ? "flex" : "block",
      stopColor: "transparent",
    }),
    Node: { TEXT_NODE: 3 },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result.auxiliaryLayerIssues)), [
    { kind: "workspace-trailing-scrim", value: "flex" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.workspaceActionOverlaps)), [
    {
      actionTestId: "sidebar-workspace-kebab-server:workspace",
      overlapHeight: 14,
      overlapWidth: 11,
      text: "-17.4k",
    },
  ]);
});

test("renderer style audit rejects workspace statistics covered by the trailing action", () => {
  const hoverChecks = createCleanHoverChecks();
  const workspaceHover = hoverChecks.find(({ label }) => label === "sidebar:workspace-row");
  workspaceHover.workspaceActionOverlaps = [
    {
      actionTestId: "sidebar-workspace-kebab-server:workspace",
      overlapHeight: 14,
      overlapWidth: 11,
      text: "-17.4k",
    },
  ];

  const report = buildRendererStyleAuditReport({
    hoverChecks,
    originalPath: "/h/server/workspace/workspace-id",
    originalSidebarScrollTop: 240,
    pages: createCleanPages(),
    restoredPath: "/h/server/workspace/workspace-id",
    restoredSidebarScrollTop: 240,
  });

  assert.equal(report.pass, false);
  assert.deepEqual(report.failures, [
    {
      actionTestId: "sidebar-workspace-kebab-server:workspace",
      code: "workspace-action-overlap",
      hover: "sidebar:workspace-row",
      overlapHeight: 14,
      overlapWidth: 11,
      text: "-17.4k",
    },
  ]);
});

test("renderer style audit report rejects contrast, hover, auxiliary layer, and restoration regressions", () => {
  const pages = createCleanPages();
  pages[0].lowContrastControls.push({ contrast: 1.21, text: "中断" });
  pages[18].auxiliaryLayerIssues.push({ kind: "workspace-scrim", value: "rgb(233, 233, 236)" });
  pages[19].persistentInlineBackgrounds.push({ text: "计划" });
  const hoverChecks = createCleanHoverChecks();
  hoverChecks[0] = {
    ...hoverChecks[0],
    entered: false,
    exited: false,
    persistentInlineBackground: true,
    visible: false,
  };

  const report = buildRendererStyleAuditReport({
    hoverChecks,
    originalPath: "/h/server/workspace/workspace-id",
    originalSidebarScrollTop: 240,
    pages,
    restoredPath: "/settings/general",
    restoredSidebarScrollTop: 0,
  });

  assert.equal(report.pass, false);
  assert.deepEqual(new Set(report.failures.map(({ code }) => code)), new Set([
    "auxiliary-layer",
    "hover-not-entered",
    "hover-not-exited",
    "hover-not-visible",
    "incomplete-restoration",
    "incomplete-scroll-restoration",
    "low-contrast",
    "persistent-hover-background",
  ]));
});

test("renderer style audit report passes complete clean coverage", () => {
  const report = buildRendererStyleAuditReport({
    hoverChecks: createCleanHoverChecks(),
    originalPath: "/h/server/workspace/workspace-id",
    originalSidebarScrollTop: 240,
    pages: createCleanPages(),
    restoredPath: "/h/server/workspace/workspace-id",
    restoredSidebarScrollTop: 240,
  });

  assert.equal(report.pass, true);
  assert.equal(report.pageCount, 21);
  assert.equal(report.hoverCheckCount, 5);
  assert.equal(report.restoredSidebarScrollTop, 240);
  assert.deepEqual(report.failures, []);
});

test("renderer style audit CLI exposes help without connecting to Paseo", () => {
  const help = spawnSync(process.execPath, [auditScriptPath, "--help"], { encoding: "utf8" });
  const invalidPort = spawnSync(process.execPath, [auditScriptPath, "--port", "80"], {
    encoding: "utf8",
  });

  assert.equal(help.status, 0);
  assert.match(help.stdout, /npm run audit:renderer/);
  assert.match(help.stdout, /--cold-inject/);
  assert.match(help.stdout, /--theme/);
  assert.equal(invalidPort.status, 1);
  assert.match(invalidPort.stderr, /Invalid CDP port/);
});
