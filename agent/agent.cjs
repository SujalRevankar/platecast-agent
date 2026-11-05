#!/usr/bin/env node
/**
 * PlateCast print agent — one computer, many printers.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The browser print station (/print-station) can only ever reach ONE printer:
 * a web page cannot choose a destination, so window.print() lands on whatever
 * that browser profile's default printer is. Most cafés have one PC with a
 * kitchen printer AND a billing printer, which the browser simply cannot serve.
 *
 * This agent does. It pulls the SAME job queue, and each job carries the printer
 * it belongs to, so it can send one ticket to the kitchen and the next to the
 * counter from a single machine.
 *
 * ── Why it holds no printing logic ──────────────────────────────────────────
 * The server hands us ready-made ESC/POS bytes (`job.escpos`). The receipt
 * layout and the encoder live in the app, in one place. That is deliberate: this
 * binary ends up installed on counter PCs we cannot reach, so the less it knows,
 * the less it ever needs updating. Changing how a bill looks is a deploy, not a
 * rollout.
 *
 * ── Why CommonJS and not ESM ────────────────────────────────────────────────
 * Node's single-executable (SEA) packaging runs the entry script through the
 * CJS loader ONLY — an ESM entry builds a blob fine and then dies at runtime on
 * "await is only valid in ... modules". Shipping one .exe is worth more than the
 * import syntax, so this file is CJS. Still zero dependencies.
 *
 *   node agent.cjs                        run (pairs interactively on first use)
 *   node agent.cjs install <url> <code>   pair + start at login (what the installer runs)
 *   node agent.cjs pair <url> <code>      pair without prompting
 *   node agent.cjs printers               list the printers this PC can see
 *   node agent.cjs once                   one poll+print pass, then exit
 *   node agent.cjs status                 show what this agent is paired to
 *   node agent.cjs uninstall              stop starting at login
 */
const { createConnection } = require("node:net");
const { spawn } = require("node:child_process");
const { readFile, writeFile, unlink } = require("node:fs/promises");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");
const { createInterface } = require("node:readline/promises");

/**
 * Where to keep agent.json.
 *
 * Inside a SEA binary `__dirname` is the directory of the .exe, which is what we
 * want (config lives beside the program in %LOCALAPPDATA%\PlateCast). Resolving
 * it from execPath explicitly avoids depending on that being true forever.
 */
let IS_SEA = false;
try {
  IS_SEA = require("node:sea").isSea();
} catch {
  /* older Node, or running from source */
}
const HERE = IS_SEA ? dirname(process.execPath) : __dirname;
const CONFIG = join(HERE, "agent.json");

const TASK_NAME = "PlateCast Print Agent";
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 10_000;
const IDLE_AFTER_MS = 60_000;
/** A printer that accepts nothing for this long is wedged, not slow. */
const PRINT_TIMEOUT_MS = 15_000;
/** How often to re-tell the server which printers this PC has. */
const HELLO_EVERY_MS = 15 * 60_000;
const DEFAULT_RAW_PORT = 9100;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const isWindows = process.platform === "win32";

/**
 * Everything this program prints stays ASCII.
 *
 * A Windows console runs on a legacy code page (437/1252 in most of the world),
 * so UTF-8 output is decoded byte-by-byte: "✓ Paired" arrives as "âœ" Paired"
 * and "ready — ..." as "ready â€"". That window is the ONLY status display a
 * restaurant has, so garbled text there reads as broken software to exactly the
 * person least able to judge otherwise. `chcp 65001` would fix the common path
 * and still leave raw consoles, redirected logs and older builds mangled;
 * plain ASCII is correct everywhere with nothing to configure.
 */
const OK = "[ok]";
const BAD = "[!!]";

// ── config ──────────────────────────────────────────────────────────────────

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG, "utf8"));
  } catch {
    return null;
  }
}

