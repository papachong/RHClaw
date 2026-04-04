# RHClaw Desktop

RHClaw Desktop is a Tauri + React desktop client for bootstrapping and managing a local OpenClaw runtime.

## Development

### Requirements

- Node.js 22+
- Rust toolchain
- Tauri CLI prerequisites for your platform

### Local Run

Prepare local environment variables first:

```bash
cp .env.example .env.local
```

The public default points `VITE_API_BASE_URL` to `http://localhost:3000/api/v1`.

```bash
npm install
npm run desktop:dev
```

On Windows:

```bash
npm run desktop:dev:windows
```

### Validation

```bash
npm run typecheck
npm run build
npm run tauri:doctor
npm run tauri:check
```

## Packaging Notes

- Local development works with the example environment file only.
- Release packaging and update distribution are not wired to any private infrastructure in this public repository.
- If you want to build release artifacts, provide explicit environment variables for any mirror, updater, or distribution endpoint that your environment requires.
- Signing is opt-in in the public repo. Provide `TAURI_SIGNING_PRIVATE_KEY` or `TAURI_SIGNING_PRIVATE_KEY_PATH` only when your packaging flow needs updater signatures.
- Release-manifest signing requires explicit `RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY_PATH` and `RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY_PATH`.
- Full-offline packaging expects RHClaw-Channel input explicitly. Use `RHOPENCLAW_CHANNEL_ROOT` for a source checkout, or `RHOPENCLAW_CHANNEL_PACKAGE_PATH` for a prebuilt `.tgz`.

## Structure

1. `src/` contains the React frontend and desktop workflow UI.
2. `src-tauri/` contains native orchestration, updater integration, and OpenClaw bootstrap logic.
3. `scripts/` contains development helpers, packaging helpers, and bootstrap asset generation.
