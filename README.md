# Afro_Asian_Business_Intelligence (AABI) — broking

Treaty capture for reinsurance broking: every contract keyed by a UUID and a Lloyd's UMR.
React 19 + Vite client, Express 5 server, PostgreSQL 16. The module keeps the Universe
(`iwadaya/Saudi_re`) layout — `server/src/broking`, `client/src/broking`, `shared/broking` —
see `docs/broking/PLAN.md`.

```bash
npm run install:all
cp .env.example .env            # BROKING_ENABLED=true, BROKING_LLOYDS_BROKER_NO=0621
npm run migrate && npm run seed # PostgreSQL at DATABASE_URL
npm run dev                     # client :3000 → API :4000
```

Demo sign-in: `aabi.broker` / `aabi-broker-2026` (see `server/src/db/seeds/001_demo_users.sql`).
