# Non-proportional claims workspace

Open **Claims & Premium → Non-Proportional → Claims**. The contract pop-up is shared with Premium: pick the country, then the cedant, then the contract, and **Change contract** brings it back. Both the signed-layer ledger and confirmed final-placement structures are supported.

## Loss basis and calculations

The retained loss is the cedant's loss entering this treaty, before the treaty's layer deductibles. It is recorded at 100% in the contract currency. Paid and outstanding must be non-negative monetary amounts with at most two decimal places, and must add exactly to the retained total. This reconciliation is enforced in the browser, service and database.

For each applicable occurrence layer:

- Subject loss is `min(limit, max(retained loss − deductible, 0))`.
- Any unconsumed annual aggregate deductible applies before recovery. Earlier reported claims consume the AAD and annual recovery/reinstatement capacity in loss-date order, then creation order.
- Paid recovery applies that same deductible, remaining AAD and available limit to the paid loss. Outstanding recovery is total incurred recovery less paid recovery; the deductible is not charged a second time to outstanding.
- Reinstatement premium uses the existing engine's **pro rata to amount, 100% as to time** basis: `reinstated amount / limit × annual premium × reinstatement premium percentage`. The final exhausted limit is not reinstated. Free and unlimited reinstatements follow the recorded terms. A missing reinstatement count means zero; an absent reinstatement percentage follows the existing 100% convention, both shown in the structure.
- Net recovery is loss recovery less reinstatement premium. The paid and outstanding components also reconcile to that net total. A negative net remains visible; it is not silently floored to zero.
- Each component is allocated using the actual signed percentage on that layer. Partial placements are not normalised. Cent rounding is reconciled, and paid allocations cannot create negative outstanding amounts through rounding. Per-layer allocations and reinsurer totals are both shown.

For example, a retained loss of 3m, paid 2m and outstanding 1m, against a 2m xs 1m layer with one reinstatement at 100% and annual premium 400k yields: recovery 2m (paid 1m / outstanding 1m), reinstatement premium 400k (200k / 200k), net recovery 1.6m (800k / 800k). A reinsurer signing 60% receives the corresponding 60% allocation.

The paid figure is the cedant's claim payment, not confirmation that a reinsurer has remitted cash. Net outstanding is a reserve, not a current cash request. Risk/Cat cover flags are respected. Layers in another currency are explicitly excluded; there is no implicit FX conversion. This workspace validates loss dates against the contract period and uses occurrence-layer terms; bespoke time-rated reinstatements or other settlement adjustments require a separate agreed calculation.

## Save, review and revise

**Save & calculate** creates one recorded loss event and its draft calculation. Stable claim IDs and revision checks prevent duplicate or conflicting saves. Saved claims feed the dashboard's reported claim count and 100% loss amount.

The preparer approves and submits to a named different senior broker, underwriter or administrator. Only that reviewer can approve or return the calculation. Submitted inputs are locked. Structure, signing or earlier-loss changes make the saved calculation stale and prevent approval until recalculated. Approval records an immutable revision and populates the existing loss exhibit's summary.

**Update claim · new revision** lets the preparer update paid/outstanding development on the same claim, retaining every previous approved snapshot. Every new revision requires independent approval. A change that would alter a later approved claim's aggregate allocation is blocked; paid/outstanding movements with an unchanged retained total can proceed.

This stage records and reviews recoveries; approval does not send a claim advice or request payment. Historical claims retain their existing loss-exhibit and advice workflow. New retained-loss claims are protected from the legacy mutation/advice endpoints, which would otherwise omit the new split or final-placement structure.

## Deployment and verification

Apply migration `054_claims_workspace.sql` through the existing migration process. No new production dependency is required.

`backend/test/unit/claimsAccounting.test.js` covers exact reconciliation, deductible/limit allocation, aggregate exhaustion, AAD, cover/currency exclusions, signed-share rounding and net identities. `backend/test/integration/claimsWorkspace.test.js` runs the database fixture for both placement sources, duplicate prevention, source invalidation, independent approval, dashboard reporting and preserved claim revisions.
