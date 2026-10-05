// OPER-5: one machine/PIC record per batch stage, editable from Production and Stock-in.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  available,
  ConflictError,
  createDraft,
  stageStep,
} from "../apps/web/src/lib/draft.ts";
import { outOfScopeKeys } from "../apps/web/src/lib/access.ts";

const member = (role, siteId = "site-a") => ({
  kind: "member",
  role,
  name: "Synthetic " + role + " SV",
  userId: "u-" + role + "-" + siteId,
  siteId,
});
const as = (s, role, type, input, siteId) =>
  applyCommand(s, { type, role, input, actor: member(role, siteId) });
const stages = ["mixing", "filling", "batching", "hologram", "wrapping"];

function withMachines() {
  let s = createDraft();
  s = as(s, "production", "machine-create", { stage: "hologram", name: "Holo A", code: "HA-1" });
  s = as(s, "intake", "machine-create", { stage: "hologram", name: "Holo B" });
  s = as(s, "production", "machine-create", { stage: "mixing", name: "Mixer 1" });
  s = as(s, "production", "batch", { product: "ady", code: "SHARED-1", date: "2026-09-30" });
  return s;
}
const machine = (s, name) => s.machines.find((m) => m.name === name);

test("Production and Stock-in edit the same stage record; no second history is created", () => {
  let s = withMachines();
  const id = s.batches[0].id;
  s = as(s, "production", "machine", {
    id,
    stage: "hologram",
    pic: "Operator H",
    machineId: machine(s, "Holo A").id,
    expectedVersion: 0,
  });
  const step = stageStep(s.batches[0], "hologram");
  assert.equal(step.recordedBy.role, "production");
  // Stock-in corrects the very same record.
  s = as(s, "intake", "stage-correct", {
    id,
    stage: "hologram",
    field: "machine",
    machineId: machine(s, "Holo B").id,
    reason: "Wrong machine chosen on the line",
    expectedVersion: step.version,
  });
  const after = s.batches[0];
  assert.equal(after.steps.filter((x) => x.sachetStage === "hologram").length, 1);
  const updated = stageStep(after, "hologram");
  assert.equal(updated.machineName, "Holo B");
  assert.equal(updated.corrections[0].from, "Holo A");
  assert.equal(updated.corrections[0].recordedBy.role, "intake");
  assert.equal(updated.pic, "Operator H");
  // Stock-in can record a stage too; Production sees it (same state).
  s = as(s, "intake", "machine", { id, stage: "mixing", pic: "Operator M" });
  assert.equal(stageStep(s.batches[0], "mixing").recordedBy.role, "intake");
});

test("machine registry: create, find, edit and deactivate without rewriting history", () => {
  let s = withMachines();
  const id = s.batches[0].id;
  s = as(s, "production", "machine", {
    id,
    stage: "hologram",
    pic: "Operator H",
    machineId: machine(s, "Holo A").id,
  });
  assert.throws(
    () => as(s, "intake", "machine-create", { stage: "hologram", name: "holo a" }),
    /already exists/,
  );
  const holo = machine(s, "Holo A");
  s = as(s, "intake", "machine-update", {
    id: holo.id,
    name: "Hologram Line 1",
    code: "HA-1",
    expectedVersion: holo.version,
  });
  assert.equal(stageStep(s.batches[0], "hologram").machineName, "Holo A");
  assert.equal(s.machines.find((m) => m.id === holo.id).history.at(-1).changes.name[1], "Hologram Line 1");
  const renamed = s.machines.find((m) => m.id === holo.id);
  assert.throws(
    () => as(s, "production", "machine-deactivate", { id: holo.id, expectedVersion: renamed.version }),
    /reason/,
  );
  s = as(s, "production", "machine-deactivate", {
    id: holo.id,
    reason: "Retired",
    expectedVersion: renamed.version,
  });
  const inactive = s.machines.find((m) => m.id === holo.id);
  assert.equal(inactive.active, false);
  // Inactive machines stay readable in history but are not offered for new work.
  assert.equal(stageStep(s.batches[0], "hologram").machineId, holo.id);
  assert.throws(
    () =>
      as(s, "production", "stage-rework", {
        id,
        stage: "hologram",
        pic: "P",
        reason: "redo",
        machineId: holo.id,
      }),
    /inactive/,
  );
  assert.throws(
    () => as(s, "production", "machine", { id, stage: "mixing", pic: "P", machineId: holo.id }),
    /registered for Hologram machine/,
  );
  assert.throws(
    () => as(s, "packer", "machine-create", { stage: "mixing", name: "X" }),
    /supervisor role|signed-in role|does not permit/,
  );
});

