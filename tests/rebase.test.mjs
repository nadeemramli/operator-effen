// WP9: a save that lost the race is re-applied on the latest records instead of failing.
// The store below behaves like the conditional commit (update … where revision = expected):
// it commits only when the revision the attempt loaded is still current.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  ConflictError,
  createDraft,
  findOperation,
  recordOperation,
  stageStep,
} from "../apps/web/src/lib/draft.ts";
import { fingerprint } from "../apps/web/src/lib/access.ts";
import { MAX_REBASE_ATTEMPTS, rebaseLoop } from "../apps/web/src/lib/rebase.ts";

const member = (role) => ({
  kind: "member",
  role,
  name: "Synthetic " + role,
  userId: "u-" + role,
  siteId: "site-a",
});

function store(state) {
  const db = { state: structuredClone(state), revision: 0, loads: 0, commits: 0 };
  // `meddle` runs between this writer's load and its commit: another person saving.
  db.save = (role, type, input, operationId, meddle = () => {}) =>
    rebaseLoop(
      async () => {
        const loaded = { state: structuredClone(db.state), revision: db.revision };
        db.loads++;
        const prior = findOperation(loaded.state, operationId);
        if (prior)
          return {
            done:
              prior.fingerprint === fingerprint(type, input)
                ? { ok: true, replayed: true, revision: loaded.revision }
                : { ok: false, code: "operation-mismatch" },
          };
        let next;
        try {
          next = applyCommand(loaded.state, { type, role, input, actor: member(role) });
          recordOperation(next, {
            id: operationId,
            type,
            fingerprint: fingerprint(type, input),
            userId: member(role).userId,
            at: new Date().toISOString(),
          });
        } catch (e) {
          return {
            done: {
              ok: false,
              code: e instanceof ConflictError ? "record" : "domain",
              error: e.message,
            },
          };
        }
        meddle();
        if (db.revision !== loaded.revision) return { stale: true };
        db.state = next;
        db.revision++;
        db.commits++;
        return { done: { ok: true, revision: db.revision } };
      },
      () => ({ ok: false, code: "revision" }),
    );
  return db;
}

const sachetBatch = () =>
  applyCommand(createDraft(), {
    type: "batch",
    role: "production",
    input: { product: "ady", code: "REB-1", date: "2026-10-01", route: "sachet-v2" },
    actor: member("production"),
  });

test("a second writer whose loaded revision went stale is rebased and both changes survive", async () => {
  const db = store(sachetBatch());
  const id = db.state.batches[0].id;
  // Writer B loads, then writer A saves an unrelated stage before B commits.
  const result = await db.save(
    "intake",
    "machine",
    { id, stage: "filling", pic: "Operator F" },
    "op-b",
    (() => {
      let once = false;
      return () => {
        if (once) return;
        once = true;
        db.state = applyCommand(db.state, {
          type: "machine",
          role: "production",
          input: { id, stage: "mixing", pic: "Operator M" },
          actor: member("production"),
        });
        db.revision++;
      };
    })(),
  );
  assert.equal(result.ok, true);
  assert.equal(db.revision, 2);
  assert.equal(db.loads, 2, "one stale attempt, one rebased attempt");
  const b = db.state.batches[0];
  assert.equal(stageStep(b, "mixing").pic, "Operator M");
  assert.equal(stageStep(b, "filling").pic, "Operator F");
});

test("a stale expectedVersion is still a record conflict after rebasing", async () => {
  const db = store(sachetBatch());
  const id = db.state.batches[0].id;
  await db.save("production", "machine", { id, stage: "hologram", pic: "Operator H" }, "op-1");
  const opened = stageStep(db.state.batches[0], "hologram").version;
  await db.save(
    "production",
    "change-step-pic",
    { id, stage: "hologram", kind: "correction", pic: "Operator H2", reason: "Wrong profile", expectedVersion: opened },
    "op-2",
  );
  const result = await db.save(
    "intake",
    "change-step-pic",
    { id, stage: "hologram", kind: "correction", pic: "Operator H3", reason: "Mine", expectedVersion: opened },
    "op-3",
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "record");
  assert.equal(stageStep(db.state.batches[0], "hologram").pic, "Operator H2");
});

test("the same operation ID replays inside the loop instead of saving twice", async () => {
  const db = store(sachetBatch());
  const id = db.state.batches[0].id;
  const input = { id, stage: "mixing", pic: "Operator M" };
  assert.equal((await db.save("production", "machine", input, "op-same")).ok, true);
  const again = await db.save("production", "machine", input, "op-same");
  assert.equal(again.replayed, true);
  assert.equal(db.commits, 1);
  const other = await db.save("production", "machine", { ...input, pic: "X" }, "op-same");
  assert.equal(other.code, "operation-mismatch");
});

test("after the attempt limit the save reports a revision conflict and changes nothing", async () => {
  const db = store(sachetBatch());
  const id = db.state.batches[0].id;
  const before = structuredClone(db.state);
  let meddled = 0;
  const result = await db.save("production", "machine", { id, stage: "mixing", pic: "M" }, "op-x", () => {
    meddled++;
    db.revision++;
  });
  assert.deepEqual(result, { ok: false, code: "revision" });
  assert.equal(meddled, MAX_REBASE_ATTEMPTS);
  assert.deepEqual(db.state, before);
});