async function writeConfig(cfg) {
  await writeFile(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

// ── running other programs ──────────────────────────────────────────────────

/** spawn → promise, capturing output. `env` is how we pass untrusted strings. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      windowsHide: true,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(stderr.trim() || stdout.trim() || `${cmd} exited ${code}`))
    );
  });
}

function powershell(script, env) {
  return run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { env }
  );
}

// ── pairing ─────────────────────────────────────────────────────────────────

async function pair(baseUrl, code) {
  const url = String(baseUrl).replace(/\/+$/, "");
  const res = await fetch(`${url}/api/print/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: String(code).trim().toUpperCase(),
      // Tells the server to send ESC/POS bytes rather than a document to render.
      kind: "agent",
      platform: `${process.platform} ${process.arch} node ${process.versions.node}`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error ?? `Pairing failed (${res.status})`);
  }
  const cfg = {
    baseUrl: url,
    token: json.token,
    deviceName: json.device_name,
    restaurant: json.restaurant_name,
  };
  await writeConfig(cfg);
  // Tell the server what this PC can print to, so Settings can offer a list
  // instead of asking the owner to type a printer name correctly.
  await sayHello(cfg).catch(() => {});
  return cfg;
}

async function pairInteractively() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\n  PlateCast print agent - first-time setup\n");
    console.log("  In PlateCast: Settings > Printers > Add a print station.");
    console.log("  It shows a 6-character code. Type it below.\n");
    const baseUrl =
      (await rl.question("  Your PlateCast address [https://getplatecast.com]: ")).trim() ||
      "https://getplatecast.com";
    const code = (await rl.question("  Pairing code: ")).trim();
    const cfg = await pair(baseUrl, code);
    console.log(`\n  ${OK} Paired as "${cfg.deviceName}" (${cfg.restaurant}).\n`);
    return cfg;
  } finally {
    rl.close();
  }
}

// ── which printers does this computer have? ─────────────────────────────────

/**
 * The names Windows/CUPS knows a printer by — exactly the strings the raw-print
 * call below accepts. Reporting these to the server turns the most error-prone
 * field in setup (typing a share name) into a dropdown.
 */
async function listPrinters() {
  try {
    if (isWindows) {
      // Get-Printer is Win8+; Win32_Printer covers everything older and is also
      // what shows up when the print spooler is remote.
      const out = await powershell(
        "$ErrorActionPreference='SilentlyContinue';" +
          "$n=@(Get-Printer|Select-Object -ExpandProperty Name);" +
          "if(-not $n){$n=@(Get-CimInstance Win32_Printer|Select-Object -ExpandProperty Name)};" +
          "$n|ForEach-Object{$_}"
      );
      return cleanNames(out.split(/\r?\n/));
    }
    // lpstat -a lists accepting queues: "Kitchen accepting requests since ..."
    const out = await run("lpstat", ["-a"]);
    return cleanNames(out.split(/\r?\n/).map((l) => l.split(/\s+/)[0]));
  } catch {
    // No spooler, no permission, no lpstat — not fatal, just means no list.
    return [];
  }
}

function cleanNames(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const name = String(raw ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name.slice(0, 120));
    if (out.length >= 40) break;
  }
  return out;
}

/** Report this station's printers (and that it's alive) to PlateCast. */
async function sayHello(cfg) {
  const printers = await listPrinters();
  await fetch(`${cfg.baseUrl}/api/print/hello`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ printers, platform: process.platform }),
  });
  return printers;
}

// ── the two ways to reach a printer ─────────────────────────────────────────

/**
 * Straight to a network printer: raw ESC/POS over TCP, usually port 9100.
 *
 * No driver, no spooler, no OS involvement — which is why this is the path worth
 * recommending. It also means the agent does not have to run on the PC the
 * printer is plugged into; anything on the same network will do.
 */
function printToNetwork(address, bytes) {
  const [host, portRaw] = String(address).split(":");
  const port = Number(portRaw) || DEFAULT_RAW_PORT;
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(PRINT_TIMEOUT_MS, () => done(new Error(`${host}:${port} timed out`)));
    socket.on("error", done);
    socket.on("connect", () => {
      socket.write(bytes, (err) => (err ? done(err) : socket.end()));
    });
    // `end` flushes; the printer closing the socket is our acknowledgement.
    socket.on("close", () => done(null));
  });
}

