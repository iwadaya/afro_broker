-- 002: broking organisation, users and server-side auth sessions.
-- bk_org carries the org-level setting the Identify step needs (the Lloyd's
-- broker number); uw_user keeps the Universe name and auth columns so the
-- ported auth middleware works unchanged.
CREATE TABLE IF NOT EXISTS public.bk_org (
  org_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL UNIQUE,
  lloyds_broker_no char(4) CHECK (lloyds_broker_no ~ '^[0-9]{4}$'),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.uw_user (
  user_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES public.bk_org(org_id),
  username             text NOT NULL UNIQUE,
  email                text NOT NULL,
  display_name         text NOT NULL,
  role_code            text NOT NULL DEFAULT 'BROKER' CHECK (role_code IN ('ADMIN','BROKER','VIEWER')),
  password_hash        text,
  is_active            boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_attempts      integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  session_epoch        integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_uw_user_email ON public.uw_user (lower(email));
DROP TRIGGER IF EXISTS trg_uw_user_updated ON public.uw_user;
CREATE TRIGGER trg_uw_user_updated BEFORE UPDATE ON public.uw_user FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.auth_session (
  session_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.uw_user(user_id) ON DELETE CASCADE,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  last_seen_at   timestamptz,
  revoked_at     timestamptz,
  revoked_reason text,
  auth_method    text NOT NULL DEFAULT 'PASSWORD',
  ip             inet,
  user_agent     text
);
CREATE INDEX IF NOT EXISTS idx_auth_session_user_live ON public.auth_session (user_id) WHERE revoked_at IS NULL;

-- The default broking house. BROKING_LLOYDS_BROKER_NO (env) overrides this at
-- runtime; the seed keeps the two in step.
INSERT INTO public.bk_org (org_id, name, lloyds_broker_no)
VALUES ('00000000-0000-0000-0000-00000000a0b1', 'Afro-Asian Re Brokers', '0621')
ON CONFLICT (org_id) DO NOTHING;
