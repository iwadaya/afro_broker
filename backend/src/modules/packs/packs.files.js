/*
 * The files of a renewal pack version, as attachments.
 *
 * A version's Excel and PDF are rendered when it is cut and stored with it
 * (migration 038), so what goes to market is byte-for-byte what was
 * approved. Anything that emails the approved pack — the covering email of
 * the quoting stage, the firm order terms — attaches both formats from here;
 * a version cut before the files were stored is rendered on the spot from
 * its snapshot, so an older pack still goes out whole.
 */

import { query } from '../../db/pool.js';
import { NotFoundError } from '../../lib/errors.js';
import { presentPack, packFilename } from './packs.present.js';
import { packToPdf } from './packs.pdf.js';
import { packToXlsx } from './packs.xlsx.js';

export const PACK_FORMATS = ['xlsx', 'pdf'];

const CONTENT_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

const RENDER = {
  xlsx: (presented) => packToXlsx(presented),
  pdf: (presented) => packToPdf(presented),
};

/**
 * The attachments of a pack version, one per format: the stored file where
 * there is one, rendered from the snapshot where there is not.
 *
 * @returns {Promise<Array<{ format, filename, content: Buffer, contentType }>>}
 */
export async function packAttachments(packId, { formats = PACK_FORMATS, runner = { query } } = {}) {
  const { rows } = await runner.query('SELECT * FROM renewal_pack WHERE id = $1', [packId]);
  const pack = rows[0];
  if (!pack) throw new NotFoundError('Renewal pack');
  const { rows: files } = await runner.query(
    'SELECT format, filename, content FROM renewal_pack_file WHERE pack_id = $1', [packId],
  );
  const stored = new Map(files.map((f) => [f.format, f]));
  let presented = null;
  const out = [];
  for (const format of formats) {
    if (!RENDER[format]) continue;
    const file = stored.get(format);
    if (file) {
      out.push({ format, filename: file.filename, content: file.content, contentType: CONTENT_TYPES[format] });
      continue;
    }
    presented = presented || presentPack(pack);
    const content = await RENDER[format](presented);
    out.push({
      format,
      filename: packFilename(pack, format),
      content: Buffer.isBuffer(content) ? content : Buffer.from(content),
      contentType: CONTENT_TYPES[format],
    });
  }
  return out;
}

/** The same, described without the bytes — for a screen to list what will go. */
export const describePackAttachments = (attachments) => attachments
  .map((a) => ({ format: a.format, filename: a.filename, bytes: a.content.length, mime_type: a.contentType }));
