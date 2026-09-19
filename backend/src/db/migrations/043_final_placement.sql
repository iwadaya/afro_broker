-- Final placement: the stage after the negotiation.
--
-- Once the quotes are in and the final terms are settled, the placement is
-- closed out here: the final terms (picked from the negotiation's quotes when
-- we won the lead, entered when another broker leads), who leads it — the
-- lead broker and the lead reinsurer, kept for market intelligence — the
-- firm order terms sent to the reinsurers and underwriters that will write
-- it, the written lines that come back, the signed lines once the shares are
-- finalised, and the confirmation each underwriter is sent with their line.

CREATE TABLE final_placement (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id        UUID NOT NULL UNIQUE REFERENCES placement(id) ON DELETE CASCADE,
  lead_won            BOOLEAN NOT NULL DEFAULT TRUE,   -- we lead the placement
  lead_broker         TEXT,                            -- the broker leading it (us, or the other house)
  lead_reinsurer_id   UUID REFERENCES market(id) ON DELETE SET NULL,
  lead_reinsurer_name TEXT,                            -- kept as text too, for a reinsurer not on the register
  treaty_type         TEXT,                            -- the type of treaty placed (entered when another broker leads)
  -- The final terms, one row per line of the structures placed:
  -- [{key, structure_index, layer_index, label, basis, limit, attachment,
  --   premium, rate_pct, commission_pct, quote_id, market_id, market_name, notes}]
  terms               JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'fot_sent', 'confirmed')),
  confirmed_by        UUID REFERENCES users(id),
  confirmed_at        TIMESTAMPTZ,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The emails sent from this stage: the firm order terms (with the renewal
-- pack), and the confirmations of written and signed lines.
CREATE TABLE final_placement_email (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  final_placement_id UUID NOT NULL REFERENCES final_placement(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('fot', 'confirmation')),
  subject            TEXT NOT NULL,
  body               TEXT NOT NULL,
  attach_pack        BOOLEAN NOT NULL DEFAULT FALSE,
  pack_id            UUID REFERENCES renewal_pack(id) ON DELETE SET NULL,
  -- [{market_id, market_name, contact_id, name, email, status, message_id, error}]
  recipients         JSONB NOT NULL DEFAULT '[]'::jsonb,
  delivered          INTEGER NOT NULL DEFAULT 0,
  sent_by            UUID REFERENCES users(id),
  sent_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_final_placement_email ON final_placement_email(final_placement_id, sent_at DESC);

-- One line per market per line of the final terms: what they wrote, and what
-- they sign once the shares are finalised.
CREATE TABLE final_placement_line (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  final_placement_id UUID NOT NULL REFERENCES final_placement(id) ON DELETE CASCADE,
  market_id          UUID NOT NULL REFERENCES market(id),
  term_key           TEXT NOT NULL,                     -- the final term line, e.g. s1:l0 or s2:whole
  written_pct        NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (written_pct >= 0),
  signed_pct         NUMERIC(7,4) CHECK (signed_pct IS NULL OR signed_pct >= 0),
  to_stand           BOOLEAN NOT NULL DEFAULT FALSE,
  status             TEXT NOT NULL DEFAULT 'written' CHECK (status IN ('written', 'signed')),
  contact_id         UUID REFERENCES market_contact(id) ON DELETE SET NULL,
  notes              TEXT,
  updated_by         UUID REFERENCES users(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (final_placement_id, market_id, term_key)
);

CREATE INDEX idx_final_placement_line ON final_placement_line(final_placement_id);
