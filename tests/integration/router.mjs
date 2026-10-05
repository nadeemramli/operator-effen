// Stand-in for Supabase's Kong gateway on a local stack: routes /auth/v1, /rest/v1 and
// /storage/v1 to the real GoTrue, PostgREST and Storage API processes, strips the
// prefix and answers CORS like the hosted gateway. It does not inspect or alter bodies.
import http from "node:http";

const [, , port, auth, rest, storage] = process.argv;
const routes = [
  ["/auth/v1", auth],
  ["/rest/v1", rest],
  ["/storage/v1", storage],
];
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
  "access-control-allow-headers":
    "authorization,apikey,content-type,x-client-info,x-upsert,cache-control,accept-profile,content-profile,prefer,range,x-supabase-api-version",
  "access-control-expose-headers": "content-range,content-length,etag",
};
http
  .createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    const route = routes.find(([prefix]) => req.url.startsWith(prefix + "/") || req.url === prefix);
    if (!route) {
      res.writeHead(404, cors);
      return res.end();
    }
    const target = new URL(route[1]);
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url.slice(route[0].length) || "/",
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { ...up.headers, ...cors });
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, cors);
      res.end();
    });
    req.pipe(upstream);
  })
  .listen(Number(port), "127.0.0.1");
