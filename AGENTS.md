# Deskland Preview development guide

- This repository contains the host, the shared settings UI, and the themes. Every theme in `themes.json` is free and fully implemented. There are no locked or paid themes, no purchase prompts and no update prompts.
- The UI is English only. UI text lives in `prototype/i18n/en.json` (`ui` for the settings page, `host` for the tray menu and dialogs). Theme names and parameter labels live directly in `prototype/themes.json`.
- There is no account sign-in, purchase restoration or automatic update check. Do not connect to licensing services, a website update manifest or store update APIs.
- Keep `themes.json` and the parameter defaults in each theme page consistent. Every theme entry needs `status: "ready"`, a `page`, and a thumbnail.
- After changing a theme, check icon movement, preview, pause and sharing. Every canvas draws at actual device pixels and at fractional display sizes.
- The wallpaper stays resident in the background and targets 30fps on integrated graphics. Cache static drawing, use local layers for small objects, and do not compute large numbers of objects one by one in a full-screen shader.
- `prototype/thumbs/` holds hand-designed thumbnails. Do not regenerate or overwrite them unless asked.
- Host build: `powershell -ExecutionPolicy Bypass -File host\build.ps1`; output is `host/bin/Deskland.exe`.
- Browser preview: `node prototype\serve.mjs`, then open `http://localhost:5178/settings.html`.
- Windows host: `host/DesktopHost.cs`. Changing theme HTML/JS does not require rebuilding the host; use the tray "Reload" command.
- The product display name is `Deskland Preview`. The program reads and writes `%LOCALAPPDATA%\DesklandPreview` and installs to `Programs\Deskland Preview`. Its startup entry and running-instance identity are also separate from the development build. Do not change them back to a shared identity.
- Do not commit `host/bin/`, `host/lib/`, personal data, credentials or local machine paths.
- See `TRADEMARKS.md` for notes on the name and icon.