/**
 * Windows raw printing, via the spooler API every real POS app uses.
 *
 * OpenPrinter → StartDocPrinter(RAW) → WritePrinter sends bytes to a printer BY
 * NAME. That is the whole reason one PC can drive several printers here and
 * cannot in the browser.
 *
 * The previous approach — copying bytes to \\localhost\ShareName — worked only
 * if the owner had first gone into Printer properties and SHARED the printer,
 * which was the single most error-prone step in setup. This needs no sharing.
 * Verified against an unshared printer.
 */
const WINSPOOL_PS1 = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public class PcRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr h, IntPtr buf, int count, out int written);

  public static void Send(string printer, string file) {
    byte[] data = File.ReadAllBytes(file);
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("Windows has no printer called \\"" + printer + "\\"");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "PlateCast ticket";
      di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, ref di))
        throw new Exception("The printer refused the job (error " + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h))
          throw new Exception("StartPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        IntPtr buf = Marshal.AllocHGlobal(data.Length);
        try {
          Marshal.Copy(data, 0, buf, data.Length);
          int written;
          if (!WritePrinter(h, buf, data.Length, out written))
            throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
          if (written != data.Length)
            throw new Exception("Only " + written + " of " + data.Length + " bytes reached the printer");
        } finally { Marshal.FreeHGlobal(buf); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
[PcRaw]::Send($env:PC_PRINTER, $env:PC_FILE)`;

/**
 * Through the operating system, to a printer BY NAME.
 *
 * The printer name and file path go via environment variables, never
 * interpolated into the script — a printer called O'Brien's or one with a quote
 * in it would otherwise break the command, or worse.
 */
async function printToSpooler(queue, bytes) {
  if (!queue) throw new Error("No printer name set for this printer");
  const file = join(tmpdir(), `platecast-${randomUUID()}.bin`);
  await writeFile(file, bytes);
  try {
    if (isWindows) {
      await powershell(WINSPOOL_PS1, { PC_PRINTER: queue, PC_FILE: file });
    } else {
      await run("lp", ["-d", queue, "-o", "raw", file]);
    }
  } finally {
    await unlink(file).catch(() => {});
  }
}

/** Where does this job go, and how? */
async function deliver(job) {
  const printer = job.printer ?? {};
  if (!job.escpos) {
    // Only happens if the server could not encode the document. Fail loudly
    // rather than print nothing and report success.
    throw new Error("No printable data for this job");
  }
  const bytes = Buffer.from(job.escpos, "base64");
  const copies = Math.min(Math.max(printer.copies ?? 1, 1), 3);

  for (let i = 0; i < copies; i++) {
    if (printer.connection === "network") {
      await printToNetwork(printer.address, bytes);
    } else {
      // 'usb' and 'os_default' both go through the OS. `address` carries the
      // printer's name when it differs from the label used in PlateCast.
      await printToSpooler(printer.address || printer.name, bytes);
    }
  }
}

// ── the loop ────────────────────────────────────────────────────────────────

async function pollOnce(cfg) {
  const auth = { Authorization: `Bearer ${cfg.token}` };
  const res = await fetch(`${cfg.baseUrl}/api/print/poll`, { headers: auth, cache: "no-store" });
  if (res.status === 401) {
    const err = new Error("This station was removed in Settings. Pair it again.");
    err.fatal = true;
    throw err;
  }
  if (!res.ok) throw new Error(`poll ${res.status}`);
  const { jobs = [] } = await res.json();

  for (const job of jobs) {
    let ok = true;
    let message = "";
    try {
      await deliver(job);
      log(`${OK} printed ${job.payload?.title ?? job.kind} -> ${job.printer?.name ?? "?"}`);
    } catch (err) {
      ok = false;
      message = String(err.message ?? err).slice(0, 300);
      log(`${BAD} ${job.payload?.title ?? job.kind} -> ${job.printer?.name ?? "?"}: ${message}`);
    }
    // Always ack: a job nobody acks sits claimed and prints nowhere. Reporting
    // the failure is what raises "1 ticket didn't print" for the owner.
    await fetch(`${cfg.baseUrl}/api/print/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ job_id: job.id, ok, error: message }),
    }).catch((err) => log("! could not ack:", err.message));
  }
  return jobs.length;
}

