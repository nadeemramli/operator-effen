// OPER-2: role-based operational entry with explicit capabilities, and separate recorder
// and performer identity.
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
  attest,
  authorizeMember,
  effectiveCapabilities,
  fingerprint,
  outOfScopeKeys,
} from "../apps/web/src/lib/access.ts";
import { commandRules, roleCapabilities } from "../apps/web/src/lib/capabilities.ts";

const sv = (role, siteId = "site-a", name = "Synthetic SV") => ({
  kind: "member",
  role,
  name,
  userId: "user-" + role + "-" + siteId,
  siteId,
});
const asMember = (s, actor, type, input, capabilities = effectiveCapabilities(actor.role)) =>
  applyCommand(s, { type, role: actor.role, input, actor, capabilities });

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

test("packers only post feedback, drivers also log trips; supervisors act within their capabilities", () => {
  for (const role of ["packer", "driver"]) {
    const caps = effectiveCapabilities(role);
    assert.deepEqual(caps, role === "driver" ? ["trips.log", "feedback.post"] : ["feedback.post"]);
    assert.equal(authorizeMember("feedback", caps), null);
    assert.equal(authorizeMember("trip", caps) === null, role === "driver");
    for (const type of ["pack", "machine", "dispatch", "adjust", "stage-correct", "reset"])
      assert.match(authorizeMember(type, caps), /supervisor|not available/);
  }
  assert.equal(authorizeMember("pack", effectiveCapabilities("outbound")), null);
  assert.equal(authorizeMember("machine", effectiveCapabilities("production")), null);
  assert.equal(authorizeMember("machine", effectiveCapabilities("intake")), null);
  assert.match(authorizeMember("pack", effectiveCapabilities("production")), /does not permit/);
  assert.match(authorizeMember("reset", effectiveCapabilities("outbound")), /not available/);
});

test("office admin, HR and management: explicit capabilities, never production/stock corrections", () => {
  const admin = effectiveCapabilities("admin"),
    hr = effectiveCapabilities("hr"),
    mgmt = effectiveCapabilities("management");
  assert.equal(authorizeMember("import-save", admin), null);
  assert.equal(authorizeMember("import-release", admin), null);
  assert.equal(authorizeMember("review", mgmt), null);
  for (const caps of [admin, hr, mgmt])
    for (const type of ["adjust", "stage-correct", "change-step-pic", "transfer", "batch", "correct"])
      assert.notEqual(authorizeMember(type, caps), null, type);
  assert.ok(hr.includes("members.manage"));
  assert.equal(authorizeMember("feedback", hr), null);
  // Stock adjustments and production corrections stay with the roles that hold them.
  assert.deepEqual(
    Object.entries(roleCapabilities).filter(([, c]) => c.includes("stock.adjust")).map(([r]) => r),
    ["intake"],
  );
  assert.deepEqual(
    Object.entries(roleCapabilities).filter(([, c]) => c.includes("stage.correct")).map(([r]) => r),
    ["production", "intake"],
  );
});

test("site policy narrows a role's capabilities and can never widen them", () => {
  const narrowed = effectiveCapabilities("management", {
    management: ["sources.read", "feedback.post"],
  });
  assert.deepEqual(narrowed, ["sources.read", "feedback.post"]);
  assert.deepEqual(effectiveCapabilities("packer", { packer: ["stock.adjust", "feedback.post"] }), [
    "feedback.post",
  ]);
  const s = createDraft();
  assert.throws(
    () => asMember(s, sv("management"), "review", { text: "Check line 2" }, narrowed),
    /does not permit/,
  );
  const allowed = asMember(s, sv("management"), "review", { text: "Check line 2" });
  assert.equal(allowed.notes[0].text, "Check line 2");
  assert.equal(allowed.notes[0].author.userId, "user-management-site-a");
});

test("feedback from view-only staff keeps its author, site, record and time", () => {
  const packer = sv("packer", "site-a", "Synthetic Packer");
  const s = asMember(createDraft(), packer, "feedback", {
    text: "Label printer jammed twice",
    entity: "TEST-AWB-1003",
  });
  const note = s.notes[0];
  assert.equal(note.kind, "feedback");
  assert.equal(note.author.userId, packer.userId);
  assert.equal(note.siteId, "site-a");
  assert.equal(note.entity, "TEST-AWB-1003");
  assert.ok(note.at);
  assert.deepEqual(outOfScopeKeys("feedback", createDraft(), s), []);
  assert.throws(
    () => asMember(createDraft(), packer, "pack", { id: "o-3", actual: 1, pic: "x", labelPic: "x" }),
    /does not permit/,
  );
});

test("events created by helpers are stamped with the server recorder", () => {
  const actor = sv("outbound", "site-a", "Synthetic Stock-out SV");
  let s = createDraft();
  s = asMember(s, actor, "order", {
    awb: "SYN-AWB-9",
    product: "cav",
    channel: "TikTok",
    package: "P",
    expected: 1,
    date: "2026-10-01",
  });
  assert.ok(s.events.every((e) => e.id === "seed" || e.recorder?.userId === actor.userId));
});

test("commit signatures bind user, revision, operation, command and exact state", () => {
  const secret = Buffer.alloc(32, 7);
  const base = {
    workspaceId: "w",
    revision: 3,
    userId: "u",
    operationId: "op",
    command: "machine",
    fingerprint: "f".repeat(64),
    stateText: '{"a":1}',
  };
  const sig = attest(secret, base);
  assert.match(sig, /^[0-9a-f]{64}$/);
  for (const change of [
    { userId: "other" },
    { revision: 4 },
    { operationId: "op2" },
    { command: "transfer" },
    { stateText: '{"a":2}' },
  ])
    assert.notEqual(attest(secret, { ...base, ...change }), sig);
  assert.notEqual(attest(Buffer.alloc(32, 8), base), sig);
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

test("command scopes block edits outside the command's records", () => {
  const before = createDraft();
  const after = structuredClone(before);
  after.cartons[0].qty = 9999;
  assert.deepEqual(outOfScopeKeys("machine", before, after), ["cartons"]);
  assert.deepEqual(outOfScopeKeys("receive", before, after), []);
  assert.deepEqual(outOfScopeKeys("feedback", before, after), ["cartons"]);
  let s = createDraft();
  const next = asMember(s, sv("production"), "batch", {
    product: "ady",
    code: "SCOPE-1",
    date: "2026-10-01",
  });
  assert.deepEqual(outOfScopeKeys("batch", s, next), []);
  s = asMember(next, sv("intake"), "machine-create", { stage: "hologram", name: "Holo 1" });
  assert.deepEqual(outOfScopeKeys("machine-create", next, s), []);
  assert.ok(commandRules["stage-correct"].stateKeys.includes("batches"));
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
