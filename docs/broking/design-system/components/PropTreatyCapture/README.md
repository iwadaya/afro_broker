# PropTreatyCapture

The proportional capture screen: the Universe Treaty Detail as-is — a 2×2 grid of Panes (CONTRACT DETAILS, LIMIT DETAILS, COMMISSIONS, LOSS PARTICIPATION with EPI and BROKERAGE & TAXES) under the header pill and SummaryBar.

**Consumer provides:** the contract (UMR, UUID, status), reference lists, the `propTreatyDetail` values, `onSave` (PUT `/api/contracts/:contractId/prop-detail` with `row_version`).

- Treaty mode (quota / surplus / both) from the Treaty Type enables QS or surplus fields; the rest are disabled with "Not applicable for this treaty type".
- Retention % and Cession % always sum to 100; Retention Amount, Cession Amount and Total Treaty Capacity are live.
- FIXED / SLIDING and Loss Participation YES / NO dim the inactive block to 35%.
- Every field, key and rule is listed in **Capture flow**.
