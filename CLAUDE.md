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
node prototype\serve.mjs         # http://localhost:5178/settings.html, or /flat.html, /meadow.html, /saltflats.html standalone

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

**How to design a new theme (the owner's default strategy).** Every new theme follows the pattern of Beach, Salt Flats and Cells. The owner tried busy, detailed dioramas with many moving sprites, and also a flat minimal style, and rejected both. This pattern is what they approved.
- **One calm baseline surface over the whole screen.** It is made of two materials and the boundary between them. The icon field decides where one material becomes the other. In Beach the icons are sand and the rest is sea. In Salt Flats the icons crack open white salt to show red soil. In Cells each icon group becomes a glassy cell floating in fluid.
- **The boundary is the star.** Most of the life happens there: waves on the shoreline, or a breathing, rippling membrane. The boundary reshapes smoothly when icons move, and nearby icons merge into one shape.
- **Flat colour with fine grain.** Use a restrained palette and soft gradients. Avoid stacked layers of detail, photographic clutter, depth-of-field tricks and busy textures. Keep the area behind icon labels calm.
- **Very few movers.** Use a handful of small drifting things, scaled by the activity setting, not crowds, battles or traffic.
- **No time-of-day or weather adaptation.**
- **Interaction is simple.** Mouse movement does nothing unless the owner asks for it. A double-click triggers one short, satisfying event at that spot that plays out on the surface and leaves it clean.
- **Build it on the shared engine.** A new theme is `<id>.html` plus `<id>-scene.js` on `scene-core.js`: one main full-screen pass plus a few sprites. Aim for about 2 to 3 ms per frame at 3840x2160.

**Scene themes (`scene-core.js` plus one `<id>-scene.js` per page).** Salt Flats (`saltflats.html`, `saltflats-scene.js`) and Cells (`cells.html`, `cells-scene.js`) use a different structure from Beach and Meadow. Each page loads the shared WebGL engine and exactly one scene file, and the engine runs whichever scene registered. Salt Flats began as one of six scenes in an earlier Galaxy theme, and the other five were removed. A scene file calls `Galaxy.register(id, {init, resize, layout, update, render, dispose, post, fire})`.
- **What the engine does:** `scene-core.js` owns the `share.js` contract, the host messages and an icon field. The field texture holds sharp distance in R and blobby distance in G, and GLSL reads it through `iconDist()` / `iconBlob()`. The engine also owns an HDR target with bloom and ACES post-processing, an instanced sprite atlas, additive glows, and the `Flock` and `Bolts` helpers.
- **Defaults:** the theme defaults to Ultra quality at 60 fps, because the owner asked for maximum visual quality. This overrides the general 30 fps target.
- **Sprite colors:** the sprite shader decodes the atlas from sRGB, so Canvas 2D colors appear as authored.
- **Textures:** `ctx.loadTexture(url, {srgb, repeat})` loads CC0 photo textures from `prototype/assets/saltflats/`. The folder has a `SOURCES.md` with credits, and the installer packages the whole `assets/saltflats` folder automatically. Only CC0 or public-domain sources are allowed.
- **No time or weather:** the owner removed the time-of-day and live-weather adaptations. The `Env` block in `scene-core.js` is now a fixed stub, so the scene always shows its designed look at its `defaultHour`.
- **Interaction:** the host forwards the cursor and double-clicks over empty desktop as `{t:"pointer"}` and `{t:"fire"}` messages. It installs its low-level mouse hook only after the page sends `pointer|on`. The scene reads `ctx.pointer` so ships and the walker react to the cursor, and it implements `fire(ctx, x, y)` for the double-click strike. Test with `?pointer=x,y` and `?fireat=x,y&firet=0.5`.
- **GPU budget:** the owner wants no increase in GPU use. `?perf=200` (run headless at 3840x2160 with `--timeout=16000` and no virtual time) prints `[perf] steady` and `[perf] morph` frame times. Headless Edge on this machine runs on the real GPU.
- **Visual check:** render the scene headlessly with `msedge --headless=new --screenshot=out.png --window-size=1920,1080 "http://localhost:5178/saltflats.html?advance=6&nopanel"`. These query params are for testing:
  - `advance=N` simulates N seconds before the shot.
  - `noghosts` hides the white sample icons.
  - `layout=sparse|none` changes the sample desktop.

**Sharing (`share.js`).** Image and animation exports re-render the theme with sample icons and color-block names. They never capture the real desktop. The result goes back to the host as a `snapshot|...` message.

**UI text (`prototype/i18n/en.json`).** The UI is English only. `en.json` has a `ui` section, which `t(key)` in `settings.html` reads, and a `host` section, which `I18n.T(key)` in the host reads for tray and dialog text. Theme names, descriptions and parameter labels are not in `en.json`. They live directly in `themes.json`.

**Thumbnails.** `prototype/thumbs-data.js` defines `window.DESKLAND_THUMBS` with every thumbnail inlined as a WebP data URI. The settings page prefers it over the `url(thumbs/...?v=hash)` in `themes.json`. No generator script for it exists in the repo, so a changed thumbnail needs both files updated by hand.

**Installer (`tools/build-installer.ps1`, `tools/installer.nsi`).** The script stages an explicit allow-list of `prototype/` files (the `$themeFiles` array). A new file under `prototype/` must be added there or it will be missing from the installed app. The version string in `tools/version.json` feeds both the assembly version and the installer name.
