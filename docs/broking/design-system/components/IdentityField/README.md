# IdentityField

The first thing captured on every contract: the Lloyd's UMR, validated for format as it is typed and for uniqueness on blur, plus the business type.

**Consumer provides:** the broker's 4-digit Lloyd's number (pre-fills `B0621`), an `onCheck(umr)` that calls `GET /api/contracts/by-umr/:umr`, and an `onCreate({umr, businessType, parentContractId})` that inserts `bk_contract` and returns the UUID.

**States:** idle (`muted` "B + 4-digit broker no. + up to 12 characters"), invalid format (`danger`, names the rule), checking, taken (`danger`, names the contract that owns it and offers to open it), available (`accent-strong` tick). "Create contract" stays disabled until available.

- Do normalise as the user types: uppercase, strip spaces.
- Do show the UMR in the `umr` type style everywhere afterwards.
- Don't let the user type the UUID — it is shown read-only after creation in `uuid` style.
- Don't allow the UMR to change after creation except through the audited "Amend UMR" action.
