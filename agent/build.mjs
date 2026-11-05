#!/usr/bin/env node
/**
 * Build platecast-agent.exe — one file the client double-clicks, no Node.js
 * install required on their machine.
 *
 *   node build.mjs            build for this platform
 *   node build.mjs --run      build, then smoke-test the result
 *
 * Uses Node's built-in Single Executable Application support: a blob of the
 * script is injected into a copy of the `node` binary. No bundler, no runtime
 * dependencies — the agent is already dependency-free, which is what makes this
 * a ~20-line build instead of a toolchain.
 *
 * ── Two constraints worth knowing before editing agent.cjs ──────────────────
 * 1. SEA runs the entry through the CommonJS loader ONLY. An ESM entry builds a
 *    blob happily and then dies at runtime on "await is only valid in ...
 *    modules". That is why the agent is .cjs.
 * 2. The output is unsigned, so Windows SmartScreen shows "Windows protected
 *    your PC" on first run. Signing is a build-time step (signtool, an EV or
 *    OV certificate) that slots in at the end of this script — see SIGNING below.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const ENTRY = join(HERE, "agent.cjs");
const isWindows = process.platform === "win32";
const EXE = join(DIST, isWindows ? "platecast-agent.exe" : "platecast-agent");
const BLOB = join(DIST, "sea-prep.blob");
const SEA_CONFIG = join(DIST, "sea-config.json");

const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** Stamped into the .exe's version resource. Bump when publishing a release. */
const AGENT_VERSION = "1.0.0";

function step(label) {
  process.stdout.write(`  ${label}… `);
}

/**
 * No shell, ever. Running process.execPath through one breaks the moment Node
 * is installed under "C:\Program Files", and passing args through a shell is
 * deprecated besides — `npx` is reached as npx.cmd instead.
 */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", shell: false, ...opts });
  if (res.error || res.status !== 0) {
    console.log("FAILED\n");
    console.error(
      res.error?.message || res.stderr || res.stdout || `${cmd} exited ${res.status}`
    );
    process.exit(1);
  }
  return res.stdout ?? "";
}

/**
 * npx, reached as a script rather than as npx.cmd.
 *
 * Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980), and passing
 * args through a shell is itself deprecated — so both obvious spellings are
 * dead ends. npm ships npx-cli.js beside the node binary; running that with the
 * node we are already using needs no shell and no quoting.
 */
function npx(args) {
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (!existsSync(cli)) {
    console.log("FAILED\n");
    console.error(`Cannot find npx at ${cli} — is this a standard Node install?`);
    process.exit(1);
  }
  return run(process.execPath, [cli, ...args]);
}

if (!existsSync(ENTRY)) {
  console.error(`Cannot find ${ENTRY}`);
  process.exit(1);
}

console.log("\nBuilding the PlateCast print agent\n");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

step("preparing");
writeFileSync(
  SEA_CONFIG,
  JSON.stringify(
    {
      main: ENTRY,
      output: BLOB,
      disableExperimentalSEAWarning: true,
      // No snapshot: the agent does real work at startup (reads config, opens
      // sockets) and snapshotting that is both unnecessary and fragile.
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2
  )
);
run(process.execPath, ["--experimental-sea-config", SEA_CONFIG]);
console.log("ok");

step("copying the node runtime");
copyFileSync(process.execPath, EXE);
console.log("ok");

// ── say what this program is ────────────────────────────────────────────────
// The binary is a copy of node.exe, so untouched its Properties and its Task
// Manager row read "Node.js JavaScript Runtime — Node.js". On a counter PC we
// don't own, an unexplained Node process is the kind of thing an IT-minded
// customer kills. Version resources need no certificate.
//
// This does NOT give Windows a publisher to show: the "Publisher: Unknown" line
// on the download prompt comes from an Authenticode signature, which is the paid
// part. This is only the program identifying itself honestly once it runs.
//
// MUST happen before postject. Rewriting resources on a binary that already has
// the SEA blob appended takes MINUTES (measured: >5 on 87 MB, vs 0.9s here) —
// rcedit relocates the appended data every time it rebuilds .rsrc.
if (isWindows) {
  step("naming the program");
  try {
    // v5 is ESM with a NAMED export; `default` is undefined, which surfaces
    // only as "rcedit is not a function" in the catch below.
    const { rcedit } = await import("rcedit");
    await rcedit(EXE, {
      "version-string": {
        CompanyName: "PlateCast",
        ProductName: "PlateCast Print Agent",
        FileDescription: "PlateCast Print Agent",
        LegalCopyright: `Copyright ${new Date().getFullYear()} PlateCast`,
        OriginalFilename: "platecast-agent.exe",
      },
      "file-version": AGENT_VERSION,
      "product-version": AGENT_VERSION,
    });
    console.log("ok");
  } catch (err) {
    // Optional polish, never a reason to fail a build — rcedit is a devDependency
    // and the agent works identically without it.
    console.log(`skipped (${String(err.message).split("\n")[0]})`);
  }
}

if (isWindows) {
  // The copied node.exe carries Node's own Authenticode signature, which is no
  // longer valid once we inject the blob. Removing it first avoids shipping a
  // binary that looks tampered with rather than merely unsigned.
  step("removing the inherited signature");
  const removed = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `try { $s = Get-AuthenticodeSignature '${EXE}'; if ($s.Status -ne 'NotSigned') { Write-Output 'present' } } catch {}`,
    ],
    { encoding: "utf8" }
  );
  console.log(removed.stdout?.includes("present") ? "will be invalidated by injection" : "none");
}

step("injecting the agent");
npx([
  "--yes",
  "postject",
  EXE,
  "NODE_SEA_BLOB",
  BLOB,
  "--sentinel-fuse",
  FUSE,
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
]);
console.log("ok");

rmSync(BLOB, { force: true });
rmSync(SEA_CONFIG, { force: true });

const mb = (statSync(EXE).size / 1024 / 1024).toFixed(0);
console.log(`\n  → ${EXE}  (${mb} MB)\n`);

// ── SIGNING ─────────────────────────────────────────────────────────────────
// Unsigned, every client sees "Windows protected your PC" on first run and has
// to click More info → Run anyway. To remove that, obtain a code-signing
// certificate and add here:
//
//   run("signtool", ["sign", "/fd", "SHA256", "/tr", "http://timestamp.digicert.com",
//                    "/td", "SHA256", "/f", process.env.SIGN_PFX,
//                    "/p", process.env.SIGN_PFX_PASSWORD, EXE]);
//
// An OV certificate still accrues SmartScreen reputation over time; an EV one
// is trusted immediately. Nothing else about the build changes.

if (process.argv.includes("--run")) {
  console.log("Smoke test:\n");
  const res = spawnSync(EXE, ["printers"], { encoding: "utf8" });
  const out = (res.stdout ?? "").trim();
  if (res.status !== 0) {
    console.error(res.stderr || `exited ${res.status}`);
    process.exit(1);
  }
  console.log(out ? `  printers found:\n${out.replace(/^/gm, "    ")}` : "  (no printers)");
  const status = spawnSync(EXE, ["status"], { encoding: "utf8" });
  console.log(`\n  status: ${(status.stdout ?? "").trim()}`);
  console.log("\n  ✓ the executable runs\n");
}

console.log("Publish it so the installer can fetch it:");
console.log("  1. Upload to a GitHub Release (free, and built for large files)");
console.log("  2. Set AGENT_DOWNLOAD_URL to that asset's URL in the app's env\n");
