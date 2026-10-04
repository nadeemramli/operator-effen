// OPER-2: supervisor-only operational entry with separate recorder and performer identity.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  createDraft,
  findOperation,
  recordOperation,
  recorderLabel,
} from "../apps/web/src/lib/draft.ts";
import {
  authorizeMember,
  defaultWritePolicy,
  fingerprint,
  outOfScopeKeys,
  readWritePolicy,
  roleStateKeys,
} from "../apps/web/src/lib/access.ts";

const sv = (role, siteId = "site-a", name = "Synthetic SV") => ({
  kind: "member",
  role,
  name,
  userId: "user-" + role + "-" + siteId,
  siteId,
});
const asMember = (s, actor, type, input, policy = defaultWritePolicy) =>
  applyCommand(s, { type, role: actor.role, input, actor, policy });

function assignedOrder() {
  let s = createDraft();
  const actor = sv("outbound");
  s = asMember(s, actor, "sort-count", {
    date: s.orders[0].date,
    product: "gly",
    counted: 2,
    pic: "Sample PIC A",
  });
  s = asMember(s, actor, "assign-orders", {
    ids: ["o-3"],
    packer: "Sample Packer A",
    pic: "Sample PIC A",
  });
  return s;
}

test("packers, drivers, assistants and management cannot write; supervisors can within their command set", () => {
  for (const role of ["packer", "driver", "assistant"])
    for (const type of ["pack", "machine", "feedback", "dispatch", "reset"])
      assert.match(
        authorizeMember(role, type, defaultWritePolicy),
        /supervisor|view only/,
      );
  assert.match(
    authorizeMember("management", "review", defaultWritePolicy),
    /not enabled/,
  );
  assert.match(
    authorizeMember("admin", "import-save", defaultWritePolicy),
    /not enabled/,
  );
  assert.equal(authorizeMember("outbound", "pack", defaultWritePolicy), null);
  assert.equal(authorizeMember("production", "machine", defaultWritePolicy), null);
  assert.equal(authorizeMember("intake", "machine", defaultWritePolicy), null);
  assert.match(
    authorizeMember("production", "pack", defaultWritePolicy),
    /does not permit/,
  );
  assert.match(authorizeMember("outbound", "reset", defaultWritePolicy), /does not permit/);
});

test("office-admin imports and management comments are explicit, configurable exceptions", () => {
  const policy = readWritePolicy({ admin_imports: true, management_comments: "true" });
  assert.deepEqual(policy, { adminImports: true, managementComments: false });
  assert.equal(authorizeMember("admin", "import-save", policy), null);
  assert.match(authorizeMember("admin", "machine", policy), /does not permit/);
  // The domain layer enforces the same policy even if the access check were skipped.
  const s = createDraft();
  assert.throws(
    () =>
      asMember(s, sv("management"), "review", { text: "Check line 2" }),
    /Management comments are not enabled/,
  );
  assert.throws(
    () =>
      asMember(s, sv("admin"), "order", {
        awb: "SYN-AWB-1",
        product: "cav",
        channel: "TikTok",
        package: "P",
        expected: 1,
        date: "2026-10-01",
      }),
    /Office-admin order entry/,
  );
  const allowed = asMember(
    s,
    sv("management"),
    "review",
    { text: "Check line 2" },
    { adminImports: false, managementComments: true },
  );
  assert.equal(allowed.notes[0].text, "Check line 2");
});

test("a client-chosen role cannot override the server-derived member role", () => {
  const s = createDraft();
  assert.throws(
    () =>
      applyCommand(s, {
        type: "batch",
        role: "production",
        input: { product: "cav", code: "X-1", date: "2026-10-01", target: 1 },
        actor: sv("packer"),
      }),
    /signed-in role/,
  );
});

test("the stock-out SV records the actual packer; recorder and performer stay separate", () => {
  let s = assignedOrder();
  const actor = sv("outbound", "site-a", "Synthetic Stock-out SV");
  assert.throws(
    () =>
      applyCommand(s, {
        type: "pack",
        role: "packer",
        input: { id: "o-3", actual: 2, pic: "Sample Packer A", labelPic: "X" },
      }),
    /supervisor role/,
  );
  assert.throws(
    () =>
      asMember(s, actor, "pack", {
        id: "o-3",
        actual: 2,
        pic: "Sample Packer B",
        labelPic: "Sample Packer B",
      }),
    /differs from the assigned packer/,
  );
  s = asMember(s, actor, "pack", {
    id: "o-3",
    actual: 2,
    pic: "Sample Packer A",
    labelPic: "Sample Packer B",
    occurredAt: "2026-09-01T10:15",
  });
  const order = s.orders.find((o) => o.id === "o-3");
  assert.equal(order.packer, "Sample Packer A");
  assert.equal(order.packRecordedBy.name, "Synthetic Stock-out SV");
  assert.equal(order.packRecordedBy.userId, actor.userId);
  assert.equal(order.packedAt, "2026-09-01T02:15:00.000Z");
  assert.notEqual(order.packRecordedAt, order.packedAt);
  const event = s.events[0];
  assert.equal(event.performer, "Sample Packer A");
  assert.equal(event.recorder.userId, actor.userId);
  assert.match(event.actor, /Synthetic Stock-out SV · Stock-out supervisor/);
});

