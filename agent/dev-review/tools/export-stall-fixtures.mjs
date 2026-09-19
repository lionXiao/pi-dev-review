#!/usr/bin/env node
/**
 * One-off exporter: turn real dev-review runs into sanitized stall-detection fixtures.
 *
 * NOT part of CI and not part of the extension runtime. It reads a local
 * `.ai-dev-review` directory (passed via --source), keeps only the structured
 * review data the detector consumes (per-round verdicts + findings), applies the
 * deterministic substitution map in `stall-fixture-map.json`, and writes one
 * fixture file per scenario plus a residual-scan report.
 *
 * The map is rename-only (pseudonymisation), never redaction: issue ids, F/R
 * labels and generic behaviour text stay verbatim because they carry the linkage
 * signals (cross references, requirement similarity, identifier overlap). Editing
 * the map changes what the fixtures measure — re-run this tool and review the diff.
 *
 * Usage:
 *   node agent/dev-review/tools/export-stall-fixtures.mjs --source <path-to-.ai-dev-review> [--out <dir>] [--dry-run]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP_PATH = join(HERE, "stall-fixture-map.json");
const DEFAULT_OUT = resolve(HERE, "..", "tests", "fixtures", "stall");

/**
 * Scenario -> source run. `key` is the opaque incident label used in the fixture
 * provenance; it intentionally does not name the source project.
 */
const MANIFEST = [
  { scenario: "stalled-family-exit-gate", run: "b2a--1ab4da09", key: "b2a" },
  { scenario: "stalled-family-reminder-errors", run: "b2c--da037be4", key: "b2c" },
  { scenario: "stalled-issue-tri-state", run: "v1-2-b3-guided-input-plan--a3e2f22a", key: "a3e2" },
  { scenario: "churn-alert-timing", run: "v1-2-b3-guided-input-plan--5d67c903", key: "5d67" },
  { scenario: "churn-reminder-hydrate", run: "v1-2-b2c-settings-ia-fix-plan--be1f8982", key: "be1f" },
  { scenario: "churn-cloud-settings", run: "b2b--418c926c", key: "b2b" },
  { scenario: "churn-ax5-fix", run: "b1c--2f9e641b", key: "b1c" },
  { scenario: "churn-permission-pending", run: "v1-1-1-c4-permission-pending-plan--50bf8541", key: "c4p" },
  { scenario: "churn-refactor", run: "v1-2-refactor-plan--76ff1db6", key: "r76" },
  { scenario: "healthy-layout", run: "b1b--de5a715f", key: "b1b" },
  { scenario: "healthy-quick-fix", run: "b1a--db3a0989", key: "b1a" },
  { scenario: "healthy-b3", run: "b3--3535d49a", key: "b3" },
  { scenario: "healthy-refactor", run: "v1-2-refactor-plan--43193e73", key: "r431" },
  { scenario: "healthy-timing", run: "v1-1-1-c-timing-plan--ca55d4e8", key: "ct" },
  { scenario: "healthy-threshold", run: "v1-1-1-c3-threshold-linkage-plan--62317151", key: "c3" },
  { scenario: "healthy-spec-block", run: "b4--07127329", key: "b4" },
  { scenario: "healthy-polish", run: "v1-2-b3d-guided-input-polish-plan--625d17e7", key: "b3d" }
];

