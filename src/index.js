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
      if (!env.DB) {
        return json({ ok: false, error: "DB_binding_missing" }, 500);
      }

      await env.DB.exec(`
        CREATE TABLE IF NOT EXISTS installations (
          machine_id TEXT PRIMARY KEY,
          first_seen_at TEXT,
          last_seen_at TEXT,
          activated INTEGER DEFAULT 0,
          blocked INTEGER DEFAULT 0,
          expires_at TEXT
        );
      `);

      const now = () => new Date().toISOString();

      // health
      if (path === "/" && method === "GET") {
        return json({ ok: true, service: "tonch-licensing-api" });
      }

      // activation status
      if (path === "/activation_status" && method === "GET") {
        const machine_id = url.searchParams.get("machine_id");
        if (!machine_id) {
          return json({ ok: false, error: "machine_id_required" }, 400);
        }

        const row = await env.DB
          .prepare(`SELECT * FROM installations WHERE machine_id=?`)
          .bind(machine_id)
          .first();

        if (!row) {
          return json({
            ok: true,
            activated: false,
            blocked: false,
            expires_at: null,
            reason: "not_registered",
          });
        }

        let expired = false;
        if (row.expires_at) {
          expired = Date.now() > Date.parse(row.expires_at);
        }

        const activated = row.activated === 1 && !expired;
        const blocked = row.blocked === 1;

        await env.DB
          .prepare(`UPDATE installations SET last_seen_at=? WHERE machine_id=?`)
          .bind(now(), machine_id)
          .run();

        return json({
          ok: true,
          activated: activated && !blocked,
          blocked,
          expires_at: row.expires_at,
          reason: blocked
            ? "blocked"
            : expired
            ? "expired"
            : activated
            ? "ok"
            : "not_activated",
        });
      }

      // admin auth
      if (path.startsWith("/admin/")) {
        const auth = request.headers.get("authorization");
        if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
      }

      // admin grant
      if (path === "/admin/grant" && method === "POST") {
        const body = await request.json();
        const { machine_id, days = 365 } = body;

        if (!machine_id) {
          return json({ ok: false, error: "machine_id_required" }, 400);
        }

        const expires_at = new Date(
          Date.now() + days * 86400000
        ).toISOString();

        await env.DB.prepare(`
          INSERT INTO installations (machine_id, first_seen_at, last_seen_at, activated, blocked, expires_at)
          VALUES (?, ?, ?, 1, 0, ?)
          ON CONFLICT(machine_id) DO UPDATE SET
            activated=1,
            blocked=0,
            expires_at=excluded.expires_at,
            last_seen_at=excluded.last_seen_at
        `)
          .bind(machine_id, now(), now(), expires_at)
          .run();

        return json({ ok: true, machine_id, expires_at });
      }

      return json({ ok: false, error: "not_found" }, 404);
    } catch (e) {
      return json(
        { ok: false, error: "worker_exception", detail: String(e) },
        500
      );
    }
  },
};
