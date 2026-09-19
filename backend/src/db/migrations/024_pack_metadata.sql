-- Renewal packs carry cedant-facing metadata alongside the templated snapshot:
-- a title, broker notes, arbitrary attachments (exposure workbooks, slips,
-- correspondence) and a free-form `extra` bag for anything else worth keeping
-- with the version. The snapshot stays immutable evidence; these fields are
-- editable while the pack is a draft and frozen on approval.

ALTER TABLE renewal_pack
  ADD COLUMN title       TEXT,
  ADD COLUMN notes       TEXT,
  ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN extra       JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN renewal_pack.attachments IS
  'Files held with this version: [{name, kind, file, note}].';
COMMENT ON COLUMN renewal_pack.extra IS
  'Anything else worth keeping with the version, free-form.';

-- The pack store lists every cedant''s versions newest-first.
CREATE INDEX idx_pack_created ON renewal_pack(created_at DESC);
