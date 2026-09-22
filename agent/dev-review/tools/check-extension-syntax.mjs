#!/usr/bin/env node
/**
 * Syntax-check the Pi extension entry point (`index.ts`).
 *
 * `node --check index.ts` cannot be used directly any more: Node 24.21.0
 * regressed on it (type stripping no longer applies to `--check`, with or
 * without --experimental-strip-types; 24.20.0 and 25.x are fine), so the CI step
 * flipped red for reasons unrelated to the code. This follows the documented API
 * instead — strip the types with node:module, then syntax-check the JavaScript
 * the runtime would actually execute.
 *
 * Usage: node tools/check-extension-syntax.mjs <file.ts>
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/check-extension-syntax.mjs <file.ts>");
  process.exit(2);
}

const directory = mkdtempSync(join(tmpdir(), "pi-dev-review-ts-"));
try {
  const stripped = join(directory, "entry.mjs");
  writeFileSync(stripped, stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" }), "utf8");
  execFileSync(process.execPath, ["--check", stripped], { stdio: "inherit" });
  console.log(`syntax ok: ${file}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
