# Genmitsu Cubiko: real machine profile

Measured on 2026-11-14 with `staffy-cnc/tools/cubiko-check.html` on the user's own Cubiko.
The raw report is in [`cubiko-report-2026-11-14.json`](cubiko-report-2026-11-14.json).

## Identity

| What | Measured | What we assumed |
|---|---|---|
| USB chip | CH340, vendor `0x1A86`, product `0x7523` | CH340 ✓ |
| Baud | 115200 | 115200 ✓ |
| Firmware | `Grbl 1.1f`, controller "1010 cnc controller", `Version:V43.1`, build `V43.1.20250416` | GRBL 1.1h, V45.2 ✗ |
| Build options | `[OPT:VMZ0L,35,254]`: variable spindle, mist, homing sets origin, spindle off at S0, homing lock at power-up | — |
| Axes | **4** (X, Y, Z, A). Every position has 4 numbers. | 3 ✗ |
| Planner | 35 blocks | — |
| Serial buffer | **254 bytes free** when idle (`Bf:35,254`) | 127 ✗ |

The firmware name in `$I` is followed by bytes that aren't valid text, probably Chinese in another encoding. The reader must not choke on them.

## Settings that matter to Staffy

| Setting | Value | Meaning |
|---|---|---|
| `$10` | 3 | Status shows machine position **and** buffer. Nothing to change. |
| `$5` / `$6` | 1 / 1 | Limit and probe pins are inverted (normal for this board). |
| `$20` | 0 | Soft limits **off**. Staffy must check job size itself. |
| `$21` | 1 | Hard limits on. |
| `$22` / `$23` | 1 / 3 | Homing on. X and Y home toward their minimum, Z homes up. |
| `$24` / `$25` / `$27` | 50 / 200 / 1 | Homing slow / fast speed (mm/min), pull-off 1 mm. |
| `$30` / `$31` | 10000 / 0 | Spindle and laser power range is S0–S10000. |
| `$32` | 0 | Laser mode off. Staffy sets it when the laser is chosen and puts it back after. |
| `$43`–`$46` | 148, 109, 2, 1 | **Not standard GRBL.** SainSmart probe-position settings tied to the home corner. Read, never change. |
| `$100`–`$102` | 800 | Steps per mm ✓ |
| `$103`, `$113`, `$123`, `$133` | A-axis settings | A rotary axis is supported by the firmware. Ignore for now. |
| `$110`–`$112` | 2000 | Max speed, all axes, mm/min |
| `$120`–`$122` | 50 | Acceleration, mm/s² (gentle) |
| `$130`–`$132` | 152 / 113 / 39 | **Real travel in mm.** The docs said 150 × 110 × 40. |

After homing, the machine position is `0,0,0` ("homing sets origin"). So the work area is X 0 to 152, Y 0 to 113, and Z 0 down to −39.

## Behaviour that breaks normal GRBL senders

These must be handled in M1. Most senders that "lose connection" on this machine are probably tripping over them.

1. **No welcome message on connect.** Opening the port doesn't reset the board. Staffy must ask with `?` first, and **must not** send a reset just to say hello: the machine could be mid-job from its offline controller.
2. **The board reboots itself when a limit switch is pressed**, and again when it's released. It doesn't send the usual `ALARM:1`. Instead it sends the welcome lines, `[MSG:Check Limits]`, and sometimes `[MSG:'$H'|'$X' to unlock]`.
   → A welcome line arriving mid-session means **"the machine reset, the job is gone"**. Stop streaming, explain in plain words, and offer to home.
3. **Every reset dumps all settings** (`$0=…` to `$133=…`) without being asked. Only treat `$n=` lines as a settings reply when Staffy asked for them.
4. **Unrequested `ok` replies.** While a limit is pressed, the board sends `[MSG:Check Limits]` followed by an `ok` that answers nothing. A buffer-counting streamer that trusts every `ok` would get out of step and could overflow the buffer. Count an `ok` only while a line is waiting for one, and reset all counters after any reboot.
5. **Settings lines carry comments**, e.g. `$0=10 (step pulse,usec)`. Parse up to the first space.
6. **Start-up state varies.** Sometimes it starts in Alarm (homing lock), sometimes Idle. The Cut walkthrough must handle both without alarming the user.
7. **Status reports** follow GRBL 1.1: `WCO:` and `Ov:` appear only every few reports, and `Pn:` only while a pin is active.

## Switches

| Switch | Result |
|---|---|
| X limit | Works (`Pn:X`) |
| Y limit | Works (`Pn:Y`, seen during homing) |
| Z limit | Works (`Pn:Z`, seen during homing) |
| Probe | **Never seen.** Either it wasn't touched, wasn't plugged in, or the wiring or `$6` is wrong. Needs a retest. |

## Homing

Homing ran about 25 s: Z first, then X and Y together, each with a fast seek, a slow re-touch and a 1 mm pull-off. It finished `Idle` at `0,0,0`.

The page didn't send `$H`, so it was started from the machine itself (offline controller or button). That still proves homing works. **Confirmed by eye: it homes to the front-left corner, bit raised.** So machine X+ is right, Y+ is towards the back, Z+ is up.

## Still to find out

- Whether the probe works (retest: touch the clip to the plate in step 4).
- How `$32` laser mode and the laser module behave (M3 test).
- Whether `G38.2` probing and `G10 L20` behave normally (M1 test, with the probe).