test("wrong-site machine and batch selections are denied", () => {
  let s = withMachines();
  const id = s.batches[0].id;
  s.machines.push({
    id: "site-b-holo",
    siteId: "site-b",
    stage: "hologram",
    name: "Other site holo",
    active: true,
    createdAt: "t",
    updatedAt: "t",
    version: 1,
    history: [],
  });
  assert.throws(
    () =>
      as(s, "production", "machine", {
        id,
        stage: "hologram",
        pic: "P",
        machineId: "site-b-holo",
      }),
    /another site/,
  );
  assert.throws(
    () => as(s, "production", "machine", { id, stage: "hologram", pic: "P", machineId: "nope" }),
    /could not be found/,
  );
  assert.throws(
    () =>
      as(s, "production", "machine-update", {
        id: "site-b-holo",
        name: "Taken over",
        expectedVersion: 1,
      }),
    /another site/,
  );
  assert.throws(
    () => as(s, "intake", "stage-rework", { id, stage: "mixing", pic: "P", reason: "x" }, "site-b"),
    /another site/,
  );
});

test("concurrent edits from two screens conflict instead of overwriting", () => {
  let s = withMachines();
  const id = s.batches[0].id;
  s = as(s, "production", "machine", { id, stage: "hologram", pic: "Operator H" });
  const opened = stageStep(s.batches[0], "hologram").version;
  // Production saves a PIC correction first...
  s = as(s, "production", "change-step-pic", {
    id,
    stage: "hologram",
    kind: "correction",
    pic: "Operator H2",
    reason: "Wrong profile",
    expectedVersion: opened,
  });
  // ...then Stock-in submits a change based on the version it had opened.
  let conflict;
  try {
    as(s, "intake", "stage-correct", {
      id,
      stage: "hologram",
      field: "machine",
      machineId: machine(s, "Holo B").id,
      reason: "Machine",
      expectedVersion: opened,
    });
  } catch (e) {
    conflict = e;
  }
  assert.ok(conflict instanceof ConflictError);
  assert.equal(conflict.conflict.currentVersion, opened + 1);
  assert.equal(conflict.conflict.expectedVersion, opened);
  // A correction without the opened version is refused rather than applied blind.
  assert.throws(
    () =>
      as(s, "intake", "stage-correct", {
        id,
        stage: "hologram",
        field: "machine",
        machineId: machine(s, "Holo B").id,
        reason: "Machine",
      }),
    /Reopen this record/,
  );
  // Machine master edits are version-protected too.
  const m = machine(s, "Holo B");
  s = as(s, "production", "machine-update", { id: m.id, name: "Holo B2", expectedVersion: m.version });
  assert.throws(
    () => as(s, "intake", "machine-update", { id: m.id, name: "Holo B3", expectedVersion: m.version }),
    /changed by another entry/,
  );
});

test("assignment, reassignment, handover, completion and correction are distinct", () => {
  let s = createDraft();
  s = as(s, "production", "batch", {
    product: "ady",
    code: "KINDS-1",
    date: "2026-09-30",
    pic_0: "Planned A",
  });
  const id = s.batches[0].id;
  s = as(s, "intake", "change-step-pic", {
    id,
    stage: "mixing",
    kind: "reassignment",
    pic: "Planned B",
    reason: "A moved to filling",
  });
  s = as(s, "production", "change-step-pic", {
    id,
    stage: "mixing",
    kind: "handover",
    pic: "Planned C",
    effectiveAt: "2026-09-30T14:00",
    reason: "Shift change",
  });
  s = as(s, "production", "machine", { id, stage: "mixing", pic: "Planned C" });
  assert.throws(
    () =>
      as(s, "production", "change-step-pic", {
        id,
        stage: "mixing",
        kind: "reassignment",
        pic: "Z",
        reason: "x",
      }),
    /cannot be reassigned/,
  );
  s = as(s, "production", "change-step-pic", {
    id,
    stage: "mixing",
    kind: "correction",
    pic: "Planned D",
    reason: "Wrong person selected at completion",
  });
  const step = stageStep(s.batches[0], "mixing");
  assert.deepEqual(
    step.picHistory.map((h) => h.kind),
    ["assignment", "reassignment", "handover", "correction"],
  );
  assert.equal(step.picHistory[2].effectiveAt, "2026-09-30T06:00:00.000Z");
  assert.equal(step.picHistory[1].recordedBy.role, "intake");
  assert.ok(step.recordedBy && step.occurredAt);
  // Stock-in may not edit bottle production records.
  assert.throws(
    () =>
      as(s, "intake", "change-step-pic", {
        id: "b-cav-next",
        step: 1,
        kind: "correction",
        pic: "X",
        reason: "x",
      }),
    /sachet machine\/PIC records only/,
  );
});

