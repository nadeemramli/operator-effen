// Production supervisors limited to one factory (20261007090000_operator_factory_scope).
// The API server refuses before the domain rules run (factoryDenial) and re-checks the
// resulting state (outOfFactory) the same way the database does on the signed state.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyCommand,
  createDraft,
  isSachet,
  products,
} from "../apps/web/src/lib/draft.ts";
import {
  asFactory,
  effectiveCapabilities,
  factoryDenial,
  outOfFactory,
} from "../apps/web/src/lib/access.ts";
import { commandRules } from "../apps/web/src/lib/capabilities.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sql = read("../supabase/migrations/20261007090000_operator_factory_scope.sql");
const route = read("../apps/web/src/app/api/draft/route.ts");

const member = (role) => ({
  kind: "member",
  role,
  name: role,
  userId: "u-" + role,
  siteId: "site-a",
});
const apply = (s, type, input, role = "production") =>
  applyCommand(s, {
    type,
    role,
    input,
    actor: member(role),
    capabilities: effectiveCapabilities(role),
  });
// The API command path for a member with a factory scope: pre-check, domain rules, re-check.
function save(s, factory, type, input) {
  const denied = factoryDenial(factory, type, input, s.batches);
  if (denied) return { denied };
  const next = apply(s, type, input);
  const outside = outOfFactory(factory, s, next);
  return outside.length ? { denied: outside.join(", ") } : { state: next };
}
const bottleId = (s) => s.batches.find((b) => !isSachet(b.product)).id;
const sachetId = (s) => s.batches.find((b) => isSachet(b.product)).id;

test("the database maps products to the same factories as the app", () => {
  const body = sql.slice(
    sql.indexOf("create function operator_private.product_factory"),
    sql.indexOf("$$;", sql.indexOf("create function operator_private.product_factory")),
  );
  const sachet = [...body.matchAll(/when p_product = '([a-z]+)' then 'sachet'/g)].map((m) => m[1]);
  const bottle = body
    .match(/when p_product in \(([^)]+)\) then 'bottle'/)[1]
    .match(/'([a-z]+)'/g)
    .map((x) => x.slice(1, -1));
  assert.deepEqual(
    sachet.sort(),
    products.filter((p) => p.factory === "sachet").map((p) => p.id).sort(),
  );
  assert.deepEqual(
    bottle.sort(),
    products.filter((p) => p.factory === "bottle").map((p) => p.id).sort(),
  );
});

test("only production memberships carry a bottle or sachet scope", () => {
  assert.match(sql, /check \(factory in \('bottle', 'sachet'\)\)/);
  assert.match(sql, /check \(factory is null or role = 'production'\)/);
  assert.equal(asFactory("sachet"), "sachet");
  assert.equal(asFactory("bottle"), "bottle");
  assert.equal(asFactory("capsule"), undefined);
  assert.equal(asFactory(null), undefined);
});

test("a sachet supervisor cannot change a bottle batch with any production command", () => {
  const s = createDraft();
  const id = bottleId(s);
  const attempts = [
    ["batch", { product: "cav", code: "X-1", date: "2026-10-07", target: 5 }],
    ["step", { id, step: 0, pic: "P", qty: 1, qc: "not-recorded" }],
    ["transfer", { id, qty: 1, pic: "P" }],
    ["machine", { id, stage: "mixing", pic: "P" }],
    ["stage-rework", { id, stage: "mixing", pic: "P", reason: "x" }],
    ["stage-correct", { id, stage: "mixing", field: "machine", reason: "x" }],
    ["change-step-pic", { id, step: 0, kind: "correction", pic: "Q", reason: "x" }],
    ["route-review", { id, decision: "upgrade", reason: "x" }],
  ];
  for (const [type, input] of attempts) {
    const result = save(s, "sachet", type, input);
    assert.match(result.denied ?? "", /sachet factory only/, type);
  }
  // Every production command that writes batches is covered by the list above.
  const batchCommands = Object.entries(commandRules)
    .filter(([, rule]) => rule.stateKeys.includes("batches"))
    .map(([type]) => type);
  assert.deepEqual(batchCommands.sort(), attempts.map(([type]) => type).sort());
});

