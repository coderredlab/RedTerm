# RedTerm

[![CI](https://github.com/coderredlab/RedTerm/actions/workflows/ci.yml/badge.svg)](https://github.com/coderredlab/RedTerm/actions/workflows/ci.yml)
[![Desktop Installers](https://github.com/coderredlab/RedTerm/actions/workflows/desktop-installers.yml/badge.svg)](https://github.com/coderredlab/RedTerm/actions/workflows/desktop-installers.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

RedTerm is an SSH terminal and remote-file workspace built with Tauri, Svelte, and Rust. It uses a custom canvas terminal renderer rather than embedding xterm.js, and keeps separate desktop and mobile shells around the same SSH, terminal, and storage core.

The desktop app combines SSH sessions, local shells, split panes, an SFTP file browser, editable text previews, and media previews in one workspace. The mobile app focuses on SSH access with native credential storage, keyboard handling, voice input, and clipboard integration.

## Download

Desktop installers are published on the [GitHub Releases](https://github.com/coderredlab/RedTerm/releases) page.

| Platform | Packages |
| --- | --- |
| Linux x86-64 | AppImage, Debian package |
| macOS Apple Silicon and Intel | Universal DMG |
| Windows x86-64 | MSI, NSIS installer |

The macOS build is ad-hoc signed but not Apple-notarized. The Windows installers are not code-signed. Gatekeeper or SmartScreen may therefore ask for explicit approval when opening a downloaded build.

Android and iOS sources are included in the repository, but mobile binaries are not distributed through GitHub Releases.

## Terminal

- Password, stored-password, and SSH key authentication
- Known-host verification before a new host key is trusted
- Persistent SSH sessions with sequence-based output replay and terminal snapshots
- Desktop local-shell sessions alongside remote SSH sessions
- Custom ANSI/VT parser and canvas renderer
- Truecolor text, OSC 8 hyperlinks, alternate screen, mouse reporting, bracketed paste, and Kitty keyboard protocol handling
- Inline Kitty, iTerm2, and Sixel image rendering with bounded decode and image-memory limits
- Unicode, IME composition, native keyboard-layout mapping, and mobile virtual-keyboard handling
- Installed monospaced font selection on desktop, with a bundled fallback font stack

## Desktop workspace

- Multiple workspace tabs and split terminal panes
- Saved connection list with edit and delete controls
- Local and SFTP directory browsing
- Editable code, configuration, shell, Markdown, and UTF-8 text files
- Image, PDF, audio, and video previews
- Remote file downloads and clipboard-image uploads over the active SSH connection
- Unsaved-document and active-session checks before closing documents, panes, tabs, or the application
- Dark and light terminal themes with persistent font, size, and layout settings

## Mobile integration

- Android Keystore and iOS Keychain credential storage
- Mobile extra-key row and viewport-aware software-keyboard handling
- Native voice input
- Clipboard text and image handling
- Keep-screen-on support during terminal sessions
- Native Android and iOS bridges for platform-specific behavior

## Credential storage

Saved passwords and private-key references are not protected by an app-data-derived key. RedTerm uses each platform's credential service:

| Platform | Credential backend |
| --- | --- |
| Android | Android Keystore |
| iOS and macOS | Keychain |
| Windows | Windows Credential Manager |
| Linux | Secret Service |

Host keys are checked separately from login credentials. A changed host key must be reviewed and explicitly trusted before a connection proceeds.

## Desktop shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+T` | Open a new connection |
| `Ctrl/Cmd+Shift+C` | Copy the terminal selection |
| `Ctrl/Cmd+Shift+V` | Paste from the clipboard |
| `Ctrl/Cmd+W` | Close the active document or pane |
| `Ctrl/Cmd+Shift+W` | Close the active workspace tab |
| `Ctrl/Cmd+Tab` | Select the next tab |
| `Ctrl/Cmd+Shift+Tab` | Select the previous tab |
| `Ctrl+PageUp/PageDown` | Select the previous or next tab |
| `Ctrl/Cmd+1…9` | Select a tab by number |
| `Ctrl/Cmd+\` | Split the active pane to the right |
| `Ctrl/Cmd+Shift+\` | Split the active pane downward |
| `Ctrl+Alt+Arrow` | Move focus between panes |
| `Ctrl/Cmd+,` | Open settings |

On Linux and Windows, `Ctrl+T`, `Ctrl+W`, and `Ctrl+\` retain their shell meaning while a terminal has focus.

## Build from source

### Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- Stable Rust toolchain
- The [Tauri v2 platform prerequisites](https://v2.tauri.app/start/prerequisites/) for the target operating system
- Android Studio, the Android SDK, and the Rust Android target for Android builds
- Xcode for iOS builds

Install the locked frontend dependencies:

```bash
bun install --frozen-lockfile
```

Run the desktop app with hot reload:

```bash
bun run desktop:dev
```

Build a desktop installer for the current platform:

```bash
bun run desktop:build
```

Run the checks used by continuous integration:

```bash
bun run check
bun test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Build the ARM64 Android app:

```bash
bun run android:build
```

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/lib/terminal/` | ANSI parser, canvas renderer, keyboard encoding, and terminal session UI |
| `src/lib/desktop/` | Desktop connection list, tabs, panes, file workspace, and settings |
| `src/lib/mobile/` | Mobile application shell and mobile input controls |
| `src/lib/tauri/commands.ts` | Typed frontend boundary for Tauri commands and events |
| `src-tauri/src/ssh/` | SSH authentication, PTY handling, and session processing |
| `src-tauri/src/storage/` | Saved connections and credential-service integration |
| `src-tauri/plugins/` | Android and iOS native plugins |
| `src-tauri/gen/` | Generated Android and Apple projects |

## Releases

Pull requests and pushes to `main` run the frontend and Rust checks. A `desktop-vX.Y.Z` tag matching `src-tauri/tauri.desktop.conf.json` builds all desktop packages, verifies the complete installer set, and publishes a GitHub Release.

Release notes describe user-visible behavior and installation constraints. The full installer matrix must complete before a tagged release is published.

## License

RedTerm is licensed under the [Apache License 2.0](LICENSE). Third-party source and font notices are listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
