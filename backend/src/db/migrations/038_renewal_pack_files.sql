-- The files a renewal pack version is cut into.
--
-- Creating a renewal pack now does three things at once: the version row on
-- renewal_pack (the SQL record — snapshot, summary, changes), and the Excel
-- workbook and PDF rendered from that snapshot at the moment it was cut. The
-- files are held here so a download of v2 is byte-for-byte the v2 that went
-- to market, however the renderers move on. One row per format per version;
-- CSV stays rendered on demand.

CREATE TABLE renewal_pack_file (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id    UUID NOT NULL REFERENCES renewal_pack(id) ON DELETE CASCADE,
  format     TEXT NOT NULL CHECK (format IN ('xlsx', 'pdf')),
  filename   TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  content    BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pack_id, format)
);

CREATE INDEX idx_pack_file_pack ON renewal_pack_file(pack_id);

COMMENT ON TABLE renewal_pack_file IS
  'The Excel and PDF of a renewal pack version, rendered when the version was created.';
