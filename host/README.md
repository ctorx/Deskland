# Deskland Windows host

The host uses C# / .NET Framework and WebView2 to place the theme pages beneath the Windows desktop icon layer.

## Build and run

```powershell
powershell -ExecutionPolicy Bypass -File host\build.ps1
host\bin\Deskland.exe
```

The build script uses the C# compiler that ships with Windows. On the first run it downloads a pinned version of the WebView2 SDK from NuGet. Dependencies are stored in `host/lib/` and output goes to `host/bin/`. Neither folder is committed.

## Command-line arguments

| Argument | Behavior |
| --- | --- |
| none | Start the wallpaper and open Settings; if already running, open Settings |
| `--autostart` | Start in the background without opening Settings |
| `--settings` | Open Settings |
| `--menu` | Open the tray menu |
| `--exit` | Exit cleanly and restore the system wallpaper |
| `--exit-installed` | Used by the installer: exit only an instance running from the current executable path |

## Behavior and data

- Themes come from `prototype/themes.json`. Only themes with status `ready` are loaded.
- The host checks desktop icon positions every 400ms and notifies the theme page only when they change.
- The wallpaper pauses when the foreground window is maximized or full-screen. Starting the wallpaper does not steal focus. The host's own windows, invisible windows and cloaked windows do not trigger a pause. The tray menu can pause and resume manually. The settings page busts its cache by program version, and thumbnails use inlined images in real `<img>` elements.
- Windows 11 24H2 and later use a layered Progman child window. Earlier versions use WorkerW.
- Only the primary monitor is covered. A system wallpaper slideshow or Windows Spotlight image change can cause a brief flash.
- Settings are saved to `%LOCALAPPDATA%\DesklandPreview\settings.json`, and the log is `host.log` in the same folder.
- The host has no account sign-in, purchase restoration or automatic update check. It does not go online at startup or when Settings opens.
- Sharing uses only icon positions. The theme page draws sample icons and color blocks for names, and does not capture the desktop.
- After changing theme pages, use the tray "Reload" command. After changing host C#, exit and rebuild.

For install testing, set the environment variable `DESKLAND_PROFILE_DIR` to an absolute path. This isolates settings, the WebView2 cache and the single-instance events. In this mode the host skips legacy data migration and does not write the startup entry. A normal launch does not set this variable and keeps using the regular data folder.

## Page messaging

The settings page sends `hello`, `set`, `reset`, `theme`, `autostart` and share-related messages. The host sends the initial settings, icon rectangles and share results.

After a theme page sends `ready`, the host sends the settings and then the icon positions. After that it sends parameter changes, icon changes and the pause state. Settings and theme pages are both loaded from a local virtual host name.
