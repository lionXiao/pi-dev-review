import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Contract tests for the frozen stall-detection fixtures. These do NOT exercise the
// detector (it is implemented separately); they guarantee that the fixtures are
// structurally sound, fully labelled and free of source-project identifiers, so the
// detector tests can treat them as ground truth.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures", "stall");
const MAP_PATH = join(HERE, "..", "tools", "stall-fixture-map.json");

const DECISIONS = new Set(["pass", "fix_required", "spec_blocked", null]);
const VERDICTS = new Set(["verified_closed", "still_open", "partially_fixed", "not_verifiable"]);
const CLASSES = new Set(["stalled-family", "churn", "healthy"]);
const SOFT_EXPECT = new Set(["must-fire-by", "allowed", "must-not-fire"]);
const HARD_EXPECT = new Set(["not-before", "must-not-fire", "allowed"]);

function loadFixtures() {
  const names = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json") && name !== "labels.json");
  return names.sort().map((name) => ({
    name,
    fixture: JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"))
  }));
}

const fixtures = loadFixtures();
const labels = JSON.parse(readFileSync(join(FIXTURE_DIR, "labels.json"), "utf8"));
const map = JSON.parse(readFileSync(MAP_PATH, "utf8"));

test("every fixture parses and has the expected shape", () => {
  assert.ok(fixtures.length >= 10, `expected a meaningful fixture set, got ${fixtures.length}`);
  for (const { name, fixture } of fixtures) {
    assert.equal(typeof fixture.scenario, "string", `${name}: scenario`);
    assert.equal(fixture.scenario, name.replace(/\.json$/, ""), `${name}: scenario must match file name`);
    assert.equal(fixture.provenance?.sourceKind, "sanitized-dev-review-run", `${name}: provenance`);
    assert.ok(Array.isArray(fixture.rounds) && fixture.rounds.length > 0, `${name}: rounds`);

    const seenIds = new Set();
    let lastRound = 0;
    for (const round of fixture.rounds) {
      assert.ok(Number.isInteger(round.round) && round.round > lastRound, `${name}: rounds must ascend`);
      lastRound = round.round;
      assert.ok(DECISIONS.has(round.decision), `${name} r${round.round}: decision "${round.decision}"`);
      const verdictIds = new Set();
      for (const verdict of round.verdicts) {
        assert.match(verdict.id, /^R\d+-\d+$/, `${name} r${round.round}: verdict id`);
        assert.ok(!verdictIds.has(verdict.id), `${name} r${round.round}: duplicate verdict ${verdict.id}`);
        verdictIds.add(verdict.id);
        assert.ok(VERDICTS.has(verdict.verdict), `${name} r${round.round}: verdict "${verdict.verdict}"`);
      }
      for (const finding of round.findings) {
        assert.match(finding.id, /^R\d+-\d+$/, `${name} r${round.round}: finding id`);
        assert.ok(!seenIds.has(finding.id), `${name}: duplicate finding id ${finding.id}`);
        seenIds.add(finding.id);
        assert.ok(["critical", "major", "minor"].includes(finding.severity), `${name} ${finding.id}: severity`);
        for (const field of ["location", "requirement", "evidence", "required_fix"]) {
          assert.equal(typeof finding[field], "string", `${name} ${finding.id}: ${field}`);
        }
        assert.ok(finding.requirement.length > 0, `${name} ${finding.id}: empty requirement`);
      }
    }
  }
});

test("fixtures carry no source-project identifiers", () => {
  for (const { name, fixture } of fixtures) {
    const text = JSON.stringify(fixture);
    for (const token of map.forbiddenResidual) {
      assert.ok(!text.includes(token), `${name}: residual token "${token}" — extend stall-fixture-map.json and re-export`);
    }
    assert.ok(!/\/Users\//.test(text), `${name}: absolute path leaked`);
  }
});

test("labels cover every fixture exactly once, with valid classes", () => {
  const scenarioNames = fixtures.map(({ fixture }) => fixture.scenario).sort();
  const labelNames = Object.keys(labels.scenarios).sort();
  assert.deepEqual(labelNames, scenarioNames, "labels.json scenarios must match fixture files");
  assert.equal(typeof labels.signed, "boolean");
  for (const [scenario, label] of Object.entries(labels.scenarios)) {
    assert.ok(CLASSES.has(label.class), `${scenario}: unknown class ${label.class}`);
    assert.ok(Array.isArray(label.expectedFamilies), `${scenario}: expectedFamilies`);
    assert.ok(Array.isArray(label.knownL2Misses), `${scenario}: knownL2Misses`);
    assert.ok(typeof label.evidence === "string" && label.evidence.length > 0, `${scenario}: evidence required`);
    assert.ok(SOFT_EXPECT.has(label.soft?.expect), `${scenario}: soft.expect "${label.soft?.expect}"`);
    assert.ok(HARD_EXPECT.has(label.hard?.expect), `${scenario}: hard.expect "${label.hard?.expect}"`);
    if (label.class === "stalled-family") {
      assert.ok(label.expectedFamilies.length > 0, `${scenario}: stalled-family needs an expected family`);
      assert.equal(label.soft.expect, "must-fire-by", `${scenario}: stalled-family needs a soft deadline`);
      assert.ok(Number.isInteger(label.soft.round), `${scenario}: soft.round`);
    } else {
      assert.equal(label.expectedFamilies.length, 0, `${scenario}: non-stalled scenarios carry no family`);
    }
    if (label.class === "churn") {
      assert.equal(label.soft.expect, "allowed", `${scenario}: churn soft policy`);
      assert.equal(label.hard.expect, "not-before", `${scenario}: churn hard policy`);
      assert.ok(Number.isInteger(label.hard.round), `${scenario}: churn hard.round`);
    }
    if (label.class === "healthy") {
      assert.equal(label.soft.expect, "must-not-fire", `${scenario}: healthy soft policy`);
      assert.equal(label.hard.expect, "must-not-fire", `${scenario}: healthy hard policy`);
    }
  }
});

test("label families reference real findings and known misses stay inside the family", () => {
  const byScenario = new Map(fixtures.map(({ fixture }) => [fixture.scenario, fixture]));
  for (const [scenario, label] of Object.entries(labels.scenarios)) {
    const ids = new Set(byScenario.get(scenario).rounds.flatMap((round) => round.findings.map((f) => f.id)));
    const familyIds = new Set();
    for (const family of label.expectedFamilies) {
      assert.ok(family.length > 1, `${scenario}: a family needs at least two members`);
      for (const id of family) {
        assert.ok(ids.has(id), `${scenario}: family member ${id} is not in the fixture`);
        assert.ok(!familyIds.has(id), `${scenario}: ${id} appears in two families`);
        familyIds.add(id);
      }
    }
    for (const id of label.knownL2Misses) {
      assert.ok(familyIds.has(id), `${scenario}: known miss ${id} must belong to a labelled family`);
    }
  }
});

test("the fixture set covers stalled, churn and healthy classes", () => {
  const classes = new Set(Object.values(labels.scenarios).map((label) => label.class));
  assert.deepEqual([...classes].sort(), ["churn", "healthy", "stalled-family"]);
});
