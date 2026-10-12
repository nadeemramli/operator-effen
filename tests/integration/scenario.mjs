// Integration scenarios for OPER-2/4/5 against real Supabase components (GoTrue, PostgREST,
// Storage API, Postgres) and the production Next.js build, driven through Chromium.
// Synthetic users, sites and PDFs only. Usage (see run-real-stack.sh):
//   node scenario.mjs <appUrl> <supabaseUrl> <anonKey> <serviceKey> <pgPort> <playwrightModule>
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { parsePages } from "../../apps/web/src/lib/awb-import.ts";

const [, , app, supabase, anonKey, serviceKey, pgPort, pwPath] = process.argv;
const { chromium } = createRequire(import.meta.url)(pwPath);
const sql = (q) =>
  execFileSync("psql", ["-h", "127.0.0.1", "-p", pgPort, "-U", "postgres", "-At", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", q])
    .toString()
    .trim();
// Another database session running `q` (one transaction) while the test goes on.
const sqlSession = (q) =>
  new Promise((resolve, reject) => {
    const p = spawn("psql", ["-h", "127.0.0.1", "-p", pgPort, "-U", "postgres", "-At", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", q]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
    console.log("PASS", name);
  } catch (e) {
    results.push(["FAIL", name]);
    console.log("FAIL", name, "\n   ", String(e.message).split("\n").slice(0, 8).join("\n    "));
  }
}
const W = { a: "10000000-0000-4000-8000-0000000000aa", b: "10000000-0000-4000-8000-0000000000bb" };
const password = "synthetic-only-password-1";
const people = {
  prodA: { role: "production", ws: W.a, name: "Synthetic Production SV A" },
  intakeA: { role: "intake", ws: W.a, name: "Synthetic Stock-in SV A" },
  outA: { role: "outbound", ws: W.a, name: "Synthetic Stock-out SV A" },
  packerA: { role: "packer", ws: W.a, name: "Synthetic Packer A" },
  driverA: { role: "driver", ws: W.a, name: "Synthetic Drivers A" },
  prodB: { role: "production", ws: W.b, name: "Synthetic Production SV B" },
  outB: { role: "outbound", ws: W.b, name: "Synthetic Stock-out SV B" },
  mgmt: { role: "management", scope: "all-sites", name: "Synthetic Manager" },
  admin: { role: "admin", scope: "all-sites", name: "Synthetic Office Admin" },
  hr: { role: "hr", scope: "all-sites", name: "Synthetic HR" },
  newHire: { name: "Synthetic New Hire" },
  outsider: { name: "Synthetic Outsider" },
  preview: { preview: true, name: "Preview tester" },
};
const email = (key) => key.toLowerCase() + "@synthetic.test";

// --- Seed: real GoTrue users (admin API), sites and memberships (administrator SQL). ---
for (const [key, p] of Object.entries(people)) {
  const res = await fetch(supabase + "/auth/v1/admin/users", {
    method: "POST",
    headers: { apikey: serviceKey, authorization: "Bearer " + serviceKey, "content-type": "application/json" },
    body: JSON.stringify({
      email: email(key),
      password,
      email_confirm: true,
      app_metadata: p.preview ? { ui_draft_access: true } : {},
    }),
  });
  const body = await res.json();
  assert.ok(res.ok, JSON.stringify(body));
  p.id = body.id;
}
sql(`insert into public.operator_workspaces (id, site_id, name) values ('${W.a}','site-a','Synthetic Site A'),('${W.b}','site-b','Synthetic Site B')`);
for (const p of Object.values(people))
  if (p.role)
    sql(`insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope) values (${p.ws ? `'${p.ws}'` : "null"}, '${p.id}', '${p.role}', '${p.name}', '${p.scope ?? "site"}')`);

// PW_CHROMIUM points at a system Chromium (the cloud container keeps one at
// /opt/pw-browsers/chromium); otherwise Playwright's own installed browser is used.
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
async function session(key) {
  const context = await browser.newContext({ baseURL: app, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await login(page, key);
  return { context, page, key };
}
async function login(page, key) {
  await page.goto("/login");
  await page.locator("#username").fill(email(key));
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /Enter workspace/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.getByText(/Workspace|Ruang kerja/).first().waitFor();
}
const api = (s, method, body, query = "") =>
  s.page.evaluate(
    async ([method, body, query]) => {
      const res = await fetch("/api/draft" + query, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: res.status,
        body: await res.json().catch(() => null),
        attempts: res.headers.get("x-operator-attempts"),
      };
    },
    [method, body, query],
  );
const load = async (s, ws) => (await api(s, "GET", null, ws ? "?workspace=" + ws : "")).body;
async function post(s, type, input, extra = {}) {
  const current = await load(s, extra.ws);
  return api(s, "POST", {
    command: { type, role: extra.role ?? "production", input },
    revision: extra.revision ?? current.revision,
    operationId: extra.operationId ?? randomUUID(),
    workspaceId: extra.ws ?? current.actor?.workspaceId,
  });
}
const stored = (ws) => JSON.parse(sql(`select state::text from public.operator_workspaces where id='${ws}'`));
const revision = (ws) => Number(sql(`select revision from public.operator_workspaces where id='${ws}'`));
async function token(key) {
  const res = await fetch(supabase + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify({ email: email(key), password }),
  });
  return (await res.json()).access_token;
}
const rest = (path, jwt, init = {}) =>
  fetch(supabase + "/rest/v1/" + path, {
    ...init,
    headers: { apikey: anonKey, authorization: "Bearer " + jwt, "content-type": "application/json", ...(init.headers ?? {}) },
  });
const files = (s, method, query, body) =>
  s.page.evaluate(
    async ([method, query, body]) => {
      const res = await fetch("/api/awb-files" + query, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [method, query, body],
  );
// PDF uploads (operator_imports, since 20261012090000): GET/POST /api/imports[/<id>[/receive]].
const imports = (s, method, path, body) =>
  s.page.evaluate(
    async ([method, path, body]) => {
      const res = await fetch("/api/imports" + path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [method, path, body],
  );
// Audit entries of operational sites (operator_events, since 20261013090000): GET /api/events.
const eventsApi = (s, query) =>
  s.page.evaluate(async (query) => {
    const res = await fetch("/api/events" + query, { cache: "no-store" });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, query);

const prod = await session("prodA");
const intake = await session("intakeA");
let batchId;

// ===================== Objective A: authoritative write boundary =====================
await check("A: member identity, role and site come from the server; no preview switcher", async () => {
  const data = await load(prod);
  assert.equal(data.actor.kind, "member");
  assert.equal(data.actor.role, "production");
  assert.equal(data.actor.siteId, "site-a");
  assert.ok(data.actor.capabilities.includes("production.plan"));
  assert.equal(await prod.page.locator("#role-switch").count(), 0);
});

await check("A: plan a five-stage batch in the UI; route order shows Hologram 4th", async () => {
  await prod.page.goto("/?view=production&production=plan&factory=sachet");
  await prod.page.locator("#plan-product").selectOption("ady");
  await prod.page.locator("#plan-code").fill("INT-ADY-001");
  await prod.page.locator("#plan-date").fill("2026-10-03");
  await prod.page.getByRole("button", { name: /Save batch plan/ }).click();
  await prod.page.getByText("INT-ADY-001").first().waitFor();
  const batch = stored(W.a).batches.find((b) => b.code === "INT-ADY-001");
  batchId = batch.id;
  assert.deepEqual(batch.route.stages, ["mixing", "filling", "batching", "hologram", "wrapping"]);
  // Production records the two factory stages; the other three are listed, in route order,
  // as recorded at stock-in.
  const card = prod.page.locator("section.batch-card", { hasText: "INT-ADY-001" });
  const rows = await card.locator("table.machine-records tbody tr td:first-child").allInnerTexts();
  assert.match(rows.join("|"), /^1\. Mixer.*\|2\. Sachet filling[^|]*$/s);
  const later = await card.locator(".warehouse-stage-list li > span:first-child").allInnerTexts();
  assert.deepEqual(later.map((x) => x.split(" ")[0]), ["Inkjet", "Hologram", "Shrink"]);
});

await check("A: supervisor's direct RPC with a replacement state is refused by the database", async () => {
  const jwt = await token("prodA");
  const before = revision(W.a);
  const forged = stored(W.a);
  forged.batches.find((b) => b.id === batchId).transferredAt = "2026-10-04T00:00:00Z";
  forged.events = [{ id: "x", actor: "Someone else", detail: "rewritten", recorder: { userId: "forged" } }];
  const unsigned = await rest("rpc/operator_commit_workspace", jwt, {
    method: "POST",
    body: JSON.stringify({
      p_workspace: W.a, p_expected_revision: before, p_command: "transfer", p_operation: randomUUID(),
      p_fingerprint: "a".repeat(64), p_state: JSON.stringify(forged), p_attestation: "b".repeat(64),
    }),
  });
  assert.equal(unsigned.status, 403, await unsigned.text());
  const legacy = await rest("rpc/operator_commit_workspace", jwt, {
    method: "POST",
    body: JSON.stringify({ p_workspace: W.a, p_expected_revision: before, p_state: forged }),
  });
  assert.equal(legacy.status, 404, "old replacement-state signature must not exist");
  for (const [path, init] of [
    [`operator_workspaces?id=eq.${W.a}`, { method: "PATCH", body: JSON.stringify({ revision: 999 }) }],
    ["operator_commits", { method: "POST", body: JSON.stringify({ workspace_id: W.a, operation_id: randomUUID(), user_id: people.prodA.id, role: "production", command: "batch", fingerprint: "a".repeat(64), result_revision: 9 }) }],
    [`operator_memberships?user_id=eq.${people.prodA.id}`, { method: "PATCH", body: JSON.stringify({ role: "hr" }) }],
    ["operator_membership_audit", { method: "POST", body: JSON.stringify({ action: "grant", actor_user: people.prodA.id, actor_role: "hr", reason: "forged" }) }],
  ]) {
    const res = await rest(path, jwt, init);
    assert.ok(!res.ok || (await res.text()) === "[]", `${init.method} ${path} -> ${res.status}`);
  }
  assert.equal(revision(W.a), before);
  assert.equal(sql(`select role from public.operator_memberships where user_id='${people.prodA.id}'`), "production");
  assert.equal(stored(W.a).batches.find((b) => b.id === batchId).transferredAt, undefined);
});

await check("A: machines added by production are shared with stock-in", async () => {
  for (const [stage, name] of [["hologram", "INT Holo Alpha"], ["hologram", "INT Holo Beta"], ["mixing", "INT Mixer"]]) {
    const r = await post(prod, "machine-create", { stage, name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  await intake.page.goto("/?view=warehouse");
  // The machine list sits behind the gear button on the Stock-in page.
  await intake.page.getByRole("button", { name: "Sachet machines" }).click();
  await intake.page.getByText("INT Holo Alpha").first().waitFor();
});

await check("A: invalid stock, route and correction operations are rejected without side effects", async () => {
  const machines = stored(W.a).machines;
  // Transfer needs the factory stages (mixing, filling); with only mixing it is refused.
  for (const stage of ["mixing"]) {
    const r = await post(prod, "machine", {
      id: batchId, stage, pic: "Sample PIC A", expectedVersion: 0,
      ...(stage === "mixing" ? { machineId: machines.find((m) => m.name === "INT Mixer").id } : {}),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const before = revision(W.a);
  const cases = [
    [prod, "transfer", { id: batchId, pic: "Sample PIC B" }, /mixing and filling stages/, "production"],
    [prod, "machine", { id: batchId, stage: "laminating", pic: "X" }, /Unknown production stage/, "production"],
    [prod, "stage-correct", { id: batchId, stage: "mixing", field: "machine", machineId: machines[0].id, reason: "x" }, /Reopen/, "production"],
    [prod, "change-step-pic", { id: batchId, stage: "mixing", kind: "correction", pic: "Sample PIC B" }, /reason/, "production"],
    [intake, "adjust", { id: "missing-count", reason: "x" }, /could not be found/, "intake"],
  ];
  for (const [s, type, input, message, role] of cases) {
    const r = await post(s, type, input, { role });
    assert.equal(r.status, 400, type + " " + JSON.stringify(r.body));
    assert.match(r.body.error, message);
  }
  assert.equal(revision(W.a), before);
  const card = prod.page.locator("section.batch-card", { hasText: "INT-ADY-001" });
  await prod.page.goto("/?view=production&production=log&date=2026-10-03");
  assert.equal(await card.getByRole("button", { name: /Send to warehouse/ }).isDisabled(), true);
  for (const stage of ["filling", "batching", "wrapping"]) {
    const r = await post(prod, "machine", { id: batchId, stage, pic: "Sample PIC A", expectedVersion: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  // The production card shows the factory stages; the rest are listed as recorded at stock-in.
  await prod.page.reload();
  await card.getByText("Recorded at stock-in").waitFor();
  assert.equal(await card.getByRole("button", { name: /Send to warehouse/ }).isDisabled(), false);
});

await check("A: stock-in records Hologram through the UI person picker (visible card click)", async () => {
  await intake.page.goto("/?view=warehouse");
  const record = intake.page.locator("details.sachet-record", { hasText: "INT-ADY-001" });
  await record.locator("summary").first().click();
  await record.locator("tr", { hasText: "Hologram machine" }).getByRole("button", { name: /Record completion/ }).click();
  const dialog = intake.page.getByRole("dialog");
  await dialog.locator('select[name="machineId"]').selectOption({ label: "INT Holo Alpha" });
  await dialog.locator('input[name="occurredAt"]').fill("2026-10-03T10:30");
  // A plain click on the visible card, then the accessible radio itself.
  await dialog.locator("label.pic-option", { hasText: "Sample PIC B" }).click();
  assert.equal(await dialog.getByRole("radio", { name: /Sample PIC B/ }).isChecked(), true);
  const person = dialog.getByRole("radio", { name: /Sample PIC C/ });
  await person.check();
  assert.equal(await person.isChecked(), true);
  assert.equal(await dialog.getByRole("radio", { name: /Sample PIC B/ }).isChecked(), false);
  await dialog.getByRole("button", { name: /Save record/ }).click();
  await dialog.waitFor({ state: "hidden" });
  const holo = stored(W.a).batches.find((b) => b.id === batchId).steps.find((s) => s.sachetStage === "hologram");
  assert.equal(holo.pic, "Sample PIC C");
  assert.equal(holo.machineName, "INT Holo Alpha");
  assert.equal(holo.recordedBy.userId, people.intakeA.id);
  assert.equal(holo.occurredAt, "2026-10-03T02:30:00.000Z");
  const commit = sql(`select role || ':' || command from public.operator_commits where user_id='${people.intakeA.id}' order by committed_at desc limit 1`);
  assert.equal(commit, "intake:machine");
  await prod.page.reload();
  const card = prod.page.locator("section.batch-card", { hasText: "INT-ADY-001" });
  await card.locator(".warehouse-stage-list").getByText("Sample PIC C").waitFor();
  assert.equal(await card.getByRole("button", { name: /Send to warehouse/ }).isDisabled(), false);
});

await check("A: transfer succeeds once mixing and filling have PICs", async () => {
  const t = await post(prod, "transfer", { id: batchId, pic: "Sample PIC B" });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.ok(stored(W.a).batches.find((b) => b.id === batchId).transferredAt);
});

await check("A: response-loss retry applies once; reused ID with different input is rejected", async () => {
  const operationId = randomUUID();
  const before = await load(intake);
  const input = { batchId, pic: "Sample PIC C" };
  const send = (inp, rev) => api(intake, "POST", { command: { type: "receive-ady", role: "intake", input: inp }, revision: rev, operationId, workspaceId: W.a });
  const first = await send(input, before.revision);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const retry = await send(input, before.revision);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(stored(W.a).adypocideReceipts.filter((r) => r.batchId === batchId).length, 1);
  assert.equal(sql(`select count(*) from public.operator_commits where operation_id='${operationId}'`), "1");
  const reused = await send({ ...input, pic: "Other" }, retry.body.revision);
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, "operation-mismatch");
});

// Saves of different records no longer conflict (the server re-applies a save that lost the
// race); two edits of the same record still do.
await check("A: concurrent edits of the same record — one wins, the other gets a reviewable conflict", async () => {
  const holo = stored(W.a).batches.find((b) => b.id === batchId).steps.find((s) => s.sachetStage === "hologram");
  const beta = stored(W.a).machines.find((m) => m.name === "INT Holo Beta").id;
  const rev = revision(W.a);
  const [a, b] = await Promise.all([
    api(prod, "POST", { command: { type: "change-step-pic", role: "production", input: { id: batchId, stage: "hologram", kind: "correction", pic: "Sample PIC D", reason: "Wrong profile", expectedVersion: holo.version } }, revision: rev, operationId: randomUUID(), workspaceId: W.a }),
    api(intake, "POST", { command: { type: "stage-correct", role: "intake", input: { id: batchId, stage: "hologram", field: "machine", machineId: beta, reason: "Line log", expectedVersion: holo.version } }, revision: rev, operationId: randomUUID(), workspaceId: W.a }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
  assert.equal(revision(W.a), rev + 1);
  const loser = a.status === 409 ? intake : prod;
  const retry = loser === intake
    ? await post(intake, "stage-correct", { id: batchId, stage: "hologram", field: "machine", machineId: beta, reason: "Line log", expectedVersion: holo.version }, { role: "intake" })
    : await post(prod, "change-step-pic", { id: batchId, stage: "hologram", kind: "correction", pic: "Sample PIC D", reason: "Wrong profile", expectedVersion: holo.version });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, "record");
  assert.equal(retry.body.conflict.currentVersion, holo.version + 1);
});

await check("A: an unrelated save after a teammate's save succeeds without a refresh", async () => {
  const seen = await load(intake);
  const a = await post(prod, "feedback", { text: "Saved first by production" });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  // Stock-in still holds the revision it loaded before production saved.
  const b = await api(intake, "POST", { command: { type: "feedback", role: "intake", input: { text: "Saved second without refreshing" } }, revision: seen.revision, operationId: randomUUID(), workspaceId: W.a });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.revision, seen.revision + 2);
  const texts = stored(W.a).notes.map((n) => n.text);
  assert.ok(texts.includes("Saved first by production") && texts.includes("Saved second without refreshing"));
});

// Factory-stage corrections after transfer are revisions; warehouse-stage records before the
// box count are the normal stock-in flow and are not (see the INT-ADY-002 case).
await check("A: post-transfer correction of a factory stage keeps stock/custody facts and flags the revision", async () => {
  const before = stored(W.a);
  const mixing = before.batches.find((b) => b.id === batchId).steps.find((s) => s.sachetStage === "mixing");
  const r = await post(intake, "stage-correct", { id: batchId, stage: "mixing", field: "occurredAt", occurredAt: "2026-10-03T09:00", reason: "Line log shows the actual mixing time", expectedVersion: mixing.version }, { role: "intake" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = stored(W.a);
  assert.deepEqual([after.cartons, after.adypocideReceipts, after.issues, after.adjustments], [before.cartons, before.adypocideReceipts, before.issues, before.adjustments]);
  const b0 = before.batches.find((b) => b.id === batchId), b1 = after.batches.find((b) => b.id === batchId);
  assert.equal(b1.transferredAt, b0.transferredAt);
  assert.equal(b1.revisions.at(-1).recordedBy.userId, people.intakeA.id);
  await prod.page.goto(`/?view=production&production=history&batch=${batchId}`);
  await prod.page.reload();
  await prod.page.getByText(/Revised after transfer/).first().waitFor();
});

await check("A: packer cannot write through the API or the database", async () => {
  const packer = await session("packerA");
  const before = revision(W.a);
  for (const type of ["pack", "machine", "batch", "adjust"]) {
    const r = await post(packer, type, { id: batchId, stage: "mixing", pic: "x" }, { role: "outbound" });
    assert.equal(r.status, 403, type + " " + JSON.stringify(r.body));
  }
  const jwt = await token("packerA");
  const rpc = await rest("rpc/operator_commit_workspace", jwt, {
    method: "POST",
    body: JSON.stringify({ p_workspace: W.a, p_expected_revision: before, p_command: "machine", p_operation: randomUUID(), p_fingerprint: "a".repeat(64), p_state: "{}", p_attestation: "c".repeat(64) }),
  });
  assert.equal(rpc.status, 403);
  assert.equal(revision(W.a), before);
  await packer.page.goto("/?view=packing");
  await packer.page.getByText(/Who is packing\?/).first().waitFor();
  await packer.context.close();
});

await check("A: another site's supervisor cannot read or write site A", async () => {
  const other = await session("prodB");
  const data = await load(other);
  assert.equal(data.actor.siteId, "site-b");
  assert.equal(data.state.batches.some((b) => b.id === batchId), false);
  assert.equal((await api(other, "GET", null, "?workspace=" + W.a)).status, 403);
  const r = await api(other, "POST", { command: { type: "machine", role: "production", input: { id: batchId, stage: "mixing", pic: "x" } }, revision: data.revision, workspaceId: W.a });
  assert.equal(r.status, 403);
  await other.context.close();
});

await check("A: legacy four-stage batches — history readable, in-progress needs explicit review", async () => {
  const state = stored(W.a);
  const step = (stage, machine) => ({ sachetStage: stage, machine, pic: "Legacy PIC", qty: null, start: "", end: "", done: true, qc: "not-recorded" });
  const steps = [["mixing", "Mixer machine"], ["filling", "Sachet filling machine"], ["batching", "Inkjet printer"], ["wrapping", "Shrink machine"]].map(([a, b]) => step(a, b));
  state.batches.push(
    { id: "legacy-sent", code: "LEGACY-SENT", product: "ady", date: "2026-09-20", target: 0, actual: 0, sent: 0, transferredAt: "2026-09-20T05:00:00Z", transferPic: "Old", steps },
    { id: "legacy-open", code: "LEGACY-OPEN", product: "ady", date: "2026-10-03", target: 0, actual: 0, sent: 0, steps },
  );
  // Administrator data load standing in for pre-existing records.
  sql(`update public.operator_workspaces set state = $j$${JSON.stringify(state)}$j$::jsonb, revision = revision + 1 where id='${W.a}'`);
  const t = await post(prod, "transfer", { id: "legacy-open", pic: "x" });
  assert.equal(t.status, 400);
  assert.match(t.body.error, /Review its route/);
  await prod.page.goto("/?view=production&production=log&date=2026-10-03");
  const card = prod.page.locator("section.batch-card", { hasText: "LEGACY-OPEN" });
  await card.getByText("Route review needed").waitFor();
  await card.getByRole("button", { name: "Upgrade to five stages" }).click();
  const dialog = prod.page.getByRole("dialog");
  await dialog.locator('textarea[name="reason"]').fill("Hologram machine in use for this batch");
  await dialog.getByRole("button", { name: /Save record/ }).click();
  await dialog.waitFor({ state: "hidden" });
  const open = stored(W.a).batches.find((b) => b.id === "legacy-open");
  assert.equal(open.route.id, "sachet-v2");
  assert.equal(open.steps.find((s) => s.sachetStage === "hologram").done, false);
  await prod.page.goto("/?view=production&production=history&batch=legacy-sent");
  await prod.page.getByText(/Four-stage sachet route/).waitFor();
  assert.equal(stored(W.a).batches.find((b) => b.id === "legacy-sent").route, undefined);
});

await check("A: warehouse stages are recorded at stock-in after transfer and gate the box count", async () => {
  const planned = await post(prod, "batch", { product: "ady", code: "INT-ADY-002", date: "2026-10-03", route: "sachet-v2" });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const id = stored(W.a).batches.find((b) => b.code === "INT-ADY-002").id;
  for (const stage of ["mixing", "filling"]) {
    const r = await post(prod, "machine", { id, stage, pic: "Sample PIC A", expectedVersion: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const sent = await post(prod, "transfer", { id, pic: "Sample PIC B" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const received = await post(intake, "receive-ady", { batchId: id, pic: "Sample PIC C" }, { role: "intake" });
  assert.equal(received.status, 200, JSON.stringify(received.body));
  const receiptId = stored(W.a).adypocideReceipts.find((r) => r.batchId === id).id;
  const early = await post(intake, "stock-in-ady", { receiptId, boxes: 5, rack: "R-1", pic: "Sample PIC C" }, { role: "intake" });
  assert.equal(early.status, 400, JSON.stringify(early.body));
  assert.match(early.body.error, /warehouse stages/);
  // The stock-in receipt row shows the open warehouse stages and keeps the box count disabled.
  await intake.page.goto("/?view=warehouse");
  const row = intake.page.locator("table.ady-receipts tr", { hasText: "INT-ADY-002" }).first();
  await row.getByText(/0\/3 warehouse stages/).waitFor();
  assert.equal(await row.getByRole("button", { name: /Finalize box count/ }).isDisabled(), true);
  for (const stage of ["batching", "hologram", "wrapping"]) {
    const r = await post(intake, "machine", { id, stage, pic: "Sample PIC C", expectedVersion: 0 }, { role: "intake" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const b = stored(W.a).batches.find((x) => x.id === id);
  assert.equal(b.revisions, undefined, "warehouse stages after transfer are not revisions");
  await intake.page.reload();
  await row.getByText(/3\/3 warehouse stages/).waitFor();
  assert.equal(await row.getByRole("button", { name: /Finalize box count/ }).isDisabled(), false);
});

// ============ Objective B: memberships, cross-site roles, files and policy ============
await check("B: management sees both sites, comments at site B, cannot adjust stock", async () => {
  const m = await session("mgmt");
  const data = await load(m);
  assert.deepEqual(data.workspaces.map((w) => w.name).sort(), ["Synthetic Site A", "Synthetic Site B"]);
  await m.page.locator("#site-switch").selectOption({ label: "Synthetic Site B" });
  await m.page.getByText(/Synthetic Manager · Management · Synthetic Site B/).first().waitFor();
  const review = await post(m, "review", { text: "Please confirm Monday's counts" }, { ws: W.b, role: "management" });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const note = stored(W.b).notes[0];
  assert.equal(note.author.userId, people.mgmt.id);
  assert.equal(note.siteId, "site-b");
  const adjust = await post(m, "adjust", { id: "x", reason: "x" }, { ws: W.a, role: "management" });
  assert.equal(adjust.status, 403);
  const correction = await post(m, "stage-correct", { id: batchId, stage: "mixing", field: "occurredAt", occurredAt: "2026-10-03T08:00", reason: "x", expectedVersion: 1 }, { ws: W.a, role: "management" });
  assert.equal(correction.status, 403);
  await m.context.close();
});

let sourcePath, sourceBytes, importId;
await check("B: office admin uploads a site source, saves its review in the tables and releases it", async () => {
  const a = await session("admin");
  sourceBytes = Buffer.from("%PDF-1.4\n% synthetic Operator integration fixture " + randomUUID() + "\n%%EOF\n");
  const hash = createHash("sha256").update(sourceBytes).digest("hex");
  const prep = await files(a, "POST", "", { hash, size: sourceBytes.length, workspace: W.a });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  assert.equal(prep.body.path, `${W.a}/${hash}.pdf`);
  const put = await a.page.evaluate(async ([url, bytes]) => {
    const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: new Uint8Array(bytes) });
    return res.status;
  }, [prep.body.url, [...sourceBytes]]);
  assert.equal(put, 200);
  sourcePath = prep.body.path;
  const again = await files(a, "POST", "", { hash, size: sourceBytes.length, workspace: W.a });
  assert.equal(again.body.exists, true);
  const fileRef = { id: hash, name: "synthetic.pdf", path: sourcePath, pages: 1, size: sourceBytes.length };
  const batch = {
    id: randomUUID(), name: "Synthetic integration", date: "2026-10-03", files: [fileRef],
    rows: parsePages([{ file: hash, page: 1, method: "text", text: "Ninja Van\nNVMYINT000001\nOrder: #INT-ORDER-1\nProducts:\n1x Cavernosil [cave04]" }], "Luxana", "INT STORE"),
    createdAt: "", updatedAt: "",
  };
  importId = batch.id;
  const rev = revision(W.a);
  const saved = await imports(a, "POST", "", { workspace: W.a, batch, expectedUpdatedAt: null });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.import.rows.length, 1);
  assert.equal(revision(W.a), rev, "saving a review does not touch the workspace document");
  assert.equal(sql(`select count(*) || ':' || min(created_by::text) from public.operator_imports where id='${batch.id}'`), `1:${people.admin.id}`);
  // A review opened before a teammate's save is refused with a reviewable conflict.
  const resaved = await imports(a, "POST", "", { workspace: W.a, batch: saved.body.import, expectedUpdatedAt: saved.body.import.updatedAt });
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body));
  const stale = await imports(a, "POST", "", { workspace: W.a, batch: saved.body.import, expectedUpdatedAt: saved.body.import.updatedAt });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "record");
  const listed = await imports(a, "GET", "?workspace=" + W.a);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.imports.find((x) => x.id === batch.id).counts, { rows: 1, released: 0 });
  const released = await post(a, "import-release", { id: batch.id }, { ws: W.a, role: "admin" });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const imported = stored(W.a).orders.find((o) => o.awb === "NVMYINT000001");
  assert.ok(imported);
  assert.equal(imported.importId, batch.id);
  // Audit entries live in operator_events (20261013090000), not in the document.
  assert.equal(sql(`select recorder ->> 'userId' from public.operator_events where workspace_id='${W.a}' and entity='${imported.id}' and command='import-release'`), people.admin.id);
  assert.deepEqual(stored(W.a).events, [], "audit entries no longer live in the document");
  assert.equal(stored(W.a).awbImports, undefined, "uploads no longer live in the document");
  assert.equal(sql(`select released_order_id from public.operator_import_rows where import_id='${batch.id}'`), imported.id);
  assert.equal(sql(`select confirmed_at is not null from public.operator_imports where id='${batch.id}'`), "t");
  const opened = await imports(a, "GET", `/${batch.id}?workspace=${W.a}`);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.ok(opened.body.import.confirmedAt);
  assert.equal(opened.body.import.rows[0].releasedOrderId, imported.id);
  const second = await post(a, "import-release", { id: batch.id }, { ws: W.a, role: "admin" });
  assert.equal(second.status, 400, JSON.stringify(second.body));
  assert.match(second.body.error, /already confirmed/);
  const forged = await imports(a, "POST", "", { workspace: W.a, batch: { ...batch, id: randomUUID(), files: [{ ...fileRef, path: `${W.b}/${hash}.pdf` }] } });
  assert.equal(forged.status, 400);
  const notUploaded = "e".repeat(64);
  const missing = await imports(a, "POST", "", {
    workspace: W.a,
    batch: {
      ...batch,
      id: randomUUID(),
      files: [{ ...fileRef, id: notUploaded, path: `${W.a}/${notUploaded}.pdf` }],
      rows: parsePages([{ file: notUploaded, page: 1, method: "text", text: "Ninja Van\nNVMYINT000002\nOrder: #INT-ORDER-2\nProducts:\n1x Cavernosil [cave04]" }], "Luxana", "INT STORE"),
    },
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /was not saved/);
  // Saving and receiving are no longer document commands.
  const legacy = await post(a, "import-save", { batch }, { ws: W.a, role: "admin" });
  assert.equal(legacy.status, 403);
  // The screen lists the upload from the tables and opens its review.
  await a.page.goto("/?view=input");
  await a.page.getByRole("button", { name: "Import history" }).click();
  await a.page.getByRole("button", { name: /Synthetic integration/ }).click();
  await a.page.getByText(/Admin handoff confirmed/).waitFor();
  const adminProd = await post(a, "batch", { product: "cav", code: "ADMIN-1", date: "2026-10-03", target: 1 }, { ws: W.a, role: "admin" });
  assert.equal(adminProd.status, 403);
  await a.context.close();
});

await check("B: authorized colleagues open the site source; others and guessed paths get nothing", async () => {
  const out = await session("outA");
  // Stock-out opens the released upload and acknowledges it once.
  const handoff = await imports(out, "GET", `/${importId}?workspace=${W.a}`);
  assert.equal(handoff.status, 200, JSON.stringify(handoff.body));
  const received = await imports(out, "POST", `/${importId}/receive`, { workspace: W.a, pic: "Sample PIC S" });
  assert.equal(received.status, 200, JSON.stringify(received.body));
  assert.equal(received.body.import.receivedBy, "Sample PIC S");
  const twice = await imports(out, "POST", `/${importId}/receive`, { workspace: W.a, pic: "Sample PIC S" });
  assert.equal(twice.status, 409);
  assert.equal(sql(`select received_user from public.operator_imports where id='${importId}'`), people.outA.id);
  const opened = await files(out, "GET", "?path=" + encodeURIComponent(sourcePath));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.expiresIn, 60);
  const bytes = await out.page.evaluate(async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], opened.body.url);
  assert.deepEqual(Buffer.from(bytes), sourceBytes);
  const tampered = await out.page.evaluate(async (url) => (await fetch(url.replace(/token=[^&]+/, "token=forged"))).status, opened.body.url);
  assert.ok(tampered >= 400);
  const guessed = await files(out, "GET", "?path=" + encodeURIComponent(`${W.a}/${"f".repeat(64)}.pdf`));
  assert.equal(guessed.status, 404);
  for (const bad of ["../etc/passwd", `${W.a}/../x.pdf`, "not-a-path"])
    assert.equal((await files(out, "GET", "?path=" + encodeURIComponent(bad))).status, 404);
  await out.context.close();
  for (const key of ["prodA", "outB", "packerA", "preview"]) {
    const s = await session(key);
    const denied = await files(s, "GET", "?path=" + encodeURIComponent(sourcePath));
    assert.equal(denied.status, 404, key);
    // Uploads follow the same rule; the preview sandbox does not cover them at all.
    for (const path of ["?workspace=" + W.a, `/${importId}?workspace=${W.a}`])
      assert.equal((await imports(s, "GET", path)).status, 403, key + " " + path);
    await s.context.close();
  }
  // Direct Storage API access with a real user JWT is governed by the same RLS.
  for (const [key, ok] of [["prodA", false], ["outB", false], ["mgmt", true]]) {
    const jwt = await token(key);
    const res = await fetch(`${supabase}/storage/v1/object/authenticated/operator-sources/${sourcePath}`, { headers: { apikey: anonKey, authorization: "Bearer " + jwt } });
    assert.equal(res.ok, ok, key + " " + res.status);
  }
  const prodJwt = await token("prodA");
  const upload = await fetch(`${supabase}/storage/v1/object/operator-sources/${W.a}/${"d".repeat(64)}.pdf`, {
    method: "POST",
    headers: { apikey: anonKey, authorization: "Bearer " + prodJwt, "content-type": "application/pdf" },
    body: sourceBytes,
  });
  assert.ok(!upload.ok, "production SV must not upload sources: " + upload.status);
});

await check("B: membership administration — HR across sites, supervisors only for their site's staff", async () => {
  const hr = await token("hr");
  const sv = await token("prodA");
  const call = (jwt, fn, args) => rest("rpc/" + fn, jwt, { method: "POST", body: JSON.stringify(args) });
  const svGrant = await call(sv, "operator_grant_membership", { p_workspace: W.a, p_user: people.newHire.id, p_role: "packer", p_display_name: "New Hire", p_staff_profile_id: "staff-new", p_reason: "Starts Monday" });
  assert.equal(svGrant.status, 200, await svGrant.text());
  for (const [label, args] of [
    ["promote to supervisor", { p_workspace: W.a, p_user: people.newHire.id, p_role: "intake", p_display_name: "x", p_staff_profile_id: null, p_reason: "x" }],
    ["self-promotion", { p_workspace: W.a, p_user: people.prodA.id, p_role: "packer", p_display_name: "x", p_staff_profile_id: null, p_reason: "x" }],
    ["other site", { p_workspace: W.b, p_user: people.newHire.id, p_role: "packer", p_display_name: "x", p_staff_profile_id: null, p_reason: "x" }],
    ["all-sites", { p_workspace: null, p_user: people.newHire.id, p_role: "management", p_display_name: "x", p_staff_profile_id: null, p_reason: "x", p_scope: "all-sites" }],
    ["change a peer supervisor", { p_workspace: W.a, p_user: people.intakeA.id, p_role: "packer", p_display_name: "x", p_staff_profile_id: null, p_reason: "x" }],
  ]) {
    const res = await call(sv, "operator_grant_membership", args);
    assert.equal(res.status, 403, label + " " + (await res.text()));
  }
  assert.equal((await call(sv, "operator_set_site_policy", { p_workspace: W.a, p_policy: {}, p_reason: "x" })).status, 403);
  assert.equal((await call(hr, "operator_grant_membership", { p_workspace: null, p_user: people.hr.id, p_role: "hr", p_display_name: "x", p_staff_profile_id: null, p_reason: "x", p_scope: "all-sites" })).status, 403);
  const hrGrant = await call(hr, "operator_grant_membership", { p_workspace: W.b, p_user: people.newHire.id, p_role: "outbound", p_display_name: "New Hire", p_staff_profile_id: null, p_reason: "Transfer to site B" });
  assert.equal(hrGrant.status, 200, await hrGrant.text());
  const audit = await (await rest("operator_membership_audit?select=action,actor_role,reason&order=id", hr)).json();
  assert.deepEqual(audit.map((r) => r.action + ":" + r.actor_role), ["grant:production", "grant:hr"]);
  const svAudit = await (await rest("operator_membership_audit?select=workspace_id", sv)).json();
  assert.ok(svAudit.every((r) => r.workspace_id === W.a), "supervisor audit view is site-scoped");
});

await check("B: HR revocation takes effect on the revoked member's next request", async () => {
  const hr = await token("hr");
  const membership = sql(`select id from public.operator_memberships where user_id='${people.intakeA.id}'`);
  const revoke = await rest("rpc/operator_revoke_membership", hr, { method: "POST", body: JSON.stringify({ p_membership: membership, p_reason: "Left the company" }) });
  assert.equal(revoke.status, 204, await revoke.text());
  const r = await post(intake, "machine-create", { stage: "mixing", name: "After revoke" }, { role: "intake", ws: W.a });
  assert.ok([401, 403].includes(r.status), String(r.status));
  assert.equal((await api(intake, "GET")).status, 403);
  assert.equal(stored(W.a).machines.some((m) => m.name === "After revoke"), false);
});

await check("B: outsider, revoked and other-site users cannot revoke or grant access, even with the UUID", async () => {
  const snapshot = () =>
    sql(`select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]')::text || '|' || (select count(*) from public.operator_membership_audit) from public.operator_memberships m`);
  const before = snapshot();
  const membershipOf = (key, scope = "site") =>
    sql(`select id from public.operator_memberships where user_id='${people[key].id}' and scope='${scope}' order by created_at limit 1`);
  const targets = [membershipOf("packerA"), membershipOf("prodA"), membershipOf("hr", "all-sites"), membershipOf("mgmt", "all-sites"), randomUUID()];
  // intakeA was revoked in the previous scenario; outsider never had a membership.
  for (const caller of ["outsider", "intakeA", "prodB", "mgmt"]) {
    const jwt = await token(caller);
    assert.ok(jwt, caller + " has a real session");
    for (const target of targets) {
      const res = await rest("rpc/operator_revoke_membership", jwt, { method: "POST", body: JSON.stringify({ p_membership: target, p_reason: "probe" }) });
      const body = await res.json().catch(() => ({}));
      assert.equal(res.status, 403, `${caller} revoking ${target}: ${res.status} ${JSON.stringify(body)}`);
      assert.equal(body.code, "42501");
      assert.equal(body.message, "You cannot revoke this access.");
    }
    for (const [ws, scope, role] of [[W.a, "site", "driver"], [null, "all-sites", "hr"]]) {
      const res = await rest("rpc/operator_grant_membership", jwt, {
        method: "POST",
        body: JSON.stringify({ p_workspace: ws, p_user: people.newHire.id, p_role: role, p_display_name: "Probe", p_staff_profile_id: null, p_reason: "probe", p_scope: scope }),
      });
      assert.equal(res.status, 403, `${caller} granting ${scope}: ${res.status}`);
    }
  }
  assert.equal(snapshot(), before, "memberships and audit unchanged after denied calls");
  // Authorized paths still work: the site supervisor revokes staff it granted; HR revokes elsewhere.
  const sv = await token("prodA"), hr = await token("hr");
  const siteA = sql(`select id from public.operator_memberships where user_id='${people.newHire.id}' and workspace_id='${W.a}'`);
  const siteB = sql(`select id from public.operator_memberships where user_id='${people.newHire.id}' and workspace_id='${W.b}'`);
  const svRevoke = await rest("rpc/operator_revoke_membership", sv, { method: "POST", body: JSON.stringify({ p_membership: siteA, p_reason: "Contract ended" }) });
  assert.equal(svRevoke.status, 204, await svRevoke.text());
  const svOther = await rest("rpc/operator_revoke_membership", sv, { method: "POST", body: JSON.stringify({ p_membership: siteB, p_reason: "x" }) });
  assert.equal(svOther.status, 403);
  const hrRevoke = await rest("rpc/operator_revoke_membership", hr, { method: "POST", body: JSON.stringify({ p_membership: siteB, p_reason: "Contract ended" }) });
  assert.equal(hrRevoke.status, 204, await hrRevoke.text());
  assert.equal(sql(`select string_agg(active::text, ',') from public.operator_memberships where user_id='${people.newHire.id}' and scope='site'`), "false,false");
  const audit = sql(`select string_agg(action || ':' || actor_role, ',' order by id) from public.operator_membership_audit where target_user='${people.newHire.id}' and action='revoke'`);
  assert.equal(audit, "revoke:production,revoke:hr");
});

await check("B: a view-only packer posts authored feedback through the UI; it persists", async () => {
  const p = await session("packerA");
  await p.page.goto("/?view=feedback");
  await p.page.getByRole("button", { name: /Leave feedback/ }).click();
  const dialog = p.page.getByRole("dialog");
  await dialog.locator('textarea[name="text"]').fill("Label printer jammed twice this morning");
  await dialog.locator('input[name="entity"]').fill("NVMYINT000001");
  await dialog.getByRole("button", { name: /Save record/ }).click();
  await dialog.waitFor({ state: "hidden" });
  await p.page.reload();
  await p.page.getByText("Label printer jammed twice this morning").waitFor();
  const note = stored(W.a).notes.find((n) => n.text.startsWith("Label printer"));
  assert.equal(note.author.userId, people.packerA.id);
  assert.equal(note.siteId, "site-a");
  assert.equal(note.entity, "NVMYINT000001");
  await p.page.getByText(/Synthetic Packer A · Packer · site-a · NVMYINT000001/).first().waitFor();
  await p.context.close();
});

await check("B: shared preview account stays in the fictional sandbox", async () => {
  const p = await session("preview");
  const data = await load(p);
  assert.equal(data.actor.kind, "preview");
  assert.equal(await p.page.locator("#role-switch").count(), 1);
  const before = revision(W.a);
  const r = await api(p, "POST", { command: { type: "machine", role: "production", input: { id: batchId, stage: "mixing", pic: "x" } }, revision: data.revision, workspaceId: W.a });
  assert.equal(r.status, 400);
  assert.equal(revision(W.a), before);
  const sandboxWrite = await api(p, "POST", { command: { type: "feedback", role: "packer", input: { text: "Sandbox note" } }, revision: data.revision });
  assert.equal(sandboxWrite.status, 200);
  // PDF uploads are not part of the sandbox: no upload tab or history, manual entry stays.
  const upload = await api(p, "POST", { command: { type: "import-release", role: "admin", input: { id: randomUUID() } }, revision: sandboxWrite.body.revision });
  assert.equal(upload.status, 403);
  // The sandbox keeps its audit entries in its document; the table endpoint is for sites.
  assert.ok(sandboxWrite.body.state.events.length > 0);
  const sandboxEvents = await eventsApi(p, "?recent=1");
  assert.equal(sandboxEvents.status, 403);
  assert.equal(sandboxEvents.body.code, "sandbox");
  await p.page.locator("#role-switch").selectOption("admin");
  await p.page.goto("/?view=input");
  await p.page.getByText(/PDF uploads are tested on the synthetic operational site/).waitFor();
  assert.equal(await p.page.getByRole("button", { name: "Upload AWB batch" }).count(), 0);
  assert.equal(await p.page.getByRole("button", { name: "Import history" }).count(), 0);
  assert.equal(sql(`select count(*) from public.ui_draft_workspaces where user_id='${people.preview.id}'`), "1");
  await p.context.close();
});

await check("B: expired session keeps the unsaved entry and resubmits it once after sign-in", async () => {
  const s = await session("prodA");
  await s.page.goto("/?view=production&production=machines");
  await s.page.getByRole("button", { name: /Add machine/ }).waitFor();
  // End every GoTrue session for this user (as session expiry/revocation would).
  sql(`delete from auth.sessions where user_id='${people.prodA.id}'`);
  await s.page.getByRole("button", { name: /Add machine/ }).click();
  const dialog = s.page.getByRole("dialog");
  await dialog.locator('select[name="stage"]').selectOption("wrapping");
  await dialog.locator('input[name="name"]').fill("INT Shrink After Expiry");
  await dialog.getByRole("button", { name: /Save record/ }).click();
  await s.page.waitForURL(/\/login\?expired=1/);
  await s.page.getByText(/Your session ended/).waitFor();
  assert.match(await s.page.evaluate(() => localStorage.getItem("operator-pending-save")), /INT Shrink After Expiry/);
  assert.equal(stored(W.a).machines.some((m) => m.name === "INT Shrink After Expiry"), false);
  await login(s.page, "prodA");
  await s.page.getByRole("button", { name: /Resubmit/ }).click();
  await s.page.getByText(/Saved to your site's records|already saved/).waitFor();
  await s.page.getByRole("button", { name: /Resubmit/ }).waitFor({ state: "detached" });
  assert.equal(stored(W.a).machines.filter((m) => m.name === "INT Shrink After Expiry").length, 1);
  await s.context.close();
});

// ============ Objective C: shared packer and driver sign-ins (20261008) ============
const mytToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
const pins = (s, method, body, query = "") =>
  s.page.evaluate(
    async ([path, method, body]) => {
      const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [query, method, body],
  );
const outC = await session("outA");
const packers = await session("packerA");
let ali, abu, aliAwb, abuAwb;

await check("C: stock-out SV adds packer profiles with PINs; PINs never reach the workspace state", async () => {
  await outC.page.goto("/?view=packing");
  for (const [name, pin] of [["Synthetic Ali", "2468"], ["Synthetic Abu", "8642"]]) {
    await outC.page.getByLabel("Packer name").fill(name);
    await outC.page.getByLabel(/PIN \(4–6 digits\)/).fill(pin);
    await outC.page.getByRole("button", { name: /Add packer/ }).click();
    await outC.page.getByText(`${name} added with their PIN.`).waitFor();
  }
  const profiles = stored(W.a).staffProfiles;
  ali = profiles.find((p) => p.name === "Synthetic Ali").id;
  abu = profiles.find((p) => p.name === "Synthetic Abu").id;
  assert.equal(sql(`select count(*) from operator_private.staff_pins where workspace_id='${W.a}'`), "2");
  // PINs are digits. Hex identifiers (record UUIDs, file hashes) can contain any digit run
  // by chance, so they are stripped before the check; a PIN stored in a field survives it.
  const text = JSON.stringify(stored(W.a))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
    .replace(/[0-9a-f]{8,}/gi, "");
  assert.ok(!text.includes("2468") && !text.includes("8642"), "PIN in workspace state");
  assert.equal((await pins(outC, "GET", null, "/api/staff-pins?workspace=" + W.a)).body.pins.length, 2);
});

await check("C: the supervisor assigns today's AWBs to Ali and Abu", async () => {
  const awbs = ["NVMYINTPK0001", "NVMYINTPK0002"];
  for (const awb of awbs) {
    const r = await post(outC, "order", { awb, product: "cav", channel: "TikTok", package: "INT pack", expected: 2, date: mytToday }, { role: "outbound" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = stored(W.a).orders.find((o) => o.awb === awb).id;
    assert.equal((await post(outC, "review-order", { id, pic: "S" }, { role: "outbound" })).status, 200);
  }
  const counted = stored(W.a).orders.filter((o) => o.date === mytToday && o.product === "cav").reduce((n, o) => n + o.expected, 0);
  const count = await post(outC, "sort-count", { date: mytToday, product: "cav", counted, pic: "S", note: "INT count" }, { role: "outbound" });
  assert.equal(count.status, 200, JSON.stringify(count.body));
  aliAwb = stored(W.a).orders.find((o) => o.awb === awbs[0]).id;
  abuAwb = stored(W.a).orders.find((o) => o.awb === awbs[1]).id;
  for (const [id, packer] of [[aliAwb, ali], [abuAwb, abu]]) {
    const r = await post(outC, "assign-orders", { ids: [id], packer, pic: "S" }, { role: "outbound" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
});

await check("C: on the shared packer sign-in, Ali taps his name, enters his PIN and records his own AWB", async () => {
  await packers.page.goto("/?view=packing");
  await packers.page.getByText("Who is packing?").waitFor();
  await packers.page.locator("label.pic-option", { hasText: "Synthetic Ali" }).click();
  await packers.page.locator('input[type="password"]').fill("1111");
  await packers.page.getByRole("button", { name: /Open my AWBs/ }).click();
  await packers.page.getByText("Wrong PIN. Try again.").waitFor();
  await packers.page.locator('input[type="password"]').fill("2468");
  await packers.page.getByRole("button", { name: /Open my AWBs/ }).click();
  await packers.page.getByText(/Recording as/).waitFor();
  await packers.page.getByText("NVMYINTPK0001").waitFor();
  assert.equal(await packers.page.getByText("NVMYINTPK0002").count(), 0, "Abu's AWB visible to Ali");
  await packers.page.locator("section.packing-card", { hasText: "NVMYINTPK0001" }).getByRole("button", { name: /Record what I packed/ }).click();
  const dialog = packers.page.getByRole("dialog");
  await dialog.locator('input[name="actual"]').fill("2");
  await dialog.getByRole("button", { name: /Save my count/ }).click();
  await dialog.waitFor({ state: "hidden" });
  const o = stored(W.a).orders.find((x) => x.id === aliAwb);
  assert.equal(o.actual, 2);
  assert.equal(o.packer, ali);
  assert.equal(o.packRecordedBy.userId, people.packerA.id);
  assert.equal(sql(`select command from public.operator_commits where user_id='${people.packerA.id}' order by committed_at desc limit 1`), "pack-own");
  // The AWB's activity log reads the table through /api/events on the packer phone too.
  await packers.page.locator("section.packing-card", { hasText: "NVMYINTPK0001" }).locator("button.record-link").click();
  await packers.page.locator(".trace-sheet").getByText("Parcel quantity recorded").waitFor();
  await packers.page.keyboard.press("Escape");
  await packers.page.locator(".trace-sheet").waitFor({ state: "hidden" });
});

await check("C: audit entries are rows: read by entity, day and latest; attributed; never written directly", async () => {
  const byAwb = await eventsApi(packers, `?workspace=${W.a}&entity=${aliAwb}`);
  assert.equal(byAwb.status, 200, JSON.stringify(byAwb.body));
  const packed = byAwb.body.events[0];
  assert.equal(packed.action, "Parcel quantity recorded");
  assert.equal(packed.recorder.userId, people.packerA.id);
  assert.equal(packed.performer, ali, "the performer profile the PIN unlocked");
  assert.ok(packed.occurredAt);
  assert.ok(byAwb.body.events.every((e, i, all) => i === 0 || all[i - 1].seq > e.seq), "newest first");
  assert.ok(byAwb.body.events.some((e) => e.action === "Packer assigned"));
  const day = new Date(Date.parse(packed.at) + 8 * 3600e3).toISOString().slice(0, 10);
  const byDay = await eventsApi(outC, `?workspace=${W.a}&date=${day}`);
  assert.equal(byDay.status, 200, JSON.stringify(byDay.body));
  assert.ok(byDay.body.events.some((e) => e.id === packed.id));
  const latest = await eventsApi(outC, `?workspace=${W.a}&recent=1&limit=2`);
  assert.equal(latest.body.events.length, 2);
  assert.equal(latest.body.next, latest.body.events[1].seq);
  const older = await eventsApi(outC, `?workspace=${W.a}&recent=1&limit=2&before=${latest.body.next}`);
  assert.ok(older.body.events.every((e) => e.seq < latest.body.next));
  assert.equal((await eventsApi(outC, `?workspace=${W.a}&date=2026-02-30`)).status, 400);
  assert.equal((await eventsApi(outC, `?workspace=${W.b}&recent=1`)).status, 403);
  // Same rules through the Data API with the members' own tokens.
  const otherSite = await token("prodB");
  assert.deepEqual(await (await rest(`operator_events?select=id&workspace_id=eq.${W.a}`, otherSite)).json(), []);
  const jwt = await token("outA");
  const forged = { id: randomUUID(), workspace_id: W.a, entity: aliAwb, action: "x", detail: "x", actor: "x", at: new Date().toISOString(), recorder: { userId: people.outA.id }, command: "pack", operation_id: randomUUID() };
  for (const [path, init] of [
    ["operator_events", { method: "POST", body: JSON.stringify(forged) }],
    [`operator_events?id=eq.${packed.id}`, { method: "PATCH", body: JSON.stringify({ detail: "rewritten" }) }],
    [`operator_events?id=eq.${packed.id}`, { method: "DELETE" }],
  ]) {
    const res = await rest(path, jwt, init);
    assert.ok(!res.ok || (await res.text()) === "[]", `${init.method} ${path} -> ${res.status}`);
  }
  assert.equal(sql(`select detail <> 'rewritten' from public.operator_events where id='${packed.id}'`), "t");
  assert.equal(sql(`select count(*) from public.operator_events where id='${forged.id}'`), "0");
});

await check("C: a packer cannot record another packer's AWB, re-record, or save without an unlocked PIN", async () => {
  const before = revision(W.a);
  const spoof = await post(packers, "pack-own", { id: abuAwb, actual: 2, packer: abu, pic: abu }, { role: "packer" });
  assert.equal(spoof.status, 400, JSON.stringify(spoof.body));
  assert.match(spoof.body.error, /assigned to another packer/);
  const again = await post(packers, "pack-own", { id: aliAwb, actual: 1 }, { role: "packer" });
  assert.equal(again.status, 400, JSON.stringify(again.body));
  await packers.page.getByRole("button", { name: /^Done$/ }).click();
  await packers.page.getByText("Who is packing?").waitFor();
  const locked = await post(packers, "pack-own", { id: abuAwb, actual: 2 }, { role: "packer" });
  assert.equal(locked.status, 403);
  assert.equal(locked.body.code, "packer-locked");
  // A forged or copied cookie for another account does not unlock anything.
  const other = await session("packerA");
  await other.context.addCookies([{ name: "operator-packer", value: "v1.x.y.z.1.ab", url: app + "/api" }]);
  assert.equal((await post(other, "pack-own", { id: abuAwb, actual: 2 }, { role: "packer" })).status, 403);
  await other.context.close();
  for (const [path, method, body] of [
    ["/api/staff-pins", "POST", { workspaceId: W.a, profileId: abu, pin: "0000" }],
    ["/api/staff-pins?workspace=" + W.a, "GET", null],
  ])
    assert.equal((await pins(packers, method, body, path)).status, 403, method + " " + path);
  const jwt = await token("packerA");
  assert.equal((await rest("rpc/operator_set_staff_pin", jwt, { method: "POST", body: JSON.stringify({ p_workspace: W.a, p_profile: abu, p_pin: "0000" }) })).status, 403);
  assert.ok(!(await rest("staff_pins", jwt)).ok, "PIN table exposed through the Data API");
  assert.equal(revision(W.a), before);
});

await check("C: five wrong PINs lock the profile until the supervisor sets a new PIN", async () => {
  const unlock = (pin) => pins(packers, "POST", { workspaceId: W.a, profileId: abu, pin }, "/api/packer-session");
  for (let i = 0; i < 4; i++) assert.equal((await unlock("0000")).status, 403);
  assert.equal((await unlock("0000")).status, 423);
  assert.equal((await unlock("8642")).status, 423, "right PIN accepted while locked");
  const status = (await pins(outC, "GET", null, "/api/staff-pins?workspace=" + W.a)).body.pins;
  assert.ok(status.find((p) => p.profileId === abu).lockedUntil);
  assert.equal((await pins(outC, "POST", { workspaceId: W.a, profileId: abu, pin: "97531" }, "/api/staff-pins")).status, 200);
  assert.equal((await unlock("97531")).status, 200);
  const r = await post(packers, "pack-own", { id: abuAwb, actual: 2 }, { role: "packer" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(stored(W.a).orders.find((o) => o.id === abuAwb).packer, abu);
  // The supervisor still corrects a saved count, with a reason.
  const fix = await post(outC, "correct", { id: abuAwb, field: "actual", qty: 1, reason: "INT recount" }, { role: "outbound" });
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  await pins(packers, "DELETE", null, "/api/packer-session");
});

await check("C: drivers share one sign-in; each trip keeps the typed driver name", async () => {
  const d = await session("driverA");
  for (const name of ["Synthetic Driver Ali", "Synthetic Driver Abu"]) {
    await d.page.goto("/?view=trips");
    await d.page.getByRole("button", { name: /Log a trip/ }).first().click();
    const dialog = d.page.getByRole("dialog");
    await dialog.locator('input[name="driver"]').fill(name);
    await dialog.getByRole("button", { name: /Save trip/ }).click();
    await dialog.waitFor({ state: "hidden" });
    await d.page.getByText(name).first().waitFor();
  }
  const trips = stored(W.a).trips;
  assert.deepEqual(trips.slice(0, 2).map((t) => t.driver), ["Synthetic Driver Abu", "Synthetic Driver Ali"]);
  assert.ok(trips.slice(0, 2).every((t) => t.recordedBy.userId === people.driverA.id));
  const unnamed = await post(d, "trip", { pickupAt: mytToday + "T08:00" }, { role: "driver" });
  assert.equal(unnamed.status, 400);
  await d.context.close();
});
await check("C: a driver lists two assistants and logs a drop-off with its own time and photo", async () => {
  const d = await session("driverA");
  const myt = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16);
  const now = Date.now();
  const trip = await post(d, "trip", { driver: "Synthetic Driver Ali", assistant_0: "Synthetic Helper A", assistant_1: "Synthetic Helper B", pickupAt: myt(now - 60 * 60e3) }, { role: "driver" });
  assert.equal(trip.status, 200, JSON.stringify(trip.body));
  const logged = stored(W.a).trips[0];
  assert.deepEqual(logged.assistants, ["Synthetic Helper A", "Synthetic Helper B"]);
  assert.equal(logged.assistant, "Synthetic Helper A");
  // Upload a proof photo the way the browser does: sign, then PUT to the signed URL.
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("synthetic drop-off " + randomUUID()), Buffer.alloc(200)]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const uploaded = await d.page.evaluate(async ([hash, bytes, ws]) => {
    const res = await fetch("/api/trip-photos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hash, size: bytes.length, workspace: ws }) });
    const signed = await res.json();
    if (!res.ok) return { status: res.status, signed };
    if (!signed.exists) {
      const put = await fetch(signed.url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: new Uint8Array(bytes) });
      if (!put.ok) return { status: put.status, signed };
    }
    return { status: 200, path: signed.path };
  }, [hash, [...bytes], W.a]);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded));
  const noPhoto = await post(d, "trip-dropoff", { id: logged.id, at: myt(now - 30 * 60e3) }, { role: "driver" });
  assert.equal(noPhoto.status, 400);
  assert.match(noPhoto.body.error, /photo/);
  const drop = await post(d, "trip-dropoff", { id: logged.id, at: myt(now - 30 * 60e3), photo: uploaded.path, note: "INT shop" }, { role: "driver" });
  assert.equal(drop.status, 200, JSON.stringify(drop.body));
  const after = stored(W.a).trips.find((t) => t.id === logged.id);
  assert.equal(after.dropoffs.length, 1);
  assert.equal(after.dropoffs[0].photo, uploaded.path);
  // Another sign-in cannot add to this trip.
  const other = await post(outC, "trip-dropoff", { id: logged.id, at: myt(now - 20 * 60e3), photo: uploaded.path }, { role: "outbound" });
  assert.equal(other.status, 403);
  await d.page.goto("/?view=trips");
  await d.page.getByText("Synthetic Helper A, Synthetic Helper B").first().waitFor();
  await d.page.locator(".dropoff-list", { hasText: "INT shop" }).first().waitFor();
  await d.context.close();
});
await outC.context.close();
await packers.context.close();

// ====== Objective D: order records on a tables-mode site (20261014090000; WP C, PR C2) ======
// Every scenario above ran with site A's orders in its workspace document. The owner now
// moves them to the order tables (administrator SQL, as the owner runs it) and the same
// POST /api/draft serves order commands through operator_commit_records: a slice of rows,
// row versions instead of the document revision, signed change sets. The screens read the
// tables in C3, so these checks drive the API from a page of the app's origin.
const outD = await session("outA");
const packD = await session("packerA");
for (const s of [outD, packD]) await s.page.goto("/api/events?workspace=" + W.a + "&recent=1&limit=1");
const asOut = { role: "outbound", ws: W.a };
const row = (id, columns) => sql(`select ${columns} from public.operator_orders where id='${id}'`);
const laterDay = (n) => new Date(Date.parse(mytToday + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
const newOrder = (awb, extra = {}) => ({ awb, product: "cav", channel: "TikTok", package: "INT D", expected: 3, date: mytToday, ...extra });
let awbX, awbY, issuedTo;

await check("D: the owner moves site A's orders to the tables; the document keeps no order lists", async () => {
  const before = stored(W.a);
  const moved = JSON.parse(sql(`select operator_private.move_orders_to_tables('${W.a}')::text`));
  assert.equal(moved.moved, true, JSON.stringify(moved));
  assert.equal(moved.orders, before.orders.length);
  assert.equal(sql(`select order_store from public.operator_workspaces where id='${W.a}'`), "tables");
  const after = stored(W.a);
  assert.deepEqual([after.orders, after.issues, after.sortCounts], [undefined, undefined, undefined]);
  assert.equal(sql(`select count(*) from public.operator_orders where workspace_id='${W.a}'`), String(before.orders.length));
  // Synthetic stock for the issue checks: one 5-unit cav carton (administrator SQL).
  sql(`update public.operator_workspaces set state = jsonb_set(jsonb_set(state, '{batches}', state -> 'batches' || '[{"id":"b-int-d","code":"INT-CAV-D","product":"cav","date":"2026-10-03","target":5,"actual":5,"sent":5,"transferredAt":"2026-10-03T05:00:00Z","transferPic":"Synthetic F","steps":[]}]'), '{cartons}', state -> 'cartons' || '[{"id":"c-int-d","ref":"INT-CAV-D","batchId":"b-int-d","product":"cav","unit":"bottle","qty":5,"rack":"D-01","pic":"Synthetic R","at":"2026-10-03T06:00:00.000Z"}]') where id='${W.a}'`);
});

await check("D: AWBs are recorded, reviewed, counted and assigned as rows; the revision does not move", async () => {
  const rev = revision(W.a);
  const ids = [];
  for (const awb of ["nvmy intd 0001", "NVMYINTD0002"]) {
    const r = await post(outD, "order", newOrder(awb), asOut);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.orderStore, "tables");
    // The document view of a tables-mode site (C3): empty order lists, carton totals.
    assert.deepEqual([r.body.state.orders, r.body.state.issues], [[], []], "a tables-mode response carries no AWBs");
    assert.ok(r.body.state.cartonIssued, "and the per-carton issued totals");
    assert.equal(r.body.records.replayed, false);
    const [created] = r.body.records.result.orders;
    assert.deepEqual([created.op, created.version], ["insert", 1]);
    assert.deepEqual(r.body.records.result.days, [mytToday]);
    ids.push(created.id);
    const reviewed = await post(outD, "review-order", { id: created.id, pic: "S" }, asOut);
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  }
  [awbX, awbY] = ids;
  assert.equal(row(awbX, "awb || ':' || version || ':' || review_state || ':' || created_by"), `NVMYINTD0001:2:confirmed:${people.outA.id}`);
  const counted = Number(sql(`select expected from operator_private.day_demand('${W.a}', '${mytToday}', 'cav')`));
  const count = await post(outD, "sort-count", { date: mytToday, product: "cav", counted, pic: "S", note: "INT D count" }, asOut);
  assert.equal(count.status, 200, JSON.stringify(count.body));
  assert.equal(sql(`select operator_private.sort_count_current('${W.a}', '${mytToday}', 'cav')`), "t");
  for (const [id, packer] of [[awbX, ali], [awbY, abu]]) {
    const r = await post(outD, "assign-orders", { ids: [id], packer, pic: "S" }, asOut);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.records.result.orders, [{ id, op: "update", version: 3 }]);
  }
  assert.equal(row(awbY, "assigned_packer || ':' || (assigned_at is not null)"), `${abu}:true`);
  assert.equal(revision(W.a), rev, "order records never move the document revision");
  assert.equal(sql(`select count(*) from public.operator_events where workspace_id='${W.a}' and entity in ('${awbX}','${awbY}')`), "6");
});

await check("D: two concurrent issues of 3 against one 5-unit carton apply once", async () => {
  const send = (orderId) => post(outD, "issue", { cartonId: "c-int-d", orderId, qty: 3, pic: "S" }, asOut);
  const results = await Promise.all([send(awbX), send(awbY)]);
  const ok = results.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => [r.status, r.body?.error])));
  const refused = results.find((r) => r.status !== 200);
  // Refused by the domain rules on a fresh slice (400) or, when both read the carton before
  // either committed, by the database under the carton lock (409 invariant).
  assert.ok([400, 409].includes(refused.status), JSON.stringify(refused));
  assert.match(refused.body.error, /Not enough stock/);
  if (refused.status === 409) assert.equal(refused.body.code, "invariant");
  console.log(`    (refused ${refused.status === 409 ? "by the database under the carton lock" : "by the domain rules on a fresh slice"})`);
  assert.equal(sql(`select issued from public.operator_carton_issued where workspace_id='${W.a}' and carton_id='c-int-d'`), "3");
  issuedTo = sql(`select order_id from public.operator_issues where workspace_id='${W.a}' and carton_id='c-int-d'`);
  assert.ok([awbX, awbY].includes(issuedTo), "exactly one issue row");
  // Deterministically: another session holds the carton lock while it issues 1 of the 2
  // units left. The API's slice still reads 2 and signs an issue of 2; the database waits
  // for the lock, reads the new balance and refuses (409 invariant).
  const other = sqlSession(`begin;
    select pg_advisory_xact_lock(hashtextextended('operator-carton:${W.a}:c-int-d', 0));
    insert into public.operator_issues (id, workspace_id, order_id, carton_id, product, unit, qty, pic, legacy)
      values ('${randomUUID()}', '${W.a}', '${issuedTo}', 'c-int-d', 'cav', 'bottle', 1, 'Synthetic other session', true);
    update public.operator_carton_issued set issued = issued + 1 where workspace_id = '${W.a}' and carton_id = 'c-int-d';
    select pg_sleep(2.5); commit;`);
  await pause(800);
  const waited = await post(outD, "issue", { cartonId: "c-int-d", orderId: issuedTo, qty: 2, pic: "S" }, asOut);
  await other;
  assert.equal(waited.status, 409, JSON.stringify(waited.body));
  assert.equal(waited.body.code, "invariant");
  assert.match(waited.body.error, /Not enough stock/);
  assert.equal(sql(`select issued || ':' || (select count(*) from public.operator_issues where workspace_id='${W.a}' and carton_id='c-int-d') from public.operator_carton_issued where workspace_id='${W.a}' and carton_id='c-int-d'`), "4:2");
});

await check("D: a response-loss retry of an issue replays its result without a second issue", async () => {
  const operationId = randomUUID();
  const input = { cartonId: "c-int-d", orderId: issuedTo, qty: 1, pic: "S" };
  const first = await post(outD, "issue", input, { ...asOut, operationId });
  const again = await post(outD, "issue", input, { ...asOut, operationId });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([first.body.replayed, again.body.replayed], [false, true]);
  assert.deepEqual(again.body.records.result, first.body.records.result);
  assert.equal(sql(`select issued from public.operator_carton_issued where workspace_id='${W.a}' and carton_id='c-int-d'`), "5");
  assert.equal(sql(`select count(*) from public.operator_issues where workspace_id='${W.a}' and carton_id='c-int-d'`), "3");
  assert.equal(sql(`select count(*) || ':' || bool_and(result is not null and result_revision is null) from public.operator_commits where operation_id='${operationId}'`), "1:true");
  const other = await post(outD, "issue", { ...input, qty: 2 }, { ...asOut, operationId });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, "operation-mismatch");
});

await check("D: a packer's count, a print and a note saved at once all apply; only the note moves the revision", async () => {
  const unlock = await pins(packD, "POST", { workspaceId: W.a, profileId: ali, pin: "2468" }, "/api/packer-session");
  assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
  const rev = revision(W.a);
  const versionY = Number(row(awbY, "version"));
  // Every request carries an out-of-date revision hint; none of them conflicts.
  const [own, printed, note] = await Promise.all([
    post(packD, "pack-own", { id: awbX, actual: 3 }, { role: "packer", ws: W.a, revision: rev - 1 }),
    post(outD, "print", { id: awbY, pic: "S" }, { ...asOut, revision: rev - 1 }),
    post(outD, "feedback", { text: "INT D: saved alongside order records" }, { ...asOut, revision: rev - 1 }),
  ]);
  for (const r of [own, printed, note]) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([own.attempts, printed.attempts, note.attempts], ["1", "1", "1"], "no save was rebased");
  assert.ok(own.body.packerExpiresAt, "the packer's session slides with the save");
  assert.equal(revision(W.a), rev + 1);
  assert.equal(row(awbX, "actual || ':' || packer || ':' || label_pic || ':' || (pack_recorded_by ->> 'userId')"), `3:${ali}:${ali}:${people.packerA.id}`);
  assert.equal(row(awbY, "printed || ':' || version"), `true:${versionY + 1}`);
  assert.equal(sql(`select command from public.operator_commits where user_id='${people.packerA.id}' order by committed_at desc limit 1`), "pack-own");
});

await check("D: a packer's own count is saved only for an AWB assigned to the profile they unlocked", async () => {
  // Abu's AWB is not even readable through Ali's sealed session.
  const spoof = await post(packD, "pack-own", { id: awbY, actual: 3 }, { role: "packer", ws: W.a });
  assert.equal(spoof.status, 400, JSON.stringify(spoof.body));
  assert.equal(row(awbY, "actual is null"), "t");
  await pins(packD, "DELETE", null, "/api/packer-session");
  const locked = await post(packD, "pack-own", { id: awbY, actual: 3 }, { role: "packer", ws: W.a });
  assert.equal(locked.status, 403);
  assert.equal(locked.body.code, "packer-locked");
  // The packer's own token without the sealed session reads no AWB rows.
  const jwt = await token("packerA");
  assert.deepEqual(await (await rest(`operator_orders?select=id&workspace_id=eq.${W.a}`, jwt)).json(), []);
});

await check("D: an AWB changed after a form opened it is reported; unversioned saves retry on fresh rows", async () => {
  const created = await post(outD, "order", newOrder("NVMYINTD0003", { expected: 1 }), asOut);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.records.result.orders[0].id;
  const edit = (expected, extra = {}) =>
    post(outD, "edit-order", { id, awb: "NVMYINTD0003", product: "cav", channel: "TikTok", package: "INT D", expected, date: mytToday, ...extra }, asOut);
  assert.equal((await edit(2, { expectedVersion: 1 })).status, 200);
  const stale = await edit(4, { expectedVersion: 1 });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, "record");
  assert.equal(stale.body.conflict.currentVersion, 2);
  assert.equal(stale.body.conflict.current.expected, 2);
  assert.equal(row(id, "expected || ':' || version"), "2:2");
  // Edits without a version at once: a row changed after it was read (PT412) is read again
  // and the edit applied to it; a rebased save reports more than one attempt.
  // Deterministically: another session changes the row (its version) after the API read it.
  // The commit finds a stale version (PT412); the API reads the row again and applies the
  // edit on the second attempt. With the form's version, the second attempt reports it.
  const hold = () => sqlSession(`begin; update public.operator_orders set version = version + 1, note = 'INT D: changed elsewhere'
    where id = '${id}'; select pg_sleep(2.5); commit;`);
  let other = hold();
  await pause(800);
  const rebased = await edit(3);
  await other;
  assert.equal(rebased.status, 200, JSON.stringify(rebased.body));
  assert.equal(rebased.attempts, "2", "applied again on the fresh row");
  assert.equal(row(id, "expected || ':' || version || ':' || note"), "3:4:INT D: changed elsewhere");
  other = hold();
  await pause(800);
  const conflict = await edit(9, { expectedVersion: 4 });
  await other;
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, "record");
  assert.equal(conflict.body.conflict.currentVersion, 5);
  assert.equal(row(id, "expected || ':' || version"), "3:5");
  // Three at most: the rebase loop makes three attempts, enough for three colliding saves.
  const all = await Promise.all([5, 6, 7].map((n) => edit(n)));
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200], JSON.stringify(all.map((r) => r.body)));
  assert.equal(row(id, "version"), "8");
  console.log(`    (attempts: ${all.map((r) => r.attempts).join(", ")})`);
});

await check("D: a duplicate AWB is refused; a courier's number may return 30+ days after handover", async () => {
  const dup = await post(outD, "order", newOrder("NVMYINTD0001", { date: laterDay(5) }), asOut);
  assert.equal(dup.status, 400, JSON.stringify(dup.body));
  assert.match(dup.body.error, /already recorded/);
  // The same new number saved twice at once: one row; the other is refused by the domain
  // rules (400) or by the database's unique key (409 duplicate).
  const both = await Promise.all([1, 2].map(() => post(outD, "order", newOrder("NVMYINTD0009"), asOut)));
  assert.equal(both.filter((r) => r.status === 200).length, 1, JSON.stringify(both.map((r) => r.body)));
  const refused = both.find((r) => r.status !== 200);
  assert.match(refused.body.error, /already recorded/);
  if (refused.status === 409) assert.equal(refused.body.code, "duplicate");
  else assert.equal(refused.status, 400);
  console.log(`    (refused ${refused.status === 409 ? "by the database's unique key" : "by the domain rules"})`);
  assert.equal(sql(`select count(*) from public.operator_orders where workspace_id='${W.a}' and awb='NVMYINTD0009'`), "1");
  // Deterministically: another session inserts the same AWB for the day and commits while
  // the API's commit waits on the unique key: 409 duplicate.
  const other = sqlSession(`begin; insert into public.operator_orders (id, workspace_id, awb, channel, product, package,
    expected, original_expected, fulfil_date, review_state, legacy) values ('${randomUUID()}', '${W.a}', 'NVMYINTD0010',
    'TikTok', 'cav', 'INT D', 1, 1, '${mytToday}', 'pending', true); select pg_sleep(2.5); commit;`);
  await pause(800);
  const raced = await post(outD, "order", newOrder("NVMYINTD0010"), asOut);
  await other;
  assert.equal(raced.status, 409, JSON.stringify(raced.body));
  assert.equal(raced.body.code, "duplicate");
  assert.equal(raced.body.error, "This AWB is already recorded.");
  const handed = await post(outD, "dispatch", { id: awbX, reference: "INT-M-D1", pic: "S" }, asOut);
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(row(awbX, "dispatched_at is not null"), "t");
  const soon = await post(outD, "order", newOrder("NVMYINTD0001", { date: laterDay(10) }), asOut);
  assert.equal(soon.status, 400, JSON.stringify(soon.body));
  const reused = await post(outD, "order", newOrder("NVMYINTD0001", { date: laterDay(40) }), asOut);
  assert.equal(reused.status, 200, JSON.stringify(reused.body));
  assert.equal(sql(`select string_agg(to_char(fulfil_date, 'YYYY-MM-DD'), ',' order by fulfil_date) from public.operator_orders where workspace_id='${W.a}' and awb='NVMYINTD0001'`), `${mytToday},${laterDay(40)}`);
});

// ====== Objective D (continued): the screens read the order tables (WP C, PR C3) ======
// On a tables-mode site the order screens read /api/orders/* instead of the document:
// the day list (200 per page), the day's aggregates, the packer's own page, trace and the
// CSV export. Synthetic rows are seeded with administrator SQL for paging and payloads.
const orderApi = (s, path, headers = {}) =>
  s.page.evaluate(
    async ([path, headers]) => {
      const res = await fetch(path, { cache: "no-store", headers });
      const type = res.headers.get("content-type") ?? "";
      return {
        status: res.status,
        etag: res.headers.get("etag"),
        body: type.includes("json") ? await res.json().catch(() => null) : await res.text(),
      };
    },
    [path, headers],
  );
const openParcels = async (page) => {
  const details = page.locator("details.parcel-details");
  await details.waitFor();
  if (!(await details.evaluate((d) => d.open))) await details.locator("summary").click();
};
const parcelRows = (page) => page.locator("details.parcel-details table tbody tr");
const ui = await session("outA");

await check("D: the supervisor's order screen and daily tally read the day list and aggregates from the tables", async () => {
  const data = await load(ui);
  assert.equal(data.orderStore, "tables");
  assert.deepEqual([data.state.orders, data.state.issues], [[], []], "no AWBs in the document view");
  assert.equal(data.state.cartonIssued["c-int-d"], 5, "carton balances count table issues");
  await ui.page.goto("/?view=orders");
  await openParcels(ui.page);
  for (const awb of ["NVMYINTD0002", "NVMYINTD0003", "NVMYINTPK0001"])
    await parcelRows(ui.page).filter({ hasText: awb }).first().waitFor();
  const today = Number(sql(`select count(*) from public.operator_orders where workspace_id='${W.a}' and fulfil_date='${mytToday}'`));
  await ui.page.getByText(`Showing ${today} of ${today} AWBs`).waitFor();
  // Package groups come from the server's aggregates (no AWB ids on the wire).
  await ui.page.locator("table.package-table tbody tr", { hasText: "INT D" }).first().waitFor();
  const day = await orderApi(ui, `/api/orders/day?workspace=${W.a}&date=${mytToday}`);
  assert.equal(day.status, 200, JSON.stringify(day.body));
  assert.ok(day.body.groups.length && day.body.groups.every((g) => g.ids === undefined));
  assert.equal(day.body.counts.awbs, today);
  await ui.page.goto("/?view=tally");
  const required = sql(`select expected from operator_private.day_demand('${W.a}', '${mytToday}', 'cav')`);
  const cav = ui.page.locator("table.daily-tally").first().locator("tbody tr", { hasText: "Cavernosil" });
  await cav.waitFor();
  assert.equal((await cav.locator("td").nth(1).innerText()).trim(), required);
  await ui.page.getByText("Tally by assigned packer").waitFor();
  await ui.page.locator("table tbody tr", { hasText: "Synthetic Abu" }).first().waitFor();
});

await check("D: the order list shows 200 AWBs at a time and Show more loads the rest", async () => {
  const day = laterDay(2);
  sql(`insert into public.operator_orders (id, workspace_id, awb, channel, product, package, expected, original_expected, fulfil_date, review_state, legacy)
    select gen_random_uuid(), '${W.a}', 'NVMYINTPG' || lpad(g::text, 4, '0'), 'TikTok', 'cav', 'INT page', 2, 2, '${day}', 'confirmed', true
    from generate_series(1, 230) g`);
  await ui.page.goto("/?view=orders");
  await ui.page.locator(".order-filters input[type=date]").first().fill(day);
  await openParcels(ui.page);
  await ui.page.getByText("Showing 200 of 230 AWBs").waitFor();
  assert.equal(await parcelRows(ui.page).count(), 200);
  assert.equal(await parcelRows(ui.page).filter({ hasText: "NVMYINTPG0201" }).count(), 0);
  await ui.page.getByRole("button", { name: "Show more AWBs" }).click();
  await ui.page.getByText("Showing 230 of 230 AWBs").waitFor();
  await parcelRows(ui.page).filter({ hasText: "NVMYINTPG0230" }).waitFor();
  assert.equal(await parcelRows(ui.page).count(), 230);
  assert.equal(await ui.page.getByRole("button", { name: "Show more AWBs" }).count(), 0);
  // The package group counts the whole day, not the visible page.
  const group = ui.page.locator("table.package-table tbody tr", { hasText: "INT page" });
  assert.match(await group.innerText(), /\b230\b/);
});

await check("D: on the packer phone Abu sees only his own AWBs from the tables and records his count", async () => {
  const phone = await session("packerA");
  try {
    await phone.page.goto("/?view=packing");
    await phone.page.getByText("Who is packing?").waitFor();
    // Unlock screen counts come from /api/orders/packer-counts (no AWBs before a PIN).
    await phone.page.locator("label.pic-option", { hasText: "Synthetic Abu" }).getByText("1 AWBs to pack today").waitFor();
    const projected = await load(phone);
    assert.equal(projected.orderStore, "tables");
    assert.deepEqual([projected.state.batches, projected.state.cartons, projected.state.orders], [[], [], []], "packer projection");
    assert.ok(projected.state.staffProfiles.some((p) => p.id === abu));
    await phone.page.locator("label.pic-option", { hasText: "Synthetic Abu" }).click();
    await phone.page.locator('input[type="password"]').fill("97531");
    await phone.page.getByRole("button", { name: /Open my AWBs/ }).click();
    await phone.page.getByText(/Recording as/).waitFor();
    const card = (awb) => phone.page.locator("section.packing-card", { hasText: awb });
    await card("NVMYINTD0002").waitFor();
    await card("NVMYINTPK0002").waitFor();
    assert.equal(await card("NVMYINTPK0001").count(), 0, "Ali's AWB visible to Abu");
    assert.equal(await card("NVMYINTD0001").count(), 0);
    const page = await orderApi(phone, `/api/orders/packer?workspace=${W.a}&date=${mytToday}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.equal(page.body.profileId, abu);
    assert.ok(page.body.orders.every((o) => o.assignedPacker === abu));
    assert.equal((await orderApi(phone, `/api/orders?workspace=${W.a}&date=${mytToday}`)).status, 403, "a packer reads no day list");
    await card("NVMYINTD0002").getByRole("button", { name: /Record what I packed/ }).click();
    const dialog = phone.page.getByRole("dialog");
    await dialog.locator('input[name="actual"]').fill("3");
    await dialog.getByRole("button", { name: /Save my count/ }).click();
    await dialog.waitFor({ state: "hidden" });
    await card("NVMYINTD0002").getByText(/Saved\. Ask your supervisor/).waitFor();
    assert.equal(row(awbY, "actual || ':' || packer || ':' || (pack_recorded_by ->> 'role')"), `3:${abu}:packer`);
    await pins(phone, "DELETE", null, "/api/packer-session");
    const locked = await orderApi(phone, `/api/orders/packer?workspace=${W.a}&date=${mytToday}`);
    assert.deepEqual([locked.status, locked.body.code], [403, "packer-locked"]);
  } finally {
    await phone.context.close();
  }
});

await check("D: trace by a reused AWB lists every occurrence, newest first, with its activity", async () => {
  await ui.page.goto("/?view=trace");
  await ui.page.getByLabel(/find an AWB or order number/).fill("NVMYINTD0001");
  const rows = ui.page.locator("table tbody tr", { hasText: "NVMYINTD0001" });
  await rows.nth(1).waitFor();
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).innerText(), new RegExp(laterDay(40)));
  assert.match(await rows.nth(1).innerText(), new RegExp(mytToday));
  const api = await orderApi(ui, `/api/orders/trace?workspace=${W.a}&q=NVMYINTD0001`);
  assert.deepEqual(api.body.orders.map((o) => o.date), [laterDay(40), mytToday]);
  // The handed-over occurrence opens with its source carton and its audit entries.
  await rows.nth(1).locator("button.record-link").click();
  const sheet = ui.page.locator(".trace-sheet");
  await sheet.getByText("Courier handover").waitFor();
  await sheet.getByText("SOURCE CARTONS").waitFor();
  await ui.page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  // Roles without AWB access trace a batch's cartons, not its parcels.
  const mgmt = await session("mgmt");
  try {
    const batch = await orderApi(mgmt, `/api/orders/trace?workspace=${W.a}&batch=b-int-d`);
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.deepEqual([batch.body.parcels, batch.body.orders.length, batch.body.cartons[0].issued], [false, 0, 5]);
    assert.equal((await orderApi(mgmt, `/api/orders/trace?workspace=${W.a}&q=NVMYINTD0001`)).status, 403);
    assert.equal((await orderApi(mgmt, `/api/orders/day?workspace=${W.a}&date=${mytToday}`)).status, 403);
  } finally {
    await mgmt.context.close();
  }
});

await check("D: Export AWBs downloads the day's CSV; a range over 31 days is refused", async () => {
  await ui.page.goto("/?view=orders");
  const button = ui.page.getByRole("button", { name: "Export AWBs (CSV)" });
  await button.waitFor();
  const [download] = await Promise.all([ui.page.waitForEvent("download"), button.click()]);
  assert.equal(download.suggestedFilename(), `operator-awbs-${mytToday}.csv`);
  const text = readFileSync(await download.path(), "utf8");
  const lines = text.replace(/^﻿/, "").split("\r\n");
  assert.match(lines[0], /^"AWB","Source","Date","Product"/);
  const expected = sql(`select sum(coalesce(jsonb_array_length(lines), 1)) from public.operator_orders where workspace_id='${W.a}' and fulfil_date='${mytToday}'`);
  assert.equal(lines.length - 1, Number(expected));
  assert.ok(lines.some((l) => l.startsWith('"NVMYINTD0002"')));
  assert.ok(lines.every((l, i) => !i || l.includes(`"${mytToday}"`)), "only the chosen day");
  await ui.page.getByLabel("Export to").fill(laterDay(40));
  await button.click();
  await ui.page.getByText("Export at most 31 days at a time.").waitFor();
  const refused = await orderApi(ui, `/api/orders/export?workspace=${W.a}&from=${mytToday}&to=${laterDay(31)}`);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /at most 31 days/);
  const month = await orderApi(ui, `/api/orders/export?workspace=${W.a}&from=${mytToday}&to=${laterDay(30)}`);
  assert.equal(month.status, 200);
});

await check("D: an unchanged day answers 304; a change, the sandbox and other sites are handled", async () => {
  const day = `/api/orders/day?workspace=${W.a}&date=${mytToday}`;
  const list = `/api/orders?workspace=${W.a}&date=${mytToday}`;
  for (const path of [day, list, `/api/orders/summary?workspace=${W.a}&date=${mytToday}`]) {
    const first = await orderApi(ui, path);
    assert.equal(first.status, 200, path);
    assert.ok(first.etag, path);
    const again = await orderApi(ui, path, { "If-None-Match": first.etag });
    assert.equal(again.status, 304, path);
  }
  const before = await orderApi(ui, list);
  const added = await post(outD, "order", newOrder("NVMYINTD0011"), asOut);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const after = await orderApi(ui, list, { "If-None-Match": before.etag });
  assert.equal(after.status, 200, "a new AWB changes the day marker");
  assert.equal(after.body.total, before.body.total + 1);
  const preview = await session("preview");
  try {
    const r = await orderApi(preview, list);
    assert.deepEqual([r.status, r.body.code], [403, "sandbox"]);
  } finally {
    await preview.context.close();
  }
  // Site B keeps its orders in the document: its supervisor reads none of site A's.
  const outsider = await session("outB");
  try {
    assert.equal((await orderApi(outsider, list)).status, 403);
    assert.equal((await load(outsider)).orderStore, undefined, "a document-mode site's response is unchanged");
  } finally {
    await outsider.context.close();
  }
});

await check("D: first-open payloads at 2,000 synthetic AWBs (laptop and packer phone)", async () => {
  const day = laterDay(3);
  sql(`insert into public.operator_orders (id, workspace_id, awb, channel, store, order_ref, courier, product, package, expected, original_expected,
      fulfil_date, review_state, assigned_packer, legacy)
    select gen_random_uuid(), '${W.a}', 'NVMYINTLD' || lpad(g::text, 5, '0'), (array['TikTok','Shopee','Lazada','Luxana'])[1 + g % 4],
      'Synthetic Store ' || (g % 3), 'ORDER-INT-' || lpad(g::text, 6, '0'), 'Ninja Van',
      (array['cav','gly','lip','syn'])[1 + g % 4], 'INT LD pack ' || (g % 12), 1 + g % 4, 1 + g % 4, '${day}', 'confirmed',
      case when g <= 250 then '${ali}' when g <= 1500 then '${abu}' end, true
    from generate_series(1, 2000) g`);
  const measure = async (s, path) => {
    const cookie = (await s.context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await new Promise((resolve, reject) =>
      http.get(app + path, { headers: { cookie, "accept-encoding": "gzip" } }, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode, encoding: r.headers["content-encoding"], body: Buffer.concat(chunks) }));
      }).on("error", reject),
    );
    assert.equal(res.status, 200, path);
    const raw = res.encoding === "gzip" ? gunzipSync(res.body) : res.body;
    return { raw: raw.length, sent: res.body.length, gzip: gzipSync(raw).length, compressed: res.encoding === "gzip" };
  };
  const kb = (n) => (n / 1024).toFixed(1) + " KB";
  const show = (label, parts) => {
    const total = parts.reduce((t, p) => ({ raw: t.raw + p.raw, sent: t.sent + p.sent, gzip: t.gzip + p.gzip }), { raw: 0, sent: 0, gzip: 0 });
    console.log(`    ${label}: ${parts.map((p) => `${p.name} ${kb(p.raw)} raw / ${kb(p.gzip)} gzip`).join(" + ")}` +
      ` = ${kb(total.raw)} raw, ${kb(total.gzip)} gzip (${kb(total.sent)} sent by next start${parts.every((p) => p.compressed) ? ", compressed" : ", uncompressed"})`);
    return total;
  };
  const laptop = [
    { name: "document", ...(await measure(ui, `/api/draft?workspace=${W.a}`)) },
    { name: "/day", ...(await measure(ui, `/api/orders/day?workspace=${W.a}&date=${day}`)) },
    { name: "first page", ...(await measure(ui, `/api/orders?workspace=${W.a}&date=${day}`)) },
  ];
  const phone = await session("packerA");
  try {
    const unlocked = await pins(phone, "POST", { workspaceId: W.a, profileId: ali, pin: "2468" }, "/api/packer-session");
    assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
    const packerPage = await orderApi(phone, `/api/orders/packer?workspace=${W.a}&date=${day}`);
    assert.equal(packerPage.body.orders.length, 250);
    const packer = [
      { name: "document (packer projection)", ...(await measure(phone, `/api/draft?workspace=${W.a}`)) },
      { name: "packer page (250 AWBs)", ...(await measure(phone, `/api/orders/packer?workspace=${W.a}&date=${day}`)) },
    ];
    const l = show("laptop, supervisor first open", laptop);
    const p = show("packer phone first open", packer);
    // Design section 5: laptop ≈ 0.2–0.6 MB raw, 40–80 KB gzip; phone ≈ 70 KB raw, ≈ 10 KB gzip.
    assert.ok(laptop[1].raw < 60 * 1024, "the day's aggregates stay small");
    assert.ok(l.raw < 600 * 1024 && l.gzip < 120 * 1024, JSON.stringify(l));
    assert.ok(p.raw < 200 * 1024 && p.gzip < 40 * 1024, JSON.stringify(p));
    const first = await orderApi(phone, `/api/orders/packer?workspace=${W.a}&date=${day}`);
    const again = await orderApi(phone, `/api/orders/packer?workspace=${W.a}&date=${day}`, { "If-None-Match": first.etag });
    assert.equal(again.status, 304, "an unchanged packer page refreshes with no body");
  } finally {
    await phone.context.close();
  }
});
await ui.context.close();
await outD.context.close();
await packD.context.close();

await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
