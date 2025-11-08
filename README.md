# electron-audio-loopback
 Example For Electron Audio Loopback 

## Packaging

Install dependencies once (`npm install`), set the required `.env` keys for your transcription providers, and choose one of the packaging flows:

- `npm run package` (electron-builder) — produces an NSIS installer under `dist/`.
- `npm run forge:package` (electron-forge) — runs the Forge packager using `forge.config.cjs`, emitting artifacts under `out/`.

Both commands rebuild native modules automatically, so ensure your machine has the prerequisites (Python ≤ 3.11 and MSVC build tools on Windows).
