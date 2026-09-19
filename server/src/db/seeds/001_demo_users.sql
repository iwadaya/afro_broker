-- Seed 001: demo organisations and users (dev/test/demo boxes only).
-- Passwords (scrypt, see server/src/lib/passwordHash.js):
--   aabi.admin  / aabi-admin-2026    (ADMIN,  Afro-Asian Re Brokers)
--   aabi.broker / aabi-broker-2026   (BROKER, Afro-Asian Re Brokers)
--   other.broker / other-broker-2026 (BROKER, Other Broking House — for IDOR tests)
-- Under ALLOW_DEMO_AUTH=true the universal password 'demo2026' also works.
INSERT INTO public.bk_org (org_id, name, lloyds_broker_no) VALUES
  ('00000000-0000-0000-0000-00000000a0b1', 'Afro-Asian Re Brokers', '0621'),
  ('00000000-0000-0000-0000-00000000a0b2', 'Other Broking House',   '0999')
ON CONFLICT (org_id) DO NOTHING;

INSERT INTO public.uw_user (user_id, org_id, username, email, display_name, role_code, password_hash) VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000a0b1', 'aabi.admin',   'admin@aabi.example',   'Ane Hwida',      'ADMIN',  'scrypt$15$8$1$a31f1daa2070995e08022fa59e298fbf$be3648bc9978b4a89fc1a6573dc8377ce834c2938fca67202c0756a3a798ae5244101952fe9ff2a722642b572038325e0532fc4bd4300c290021e2284c7d64e3'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000a0b1', 'aabi.broker',  'broker@aabi.example',  'Dar Chville',    'BROKER', 'scrypt$15$8$1$89ada86c10be1a9037076b407e5bc757$54b0493d5d0c298238e10547f12dbc6c99a62fe4d7ba3bc4c7c8486a1f0b9630b8aa5e861d1723b13f8e269e7b3f8b18cbcec71fa6cd1890c074c4e4292e4421'),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000a0b2', 'other.broker', 'broker@other.example', 'Olu Adeyemi',    'BROKER', 'scrypt$15$8$1$2e288bc64496af6abdf775af9458c29d$76744c830a73d6edad21580775904c2da234b40e0d352aa4cced332a254d1eda85b59ed7be3017590275ab219cef0c1ec795cce29e88531d8ba2818b1fe53234')
ON CONFLICT (user_id) DO NOTHING;
