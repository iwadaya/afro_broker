/**
 * The authentic market-standard clauses.
 *
 * Every clause below is a published market form, reproduced from the body that
 * issues it, with its reference, publisher and a source URL recorded on the row
 * so a broker can follow it back. These are the forms the London and treaty
 * markets actually use — LMA and Institute clauses are published by their
 * bodies precisely so the market can put them on slips, and the BRMA treaty
 * articles are the standard US reinsurance wordings reproduced in thousands of
 * public contract filings.
 *
 * Copyright in the LMA, Institute/IUA and BRMA forms remains with those bodies.
 * They are held here for market use, as they are in every broking system, with
 * attribution. **Check the publisher's current version before putting a clause
 * on a live slip** — market forms are revised (LMA3100 → LMA3100A, the cyber
 * and communicable-disease families) and this library is a convenience, not the
 * authority.
 *
 * `seedWordings.js` remains the source of the *illustrative* drafting for the
 * class-specific coverages and extensions, where there is no single published
 * market standard to reproduce. Rows here are marked `provenance:
 * 'market_standard'`; those are marked `illustrative`.
 */

import { query } from './pool.js';

const LMA = "Lloyd's Market Association (LMA)";
const IUA = 'Institute of London Underwriters / IUA';
const BRMA = 'Brokers & Reinsurance Markets Association (BRMA)';
const MARKET = 'Standard treaty market form';

const LMA_NOTE = `Published by the ${LMA} as a model clause for market use; copyright remains with the LMA. Verify against the LMA's current published version before use on a live slip.`;
const IUA_NOTE = `Institute clause, copyright the Institute of London Underwriters / IUA. Reproduced for market use; verify against the current published version before use on a live slip.`;
const BRMA_NOTE = `Standard BRMA treaty article, as reproduced in publicly filed reinsurance contracts. Wording varies slightly between contracts — confirm the form your treaty actually uses.`;
const MARKET_NOTE = `Standard treaty market wording, as reproduced in publicly filed reinsurance contracts. Wording varies between contracts and markets — confirm the form your treaty actually uses.`;

/**
 * Each entry keys on the clause it replaces in the illustrative corpus
 * (`title` + `category` + `cob`), so a library seeded before this existed is
 * upgraded in place rather than gaining a duplicate.
 *
 * Fields: title, category, cob, clause_ref, summary, body, source_*.
 */
