-- A note on a line: the declinature reason, or what the underwriter said
-- with their line. Recorded on the line itself — a declinature is a response
-- the desk keeps beside the nil line, not a missing row.

ALTER TABLE line ADD COLUMN notes TEXT;
