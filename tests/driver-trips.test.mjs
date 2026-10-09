// One driver role on a shared sign-in: each trip names its driver and assistant (typed),
// pickup and arrival time, photo. The assistant is recorded by name and never signs in.
import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand, createDraft, roles } from "../apps/web/src/lib/draft.ts";
import { effectiveCapabilities, outOfScopeKeys } from "../apps/web/src/lib/access.ts";

const WS = "10000000-0000-4000-8000-00000000000a";
const driver = (n = 1, siteId = "site-a") => ({
  kind: "member",
  role: "driver",
  name: "Synthetic Driver " + n,
  userId: `00000000-0000-4000-8000-00000000001${n}`,
  siteId,
});
const photo = (who, c = "e") => `${WS}/${who.userId}/${c.repeat(64)}.jpg`;
const run = (s, actor, type, input) => {
  const next = applyCommand(s, {
    type,
    role: actor.role,
    input,
    actor,
    capabilities: effectiveCapabilities(actor.role),
  });
  assert.deepEqual(outOfScopeKeys(type, s, next), [], type);
  return next;
};

test("driver and assistant are one role; there is no separate assistant login", () => {
  assert.ok(roles.some((r) => r.id === "driver"));
  assert.ok(!roles.some((r) => r.id === "assistant"));
  assert.throws(
    () => applyCommand(createDraft(), { type: "feedback", role: "assistant", input: { text: "x" } }),
    /valid test role/,
  );
});

test("a driver logs a trip with assistant, pickup, arrival and photo", () => {
  const d = driver();
  const s = run(createDraft(), d, "trip", {
    driver: "  Sample Driver Ali  ",
    assistant: "  Sample Assistant  ",
    pickupAt: "2026-10-01T08:15",
    arriveAt: "2026-10-01T09:40",
    photo: photo(d),
    note: "Courier hub",
  });
  const [trip] = s.trips;
  assert.equal(trip.driver, "Sample Driver Ali");
  assert.equal(trip.assistant, "Sample Assistant");
  assert.equal(trip.date, "2026-10-01");
  assert.equal(trip.pickupAt, "2026-10-01T00:15:00.000Z");
  assert.equal(trip.arriveAt, "2026-10-01T01:40:00.000Z");
  assert.equal(trip.photo, photo(d));
  assert.equal(trip.note, "Courier hub");
  assert.equal(trip.siteId, "site-a");
  assert.equal(trip.recordedBy.userId, d.userId);
  assert.equal(s.events[0].entity, "trip:" + trip.id);
  assert.equal(s.events[0].recorder.userId, d.userId);
  assert.equal(s.events[0].performer, "Sample Driver Ali");
  assert.match(s.events[0].detail, /^Driver Sample Driver Ali · pickup /);
});

test("pickup first, then arrival and photo later; recorded values are fixed", () => {
  const d = driver();
  let s = run(createDraft(), d, "trip", { driver: "Sample Driver", pickupAt: "2026-10-01T08:00" });
  const id = s.trips[0].id;
  assert.equal(s.trips[0].assistant, "");
  assert.equal(s.trips[0].arriveAt, undefined);
  assert.throws(() => run(s, d, "trip-update", { id }), /arrival time or add a photo/);
  assert.throws(
    () => run(s, d, "trip-update", { id, arriveAt: "2026-10-01T07:59" }),
    /before the pickup/,
  );
  s = run(s, d, "trip-update", { id, arriveAt: "2026-10-01T09:00" });
  assert.equal(s.trips[0].arriveAt, "2026-10-01T01:00:00.000Z");
  assert.ok(s.trips[0].arrivalRecordedAt);
  assert.throws(
    () => run(s, d, "trip-update", { id, arriveAt: "2026-10-01T09:30" }),
    /already recorded/,
  );
  s = run(s, d, "trip-update", { id, photo: photo(d) });
  assert.equal(s.trips[0].photo, photo(d));
  assert.throws(() => run(s, d, "trip-update", { id, photo: photo(d, "f") }), /already has a photo/);
  assert.equal(s.events[0].action, "Trip photo added");
});

