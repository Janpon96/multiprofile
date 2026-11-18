# MultiProfile Studio — Build Guide

## Development

### Prerequisites
- **Node.js 18+** (LTS recommended)
- **Windows 10/11 x64**
- npm 9+ (comes with Node.js)

### Setup
```bat
cd "e:\Antigravity Project\Tools New\multiprofile"
npm install
```

### Run in Dev Mode
```bat
# Option 1: use run.bat at repo root (if present)
run.bat

# Option 2: manual
npm run build          # compile TypeScript once
npm --workspace=@multiprofile/desktop run start   # launch Electron
```

For live TypeScript recompile while developing:
```bat
npm run dev            # tsc -w in desktop package (watches for changes)
```

---

## Building the .exe

### Portable executable (single-file, no install)
```bat
cd "e:\Antigravity Project\Tools New\multiprofile\apps\desktop"
npm install            # install electron-builder (first time only)
npm run dist:portable
```

Output: `dist-exe\MultiProfileStudio-portable-1.0.0.exe` (at repo root)

### NSIS installer (with installation wizard)
```bat
cd "e:\Antigravity Project\Tools New\multiprofile\apps\desktop"
npm run dist
```

Output: `dist-exe\MultiProfileStudio-setup-1.0.0.exe` (at repo root)

---

## ⚠️ Important Notes

### Disk Space
Chromium (~300 MB) is bundled into the exe as an extraResource.  
Make sure `node_modules/playwright-core/.local-chromium` exists before building:
```bat
cd "e:\Antigravity Project\Tools New\multiprofile"
npm run engine:install:pinned
```

### First-time build time
The first `npm run dist` can take **5–15 minutes** because electron-builder downloads
the Electron binary cache (~100 MB) and processes Chromium.

### Icon
The build uses `public/assets/icon.png`. To regenerate:
```bat
powershell -ExecutionPolicy Bypass -File scripts/create-icon.ps1
```
Replace `public/assets/icon.png` with your own 256×256 PNG for a custom icon.

### Chromium in packaged app
When running from the `.exe`, the app automatically sets `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
to point to the bundled chromium at `resources/chromium/chrome-win/chrome.exe` inside the
app directory. No manual configuration needed.

### Data directory
User data (SQLite DB, profile browser data) is stored in:
```
%LOCALAPPDATA%\MultiProfileStudio\
```
Override with the `MPS_DATA_DIR` environment variable.

---

## Build Troubleshooting

| Problem | Fix |
|---|---|
| `electron-builder: command not found` | Run `npm install` inside `apps/desktop` |
| `Error: icon does not exist` | Run `scripts/create-icon.ps1` |
| `Cannot find module` after build | Run `npm run build` at repo root first |
| Chromium not found in packaged app | Run `npm run engine:install:pinned` at repo root |
| Build fails TypeScript errors | Run `npm run build` at root and fix errors first |
