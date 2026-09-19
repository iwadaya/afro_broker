/**
 * Seed the wording library.
 *
 * IMPORTANT — the clause texts below are *illustrative drafting* written for
 * this repository so the library, the draft builder and the comparison screen
 * have realistic material to work on. They are deliberately short paraphrases
 * of the shape a market clause takes; they are **not** the authentic LMA/NMA,
 * Institute or reinsurer wordings, and must not be used on a real slip. A firm
 * putting this into production should clear the library and load its own
 * approved wordings (the API and the CSV-free import path both write to the
 * same tables, and re-running this seed never overwrites an existing clause).
 *
 * Shape of the corpus:
 *   - `cob: null`  — the general treaty conditions, definitions and market
 *                    exclusions that apply to every class.
 *   - `cob: '...'` — coverages, extensions and exclusions for one class.
 *   - market rows  — a named reinsurer's house version of a clause, carrying
 *                    the *same title* as the standard one so the comparison
 *                    engine lines the two up.
 */

import { query } from './pool.js';

/** The reinsurers whose house wordings ship with the library. */
export const TOP_REINSURERS = [
  { name: 'Swiss Re', domicile: 'Switzerland', rating: 'AA-', region: 'EMEA' },
  { name: 'Munich Re', domicile: 'Germany', rating: 'AA-', region: 'EMEA' },
  { name: "Lloyd's", domicile: 'UK', rating: 'AA-', region: 'EMEA' },
  { name: 'Hannover Re', domicile: 'Germany', rating: 'AA-', region: 'EMEA' },
  { name: 'SCOR', domicile: 'France', rating: 'A+', region: 'EMEA' },
  { name: 'Everest Re', domicile: 'Bermuda', rating: 'A+', region: 'Americas' },
  { name: 'PartnerRe', domicile: 'Bermuda', rating: 'A+', region: 'Americas' },
  { name: 'RenaissanceRe', domicile: 'Bermuda', rating: 'A+', region: 'Americas' },
  { name: 'Berkshire Hathaway Re', domicile: 'USA', rating: 'AA+', region: 'Americas' },
  { name: 'Arch Re', domicile: 'Bermuda', rating: 'A+', region: 'Americas' },
  { name: 'TransRe', domicile: 'USA', rating: 'A+', region: 'Americas' },
  { name: 'Africa Re', domicile: 'Nigeria', rating: 'A', region: 'Africa' },
];

/* ------------------------------------------------------------------------ */
/* Standard library — the market-standard wording, by class.                 */
/* ------------------------------------------------------------------------ */

