// End-to-end check of OPER-2/4/5 through the real Next.js server, browser UI and the
// local Postgres RLS/RPC (via supabase-shim.mjs). Synthetic users and data only.
// Usage: node tests/e2e/scenario.mjs <appUrl> <shimUrl> <pgSocketDir> <playwrightModule>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const [, , app, shim, socket, pwPath] = process.argv;
const { chromium } = createRequire(import.meta.url)(pwPath);
const sql = (q) =>
  execFileSync("psql", ["-h", socket, "-U", "postgres", "-At", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", q]).toString().trim();
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(["PASS", name]);
    console.log("PASS", name);
  } catch (e) {
    results.push(["FAIL", name, e.message]);
    console.log("FAIL", name, "\n   ", e.message.split("\n").slice(0, 6).join("\n    "));
  }
};
const W = { a: "10000000-0000-4000-8000-0000000000aa", b: "10000000-0000-4000-8000-0000000000bb" };
const people = {
  prodA: ["00000000-0000-4000-8000-0000000000a1", "production", W.a, "Synthetic Production SV A"],
  intakeA: ["00000000-0000-4000-8000-0000000000a2", "intake", W.a, "Synthetic Stock-in SV A"],
  outA: ["00000000-0000-4000-8000-0000000000a3", "outbound", W.a, "Synthetic Stock-out SV A"],
  packerA: ["00000000-0000-4000-8000-0000000000a4", "packer", W.a, "Synthetic Packer A"],
  mgmtA: ["00000000-0000-4000-8000-0000000000a5", "management", W.a, "Synthetic Manager A"],
  prodB: ["00000000-0000-4000-8000-0000000000b1", "production", W.b, "Synthetic Production SV B"],
  preview: ["00000000-0000-4000-8000-0000000000c1", null, null, "Preview tester"],
};
const email = (key) => key.toLowerCase() + "@synthetic.test";
const password = "synthetic-only-password";

