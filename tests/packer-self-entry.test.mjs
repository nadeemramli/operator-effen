// Shared packer sign-in: the stock-out supervisor manages packer profiles; a packer unlocks
// their own profile with a PIN (checked by the database) and records their own first count.
import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand, createDraft, packEntrySource, packerProfiles, staffName } from "../apps/web/src/lib/draft.ts";
import { effectiveCapabilities, outOfScopeKeys } from "../apps/web/src/lib/access.ts";
import {
  openPackerSession,
  PACKER_IDLE_MS,
  sealPackerSession,
} from "../apps/web/src/lib/packer-session.ts";

const DATE = "2026-10-01";
const ALI = "20000000-0000-4000-8000-0000000000a1";
const ABU = "20000000-0000-4000-8000-0000000000a2";
const member = (role, n = 1) => ({
  kind: "member",
  role,
  name: role === "packer" ? "Packers" : "Synthetic " + role,
  userId: `00000000-0000-4000-8000-00000000003${n}`,
  siteId: "site-a",
});
const SV = member("outbound"),
  PACKERS = member("packer", 2);
const run = (s, actor, type, input, performer) => {
  const next = applyCommand(s, {
    type,
    role: actor.role,
    input,
    actor,
    capabilities: effectiveCapabilities(actor.role),
    performer,
  });
  assert.deepEqual(outOfScopeKeys(type, s, next), [], type);
  return next;
};
// A day with two reviewed, counted AWBs: one assigned to Ali, one to Abu.
function day() {
  let s = createDraft();
  s.orders = [];
  s = run(s, SV, "staff-profile-create", { profileId: ALI, name: "Sample Ali" });
  s = run(s, SV, "staff-profile-create", { profileId: ABU, name: "Sample Abu" });
  for (const awb of ["SYN-1", "SYN-2"]) {
    s = run(s, SV, "order", { awb, product: "cav", channel: "TikTok", package: "P", expected: 2, date: DATE });
    s = run(s, SV, "review-order", { id: s.orders[0].id, pic: "S" });
  }
  s = run(s, SV, "sort-count", { date: DATE, product: "cav", counted: 4, pic: "S" });
  const [two, one] = s.orders;
  s = run(s, SV, "assign-orders", { ids: [one.id], packer: ALI, pic: "S" });
  s = run(s, SV, "assign-orders", { ids: [two.id], packer: ABU, pic: "S" });
  return { s, ali: one.id, abu: two.id };
}

test("the stock-out supervisor adds, renames, deactivates and reactivates packer profiles", () => {
  let { s } = day();
  assert.deepEqual(packerProfiles(s).map((p) => p.name), ["Sample Ali", "Sample Abu"]);
  assert.equal(s.staffProfiles[0].createdBy.userId, SV.userId);
  assert.equal(s.events.find((e) => e.entity === "staff:" + ALI).action, "Packer profile added");
  assert.throws(
    () => run(s, SV, "staff-profile-create", { profileId: "20000000-0000-4000-8000-0000000000a3", name: "sample ali" }),
    /already has this name/,
  );
  assert.throws(() => run(s, SV, "staff-profile-create", { profileId: ALI, name: "Other" }), /already exists/);
  assert.throws(() => run(s, SV, "staff-profile-create", { profileId: "not-a-uuid", name: "X" }), /Invalid profile/);
  s = run(s, SV, "staff-profile-update", { id: ALI, name: "Sample Ali B" });
  assert.equal(staffName(s, ALI), "Sample Ali B");
  s = run(s, SV, "staff-profile-update", { id: ABU, active: false });
  assert.deepEqual(packerProfiles(s).map((p) => p.id), [ALI]);
  assert.throws(() => run(s, SV, "staff-profile-update", { id: ABU, active: false }), /Nothing to change/);
  s = run(s, SV, "staff-profile-update", { id: ABU, active: true });
  assert.equal(packerProfiles(s).length, 2);
});

test("only the stock-out supervisor and HR manage packer profiles", () => {
  const s = createDraft();
  const input = { profileId: ALI, name: "Sample Ali" };
  assert.ok(run(s, member("hr"), "staff-profile-create", input).staffProfiles.length);
  for (const role of ["production", "intake"])
    assert.throws(() => run(s, member(role), "staff-profile-create", input), /responsible supervisor/);
  for (const role of ["packer", "driver", "admin", "management"])
    assert.throws(() => run(s, member(role), "staff-profile-create", input), /does not permit/);
});

test("an inactive packer cannot be assigned", () => {
  let { s, ali } = day();
  s = run(s, SV, "staff-profile-update", { id: ABU, active: false });
  assert.throws(() => run(s, SV, "assign-orders", { ids: [ali], packer: ABU, pic: "S", reason: "x" }), /packer profile/);
});

