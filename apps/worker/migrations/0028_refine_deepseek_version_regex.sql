UPDATE model_registry
SET import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-chat$', updated_at = CURRENT_TIMESTAMP
WHERE canonical_model = 'deepseek/deepseek-chat'
  AND import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-chat(?:[-:][\w.]+)*$';

UPDATE model_registry
SET import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-reasoner$', updated_at = CURRENT_TIMESTAMP
WHERE canonical_model = 'deepseek/deepseek-reasoner'
  AND import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-reasoner(?:[-:][\w.]+)*$';

UPDATE model_registry
SET import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-r1$', updated_at = CURRENT_TIMESTAMP
WHERE canonical_model = 'deepseek/deepseek-r1'
  AND import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-r1(?:[-:][\w.]+)*$';

UPDATE model_registry
SET import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3$', updated_at = CURRENT_TIMESTAMP
WHERE canonical_model = 'deepseek/deepseek-v3'
  AND import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3(?:[-:][\w.]+)*$';

UPDATE model_registry
SET import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3(?:[.-]1)(?:-terminus)?$', updated_at = CURRENT_TIMESTAMP
WHERE canonical_model = 'deepseek/deepseek-v3.1'
  AND import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3(?:[.-]1)(?:[-:][\w.]+)*$';

UPDATE model_registry
SET import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3(?:[.-]2)(?:-\d{6,8})?$', updated_at = CURRENT_TIMESTAMP
WHERE canonical_model = 'deepseek/deepseek-v3.2'
  AND import_regex = '^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3(?:[.-]2)(?:[-:][\w.]+)*$';

INSERT INTO model_registry (
  canonical_model,
  display_name,
  provider_hint,
  import_regex,
  created_at,
  updated_at
)
VALUES (
  'deepseek/deepseek-v3.2-exp',
  'deepseek/deepseek-v3.2-exp',
  NULL,
  '^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3(?:[.-]2)-exp$',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT(canonical_model) DO UPDATE SET
  display_name = excluded.display_name,
  import_regex = excluded.import_regex,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO model_registry (
  canonical_model,
  display_name,
  provider_hint,
  import_regex,
  created_at,
  updated_at
)
VALUES (
  'deepseek/deepseek-v3.2-speciale',
  'deepseek/deepseek-v3.2-speciale',
  NULL,
  '^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3(?:[.-]2)-speciale$',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT(canonical_model) DO UPDATE SET
  display_name = excluded.display_name,
  import_regex = excluded.import_regex,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO model_aliases (alias, provider_hint, canonical_model, created_at, updated_at)
VALUES ('deepseek/deepseek-v3.2-exp', '', 'deepseek/deepseek-v3.2-exp', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(alias, provider_hint) DO UPDATE SET
  canonical_model = excluded.canonical_model,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO model_aliases (alias, provider_hint, canonical_model, created_at, updated_at)
VALUES ('deepseek/deepseek-v3.2-speciale', '', 'deepseek/deepseek-v3.2-speciale', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(alias, provider_hint) DO UPDATE SET
  canonical_model = excluded.canonical_model,
  updated_at = CURRENT_TIMESTAMP;
