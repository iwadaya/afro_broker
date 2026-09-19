# Universe Broking — end-to-end tests

Browser tests (Playwright) that drive the real UI against a live backend. They
cover the full placement lifecycle (`DRAFT→BOUND`, four-eyes, exact signing-down),
signing by contract (the Signing pill asking which contract, the programme
and the written and signed lines of the one chosen, the preview before the
signing is applied and the ledger after), secondary actions (admin gating, subjectivities, line decline, accept-shortfall,
documents), the table of retentions (the class / % of capacity table and
grading an occupancy automatically), negotiation (the pack going to market, the
quotes coming back against the structures quoted, and a lead answering with a
structure of its own), and the dynamic financial analysis desk (what to model
asked on arrival, one contract run by itself, the verdict strip, the eight
stages, an edit marking the run stale, the tower, a frontier scan, a
multi-year horizon, the structuring sweep with its pick adopted and its
one-pager, a standalone book typed from scratch, and the whole portfolio).

This package is **not** part of the root npm workspaces, so a normal
`npm install` stays lean and doesn't pull a browser. Install it on demand.

## Run locally

From the repo root, with PostgreSQL running:

```bash
# 1. one-time: install e2e deps + a browser
cd e2e && npm install && npx playwright install chromium && cd ..

# 2. prepare the database + demo users
npm run migrate && npm run seed

# 3. start the backend (:4000) and the frontend dev server (:5173)
npm run dev &                       # backend
npm --workspace frontend run dev &  # frontend (proxies /api → :4000)

# 4. run the e2e suite
npm --prefix e2e test
```

## Configuration (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `BASE_URL` | `http://localhost:5173` | Where the frontend is served. |
| `PW_CHROMIUM` | _(unset)_ | Explicit Chromium binary path. Leave unset to use Playwright's managed install; set it to reuse a pre-installed browser. |

The specs assume the backend is seeded (`npm run seed`) so the demo users
(`broker@`, `uw@`, `admin@broking.local`) can sign in.
