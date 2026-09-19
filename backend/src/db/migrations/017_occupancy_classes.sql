-- Occupancy classes: the standard "class / % of capacity" grading behind the
-- table of retentions. Reference data an admin maintains — the seed below is
-- the grading that shipped hard-coded with the retentions table.

CREATE TABLE occupancy_class (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The code written into a retention row ("A", "B", "1"). Editable, so the
  -- row keeps a surrogate key of its own.
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  capacity_pct NUMERIC(7,4) NOT NULL CHECK (capacity_pct >= 0 AND capacity_pct <= 100),
  -- Match terms used to grade an occupancy description into this class.
  occupancies  TEXT[] NOT NULL DEFAULT '{}',
  position     INTEGER NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Two classes answering to the same code would make grading ambiguous.
CREATE UNIQUE INDEX idx_occupancy_class_code ON occupancy_class (upper(code));

INSERT INTO occupancy_class (code, name, description, capacity_pct, position, occupancies) VALUES
  ('A', 'Non-hazardous', 'Simple, non-industrial occupancies with no process hazard.', 100, 1, ARRAY[
    'dwelling', 'residential', 'apartment', 'flat', 'bungalow', 'office',
    'offices and retail', 'retail', 'shop', 'school', 'college', 'university',
    'church', 'mosque', 'bank', 'clinic', 'surgery', 'hostel', 'library',
    'museum', 'government building'
  ]),
  ('B', 'Light hazard', 'Commercial, storage and light-industrial risks.', 75, 2, ARRAY[
    'warehousing', 'warehouse', 'light industry', 'workshop', 'garage',
    'hotel', 'guest house', 'lodge', 'hospital', 'supermarket',
    'shopping mall', 'restaurant', 'bakery', 'laundry', 'cold store',
    'cold storage', 'showroom', 'cinema', 'printing works', 'packaging',
    'data centre', 'data center'
  ]),
  ('C', 'Heavy / hazardous', 'Heavy industry and highly combustible or flammable processes.', 50, 3, ARRAY[
    'heavy industry', 'hazardous risk', 'hazardous', 'factory',
    'manufacturing', 'mill', 'textile mill', 'flour mill', 'spinning mill',
    'ginnery', 'foundry', 'steel', 'cement works', 'chemical', 'petrol',
    'filling station', 'petrol filling station', 'fuel depot', 'refinery',
    'sawmill', 'timber yard', 'foam', 'rubber', 'tyre', 'plastics',
    'distillery', 'brewery', 'grain silo', 'explosives', 'fireworks',
    'mining', 'quarry'
  ]);
