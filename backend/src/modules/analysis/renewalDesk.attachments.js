/*
 * What goes out with the desk's market email: the cedant's own pack as
 * uploaded, the broker-verified summary, and the layer schedule with the
 * experience. Described (name and size) for the composer's chips, and
 * rendered in full for the send.
 */

import { query } from '../../db/pool.js';
import { NotFoundError } from '../../lib/errors.js';
import { summaryPdf, schedulePdf, deskFilename } from './renewalDesk.pdf.js';

async function loadForAttachments(analysisId) {
  const { rows } = await query(
    `SELECT a.*, u.name AS verified_by_name
       FROM renewal_pack_analysis a LEFT JOIN users u ON u.id = a.verified_by
      WHERE a.id = $1`,
    [analysisId],
  );
  if (!rows[0]) throw new NotFoundError('Renewal pack analysis');
  return rows[0];
}

/** The generated documents, rendered from the summary as signed off. */
async function generated(analysis) {
  const verifiedBy = analysis.verified_by_name;
  const [summary, schedule] = await Promise.all([
    summaryPdf({ analysis, verifiedBy }),
    schedulePdf({ analysis, verifiedBy }),
  ]);
  return [
    { kind: 'summary', filename: deskFilename(analysis, 'summary'), content: summary, contentType: 'application/pdf' },
    { kind: 'schedule', filename: deskFilename(analysis, 'schedule'), content: schedule, contentType: 'application/pdf' },
  ];
}

/** The chips: every attachment by name, kind and size, without the bytes. */
export async function describeAttachments(analysis, documents) {
  const pdfs = await generated(analysis);
  return [
    ...documents.map((d) => ({ kind: 'source', filename: d.filename, size_bytes: d.size_bytes, mime_type: d.mime_type })),
    ...pdfs.map((p) => ({ kind: p.kind, filename: p.filename, size_bytes: p.content.length, mime_type: p.contentType })),
  ];
}

/** The attachments themselves, as the mailer takes them. */
export async function deskAttachments(analysisId) {
  const analysis = await loadForAttachments(analysisId);
  const { rows: documents } = await query(
    'SELECT filename, mime_type, content FROM renewal_pack_analysis_document WHERE analysis_id = $1 ORDER BY created_at',
    [analysisId],
  );
  const pdfs = await generated(analysis);
  return [
    ...documents.map((d) => ({ filename: d.filename, content: d.content, contentType: d.mime_type })),
    ...pdfs.map(({ filename, content, contentType }) => ({ filename, content, contentType })),
  ];
}
