# RedTerm

RedTerm is a cross-platform SSH terminal built with Tauri, Svelte and Rust. It ships as an Android app, includes native iOS project support, and provides an early desktop workspace for Linux, macOS and Windows.

## Features

- Password and SSH key authentication
- Platform-secured saved connections
- Host key verification
- Persistent SSH sessions
- Mobile keyboard, voice input and clipboard image upload
- Custom canvas terminal renderer with Kitty and iTerm2 inline image support
- Separate mobile and desktop application shells
- Native Android and iOS integrations for mobile platform features

## Development

Install dependencies:

```bash
bun install
```

Run frontend checks:

```bash
bun run check
```

Run the desktop app:

```bash
bun run desktop:dev
```

Build the ARM64 Android app:

```bash
bun run android:build
```

## License

RedTerm is licensed under the MIT License. See `LICENSE`.

Third-party source and font notices are listed in `THIRD_PARTY_NOTICES`.
