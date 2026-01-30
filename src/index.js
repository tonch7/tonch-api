export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      // Health
      if (path === "/" && request.method === "GET") {
        return json({ ok: true, service: "comments-api" });
      }

      // GET /comments
      if (path === "/comments" && request.method === "GET") {
        const limit = clampInt(url.searchParams.get("limit"), 1, 200, 50);
        const offset = clampInt(url.searchParams.get("offset"), 0, 1000000, 0);

        if (!env.DB) return json({ ok: false, error: "DB_binding_missing" }, 500);

        const rows = await env.DB.prepare(
          `SELECT id, author, content, created_at
           FROM comments
           ORDER BY id DESC
           LIMIT ? OFFSET ?`
        ).bind(limit, offset).all();

        return json({ ok: true, items: rows.results || [] });
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

      // POST /comments
      if (path === "/comments" && request.method === "POST") {
        let body;
        try { body = await request.json(); }
        catch { return json({ ok: false, error: "invalid_json" }, 400); }

        const author = String(body?.author ?? "").trim();
        const content = String(body?.content ?? "").trim();

        if (!author) return json({ ok: false, error: "author_required" }, 400);
        if (!content) return json({ ok: false, error: "content_required" }, 400);

        const res = await env.DB.prepare(
          `INSERT INTO comments (author, content) VALUES (?, ?)`
        ).bind(author, content).run();

        const id = res?.meta?.last_row_id ?? null;
        return json({ ok: true, id }, 201);
      }

      // DELETE /comments/:id
      const md = path.match(/^\/comments\/(\d+)$/);
      if (md && request.method === "DELETE") {
        const id = Number(md[1]);
        const r = await env.DB.prepare(`DELETE FROM comments WHERE id=?`).bind(id).run();
        const changes = r?.meta?.changes ?? 0;
        if (!changes) return json({ ok: false, error: "not_found" }, 404);
        return json({ ok: true });
      }

      return json({ ok: false, error: "not_found", path, method: request.method }, 404);
    } catch (e) {
      return json({ ok: false, error: "worker_exception", detail: String(e?.message || e) }, 500);
    }
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() }
  });
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return Math.max(min, Math.min(max, i));
}
