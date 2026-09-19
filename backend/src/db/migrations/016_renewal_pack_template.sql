-- Renewal packs run to a fixed template per basis. Recording the basis and the
-- template version a pack was built against means an older version can still be
-- read exactly as it was built, even after the template changes.

ALTER TABLE renewal_pack
  ADD COLUMN basis            TEXT,
  ADD COLUMN template_version INTEGER,
  ADD COLUMN summary          JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN changes          JSONB NOT NULL DEFAULT '[]'::jsonb;  -- vs the previous version
