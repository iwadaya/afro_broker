-- 006: AABI broking — field-level audit trail. Every write appends one row whose
-- `diff` is { action, changes: { "<table>.<column>": { from, to } } }.
CREATE TABLE IF NOT EXISTS public.bk_audit (
  audit_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id  uuid NOT NULL REFERENCES public.bk_contract(contract_id) ON DELETE CASCADE,
  umr          varchar(17) NOT NULL,
  user_id      uuid REFERENCES public.uw_user(user_id),
  diff         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bk_audit_contract ON public.bk_audit (contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bk_audit_umr ON public.bk_audit (umr);
