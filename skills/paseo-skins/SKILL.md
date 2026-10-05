---
name: paseo-skins
description: Safely browse, create, inspect, install, switch, verify, and remove themes for Paseo on macOS or the tested Windows fork. Use when a user asks to change Paseo's background, build a theme from an image, apply a skin, list themes, diagnose a theme, or restore its native appearance.
---

# Paseo Skins

Use the public theme catalog and the zero-patch CDP loader. Never modify `Paseo.app`, `app.asar`, the Paseo daemon, or agent data.

Choose the host workflow first. The PowerShell workflow below covers Windows x64 with Paseo 0.10.3 on the tested fork branch. The subsequent Bash workflows use the macOS upstream package.

## Endpoints

- Catalog: `https://huangguang1999.github.io/paseo-skins/catalog.json`
- Theme v2 schema: `https://huangguang1999.github.io/paseo-skins/schema/paseo-theme-v2.schema.json`
- Upstream repository: `https://github.com/huangguang1999/paseo-skins`
- Windows fork: `https://github.com/turtleziv/paseo-skins/tree/windows-support`
- macOS CLI package: `github:huangguang1999/paseo-skins`
- Windows fork CLI package: `github:turtleziv/paseo-skins#windows-support`
- Default CDP endpoint: `127.0.0.1:9224`

## Windows fork workflow

