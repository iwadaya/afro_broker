-- The Documents step, as the Universe modelling tool's Documents screen
-- keeps a file: a document type off the tool's list (Final Slip, Draft
-- Slip, Expiring Slip, Renewal Pack, Large Loss List, Risk Profiles, Claims
-- Profile, Presentation, CAT Modelling, Bordereaux, Accounts, Other), a
-- title and a description — in place of the kind and the note the first
-- cut carried. What was uploaded under a kind reads through to the nearest
-- type, titled after its file.

ALTER TABLE contract_document DROP CONSTRAINT IF EXISTS contract_document_kind_check;
ALTER TABLE contract_document RENAME COLUMN kind TO doc_type;
ALTER TABLE contract_document RENAME COLUMN note TO description;
ALTER TABLE contract_document ADD COLUMN title TEXT;

UPDATE contract_document
   SET doc_type = CASE doc_type
                    WHEN 'slip' THEN 'Final Slip'
                    WHEN 'submission' THEN 'Renewal Pack'
                    WHEN 'bordereau' THEN 'Bordereaux'
                    WHEN 'statement' THEN 'Accounts'
                    ELSE 'Other'
                  END,
       title = regexp_replace(filename, '\.[^.]+$', '');

ALTER TABLE contract_document ALTER COLUMN doc_type SET DEFAULT 'Other';
ALTER TABLE contract_document ALTER COLUMN title SET NOT NULL;
ALTER TABLE contract_document ADD CONSTRAINT contract_document_doc_type_check
  CHECK (doc_type IN ('Final Slip','Draft Slip','Expiring Slip','Renewal Pack','Large Loss List','Risk Profiles',
                      'Claims Profile','Presentation','CAT Modelling','Bordereaux','Accounts','Other'));
