-- Market intelligence, split into sections. The brief a gather stores for a
-- country or a region was one shape — a headline, dynamics by topic, the
-- cedants, regulatory change, developments, what to do next. The desk wants
-- it in six sections, each researched on its own and stored as one object:
--
--   sector      the insurance and reinsurance sector: gross premium by
--               segment, the top insurance companies, the local brokers,
--               mergers and acquisitions in the industry
--   economy     the economic indicators, and the government and private-
--               sector projects above USD 50m, approved and in the pipeline
--   regulation  the regulatory environment and its updates, the capital
--               regime, fines and findings on industry players, other news
--   statistics  gross written premium by class and in aggregate, loss ratios
--               by class for the market and by insurer or reinsurer, the 50
--               biggest insured risks, the largest reported losses insured
--               and uninsured
--   events      catastrophes — flooding, hail, wildfire, earthquake — and
--               big individual fires
--   players     competition among brokers, insurers and reinsurers, new
--               products, government insurance pools
--
-- Every section is { summary, ...its lists, from_the_desk, sources }; the
-- shape of each list is in integrations/marketBrief.js, which is also what
-- fills them. `citations` stays, as the union of the sections' sources.
--
-- A brief gathered under the old shape keeps what has a home in the new one
-- — the headline and the desk's paragraph (the sector's), the cedants (as the
-- top insurers), the regulatory changes (as the regulation's updates) and the
-- developments (as its other news) — and is otherwise empty until it is
-- gathered again. Its verification is left as it was: what remains is what
-- was checked.

ALTER TABLE market_intel_brief
  ADD COLUMN sector     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN economy    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN regulation JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN statistics JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN events     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN players    JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE market_intel_brief b SET
  sector = jsonb_build_object(
    'summary', b.headline,
    'gross_premium', '[]'::jsonb,
    'top_insurers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'rank', NULL::int, 'name', c->'name', 'type', NULL::text, 'overview', c->'overview',
        'gwp', NULL::numeric, 'currency', NULL::text, 'year', NULL::int, 'market_share_pct', NULL::numeric, 'url', c->'url'))
        FROM jsonb_array_elements(b.cedants) c), '[]'::jsonb),
    'local_brokers', '[]'::jsonb,
    'mergers_acquisitions', '[]'::jsonb,
    'from_the_desk', b.from_the_desk,
    'sources', b.citations),
  regulation = jsonb_build_object(
    'summary', NULL::text,
    'regulators', '[]'::jsonb,
    'updates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'headline', r->'headline', 'summary', r->'summary', 'regulator', r->'regulator',
        'status', NULL::text, 'effective_date', r->'effective_date', 'url', r->'url'))
        FROM jsonb_array_elements(b.regulatory) r), '[]'::jsonb),
    'capital_regime', '[]'::jsonb,
    'enforcement', '[]'::jsonb,
    'other_news', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'headline', d->'headline', 'summary', d->'summary', 'published_at', d->'published_at', 'url', d->'url'))
        FROM jsonb_array_elements(b.developments) d), '[]'::jsonb),
    'from_the_desk', NULL::text,
    'sources', '[]'::jsonb);

ALTER TABLE market_intel_brief
  DROP COLUMN headline,
  DROP COLUMN market_dynamics,
  DROP COLUMN cedants,
  DROP COLUMN regulatory,
  DROP COLUMN developments,
  DROP COLUMN opportunities,
  DROP COLUMN from_the_desk;
