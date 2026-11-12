# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The project rules live in `AGENTS.md` and are imported here. They are binding: keep the product identity `Deskland Preview`, keep the app free of purchase and update prompts, and never touch `prototype/thumbs/` unasked.

@AGENTS.md

## Commands

There is no test suite, linter or package manager. Verification is manual, in the browser preview and in the real host.

```powershell
# Build the Windows host (uses the .NET Framework csc.exe that ships with Windows; first run downloads WebView2 SDK into host/lib/)
powershell -ExecutionPolicy Bypass -File host\build.ps1
host\bin\Deskland.exe            # start wallpaper + open settings
host\bin\Deskland.exe --exit     # quit and restore the system wallpaper

# Browser preview (sample icons only; real icon adaptation needs the host)
node prototype\serve.mjs         # http://localhost:5178/settings.html, or /flat.html, /meadow.html standalone

# Installer (NSIS, output in dist/ with SHA256 and source ZIP); version comes from tools/version.json
powershell -ExecutionPolicy Bypass -File tools\build-installer.ps1

# Debug: dump the Progman/WorkerW window hierarchy
powershell -ExecutionPolicy Bypass -File host\inspect.ps1
```

Set the environment variable `DESKLAND_PROFILE_DIR` to an absolute path to run the host with an isolated profile (settings, WebView2 cache, single-instance event). That mode skips data migration and does not write the startup entry.

## Architecture

The product has two halves that run from the same files: a C# WinForms host, and plain HTML/JS pages in `prototype/`.

**Host (`host/DesktopHost.cs`, `host/Themes.cs`).** The host is a single-file .NET Framework 4.x app compiled directly by `csc.exe` (see `build.ps1` for the reference list; there is no .csproj). It embeds WebView2 windows and parents the wallpaper window under the desktop icon layer. On Windows 11 24H2+ it uses a layered Progman child window; on older builds it uses WorkerW. It maps `prototype/` to the virtual host `app.local`, so both the settings window and the wallpaper load pages from disk. The host polls desktop icon rectangles every 400ms, pauses when a foreground window is maximized or full-screen, and stores settings in `%LOCALAPPDATA%\DesklandPreview\settings.json` with a `host.log` beside it. Changes to theme HTML/JS only need the tray "Reload" command. Changes to C# need an exit, rebuild and restart.

**Theme manifest (`prototype/themes.json`).** One manifest drives both the host and the settings UI. `Themes.cs` loads any theme whose `status` is `ready` and that has a `page`. Each theme declares `groups[].params` (sliders with min/max/step/default, or `options` toggles), and the settings page generates its controls from them. A new theme also needs a thumbnail in `prototype/thumbs/`, an entry in `prototype/thumbs-data.js`, and its files added to `$themeFiles` in `tools/build-installer.ps1`.

**Theme pages (`flat.html` = Beach, `meadow.html` = Meadow).** Each page is self-contained canvas code with its own `P` / `DEFAULTS` / `SLIDERS` near the top. Those defaults must match the `default` values in `themes.json`. A page runs in one of three modes, chosen by query string:
- `?wallpaper=1`: driven by the host over `window.chrome.webview` messages.
- `?preview=1`: embedded as an iframe in `settings.html` and driven by `postMessage`. It draws semi-transparent "ghost" icons.
- no query: standalone, with sample icons, for development.

In the two hosted modes the page sends `ready`, then receives these messages: `settings` (partial parameter update, unknown keys ignored), `reset`, `icons` (icon rectangles in physical pixels, which the page divides by `devicePixelRatio`), and `pause`. A pause freezes animation, but the first terrain build and icon layout must still complete. Character sprites live in helper scripts (`beach-palms.js`, `meadow-boy.js`, `meadow-cat.js`) with images in `prototype/assets/`.

**Galaxy theme (`galaxy.html`, `galaxy-core.js`, `galaxy-scene-*.js`).** This theme uses a different structure from Beach and Meadow. It is one theme with six scenes, chosen by the `faction` (Empire/Rebellion) and `era` (Original/Prequel/Sequel) params. Each scene file calls `Galaxy.register(id, {init, resize, layout, update, render, dispose, post})`.
- **What the engine does:** `galaxy-core.js` owns the `share.js` contract, the host messages and an icon field. The field texture holds sharp distance in R and blobby distance in G, and GLSL reads it through `iconDist()` / `iconBlob()`. The engine also owns an HDR target with bloom and ACES post-processing, an instanced sprite atlas, additive glows, the `Flock` and `Bolts` helpers, and the hyperspace transition between scenes.
- **Reference scene:** `galaxy-scene-example.js` is a minimal reference scene. The page does not load it.
- **Defaults:** Galaxy defaults to Ultra quality at 60 fps, because the owner asked for maximum visual quality. This overrides the general 30 fps target.
- **Sprite colors:** The sprite shader decodes the atlas from sRGB, so Canvas 2D colors appear as authored.
- **Textures:** `ctx.loadTexture(url, {srgb, repeat})` loads CC0 photo textures from `prototype/assets/galaxy/<scene-id>/`. Each folder has a `SOURCES.md` with credits, and the installer packages the whole `assets/galaxy` tree automatically. Only CC0 or public-domain sources are allowed.
- **GPU budget:** The owner wants no increase in GPU use. `?perf=200` (run headless at 3840x2160 with `--timeout=16000` and no virtual time) prints `[perf] steady` and `[perf] morph` frame times. Headless Edge on this machine runs on the real GPU. At the November 2026 polish, every scene measured between 2.1 and 4.9 ms steady and between 2.5 and 6.7 ms during icon morphs. Any change should stay at or below those numbers.
- **Visual check:** Render a scene headlessly with `msedge --headless=new --screenshot=out.png --window-size=1920,1080 "http://localhost:5178/galaxy.html?scene=st-rebel&advance=6&nopanel"`. These query params are for testing:
  - `advance=N` simulates N seconds before the shot.
  - `noghosts` hides the white sample icons.
  - `layout=sparse|none` changes the sample desktop.
  - `testhyper=<id>&hypert=0.5` captures the hyperspace transition.

**Sharing (`share.js`).** Image and animation exports re-render the theme with sample icons and color-block names. They never capture the real desktop. The result goes back to the host as a `snapshot|...` message.

**UI text (`prototype/i18n/en.json`).** The UI is English only. `en.json` has a `ui` section, which `t(key)` in `settings.html` reads, and a `host` section, which `I18n.T(key)` in the host reads for tray and dialog text. Theme names, descriptions and parameter labels are not in `en.json`. They live directly in `themes.json`.

**Thumbnails.** `prototype/thumbs-data.js` defines `window.DESKLAND_THUMBS` with every thumbnail inlined as a WebP data URI. The settings page prefers it over the `url(thumbs/...?v=hash)` in `themes.json`. No generator script for it exists in the repo, so a changed thumbnail needs both files updated by hand.

**Installer (`tools/build-installer.ps1`, `tools/installer.nsi`).** The script stages an explicit allow-list of `prototype/` files (the `$themeFiles` array). A new file under `prototype/` must be added there or it will be missing from the installed app. The version string in `tools/version.json` feeds both the assembly version and the installer name.
