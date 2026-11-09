-- Durable replay protection for the optional direct GitHub App webhook ingress.
-- Apply only to an independently approved D1 database before enabling any public webhook route.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  body_digest TEXT NOT NULL UNIQUE,
  installation_id INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  source_repository TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  delivered_ms INTEGER
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending
  ON webhook_deliveries (delivered_ms, lease_until_ms, created_ms);