export const MARKET_CLAUSES = [
  /* ------------------------------------------- treaty-wide market exclusions */
  {
    title: 'War and Civil War Exclusion',
    category: 'exclusion',
    cob: null,
    clause_ref: 'NMA 464',
    summary: "The Lloyd's Non-Marine Association war exclusion, in market use since 1938.",
    source_org: LMA,
    source_url: 'https://www.lmalloyds.com/',
    source_note: `Approved by Lloyd's Underwriters' Non-Marine Association. ${LMA_NOTE}`,
    body: `Notwithstanding anything to the contrary contained herein this Policy does not cover Loss or Damage directly or indirectly occasioned by, happening through or in consequence of war, invasion, acts of foreign enemies, hostilities (whether war be declared or not), civil war, rebellion, revolution, insurrection, military or usurped power or confiscation or nationalisation or requisition or destruction of or damage to property by or under the order of any government or public or local authority.`,
  },
  {
    title: 'Sanctions Limitation and Exclusion',
    category: 'exclusion',
    cob: null,
    clause_ref: 'LMA 3100',
    summary: 'The market sanctions clause. Suspends cover to the extent it would expose the reinsurer to sanctions.',
    source_org: LMA,
    source_url: 'https://lmalloyds.com/',
    source_note: `${LMA_NOTE} Note LMA3100A (published 5 October 2023) is the same text with the word 'exclusion' removed from the title, reflecting that the clause suspends benefits rather than excluding them outright; LMA3200 is the companion form.`,
    body: `No (re)insurer shall be deemed to provide cover and no (re)insurer shall be liable to pay any claim or provide any benefit hereunder to the extent that the provision of such cover, payment of such claim or provision of such benefit would expose that (re)insurer to any sanction, prohibition or restriction under United Nations resolutions or the trade or economic sanctions, laws or regulations of the European Union, United Kingdom or United States of America.`,
  },
  {
    title: 'Communicable Disease Exclusion',
    category: 'exclusion',
    cob: null,
    clause_ref: 'LMA 5394',
    summary: 'The LMA communicable disease exclusion drafted for property treaty reinsurance (March 2020).',
    source_org: LMA,
    source_url: 'https://lmalloyds.com/wp-content/uploads/2025/06/LMA-Model-Communicable-Disease-Clauses-August-2021.pdf',
    source_note: `LMA model communicable disease clause for property treaty reinsurance, released March 2020. ${LMA_NOTE} The LMA publishes a family of these — LMA5393 for property policies, LMA5394 for property treaty reinsurance, LMA5395/5396 and later forms for other classes.`,
    body: `This reinsurance excludes any loss, damage, claim, cost, expense or other sum directly or indirectly caused by, contributed to by, resulting from, arising out of, or in connection with a Communicable Disease or the fear or threat (whether actual or perceived) of a Communicable Disease regardless of any other cause or event contributing concurrently or in any other sequence thereto.

As used herein, a Communicable Disease means any disease which can be transmitted by means of any substance or agent from any organism to another organism where:

(a) the substance or agent includes, but is not limited to, a virus, bacterium, parasite or other organism or any variation thereof, whether deemed living or not, and

(b) the method of transmission, whether direct or indirect, includes but is not limited to, airborne transmission, bodily fluid transmission, transmission from or to any surface or object, solid, liquid or gas or between organisms, and

(c) the disease, substance or agent can cause or threaten damage to human health or human welfare or can cause or threaten damage to, deterioration of, loss of value of, marketability of or loss of use of property.`,
  },
  {
    title: 'Cyber Loss Absolute Exclusion',
    category: 'exclusion',
    cob: null,
    clause_ref: 'LMA 5401',
    summary: 'Property Cyber and Data Exclusion — the absolute form, with no fire/explosion write-back.',
    source_org: LMA,
    source_url: 'https://lmalloyds.com/specialist-areas/underwriting/wordings/',
    source_note: `LMA5401 "Property Cyber and Data Exclusion" — the absolute form. ${LMA_NOTE} Its companion LMA5400 carries the same operative wording but adds a write-back for physical damage by fire or explosion resulting from a Cyber Incident; pick the form your programme actually agreed.`,
    body: `Notwithstanding any provision to the contrary within this Policy or any endorsement thereto this Policy excludes any:

1.1 Cyber Loss;

1.2 loss, damage, liability, claim, cost, expense of whatsoever nature directly or indirectly caused by, contributed to by, resulting from, arising out of or in connection with any loss of use, reduction in functionality, repair, replacement, restoration or reproduction of any Data, including any amount pertaining to the value of such Data;

regardless of any other cause or event contributing concurrently or in any other sequence thereto.

Definitions

Cyber Loss means any loss, damage, liability, claim, cost or expense of whatsoever nature directly or indirectly caused by, contributed to by, resulting from, arising out of or in connection with any Cyber Act or Cyber Incident including, but not limited to, any action taken in controlling, preventing, suppressing or remediating any Cyber Act or Cyber Incident.

Cyber Act means an unauthorised, malicious or criminal act or series of related unauthorised, malicious or criminal acts, regardless of time and place, or the threat or hoax thereof involving access to, processing of, use of or operation of any Computer System.

Cyber Incident means:
(a) any error or omission or series of related errors or omissions involving access to, processing of, use of or operation of any Computer System; or
(b) any partial or total unavailability or failure or series of related partial or total unavailability or failures to access, process, use or operate any Computer System.

Computer System means any computer, hardware, software, communications system, electronic device (including, but not limited to, smart phone, laptop, tablet, wearable device), server, cloud or microcontroller including any similar system or any configuration of the aforementioned and including any associated input, output, data storage device, networking equipment or back up facility.

Data means information, facts, concepts, code or any other information of any kind that is recorded or transmitted in a form to be used, accessed, processed, transmitted or stored by a Computer System.`,
  },

  /* --------------------------------------------------- treaty-wide conditions */
  {
    title: 'Net Retained Lines',
    category: 'condition',
    cob: null,
    clause_ref: 'BRMA 32B',
    summary: 'The treaty attaches only to what the cedant retains net for its own account.',
    source_org: BRMA,
    source_url: 'https://brma.org/contract_wording.php',
    source_note: BRMA_NOTE,
    body: `This Contract applies only to that portion of any Policy which the Company retains net for its own account (prior to deduction of any underlying reinsurance specifically permitted in this Contract), and in calculating the amount of any loss hereunder and also in computing the amount or amounts in excess of which this Contract attaches, only loss or losses in respect of that portion of any Policy which the Company retains net for its own account shall be included.

It is understood and agreed that the amount of the Reinsurer's liability hereunder in respect of any loss or losses shall not be increased by reason of the inability of the Company to collect from any other reinsurer(s), whether specifically permitted in this Contract or not, any amounts which may have become due from such reinsurer(s), whether such inability arises from the insolvency of such other reinsurer(s) or otherwise.`,
  },
  {
    title: 'Errors and Omissions',
    category: 'condition',
    cob: null,
    clause_ref: 'BRMA 14F',
    summary: 'An inadvertent error does not forfeit cover, provided it is put right on discovery.',
    source_org: BRMA,
    source_url: 'https://brma.org/contract_wording.php',
    source_note: BRMA_NOTE,
    body: `Inadvertent delays, errors or omissions made in connection with this Contract or any transaction hereunder shall not relieve either party from any liability which would have attached had such delay, error or omission not occurred, provided always that such error or omission is rectified as soon as possible after discovery.`,
  },
  {
    title: 'Insolvency of the Reinsured',
    category: 'condition',
    cob: null,
    clause_ref: 'BRMA 19A',
    summary: 'The reinsurance is payable to the estate in full, without diminution for the insolvency.',
    source_org: BRMA,
    source_url: 'https://brma.org/contract_wording.php',
    source_note: `${BRMA_NOTE} The insolvency clause is mandated in substance by US state insurance law (e.g. New York Insurance Law § 1308) for reinsurance to receive statutory credit.`,
    body: `In the event of the insolvency of the Company, this reinsurance shall be payable directly to the Company, or to its liquidator, receiver, conservator or statutory successor on the basis of the liability of the Company without diminution because of the insolvency of the Company or because the liquidator, receiver, conservator or statutory successor of the Company has failed to pay all or a portion of any claim.

It is agreed, however, that the liquidator, receiver, conservator or statutory successor of the Company shall give written notice to the Reinsurer of the pendency of a claim against the Company indicating the Policy reinsured, which claim would involve a possible liability on the part of the Reinsurer within a reasonable time after such claim is filed in the conservation or liquidation proceeding or in the receivership, and that during the pendency of such claim the Reinsurer may investigate such claim and interpose, at its own expense, in the proceeding where such claim is to be adjudicated any defense or defenses that it may deem available to the Company or its liquidator, receiver, conservator or statutory successor.`,
  },
  {
    title: 'Offset',
    category: 'condition',
    cob: null,
    clause_ref: 'BRMA 36C',
    summary: 'Either party may net balances due under the contract.',
    source_org: BRMA,
    source_url: 'https://brma.org/contract_wording.php',
    source_note: BRMA_NOTE,
    body: `The Company and the Reinsurer shall have the right to offset any balance or amounts due from one party to the other under the terms of this Contract. The party asserting the right of offset may exercise such right at any time, whether the balances due are on account of premiums or losses or otherwise.`,
  },
  {
    title: 'Intermediary',
    category: 'condition',
    cob: null,
    clause_ref: 'BRMA 23A',
    summary: 'All communications and money pass through the broker; credit risk sits with the reinsurer on premium and with the broker on claims.',
    source_org: BRMA,
    source_url: 'https://brma.org/contract_wording.php',
    source_note: BRMA_NOTE,
    body: `[Intermediary] is hereby recognized as the Intermediary negotiating this Contract for all business hereunder. All communications (including, but not limited to, notices, statements, premium, return premium, commissions, taxes, losses, loss adjustment expense, salvages and loss settlements) relating thereto shall be transmitted to the Company or the Reinsurer through the Intermediary. Payments by the Company to the Intermediary shall be deemed to constitute payment to the Reinsurer. Payments by the Reinsurer to the Intermediary shall be deemed to constitute payment to the Company only to the extent that such payments are actually received by the Company.`,
  },
  {
    title: 'Arbitration',
    category: 'condition',
    cob: null,
    clause_ref: 'BRMA 6J',
    summary: 'Disputes to a panel of insurance people, reading the treaty as an honourable engagement.',
    source_org: BRMA,
    source_url: 'https://brma.org/contract_wording.php',
    source_note: BRMA_NOTE,
    body: `As a condition precedent to any right of action hereunder, any dispute arising out of the interpretation, performance or breach of this Contract, including the formation or validity thereof, shall be submitted for decision to a panel of three arbitrators. Notice requesting arbitration will be in writing and sent certified or registered mail, return receipt requested.

One arbitrator shall be chosen by each party and the two arbitrators shall, before instituting the hearing, choose an impartial third arbitrator who shall preside at the hearing. The arbitrators shall be disinterested, active or retired officers or executives of insurance or reinsurance companies or Underwriters at Lloyd's, London.

The panel shall interpret this Contract as an honourable engagement rather than as merely a legal obligation and shall not be obliged to follow the strict rules of law or evidence. In making their award they shall apply the custom and practice of the insurance and reinsurance business, with a view to effecting the general purpose of this Contract. The decision of a majority of the panel shall be final and binding upon the parties.`,
  },

  /* -------------------------------------------------- treaty-wide definitions */
  {
    title: 'Ultimate Net Loss',
    category: 'definition',
    cob: null,
    clause_ref: 'BRMA 44B',
    summary: 'What the treaty pays on: paid loss net of recoveries and inuring reinsurance, plus adjustment expense.',
    source_org: BRMA,
    source_url: 'https://brma.org/contract_wording.php',
    source_note: BRMA_NOTE,
    body: `The term "Ultimate Net Loss" shall mean the sum actually paid by the Company in settlement of losses or liability after making deductions for all recoveries, all salvages and all claims upon other reinsurances, whether collected or not, and shall include all costs and adjustment expenses arising from the settlement of claims other than the salaries of employees and the office expenses of the Company.

Nothing herein shall be construed to mean that losses are not recoverable hereunder until the Ultimate Net Loss of the Company has been ascertained. All salvages, recoveries or payments recovered or received subsequent to a loss settlement hereunder shall be applied as if recovered or received prior to the aforesaid settlement, and all necessary adjustments shall be made by the parties hereto.`,
  },
  {
    title: 'Loss Occurrence',
    category: 'definition',
    cob: null,
    clause_ref: 'Hours clause (market standard)',
    summary: 'The hours clause: which individual losses may be aggregated into one occurrence.',
    source_org: MARKET,
    source_url: 'https://brma.org/contract_wording.php',
    source_note: `${MARKET_NOTE} Hour counts are negotiated — 72/168 is the common baseline, but named-windstorm periods of 96, 120 or 504 hours are widely agreed. Set the periods your treaty actually carries.`,
    body: `The term "Loss Occurrence" shall mean all individual losses arising out of and directly occasioned by one catastrophe. However, the duration and extent of any one "Loss Occurrence" shall be limited to all individual losses sustained by the Company occurring during any period of:

(a) 72 consecutive hours as regards hurricane, typhoon, windstorm, rainstorm, hailstorm and/or tornado;
(b) 72 consecutive hours as regards earthquake, seaquake, tidal wave and/or volcanic eruption;
(c) 72 consecutive hours and within the limits of one city, town or village as regards riots, civil commotions and malicious damage;
(d) 168 consecutive hours as regards any other catastrophe of whatsoever nature.

No individual loss which occurs outside these periods shall be included in that Loss Occurrence. The Company may choose the date and time when any such period of consecutive hours commences, provided that it is not earlier than the date and time of the occurrence of the first recorded individual loss sustained by the Company arising out of that catastrophe, and provided that only one such period of consecutive hours shall apply with respect to one catastrophe.`,
  },

  /* -------------------------------------------------------------- Marine */
  {
    title: 'Cyber Attack Exclusion',
    category: 'exclusion',
    cob: 'Marine',
    clause_ref: 'CL 380',
    summary: 'The Institute cyber attack exclusion, with the war/terrorism carve-back for weapon guidance systems.',
    source_org: IUA,
    source_url: 'https://www.lmalloyds.com/',
    source_note: `Institute Cyber Attack Exclusion Clause, 10/11/03. ${IUA_NOTE}`,
    body: `1.1 Subject only to clause 1.2 below, in no case shall this insurance cover loss damage liability or expense directly or indirectly caused by or contributed to by or arising from the use or operation, as a means for inflicting harm, of any computer, computer system, computer software programme, malicious code, computer virus or process or any other electronic system.

1.2 Where this clause is endorsed on policies covering risks of war, civil war, revolution, rebellion, insurrection, or civil strife arising therefrom, or any hostile act by or against a belligerent power, or terrorism or any person acting from a political motive, Clause 1.1 shall not operate to exclude losses (which would otherwise be covered) arising from the use of any computer, computer system or computer software programme or any other electronic system in the launch and/or guidance system and/or firing mechanism of any weapon or missile.`,
  },
  {
    title: 'Radioactive Contamination Exclusion',
    category: 'exclusion',
    cob: 'Marine',
    clause_ref: 'CL 370',
    summary: 'The Institute R.A.C.E. clause — paramount, and overriding anything inconsistent with it.',
    source_org: IUA,
    source_url: 'https://www.lmalloyds.com/',
    source_note: `Institute Radioactive Contamination, Chemical, Biological, Bio-Chemical and Electromagnetic Weapons Exclusion Clause, 10/11/03 (the "R.A.C.E." clause). ${IUA_NOTE}`,
    body: `This clause shall be paramount and shall override anything contained in this insurance inconsistent therewith.

1. In no case shall this insurance cover loss damage liability or expense directly or indirectly caused by or contributed to by or arising from

1.1 ionising radiations from or contamination by radioactivity from any nuclear fuel or from any nuclear waste or from the combustion of nuclear fuel

1.2 the radioactive, toxic, explosive or other hazardous or contaminating properties of any nuclear installation, reactor or other nuclear assembly or nuclear component thereof

1.3 any weapon or device employing atomic or nuclear fission and/or fusion or other like reaction or radioactive force or matter

1.4 the radioactive, toxic, explosive or other hazardous or contaminating properties of any radioactive matter. The exclusion in this sub-clause does not extend to radioactive isotopes, other than nuclear fuel, when such isotopes are being prepared, carried, stored, or used for commercial, agricultural, medical, scientific or other similar peaceful purposes

1.5 any chemical, biological, bio-chemical, or electromagnetic weapon.`,
  },
];

