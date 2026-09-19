-- Broker sign-off on an uploaded pack's AI draft.
--
-- The model drafts the renewal summary; a broker reads it against the packs
-- and signs it off, and nothing goes to market until then. The sign-off is
-- held on the analysis itself — who, and when — rather than in a browser, so
-- the gate can be enforced by the API and read by anyone. A new draft (a
-- re-run, a pack added or removed, a corrected figure) clears it: it was
-- given for the draft and the packs as they were.
--
-- ON DELETE SET NULL: a user removed from the register leaves the stamp in
-- place — the audit event carries who it was.

ALTER TABLE renewal_pack_analysis
  ADD COLUMN verified_at TIMESTAMPTZ,
  ADD COLUMN verified_by UUID REFERENCES users(id) ON DELETE SET NULL;
