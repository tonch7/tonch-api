export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });

    if (method === "OPTIONS") return json({ ok: true }, 204);

    try {
      if (!env.DB) return json({ ok: false, error: "DB_binding_missing" }, 500);

      // ✅ UMA TABELA SÓ (sempre esse nome)
      await env.DB.exec(`
        CREATE TABLE IF NOT EXISTS installations (
          machine_id TEXT PRIMARY KEY,
          first_seen_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_seen_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          activated INTEGER DEFAULT 0,
          blocked   INTEGER DEFAULT 0,
          expires_at TEXT,
          notes TEXT
        );
      `);

      const nowIso = () => new Date().toISOString();

      // GET /
      if (path === "/" && method === "GET") {
        return json({ ok: true, service: "tonch-licensing-api", ts: nowIso() });
      }

      // POST /register_install  { machine_id }
      if (path === "/register_install" && method === "POST") {
        const body = await request.json().catch(() => null);
        const machine_id = (body?.machine_id || "").trim();
        if (!machine_id) return json({ ok: false, error: "machine_id_required" }, 400);

        await env.DB.prepare(`
          INSERT INTO installations (machine_id, first_seen_at, last_seen_at, activated, blocked)
          VALUES (?, ?, ?, 0, 0)
          ON CONFLICT(machine_id) DO UPDATE SET last_seen_at=excluded.last_seen_at
        `).bind(machine_id, nowIso(), nowIso()).run();

        return json({ ok: true });
      }

      // GET /activation_status?machine_id=...
      if (path === "/activation_status" && method === "GET") {
        const machine_id = (url.searchParams.get("machine_id") || "").trim();
        if (!machine_id) return json({ ok: false, error: "machine_id_required" }, 400);

        const row = await env.DB.prepare(`
          SELECT machine_id, activated, blocked, expires_at
          FROM installations
          WHERE machine_id=?
        `).bind(machine_id).first();

        if (!row) {
          return json({
            ok: true,
            activated: false,
            blocked: false,
            expires_at: null,
            reason: "not_registered",
          });
        }

        await env.DB.prepare(`
          UPDATE installations SET last_seen_at=? WHERE machine_id=?
        `).bind(nowIso(), machine_id).run();

        // expiração simples
        let expired = false;
        if (row.expires_at) {
          const ms = Date.parse(row.expires_at);
          if (!Number.isNaN(ms)) expired = Date.now() > ms;
        }

        const activated = !!row.activated && !expired;
        const blocked = !!row.blocked;

        return json({
          ok: true,
          activated: activated && !blocked,
          blocked,
          expires_at: row.expires_at || null,
          reason: blocked ? "blocked" : (expired ? "expired" : (activated ? "ok" : "not_activated")),
        });
      }

      // ---------- ADMIN ----------
      const needAdmin = path.startsWith("/admin/");
      if (needAdmin) {
        const token = env.ADMIN_TOKEN;
        if (!token) return json({ ok: false, error: "ADMIN_TOKEN_missing" }, 500);
        const auth = request.headers.get("authorization") || "";
        if (auth !== `Bearer ${token}`) return json({ ok: false, error: "unauthorized" }, 401);
      }

      // POST /admin/grant { machine_id, days }
      if (path === "/admin/grant" && method === "POST") {
        const body = await request.json().catch(() => null);
        const machine_id = (body?.machine_id || "").trim();
        const days = Number(body?.days ?? 365);

        if (!machine_id) return json({ ok: false, error: "machine_id_required" }, 400);
        if (!Number.isFinite(days) || days < 1 || days > 3650) {
          return json({ ok: false, error: "invalid_days" }, 400);
        }

        const expires_at = new Date(Date.now() + days * 86400000).toISOString();

        await env.DB.prepare(`
          INSERT INTO installations (machine_id, first_seen_at, last_seen_at, activated, blocked, expires_at)
          VALUES (?, ?, ?, 1, 0, ?)
          ON CONFLICT(machine_id) DO UPDATE SET
            activated=1,
            blocked=0,
            expires_at=excluded.expires_at,
            last_seen_at=excluded.last_seen_at
        `).bind(machine_id, nowIso(), nowIso(), expires_at).run();

        return json({ ok: true, machine_id, expires_at });
      }

      // GET /admin/installs
      if (path === "/admin/installs" && method === "GET") {
        const rows = await env.DB.prepare(`
          SELECT machine_id, activated, blocked, expires_at, first_seen_at, last_seen_at, notes
          FROM installations
          ORDER BY last_seen_at DESC
          LIMIT 300
        `).all();

        return json({ ok: true, items: rows.results || [] });
      }

      return json({ ok: false, error: "not_found", path, method }, 404);
    } catch (e) {
      // 🔥 nunca mais 1101 sem JSON
      return json({ ok: false, error: "worker_exception", detail: String(e?.message || e) }, 500);
    }
  },
};
