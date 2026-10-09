// Integration scenarios for OPER-2/4/5 against real Supabase components (GoTrue, PostgREST,
// Storage API, Postgres) and the production Next.js build, driven through Chromium.
// Synthetic users, sites and PDFs only. Usage (see run-real-stack.sh):
//   node scenario.mjs <appUrl> <supabaseUrl> <anonKey> <serviceKey> <pgPort> <playwrightModule>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { parsePages } from "../../apps/web/src/lib/awb-import.ts";

const [, , app, supabase, anonKey, serviceKey, pgPort, pwPath] = process.argv;
const { chromium } = createRequire(import.meta.url)(pwPath);
const sql = (q) =>
  execFileSync("psql", ["-h", "127.0.0.1", "-p", pgPort, "-U", "postgres", "-At", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", q])
    .toString()
    .trim();
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
      return { status: res.status, body: await res.json().catch(() => null) };
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
  const rows = await prod.page.locator("section.batch-card", { hasText: "INT-ADY-001" }).locator("table.machine-records tbody tr td:first-child").allInnerTexts();
  assert.match(rows.join("|"), /1\. Mixer.*\|2\. Sachet filling.*\|3\. Inkjet.*\|4\. Hologram machine.*\|5\. Shrink/s);
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
  for (const stage of ["mixing", "filling", "batching", "wrapping"]) {
    const r = await post(prod, "machine", {
      id: batchId, stage, pic: "Sample PIC A", expectedVersion: 0,
      ...(stage === "mixing" ? { machineId: machines.find((m) => m.name === "INT Mixer").id } : {}),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const before = revision(W.a);
  const cases = [
    [prod, "transfer", { id: batchId, pic: "Sample PIC B" }, /all five stages/, "production"],
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
  await card.getByText(/Entered by Synthetic Stock-in SV A/).first().waitFor();
  assert.equal(await card.getByRole("button", { name: /Send to warehouse/ }).isDisabled(), false);
});

await check("A: transfer succeeds once all five stages and PICs exist", async () => {
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

await check("A: concurrent saves — one wins, the other gets a reviewable conflict", async () => {
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

await check("A: post-transfer correction keeps stock/custody facts and flags the revision", async () => {
  const before = stored(W.a);
  const holo = before.batches.find((b) => b.id === batchId).steps.find((s) => s.sachetStage === "hologram");
  const target = before.machines.find((m) => m.name === (holo.machineName === "INT Holo Beta" ? "INT Holo Alpha" : "INT Holo Beta")).id;
  const r = await post(intake, "stage-correct", { id: batchId, stage: "hologram", field: "machine", machineId: target, reason: "Line log shows the other machine", expectedVersion: holo.version }, { role: "intake" });
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

let sourcePath, sourceBytes;
await check("B: office admin uploads a site source, imports and releases it", async () => {
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
  const saved = await post(a, "import-save", { batch }, { ws: W.a, role: "admin" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const released = await post(a, "import-release", { id: batch.id }, { ws: W.a, role: "admin" });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const imported = stored(W.a).orders.find((o) => o.awb === "NVMYINT000001");
  assert.ok(imported);
  assert.equal(stored(W.a).events.find((e) => e.entity === imported.id).recorder.userId, people.admin.id);
  const forged = await post(a, "import-save", { batch: { ...batch, id: randomUUID(), files: [{ ...fileRef, path: `${W.b}/${hash}.pdf` }] } }, { ws: W.a, role: "admin" });
  assert.equal(forged.status, 400);
  const notUploaded = "e".repeat(64);
  const missing = await post(a, "import-save", {
    batch: {
      ...batch,
      id: randomUUID(),
      files: [{ ...fileRef, id: notUploaded, path: `${W.a}/${notUploaded}.pdf` }],
      rows: parsePages([{ file: notUploaded, page: 1, method: "text", text: "Ninja Van\nNVMYINT000002\nOrder: #INT-ORDER-2\nProducts:\n1x Cavernosil [cave04]" }], "Luxana", "INT STORE"),
    },
  }, { ws: W.a, role: "admin" });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /was not saved/);
  const adminProd = await post(a, "batch", { product: "cav", code: "ADMIN-1", date: "2026-10-03", target: 1 }, { ws: W.a, role: "admin" });
  assert.equal(adminProd.status, 403);
  await a.context.close();
});

await check("B: authorized colleagues open the site source; others and guessed paths get nothing", async () => {
  const out = await session("outA");
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
  const text = JSON.stringify(stored(W.a));
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
await outC.context.close();
await packers.context.close();

await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
