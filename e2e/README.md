# Broker IQ — end-to-end tests

Browser tests (Playwright) that drive the real UI against a live backend. They
cover the tool's four functions: **Contracts** (the launcher pill's two options
— Proportional opens the Universe treaty detail with its four panes, the
lookups' dropdowns, the treaty-type gating, the derived amounts, the renewal
default, the required-field hold, the sliding scale, loss participation and
EPI split modals, a save that lands on the contract's own URL and reads back
after a reload; Non-proportional opens the contract details pane only, with the
non-proportional treaty types), the **renewal calendar** (the contract in its
window, opening on its basis page), **portfolio intelligence** with its
programme analysis, and **market intelligence** (a market by country, a trip
with its return, a note, the honest no-key gather, an account opening as a
contract) — plus the dashboard's launcher and calendar shelf, the register's
search and basis filter, the top bar's search and recents, and Admin's
role-gating.

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