/** General conditions, definitions and exclusions — every class inherits these. */
const GENERAL = [
  ['coverage', 'Reinsuring Clause', null,
    'The operative clause: what the Reinsurer agrees to indemnify.',
    `The Reinsurer agrees to indemnify the Reinsured for the amount of Ultimate Net Loss which the Reinsured becomes liable to pay in respect of business falling within the Business Covered, in excess of the retention and up to the limit stated in the Schedule, arising out of loss occurrences taking place during the period of this Agreement.\n\nThe liability of the Reinsurer shall follow in all respects that of the Reinsured, subject always to the terms, conditions, limitations and exclusions of this Agreement.`],

  ['coverage', 'Business Covered', null,
    'Scope of the subject business ceded to the treaty.',
    `This Agreement covers the Reinsured's net retained liability under all policies, contracts and binders of insurance or reinsurance classified by the Reinsured as the classes of business stated in the Schedule, written or renewed by or on behalf of the Reinsured during the period of this Agreement and in respect of risks situated within the Territorial Scope.`],

  ['extension', 'Reinstatement of Limit', null,
    'How the limit is restored after a loss, and at what cost.',
    `In the event of loss under this Agreement, the limit is automatically reinstated for the number of reinstatements stated in the Schedule.\n\nEach reinstatement is subject to additional premium calculated pro rata as to the amount of limit reinstated and, unless the Schedule states otherwise, 100% as to time. Additional premium is due at the time the loss is settled and may be offset against the loss payment.`],

  ['extension', 'Extended Expiry', null,
    'Cover for a loss occurrence running over the expiry of the treaty.',
    `Where a loss occurrence begins before and continues beyond the expiry of this Agreement, this Agreement shall cover the whole of that loss occurrence provided it commenced during the period of this Agreement, up to a maximum of the hours stated in the Loss Occurrence definition. No loss occurrence commencing after expiry is covered.`],

  ['exclusion', 'War and Civil War Exclusion', 'War (market standard)',
    'Excludes loss from war, invasion, hostilities and civil war.',
    `This Agreement excludes all loss, damage, liability, cost or expense directly or indirectly caused by, contributed to by, resulting from or arising out of war, invasion, acts of foreign enemies, hostilities or warlike operations (whether war be declared or not), civil war, rebellion, revolution, insurrection, civil commotion assuming the proportions of or amounting to an uprising, military or usurped power, or confiscation, nationalisation, requisition or destruction of property by or under the order of any government or public authority.\n\nThis exclusion does not apply to marine, aviation and transit business written on standard market war terms where those terms are expressly declared to and accepted by the Reinsurer.`],

  ['exclusion', 'Nuclear Energy Risks Exclusion', 'Nuclear (market standard)',
    'Excludes nuclear installations and radioactive contamination.',
    `This Agreement excludes all loss, damage, liability, cost or expense directly or indirectly caused by, contributed to by or arising from ionising radiation or contamination by radioactivity from any nuclear fuel or from any nuclear waste from the combustion of nuclear fuel, or from the radioactive, toxic, explosive or other hazardous properties of any nuclear assembly or nuclear component thereof.\n\nNuclear energy risks, as defined by the nuclear risks exclusion agreements in force in the relevant territory, are excluded in their entirety.`],

  ['exclusion', 'Terrorism Exclusion', null,
    'Excludes acts of terrorism, with a limited write-back for pooled schemes.',
    `This Agreement excludes all loss, damage, liability, cost or expense directly or indirectly caused by, resulting from or in connection with any act of terrorism, regardless of any other cause or event contributing concurrently or in any other sequence to the loss.\n\nAn act of terrorism means an act, including the use of force or violence or the threat thereof, of any person or group acting for or in connection with any organisation or government, committed for political, religious, ideological or similar purposes, including the intention to influence any government or to put the public in fear.\n\nWhere the Reinsured cedes business to a government-backed terrorism pool, losses recoverable from that pool are excluded from Ultimate Net Loss.`],

  ['exclusion', 'Cyber Loss Absolute Exclusion', 'Cyber (market standard)',
    'Absolute exclusion of cyber act and cyber incident losses.',
    `Notwithstanding any provision to the contrary, this Agreement excludes all loss, damage, liability, cost or expense of any kind directly or indirectly caused by, contributed to by, resulting from, arising out of or in connection with any cyber act or cyber incident, including any action taken to control, prevent, suppress or remediate a cyber act or cyber incident.\n\nCyber act means an unauthorised, malicious or criminal act involving access to, processing of, use of or operation of any computer system. Cyber incident means any error or omission, or any partial or total unavailability or failure, of any computer system.`],

  ['exclusion', 'Communicable Disease Exclusion', 'Communicable disease (market standard)',
    'Excludes loss arising from communicable disease and fear of it.',
    `This Agreement excludes all loss, damage, liability, cost or expense directly or indirectly arising out of, attributable to, or occurring concurrently or in any sequence with a communicable disease or the fear or threat, whether actual or perceived, of a communicable disease.\n\nCommunicable disease means any disease which can be transmitted by means of any substance or agent from any organism to another organism where the substance or agent induces or is capable of inducing physical distress, illness or disease, or where the disease may cause damage to human health or human welfare or to property.`],

  ['exclusion', 'Sanctions Limitation and Exclusion', 'Sanctions (market standard)',
    'No cover or payment where it would expose the Reinsurer to sanctions.',
    `No Reinsurer shall be deemed to provide cover and no Reinsurer shall be liable to pay any claim or provide any benefit under this Agreement to the extent that the provision of such cover, payment of such claim or provision of such benefit would expose that Reinsurer to any sanction, prohibition or restriction under United Nations resolutions or the trade or economic sanctions, laws or regulations of the European Union, the United Kingdom or the United States of America.`],

  ['exclusion', 'Asbestos Exclusion', null,
    'Excludes asbestos-related bodily injury and property damage.',
    `This Agreement excludes all loss, damage, liability, cost or expense arising directly or indirectly out of the manufacture, mining, processing, distribution, testing, remediation, removal, storage, disposal, sale, use of or exposure to asbestos or materials or products containing asbestos, whether or not the asbestos is or was at any time airborne as a fibre or particle, contained in a product, carried on clothing, or transmitted by any other means.`],

  ['exclusion', 'Seepage, Pollution and Contamination Exclusion', null,
    'Excludes gradual pollution; sudden and accidental may be written back.',
    `This Agreement excludes all loss, damage, liability, cost or expense arising out of seepage, pollution or contamination, and any cost of removing, nullifying or cleaning up seeping, polluting or contaminating substances.\n\nThis exclusion does not apply where the seepage, pollution or contamination is caused by a sudden, unintended and unexpected happening during the period of this Agreement, and is reported to the Reinsured within the notification period stated in the original policy.`],

  ['exclusion', 'Fines and Penalties Exclusion', null,
    'Excludes punitive awards and regulatory fines.',
    `This Agreement excludes fines, penalties, taxes, punitive, exemplary, multiplied or vindictive damages, and any additional damages awarded against the Reinsured by way of punishment rather than compensation, together with any sum awarded for the Reinsured's own bad faith, wilful misconduct or breach of duty in the handling of a claim.`],

  ['exclusion', 'Financial Guarantee Exclusion', null,
    'Excludes financial guarantee and credit-enhancement business.',
    `This Agreement excludes financial guarantee business, credit enhancement, residual value insurance, and any insurance or reinsurance of the financial performance, solvency or creditworthiness of any person or entity, save where such business is written under a Credit and Surety section expressly declared in the Schedule.`],

  ['condition', 'Net Retained Lines', null,
    'The treaty applies only to what the Reinsured actually retains.',
    `This Agreement applies only to that portion of any insurance or reinsurance which the Reinsured retains net for its own account. In calculating the amount of any loss and the retention, only loss or losses in respect of that portion shall be included.\n\nThe amount of the Reinsurer's liability shall not be increased by reason of the inability of the Reinsured to collect from any other reinsurer, whether by reason of insolvency or otherwise.`],

  ['condition', 'Errors and Omissions', null,
    'An inadvertent error does not prejudice cover.',
    `Any inadvertent delay, omission or error on the part of either party shall not be held to relieve either party of liability under this Agreement, provided the delay, omission or error is rectified as soon as practicable after discovery.`],

  ['condition', 'Claims Notification and Co-operation', null,
    'When and how the Reinsurer is told about a claim.',
    `The Reinsured shall advise the Reinsurer as soon as practicable of any loss occurrence which, in the Reinsured's reasonable opinion, may result in a claim under this Agreement, and in any event of any loss reserved at 50% or more of the retention.\n\nThe Reinsured shall provide such further information as the Reinsurer may reasonably require. The Reinsurer shall have the right, at its own expense, to co-operate with the Reinsured in the investigation, adjustment and defence of any claim which may involve this Agreement.`],

  ['condition', 'Loss Settlements', null,
    'Follow the settlements — the Reinsurer is bound by proper settlements.',
    `All loss settlements made by the Reinsured, provided they are within the terms and conditions of the original policies and within the terms and conditions of this Agreement, shall be binding upon the Reinsurer.\n\nUpon receipt of a reasonable proof of loss, the Reinsurer shall promptly pay its share of the settlement. Payment shall be made in the currency in which the loss was settled.`],

  ['condition', 'Access to Records', null,
    'Inspection rights over the Reinsured’s books relating to the treaty.',
    `The Reinsurer, or its duly appointed representatives, shall have the right at any reasonable time during the currency of this Agreement, and for a period of three years thereafter, to inspect at the offices of the Reinsured all books, records and papers relating to business ceded under this Agreement.\n\nInspection shall be on reasonable notice and shall not unreasonably interfere with the Reinsured's business.`],

  ['condition', 'Premium Payment', null,
    'Payment terms for deposit, instalment and adjustment premium.',
    `Deposit premium shall be payable in equal instalments in accordance with the Schedule. Adjustment premium, if any, shall be payable within 60 days of the date on which the adjustment statement is rendered.\n\nIf any premium remains unpaid 90 days after the due date, the Reinsurer may give 15 days' notice of cancellation, such cancellation to be without prejudice to premium earned to the date of cancellation.`],

  ['condition', 'Currency Conversion', null,
    'How non-treaty currencies are converted for premium and loss.',
    `Amounts in currencies other than the currency of this Agreement shall be converted at the rate of exchange used in the Reinsured's books at the date the premium was booked or the loss was settled, as applicable. Where no such rate is available, the closing mid-market rate on the relevant date shall apply.`],

  ['condition', 'Offset', null,
    'Netting of balances between the parties.',
    `Each party shall have, and may exercise at any time, the right to offset any balance or balances, whether on account of premium, commission, claims, losses, adjustments or otherwise, due from one party to the other under this Agreement or under any other agreement between them.`],

  ['condition', 'Insolvency of the Reinsured', null,
    'The Reinsurer pays the estate, without diminution, on insolvency.',
    `In the event of the insolvency of the Reinsured, the reinsurance provided by this Agreement shall be payable by the Reinsurer on the basis of the liability of the Reinsured under the policies reinsured, without diminution because of the insolvency of the Reinsured or because the liquidator, receiver or statutory successor has failed to pay all or a portion of any claim.`],

  ['condition', 'Special Termination', null,
    'When either party may cancel mid-term.',
    `Either party may terminate this Agreement immediately by written notice if the other party: loses part of its paid-up capital; is placed in liquidation, receivership or administration; has its licence or authorisation withdrawn; suffers a downgrade of its financial strength rating below A- from a recognised rating agency; merges with or is acquired by another entity; or fails to comply with any material term of this Agreement.\n\nTermination may be on a cut-off or run-off basis at the election of the terminating party.`],

  ['condition', 'Arbitration', null,
    'Disputes go to a three-arbitrator panel of insurance people.',
    `All disputes arising out of or in connection with this Agreement shall be referred to arbitration. Each party shall appoint one arbitrator and the two so appointed shall appoint a third before entering upon the reference. The arbitrators shall be active or retired executives of insurance or reinsurance companies or Lloyd's underwriters.\n\nThe arbitrators shall interpret this Agreement as an honourable engagement rather than merely as a legal obligation, and shall make their award with a view to effecting the general purpose of this Agreement. The decision of the majority shall be final and binding.`],

  ['condition', 'Governing Law and Jurisdiction', null,
    'The law of the contract and the forum for disputes.',
    `This Agreement shall be governed by and construed in accordance with the law stated in the Schedule, and the parties submit to the exclusive jurisdiction of the courts of that territory, save for matters referred to arbitration under the Arbitration clause.`],

  ['condition', 'Intermediary', null,
    'All communications and money flow through the broker.',
    `The intermediary named in the Schedule is recognised as the intermediary negotiating this Agreement, through whom all communications shall be transmitted. Payments by the Reinsured to the intermediary shall be deemed payment to the Reinsurer; payments by the Reinsurer to the intermediary shall be deemed payment to the Reinsured only to the extent that such payments are actually received by the Reinsured.`],

  ['condition', 'Confidentiality and Data Protection', null,
    'Confidentiality of ceded data and processing obligations.',
    `Each party shall keep confidential all information disclosed under this Agreement and shall not disclose it to any third party save to its professional advisers, retrocessionaires and regulators, or as required by law.\n\nWhere personal data is transferred under this Agreement, each party shall comply with applicable data protection legislation and shall implement appropriate technical and organisational measures to protect that data.`],

  ['definition', 'Ultimate Net Loss', null,
    'What counts as loss, and what is deducted before the treaty responds.',
    `Ultimate Net Loss means the sum actually paid by the Reinsured in settlement of losses or liability, after making deductions for all recoveries, salvages and all claims upon other reinsurances, whether collected or not, and including loss adjustment expenses and court costs incurred by the Reinsured in the defence of a claim.\n\nSalvages and recoveries received subsequent to a loss settlement under this Agreement shall be applied as if received prior to the settlement, and all necessary adjustments shall be made between the parties.\n\nThe office expenses of the Reinsured and the salaries of its employees are not included in Ultimate Net Loss.`],

  ['definition', 'Loss Occurrence', null,
    'The hours clause: what aggregates into a single occurrence.',
    `Loss Occurrence means all individual losses arising out of and directly occasioned by one catastrophe. However, the duration and extent of any one loss occurrence shall be limited to: 72 consecutive hours for hurricane, typhoon, windstorm, rainstorm, hailstorm or tornado; 72 consecutive hours for earthquake, seaquake, tidal wave or volcanic eruption; 72 consecutive hours for riot, civil commotion or malicious damage; and 168 consecutive hours for any other loss occurrence.\n\nNo individual loss which occurs outside these periods may be included in that loss occurrence. The Reinsured may choose the date and time at which any such period commences, provided it is not earlier than the first recorded individual loss, and provided that only one such period shall apply to each catastrophe.`],

  ['definition', 'Territorial Scope', null,
    'Where the underlying risks must be situated.',
    `This Agreement applies to risks situated in the territories stated in the Schedule. Where a policy covers risks both inside and outside those territories, only that portion of the policy relating to risks within the territories shall be ceded, unless otherwise agreed in writing.`],
];