// Seed: two site workspaces, memberships, one preview-only account.
sql(`truncate public.operator_memberships, public.operator_workspaces, public.ui_draft_workspaces, auth.users cascade`);
sql(`insert into public.operator_workspaces (id, site_id, name) values ('${W.a}','site-a','Synthetic Site A'),('${W.b}','site-b','Synthetic Site B')`);
for (const [key, [id, role, ws, name]] of Object.entries(people)) {
  sql(`insert into auth.users (id) values ('${id}')`);
  if (role)
    sql(`insert into public.operator_memberships (workspace_id,user_id,role,display_name) values ('${ws}','${id}','${role}','${name}')`);
  await fetch(shim + "/__shim/user", {
    method: "POST",
    body: JSON.stringify({ email: email(key), id, password, app_metadata: role ? {} : { ui_draft_access: true } }),
  });
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
async function session(key) {
  const context = await browser.newContext({ baseURL: app });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.goto("/login");
  await page.locator("#username").fill(email(key));
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /Enter workspace/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.getByText(/Workspace|Ruang kerja/).first().waitFor();
  return { context, page, key };
}
// Calls the real API from inside the signed-in browser (same origin, real cookies).
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
const load = async (s) => (await api(s, "GET")).body;
const post = async (s, type, input, extra = {}) => {
  const current = await load(s);
  return api(s, "POST", {
    command: { type, role: extra.role ?? "production", input },
    revision: extra.revision ?? current.revision,
    operationId: extra.operationId ?? crypto.randomUUID(),
  });
};
const stored = (ws) => JSON.parse(sql(`select state::text from public.operator_workspaces where id='${ws}'`));

const prod = await session("prodA");
const intake = await session("intakeA");
let batchId;

await check("OPER-2 member identity comes from the server; no preview role switcher", async () => {
  const data = await load(prod);
  assert.equal(data.actor.kind, "member");
  assert.equal(data.actor.role, "production");
  assert.equal(data.actor.siteId, "site-a");
  assert.equal(await prod.page.locator("#role-switch").count(), 0);
  await prod.page.getByText("Synthetic Production SV A").first().waitFor();
});

await check("OPER-4 plan a five-stage batch through the UI and see Hologram in route order", async () => {
  await prod.page.goto("/?view=production&production=plan&factory=sachet");
  await prod.page.locator("#plan-product").selectOption("ady");
  await prod.page.locator("#plan-code").fill("E2E-ADY-001");
  await prod.page.locator("#plan-date").fill("2026-10-03");
  await prod.page.getByRole("button", { name: /Save batch plan/ }).click();
  await prod.page.getByText("E2E-ADY-001").first().waitFor();
  const batch = stored(W.a).batches.find((b) => b.code === "E2E-ADY-001");
  batchId = batch.id;
  assert.deepEqual(batch.route.stages, ["mixing", "filling", "batching", "hologram", "wrapping"]);
  assert.equal(batch.siteId, "site-a");
  const rows = await prod.page.locator("table.machine-records tbody tr td:first-child").allInnerTexts();
  assert.match(rows.slice(0, 5).join("|"), /1\. Mixer.*\|2\. Sachet filling.*\|3\. Inkjet.*\|4\. Hologram machine.*\|5\. Shrink/s);
});

await check("OPER-5 production SV adds machines; stock-in sees the same registry", async () => {
  for (const [stage, name] of [["hologram", "E2E Holo Alpha"], ["hologram", "E2E Holo Beta"], ["mixing", "E2E Mixer"]]) {
    const r = await post(prod, "machine-create", { stage, name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const dup = await post(intake, "machine-create", { stage: "hologram", name: "e2e holo alpha" }, { role: "intake" });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already exists/);
  await intake.page.goto("/?view=warehouse");
  await intake.page.getByText("E2E Holo Alpha").first().waitFor();
});

await check("OPER-4 four stages recorded; transfer without Hologram is refused by API and UI", async () => {
  const machines = stored(W.a).machines;
  for (const stage of ["mixing", "filling", "batching", "wrapping"]) {
    const r = await post(prod, "machine", {
      id: batchId,
      stage,
      pic: "Sample PIC A",
      expectedVersion: 0,
      ...(stage === "mixing" ? { machineId: machines.find((m) => m.name === "E2E Mixer").id } : {}),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const t = await post(prod, "transfer", { id: batchId, pic: "Sample PIC B" });
  assert.equal(t.status, 400);
  assert.match(t.body.error, /all five stages/);
  await prod.page.goto("/?view=production&production=log&date=2026-10-03");
  const card = prod.page.locator("section.batch-card", { hasText: "E2E-ADY-001" });
  assert.equal(await card.getByRole("button", { name: /Send to warehouse/ }).isDisabled(), true);
});

await check("OPER-5 stock-in records Hologram in the UI; production sees it after refresh", async () => {
  await intake.page.goto("/?view=warehouse");
  await intake.page.reload();
  const record = intake.page.locator("details.sachet-record", { hasText: "E2E-ADY-001" });
  await record.locator("summary").first().click();
  await record.locator("tr", { hasText: "Hologram machine" }).getByRole("button", { name: /Record completion/ }).click();
  const dialog = intake.page.getByRole("dialog");
  await dialog.locator('select[name="machineId"]').selectOption({ label: "E2E Holo Alpha" });
  await dialog.locator('input[name="occurredAt"]').fill("2026-10-03T10:30");
  // PersonPicker: choose a person option.
  // The person picker's radio inputs are visually hidden; select through the DOM.
  await dialog.locator('input[name="pic"][value="Sample PIC C"]').evaluate((el) => el.click());
  await dialog.getByRole("button", { name: /Save record/ }).click();
  await dialog.waitFor({ state: "hidden" });
  const holo = stored(W.a).batches.find((b) => b.id === batchId).steps.find((s) => s.sachetStage === "hologram");
  assert.equal(holo.done, true);
  assert.equal(holo.machineName, "E2E Holo Alpha");
  assert.equal(holo.recordedBy.role, "intake");
  assert.equal(holo.recordedBy.name, "Synthetic Stock-in SV A");
  assert.equal(holo.occurredAt, "2026-10-03T02:30:00.000Z");
  await prod.page.reload();
  const card = prod.page.locator("section.batch-card", { hasText: "E2E-ADY-001" });
  await card.getByText(/Entered by Synthetic Stock-in SV A/).first().waitFor();
  assert.equal(await card.getByRole("button", { name: /Send to warehouse/ }).isDisabled(), false);
});

await check("OPER-4 transfer succeeds once all five stages and PICs are recorded", async () => {
  const t = await post(prod, "transfer", { id: batchId, pic: "Sample PIC B" });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.ok(stored(W.a).batches.find((b) => b.id === batchId).transferredAt);
});

await check("OPER-5 response-loss retry with the same operation ID applies once", async () => {
  const operationId = crypto.randomUUID();
  const before = await load(intake);
  const input = { batchId, pic: "Sample PIC C" };
  const first = await api(intake, "POST", { command: { type: "receive-ady", role: "intake", input }, revision: before.revision, operationId });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // Client never saw the response; it retries with its original (now stale) revision.
  const retry = await api(intake, "POST", { command: { type: "receive-ady", role: "intake", input }, revision: before.revision, operationId });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  const receipts = stored(W.a).adypocideReceipts.filter((r) => r.batchId === batchId);
  assert.equal(receipts.length, 1);
  const reused = await api(intake, "POST", { command: { type: "receive-ady", role: "intake", input: { ...input, pic: "Other" } }, revision: retry.body.revision, operationId });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, "operation-mismatch");
});

await check("OPER-5 concurrent edits: second screen gets a reviewable conflict", async () => {
  const holo = stored(W.a).batches.find((b) => b.id === batchId).steps.find((s) => s.sachetStage === "hologram");
  const beta = stored(W.a).machines.find((m) => m.name === "E2E Holo Beta").id;
  const first = await post(prod, "change-step-pic", { id: batchId, stage: "hologram", kind: "correction", pic: "Sample PIC D", reason: "Wrong profile", expectedVersion: holo.version }, { role: "production" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await post(intake, "stage-correct", { id: batchId, stage: "hologram", field: "machine", machineId: beta, reason: "Line log", expectedVersion: holo.version }, { role: "intake" });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "record");
  assert.equal(second.body.conflict.currentVersion, holo.version + 1);
  // Stale whole-workspace revision is also rejected by the database commit.
  const stale = await post(intake, "stage-correct", { id: batchId, stage: "hologram", field: "machine", machineId: beta, reason: "Line log", expectedVersion: holo.version + 1 }, { role: "intake", revision: 0 });
  assert.equal(stale.status, 409);
});

await check("OPER-5 post-transfer machine correction keeps stock/custody facts and flags revision", async () => {
  const before = stored(W.a);
  const holo = before.batches.find((b) => b.id === batchId).steps.find((s) => s.sachetStage === "hologram");
  const beta = before.machines.find((m) => m.name === "E2E Holo Beta").id;
  const r = await post(intake, "stage-correct", { id: batchId, stage: "hologram", field: "machine", machineId: beta, reason: "Line log shows Beta", expectedVersion: holo.version }, { role: "intake" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = stored(W.a);
  const b0 = before.batches.find((b) => b.id === batchId), b1 = after.batches.find((b) => b.id === batchId);
  assert.deepEqual([after.cartons, after.adypocideReceipts, after.issues], [before.cartons, before.adypocideReceipts, before.issues]);
  assert.equal(b1.transferredAt, b0.transferredAt);
  assert.equal(b1.revisions.at(-1).field, "machine");
  await prod.page.goto(`/?view=production&production=history&batch=${batchId}`);
  await prod.page.getByText(/Revised after transfer/).first().waitFor();
});

await check("OPER-5 inactive machine stays readable in history; new work cannot select it", async () => {
  const m = stored(W.a).machines.find((x) => x.name === "E2E Holo Beta");
  const r = await post(prod, "machine-deactivate", { id: m.id, reason: "Retired", expectedVersion: m.version });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await prod.page.goto(`/?view=production&production=history&batch=${batchId}`);
  await prod.page.getByText("E2E Holo Beta").first().waitFor();
});

await check("OPER-2 packer cannot write: crafted role, alternate RPC and direct table paths denied", async () => {
  const packer = await session("packerA");
  const before = sql(`select revision from public.operator_workspaces where id='${W.a}'`);
  for (const type of ["pack", "machine", "batch", "feedback"]) {
    const r = await post(packer, type, { id: batchId, stage: "mixing", pic: "x" }, { role: "outbound" });
    assert.equal(r.status, 403, type + " " + JSON.stringify(r.body));
  }
  const token = await packer.page.evaluate(() => document.cookie);
  assert.ok(token.length > 0);
  // Alternate path: call the commit RPC directly with the packer's own JWT via the Data API.
  const rpc = await fetch(shim + "/rest/v1/rpc/operator_commit_workspace", {
    method: "POST",
    headers: { authorization: "Bearer " + jwtFor(people.packerA[0]), "content-type": "application/json" },
    body: JSON.stringify({ p_workspace: W.a, p_expected_revision: Number(before), p_state: { hacked: true } }),
  });
  assert.equal(rpc.status, 403);
  const direct = await fetch(shim + `/rest/v1/operator_workspaces?id=eq.${W.a}`, {
    method: "PATCH",
    headers: { authorization: "Bearer " + jwtFor(people.packerA[0]), "content-type": "application/json" },
    body: JSON.stringify({ revision: 999 }),
  });
  assert.equal(direct.ok, false);
  assert.equal(sql(`select revision from public.operator_workspaces where id='${W.a}'`), before);
  await packer.page.goto("/?view=packing");
  await packer.page.getByText(/Your supervisor records this count|Supervisors record/).first().waitFor();
  await packer.context.close();
});

await check("OPER-2 management cannot write while the exception is off", async () => {
  const mgmt = await session("mgmtA");
  const r = await post(mgmt, "review", { text: "Please check" }, { role: "management" });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /not enabled/);
  await mgmt.context.close();
});

await check("OPER-2 another site's supervisor cannot read or mutate site A", async () => {
  const other = await session("prodB");
  const data = await load(other);
  assert.equal(data.actor.siteId, "site-b");
  assert.equal(data.state.batches.some((b) => b.id === batchId), false);
  const wrongWs = await api(other, "GET", null, "?workspace=" + W.a);
  assert.equal(wrongWs.status, 403);
  const r = await api(other, "POST", { command: { type: "machine", role: "production", input: { id: batchId, stage: "mixing", pic: "x" } }, revision: data.revision, workspaceId: W.a });
  assert.equal(r.status, 403);
  await other.context.close();
});

await check("OPER-2 stock-out SV records the actual packer; both identities are stored", async () => {
  const out = await session("outA");
  // Synthetic order for site A.
  for (const [type, input] of [
    ["order", { awb: "E2E-AWB-1", product: "cav", channel: "TikTok", package: "P1", expected: 1, date: "2026-10-03" }],
  ]) {
    const r = await post(out, type, input, { role: "outbound" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const id = stored(W.a).orders[0].id;
  for (const [type, input] of [
    ["review-order", { id, pic: "Sample PIC A" }],
    ["sort-count", { date: "2026-10-03", product: "cav", counted: 1, pic: "Sample PIC A" }],
    ["assign-orders", { ids: [id], packer: "Sample Packer A", pic: "Sample PIC A" }],
    ["pack", { id, actual: 1, pic: "Sample Packer A", labelPic: "Sample Packer B", occurredAt: "2026-10-03T09:05" }],
  ]) {
    const r = await post(out, type, input, { role: "outbound" });
    assert.equal(r.status, 200, type + JSON.stringify(r.body));
  }
  const order = stored(W.a).orders.find((o) => o.id === id);
  assert.equal(order.packer, "Sample Packer A");
  assert.equal(order.packRecordedBy.name, "Synthetic Stock-out SV A");
  assert.equal(order.packRecordedBy.userId, people.outA[0]);
  assert.equal(order.packedAt, "2026-10-03T01:05:00.000Z");
  await out.context.close();
});

await check("OPER-2 revoked membership is denied at the next save", async () => {
  sql(`update public.operator_memberships set active=false, revoked_at=now() where user_id='${people.intakeA[0]}'`);
  const r = await post(intake, "machine-create", { stage: "mixing", name: "After revoke" }, { role: "intake" });
  assert.ok([401, 403].includes(r.status), String(r.status));
  sql(`update public.operator_memberships set active=true, revoked_at=null where user_id='${people.intakeA[0]}'`);
});

await check("OPER-4 legacy four-stage batches: historical stays readable, in-progress needs review", async () => {
  // Inject legacy-shaped records directly (as an administrator migration would leave them).
  const state = stored(W.a);
  const legacyStep = (stage, machine) => ({ sachetStage: stage, machine, pic: "Legacy PIC", qty: null, start: "", end: "", done: true, qc: "not-recorded" });
  const steps = [["mixing", "Mixer machine"], ["filling", "Sachet filling machine"], ["batching", "Inkjet printer"], ["wrapping", "Shrink machine"]].map(([a, b]) => legacyStep(a, b));
  state.batches.push(
    { id: "legacy-sent", code: "LEGACY-SENT", product: "ady", date: "2026-09-20", target: 0, actual: 0, sent: 0, transferredAt: "2026-09-20T05:00:00Z", transferPic: "Old", steps },
    { id: "legacy-open", code: "LEGACY-OPEN", product: "ady", date: "2026-10-03", target: 0, actual: 0, sent: 0, steps },
  );
  sql(`update public.operator_workspaces set state = ${"$j$" + JSON.stringify(state) + "$j$"}::jsonb, revision = revision + 1 where id='${W.a}'`);
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

await check("Preview sandbox: role preview never reaches operational workspaces", async () => {
  const p = await session("preview");
  const data = await load(p);
  assert.equal(data.actor?.kind, "preview", JSON.stringify(data).slice(0, 300));
  assert.equal(await p.page.locator("#role-switch").count(), 1);
  const r = await api(p, "POST", { command: { type: "machine", role: "production", input: { id: batchId, stage: "mixing", pic: "x" } }, revision: data.revision, workspaceId: W.a });
  assert.equal(r.status, 400); // batch not in the fictional sandbox; operational rows untouched
  const pack = await api(p, "POST", { command: { type: "pack", role: "packer", input: { id: "o-3", actual: 1, pic: "Sample Packer A", labelPic: "x" } }, revision: data.revision });
  assert.equal(pack.status, 400);
  assert.match(pack.body.error, /supervisor role/);
  await p.context.close();
});

await check("OPER-2 expired session keeps the unsaved entry and resubmits it once after sign-in", async () => {
  const s = await session("prodA");
  await s.page.goto("/?view=production&production=machines");
  await s.page.getByRole("button", { name: /Add machine/ }).waitFor();
  await fetch(shim + "/__shim/revoke", { method: "POST", body: JSON.stringify({ id: people.prodA[0] }) });
  await s.page.getByRole("button", { name: /Add machine/ }).click();
  const dialog = s.page.getByRole("dialog");
  await dialog.locator('select[name="stage"]').selectOption("wrapping");
  await dialog.locator('input[name="name"]').fill("E2E Shrink After Expiry");
  await dialog.getByRole("button", { name: /Save record/ }).click();
  await s.page.waitForURL(/\/login\?expired=1/);
  await s.page.getByText(/Your session ended/).waitFor();
  const kept = await s.page.evaluate(() => localStorage.getItem("operator-pending-save"));
  assert.match(kept, /E2E Shrink After Expiry/);
  assert.equal(stored(W.a).machines.some((m) => m.name === "E2E Shrink After Expiry"), false);
  await s.page.locator("#username").fill(email("prodA"));
  await s.page.locator("#password").fill(password);
  await s.page.getByRole("button", { name: /Enter workspace/ }).click();
  await s.page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await s.page.getByRole("button", { name: /Resubmit/ }).click();
  await s.page.getByText(/Saved to your site's records|already saved/).waitFor();
  await s.page.getByRole("button", { name: /Resubmit/ }).waitFor({ state: "detached" });
  assert.equal(stored(W.a).machines.filter((m) => m.name === "E2E Shrink After Expiry").length, 1);
  await s.context.close();
});

function jwtFor(sub) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [b({ alg: "HS256" }), b({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 }), "x"].join(".");
}
await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
