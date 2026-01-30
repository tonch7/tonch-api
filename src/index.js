export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---------- CORS ----------
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
      });

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // ---------- helpers ----------
    const nowIso = () => new Date().toISOString();

    const requireDB = () => {
      if (!env.DB) throw new Error("DB_binding_missing");
    };

    const requireAdmin = () => {
      const token = env.ADMIN_TOKEN;
      if (!token) return { ok: false, resp: json({ ok: false, error: "ADMIN_TOKEN_missing" }, 500) };

      const auth = request.headers.get("authorization") || "";
      if (auth !== `Bearer ${token}`) {
        return { ok: false, resp: json({ ok: false, error: "unauthorized" }, 401) };
      }
      return { ok: true };
    };

    const ensureSchema = async () => {
      requireDB();
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
    };

    const parseBody = async () => {
      try {
        return await request.json();
      } catch {
        return null;
      }
    };

    const clampInt = (v, min, max, fallback) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      const i = Math.floor(n);
      return Math.max(min, Math.min(max, i));
    };

    // ---------- routes ----------
    try {
      // Health
      if (path === "/" && method === "GET") {
        return json({ ok: true, service: "tonch-licensing-api", build: "V2-2026-01-30", ts: nowIso() });
      }

      // Sempre garante schema antes de qualquer rota útil
      await ensureSchema();

      // POST /register_install  { machine_id }
      if (path === "/register_install" && method === "POST") {
        const body = await parseBody();
        const machine_id = String(body?.machine_id ?? "").trim();
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
        const machine_id = String(url.searchParams.get("machine_id") || "").trim();
        if (!machine_id) return json({ ok: false, error: "machine_id_required" }, 400);

        const row = await env.DB.prepare(`
          SELECT machine_id, activated, blocked, expires_at
          FROM installations
          WHERE machine_id=?
        `).bind(machine_id).first();

        // Atualiza presença mesmo se não existir (opcional)
        await env.DB.prepare(`
          INSERT INTO installations (machine_id, first_seen_at, last_seen_at, activated, blocked)
          VALUES (?, ?, ?, 0, 0)
          ON CONFLICT(machine_id) DO UPDATE SET last_seen_at=excluded.last_seen_at
        `).bind(machine_id, nowIso(), nowIso()).run();

        if (!row) {
          return json({
            ok: true,
            activated: false,
            blocked: false,
            expires_at: null,
            reason: "not_activated"
          });
        }

        // Expiração
        let expired = false;
        if (row.expires_at) {
          const ms = Date.parse(row.expires_at);
          if (!Number.isNaN(ms)) expired = Date.now() > ms;
        }

        const isActivated = !!row.activated && !expired;
        const isBlocked = !!row.blocked;

        return json({
          ok: true,
          activated: isActivated && !isBlocked,
          blocked: isBlocked,
          expires_at: row.expires_at || null,
          reason: isBlocked ? "blocked" : (expired ? "expired" : (isActivated ? "ok" : "not_activated"))
        });
      }

      // ---------- ADMIN ----------
      if (path.startsWith("/admin/")) {
        const a = requireAdmin();
        if (!a.ok) return a.resp;
      }

      // POST /admin/grant { machine_id, days, notes? }
      if (path === "/admin/grant" && method === "POST") {
        const body = await parseBody();
        const machine_id = String(body?.machine_id ?? "").trim();
        const days = Number(body?.days ?? 365);
        const notes = body?.notes != null ? String(body.notes).slice(0, 500) : null;

        if (!machine_id) return json({ ok: false, error: "machine_id_required" }, 400);
        if (!Number.isFinite(days) || days < 1 || days > 3650) return json({ ok: false, error: "invalid_days" }, 400);

        const expires_at = new Date(Date.now() + days * 86400000).toISOString();

        await env.DB.prepare(`
          INSERT INTO installations (machine_id, first_seen_at, last_seen_at, activated, blocked, expires_at, notes)
          VALUES (?, ?, ?, 1, 0, ?, ?)
          ON CONFLICT(machine_id) DO UPDATE SET
            activated=1,
            blocked=0,
            expires_at=excluded.expires_at,
            notes=COALESCE(excluded.notes, installations.notes),
            last_seen_at=excluded.last_seen_at
        `).bind(machine_id, nowIso(), nowIso(), expires_at, notes).run();

        return json({ ok: true, machine_id, expires_at });
      }

      // GET /admin/installs?limit=&offset=
      if (path === "/admin/installs" && method === "GET") {
        const limit = clampInt(url.searchParams.get("limit"), 1, 500, 200);
        const offset = clampInt(url.searchParams.get("offset"), 0, 1000000, 0);

        const rows = await env.DB.prepare(`
          SELECT machine_id, activated, blocked, expires_at, first_seen_at, last_seen_at, notes
          FROM installations
          ORDER BY last_seen_at DESC
          LIMIT ? OFFSET ?
        `).bind(limit, offset).all();

        return json({ ok: true, items: rows.results || [] });
      }

      return json({ ok: false, error: "not_found", path, method }, 404);
    } catch (e) {
      return json({ ok: false, error: "worker_exception", detail: String(e?.message || e) }, 500);
    }
  },
};
