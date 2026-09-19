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

## Scripts

| Command | What it does |
| --- | --- |
| `npm run verify` | lint, typecheck, server tests, client build, client tests |
| `scripts/test-db.sh` | create / migrate / seed the test database and run the DB-backed server tests |
| `npm run test:e2e` | Playwright end-to-end suites (Identify, Treaty Detail, NP capture) against the built client on the test database |
| `npm run screenshots` | design-system previews next to the app's components, plus the 1440 / 1280 walkthroughs, in both themes → `docs/broking/screenshots` |
| `deploy/deploy.sh --ref main` | fetch, install, build, migrate, restart — see `DEPLOYMENT.md` |

## Where things are

- `docs/broking/PLAN.md` — module layout, reuse vs copy, migration numbering, build order
- `docs/broking/CHANGELOG.md` — what was built, deviations from the data model, Universe quirks carried over
- `docs/broking/design-system/` — the offline export of the design system (tokens, component READMEs and previews, data model, capture flow)
- `docs/broking/universe-reference/` — the Universe screens the capture UI was ported from
- `shared/broking/calcs.js` — every derived value, shared by server and client
