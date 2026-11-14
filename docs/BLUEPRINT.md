# Staffy CNC — Blueprint

> CNC that's easier than 3D printing. Design it, make it, cut it — in one friendly app.
> Licence: **GPL-3.0-or-later**. Always open source, built for the public.
> Made by Warner Media Design. Mascot: a friendly Staffy who walks you through every step.

*Blueprint v2 (2026-11-11). Changes from v1: Rust/egui and SolidCraft dropped in favour of a web app with the OpenCASCADE engine; 2D-first design; PCB through KiCad import; safety and usability testing added; renamed from cnc-wmd.*

---

## 1. The design rules

Every screen must pass these. If a screen breaks one, the screen is wrong.

1. **Nobody ever wonders what to do next.** Every screen has one big, obvious **Next** action, with a plain-English sentence saying what it does.
2. **Easy on top, powerful below.** One set of screens, with **progressive disclosure**: each screen has a "Show details" area for the full controls (feeds and speeds, offsets, G-code, `$$` settings). A "Skip intros" setting saves experienced users time. Safety checks never disappear; they just get shorter.
3. **Pictures before words, words before numbers.** Show the machine, the bit and the stock. Explain in plain language. Show numbers only when someone needs to change them.
4. **Sensible defaults for everything.** Pick a material and a bit and everything else fills in.
5. **The app catches mistakes, not the user.** Too deep, off the bed, bit too big for a slot, job too long: say so *before* cutting, with a one-click fix.
6. **One look, one feel.** Apple-style: calm, generous spacing, large touch-friendly targets, one accent colour per tool, light and dark themes, readable text sizes, works with browser zoom and screen readers.
7. **Nothing irreversible without a clear confirm.** The Stop button is always visible, always in the same place, and honestly labelled.

**The Staffy test.** A milestone is only done when a non-technical person gets from opening the app to a finished part while someone watches without helping. Record two numbers: **time to first cut** and **times stuck** (any pause or "what now?"). Both must be good before moving on.

---

## 2. Decisions

| Topic | Decision |
|---|---|
| Name | **Staffy CNC** (repository `staffy-cnc`). Not named after the company, so the project stands on its own. |
| Licence | **GPL-3.0-or-later** |
| Platforms | **ChromeOS**: web app in Chrome, installable. **Windows**: the same app packaged with **Tauri**. |
| Machine | Genmitsu Cubiko, **measured 2026-11-14**: `Grbl 1.1f`, SainSmart firmware V43.1, 4 axes, **115200 baud**, CH340 USB serial, **152 × 113 × 39 mm** travel, 10 000 RPM spindle (`$30=10000`), 800 steps/mm, **254-byte serial buffer**. It reboots itself when a limit switch is hit and sends stray `ok` replies. Full details in [hardware/CUBIKO-PROFILE.md](hardware/CUBIKO-PROFILE.md). |
| Connections | USB first. Wi-Fi and SD-card/offline controller later. |
| Toolhead order | **Milling → Laser → Pen plotting** |
| Materials | Wood, plywood/MDF, acrylic, PCB (FR-1/FR-4), aluminium (light cuts, with a warning), leather, card and paper |
| Prototype | Start clean, but reuse the good parts of the restored TypeScript prototype |

---

## 3. Technology

**A TypeScript web app, with heavy maths in browser-compiled (WebAssembly) libraries, packaged for Windows with Tauri.**

| Layer | Choice | Why |
|---|---|---|
| Interface | **TypeScript + React + Tailwind** | Best toolkit for polished, accessible, touch-friendly screens. Runs natively on ChromeOS. Biggest pool of contributors. The prototype's screens are a head start. |
| 3D view | **Three.js** | Already used in the prototype. Shows models, toolpaths and the simulated cut. |
| 3D modelling engine | **OpenCASCADE** (the engine inside FreeCAD) via **replicad** (MIT) / opencascade.js (LGPL) | Industry-proven and decades old. Reads and writes STEP/STL. **Loaded only when 3D mode is used**, so the app stays fast on cheap Chromebooks. |
| 2D geometry and toolpaths | **Clipper2** (offsets, pockets) and a small vector library for shapes | Bit-radius offsets and pocket clearing, which the prototype was missing |
| File import | SVG (built in), DXF/DWG (**libdxfrw**, GPL-2+, or a JavaScript DXF reader), images, Gerber/Excellon, STEP/STL, FreeCAD `.FCStd` | `.FCStd` is a zip of OpenCASCADE shapes, so FreeCAD users can open their projects directly |
| Machine connection | **Web Serial** in Chrome; Tauri's Rust side (`serialport`) on Windows | Behind one "machine link" interface, so the rest of the app doesn't care which is used |
| Streaming | Runs in a **Web Worker**, driven by the machine's replies, not timers | Chrome slows timers in background tabs; this keeps a long job from stalling |
| Project files | `.staffy` (a zip of JSON plus assets) with a **format version from day one** | Old projects keep opening in new versions |

