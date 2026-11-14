# Staffy CNC

**Design it, make it, cut it.** Friendly, free CNC software for hobby machines, starting with the Genmitsu Cubiko.

Staffy CNC puts the whole journey in one app: **Start → Design → Make → Cut**. Every screen has one obvious next step, so you never have to wonder what to do next. Experienced users can open "Show details" for the full controls.

> Status: **M0 Foundations.** The app shell, design system, machine connection, and a pretend Cubiko are in place. Cutting files comes in M1. See [docs/BLUEPRINT.md](docs/BLUEPRINT.md) for the plan.

## Run it

You need Node.js 22 or newer and Google Chrome or Microsoft Edge (for USB).

```bash
npm install
npm run dev
```

Open http://localhost:3100. No machine? Choose **Cut → Practise with a pretend machine**.

| Command | What it does |
|---|---|
| `npm run dev` | Start the app at http://localhost:3100 |
| `npm test` | Run the automated tests |
| `npm run typecheck` | Check the TypeScript |
| `npm run build` | Build for release into `dist/` |
| `npm run app` | Run the Windows app (needs [Rust](https://rustup.rs) and the Microsoft C++ build tools) |
| `npm run app:build` | Build the Windows app and its installer into `src-tauri/target/release/` |

Extra pages:
- `http://localhost:3100/engine-test.html` loads the 3D engine (OpenCASCADE) and slices a test part.
- `tools/cubiko-check.html` reads a real machine's settings into a report.

## How it's built

- **TypeScript + React + Tailwind**, running in the browser (installable on ChromeOS) and, later, packaged for Windows with Tauri.
- **OpenCASCADE** (via [replicad](https://replicad.xyz)) for 3D, loaded only when you use 3D.
- **Web Serial** to talk to the machine. GRBL code lives in `src/grbl/`:
  - `parse.ts` reads what the machine says.
  - `streamer.ts` sends jobs without overflowing the machine's buffer.
  - `session.ts` handles one connection, including the Cubiko's habit of rebooting when a limit switch is hit.
  - `cubikoEmulator.ts` is a pretend Cubiko that copies the real one's quirks, so it can be tested without hardware.
- Real machine measurements: [docs/hardware/CUBIKO-PROFILE.md](docs/hardware/CUBIKO-PROFILE.md).

## Licence

Staffy CNC is free software under the **GNU General Public License v3.0 or later**. See [LICENSE](LICENSE).
Third-party parts keep their own licences (replicad: MIT; OpenCASCADE / replicad-opencascadejs: LGPL-2.1).

Made by Warner Media Design.