test("a packer records their own first count for their own assigned AWB", () => {
  let { s, ali } = day();
  s = run(s, PACKERS, "pack-own", { id: ali, actual: 2 }, ALI);
  const o = s.orders.find((x) => x.id === ali);
  assert.equal(o.actual, 2);
  assert.equal(o.packer, ALI);
  assert.equal(o.labelPic, ALI);
  assert.equal(o.packRecordedBy.userId, PACKERS.userId);
  assert.equal(s.events[0].performer, ALI);
  assert.equal(s.events[0].recorder.userId, PACKERS.userId);
  assert.match(s.events[0].detail, /packed by Sample Ali · AWB attached by Sample Ali · entered by the packer with their PIN/);
  // Saved counts are fixed for the packer; the supervisor corrects with a reason.
  assert.throws(() => run(s, PACKERS, "pack-own", { id: ali, actual: 1 }, ALI), /supervisor correction/);
  assert.throws(() => run(s, PACKERS, "correct", { id: ali, field: "actual", qty: 1, reason: "x" }, ALI), /does not permit/);
  s = run(s, SV, "correct", { id: ali, field: "actual", qty: 1, reason: "Recount" });
  assert.equal(s.orders.find((x) => x.id === ali).actual, 1);
});

test("a packer cannot record someone else's AWB or name another packer", () => {
  const { s, ali, abu } = day();
  assert.throws(() => run(s, PACKERS, "pack-own", { id: abu, actual: 2 }, ALI), /assigned to another packer/);
  // The packer comes only from the PIN-unlocked session; input fields are ignored.
  const next = run(s, PACKERS, "pack-own", { id: ali, actual: 2, pic: ABU, packer: ABU, labelPic: ABU }, ALI);
  assert.equal(next.orders.find((x) => x.id === ali).packer, ALI);
  assert.throws(() => run(s, PACKERS, "pack-own", { id: ali, actual: 2 }), /enter your PIN/);
  assert.throws(() => run(s, PACKERS, "pack-own", { id: ali, actual: 2 }, "Sample Packer A"), /enter your PIN/);
  const inactive = run(s, SV, "staff-profile-update", { id: ALI, active: false });
  assert.throws(() => run(inactive, PACKERS, "pack-own", { id: ali, actual: 2 }, ALI), /enter your PIN/);
  for (const role of ["outbound", "production", "driver"])
    assert.throws(() => run(s, member(role), "pack-own", { id: ali, actual: 2 }, ALI), /does not permit/);
});

test("the preview packer records for a sample profile without a PIN", () => {
  const preview = (s, role, type, input, performer) =>
    applyCommand(s, { type, role, input, performer });
  let s = createDraft();
  s.orders = [];
  s = preview(s, "outbound", "order", { awb: "SYN-P", product: "cav", channel: "TikTok", package: "P", expected: 1, date: DATE });
  const id = s.orders[0].id;
  s = preview(s, "outbound", "review-order", { id, pic: "S" });
  s = preview(s, "outbound", "sort-count", { date: DATE, product: "cav", counted: 1, pic: "S" });
  s = preview(s, "outbound", "assign-orders", { ids: [id], packer: "Sample Packer A", pic: "S" });
  s = preview(s, "packer", "pack-own", { id, actual: 1 }, "Sample Packer A");
  assert.equal(s.orders[0].packer, "Sample Packer A");
  assert.equal(s.orders[0].packRecordedBy.kind, "preview");
});

test("packer sessions are signed, expire and belong to one account and site", () => {
  const secret = Buffer.alloc(32, 7);
  const now = 1_800_000_000_000;
  const who = {
    userId: "00000000-0000-4000-8000-000000000032",
    workspaceId: "10000000-0000-4000-8000-00000000000a",
  };
  const cookie = sealPackerSession(secret, { ...who, profileId: ALI, expiresAt: now + PACKER_IDLE_MS });
  assert.equal(openPackerSession(secret, cookie, who, now)?.profileId, ALI);
  assert.equal(openPackerSession(secret, cookie, who, now + PACKER_IDLE_MS), null, "expired");
  assert.equal(openPackerSession(Buffer.alloc(32, 8), cookie, who, now), null, "other key");
  assert.equal(openPackerSession(secret, cookie.replace(ALI, ABU), who, now), null, "edited profile");
  assert.equal(openPackerSession(secret, cookie, { ...who, userId: "00000000-0000-4000-8000-000000000033" }, now), null);
  assert.equal(openPackerSession(secret, cookie, { ...who, workspaceId: "10000000-0000-4000-8000-00000000000b" }, now), null);
  const far = sealPackerSession(secret, { ...who, profileId: ALI, expiresAt: now + 10 * PACKER_IDLE_MS });
  assert.equal(openPackerSession(secret, far, who, now), null, "longer than one idle period");
  for (const bad of [undefined, "", "v1.x", cookie + "0"]) assert.equal(openPackerSession(secret, bad, who, now), null);
});

// WP8 residual: the daily tally and the parcel record show who keyed each count.
test("each packed count shows whether the packer (PIN) or a supervisor entered it", () => {
  let { s, ali, abu } = day();
  const order = (id) => s.orders.find((o) => o.id === id);
  assert.equal(packEntrySource(order(ali)), null, "nothing packed yet");
  s = run(s, PACKERS, "pack-own", { id: ali, actual: 2 }, ALI);
  s = run(s, SV, "pack", { id: abu, actual: 2, pic: ABU, labelPic: ABU });
  assert.equal(packEntrySource(order(ali)), "packer");
  assert.equal(packEntrySource(order(abu)), "supervisor");
  // Records saved before the recorder was kept are shown as not recorded, not guessed.
  assert.equal(packEntrySource({ actual: 2 }), "unknown");
});
