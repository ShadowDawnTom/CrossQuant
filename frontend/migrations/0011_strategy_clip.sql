-- Pairs the legs of one strategy clip (and any repair orders for it) so hedge accounting can
-- recover each clip's intended left:right quantity ratio. Required for equal-notional premium
-- hedging, where the ratio is fixed per clip at execution prices rather than per strategy.
ALTER TABLE execution_orders ADD COLUMN strategy_clip TEXT;
