CREATE TABLE installations (
    machine_id TEXT PRIMARY KEY,
    first_seen_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    activated INTEGER DEFAULT 0,
    blocked INTEGER DEFAULT 0,
    expires_at TEXT,
    notes TEXT
);