async function loop(cfg) {
  log(`ready - "${cfg.deviceName}" - ${cfg.restaurant}`);
  log(`polling ${cfg.baseUrl}`);

  const printers = await sayHello(cfg).catch(() => null);
  if (printers?.length) log(`printers on this PC: ${printers.join(", ")}`);
  let lastHello = Date.now();

  // Say what this window is FOR. Without it the program looks finished — it has
  // printed its last line and is sitting idle — so the natural thing to do is
  // close it, which silently stops all printing until the next login.
  console.log("");
  console.log("  --------------------------------------------------------------");
  console.log("  Leave this window open. Closing it stops printing.");
  console.log("  Minimising is fine. It starts again by itself when you log in.");
  console.log("  --------------------------------------------------------------");
  console.log("");

  let lastJobAt = Date.now();
  let offline = false;

  for (;;) {
    try {
      const n = await pollOnce(cfg);
      if (n) lastJobAt = Date.now();
      if (offline) {
        offline = false;
        log("reconnected");
      }
      // A printer added on this PC after setup should appear in PlateCast
      // without anyone restarting anything.
      if (Date.now() - lastHello > HELLO_EVERY_MS) {
        lastHello = Date.now();
        await sayHello(cfg).catch(() => {});
      }
    } catch (err) {
      if (err.fatal) {
        // Return rather than process.exit(): killing the process mid-flight can
        // abort while a socket is still closing, and a crash dump on a counter
        // PC looks like a broken program rather than an unpaired one.
        log(`! ${err.message}`);
        process.exitCode = 1;
        return;
      }
      if (!offline) {
        offline = true;
        log(`! offline: ${err.message} (will keep retrying)`);
      }
    }
    const idle = Date.now() - lastJobAt > IDLE_AFTER_MS;
    await new Promise((r) => setTimeout(r, idle ? POLL_IDLE_MS : POLL_ACTIVE_MS));
  }
}

// ── start at login ──────────────────────────────────────────────────────────

/**
 * A launcher in the user's Startup folder.
 *
 * NOT a scheduled task, and that is not a style choice: `schtasks /create /sc
 * onlogon` requires elevation, because a logon trigger is a system-wide event.
 * The installer runs as whoever is sitting at the counter PC — normally not an
 * administrator — so a scheduled task would fail with "Access is denied" at the
 * last step of setup. Measured, not assumed: a `/sc once` task creates fine
 * unelevated on the same machine where `/sc onlogon` is refused.
 *
 * The Startup folder needs no privileges, runs at login for exactly the user
 * who set it up, and the owner can see and remove it from Task Manager →
 * Startup apps — which on someone else's computer is a feature.
 *
 * The console window is left VISIBLE on purpose. On a counter PC a small window
 * reading "✓ printed KOT #14 → Kitchen" is the fastest answer to "is printing
 * working?", and hiding it is how a dead agent goes unnoticed for a day.
 */
function startupShortcutPath() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("Cannot find your Windows user folder");
  return join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    `${TASK_NAME}.cmd`
  );
}

async function installAutoStart() {
  if (!isWindows) {
    throw new Error("Automatic start-up is Windows-only for now - see the README.");
  }
  const command = IS_SEA
    ? `"${process.execPath}"`
    : `"${process.execPath}" "${__filename}"`;
  // CRLF: cmd.exe mis-parses LF-only batch files in ways that look like
  // anything except a line-ending problem.
  const script = [
    `@echo off`,
    `title PlateCast Printing`,
    `cd /d "${HERE}"`,
    command,
  ].join("\r\n");
  await writeFile(startupShortcutPath(), script + "\r\n", "utf8");
}