**Why not the other options:**
- **SolidCraft:** pre-1.0, a fast-moving engine port, and its interface and brand are licence-restricted. Dropped.
- **FreeCAD itself:** mature, but its interface is built for engineers. We use its engine (OpenCASCADE) and learn from its CAM workbench (LGPL, so porting is allowed).
- **LibreCAD:** 2D drafting with an old-style interface, and its GPLv2 licence may be "v2 only", which can't be combined with GPL-3. We only use its DXF library, libdxfrw, which is GPL-2-or-later.
- **Onshape:** proprietary cloud software. It can't be built in, but it could be an optional **"Import from Onshape"** button later (its API can export STEP; its terms must be checked first).
- **Rust/egui for everything:** an egui interface is hard to make Apple-easy, has weak accessibility on the web, means a large download, and would leave few contributors. Rust stays only in Tauri's small USB part.

---

## 4. The app flow

```
 ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐
 │  START   │ →  │  DESIGN  │ →  │  MAKE    │ →  │  CUT         │
 │ open/new │    │ draw it  │    │ how to   │    │ guided setup │
 │ template │    │ or edit  │    │ cut it   │    │ + run job    │
 └──────────┘    └──────────┘    └──────────┘    └──────────────┘
```

A step bar at the top always shows where you are. The **Next** button is in the same corner on every screen.

- **Start:** big cards for *New design*, *Open a file*, *Start from a template* (keychain, coaster, sign, clamp, PCB…), *Make a PCB* (section 6), and recent projects. Opening a G-code file goes straight to **Cut**.
- **Design:**
  - **Default: "shapes with depth".** Draw or drop shapes, text, images and SVGs, then say how deep each one cuts. Almost every Cubiko job is like this, and beginners understand it straight away.
  - **3D mode (advanced):** OpenCASCADE modelling (box, cylinder, holes, fillets, extrude a sketch) and the place where imported STEP/STL/FreeCAD parts open.
- **Make:** pick the **tool** (mill, laser or pen), the **material** and the **bit or laser**. The app proposes the operations (outline, pocket, drill, engrave, fill, raster) and shows a **3D simulated cut** with time left and warnings. Then either **export** (`.nc`/`.gcode`, `.svg`, `.dxf`, `.stl`, `.step`, `.staffy`) or press **Send to Cubiko**.
- **Cut:** a step-by-step walkthrough with a picture on every step:
  1. **Connect:** find the Cubiko and read its firmware and settings.
  2. **Home:** with automatic help for the known limit-switch alarm.
  3. **Fit the tool:** check the right bit, laser or pen is fitted, and set laser mode if needed.
  4. **Clamp the stock:** show where on the bed, using the M5 hole positions.
  5. **Find zero:** touch probe for bits, focus block for the laser, paper gauge for the pen.
  6. **Check the outline:** trace the job border with Z raised or the laser on low power.
  7. **Safety check:** glasses, dust shoe, enclosure, ventilation.
  8. **Start:** live progress, time left, pause/resume and the always-visible Stop.

  Optional **"dry run in the air"** before step 8. PCB jobs add a height-map levelling step.

---

## 5. What we borrow from other projects

