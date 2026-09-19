/*
 * Renewal pack → CSV.
 *
 * A pack is many tables, and a .csv is one — so the whole pack is written as
 * titled blocks in a single file, in the template's running order, with a
 * blank line between them. It opens straight into Excel or Sheets, and an
 * empty section still appears with its note, the same as everywhere else.
 */

const escape = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const line = (cells) => cells.map(escape).join(',');

/** The pack as a CSV string. */
export function packToCsv(pack) {
  const out = [];
  out.push(line([`BROKER IQ — ${pack.reference} — Renewal Pack v${pack.version}`]));
  out.push(line(['Basis', pack.basis_label]));
  out.push(line(['Cedant', pack.placement.cedant || '']));
  out.push(line(['Class', pack.placement.cob || pack.placement.class || '']));
  out.push(line(['Treaty type', pack.placement.treaty_type || '']));
  out.push(line(['Period', `${String(pack.placement.inception || '').slice(0, 10)} to ${String(pack.placement.expiry || '').slice(0, 10)}`]));
  out.push(line(['Currency', pack.currency]));
  out.push(line(['Status', pack.status]));
  out.push(line(['Template version', `v${pack.template_version}`]));
  out.push(line(['Generated', String(pack.generated_at || '').slice(0, 19).replace('T', ' ')]));
  out.push(line(['Sections', `${pack.summary.sections_filled} of ${pack.summary.sections_total} carry data`]));
  if (pack.summary.required_total) {
    out.push(line(['Tracker', `${pack.summary.required_filled} of ${pack.summary.required_total} required sections filled${pack.summary.missing_required?.length ? ` — missing: ${pack.summary.missing_required.join(', ')}` : ''}`]));
  }
  out.push('');

  pack.sections.forEach((section, i) => {
    out.push(line([`SECTION ${i + 1}: ${section.title}`, section.status.toUpperCase()]));
    if (pack.header) out.push(line([pack.header]));
    out.push(line([section.blurb]));
    if (section.status !== 'filled') {
      out.push(line([`No data — ${section.note}`]));
      out.push('');
      return;
    }
    if (section.facts.length) {
      out.push(line(['Figure', 'Value']));
      for (const f of section.facts) out.push(line([f.label, f.value]));
      out.push('');
    }
    for (const t of section.tables) {
      out.push(line([t.title]));
      out.push(line(t.columns.map((c) => c.label)));
      for (const r of t.rows) out.push(line(t.columns.map((c) => r[c.key])));
      out.push('');
    }
  });

  // A BOM so Excel opens UTF-8 (→, ·, £) correctly on Windows.
  return `﻿${out.join('\r\n')}\r\n`;
}