/** Class-specific coverages, extensions and exclusions. */
const BY_CLASS = {
  Property: [
    ['coverage', 'Property Damage — Fire and Allied Perils', null,
      'The core property physical damage cover.',
      `Cover is granted for physical loss of or damage to insured property caused by fire, lightning, explosion, aircraft impact, riot and strike, malicious damage, storm, flood, escape of water, impact by vehicles or animals, and such other perils as are stated in the original policy, occurring during the period of insurance.`],
    ['coverage', 'Business Interruption', null,
      'Loss of gross profit following an insured damage event.',
      `Cover is granted for loss of gross profit, increased cost of working and, where stated, additional increased cost of working, resulting from interruption of or interference with the business carried on by the insured at the premises, following damage which is itself recoverable under the Property Damage section, for the indemnity period stated in the original policy.`],
    ['extension', 'Debris Removal', null,
      'Costs of clearing debris after an insured loss.',
      `This Agreement extends to include the costs and expenses necessarily incurred by the insured in removing debris, dismantling, demolishing, shoring up or propping the portions of the insured property destroyed or damaged by an insured peril.\n\nCover under this extension is limited to 10% of the sum insured on the damaged property, or the amount stated in the original policy if lower, and applies only to debris on the insured premises.`],
    ['extension', 'Professional Fees', null,
      'Architects, surveyors and consulting engineers fees on reinstatement.',
      `This Agreement extends to include architects', surveyors', consulting engineers' and other professional fees necessarily and reasonably incurred in the reinstatement of insured property following damage by an insured peril, but excluding any fees incurred in the preparation of a claim.\n\nCover under this extension is limited to 10% of the sum insured on the damaged property unless otherwise stated.`],
    ['extension', 'Temporary Removal', null,
      'Property temporarily away from the premises stays covered.',
      `Insured property temporarily removed from the premises for cleaning, renovation, repair or similar purposes remains covered while so removed, and while in transit, within the territorial limits, for up to 10% of its sum insured.`],
    ['extension', 'Capital Additions', null,
      'Automatic cover for newly acquired property, subject to declaration.',
      `Newly acquired buildings, plant, machinery and contents, and alterations and additions to existing insured property, are automatically covered from the date of acquisition or commencement, subject to a limit of 10% of the total sum insured and to declaration to the Reinsured within 90 days.`],
    ['extension', 'Automatic Reinstatement of Sum Insured', null,
      'The sum insured is restored after a loss, for additional premium.',
      `In the absence of written notice to the contrary, the sum insured shall be automatically reinstated from the date of loss, and the insured shall pay additional premium calculated pro rata from the date of loss to the expiry of the period of insurance.`],
    ['extension', 'Fire Extinguishing Expenses', null,
      'Fire brigade charges and extinguishing costs.',
      `This Agreement extends to include fire brigade charges, the cost of refilling fire extinguishing appliances, and the cost of extinguishing materials expended, where incurred in connection with an insured peril operating on the insured property.`],
    ['exclusion', 'Unoccupied Buildings Exclusion', null,
      'Cover restricts once a building has stood empty.',
      `Buildings which have been unoccupied for more than 30 consecutive days are excluded, save for loss or damage by fire and lightning, unless the Reinsured has agreed the unoccupancy in writing and appropriate conditions of cover have been imposed.`],
    ['exclusion', 'Defective Design, Materials and Workmanship Exclusion', 'LEG 2 equivalent',
      'Excludes the defect itself; resulting damage is covered.',
      `This Agreement excludes the cost of rectifying or replacing any part of the insured property in a defective condition due to defective design, plan, specification, materials or workmanship.\n\nThis exclusion is limited to the costs which would have been incurred to rectify the defect immediately before the damage occurred; loss or damage to other property resulting from that defect is not excluded.`],
    ['exclusion', 'Wear, Tear and Gradual Deterioration Exclusion', null,
      'Excludes the ordinary consequences of use and time.',
      `This Agreement excludes wear and tear, gradual deterioration, rust, corrosion, oxidation, dampness of atmosphere, change in temperature, marring, scratching, inherent vice, latent defect, vermin, insects, and any gradually operating cause.`],
    ['exclusion', 'Mould, Fungus and Spores Exclusion', null,
      'Excludes mould whether or not following an insured peril.',
      `This Agreement excludes all loss, damage, liability, cost or expense arising directly or indirectly out of mould, mildew, fungus, spores or other micro-organism of any type, nature or description, including any substance whose presence poses an actual or potential threat to human health.`],
    ['exclusion', 'Flood and Earthquake Exclusion', null,
      'Elemental perils excluded unless separately declared and rated.',
      `Loss or damage caused by flood, inundation, earthquake, seaquake, tidal wave, volcanic eruption or subterranean fire is excluded, unless such perils are expressly declared to and accepted by the Reinsurer and rated accordingly in the Schedule.`],
  ],

  'Property Cat': [
    ['coverage', 'Catastrophe Excess of Loss Cover', null,
      'The cat treaty operative clause.',
      `The Reinsurer shall pay the amount of Ultimate Net Loss sustained by the Reinsured in each and every loss occurrence in excess of the retention stated in the Schedule, subject to the limit stated in the Schedule in respect of each and every loss occurrence and in the aggregate for the number of reinstatements provided.`],
    ['extension', 'Loss Adjustment Expenses', null,
      'Adjuster and expert costs are included in the loss.',
      `Loss adjustment expenses, being the fees and expenses of independent loss adjusters, surveyors, experts and legal advisers incurred by the Reinsured in the investigation and settlement of losses arising from a covered loss occurrence, shall be included in Ultimate Net Loss in the same proportion as the loss itself.`],
    ['exclusion', 'Non-Elemental Loss Exclusion', null,
      'The cat programme responds only to natural perils.',
      `This Agreement covers only loss occurrences arising from natural perils. Losses arising from fire, explosion, machinery breakdown, theft, riot, strike, malicious damage or any other non-elemental cause are excluded unless they arise as a direct consequence of a covered natural peril.`],
    ['exclusion', 'Aggregation of Unrelated Events Exclusion', null,
      'Separate events cannot be stitched into one occurrence.',
      `Losses arising from meteorologically or seismologically distinct events may not be aggregated into a single loss occurrence, notwithstanding that they may fall within the same hours period, unless they arise from one identifiable catastrophe as defined in the Loss Occurrence clause.`],
    ['definition', 'Loss Occurrence — Catastrophe', null,
      'Cat-specific hours clause with per-peril periods.',
      `Loss Occurrence means all individual losses arising out of and directly occasioned by one catastrophe, limited to: 168 consecutive hours for named windstorm and its associated storm surge and rainfall flooding; 72 consecutive hours for all other windstorm, hailstorm and tornado; 168 consecutive hours for earthquake and its associated fire following, tsunami and sprinkler leakage; 168 consecutive hours for flood not arising from named windstorm; and 72 consecutive hours for all other perils.\n\nThe Reinsured may elect the commencement of each period, provided no two periods overlap in respect of the same catastrophe and no period commences earlier than the first recorded individual loss.`],
  ],

  Casualty: [
    ['coverage', 'General Third Party Liability', null,
      'Legal liability to third parties for injury and damage.',
      `Cover is granted for the insured's legal liability to pay compensation, and claimants' costs and expenses, in respect of accidental bodily injury to any person or accidental loss of or damage to material property, occurring during the period of insurance and arising out of the business carried on by the insured within the territorial limits.`],
    ['coverage', "Employers' Liability", null,
      'Liability to employees for injury arising out of employment.',
      `Cover is granted for the insured's legal liability to pay compensation in respect of bodily injury, disease or illness sustained by any employee, arising out of and in the course of employment by the insured, and caused during the period of insurance within the territorial limits.`],
    ['extension', 'Defence Costs and Expenses', null,
      'Costs of defending a covered claim, in addition to the limit.',
      `This Agreement extends to include costs and expenses incurred with the written consent of the Reinsured in the investigation, defence or settlement of any claim covered by this Agreement.\n\nWhere such costs are payable in addition to the limit of indemnity under the original policy, they shall be included in Ultimate Net Loss in the same proportion that the amount payable under this Agreement bears to the total amount payable by the insured.`],
    ['extension', 'Extended Reporting Period', null,
      'Run-off reporting window on claims-made business.',
      `Where the original policy is written on a claims-made basis, cover extends to claims first made against the insured and notified to the Reinsured within the extended reporting period stated in the original policy, provided the act, error or omission giving rise to the claim occurred after the retroactive date and before expiry.`],
    ['extension', 'Contractual Liability', null,
      'Liability assumed under contract, within limits.',
      `Liability assumed by the insured under the terms of a written contract or agreement is covered, provided such liability would have attached in the absence of the contract, or the contract has been declared to and accepted by the Reinsured.`],
    ['exclusion', 'Abuse and Molestation Exclusion', null,
      'Excludes sexual abuse and molestation claims.',
      `This Agreement excludes all loss, damage, liability, cost or expense arising directly or indirectly out of any actual, alleged or threatened sexual abuse, sexual molestation, physical abuse or corporal punishment, including any negligent employment, supervision, retention or reporting in connection therewith.`],
    ['exclusion', 'PFAS and Forever Chemicals Exclusion', null,
      'Excludes per- and polyfluoroalkyl substances liability.',
      `This Agreement excludes all loss, damage, liability, cost or expense arising directly or indirectly out of the manufacture, distribution, sale, handling, storage, disposal of, or exposure to, per- and polyfluoroalkyl substances (PFAS), including perfluorooctanoic acid and perfluorooctane sulfonate, or any product or material containing them.`],
    ['exclusion', 'Punitive and Exemplary Damages Exclusion', null,
      'Excludes non-compensatory damages awards.',
      `This Agreement excludes punitive, exemplary, multiplied, aggravated or vindictive damages, however denominated, and any statutory multiplication of a compensatory award, whether or not insurable under the law of the place of award.`],
    ['exclusion', 'Professional Indemnity Exclusion', null,
      'Excludes liability arising from professional advice.',
      `This Agreement excludes liability arising out of the rendering of or failure to render any professional advice or service, or any error or omission in connection therewith, save where such liability is incidental to the insured's principal business and has been declared to the Reinsured.`],
    ['exclusion', 'USA and Canada Jurisdiction Exclusion', null,
      'Excludes claims brought in North American courts.',
      `This Agreement excludes all claims made or brought in, or judgments obtained in, the courts of the United States of America or Canada, or any territory under their jurisdiction, and any claim for enforcement of such a judgment, unless expressly declared to and accepted by the Reinsurer.`],
  ],

  Motor: [
    ['coverage', 'Motor Third Party Liability', null,
      'Compulsory motor liability cover for the insured vehicle.',
      `Cover is granted for the insured's legal liability arising out of the use of a motor vehicle on a road or other public place in respect of death of or bodily injury to any third party, and loss of or damage to third party property, to the limits required by the applicable motor insurance legislation or as stated in the original policy.`],
    ['coverage', 'Motor Own Damage', null,
      'Accidental damage to the insured vehicle.',
      `Cover is granted for accidental loss of or damage to the insured vehicle and its accessories and spare parts while thereon, caused by accidental external means, fire, self-ignition, lightning, explosion, burglary, housebreaking, theft, malicious act, or whilst in transit.`],
    ['extension', 'Passenger Liability', null,
      'Liability to passengers carried in the insured vehicle.',
      `This Agreement extends to include the insured's legal liability in respect of death of or bodily injury to passengers being carried in or entering or alighting from the insured vehicle, whether or not for hire or reward, up to the limit stated in the original policy.`],
    ['extension', 'Emergency Medical Expenses', null,
      'Immediate medical treatment costs after an accident.',
      `This Agreement extends to include reasonable medical expenses necessarily incurred in the immediate treatment of injuries sustained by the driver and occupants of the insured vehicle in an accident covered by the original policy, up to the sub-limit stated therein.`],
    ['extension', 'Legal Defence Costs', null,
      'Defending prosecutions arising from an insured accident.',
      `This Agreement extends to include legal costs and expenses incurred with the consent of the Reinsured in defending proceedings, including manslaughter or culpable homicide proceedings, brought against the insured or driver arising out of an accident covered by the original policy.`],
    ['exclusion', 'Racing and Speed Testing Exclusion', null,
      'Excludes competitive and track use.',
      `This Agreement excludes loss, damage or liability arising while the insured vehicle is being used for racing, pace-making, rallying, speed testing, hill climbing, or any competitive event, or while on a circuit or track designed for such purposes.`],
    ['exclusion', 'Unlicensed or Disqualified Driver Exclusion', null,
      'No cover where the driver is not entitled to drive.',
      `This Agreement excludes loss, damage or liability arising while the insured vehicle is being driven by any person who does not hold a valid licence to drive the vehicle, or who is disqualified from holding or obtaining such a licence, or who is in breach of the conditions of that licence, save where cover is required by compulsory motor insurance legislation.`],
    ['exclusion', 'Use Outside Territorial Limits Exclusion', null,
      'Cover stops at the declared territorial boundary.',
      `This Agreement excludes loss, damage or liability arising while the insured vehicle is outside the territorial limits stated in the Schedule, unless cover has been extended by the Reinsured in writing prior to the loss.`],
  ],

  Marine: [
    ['coverage', 'Marine Cargo', null,
      'All risks of loss or damage to insured cargo in transit.',
      `Cover is granted for all risks of loss of or damage to the subject-matter insured, from the time the goods leave the warehouse at the place named for the commencement of the transit, during the ordinary course of transit, until delivery to the final warehouse at the destination named, subject to the duration and termination provisions of the original policy.`],
    ['coverage', 'Marine Hull and Machinery', null,
      'Physical damage to the insured vessel and its machinery.',
      `Cover is granted for loss of or damage to the insured vessel, its machinery, equipment and stores, caused by perils of the seas, rivers, lakes or other navigable waters, fire, explosion, violent theft, jettison, piracy, contact with land conveyance, dock or harbour equipment, earthquake, volcanic eruption or lightning, and by accidents in loading, discharging or shifting cargo or fuel.`],
    ['extension', 'War, Strikes, Riots and Civil Commotions', null,
      'Marine war and strikes cover on standard market terms.',
      `Where the original policy is extended on standard market war and strikes terms, this Agreement follows that extension in respect of loss of or damage to the subject-matter insured caused by war, civil war, capture, seizure, arrest, derelict mines, strikers, locked-out workmen, persons taking part in labour disturbances, riots or civil commotions, terrorists, or any person acting from a political motive.`],
    ['extension', 'General Average and Salvage', null,
      'Contributions to general average and salvage charges.',
      `This Agreement extends to include general average, salvage and salvage charges, adjusted or determined according to the contract of affreightment or the governing law and practice, incurred to avoid or in connection with the avoidance of loss from a peril insured against.`],
    ['extension', 'Deviation, Delay and Forced Discharge', null,
      'Cover held covered where the voyage changes involuntarily.',
      `Cover continues during any deviation, delay, forced discharge, reshipment or transhipment, and during any variation of the adventure arising from the exercise of a liberty granted to the carrier under the contract of carriage, provided the circumstances are beyond the control of the insured and prompt notice is given.`],
    ['exclusion', 'Radioactive Contamination Exclusion', 'Marine radioactive (market standard)',
      'Excludes radioactive, chemical, biological and electromagnetic weapons.',
      `This Agreement excludes loss, damage, liability or expense directly or indirectly caused by or contributed to by or arising from ionising radiations from or contamination by radioactivity from any nuclear fuel or waste, from any nuclear installation, reactor or assembly, from any weapon or device employing atomic or nuclear fission or fusion, from any radioactive matter, or from any chemical, biological, bio-chemical or electromagnetic weapon.`],
    ['exclusion', 'Cyber Attack Exclusion', 'Marine cyber (market standard)',
      'Excludes loss caused by malicious use of computer systems.',
      `This Agreement excludes loss, damage, liability or expense directly or indirectly caused by or contributed to by or arising from the use or operation, as a means for inflicting harm, of any computer, computer system, computer software programme, malicious code, computer virus, process or any other electronic system.`],
    ['exclusion', 'Unseaworthiness and Unfitness Exclusion', null,
      'No cover where the insured knew the vessel was unfit.',
      `This Agreement excludes loss, damage or expense arising from unseaworthiness of the vessel or craft, or unfitness of the vessel, craft, conveyance, container or lift van for the safe carriage of the subject-matter insured, where the insured or their servants are privy to such unseaworthiness or unfitness at the time the subject-matter insured is loaded therein.`],
    ['exclusion', 'Insufficiency of Packing Exclusion', null,
      'Excludes loss caused by inadequate packing or preparation.',
      `This Agreement excludes loss, damage or expense caused by insufficiency or unsuitability of packing or preparation of the subject-matter insured, where such packing or preparation is carried out by the insured or their servants, or prior to the attachment of the insurance.`],
  ],

  Engineering: [
    ['coverage', "Contractors' and Erection All Risks", null,
      'Physical damage to works under construction or erection.',
      `Cover is granted for sudden and unforeseen physical loss of or damage to the contract works, construction plant and equipment, and materials on site, occurring during the period of construction or erection stated in the original policy, from any cause not specifically excluded.`],
    ['coverage', 'Machinery Breakdown', null,
      'Sudden and unforeseen damage to insured machinery.',
      `Cover is granted for sudden and unforeseen physical damage to the insured machinery, whilst at work or at rest, or being dismantled for cleaning, overhauling or relocation within the premises, caused by defects in casting and material, faulty design, faults at workshop or in erection, bad workmanship, lack of skill, carelessness, shortage of water in boilers, physical explosion, tearing apart on account of centrifugal force, short circuit, storm, or any other cause not specifically excluded.`],
    ['extension', 'Testing and Commissioning', null,
      'Cover during the testing period of erected plant.',
      `Cover extends to the period of testing and commissioning of erected plant and machinery, limited to four weeks from the commencement of testing, or such longer period as is stated in the Schedule. For second-hand plant, cover ceases upon commencement of testing unless otherwise agreed.`],
    ['extension', 'Extended Maintenance', null,
      'Damage during the maintenance period, including contractor visits.',
      `Cover extends to loss of or damage to the contract works occurring during the maintenance period stated in the original policy, caused by the insured contractor in the course of operations carried out for the purpose of complying with the maintenance obligations, and to loss or damage occurring during the construction period but discovered during the maintenance period.`],
    ['extension', 'Off-Site Storage', null,
      'Materials stored away from site remain insured.',
      `Cover extends to materials and equipment destined for incorporation in the contract works while stored at a location away from the contract site within the territorial limits, up to the sub-limit stated in the Schedule, provided the storage location is secure and has been notified to the Reinsured.`],
    ['exclusion', 'Defective Design and Workmanship Exclusion', 'LEG 2/96 equivalent',
      'The cost of putting the defect right is excluded.',
      `This Agreement excludes the costs which would have been incurred to rectify the defective design, plan, specification, material or workmanship immediately before the damage occurred. Loss of or damage to other portions of the contract works resulting from that defect is covered.`],
    ['exclusion', 'Liquidated Damages and Delay Penalties Exclusion', null,
      'Excludes contractual penalties for late completion.',
      `This Agreement excludes liquidated damages, penalties for delay or detention, and any consequential loss arising from non-performance or delayed performance of a contract, whether or not resulting from insured physical damage.`],
    ['exclusion', 'Cessation of Work Exclusion', null,
      'Cover restricts once the site is idle.',
      `This Agreement excludes loss or damage occurring after work on the contract site has ceased for a continuous period exceeding 30 days, unless the cessation and the protective measures taken have been notified to and agreed by the Reinsured in writing.`],
  ],

  Aviation: [
    ['coverage', 'Aviation Hull and Liability', null,
      'Hull all risks and third party/passenger legal liability.',
      `Cover is granted for accidental physical loss of or damage to the insured aircraft, whether in flight, taxiing or on the ground, and for the insured's legal liability for bodily injury to passengers and third parties and for damage to third party property, arising out of the ownership, maintenance or operation of the insured aircraft.`],
    ['extension', 'Hull War, Hijacking and Allied Perils', null,
      'War risks buy-back for hull, on standard market terms.',
      `Where the original policy is extended on standard market hull war terms, this Agreement follows that extension in respect of loss of or damage to the insured aircraft caused by war, hijacking, confiscation, sabotage, strikes, riots and civil commotions, subject to the sub-limits and territorial write-backs stated in the original policy.`],
    ['extension', 'Aircraft Spares and Equipment', null,
      'Spares held on the ground or in transit.',
      `Cover extends to accidental loss of or damage to aircraft spares, tools and ground equipment owned by or in the care, custody or control of the insured, whilst on the ground at declared locations or in transit within the territorial limits, up to the sub-limit stated in the Schedule.`],
    ['exclusion', 'War, Hijacking and Other Perils Exclusion', 'AVN 48B equivalent',
      'The standard aviation war exclusion, subject to buy-back.',
      `This Agreement excludes claims caused by war, invasion, acts of foreign enemies, hostilities, civil war, rebellion, insurrection, martial law, strikes, riots, civil commotions, any act of sabotage or terrorism, any malicious act, confiscation or requisition by any government, and hijacking or any unlawful seizure or wrongful exercise of control of the aircraft in flight, save to the extent written back by the Hull War extension.`],
    ['exclusion', 'Noise and Pollution Exclusion', 'AVN 46B equivalent',
      'Excludes noise, pollution and electrical interference liability.',
      `This Agreement excludes claims directly or indirectly occasioned by noise (whether audible to the human ear or not), vibration, sonic boom and any phenomena associated therewith; pollution and contamination of any kind whatsoever; electrical and electromagnetic interference; and interference with the use of property, save where such claims are caused by or result in a crash, fire, explosion or a recorded in-flight emergency.`],
    ['exclusion', 'Date Recognition Exclusion', 'AVN 2000A equivalent',
      'Excludes date-processing failures in aircraft systems.',
      `This Agreement excludes all loss, damage, liability, cost or expense of any nature directly or indirectly caused by, consisting of, or arising from the failure of any computer, data processing equipment, microchip, embedded system or software to correctly recognise, interpret or process any date, whether or not any other cause contributed concurrently or in any sequence.`],
  ],

  Agriculture: [
    ['coverage', 'Multi-Peril Crop', null,
      'Yield or revenue protection against named natural perils.',
      `Cover is granted for shortfall in the insured yield of the declared crop against the guaranteed yield stated in the original policy, caused by drought, excess rainfall, flood, hail, frost, windstorm, fire, uncontrollable pest or disease, occurring during the growing season insured.`],
    ['coverage', 'Livestock Mortality', null,
      'Death of insured animals from accident or disease.',
      `Cover is granted for the death of insured animals resulting from accident, illness or disease occurring during the period of insurance, and for humane slaughter carried out on the certified advice of a qualified veterinary surgeon, up to the agreed value of each animal declared.`],
    ['extension', 'Replanting and Resowing Costs', null,
      'Costs of putting a failed crop back in the ground.',
      `Where an insured peril destroys a crop early in the growing season and replanting is agronomically practicable, this Agreement extends to include the reasonable direct costs of seed, labour and machinery incurred in replanting or resowing, up to the sub-limit stated in the original policy, in lieu of a yield-based indemnity.`],
    ['extension', 'Transit of Livestock', null,
      'Animals covered while being moved.',
      `Cover extends to the death of insured animals occurring during transit by road, rail or sea within the territorial limits, including loading and unloading, provided the transit is carried out in accordance with applicable animal welfare regulations and does not exceed the duration stated in the original policy.`],
    ['extension', 'Emergency Slaughter', null,
      'Indemnity where an animal must be destroyed on veterinary advice.',
      `Cover extends to include the agreed value of any insured animal slaughtered on the immediate written advice of a qualified veterinary surgeon to relieve incurable and excessive suffering, less the salvage value of the carcass where realised.`],
    ['exclusion', 'Notifiable and Epidemic Disease Exclusion', null,
      'Excludes government-controlled disease outbreaks.',
      `This Agreement excludes loss arising from any disease which is notifiable to, or subject to control, quarantine, movement restriction, culling or eradication measures ordered by, any government or public authority, together with any consequential loss of production, market or value arising therefrom.`],
    ['exclusion', 'Poor Husbandry Exclusion', null,
      'No cover for the consequences of bad farm management.',
      `This Agreement excludes loss attributable to failure to follow good agricultural practice, including inadequate nutrition, watering, housing, sanitation or veterinary care, failure to apply agreed inputs, late planting, unsuitable seed variety, or failure to harvest at the proper time.`],
    ['exclusion', 'Loss of Market and Price Decline Exclusion', null,
      'Excludes purely economic loss on the insured produce.',
      `This Agreement excludes loss of market, decline in the market price of the insured produce, loss of contract, loss of subsidy or grant, and any other purely financial or consequential loss not arising from physical loss of yield or death of insured animals.`],
  ],

  Energy: [
    ['coverage', 'Energy Property Damage and Business Interruption', null,
      'Physical damage and downtime on upstream and downstream assets.',
      `Cover is granted for physical loss of or damage to the insured onshore and offshore property, including platforms, pipelines, process plant, storage and associated equipment, and for the resulting loss of production income or gross profit during the indemnity period, arising from a cause not specifically excluded.`],
    ['extension', 'Control of Well and Operators Extra Expense', null,
      'Costs of regaining control of a blown-out well.',
      `Cover extends to include the costs and expenses incurred in regaining or attempting to regain control of a well which is out of control, including firefighting, capping and killing the well, together with the costs of redrilling or restoring the well to its condition immediately prior to the loss, up to the sub-limits stated in the Schedule.`],
    ['extension', 'Removal of Wreck and Debris', null,
      'Costs of clearing damaged installations.',
      `Cover extends to include the reasonable costs of removal, destruction or making safe of the wreck or debris of insured property, where such removal is compulsorily required by law or by a competent authority, or is reasonably necessary for the resumption of operations.`],
    ['exclusion', 'Reservoir and Formation Damage Exclusion', null,
      'Excludes loss of the hydrocarbons in the ground.',
      `This Agreement excludes loss of or damage to any reservoir, geological formation, or the hydrocarbons or other minerals contained therein, and any loss of reserves or reduction in recoverable volumes, howsoever caused.`],
    ['exclusion', 'Energy Seepage and Pollution Exclusion', null,
      'Gradual pollution excluded; sudden and accidental written back.',
      `This Agreement excludes liability for seepage, pollution or contamination, and the costs of removing, nullifying or cleaning up seeping, polluting or contaminating substances, unless caused by a sudden, identifiable, unintended and unexpected happening which takes place in its entirety at a specific time and place during the period of this Agreement.`],
  ],

  'Credit & Surety': [
    ['coverage', 'Whole Turnover Credit', null,
      'Protection against non-payment by approved buyers.',
      `Cover is granted for the insured's loss arising from the failure of an approved buyer to pay for goods delivered or services rendered under a contract of sale, by reason of the buyer's insolvency or protracted default, in respect of the insured turnover declared and within the credit limits established for each buyer.`],
    ['coverage', 'Surety and Bonds', null,
      'Indemnity where a bond is called against the principal.',
      `Cover is granted for the insured's loss arising from the calling of a bid, performance, advance payment, retention or maintenance bond issued on behalf of a principal, following the principal's failure to perform its obligations under the underlying contract, up to the bond amount and within the terms of the original bond.`],
    ['extension', 'Pre-Credit Risk', null,
      'Cover from order to delivery, not only from invoice.',
      `Cover extends to loss incurred during the manufacturing or pre-delivery period, being costs properly incurred by the insured in performing a contract prior to delivery, where the contract is frustrated by the buyer's insolvency or by the occurrence of an insured political event, up to the sub-limit stated in the Schedule.`],
    ['extension', 'Political Risk', null,
      'Buyer default caused by state action or transfer restriction.',
      `Cover extends to loss arising from currency inconvertibility or transfer restriction, import or export licence cancellation, moratorium on external debt, expropriation, or war or civil disturbance in the buyer's country, which prevents an otherwise solvent buyer from making payment.`],
    ['exclusion', 'Disputed Debts Exclusion', null,
      'No indemnity while the underlying debt is contested.',
      `This Agreement excludes any debt which is the subject of a bona fide dispute between the insured and the buyer as to the existence, amount, quality or performance of the underlying obligation, until such dispute is resolved in the insured's favour by agreement, arbitral award or judgment.`],
    ['exclusion', 'Related Party Debts Exclusion', null,
      'Intra-group and connected buyers are not covered.',
      `This Agreement excludes debts owed by any buyer which is a parent, subsidiary, affiliate or associate of the insured, or which is under common ownership, control or management with the insured, or in which the insured holds a material financial interest.`],
    ['exclusion', 'Trading with Distressed Buyers Exclusion', null,
      'No cover for deliveries made after warning signs.',
      `This Agreement excludes any loss in respect of goods delivered or services rendered after the insured became aware, or ought reasonably to have become aware, of the buyer's insolvency, protracted default on an earlier invoice, or the withdrawal or reduction of the buyer's credit limit.`],
  ],
};

