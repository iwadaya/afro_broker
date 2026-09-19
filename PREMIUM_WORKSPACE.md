# Non-proportional premium workspace

Open **Claims & Premium → Non-Proportional → Premium**. The workspace opens on a pop-up that asks which contract: pick the country, then the cedant, then the contract, and the placed structure opens below. **Change contract** brings the pop-up back. Both the signed-layer ledger and confirmed final-placement structures are supported.

## Accounting and approval

1. Select the treaty to see limits, deductibles, reinstatements, premiums, the adjustment rate, rate on line, annual aggregate deductible and annual aggregate limit, and the signing by layer: each reinsurer's signed percentage with its share of the limit and the premium. The aggregate limit is the one the structure states, else the limit and its reinstatements together.
2. Prepare the MDP: confirm the minimum and deposit at 100%, brokerage, instalment schedule and registered recipient for each reinsurer. Missing amounts must be entered; the workspace does not assume the quoted premium is the deposit.
3. Calculate and save. Each reinsurer receives its actual signed percentage; a partially placed panel is never normalised to 100%. Currency totals stay separate and instalment rounding reconciles to the signed account.
4. The preparer approves and submits to a named, different senior broker, underwriter or administrator. Submitted figures and recipients are locked. Only that reviewer can return or approve the account. Changes to the contract, signing or contact register require recalculation before issue.
5. Independent approval creates immutable, numbered PDF notes, then automatically queues their email attachments. No notes or email are created on the preparer's approval alone.

The adjustment opens after contract expiry and at least 12 calendar months from inception. Its terms and recipients are pre-filled from the MDP account — the issued account where there is one, else the saved draft — and the initial EGNPI from the placed structure. Enter the final EGNPI and confirm the terms for each layer:

`Final premium = max(minimum premium, final EGNPI × rate / 100)`

`Adjustment = final premium − deposit previously billed at 100%`

Calculating lists every reinsurer on each layer with its signed share of the deposit billed and of the final premium, the adjustment on its line and what it will receive. A positive adjustment creates debit notes. A negative adjustment creates credit notes only when the approved terms permit return premium. A share with no premium movement gets a numbered nil-adjustment advice instead: independent approval creates it and emails it automatically, it appears with the notes, and it has nothing to settle. The billed deposit is read from the issued MDP, and cannot be overwritten by an adjustment input. Changed signing must be reconciled before adjustment. Adjustment accounts use the same independent approval and delivery process.

## Delivery and settlement

- Apply migrations `053_premium_workspace.sql` and `055_premium_nil_advice.sql` with the normal migration command before starting the updated application.
- Emails use the application's connected Outlook mailbox or configured SMTP transport. The existing SMTP transport requires its optional `nodemailer` dependency. An unconfigured/stub transport is shown as failed outside tests, never as a successful delivery.
- The durable delivery queue is processed after approval and every 30 seconds. Successful deliveries are not resent. A failed configuration can be retried after fixing it.
- If the transport outcome is uncertain, the independent approver must check Sent Items/delivery records, record evidence, and confirm either delivery or that a resend is needed. A send in progress cannot be reconciled until ten minutes have elapsed.
- The preparer or independent approver can record settlement. Issued debit notes feed dashboard paid/due balances and account counts alongside historical MDP notes. Credit notes remain separately visible in the workspace.

This version permits one initial MDP and one final adjustment per treaty. Returned drafts are editable; issued accounts are immutable. Historical MDPs remain visible and are not billed again. The former direct MDP issuance endpoint now directs users into this approval process.

## Verification

`backend/test/unit/premiumAccounting.test.js` covers signed-share rounding, calendar boundaries, minimum premium and return-premium rules, and every share's deposit, final premium and outcome including a nil adjustment. `backend/test/integration/premiumWorkspace.test.js` runs the shared database fixture covering both placement sources, maker/reviewer separation, stale-source rejection, immutable PDFs, debit and credit allocations, the automatically emailed nil-adjustment advice, duplicate prevention, settlement, dashboard balances and uncertain-email reconciliation. Email tests use injected transports and do not contact reinsurers.