/**
 * Load the market-standard clauses over the illustrative corpus.
 *
 * An existing illustrative clause is *upgraded in place* — same row, so drafts
 * built from it keep their link — but only while nobody has edited it
 * (`version = 1` and no revision history). A clause a firm has already worked
 * on is left exactly as it is and reported as skipped, because their text is
 * the one they meant to have.
 */
export async function seedMarketClauses() {
  let inserted = 0;
  let upgraded = 0;
  let skipped = 0;

  for (const c of MARKET_CLAUSES) {
    const { rows: existing } = await query(
      `SELECT id, version, provenance,
              (SELECT COUNT(*)::int FROM wording_clause_revision r WHERE r.clause_id = w.id) AS revisions
       FROM wording_clause w
       WHERE title = $1 AND category = $2 AND cob IS NOT DISTINCT FROM $3
         AND source = 'standard' AND market_id IS NULL`,
      [c.title, c.category, c.cob],
    );

    if (!existing[0]) {
      await query(
        `INSERT INTO wording_clause
           (title, clause_ref, category, cob, source, body, summary, tags,
            provenance, source_org, source_url, source_note)
         VALUES ($1,$2,$3,$4,'standard',$5,$6,$7,'market_standard',$8,$9,$10)
         ON CONFLICT (title, category, cob, source, market_id) DO NOTHING`,
        [c.title, c.clause_ref, c.category, c.cob, c.body, c.summary,
          [c.cob ? c.cob.toLowerCase() : 'general', 'market standard'],
          c.source_org, c.source_url, c.source_note],
      );
      inserted += 1;
      continue;
    }

    const row = existing[0];
    const untouched = row.version === 1 && row.revisions === 0;
    if (!untouched) {
      skipped += 1;
      continue;
    }

    await query(
      `UPDATE wording_clause
       SET clause_ref = $1, body = $2, summary = $3, provenance = 'market_standard',
           source_org = $4, source_url = $5, source_note = $6, updated_at = now()
       WHERE id = $7`,
      [c.clause_ref, c.body, c.summary, c.source_org, c.source_url, c.source_note, row.id],
    );
    upgraded += 1;
  }

  return { inserted, upgraded, skipped, total: MARKET_CLAUSES.length };
}
