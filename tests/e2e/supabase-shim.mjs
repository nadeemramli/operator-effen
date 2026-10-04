// Local-only stand-in for the Supabase Auth and Data API endpoints this app calls.
// Every data request runs against a disposable Postgres as the `authenticated` role with
// the caller's JWT claims, so the real migrations' RLS policies and commit RPC decide
// access. Synthetic users only. Never point this at, or use it instead of, a real project.
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const [, , port = "54399", socketDir] = process.argv;
const users = new Map(); // email -> { id, password, app_metadata }
const revoked = new Set(); // user ids whose sessions were ended
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (user) =>
  [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({
      sub: user.id,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      app_metadata: user.app_metadata,
      session_id: randomUUID(),
    }),
    "local-shim",
  ].join(".");
const claimsOf = (req) => {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  try {
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    if (!claims.sub || revoked.has(claims.sub)) return null;
    return claims;
  } catch {
    return null;
  }
};
const userJson = (u) => ({
  id: u.id,
  aud: "authenticated",
  role: "authenticated",
  email: u.email,
  app_metadata: u.app_metadata,
  user_metadata: {},
  created_at: "2026-10-01T00:00:00Z",
});
const tag = () => "$q" + randomUUID().replaceAll("-", "") + "$";
const lit = (value) => {
  const t = tag();
  return t + String(value) + t;
};
function psql(sql) {
  return new Promise((resolve) => {
    const child = spawn(
      "psql",
      ["-h", socketDir, "-U", "postgres", "-d", "postgres", "-At", "-X", "-q", "-v", "ON_ERROR_STOP=1"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out: out.trim(), err }));
    child.stdin.end("\\set VERBOSITY verbose\n" + sql);
  });
}
async function asUser(claims, query) {
  const result = await psql(`begin;
do $do$ begin
  perform set_config('request.jwt.claim.sub', ${lit(claims?.sub ?? "")}, true);
  perform set_config('request.jwt.claims', ${lit(JSON.stringify(claims ?? {}))}, true);
end $do$;
set local role ${claims ? "authenticated" : "anon"};
${/^\s*(insert|update)/i.test(query) ? `with t as (${query}) select coalesce(json_agg(t), '[]'::json) from t;` : `select coalesce(json_agg(t), '[]'::json) from (${query}) t;`}
commit;
`);
  if (result.code !== 0) {
    const m = result.err.match(/ERROR:\s+([0-9A-Z]{5}):\s+(.*)/);
    return { error: { code: m?.[1] ?? "XX000", message: m?.[2] ?? result.err } };
  }
  return { rows: JSON.parse(result.out.split("\n").at(-1) || "[]") };
}
const filters = (params) =>
  [...params]
    .filter(([k]) => !["select", "order", "limit", "columns"].includes(k))
    .map(([k, v]) => {
      if (!/^[a-z_]+$/.test(k)) throw new Error("bad column");
      if (v === "is.null") return `${k} is null`;
      if (v.startsWith("eq.")) return `${k} = ${lit(v.slice(3))}`;
      throw new Error("unsupported filter " + v);
    })
    .join(" and ") || "true";
const columns = (select) => {
  const cols = (select || "*").split(",");
  if (!cols.every((c) => /^[a-z_*]+$/.test(c))) throw new Error("bad select");
  return cols.join(",");
};
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const pgStatus = (code) =>
  code === "42501" ? 403 : code === "28000" ? 401 : code === "42P01" ? 404 : 400;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://shim");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    try {
      // Test control endpoints (local only).
      if (url.pathname === "/__shim/user") {
        users.set(body.email, { ...body, app_metadata: body.app_metadata ?? {} });
        revoked.delete(body.id);
        return send(res, 204);
      }
      if (url.pathname === "/__shim/revoke") {
        revoked.add(body.id);
        return send(res, 204);
      }
      if (url.pathname === "/auth/v1/token") {
        const grant = url.searchParams.get("grant_type");
        let user;
        if (grant === "password") {
          user = users.get(body.email);
          if (!user || user.password !== body.password)
            return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials", code: "invalid_credentials" });
          revoked.delete(user.id);
        } else {
          user = [...users.values()].find((u) => body.refresh_token?.startsWith(u.id + ":"));
          if (!user || revoked.has(user.id))
            return send(res, 400, { error: "invalid_grant", code: "refresh_token_not_found" });
        }
        return send(res, 200, {
          access_token: jwt(user),
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: user.id + ":" + randomUUID(),
          user: userJson(user),
        });
      }
      if (url.pathname === "/auth/v1/user") {
        const claims = claimsOf(req);
        const user = claims && [...users.values()].find((u) => u.id === claims.sub);
        if (!user) return send(res, 403, { code: "session_not_found", message: "Session not found" });
        return send(res, 200, userJson(user));
      }
      if (url.pathname === "/auth/v1/logout") return send(res, 204);
      const claims = claimsOf(req);
      const rest = url.pathname.match(/^\/rest\/v1\/(rpc\/)?([a-z_]+)$/);
      if (!rest) return send(res, 404, { message: "not found" });
      const [, rpc, name] = rest;
      let result;
      if (rpc) {
        if (name !== "operator_commit_workspace") return send(res, 404, { code: "PGRST202" });
        result = await asUser(
          claims,
          `select * from public.operator_commit_workspace(${lit(body.p_workspace)}::uuid, ${Number(body.p_expected_revision)}, ${lit(JSON.stringify(body.p_state))}::jsonb)`,
        );
      } else if (req.method === "GET" && name === "operator_memberships") {
        result = await asUser(
          claims,
          `select m.workspace_id, m.role, m.staff_profile_id, m.display_name,
             (select row_to_json(w) from (select site_id, name, write_policy from public.operator_workspaces x where x.id = m.workspace_id) w) as operator_workspaces
           from public.operator_memberships m where ${filters(url.searchParams)}`,
        );
      } else if (req.method === "GET") {
        result = await asUser(
          claims,
          `select ${columns(url.searchParams.get("select"))} from public.${name} where ${filters(url.searchParams)}`,
        );
      } else if (req.method === "POST") {
        const keys = Object.keys(body);
        result = await asUser(
          claims,
          `insert into public.${name} (${keys.join(",")}) values (${keys
            .map((k) => (typeof body[k] === "object" ? lit(JSON.stringify(body[k])) + "::jsonb" : lit(body[k])))
            .join(",")}) returning ${columns(url.searchParams.get("select"))}`,
        );
      } else if (req.method === "PATCH") {
        result = await asUser(
          claims,
          `update public.${name} set ${Object.entries(body)
            .map(([k, v]) => `${k} = ${typeof v === "object" ? lit(JSON.stringify(v)) + "::jsonb" : lit(v)}`)
            .join(", ")} where ${filters(url.searchParams)} returning ${columns(url.searchParams.get("select"))}`,
        );
      } else return send(res, 405, { message: "method" });
      if (result.error) {
        const code = result.error.code === "42P01" ? "PGRST205" : result.error.code;
        return send(res, pgStatus(result.error.code), { ...result.error, code, details: null, hint: null });
      }
      if ((req.headers.accept ?? "").includes("vnd.pgrst.object")) {
        if (result.rows.length !== 1)
          return send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: null, hint: null });
        return send(res, 200, result.rows[0]);
      }
      return send(res, 200, result.rows);
    } catch (e) {
      return send(res, 400, { code: "SHIM", message: String(e) });
    }
  })
  .listen(Number(port), "127.0.0.1", () => console.log("shim listening " + port));
