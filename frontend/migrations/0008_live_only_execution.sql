DELETE FROM execution_fills
WHERE order_id IN (
  SELECT id FROM execution_orders WHERE environment <> 'live'
);

DELETE FROM execution_strategy_logs
WHERE strategy_id IN (
  SELECT id FROM execution_strategies WHERE environment <> 'live'
);

DELETE FROM execution_strategies WHERE environment <> 'live';
DELETE FROM execution_orders WHERE environment <> 'live';

DROP TABLE IF EXISTS paper_positions;
