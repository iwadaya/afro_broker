import { Router } from 'express';
import { asyncHandler } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import { HOUSE, parseYear, readBook } from './portfolioBook.js';
import { analyseProgrammes } from './programmeAnalysis.js';

/**
 * Portfolio intelligence — the book read by who leads it, who places it and
 * who writes it, beside the renewal calendar — and its programme analysis,
 * the same book cut by broker and by reinsurer for the charts.
 *
 * Both read the book through portfolioBook.js on every call (see its header
 * for the reading of each account); nothing here is a stored counter.
 */
const router = Router();
router.use(authenticate);

export { HOUSE };

/** The portfolio screen: summary, lead reinsurers, the panel, the brokers and every account. */
router.get(
  '/portfolio',
  asyncHandler(async (req, res) => {
    const { lines, ...book } = await readBook(parseYear(req.query.year));
    res.json(book);
  }),
);

/** The programme analysis: the programmes by the house placing them and the reinsurers writing them. */
router.get(
  '/portfolio/programmes',
  asyncHandler(async (req, res) => {
    const book = await readBook(parseYear(req.query.year));
    res.json(analyseProgrammes(book));
  }),
);

export default router;
