-- The placement workflow's later stages, in one migration:
--
--  1. Treaty type and class of business as their own columns on placement,
--     backfilled from the class string, so the register and the renewal
--     wizard search by them server-side (the modelling tool's cascade).
--  2. Versioned comments on renewal pack versions — the Pack Approval
--     screen's thread. Append-only: an edit is a new row that names the row
--     it replaces, so every earlier wording stays readable.
--  3. The Data screen's analysis of the placement's own screens, compared
--     with the prior year or an uploaded expiring pack.
--  4. Final placement: a renewal pack uploaded by hand at this stage carries
--     a reason; a line may be entered by the AI from an underwriter's email
--     and overridden by the broker, with every change kept.

-- ── 1. Treaty type / class of business on placement ─────────────────────
ALTER TABLE placement
  ADD COLUMN treaty_type       TEXT,
  ADD COLUMN class_of_business TEXT;

COMMENT ON COLUMN placement.treaty_type IS
  'The Universe treaty type name the class string ends with ("Quota Share", "Risk XL"…); kept beside `class` for search.';
COMMENT ON COLUMN placement.class_of_business IS
  'The classes of business the class string names, as written ("Property / Motor"); kept beside `class` for search.';

DO $$
DECLARE
  r RECORD;
  t RECORD;
  cls TEXT;
  lower_cls TEXT;
  matched TEXT;
  cob TEXT;
  last_word TEXT;
BEGIN
  FOR r IN SELECT id, class FROM placement LOOP
    cls := btrim(COALESCE(r.class, ''));
    lower_cls := lower(cls);
    matched := NULL;
    cob := cls;
    FOR t IN SELECT treaty_type FROM public.treaty_type ORDER BY length(treaty_type) DESC LOOP
      IF lower_cls = lower(t.treaty_type) OR right(lower_cls, length(t.treaty_type) + 1) = ' ' || lower(t.treaty_type) THEN
        matched := t.treaty_type;
        cob := btrim(left(cls, length(cls) - length(t.treaty_type)));
        EXIT;
      END IF;
    END LOOP;
    IF matched IS NULL AND cls <> '' THEN
      last_word := lower(regexp_replace(cls, '^.*\s', ''));
      matched := CASE last_word
        WHEN 'qs' THEN 'Quota Share'
        WHEN 'surplus' THEN 'First Surplus'
        WHEN 'xol' THEN 'Risk XL'
        WHEN 'xl' THEN 'Risk XL'
        WHEN 'fac' THEN 'Fac Oblig'
        ELSE NULL END;
      IF matched IS NOT NULL THEN
        cob := btrim(regexp_replace(cls, '\s\S+$', ''));
      END IF;
    END IF;
    UPDATE placement SET treaty_type = matched, class_of_business = NULLIF(cob, '') WHERE id = r.id;
  END LOOP;
END $$;

CREATE INDEX idx_placement_treaty_type ON placement(lower(treaty_type));
CREATE INDEX idx_placement_cob ON placement(lower(class_of_business));

-- ── 2. Versioned comments on a renewal pack version ─────────────────────
CREATE TABLE renewal_pack_comment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id     UUID NOT NULL REFERENCES renewal_pack(id) ON DELETE CASCADE,
  body        TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  -- An edit: the comment this one replaces. The replaced row stays, so the
  -- thread can show every wording a comment has had.
  replaces_id UUID REFERENCES renewal_pack_comment(id),
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pack_comment_pack ON renewal_pack_comment(pack_id, created_at);

CREATE OR REPLACE FUNCTION renewal_pack_comment_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'renewal_pack_comment is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_renewal_pack_comment_append_only
  BEFORE UPDATE OR DELETE ON renewal_pack_comment
  FOR EACH ROW EXECUTE FUNCTION renewal_pack_comment_is_append_only();

COMMENT ON TABLE renewal_pack_comment IS
  'The Pack Approval thread: comments on a pack version, versioned by replacement, never edited in place.';

-- ── 3. The Data screen: analysis of the placement''s screens ─────────────
CREATE TABLE placement_data_analysis (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id  UUID NOT NULL REFERENCES placement(id) ON DELETE CASCADE,
  -- What this year's data was compared with.
  basis         TEXT NOT NULL CHECK (basis IN ('prior_year', 'expiring_pack', 'none')),
  compared_to   UUID,                 -- the prior placement, or the uploaded pack analysis
  provider      TEXT,
  model         TEXT,
  digest        JSONB NOT NULL,       -- this year's data as it was read
  computed      JSONB NOT NULL,       -- the deterministic comparison
  narrative     JSONB NOT NULL,       -- the model's reading
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_placement_data_analysis ON placement_data_analysis(placement_id, created_at DESC);

-- ── 4. Final placement: uploaded packs with a reason, AI-entered lines ───
CREATE TABLE final_placement_pack_upload (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  final_placement_id UUID NOT NULL REFERENCES final_placement(id) ON DELETE CASCADE,
  filename           TEXT NOT NULL,
  mime_type          TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  content            BYTEA NOT NULL,
  -- Why a pack is being attached by hand instead of the approved version.
  reason             TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  uploaded_by        UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_final_pack_upload ON final_placement_pack_upload(final_placement_id, created_at DESC);

ALTER TABLE final_placement_email
  ADD COLUMN pack_upload_id   UUID REFERENCES final_placement_pack_upload(id) ON DELETE SET NULL,
  -- What actually rode with the email: ['xlsx','pdf'] for the approved
  -- pack, ['upload'] for a pack uploaded by hand.
  ADD COLUMN attached_formats TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE final_placement_line
  ADD COLUMN source      TEXT NOT NULL DEFAULT 'broker' CHECK (source IN ('broker', 'ai')),
  ADD COLUMN ai_reply_id UUID REFERENCES negotiation_reply(id) ON DELETE SET NULL,
  ADD COLUMN ai_read     JSONB;

COMMENT ON COLUMN final_placement_line.source IS
  'broker = entered or confirmed by a broker; ai = read from an underwriter''s email and not yet confirmed.';

CREATE TABLE final_placement_line_change (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  final_placement_id UUID NOT NULL REFERENCES final_placement(id) ON DELETE CASCADE,
  market_id          UUID NOT NULL REFERENCES market(id),
  term_key           TEXT NOT NULL,
  -- entered | overridden | accepted | cleared | ai_read
  action             TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('broker', 'ai')),
  before_state       JSONB,
  after_state        JSONB,
  note               TEXT,
  changed_by         UUID REFERENCES users(id),
  changed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_final_line_change ON final_placement_line_change(final_placement_id, changed_at DESC);

CREATE OR REPLACE FUNCTION final_placement_line_change_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'final_placement_line_change is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_final_placement_line_change_append_only
  BEFORE UPDATE OR DELETE ON final_placement_line_change
  FOR EACH ROW EXECUTE FUNCTION final_placement_line_change_is_append_only();
