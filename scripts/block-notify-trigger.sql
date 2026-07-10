-- Block-cache invalidation trigger.
--
-- The indexer (ixo-blocksync) updates "Chain".blockHeight inside every
-- per-block transaction; this trigger turns that into a pg_notify the API's
-- block cache LISTENs on, so cached responses are flushed the instant a new
-- block's data becomes visible.
--
-- Apply once per database (idempotent). In production this belongs in an
-- ixo-blocksync migration; the API also has a poll backstop
-- (BLOCK_CACHE_BACKSTOP_MS) so a missing trigger only degrades invalidation
-- latency, never correctness beyond the backstop interval.

CREATE OR REPLACE FUNCTION notify_blocksync_new_block() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('blocksync_new_block', NEW."blockHeight"::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blocksync_new_block_trigger ON "Chain";
CREATE TRIGGER blocksync_new_block_trigger
AFTER INSERT OR UPDATE ON "Chain"
FOR EACH ROW EXECUTE FUNCTION notify_blocksync_new_block();