async function uninstallAutoStart() {
  if (!isWindows) return;
  await unlink(startupShortcutPath()).catch(() => {});
}

// ── entry ───────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "pair") {
    const [url, code] = args;
    if (!url || !code) throw new Error("usage: agent pair <url> <code>");
    const cfg = await pair(url, code);
    console.log(`paired as "${cfg.deviceName}" (${cfg.restaurant})`);
    return;
  }

  if (cmd === "install") {
    // What the one-click installer runs: pair, arrange to start at login, then
    // fall through into the normal loop so printing works immediately.
    const [url, code] = args;
    if (!url || !code) throw new Error("usage: agent install <url> <code>");

    /**
     * Re-running the installer on a computer that already has the agent is a
     * normal thing to do — the owner wants a second printer and reaches for the
     * download again, because that is the button they remember.
     *
     * Reusing the stored config blindly was wrong in both directions: with a
     * live token it silently ignored the new code (leaving a station stuck on
     * "Waiting to pair" forever), and with a DEAD one — the station was removed
     * in Settings — it reused the dead token and 401'd on every poll, with a
     * fresh valid code sitting right there unused. So ask the server which it is.
     */
    let cfg = await readConfig();
    if (cfg) {
      const alive = await pollOnce(cfg).then(
        () => true,
        (err) => !err.fatal // only a 401 means this pairing is gone
      );
      if (alive) {
        console.log(`  ${OK} This computer is already set up as "${cfg.deviceName}" (${cfg.restaurant}).`);
        console.log("       One station handles every printer on this PC, so there is");
        console.log("       nothing more to install - just add the printer in PlateCast.");
      } else {
        console.log("  This computer's old connection was removed in PlateCast.");
        console.log("  Reconnecting with the new code...");
        cfg = await pair(url, code);
        console.log(`  ${OK} Reconnected as "${cfg.deviceName}" (${cfg.restaurant})`);
      }
    } else {
      cfg = await pair(url, code);
      console.log(`  ${OK} Paired as "${cfg.deviceName}" (${cfg.restaurant})`);
    }
    try {
      await installAutoStart();
      console.log(`  ${OK} Will start automatically when you log in`);
    } catch (err) {
      // Not fatal — a locked-down PC may refuse schtasks. Printing still works
      // for as long as this window stays open, and saying so beats failing.
      console.log(`  ${BAD} Could not set it to start automatically: ${err.message}`);
    }
    const printers = await listPrinters();
    console.log(
      printers.length
        ? `  ${OK} Printers on this PC: ${printers.join(", ")}`
        : `  ${BAD} No printers found on this PC yet - add one in Windows, then it will appear.`
    );
    console.log("\n  Now finish in PlateCast: Settings > Printers > Add a printer.\n");
    await loop(cfg);
    return;
  }

  if (cmd === "uninstall") {
    await uninstallAutoStart();
    console.log("removed from start-up");
    return;
  }

  if (cmd === "printers") {
    const names = await listPrinters();
    console.log(names.length ? names.join("\n") : "(no printers found)");
    return;
  }

  if (cmd === "status") {
    const cfg = await readConfig();
    console.log(cfg ? { ...cfg, token: "pd_..." } : "not paired");
    return;
  }

  if (cmd === "once") {
    const cfg = await readConfig();
    if (!cfg) throw new Error("not paired");
    const n = await pollOnce(cfg);
    console.log(`handled ${n} job(s)`);
    return;
  }

  const cfg = (await readConfig()) ?? (await pairInteractively());
  await loop(cfg);
}

main().catch((err) => {
  // Whoever runs this by hand is debugging. Give them the reason, not a stack.
  console.error(String(err.message ?? err));
  process.exitCode = 1;
});
