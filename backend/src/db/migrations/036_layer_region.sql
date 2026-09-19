-- A layer's geographic scope: the region it is restricted to (Middle East,
-- Europe…) — the reference countries' regions — or worldwide when null.
ALTER TABLE layer ADD COLUMN region TEXT;
