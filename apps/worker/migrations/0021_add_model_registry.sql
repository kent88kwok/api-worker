CREATE TABLE IF NOT EXISTS model_registry (
  canonical_model TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  provider_hint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_aliases (
  alias TEXT NOT NULL,
  provider_hint TEXT NOT NULL DEFAULT '',
  canonical_model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (alias, provider_hint)
);

CREATE INDEX IF NOT EXISTS idx_model_aliases_canonical_model
  ON model_aliases (canonical_model);

ALTER TABLE usage_logs ADD COLUMN canonical_model TEXT;
ALTER TABLE usage_logs ADD COLUMN request_model_raw TEXT;
ALTER TABLE usage_logs ADD COLUMN upstream_model_raw TEXT;

ALTER TABLE attempt_events ADD COLUMN canonical_model TEXT;
ALTER TABLE attempt_events ADD COLUMN request_model_raw TEXT;
ALTER TABLE attempt_events ADD COLUMN upstream_model_raw TEXT;

ALTER TABLE model_prices ADD COLUMN canonical_model TEXT;

ALTER TABLE channel_model_capabilities ADD COLUMN canonical_model TEXT;

UPDATE usage_logs
SET
  canonical_model = COALESCE(NULLIF(TRIM(canonical_model), ''), LOWER(TRIM(model))),
  request_model_raw = COALESCE(NULLIF(TRIM(request_model_raw), ''), model),
  upstream_model_raw = COALESCE(NULLIF(TRIM(upstream_model_raw), ''), model)
WHERE
  canonical_model IS NULL
  OR request_model_raw IS NULL
  OR upstream_model_raw IS NULL;

UPDATE attempt_events
SET
  canonical_model = COALESCE(NULLIF(TRIM(canonical_model), ''), LOWER(TRIM(model))),
  request_model_raw = COALESCE(NULLIF(TRIM(request_model_raw), ''), model),
  upstream_model_raw = COALESCE(NULLIF(TRIM(upstream_model_raw), ''), model)
WHERE
  canonical_model IS NULL
  OR request_model_raw IS NULL
  OR upstream_model_raw IS NULL;

UPDATE model_prices
SET canonical_model = COALESCE(
  NULLIF(TRIM(canonical_model), ''),
  LOWER(TRIM(COALESCE(model_name, model_pattern)))
)
WHERE canonical_model IS NULL;

UPDATE channel_model_capabilities
SET canonical_model = COALESCE(NULLIF(TRIM(canonical_model), ''), LOWER(TRIM(model)))
WHERE canonical_model IS NULL;

INSERT OR IGNORE INTO model_registry (canonical_model, display_name, provider_hint, created_at, updated_at)
SELECT DISTINCT
  canonical_model,
  canonical_model,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM usage_logs
WHERE canonical_model IS NOT NULL AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_registry (canonical_model, display_name, provider_hint, created_at, updated_at)
SELECT DISTINCT
  canonical_model,
  canonical_model,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM attempt_events
WHERE canonical_model IS NOT NULL AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_registry (canonical_model, display_name, provider_hint, created_at, updated_at)
SELECT DISTINCT
  canonical_model,
  canonical_model,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM model_prices
WHERE canonical_model IS NOT NULL AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_registry (canonical_model, display_name, provider_hint, created_at, updated_at)
SELECT DISTINCT
  canonical_model,
  canonical_model,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM channel_model_capabilities
WHERE canonical_model IS NOT NULL AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_aliases (alias, provider_hint, canonical_model, created_at, updated_at)
SELECT DISTINCT
  LOWER(TRIM(model)) AS alias,
  '' AS provider_hint,
  canonical_model,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM usage_logs
WHERE model IS NOT NULL
  AND TRIM(model) != ''
  AND canonical_model IS NOT NULL
  AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_aliases (alias, provider_hint, canonical_model, created_at, updated_at)
SELECT DISTINCT
  LOWER(TRIM(request_model_raw)) AS alias,
  '' AS provider_hint,
  canonical_model,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM usage_logs
WHERE request_model_raw IS NOT NULL
  AND TRIM(request_model_raw) != ''
  AND canonical_model IS NOT NULL
  AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_aliases (alias, provider_hint, canonical_model, created_at, updated_at)
SELECT DISTINCT
  LOWER(TRIM(upstream_model_raw)) AS alias,
  '' AS provider_hint,
  canonical_model,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM usage_logs
WHERE upstream_model_raw IS NOT NULL
  AND TRIM(upstream_model_raw) != ''
  AND canonical_model IS NOT NULL
  AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_aliases (alias, provider_hint, canonical_model, created_at, updated_at)
SELECT DISTINCT
  LOWER(TRIM(model)) AS alias,
  '' AS provider_hint,
  canonical_model,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM attempt_events
WHERE model IS NOT NULL
  AND TRIM(model) != ''
  AND canonical_model IS NOT NULL
  AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_aliases (alias, provider_hint, canonical_model, created_at, updated_at)
SELECT DISTINCT
  LOWER(TRIM(request_model_raw)) AS alias,
  '' AS provider_hint,
  canonical_model,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM attempt_events
WHERE request_model_raw IS NOT NULL
  AND TRIM(request_model_raw) != ''
  AND canonical_model IS NOT NULL
  AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_aliases (alias, provider_hint, canonical_model, created_at, updated_at)
SELECT DISTINCT
  LOWER(TRIM(upstream_model_raw)) AS alias,
  '' AS provider_hint,
  canonical_model,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM attempt_events
WHERE upstream_model_raw IS NOT NULL
  AND TRIM(upstream_model_raw) != ''
  AND canonical_model IS NOT NULL
  AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_aliases (alias, provider_hint, canonical_model, created_at, updated_at)
SELECT DISTINCT
  LOWER(TRIM(model_pattern)) AS alias,
  '' AS provider_hint,
  canonical_model,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM model_prices
WHERE model_pattern IS NOT NULL
  AND TRIM(model_pattern) != ''
  AND canonical_model IS NOT NULL
  AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_aliases (alias, provider_hint, canonical_model, created_at, updated_at)
SELECT DISTINCT
  LOWER(TRIM(model_name)) AS alias,
  '' AS provider_hint,
  canonical_model,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM model_prices
WHERE model_name IS NOT NULL
  AND TRIM(model_name) != ''
  AND canonical_model IS NOT NULL
  AND TRIM(canonical_model) != '';

INSERT OR IGNORE INTO model_aliases (alias, provider_hint, canonical_model, created_at, updated_at)
SELECT DISTINCT
  LOWER(TRIM(model)) AS alias,
  '' AS provider_hint,
  canonical_model,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM channel_model_capabilities
WHERE model IS NOT NULL
  AND TRIM(model) != ''
  AND canonical_model IS NOT NULL
  AND TRIM(canonical_model) != '';

CREATE INDEX IF NOT EXISTS idx_usage_logs_canonical_model
  ON usage_logs (canonical_model);

CREATE INDEX IF NOT EXISTS idx_usage_logs_canonical_model_created_at
  ON usage_logs (canonical_model, created_at);

CREATE INDEX IF NOT EXISTS idx_attempt_events_canonical_model
  ON attempt_events (canonical_model);

CREATE INDEX IF NOT EXISTS idx_model_prices_canonical_model
  ON model_prices (canonical_model);

CREATE INDEX IF NOT EXISTS idx_channel_model_capabilities_canonical_model
  ON channel_model_capabilities (canonical_model);
