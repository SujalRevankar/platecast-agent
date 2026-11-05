# PlateCast print agent

One computer, as many printers as you like — a kitchen printer and a billing
printer on the same PC, each getting its own tickets.

The browser print station (`/print-station`) cannot do this. A web page is not
allowed to choose a printer, so it always prints to whatever that browser's
default printer is. This agent talks to printers directly, by name, so one
machine can serve all of them.

Use the browser station if you have **one** printer and want zero setup.
Use this agent if you have **two or more**, or if your printers are on the network.

---

## For a restaurant: installing it

1. In PlateCast: **Settings → Printers → Add a print station**. Name it (e.g.
   "counter PC") and tap **Get a pairing code**.
2. Tap **Download the setup file** and open it on that computer.
3. Windows will say it doesn't recognise the file — **More info → Run anyway**.
   (It is unsigned; see *Code signing* below.)
4. Back in PlateCast: **Settings → Printers → Add a printer**, once per printer.
   Choose what it prints and **pick it from the dropdown**.

That's the whole thing. Nothing to type, no Node.js to install, no printers to
share. It starts again by itself every time that computer is logged into.

## What the setup file does

Downloads `platecast-agent.exe` into `%LOCALAPPDATA%\PlateCast`, connects it to
the restaurant's account using the code baked into the file, adds a launcher to
the Startup folder, reports the computer's printers to PlateCast, and starts
printing. It leaves a small window open showing each ticket as it prints —
that window *is* the status display, so it's meant to stay.

## Connecting printers

| Connection | What to choose |
|---|---|
| **Network printer** | *Straight to the network printer* and its IP, e.g. `192.168.1.50:9100`. No drivers at all, and the agent doesn't have to be on the same PC. |
| **USB printer** | *This computer's default printer* and pick the printer from the dropdown. Nothing else — no sharing, no setup in Control Panel. |

The dropdown is filled in by the agent, which reports what Windows can see. If
it's empty the agent hasn't connected yet; it refreshes on start and every 15
minutes, so a printer plugged in later shows up on its own.

## If something doesn't print

- The agent's window prints a line per ticket with the printer name and the
  reason when it fails. That is the first place to look.
- PlateCast shows "N tickets didn't print" on the Orders board and in
  Settings → Printers once a ticket has used up its retries.
- Network: check the IP on the printer's own self-test page, and that this
  computer can reach it (`ping 192.168.1.50`).
- USB: check the printer still appears in the PlateCast dropdown, and that a
  Windows test page prints.
- "This station was removed in Settings" means the device was deleted in
  PlateCast. Download a fresh setup file.

---

## For us: building it

```bash
node build.mjs --run     # build the .exe and smoke-test it
```

Produces `dist/platecast-agent.exe` (~87 MB), then publish it:

1. Upload to a **GitHub Release** — free, and made for files this size.
2. Set `AGENT_DOWNLOAD_URL` in the app's env to that asset's URL.

The installer route (`/api/print/agent/install`) fetches from there, so shipping
a new agent build is an upload, not a visit to every restaurant.

### Code signing

The build is unsigned, so Windows SmartScreen shows *"Windows protected your
PC"* on first run. Removing that needs a code-signing certificate
(~$200–400/yr); the `signtool` call slots into the end of `build.mjs`, and
nothing else about the build changes. An OV certificate earns SmartScreen
reputation over time, an EV one is trusted immediately.

### Commands

```
platecast-agent                        run (asks for a code the first time)
platecast-agent install <url> <code>   pair + start at login + run
platecast-agent pair <url> <code>      pair only
platecast-agent printers               list this PC's printers
platecast-agent once                   one print pass, then exit
platecast-agent status                 what it's paired to
platecast-agent uninstall              stop starting at login
```

Running from source works identically: `node agent.cjs <command>`.

### Design notes

- **The agent holds no printing logic.** The server sends finished ESC/POS
  bytes. Receipt layout changes ship with PlateCast; this program does not need
  updating for them — which matters, because it lives on computers we cannot
  reach.
- **CommonJS, not ESM.** Node's single-executable packaging runs the entry
  through the CJS loader only; an ESM entry builds fine and then dies at runtime
  on top-level `await`.
- **Windows printing goes through `winspool.drv`** (OpenPrinter →
  StartDocPrinter RAW → WritePrinter), the same API every real POS app uses. The
  earlier approach copied bytes to `\\localhost\ShareName`, which only worked if
  the owner had first shared the printer — the most error-prone step in setup.
- **Startup folder, not a scheduled task.** `schtasks /sc onlogon` requires
  elevation, and the installer runs as whoever is at the counter PC. Verified:
  on the same unelevated account, `/sc once` succeeds where `/sc onlogon` is
  denied.
- **Thermal printers are code-page devices**: they print English text. Hindi and
  other non-Latin scripts need image-based printing, which is not in this
  version.
- `agent.json` holds a device token. Treat it like a password; deleting the
  station in Settings revokes it immediately.
