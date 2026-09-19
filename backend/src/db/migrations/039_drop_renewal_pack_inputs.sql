-- The paste-from-Excel input tabs are gone from the Renewal Pack tab, and
-- with them the API that saved a pasted block per section. The pack is built
-- from the screens and the bordereaux; a version cut from pasted data keeps
-- that data in its own snapshot, so nothing a market was sent is lost.

DROP TABLE IF EXISTS renewal_pack_input;
