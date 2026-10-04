# TsakasCuts

A desktop editor for videos. Import clips, add an mp3, split, change volume and speed, add flash or fade transitions, sync cuts to the beat, and export 1080p / 2K / 4K for YouTube (16:9) or TikTok (9:16). Exports use NVIDIA NVENC when available and fall back to the CPU otherwise.

## Install

Download `TsakasCuts-Setup-x.y.z.exe` from [Releases](https://github.com/TsakasOptimizations/TsakasCuts/releases/latest) and run it. Windows may warn that the app is unrecognized because it isn't code-signed. Click **More info → Run anyway**.

## Develop

```bash
npm install
npm start        # run from source
npm test         # export self-check
npm run dist     # build dist/TsakasCuts-Setup-<version>.exe
```

## Release an update

1. Bump `version` in `package.json` (e.g. `1.0.0` → `1.0.1`).
2. `npm run dist`
3. On GitHub: **Releases → Draft a new release**, tag `v1.0.1`, and upload these three files from `dist/`:
   `TsakasCuts-Setup-1.0.1.exe`, `TsakasCuts-Setup-1.0.1.exe.blockmap`, `latest.yml`
4. Publish. **Check for updates** in the app will find it.