test("post-transfer corrections keep custody and stock facts and are flagged as revised", () => {
  let s = withMachines();
  const id = s.batches[0].id;
  for (const stage of stages)
    s = as(s, "production", "machine", {
      id,
      stage,
      pic: "P-" + stage,
      ...(stage === "hologram" ? { machineId: machine(s, "Holo A").id } : {}),
      occurredAt: "2026-09-30T09:00",
    });
  s = as(s, "production", "transfer", { id, pic: "Factory SV" });
  s = as(s, "intake", "receive-ady", { batchId: id, pic: "Receiver" });
  s = as(s, "intake", "stock-in-ady", {
    receiptId: s.adypocideReceipts[0].id,
    boxes: 40,
    rack: "R1",
    pic: "Stock-in SV",
  });
  const carton = s.cartons.find((c) => c.batchId === id);
  const snapshot = (x) =>
    JSON.stringify({
      cartons: x.cartons,
      issues: x.issues,
      receipts: x.adypocideReceipts,
      adjustments: x.adjustments,
      transferredAt: x.batches[0].transferredAt,
      transferPic: x.batches[0].transferPic,
    });
  const before = snapshot(s);
  const step = stageStep(s.batches[0], "hologram");
  let next = as(s, "intake", "stage-correct", {
    id,
    stage: "hologram",
    field: "machine",
    machineId: machine(s, "Holo B").id,
    reason: "Line log shows Holo B",
    expectedVersion: step.version,
  });
  next = as(next, "production", "change-step-pic", {
    id,
    stage: "wrapping",
    kind: "correction",
    pic: "P-wrap-actual",
    reason: "Wrong profile",
  });
  next = as(next, "production", "stage-correct", {
    id,
    stage: "mixing",
    field: "occurredAt",
    occurredAt: "2026-09-30T07:45",
    reason: "Mixing finished earlier",
    expectedVersion: stageStep(next.batches[0], "mixing").version,
  });
  assert.equal(snapshot(next), before);
  assert.equal(available(next, next.cartons.find((c) => c.id === carton.id)), 40);
  assert.deepEqual(
    next.batches[0].revisions.map((r) => [r.stage, r.field]),
    [
      ["hologram", "machine"],
      ["wrapping", "pic"],
      ["mixing", "occurredAt"],
    ],
  );
  assert.match(next.events[0].detail, /revised after transfer/);
  // Corrections may not move a stage after the transfer it preceded.
  assert.throws(
    () =>
      as(next, "production", "stage-correct", {
        id,
        stage: "mixing",
        field: "occurredAt",
        occurredAt: "2999-01-01T00:00",
        reason: "x",
        expectedVersion: stageStep(next.batches[0], "mixing").version,
      }),
    /future|after the batch was sent/,
  );
  // Handover and rework stay closed after transfer; scope stays within batch records.
  assert.throws(
    () =>
      as(next, "production", "change-step-pic", {
        id,
        stage: "mixing",
        kind: "handover",
        pic: "Q",
        effectiveAt: "2026-09-30T08:00",
        reason: "x",
      }),
    /already transferred/,
  );
  assert.throws(
    () => as(next, "production", "stage-rework", { id, stage: "mixing", pic: "Q", reason: "x" }),
    /still in production/,
  );
  assert.deepEqual(outOfScopeKeys("stage-correct", s, next), []);
});
