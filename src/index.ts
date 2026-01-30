export interface Env {
  DB: D1Database;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function text(msg: string, status = 200) {
  return new Response(msg, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function clampInt(v: string | null, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return Math.max(min, Math.min(max, i));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight CORS (browser)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health
    if (path === "/" && request.method === "GET") {
      return json({ ok: true, service: "comments-api" });
    }

    // GET /comments?limit=50&offset=0
    if (path === "/comments" && request.method === "GET") {
      const limit = clampInt(url.searchParams.get("limit"), 1, 200, 50);
      const offset = clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0);

      const rows = await env.DB.prepare(
        `SELECT id, author, content, created_at
         FROM comments
         ORDER BY id DESC
         LIMIT ? OFFSET ?`
      ).bind(limit, offset).all();

      return json({ ok: true, items: rows.results });
    }

    // GET /comments/:id
    const m = path.match(/^\/comments\/(\d+)$/);
    if (m && request.method === "GET") {
      const id = Number(m[1]);
      const row = await env.DB.prepare(
        `SELECT id, author, content, created_at FROM comments WHERE id=?`
      ).bind(id).first();

      if (!row) return json({ ok: false, error: "not_found" }, 404);
      return json({ ok: true, item: row });
    }

    // POST /comments  { author, content }
    if (path === "/comments" && request.method === "POST") {
      let body: any = null;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "invalid_json" }, 400);
      }

      const author = String(body?.author ?? "").trim();
      const content = String(body?.content ?? "").trim();

      if (!author) return json({ ok: false, error: "author_required" }, 400);
      if (!content) return json({ ok: false, error: "content_required" }, 400);
      if (author.length > 80) return json({ ok: false, error: "author_too_long" }, 400);
      if (content.length > 2000) return json({ ok: false, error: "content_too_long" }, 400);

      const res = await env.DB.prepare(
        `INSERT INTO comments (author, content) VALUES (?, ?)`
      ).bind(author, content).run();

      const id = (res as any).meta?.last_row_id ?? null;
      return json({ ok: true, id }, 201);
    }

    // DELETE /comments/:id
    if (m && request.method === "DELETE") {
      const id = Number(m[1]);
      const r = await env.DB.prepare(`DELETE FROM comments WHERE id=?`).bind(id).run();
      const changes = (r as any).meta?.changes ?? 0;
      if (!changes) return json({ ok: false, error: "not_found" }, 404);
      return json({ ok: true });
    }

    // Fallback (para debug)
    return json({ ok: false, error: "not_found", path, method: request.method }, 404);
  },
};
