import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/**
 * Written lines bordereau, exported to Excel and PDF (M9).
 *
 * Both renderers take the same object the JSON endpoint returns, so the three
 * cannot drift into disagreeing about what the panel is.
 */

const COLUMNS = [
  { header: 'Structure', key: 'structure_label', width: 24 },
  { header: 'Reinsurer', key: 'reinsurer_name', width: 32 },
  { header: 'Rating', key: 'rating', width: 10 },
  { header: 'Agency', key: 'rating_agency', width: 14 },
  { header: 'Written %', key: 'written_pct', width: 12 },
  { header: 'Signed %', key: 'signed_pct', width: 12 },
  { header: 'To stand', key: 'to_stand', width: 10 },
  { header: 'Premium', key: 'premium_signed', width: 16 },
  { header: 'Ccy', key: 'premium_currency', width: 6 },
  { header: 'Expiring panel', key: 'on_expiring_panel', width: 15 },
];

export function bordereauFilename(bordereau, extension) {
  const safe = `${bordereau.contract_year.cedant_name} ${bordereau.contract_year.contract_name} ${bordereau.contract_year.year_label}`
    .replace(/[^A-Za-z0-9 -]/g, '').replace(/\s+/g, '-');
  return `written-lines-${safe}.${extension}`;
}

export async function bordereauToXlsx(bordereau) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Afro-Asian';
  const ws = wb.addWorksheet('Written lines');

  const { contract_year: cy } = bordereau;
  ws.addRow([`${cy.cedant_name} — ${cy.contract_name}`]);
  ws.addRow([`${cy.year_label}   ${String(cy.inception).slice(0, 10)} to ${String(cy.expiry).slice(0, 10)}   ${cy.currency}`]);
  if (!bordereau.expiring_panel_known) {
    ws.addRow(['No prior year linked, so the expiring panel is not known.']);
  }
  ws.addRow([]);
  ws.getRow(1).font = { bold: true, size: 14 };

  const headerRow = ws.addRow(COLUMNS.map((c) => c.header));
  headerRow.font = { bold: true };
  ws.columns.forEach((col, i) => { col.width = COLUMNS[i]?.width ?? 14; });

  for (const line of bordereau.lines) {
    ws.addRow([
      line.structure_label,
      line.reinsurer_name,
      line.rating ?? '',
      line.rating_agency ?? '',
      line.written_pct,
      line.signed_pct ?? '',
      line.to_stand ? 'Yes' : '',
      line.premium_signed ?? '',
      line.premium_currency ?? '',
      // Blank rather than "No" when there is no prior year: an unknown is not
      // the same statement as "they were not on it".
      bordereau.expiring_panel_known ? (line.on_expiring_panel ? 'Yes' : 'No') : '—',
    ]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function bordereauToPdf(bordereau) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { contract_year: cy } = bordereau;
    doc.fontSize(15).text(`${cy.cedant_name} — ${cy.contract_name}`);
    doc.fontSize(10).fillColor('#555')
      .text(`${cy.year_label}   ${String(cy.inception).slice(0, 10)} to ${String(cy.expiry).slice(0, 10)}   ${cy.currency}`);
    if (!bordereau.expiring_panel_known) {
      doc.text('No prior year linked, so the expiring panel is not known.');
    }
    doc.fillColor('#000').moveDown(0.8);

    const widths = [110, 150, 44, 66, 62, 62, 46, 84, 34, 70];
    const headers = COLUMNS.map((c) => c.header);

    const row = (cells, bold) => {
      const y = doc.y;
      doc.fontSize(8.5).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      let x = doc.page.margins.left;
      cells.forEach((cell, i) => {
        doc.text(String(cell ?? ''), x, y, { width: widths[i] - 4, ellipsis: true });
        x += widths[i];
      });
      doc.y = y + 14;
    };

    row(headers, true);
    doc.moveTo(doc.page.margins.left, doc.y - 3)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y - 3)
      .strokeColor('#999').stroke();

    for (const line of bordereau.lines) {
      if (doc.y > doc.page.height - 60) {
        doc.addPage();
        row(headers, true);
      }
      row([
        line.structure_label,
        line.reinsurer_name,
        line.rating ?? '',
        line.rating_agency ?? '',
        line.written_pct,
        line.signed_pct ?? '',
        line.to_stand ? 'Yes' : '',
        line.premium_signed ?? '',
        line.premium_currency ?? '',
        bordereau.expiring_panel_known ? (line.on_expiring_panel ? 'Yes' : 'No') : '—',
      ]);
    }

    doc.end();
  });
}