| Project | Licence | What we take | How |
|---|---|---|---|
| **OpenCASCADE** via replicad / opencascade.js | LGPL-2.1 / MIT | 3D modelling, STEP/STL, slicing parts into flat outlines | Direct dependency |
| **FreeCAD** CAM workbench | LGPL-2.1 | Adaptive clearing, pocketing and drilling strategies; `.FCStd` file reading | Port the algorithms |
| **Candle** | GPL-3.0 | GRBL sender behaviour, **height-map probing and auto-levelling** | Port the algorithms |
| **LaserGRBL** | GPL-3.0 | Photo engraving (dithering, line-to-line), image tracing, power/speed test patterns, GRBL settings editor | Port the algorithms |
| **Rayforge** | MIT | Modern laser workflow, layers, material test grids, camera alignment ideas | Port freely |
| **LaserWeb4** | **AGPL-3.0** | Operations model, CAM settings layout | **Ideas only, no code copied** |
| **libdxfrw** (from LibreCAD) | GPL-2.0+ | DXF/DWG reading | Direct dependency (compiled for the browser), or a JavaScript reader |
| **pcb2gcode / FlatCAM** | GPL-3.0 / MIT | Isolation routing, PCB drilling | Port the algorithms |
| CNCjs, gSender, GRBL-Plotter, gcode-preview | various | Serial state machine, setup wizards, pen-lift mapping, path preview | Ideas (GPL ones can be ported) |

---

## 6. PCB: be the best way to *make* a board

Staffy CNC won't try to replace KiCad for *designing* circuit boards. It aims to be the easiest way to **make** one:

1. **Make a PCB card** on Start, with a short guide: design it in KiCad (free), export Gerber and drill files, then drop them here.
2. **Import Gerber and Excellon** → isolation routing, drilling, board outline.
3. **Height-map auto-levelling:** probe a grid on the board and adjust every cut's depth.
4. **Double-sided boards:** a **flip guide** that uses the Cubiko's M5 bed holes as alignment pins.
5. **Laser and pen PCBs:** burn paint or toner resist with the laser, or draw etch-resist with a pen.
6. **Later, maybe:** a simple built-in board designer, reconsidered only after the first public release.

---

## 7. Tools, materials and safety

**Tools, in delivery order:**
- **Milling:** profile (inside, outside, on line), pocket, drill, engrave/V-carve text, surfacing, PCB isolation. Bit library: flat end mills, V-bits, ball nose, PCB engraving bits, drills.
- **Laser:** vector cut, vector engrave, fill/hatch, photo raster, framing, material test grid. Laser mode switched on automatically. Power scaled to `$30` as read from the machine.
- **Plotting:** pen up/down via Z, hatching for fills, path ordering to reduce travel.
- **3D carving (roughing + finishing) is out of scope** until after the first release. This is said clearly in the app when someone imports an STL.

**Material presets:**
- Start from SainSmart's own parameter sheet, with conservative values.
- Every preset is marked **"tested on a real Cubiko"** or **"untested"**. The community can submit presets.
- A **"test cut"** step is offered for any new material and bit combination.
- Aluminium is allowed, but with light cuts and a clear warning.

**Safety, built in:**
- Refuse any job outside the 152 × 113 × 39 mm work area. The Cubiko ships with soft limits off (`$20=0`), so Staffy checks job size itself and never relies on the firmware for it.
- **Dry run in the air** option (Z raised, spindle and laser off).
- **Laser checklist cannot be skipped:** safety glasses, enclosure, ventilation, a fire extinguisher nearby, never leave it unattended. A diode laser this strong can cause permanent eye damage and start fires.
- Warnings for long jobs.
- The Stop button is labelled honestly: "software stop", with a picture of where the machine's power switch is.
- GPL no-warranty notice shown on first run.

---

## 8. Lessons from the old prototype

**Must fix:**
- Laser contours after the first ran with the laser off (`M5` with no new `M3`).
- Laser power assumed S0–1000, but the Cubiko uses `$30=10000`.
- No bit-radius offset; "pockets" weren't cleared.
- The probe step didn't wait for contact and used `G92` instead of `G10 L20`.
- Manual commands during a job broke the streamer's count.
- The buffer size was hard-coded. It must come from the `Bf:` status field, because 32-bit boards often have larger buffers.
- Errors and alarms didn't stop the job. Firmware resets weren't handled. On the Cubiko this matters a lot: it reboots on a limit hit, dumps its settings and sends stray `ok` replies (see the hardware profile).
- `$32` was rewritten to the controller's memory on every tool switch.

**Worth keeping:** the virtual GRBL emulator, the status parser and error-code table, the sample jobs, the React/Three.js viewport, the welcome-screen layout.

---

## 9. Before building: three one-week tests

Each answers a question the whole plan depends on.

