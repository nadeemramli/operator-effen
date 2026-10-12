// Team profiles: the preset names offered wherever a person responsible (PIC) is recorded.
// Each supervisor manages their own team's list (HR manages all); records keep the name.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  createDraft,
  packerProfiles,
  people,
  profileManagers,
  teamProfiles,
} from "../apps/web/src/lib/draft.ts";
import {
  effectiveCapabilities,
  outOfScopeKeys,
} from "../apps/web/src/lib/access.ts";

const member = (role, n = 1) => ({
  kind: "member",
  role,
  name: "Synthetic " + role,
  userId: `00000000-0000-4000-8000-00000000004${n}`,
  siteId: "site-a",
});
const PROD = member("production"),
  INTAKE = member("intake", 2),
  OUT = member("outbound", 3),
  HR = member("hr", 4);
const ids = Array.from(
  { length: 6 },
  (_, i) => `30000000-0000-4000-8000-0000000000b${i}`,
);
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
// An operational site starts with no profiles at all.
const site = () => ({ ...createDraft(), staffProfiles: undefined });

test("an operational workspace offers no sample names: presets come from team profiles", () => {
  let s = site();
  assert.deepEqual(teamProfiles(s), []);
  s = run(s, PROD, "staff-profile-create", {
    profileId: ids[0],
    name: "Synthetic Faris",
    role: "production",
  });
  s = run(s, INTAKE, "staff-profile-create", {
    profileId: ids[1],
    name: "Synthetic Mei",
    role: "intake",
  });
  s = run(s, OUT, "staff-profile-create", {
    profileId: ids[2],
    name: "Synthetic Raj",
    role: "outbound",
  });
  assert.deepEqual(
    teamProfiles(s).map((p) => p.name),
    ["Synthetic Faris", "Synthetic Mei", "Synthetic Raj"],
  );
  assert.deepEqual(
    teamProfiles(s, "production").map((p) => p.name),
    ["Synthetic Faris"],
  );
  assert.deepEqual(
    teamProfiles(s, "intake").map((p) => p.role),
    ["intake"],
  );
  for (const name of teamProfiles(s).map((p) => p.name))
    assert.ok(!people.includes(name));
  // Team profiles never become packers and packer profiles never become PIC presets.
  assert.deepEqual(packerProfiles(s), []);
  s = run(s, OUT, "staff-profile-create", {
    profileId: ids[3],
    name: "Synthetic Ali",
  });
  assert.deepEqual(
    packerProfiles(s).map((p) => p.name),
    ["Synthetic Ali"],
  );
  assert.equal(teamProfiles(s).length, 3);
  const added = s.events.find((e) => e.entity === "staff:" + ids[0]);
  assert.equal(added.action, "Team profile added");
  assert.match(added.detail, /Synthetic Faris · Production supervisor/);
  assert.equal(
    s.staffProfiles.find((p) => p.id === ids[0]).createdBy.userId,
    PROD.userId,
  );
});

test("each supervisor manages their own team; HR manages every team; others are refused", () => {
  const s = site();
  const input = (role) => ({ profileId: ids[0], name: "Synthetic X", role });
  assert.deepEqual(profileManagers("production"), ["production", "hr"]);
  assert.deepEqual(profileManagers("packer"), ["outbound", "hr"]);
  for (const role of ["production", "intake", "outbound"]) {
    assert.ok(
      run(s, HR, "staff-profile-create", input(role)).staffProfiles.length,
    );
    assert.ok(
      run(s, member(role), "staff-profile-create", input(role)).staffProfiles
        .length,
    );
    for (const other of ["production", "intake", "outbound"].filter(
      (r) => r !== role,
    ))
      assert.throws(
        () => run(s, member(other), "staff-profile-create", input(role)),
        /responsible supervisor/,
      );
  }
  for (const role of ["packer", "driver", "admin", "management"])
    assert.throws(
      () => run(s, member(role), "staff-profile-create", input("production")),
      /does not permit/,
    );
  assert.throws(
    () => run(s, HR, "staff-profile-create", input("driver")),
    /packer, production, stock-in or stock-out/,
  );
  assert.throws(
    () => run(s, HR, "staff-profile-create", input("hr")),
    /packer, production, stock-in or stock-out/,
  );
});

test("team names are unique across teams while active; renames keep earlier records as saved", () => {
  let s = site();
  s = run(s, PROD, "staff-profile-create", {
    profileId: ids[0],
    name: "Synthetic Faris",
    role: "production",
  });
  assert.throws(
    () =>
      run(s, INTAKE, "staff-profile-create", {
        profileId: ids[1],
        name: "synthetic faris",
        role: "intake",
      }),
    /teammate already has this name/,
  );
  // The same name may be a packer: packers are a separate list, referenced by ID.
  s = run(s, OUT, "staff-profile-create", {
    profileId: ids[2],
    name: "Synthetic Faris",
  });
  // A record stores the preset name itself.
  s = run(s, PROD, "transfer", {
    id: "b-cav",
    qty: 10,
    pic: "Synthetic Faris",
  });
  const sent = s.events[0];
  assert.match(sent.detail, /sent · Synthetic Faris/);
  s = run(s, PROD, "staff-profile-update", {
    id: ids[0],
    name: "Synthetic Faris B",
  });
  assert.equal(s.events.find((e) => e.id === sent.id).detail, sent.detail);
  assert.deepEqual(
    teamProfiles(s, "production").map((p) => p.name),
    ["Synthetic Faris B"],
  );
  assert.equal(s.events[0].action, "Team profile updated");
  assert.match(s.events[0].detail, /Synthetic Faris → Synthetic Faris B/);
  // Only the owning team (or HR) renames or deactivates it.
  assert.throws(
    () => run(s, INTAKE, "staff-profile-update", { id: ids[0], active: false }),
    /responsible supervisor/,
  );
  s = run(s, HR, "staff-profile-update", { id: ids[0], active: false });
  assert.deepEqual(teamProfiles(s), []);
  assert.equal(s.staffProfiles.find((p) => p.id === ids[0]).active, false);
  // While inactive the name is free; reactivating into a clash is refused.
  s = run(s, INTAKE, "staff-profile-create", {
    profileId: ids[1],
    name: "Synthetic Faris B",
    role: "intake",
  });
  assert.throws(
    () => run(s, PROD, "staff-profile-update", { id: ids[0], active: true }),
    /Rename one of them first/,
  );
  s = run(s, INTAKE, "staff-profile-update", { id: ids[1], active: false });
  s = run(s, PROD, "staff-profile-update", { id: ids[0], active: true });
  assert.deepEqual(
    teamProfiles(s).map((p) => p.id),
    [ids[0]],
  );
});

test("packer rules are unchanged: outbound or HR only, unique among active packers", () => {
  let s = site();
  s = run(s, OUT, "staff-profile-create", {
    profileId: ids[0],
    name: "Synthetic Ali",
  });
  assert.throws(
    () =>
      run(s, PROD, "staff-profile-create", {
        profileId: ids[1],
        name: "Other",
      }),
    /responsible supervisor/,
  );
  assert.throws(
    () =>
      run(s, OUT, "staff-profile-create", {
        profileId: ids[1],
        name: "synthetic ali",
        role: "packer",
      }),
    /active packer already has this name/,
  );
  assert.throws(
    () => run(s, PROD, "staff-profile-update", { id: ids[0], active: false }),
    /responsible supervisor/,
  );
  assert.equal(s.events[0].action, "Packer profile added");
});