/* ------------------------------------------------------------------------ */
/* Reinsurer house wordings.                                                 */
/*                                                                           */
/* Each row carries the SAME TITLE as the standard clause it replaces, so the */
/* comparison engine pairs them and shows a broker exactly where a market has */
/* deviated. Where a reinsurer has no house version, the standard clause      */
/* stands — that is what "layered" means on the comparison screen.            */
/* Format: [category, title, cob, clause_ref, summary, body].                */
/* ------------------------------------------------------------------------ */

const MARKET_CLAUSES = {
  'Swiss Re': [
    ['exclusion', 'Sanctions Limitation and Exclusion', null, 'SR-SANC-02',
      'Adds an automatic termination right for sanctioned cedants.',
      `The Reinsurer shall not be deemed to provide cover and shall not be liable to pay any claim or provide any benefit under this Agreement to the extent that doing so would expose the Reinsurer to any sanction, prohibition or restriction under the resolutions of the United Nations or the trade or economic sanctions, laws or regulations of the European Union, Switzerland, the United Kingdom or the United States of America.\n\nIn addition, where the Reinsured, any of its affiliates, or any cedant of business ceded hereunder becomes a designated person under any such regime, the Reinsurer may terminate this Agreement with immediate effect by written notice, and no premium shall be returnable in respect of the period for which cover was provided.`],
    ['exclusion', 'Cyber Loss Absolute Exclusion', null, 'SR-CY-05',
      'Absolute cyber exclusion with a narrow fire-and-explosion write-back.',
      `Notwithstanding any provision to the contrary, this Agreement excludes all loss, damage, liability, cost or expense of any kind directly or indirectly caused by, contributed to by, resulting from, arising out of or in connection with any cyber act or cyber incident, including any action taken to control, prevent, suppress or remediate a cyber act or cyber incident.\n\nThis exclusion does not apply to physical loss of or damage to tangible property caused by fire or explosion which itself results from a cyber incident, provided the cyber incident was not a cyber act and the property is insured under a Property section of this Agreement.\n\nCyber act means an unauthorised, malicious or criminal act, or series of related acts, involving access to, processing of, use of or operation of any computer system.`],
    ['exclusion', 'Communicable Disease Exclusion', null, 'SR-CD-03',
      'Communicable disease exclusion extended to preventive measures.',
      `This Agreement excludes all loss, damage, liability, cost or expense directly or indirectly arising out of, attributable to, or occurring concurrently or in any sequence with a communicable disease, the fear or threat of a communicable disease, or any measure taken by any public authority or by the insured to prevent, suppress, limit or remediate the spread of a communicable disease, including quarantine, closure of premises and restriction of movement.\n\nCommunicable disease means any disease transmissible by any substance or agent from any organism to another organism, whether or not the substance or agent is living.`],
    ['condition', 'Claims Notification and Co-operation', null, 'SR-CLM-01',
      'Tighter notification trigger and a formal control right.',
      `The Reinsured shall advise the Reinsurer within 14 days of any loss occurrence which may result in a claim under this Agreement, and immediately of any loss reserved at 30% or more of the retention, of any claim involving bodily injury to three or more persons, and of any claim likely to attract publicity or regulatory attention.\n\nThe Reinsured shall furnish full particulars and shall not, without the Reinsurer's prior written consent, admit liability, make any offer of settlement, or agree to any settlement in excess of the retention. The Reinsurer shall be entitled to associate in the defence and control of any such claim at its own expense.`],
    ['condition', 'Special Termination', null, 'SR-TERM-04',
      'Adds a rating-trigger at A- and a 30-day run-off election.',
      `Either party may terminate this Agreement with immediate effect by written notice if the other party is placed in liquidation, receivership, administration or provisional supervision; loses 20% or more of its paid-up capital or its solvency capital coverage falls below the regulatory minimum; has its authorisation to write the business ceded hereunder withdrawn or suspended; is subject to a change of control; or suffers a downgrade of its financial strength rating to below A- by S&P Global Ratings or the equivalent by AM Best.\n\nThe terminating party shall elect within 30 days whether termination is on a cut-off or a run-off basis. In the absence of an election, termination shall be on a run-off basis.`],
    ['definition', 'Ultimate Net Loss', null, 'SR-UNL-02',
      'Caps loss adjustment expenses at 10% of the indemnity.',
      `Ultimate Net Loss means the sum actually paid by the Reinsured in settlement of losses or liability, after deduction of all recoveries, salvages, subrogations and all claims upon other reinsurances, whether collected or not, and after deduction of any amount recoverable from any government-backed pool or scheme.\n\nLoss adjustment expenses are included in Ultimate Net Loss but shall not exceed 10% of the indemnity paid in respect of the same loss. Declaratory judgment expenses, extra-contractual obligations and the internal costs and salaries of the Reinsured are excluded from Ultimate Net Loss.`],
    ['extension', 'Debris Removal', 'Property', 'SR-PROP-DR',
      'Debris removal sub-limited to 5% and confined to the insured site.',
      `This Agreement extends to include costs necessarily incurred in removing debris, dismantling and demolishing the portions of the insured property destroyed or damaged by an insured peril.\n\nCover under this extension is limited to 5% of the sum insured on the damaged property and applies only to debris situated on the insured premises. Costs of removing, nullifying or cleaning up contaminated debris, and any cost of decontamination of land or water, are excluded.`],
  ],

  'Munich Re': [
    ['exclusion', 'War and Civil War Exclusion', null, 'MR-WAR-01',
      'War exclusion without the marine and aviation write-back.',
      `This Agreement excludes all loss, damage, liability, cost or expense directly or indirectly caused by, contributed to by, resulting from or arising out of war, invasion, acts of foreign enemies, hostilities or warlike operations (whether war be declared or not), civil war, mutiny, rebellion, revolution, insurrection, civil commotion assuming the proportions of or amounting to an uprising, military or usurped power, martial law, or confiscation, nationalisation, requisition, seizure or destruction of property by or under the order of any government or public or local authority.\n\nNo write-back applies to any class of business ceded under this Agreement. Where the Reinsured wishes to cede business written on market war terms, that business must be declared and accepted in a separate endorsement.`],
    ['exclusion', 'Nuclear Energy Risks Exclusion', null, 'MR-NUC-02',
      'Nuclear exclusion with a small-radioisotope write-back.',
      `This Agreement excludes all loss, damage, liability, cost or expense directly or indirectly caused by, contributed to by or arising from nuclear energy risks, ionising radiation, or contamination by radioactivity from any nuclear fuel, nuclear waste, nuclear installation, reactor or other nuclear assembly, or from the radioactive, toxic, explosive or other hazardous properties thereof.\n\nThis exclusion does not apply to loss or damage arising from radioisotopes used for industrial, commercial, agricultural, medical or scientific purposes away from any nuclear installation, provided the quantities involved are within the limits permitted by the applicable regulatory authority.`],
    ['exclusion', 'Terrorism Exclusion', null, 'MR-TERR-03',
      'Terrorism exclusion with an NBCR carve-out and no pool write-back.',
      `This Agreement excludes all loss, damage, liability, cost or expense directly or indirectly caused by, resulting from or in connection with any act of terrorism, and any action taken in controlling, preventing or suppressing an act of terrorism, regardless of any other cause contributing concurrently or in any sequence.\n\nThis exclusion applies absolutely, and without exception, to any act of terrorism involving nuclear, biological, chemical or radiological means, and to any cyber act committed for terrorist purposes.\n\nAn act of terrorism means any act, or preparation in respect of an act, of any person or group acting on behalf of or in connection with any organisation, government or authority, committed for political, religious, ideological or ethnic purposes, including the intention to influence any government or to put the public in fear.`],
    ['exclusion', 'Cyber Loss Absolute Exclusion', null, 'MR-CY-04',
      'Cyber exclusion with no write-back of any kind.',
      `This Agreement excludes, absolutely and without exception, all loss, damage, liability, cost or expense of any kind directly or indirectly caused by, contributed to by, resulting from, arising out of or in connection with any cyber act, cyber incident, or the unavailability, failure, corruption or loss of any data, regardless of any other cause or event contributing concurrently or in any other sequence.\n\nNo write-back, whether for fire, explosion or any other resulting peril, applies to this exclusion.`],
    ['condition', 'Access to Records', null, 'MR-REC-01',
      'Inspection rights extended to seven years and to outsourced records.',
      `The Reinsurer and its duly appointed representatives shall have the right, on 10 business days' written notice, to inspect and take copies of all books, records, files, correspondence and electronic data relating to business ceded under this Agreement, whether held by the Reinsured, by any managing general agent, coverholder, third party administrator or outsourced service provider acting on its behalf.\n\nThis right subsists during the currency of this Agreement and for seven years after all obligations under it have been discharged, and survives termination of this Agreement for any reason, including the insolvency of the Reinsured.`],
    ['definition', 'Loss Occurrence', null, 'MR-LOSS-02',
      'Hours clause with a 504-hour period for named windstorm.',
      `Loss Occurrence means all individual losses arising out of and directly occasioned by one catastrophe, limited to: 504 consecutive hours for named windstorm, including associated storm surge, rainfall flooding and fire following; 168 consecutive hours for earthquake, seaquake, tsunami and volcanic eruption; 96 consecutive hours for all other windstorm, hailstorm and tornado; 72 consecutive hours for riot, civil commotion, strike and malicious damage; and 168 consecutive hours for any other loss occurrence.\n\nThe Reinsured may elect the commencement of each period, provided that no period commences earlier than the first recorded individual loss and that periods in respect of the same catastrophe do not overlap.`],
    ['exclusion', 'Punitive and Exemplary Damages Exclusion', 'Casualty', 'MR-PUN-01',
      'Punitive damages excluded including where assessed against the Reinsured.',
      `This Agreement excludes punitive, exemplary, multiplied, aggravated, vindictive or non-compensatory damages, however denominated, together with any statutory multiplication of a compensatory award, any fine or penalty imposed by a court or regulator, and any extra-contractual obligation or liability arising from the Reinsured's own handling of a claim, whether characterised as bad faith, unfair claims practice or otherwise.`],
  ],

  "Lloyd's": [
    ['exclusion', 'War and Civil War Exclusion', null, 'NMA 464',
      'The market war exclusion in its Lloyd’s form.',
      `Notwithstanding anything to the contrary contained herein, this Agreement does not cover any loss or damage occasioned by or through or in consequence, directly or indirectly, of any of the following occurrences, namely: war, invasion, the act of foreign enemies, hostilities or warlike operations (whether war be declared or not), civil war; mutiny, civil commotion assuming the proportions of or amounting to a popular rising, military rising, insurrection, rebellion, revolution, military or usurped power; or any act of any person acting on behalf of or in connection with any organisation with activities directed towards the overthrow by force of any government.\n\nIn any action, suit or other proceeding where the Reinsurer alleges that by reason of the provisions of this clause any loss or damage is not covered, the burden of proving that such loss or damage is covered shall be upon the Reinsured.`],
    ['exclusion', 'Sanctions Limitation and Exclusion', null, 'LMA 3100',
      'The market sanctions clause in its Lloyd’s form.',
      `No Reinsurer shall be deemed to provide cover and no Reinsurer shall be liable to pay any claim or provide any benefit hereunder to the extent that the provision of such cover, payment of such claim or provision of such benefit would expose that Reinsurer to any sanction, prohibition or restriction under United Nations resolutions or the trade or economic sanctions, laws or regulations of the European Union, United Kingdom or United States of America.`],
    ['exclusion', 'Cyber Loss Absolute Exclusion', null, 'LMA 5403',
      'Property cyber exclusion, absolute form.',
      `Notwithstanding any provision to the contrary within this Agreement or any endorsement thereto, this Agreement excludes any cyber loss.\n\nCyber loss means any loss, damage, liability, claim, cost or expense of whatsoever nature directly or indirectly caused by, contributed to by, resulting from, arising out of or in connection with any cyber act or cyber incident, including but not limited to any action taken in controlling, preventing, suppressing or remediating any cyber act or cyber incident.\n\nThis Agreement also excludes any loss, damage, liability, claim, cost or expense of whatsoever nature directly or indirectly caused by, contributed to by, resulting from, arising out of or in connection with any loss of use, reduction in functionality, repair, replacement, restoration or reproduction of any data, including any amount pertaining to the value of such data.`],
    ['exclusion', 'Communicable Disease Exclusion', null, 'LMA 5394',
      'Property communicable disease exclusion.',
      `Notwithstanding any provision to the contrary within this Agreement, this Agreement excludes any loss, damage, liability, claim, cost or expense of whatsoever nature, directly or indirectly caused by, contributed to by, resulting from, arising out of, or in connection with a communicable disease or the fear or threat (whether actual or perceived) of a communicable disease regardless of any other cause or event contributing concurrently or in any other sequence thereto.\n\nAs used herein, a communicable disease means any disease which can be transmitted by means of any substance or agent from any organism to another organism where the substance or agent includes, but is not limited to, a virus, bacterium, parasite or other organism or any variation thereof, whether deemed living or not.`],
    ['exclusion', 'Terrorism Exclusion', null, 'LMA 3030 equivalent',
      'Terrorism exclusion with a pooled-scheme write-back.',
      `This Agreement excludes loss, damage, cost or expense of whatsoever nature directly or indirectly caused by, resulting from or in connection with any act of terrorism regardless of any other cause or event contributing concurrently or in any other sequence to the loss.\n\nFor the purpose of this clause an act of terrorism means an act, including but not limited to the use of force or violence and/or the threat thereof, of any person or group of persons, whether acting alone or on behalf of or in connection with any organisation or government, committed for political, religious, ideological or similar purposes including the intention to influence any government and/or to put the public, or any section of the public, in fear.\n\nWhere business is ceded to a government-backed terrorism reinsurance scheme, the Reinsured shall first exhaust its recoveries from that scheme, and only the balance shall form part of Ultimate Net Loss.`],
    ['exclusion', 'Cyber Attack Exclusion', 'Marine', 'CL 380',
      'The Institute cyber attack exclusion, marine form.',
      `Subject only to the paragraph below, in no case shall this Agreement cover loss, damage, liability or expense directly or indirectly caused by or contributed to by or arising from the use or operation, as a means for inflicting harm, of any computer, computer system, computer software programme, malicious code, computer virus or process or any other electronic system.\n\nWhere this clause is endorsed on policies covering risks of war, civil war, revolution, rebellion, insurrection, or civil strife arising therefrom, or any hostile act by or against a belligerent power, or terrorism or any person acting from a political motive, the foregoing shall not operate to exclude losses (which would otherwise be covered) arising from the use of any computer, computer system or computer software programme or any other electronic system in the launch and/or guidance system and/or firing mechanism of any weapon or missile.`],
    ['exclusion', 'Radioactive Contamination Exclusion', 'Marine', 'CL 370',
      'The Institute radioactive contamination exclusion.',
      `This clause shall be paramount and shall override anything contained in this Agreement inconsistent therewith.\n\nIn no case shall this Agreement cover loss, damage, liability or expense directly or indirectly caused by or contributed to by or arising from ionising radiations from or contamination by radioactivity from any nuclear fuel or from any nuclear waste or from the combustion of nuclear fuel; the radioactive, toxic, explosive or other hazardous or contaminating properties of any nuclear installation, reactor or other nuclear assembly or nuclear component thereof; any weapon or device employing atomic or nuclear fission and/or fusion or other like reaction or radioactive force or matter; the radioactive properties of any radioactive matter; or any chemical, biological, bio-chemical or electromagnetic weapon.`],
  ],

  'Hannover Re': [
    ['condition', 'Errors and Omissions', null, 'HR-EO-01',
      'Errors and omissions with a 12-month rectification longstop.',
      `Any inadvertent delay, omission or error on the part of either party shall not be held to relieve either party of liability under this Agreement, provided the delay, omission or error is rectified as soon as practicable after discovery and in any event within 12 months of the date on which it occurred.\n\nThis clause shall not operate to extend cover to business which is outside the Business Covered, nor to reinstate cover which has been validly terminated, nor to waive any exclusion.`],
    ['condition', 'Premium Payment', null, 'HR-PPW-02',
      'Strict premium payment warranty with automatic cancellation.',
      `It is warranted that deposit premium shall be paid in four equal quarterly instalments, the first due at inception, and that adjustment premium shall be paid within 45 days of the rendering of the adjustment statement.\n\nIf any instalment remains unpaid 60 days after its due date, this Agreement shall be automatically cancelled from the due date without further notice, and the Reinsurer shall be under no liability for any loss occurring on or after that date. Reinstatement of cover shall be at the sole discretion of the Reinsurer.`],
    ['extension', 'Reinstatement of Limit', null, 'HR-RI-01',
      'Reinstatements payable pro rata as to both amount and time.',
      `In the event of loss, the limit is reinstated for the number of reinstatements stated in the Schedule. Each reinstatement is subject to additional premium calculated pro rata as to the amount of limit reinstated and pro rata as to the unexpired period of this Agreement.\n\nAdditional reinstatement premium is due and payable on the date the loss is settled and shall not be offset against the loss payment. Reinstatements are not available in respect of the final 30 days of the period of this Agreement.`],
    ['coverage', 'Business Interruption', 'Property', 'HR-BI-03',
      'BI cover restricted to a 12-month maximum indemnity period.',
      `Cover is granted for loss of gross profit and increased cost of working resulting from interruption of the business carried on by the insured at the premises, following damage recoverable under the Property Damage section, for a maximum indemnity period of 12 months.\n\nContingent business interruption, denial of access, loss of attraction, and interruption arising from failure of public utilities away from the insured premises are covered only where expressly declared to and accepted by the Reinsurer, and are in all cases sub-limited to 10% of the business interruption sum insured.`],
  ],

  SCOR: [
    ['condition', 'Arbitration', null, 'SC-ARB-01',
      'Institutional arbitration under ARIAS rules, seated in Paris.',
      `All disputes arising out of or in connection with this Agreement, including any question as to its existence, validity or termination, shall be finally settled by arbitration under the rules of ARIAS by a tribunal of three arbitrators, one appointed by each party and the third by the two so appointed.\n\nThe seat of the arbitration shall be Paris and the language of the proceedings shall be English. The tribunal shall apply the terms of this Agreement and the applicable law, and shall not be relieved of the obligation to do so by any characterisation of this Agreement as an honourable engagement. The award shall be final and binding and judgment may be entered upon it in any court of competent jurisdiction.`],
    ['condition', 'Governing Law and Jurisdiction', null, 'SC-LAW-01',
      'French law, with disputes to arbitration only.',
      `This Agreement and any non-contractual obligations arising out of or in connection with it shall be governed by and construed in accordance with French law. The parties agree that no dispute shall be referred to any national court save for the purpose of obtaining interim relief or enforcing an arbitral award.`],
    ['condition', 'Insolvency of the Reinsured', null, 'SC-INS-02',
      'Insolvency clause with a direct notice right for the Reinsurer.',
      `In the event of the insolvency of the Reinsured, the reinsurance provided by this Agreement shall be payable by the Reinsurer on the basis of the liability of the Reinsured under the policies reinsured, without diminution because of the insolvency of the Reinsured or because the liquidator, receiver, conservator or statutory successor has failed to pay all or a portion of any claim.\n\nThe liquidator, receiver, conservator or statutory successor shall give the Reinsurer written notice of the pendency of any claim against the Reinsured within a reasonable time after such claim is filed, and the Reinsurer may investigate that claim and interpose, at its own expense, any defence which it deems available to the Reinsured or its estate.`],
    ['extension', 'Defence Costs and Expenses', 'Casualty', 'SC-DEF-01',
      'Defence costs shared in proportion, and capped where in addition to limit.',
      `Costs and expenses incurred in the investigation, defence or settlement of a claim covered by this Agreement shall be included in Ultimate Net Loss.\n\nWhere such costs are payable in addition to the original limit of indemnity, they shall be apportioned between the Reinsured and the Reinsurer in the same proportion as the loss itself, and the Reinsurer's share shall not exceed 25% of the indemnity it pays in respect of that claim. The Reinsured shall obtain the Reinsurer's prior written consent before incurring defence costs expected to exceed 10% of the retention.`],
  ],

  'Everest Re': [
    ['condition', 'Offset', null, 'EV-OFF-01',
      'Offset limited to balances under this Agreement, and cut off on insolvency.',
      `Each party may offset any balance due from one party to the other under this Agreement, whether on account of premium, commission, claims, losses or otherwise. Offset against balances arising under any other agreement between the parties is permitted only with the prior written consent of both parties.\n\nThe right of offset shall not apply where it is prohibited by the applicable insolvency law of the jurisdiction in which either party is domiciled.`],
    ['condition', 'Access to Records', null, 'EV-REC-01',
      'Inspection subject to confidentiality undertakings and a cost split.',
      `The Reinsurer shall have the right, on 15 business days' written notice and no more than twice in any 12-month period, to inspect at the offices of the Reinsured the books and records relating to business ceded under this Agreement, during the currency of this Agreement and for five years thereafter.\n\nInspection is conditional upon the Reinsurer and its representatives executing a confidentiality undertaking in a form reasonably acceptable to the Reinsured. Each party shall bear its own costs, save that where an inspection reveals a material misstatement of ceded premium or losses, the Reinsured shall bear the Reinsurer's reasonable costs of that inspection.`],
  ],

  'Africa Re': [
    ['definition', 'Territorial Scope', null, 'AR-TERR-01',
      'Continental scope with a declared-risks write-back for elsewhere.',
      `This Agreement applies to risks situated within the African continent and its offshore islands, together with risks situated elsewhere in the world which arise out of business written by a cedant domiciled in Africa, provided such non-African risks do not exceed 15% of the ceded portfolio by sum insured and are declared to the Reinsurer at each quarterly account.\n\nWhere a policy covers risks both inside and outside this scope, only the portion relating to risks within scope shall be ceded, unless the whole policy is declared to and accepted by the Reinsurer.`],
    ['condition', 'Currency Conversion', null, 'AR-CCY-01',
      'Conversion at central bank rates, with a devaluation review trigger.',
      `Amounts in currencies other than the currency of this Agreement shall be converted at the official rate published by the central bank of the country of origin on the date the premium was booked or the loss was settled, as applicable.\n\nWhere the currency of any ceded portfolio devalues by more than 25% against the currency of this Agreement during the period of this Agreement, either party may call for a review of the retention and limit, and failing agreement within 60 days may terminate the affected section on a run-off basis.`],
    ['condition', 'Premium Payment', null, 'AR-PPW-01',
      'Ninety-day terms recognising local remittance and exchange controls.',
      `Deposit premium shall be payable in equal quarterly instalments, each due within 90 days of the commencement of the quarter to which it relates. Adjustment premium shall be payable within 90 days of the rendering of the adjustment statement.\n\nWhere payment is delayed solely by exchange control or remittance restrictions imposed by a public authority, and the Reinsured evidences that the funds were placed with its bank within the due period, such delay shall not constitute a breach of this clause and no cancellation right shall arise.`],
  ],
};