1. **Engine test: passed on Windows/Chrome, 2026-11-14** (`engine-test.html`). replicad 1.2.1 runs OpenCASCADE in a Web Worker. The engine is 22.9 MB (7.3 MB gzipped) and starts in about 0.2 s once downloaded. A 60 × 40 × 12 mm test part builds in 0.3 s, slices into correct outlines (outside, pocket and holes) in under 0.1 s per layer, and exports STEP. The main app stays at 78 KB gzipped because the engine loads only for 3D.
   *Still to do:* repeat on a real Chromebook, and on a slow connection (about 3 s at 20 Mbit/s).
2. **Cubiko test: done 2026-11-14.** Results are in [hardware/CUBIKO-PROFILE.md](hardware/CUBIKO-PROFILE.md). It homes to the front-left corner. Still open: a probe retest, and laser `$32` behaviour (moved to M3).
3. **Streaming test:** stream a 30-minute job from Chrome with the tab hidden and the screen dimmed. Check nothing stalls. Test unplugging the USB cable and resuming from a line.

---

## 10. Roadmap

Every milestone ends with the **Staffy test** (section 1) and a short checklist run on the real Cubiko.

| Milestone | What you get | Done when |
|---|---|---|
| **M0 Foundations** | Repo, GPL licence, CI, app shell in Chrome and Tauri, design system (colours, type, buttons, step bar, Staffy mascot), emulator, automated tests | Empty app installs and opens on ChromeOS and Windows |
| **M1 Cut** | Machine link (Web Serial and Tauri), status, streamer in a worker, alarms and errors, settings read/write, jog, home, real probing, guided Cut walkthrough, dry run, resume from line | Any existing G-code file runs safely on the Cubiko. Already better than Candle for beginners. |
| **M2 Design + Make (milling)** | "Shapes with depth" designer, SVG/DXF/image import, profiles, pockets, drilling, text engraving, bit and material library, simulated cut, warnings, export | A beginner designs and cuts a coaster with no other software |
| **M3 Laser** | Vector cut/engrave, fill, photo raster, test grid, framing, laser safety flow | Replaces LaserGRBL for the Cubiko laser |
| **M4 PCB** | Gerber/Excellon import, isolation, drilling, outline, height-map levelling, double-sided flip guide | A KiCad board milled with no other software |
| **M5 3D mode** | OpenCASCADE modelling, STEP/STL/FreeCAD import, slicing into 2.5D cuts | Import a STEP part and cut it |
| **M6 Plotting** | Pen workflow, hatching, path optimisation | Plot a drawing with the pen kit |
| **M7 First public release** | Installable web app, signed Windows installer, translations, more machine profiles, Wi-Fi/SD, optional Onshape import | Public release |

---

## 11. Smaller risks and their fixes

| Risk | Fix |
|---|---|
| **Scope:** this could take years | Every milestone is usable on its own. The PCB designer and 3D carving are out until after release. |
| **Unsigned Windows app** shows a scary SmartScreen warning | Make the web app the main version. Budget for a code-signing certificate before release. |
| **School or work Chromebooks** may block Web Serial by policy | Detect it and explain in plain words what to ask the IT admin. |
| **US view of the breed:** Staffies get lumped with "pit bulls" there | A cute, friendly mascot design. |
| **OpenCASCADE download size** | Only load it in 3D mode; 2D design never needs it. |
| **Wrong presets break bits** | Conservative values, "tested" labels, test cuts. |
| **Licence mixing** | Only GPL-3-compatible code (MIT, Apache, LGPL, GPL-2+, GPL-3). No GPL-2-only code. AGPL projects for ideas only. Keep a `THIRD_PARTY.md`. |

---

## 12. Next steps

1. ~~Engine test~~ and ~~Cubiko test~~: done. Streaming test (hidden tab, USB unplug) to run in M1 on the real machine.
2. Create the public GitHub repository `staffy-cnc` (GPL-3.0). Check domain name availability.
3. **M0 in progress (2026-11-14).** Done: app shell, design system and Staffy mascot, GRBL parser, streamer and session built for the real Cubiko's quirks, a pretend Cubiko, 14 automated tests, CI workflow, installable web-app manifest, GPL licence. Still to do for M0: the Tauri Windows package (needs Rust installed), and checking that it opens on ChromeOS.