test("only the driver who logged a trip can add to it, and only at their site", () => {
  const d1 = driver(1),
    d2 = driver(2),
    other = driver(3, "site-b");
  const s = run(createDraft(), d1, "trip", { driver: "Sample Driver", pickupAt: "2026-10-01T08:00" });
  const id = s.trips[0].id;
  assert.throws(
    () => run(s, d2, "trip-update", { id, arriveAt: "2026-10-01T09:00" }),
    /Only the driver who logged/,
  );
  assert.throws(
    () => run(s, other, "trip-update", { id, arriveAt: "2026-10-01T09:00" }),
    /another site/,
  );
});

test("trip times and photos are validated", () => {
  const d = driver();
  const s = createDraft();
  assert.throws(() => run(s, d, "trip", { pickupAt: "2026-10-01T08:00" }), /complete driver/);
  assert.throws(
    () => run(s, d, "trip", { driver: "x".repeat(101), pickupAt: "2026-10-01T08:00" }),
    /shorter driver/,
  );
  assert.throws(() => run(s, d, "trip", { driver: "D" }), /pickupAt/);
  assert.throws(() => run(s, d, "trip", { driver: "D", pickupAt: "yesterday" }), /Malaysia time/);
  assert.throws(() => run(s, d, "trip", { driver: "D", pickupAt: "2999-01-01T08:00" }), /future/);
  assert.throws(
    () => run(s, d, "trip", { driver: "D", pickupAt: "2026-10-01T08:00", arriveAt: "2026-10-01T07:00" }),
    /before the pickup/,
  );
  assert.throws(
    () => run(s, d, "trip", { driver: "D", pickupAt: "2026-10-01T08:00", photo: "../secret.jpg" }),
    /not uploaded/,
  );
  assert.throws(
    () => run(s, d, "trip", { driver: "D", pickupAt: "2026-10-01T08:00", assistant: "x".repeat(101) }),
    /shorter assistant/,
  );
});

test("packers and supervisors cannot log trips; the preview driver can", () => {
  for (const role of ["packer", "production", "outbound", "management"])
    assert.throws(
      () =>
        applyCommand(createDraft(), {
          type: "trip",
          role,
          input: { driver: "Sample Driver", pickupAt: "2026-10-01T08:00" },
          actor: { kind: "member", role, name: role, userId: "u-" + role, siteId: "site-a" },
          capabilities: effectiveCapabilities(role),
        }),
      /does not permit/,
    );
  const s = applyCommand(createDraft(), {
    type: "trip",
    role: "driver",
    input: { driver: "Sample Driver", pickupAt: "2026-10-01T08:00", assistant: "Sample Assistant" },
  });
  assert.equal(s.trips[0].driver, "Sample Driver");
  assert.equal(s.trips[0].recordedBy.name, "Driver (test view)");
});

test("drivers share one sign-in: each trip keeps its typed driver, the account stays the recorder", () => {
  const shared = driver();
  let s = run(createDraft(), shared, "trip", { driver: "Sample Driver Ali", pickupAt: "2026-10-01T08:00" });
  s = run(s, shared, "trip", { driver: "Sample Driver Abu", assistant: "Sample Assistant", pickupAt: "2026-10-01T09:00" });
  assert.deepEqual(s.trips.map((t) => t.driver), ["Sample Driver Abu", "Sample Driver Ali"]);
  assert.ok(s.trips.every((t) => t.recordedBy.userId === shared.userId));
  // Any driver on the shared sign-in can add the missing arrival to a trip it logged.
  s = run(s, shared, "trip-update", { id: s.trips[1].id, arriveAt: "2026-10-01T08:45" });
  assert.equal(s.events[0].performer, "Sample Driver Ali");
});