/* ------------------------------------------------------------------------ */
/* Seeding                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Insert a clause if the library does not already hold one with the same
 * identity (title + category + class + source + reinsurer). Existing rows are
 * never overwritten, so re-running the seed is safe on a library a firm has
 * started editing.
 */
async function insertClause(row) {
  const { rowCount } = await query(
    `INSERT INTO wording_clause
       (title, clause_ref, category, cob, treaty_type, source, market_id, body, summary, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (title, category, cob, source, market_id) DO NOTHING`,
    [row.title, row.clause_ref, row.category, row.cob, null, row.source,
      row.market_id, row.body, row.summary, row.tags || []],
  );
  return rowCount;
}

/** A date `months` from today, as YYYY-MM-DD. */
function monthsOut(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Create the top reinsurers in the market register (idempotent on the entry). */
export async function seedReinsurers() {
  const out = new Map();
  for (const r of TOP_REINSURERS) {
    const { rows } = await query(
      `INSERT INTO market (name, domicile, type, rating, region, security_status,
                           rating_agency, rating_as_of, kyc_status, kyc_reviewed_at, kyc_expires_at)
       VALUES ($1,$2,'reinsurer',$3,$4,'approved','AM Best',$5,'approved',$6,$7)
       ON CONFLICT (type, name, domicile) DO UPDATE SET
         rating = EXCLUDED.rating, region = EXCLUDED.region,
         rating_as_of = EXCLUDED.rating_as_of, kyc_status = EXCLUDED.kyc_status,
         kyc_reviewed_at = EXCLUDED.kyc_reviewed_at, kyc_expires_at = EXCLUDED.kyc_expires_at
       RETURNING id, name`,
      [r.name, r.domicile, r.rating, r.region || null, monthsOut(-4), monthsOut(-8), monthsOut(16)],
    );
    out.set(rows[0].name, rows[0].id);
  }
  return out;
}

/** Load the standard corpus and the reinsurer house wordings. */
export async function seedWordingLibrary() {
  const marketIds = await seedReinsurers();
  let standard = 0;
  let market = 0;

  for (const [category, title, clause_ref, summary, body] of GENERAL) {
    standard += await insertClause({
      title, clause_ref, category, cob: null, source: 'standard',
      market_id: null, body, summary, tags: ['general'],
    });
  }

  for (const [cob, items] of Object.entries(BY_CLASS)) {
    for (const [category, title, clause_ref, summary, body] of items) {
      standard += await insertClause({
        title, clause_ref, category, cob, source: 'standard',
        market_id: null, body, summary, tags: [cob.toLowerCase()],
      });
    }
  }

  for (const [marketName, items] of Object.entries(MARKET_CLAUSES)) {
    const marketId = marketIds.get(marketName);
    if (!marketId) continue;
    for (const [category, title, cob, clause_ref, summary, body] of items) {
      market += await insertClause({
        title, clause_ref, category, cob, source: 'market',
        market_id: marketId, body, summary, tags: ['house wording'],
      });
    }
  }

  return { reinsurers: marketIds.size, standard, market };
}
