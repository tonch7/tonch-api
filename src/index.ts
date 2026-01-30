export interface Env {
  DB: D1Database;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    },
  });

const bad = (msg: string, status = 400) => json({ ok: false, error: msg }, status);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (request.method === "OPTIONS") return new Response("", { status: 204, headers: json({}).headers });

    // Health
    if (pathname === "/" && request.method === "GET") {
      return json({ ok: true, service: "comments-api" });
    }

    // GET /comments?limit=50&offset=0
    if (pathname === "/comments" && request.method === "GET") {
      const limit = clampInt(searchParams.get("limit"), 1, 200, 50);
      const offset = clampInt(searchParams.get("offset"), 0, 1_000_000, 0);

      const rows = await env.DB.prepare(
        `SELECT id, author, content, created_at
         FROM comments
         ORDER BY id DESC
         LIMIT ? OFFSET ?`
      ).bind(limit, offset).all();

      return json({ ok: true, items: rows.results });
    }

    // GET /comments/:id
    const mGet = pathname.match(/^\/comments\/(\d+)$/);
    if (mGet && request.method === "GET") {
      const id = Number(mGet[1]);
      const row = await env.DB.prepare(
        `SELECT id, author, content, created_at FROM comments WHERE id=?`
      ).bind(id).first();

      if (!row) return bad("not_found", 404);
      return json({ ok: true, item: row });
    }

    // POST /comments  { author, content }
    if (pathname === "/comments" && request.method === "POST") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return bad("invalid_json");
      }

      const author = String(body?.author ?? "").trim();
      const content = String(body?.content ?? "").trim();

      if (!author) return bad("author_required");
      if (!content) return bad("content_required");
      if (author.length > 80) return bad("author_too_long");
      if (content.length > 2000) return bad("content_too_long");

      const res = await env.DB.prepare(
        `INSERT INTO comments (author, content) VALUES (?, ?)`
      ).bind(author, content).run();

      // res.meta.last_row_id existe no D1
      const id = (res as any).meta?.last_row_id;

      return json({ ok: true, id }, 201);
    }

    // DELETE /comments/:id
    const mDel = pathname.match(/^\/comments\/(\d+)$/);
    if (mDel && request.method === "DELETE") {
      const id = Number(mDel[1]);

      const r = await env.DB.prepare(`DELETE FROM comments WHERE id=?`).bind(id).run();
      const changes = (r as any).meta?.changes ?? 0;

      if (!changes) return bad("not_found", 404);
      return json({ ok: true });
    }

    return bad("not_found", 404);
  },
};

function clampInt(v: string | null, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return Math.max(min, Math.min(max, i));
}
