// Helper para respostas JSON
const jsonResponse = (data, status = 200) => {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeaders()
        }
    });
};

// Headers CORS
function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400'
    };
}

// Middleware de autenticação para rotas admin
function requireAdmin(request, env) {
    const token = env.ADMIN_TOKEN;
    if (!token) {
        throw new Error('ADMIN_TOKEN não configurado');
    }
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${token}`) {
        throw new Error('Não autorizado');
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // CORS preflight
        if (method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });
        }

        try {
            // Verifica se o binding do banco de dados está disponível
            if (!env.DB) {
                throw new Error('Binding do banco de dados não disponível');
            }

            // Rota: Health check
            if (path === '/' && method === 'GET') {
                return jsonResponse({
                    ok: true,
                    service: 'tonch-licensing-api',
                    version: 'v1.0.0',
                    timestamp: new Date().toISOString()
                });
            }

            // Rota: Registrar instalação
            if (path === '/register_install' && method === 'POST') {
                const body = await request.json();
                const machineId = body.machine_id?.trim();

                if (!machineId) {
                    return jsonResponse({
                        ok: false,
                        error: 'machine_id_required'
                    }, 400);
                }

                const now = new Date().toISOString();

                // Insere ou atualiza a última vez visto
                await env.DB.prepare(`
                    INSERT INTO installations (machine_id, first_seen_at, last_seen_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(machine_id) DO UPDATE SET last_seen_at = ?
                `).bind(machineId, now, now, now).run();

                return jsonResponse({
                    ok: true,
                    message: 'Instalação registrada com sucesso'
                });
            }

            // Rota: Consultar status de ativação
            if (path === '/activation_status' && method === 'GET') {
                const machineId = url.searchParams.get('machine_id')?.trim();

                if (!machineId) {
                    return jsonResponse({
                        ok: false,
                        error: 'machine_id_required'
                    }, 400);
                }

                // Atualiza o last_seen_at
                await env.DB.prepare(`
                    UPDATE installations 
                    SET last_seen_at = ?
                    WHERE machine_id = ?
                `).bind(new Date().toISOString(), machineId).run();

                // Busca os dados da instalação
                const installation = await env.DB.prepare(`
                    SELECT machine_id, activated, blocked, expires_at
                    FROM installations
                    WHERE machine_id = ?
                `).bind(machineId).first();

                if (!installation) {
                    return jsonResponse({
                        ok: true,
                        activated: false,
                        blocked: false,
                        expires_at: null,
                        reason: 'not_registered'
                    });
                }

                const { activated, blocked, expires_at } = installation;
                let expired = false;
                let reason = 'ok';

                // Verifica se a licença expirou
                if (expires_at) {
                    const expiryDate = new Date(expires_at);
                    expired = expiryDate < new Date();
                }

                if (blocked) {
                    reason = 'blocked';
                } else if (expired) {
                    reason = 'expired';
                } else if (!activated) {
                    reason = 'not_activated';
                }

                return jsonResponse({
                    ok: true,
                    activated: activated && !expired && !blocked,
                    blocked: Boolean(blocked),
                    expires_at: expires_at || null,
                    reason
                });
            }

            // ================= ROTAS ADMINISTRATIVAS =================

            // Rota: Conceder licença
            if (path === '/admin/grant' && method === 'POST') {
                try {
                    requireAdmin(request, env);
                } catch (authError) {
                    return jsonResponse({
                        ok: false,
                        error: 'unauthorized',
                        detail: authError.message
                    }, 401);
                }

                const body = await request.json();
                const machineId = body.machine_id?.trim();
                const days = Number(body.days) || 365;

                if (!machineId) {
                    return jsonResponse({
                        ok: false,
                        error: 'machine_id_required'
                    }, 400);
                }

                if (days < 1 || days > 3650) {
                    return jsonResponse({
                        ok: false,
                        error: 'invalid_days',
                        detail: 'Dias deve estar entre 1 e 3650'
                    }, 400);
                }

                const now = new Date();
                const expiresAt = new Date(now.getTime() + days * 86400000).toISOString();
                const isoNow = now.toISOString();

                await env.DB.prepare(`
                    INSERT INTO installations (machine_id, activated, blocked, expires_at, first_seen_at, last_seen_at)
                    VALUES (?, 1, 0, ?, ?, ?)
                    ON CONFLICT(machine_id) DO UPDATE SET
                        activated = 1,
                        blocked = 0,
                        expires_at = ?,
                        last_seen_at = ?
                `).bind(machineId, expiresAt, isoNow, isoNow, expiresAt, isoNow).run();

                return jsonResponse({
                    ok: true,
                    message: 'Licença concedida com sucesso',
                    machine_id: machineId,
                    expires_at: expiresAt
                });
            }

            // Rota: Bloquear/desbloquear instalação
            if (path === '/admin/block' && method === 'POST') {
                try {
                    requireAdmin(request, env);
                } catch (authError) {
                    return jsonResponse({
                        ok: false,
                        error: 'unauthorized',
                        detail: authError.message
                    }, 401);
                }

                const body = await request.json();
                const machineId = body.machine_id?.trim();
                const blocked = Boolean(body.blocked);

                if (!machineId) {
                    return jsonResponse({
                        ok: false,
                        error: 'machine_id_required'
                    }, 400);
                }

                await env.DB.prepare(`
                    UPDATE installations
                    SET blocked = ?, last_seen_at = ?
                    WHERE machine_id = ?
                `).bind(blocked ? 1 : 0, new Date().toISOString(), machineId).run();

                return jsonResponse({
                    ok: true,
                    message: blocked ? 'Instalação bloqueada' : 'Instalação desbloqueada',
                    machine_id: machineId,
                    blocked
                });
            }

            // Rota: Listar instalações
            if (path === '/admin/installs' && method === 'GET') {
                try {
                    requireAdmin(request, env);
                } catch (authError) {
                    return jsonResponse({
                        ok: false,
                        error: 'unauthorized',
                        detail: authError.message
                    }, 401);
                }

                const installations = await env.DB.prepare(`
                    SELECT machine_id, activated, blocked, expires_at, first_seen_at, last_seen_at, notes
                    FROM installations
                    ORDER BY last_seen_at DESC
                    LIMIT 300
                `).all();

                return jsonResponse({
                    ok: true,
                    installations: installations.results || []
                });
            }

            // Rota não encontrada
            return jsonResponse({
                ok: false,
                error: 'not_found',
                path,
                method
            }, 404);

        } catch (error) {
            console.error('Erro no worker:', error);

            return jsonResponse({
                ok: false,
                error: 'worker_exception',
                detail: error.message
            }, 500);
        }
    }
};