test("a bottle supervisor cannot change a sachet batch or the machine register", () => {
  const s = createDraft();
  const id = sachetId(s);
  for (const [type, input] of [
    ["batch", { product: "ady", code: "X-2", date: "2026-10-07", route: "sachet-v2" }],
    ["machine", { id, stage: "mixing", pic: "P" }],
    ["transfer", { id, pic: "P" }],
    ["machine-create", { stage: "mixing", name: "Mixer 9" }],
  ])
    assert.match(save(s, "bottle", type, input).denied ?? "", /factory only/, type);
});

test("scoped supervisors keep their own factory; unscoped supervisors keep both", () => {
  let s = createDraft();
  let r = save(s, "sachet", "batch", {
    product: "ady",
    code: "OWN-ADY",
    date: "2026-10-07",
    route: "sachet-v2",
  });
  assert.ok(r.state, r.denied);
  s = r.state;
  r = save(s, "sachet", "machine", { id: s.batches[0].id, stage: "mixing", pic: "P" });
  assert.ok(r.state, r.denied);
  r = save(r.state, "sachet", "machine-create", { stage: "mixing", name: "Mixer 9" });
  assert.ok(r.state, r.denied);
  s = r.state;
  r = save(s, "bottle", "batch", { product: "gly", code: "OWN-GLY", date: "2026-10-07", target: 4 });
  assert.ok(r.state, r.denied);
  s = r.state;
  r = save(s, "bottle", "step", { id: s.batches[0].id, step: 0, pic: "P", qty: 4, qc: "pass" });
  assert.ok(r.state, r.denied);
  // Site-wide records are not factory records.
  r = save(r.state, "bottle", "close", { date: "2026-10-07", note: "Done" });
  assert.ok(r.state, r.denied);
  for (const [type, input] of [
    ["step", { id: bottleId(s), step: 0, pic: "P", qty: 1, qc: "pass" }],
    ["machine", { id: sachetId(s), stage: "filling", pic: "P" }],
  ]) {
    assert.equal(factoryDenial(undefined, type, input, s.batches), null);
    assert.deepEqual(outOfFactory(undefined, s, apply(s, type, input)), []);
  }
});

test("the state re-check catches what the pre-check cannot see, failing closed", () => {
  const s = createDraft();
  const forged = structuredClone(s);
  forged.batches.find((b) => !isSachet(b.product)).target += 1;
  assert.deepEqual(outOfFactory("sachet", s, forged), [
    s.batches.find((b) => !isSachet(b.product)).code,
  ]);
  const unknown = structuredClone(s);
  unknown.batches.unshift({ ...s.batches[0], id: "u", code: "UNKNOWN", product: "xyz" });
  assert.deepEqual(outOfFactory("sachet", s, unknown), ["UNKNOWN"]);
  assert.deepEqual(outOfFactory("bottle", s, unknown), ["UNKNOWN"]);
  assert.match(
    factoryDenial("sachet", "batch", { product: "xyz" }, s.batches) ?? "",
    /factory only/,
  );
  // Reordering batches is not a change.
  const reordered = structuredClone(s);
  reordered.batches.reverse();
  assert.deepEqual(outOfFactory("sachet", s, reordered), []);
});

test("the API command path applies both checks for every operational save", () => {
  const pre = route.indexOf("factoryDenial(membership.factory");
  // The operational path follows the fictional sandbox in the same handler.
  const apply = route.lastIndexOf("applyCommand(current");
  const post = route.indexOf("outOfFactory(membership.factory");
  const commit = route.indexOf('db.rpc("operator_commit_workspace"');
  assert.ok(pre > 0 && pre < apply && apply < post && post < commit);
  // The database check runs inside the commit function, before the transition checks.
  assert.match(sql, /perform operator_private\.assert_factory_scope\(v_current\.state, v_new, v_factory\);/);
});
