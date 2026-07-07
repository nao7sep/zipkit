# Build resources

electron-builder reads packaging resources from this directory (`buildResources`
in `electron-builder.yml`). Drop the app icons here before running `build:mac` /
`build:win`:

- `icon.icns` — macOS (1024×1024 source recommended)
- `icon.ico` — Windows (include 256×256)

Without them the build falls back to the default Electron icon (with a warning).
A single 1024×1024 `icon.png` here also works — electron-builder derives the
platform formats from it.
