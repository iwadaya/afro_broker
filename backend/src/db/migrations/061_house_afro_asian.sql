-- The house is Afro-Asian Insurance Services Ltd, broker at Lloyd's. The
-- rows that carried the previous name follow — the placements the house led
-- and bound, the broker share it took on a programme, the notes fold that
-- names the broker — and the house joins the brokers the contract details
-- offer.

UPDATE final_placement SET lead_broker = 'Afro-Asian Insurance Services' WHERE lead_broker = 'Universe Broking';

UPDATE contract_share SET name = 'Afro-Asian Insurance Services' WHERE party = 'broker' AND name = 'Universe Broking';

UPDATE placement
   SET notes = replace(notes, 'Broker: Universe Broking', 'Broker: Afro-Asian Insurance Services')
 WHERE notes LIKE '%Broker: Universe Broking%';

INSERT INTO public.brokers (broker_name)
SELECT 'Afro-Asian Insurance Services'
 WHERE NOT EXISTS (SELECT 1 FROM public.brokers WHERE broker_name = 'Afro-Asian Insurance Services');
