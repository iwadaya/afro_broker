// server/src/routes/lookups.js — reference data (same wire shapes as Universe routes/lookups.js).
// Response rows are { id, name, ... } so the Universe screens' lookup code works unchanged.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';

const router = Router();

router.get('/cedants', asyncHandler(async (req, res) => {
  const { country_id: countryId } = req.query;
  if (countryId && !/^[0-9a-f-]{36}$/i.test(String(countryId))) return res.status(400).json({ error: 'country_id must be a UUID', code: 'VALIDATION_FAILED' });
  const { rows } = countryId
    ? await pool.query('SELECT company_id AS id, company_name AS name, country_id FROM public.companies WHERE country_id=$1 AND is_active IS NOT FALSE ORDER BY company_name', [countryId])
    : await pool.query('SELECT company_id AS id, company_name AS name, country_id FROM public.companies WHERE is_active IS NOT FALSE ORDER BY company_name');
  res.json(rows);
}));

router.get('/brokers', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query('SELECT broker_id AS id, broker_name AS name FROM public.brokers WHERE is_active IS NOT FALSE ORDER BY broker_name');
  res.json(rows);
}));

router.get('/treaty-types', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query('SELECT treaty_type_id AS id, treaty_type AS name, category FROM public.treaty_type WHERE is_active IS NOT FALSE ORDER BY category, treaty_type');
  res.json(rows);
}));

router.get('/class-of-business', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query('SELECT class_of_business_id AS id, class_of_business AS name, code FROM public.class_of_business WHERE is_active IS NOT FALSE ORDER BY class_of_business');
  res.json(rows);
}));

router.get('/ref/lists/:key/items', asyncHandler(async (req, res) => {
  const { key } = req.params;
  if (key === 'country') {
    const { rows } = await pool.query('SELECT country_id AS id, country_name AS name, country_code AS code FROM public.country WHERE is_active IS NOT FALSE ORDER BY country_name');
    return res.json(rows);
  }
  if (key === 'currency') {
    const { rows } = await pool.query('SELECT currency_id AS id, currency_code AS name, currency_code AS code FROM public.currency WHERE is_active IS NOT FALSE ORDER BY currency_code');
    return res.json(rows);
  }
  res.json([]);
}));

export default router;