test("a different actual packer needs a reason and is visible in audit", () => {
  let s = assignedOrder();
  s = asMember(s, sv("outbound"), "pack", {
    id: "o-3",
    actual: 2,
    pic: "Sample Packer B",
    labelPic: "Sample Packer B",
    reason: "Packer A was on break",
  });
  assert.match(s.events[0].detail, /assigned to Sample Packer A: Packer A was on break/);
});

test("historical packer self-declarations keep their original attribution", () => {
  const s = createDraft();
  const before = s.orders.find((o) => o.id === "o-1");
  s.events.unshift({
    id: "legacy-pack",
    entity: "o-1",
    action: "Parcel quantity declared",
    detail: "Cavernosil: 2 bottle · Sample Packer A · AWB attached by Sample Packer B",
    actor: "Packer (test view)",
    at: "2026-09-20T01:00:00.000Z",
  });
  const after = asMember(s, sv("outbound"), "print", { id: "o-4", pic: "SV" });
  const legacy = after.events.find((e) => e.id === "legacy-pack");
  assert.equal(legacy.actor, "Packer (test view)");
  assert.equal(legacy.recorder, undefined);
  assert.deepEqual(after.orders.find((o) => o.id === "o-1"), before);
});

test("future occurrence times are rejected; late entries keep the actual time", () => {
  const s = assignedOrder();
  assert.throws(
    () =>
      asMember(s, sv("outbound"), "pack", {
        id: "o-3",
        actual: 2,
        pic: "Sample Packer A",
        labelPic: "X",
        occurredAt: "2999-01-01T09:00",
      }),
    /future/,
  );
});

test("another site's supervisor cannot mutate a site-scoped batch", () => {
  let s = createDraft();
  s = asMember(s, sv("production", "site-a"), "batch", {
    product: "ady",
    code: "SITE-A-1",
    date: "2026-10-01",
  });
  const id = s.batches[0].id;
  assert.equal(s.batches[0].siteId, "site-a");
  for (const [type, input] of [
    ["machine", { id, stage: "mixing", pic: "PIC" }],
    ["change-step-pic", { id, stage: "mixing", kind: "correction", pic: "P2", reason: "x" }],
    ["transfer", { id, pic: "X" }],
  ])
    assert.throws(
      () => asMember(s, sv("production", "site-b"), type, input),
      /another site/,
    );
});

test("role state scopes block alternate-path edits outside the role's records", () => {
  const before = createDraft();
  const after = structuredClone(before);
  after.cartons[0].qty = 9999;
  assert.deepEqual(outOfScopeKeys("production", before, after), ["cartons"]);
  assert.deepEqual(outOfScopeKeys("intake", before, after), []);
  assert.deepEqual(outOfScopeKeys("packer", before, after), ["cartons"]);
  // Every command a role may run must stay inside its scope.
  let s = createDraft();
  const next = asMember(s, sv("production"), "batch", {
    product: "ady",
    code: "SCOPE-1",
    date: "2026-10-01",
  });
  assert.deepEqual(outOfScopeKeys("production", s, next), []);
  s = asMember(next, sv("intake"), "machine-create", { stage: "hologram", name: "Holo 1" });
  assert.deepEqual(outOfScopeKeys("intake", next, s), []);
  assert.ok(roleStateKeys.intake.includes("batches"));
});

test("operation IDs: same payload replays, a different payload with the same ID is detectable", () => {
  const s = createDraft();
  const a = fingerprint("machine", { id: "b", stage: "mixing", pic: "P" });
  const b = fingerprint("machine", { pic: "P", stage: "mixing", id: "b" });
  const c = fingerprint("machine", { id: "b", stage: "mixing", pic: "Q" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  recordOperation(s, { id: "op-1", type: "machine", fingerprint: a, userId: "u", at: "t" });
  assert.equal(findOperation(s, "op-1").fingerprint, a);
  for (let i = 0; i < 600; i++)
    recordOperation(s, { id: "op-x" + i, type: "t", fingerprint: "f", at: "t" });
  assert.equal(s.operations.length, 500);
});

test("recorder labels distinguish members from the fictional preview", () => {
  assert.equal(
    recorderLabel({ kind: "member", role: "intake", name: "SV Two" }),
    "SV Two · Stock-in supervisor",
  );
  assert.equal(
    recorderLabel({ kind: "preview", role: "intake", name: "x" }),
    "Stock-in supervisor (test view)",
  );
});