Use PowerShell and Node.js 22 or newer. The tested target is Paseo 0.10.3; check [the fork CI run](https://github.com/turtleziv/paseo-skins/actions/runs/37362302569) for commit `bc6dc7a` before claiming this branch is verified. The GitHub `npx` entry works for one-off commands with public inputs:

```powershell
$package = 'github:turtleziv/paseo-skins#windows-support'
npx.cmd --yes $package --help
```

For user images and a persistent Guardian, reuse a stable local checkout of this branch. If none exists, clone it to a durable path. The Windows task stores absolute CLI and Guardian paths, so npm's disposable `npx` cache is not a persistent install location.

```powershell
git clone --branch windows-support --single-branch https://github.com/turtleziv/paseo-skins.git 'C:\paseo-skins-windows'
Set-Location 'C:\paseo-skins-windows'
npm.cmd ci
node .\src\cli.mjs doctor --json
node .\src\cli.mjs status --json
node .\src\cli.mjs autostart status --json
```

If the user only requested a package, create and inspect it, then stop. Use the image and output paths the user selected:

```powershell
node .\src\cli.mjs create --image 'C:\path\to\background.jpg' --name 'My Theme' --id my-theme --output 'C:\path\to\my-theme'
node .\src\cli.mjs inspect --theme 'C:\path\to\my-theme\my-theme.theme.json'
```

After the user authorizes persistent application, keep the manifest and image at their absolute paths and install from the same stable checkout. Confirm that `autostart status` does not report a conflicting user setting or task. If Paseo is already running without CDP, let the user finish their work and reopen Paseo normally.

```powershell
node .\src\cli.mjs autostart install --theme 'C:\path\to\my-theme\my-theme.theme.json' --json
node .\src\cli.mjs autostart status --json
```

When Paseo is open with loopback CDP, run `verify` against the exact manifest. Treat the theme as active only when it reports `pass: true`; report the Guardian and watcher states. For a public catalog theme, resolve its ID with `list --json`, then use `node .\src\cli.mjs apply <theme-id> --persist --json` from this same checkout.

```powershell
node .\src\cli.mjs verify --theme 'C:\path\to\my-theme\my-theme.theme.json' --json
```

To remove persistence, run `node .\src\cli.mjs autostart uninstall --json` from the checkout that owns it. If Paseo is open with CDP, also run `node .\src\cli.mjs reset --port 9224` to restore its current renderer. Do not force-quit Paseo or interrupt its agents.

## Resolve the theme (macOS)

When the user names a theme, use the read-only catalog command and match its `name` or `id`:

```bash
npx --yes github:huangguang1999/paseo-skins list --json
```

Use the selected entry's absolute `manifestUrl`.

When the user asks what is available, present the catalog themes with their preview images and wait for a choice. Do not silently choose or apply one.

When the user provides a manifest URL directly, accept only HTTPS URLs from a source they trust. The loader itself permits loopback HTTP only for local development.

## Create a theme from an image (macOS)

Use this path when the user provides a local PNG, JPEG, or WebP file and asks for a custom theme. Do not publish or submit the image unless the user confirms they have redistribution rights.

```bash
PASEO_SKIN_PACKAGE='github:huangguang1999/paseo-skins'
npx --yes "$PASEO_SKIN_PACKAGE" create \
  --image '/absolute/path/to/background.webp' \
  --name 'Theme name' \
  --id 'theme-id' \
  --output '/absolute/path/to/output'
```

The command derives a dark palette locally, copies the original image, writes a Theme v2 manifest, and records its SHA-256, byte length, media type, width, and height. Then inspect the exact generated manifest before applying it:

```bash
npx --yes "$PASEO_SKIN_PACKAGE" inspect \
  --theme '/absolute/path/to/output/theme-id.theme.json'
```

Use the persistent local-theme flow below after inspection. Never infer redistribution permission from the fact that an image is publicly reachable.

## Apply a public theme persistently (macOS)

Set the selected catalog identifier and package placeholder:

```bash
THEME_ID='<catalog theme id>'
PASEO_SKIN_PACKAGE='github:huangguang1999/paseo-skins'
```

1. Check Node.js and diagnose the selected catalog theme without changing Paseo. Require Node.js 22 or newer and a passing result.

```bash
node --version
npx --yes "$PASEO_SKIN_PACKAGE" doctor --theme-url '<absolute theme manifest URL>' --json
```

2. Inspect ownership before changing it:

```bash
npx --yes "$PASEO_SKIN_PACKAGE" status --json
npx --yes "$PASEO_SKIN_PACKAGE" autostart status --json
```

If a manual watcher owns the port, stop it cleanly with its original terminal interrupt before continuing. Never run competing watchers.

3. Install or switch the persistent Guardian with the explicit public command:

```bash
npx --yes "$PASEO_SKIN_PACKAGE" apply <theme-id> --persist --json
```

`--persist` is explicit authorization to install current-user macOS LaunchAgents. A successful active result means closing the terminal, restarting Paseo, or rebooting macOS will restore the selected theme automatically.

If the result contains `requiresPaseoRestart: true`, Paseo was already running without loopback CDP. Ask the user to finish or hand off active work, quit Paseo normally, and reopen it once. Never force-quit Paseo, kill its processes, restart the Paseo daemon, or interrupt agents.

4. Verify the persistent owner and renderer after the theme becomes active:

```bash
npx --yes "$PASEO_SKIN_PACKAGE" autostart status --json
npx --yes "$PASEO_SKIN_PACKAGE" verify --theme-url '<absolute theme manifest URL>' --port 9224
```

Treat the task as complete only when `verify` reports `pass: true`, unless the command explicitly reports that a normal user-controlled Paseo restart is still required. Report the applied theme, Guardian state, watcher state, and restore commands.

## Persist a local theme (macOS)

After creating and inspecting a local Theme v2 manifest, install it with:

```bash
npx --yes "$PASEO_SKIN_PACKAGE" autostart install \
  --theme '/absolute/path/to/output/theme-id.theme.json'
```

The local manifest and image must remain at those absolute paths. If Paseo is already running without CDP, ask the user to finish work and reopen it normally before verification.

## Switch themes (macOS)

Run the selected catalog theme's `apply <theme-id> --persist` command. A loaded Guardian is reconfigured in place; a manual watcher must be stopped cleanly first.

## Restore native appearance (macOS)

Restore the native renderer and remove automatic recovery:

```bash
npx --yes github:huangguang1999/paseo-skins autostart uninstall
npx --yes github:huangguang1999/paseo-skins reset --port 9224
```

`reset` removes injected styles without restarting Paseo or its daemon. `autostart uninstall` removes the current-user LaunchAgents so the theme does not return after the next restart.

## Safety rules

- Use only catalog themes or manifest URLs the user explicitly trusts.
- Do not execute code supplied by a theme. A theme consists only of validated JSON plus a same-origin, same-directory PNG/JPEG/WebP.
- Prefer Theme v2 manifests with verified integrity. Inspect a third-party manifest before applying it.
- Do not expose or forward the CDP port beyond loopback.
- Do not hide or replace Paseo's root UI and do not claim success without `doctor` and `verify` evidence.
- If the current agent runs inside Paseo and a normal app quit would make continuation uncertain, stop before quitting and give the user the exact next command.