function parseArgs(argv) {
  const options = { source: null, out: DEFAULT_OUT, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--source") options.source = argv[++index];
    else if (token === "--out") options.out = argv[++index];
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--help" || token === "-h") {
      console.log("Usage: node export-stall-fixtures.mjs --source <path-to-.ai-dev-review> [--out <dir>] [--dry-run]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!options.source) throw new Error("--source <path-to-.ai-dev-review> is required");
  return options;
}

function loadMap() {
  const map = JSON.parse(readFileSync(MAP_PATH, "utf8"));
  if (map.version !== 1) throw new Error(`Unsupported map version: ${map.version}`);
  const rules = [...map.rules].sort((left, right) => right[0].length - left[0].length);
  const seen = new Map();
  for (const [from, to] of rules) {
    if (seen.has(to) && seen.get(to) !== from) {
      console.warn(`[warn] map target collision: "${to}" <- "${seen.get(to)}" and "${from}"`);
    }
    seen.set(to, from);
  }
  return { rules, forbidden: map.forbiddenResidual, version: map.version };
}

function makeSanitizer({ rules }) {
  return function sanitize(value) {
    if (typeof value !== "string" || !value) return value ?? "";
    let text = value;
    for (const [from, to] of rules) text = text.split(from).join(to);
    return text;
  };
}

function reviewerRounds(runDir) {
  const handoffs = join(runDir, "handoffs");
  if (!existsSync(handoffs)) throw new Error(`No handoffs directory under ${runDir}`);
  return readdirSync(handoffs)
    .filter((name) => /^reviewer-r\d+\.json$/.test(name))
    .sort((left, right) => Number(left.match(/r(\d+)/)[1]) - Number(right.match(/r(\d+)/)[1]));
}

function buildFixture({ scenario, run, key }, sourceRoot, sanitize, mapVersion) {
  const runDir = join(sourceRoot, run);
  const rounds = reviewerRounds(runDir).map((name) => {
    const round = Number(name.match(/r(\d+)/)[1]);
    const report = JSON.parse(readFileSync(join(runDir, "handoffs", name), "utf8"));
    return {
      round,
      decision: typeof report.decision === "string" ? report.decision : null,
      verdicts: (report.previous_issue_verdicts ?? []).map((item) => ({
        id: String(item.id),
        verdict: String(item.verdict)
      })),
      findings: (report.new_findings ?? []).map((item) => ({
        id: String(item.id),
        severity: String(item.severity),
        location: sanitize(item.location),
        requirement: sanitize(item.requirement),
        evidence: sanitize(item.evidence),
        required_fix: sanitize(item.required_fix)
      }))
    };
  });
  return {
    scenario,
    provenance: {
      run: key,
      sourceKind: "sanitized-dev-review-run",
      mapVersion,
      note: "Paths and identifiers renamed by stall-fixture-map.json; requirement/evidence text retained because the detector consumes it. See README.md."
    },
    rounds
  };
}

function scanResiduals(fixture, forbidden) {
  const text = JSON.stringify(fixture);
  const hits = [];
  for (const token of forbidden) {
    if (text.includes(token)) hits.push(token);
  }
  return hits;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceRoot = resolve(options.source);
  if (!existsSync(sourceRoot)) throw new Error(`Source directory not found: ${sourceRoot}`);
  const map = loadMap();
  const sanitize = makeSanitizer(map);

  const outDir = resolve(options.out);
  if (!options.dryRun) mkdirSync(outDir, { recursive: true });

  const violations = [];
  const summary = [];
  for (const entry of MANIFEST) {
    const fixture = buildFixture(entry, sourceRoot, sanitize, map.version);
    const hits = scanResiduals(fixture, map.forbidden);
    if (hits.length) violations.push({ scenario: entry.scenario, hits });
    const findings = fixture.rounds.reduce((count, round) => count + round.findings.length, 0);
    summary.push(`${entry.scenario.padEnd(32)} rounds=${String(fixture.rounds.length).padStart(2)} findings=${String(findings).padStart(2)}${hits.length ? ` RESIDUAL: ${hits.join(",")}` : ""}`);
    if (!options.dryRun) {
      const target = join(outDir, `${entry.scenario}.json`);
      writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
    }
  }

  console.log(summary.join("\n"));
  console.log(`\n${options.dryRun ? "[dry-run] " : ""}${MANIFEST.length} fixture(s) -> ${outDir}`);
  if (violations.length) {
    console.error("\nResidual scan failed: forbidden tokens remain. Extend stall-fixture-map.json and re-run.");
    for (const item of violations) console.error(`  ${item.scenario}: ${item.hits.join(", ")}`);
    process.exit(1);
  }
  const labelsPath = join(outDir, "labels.json");
  if (!options.dryRun && !existsSync(labelsPath)) {
    console.warn("Note: labels.json is missing — every fixture needs a human-reviewed label entry.");
  }
}

main();
