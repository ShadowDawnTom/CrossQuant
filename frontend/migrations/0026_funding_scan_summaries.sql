-- 前端总览只读每分钟一行的小表，不能再同步聚合上亿级原始候选明细。
CREATE TABLE IF NOT EXISTS funding_scan_summaries (
  scan_id TEXT PRIMARY KEY,
  research_model_version TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observations INTEGER NOT NULL,
  live_eligible INTEGER NOT NULL,
  research_eligible INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  rejection_reasons_json TEXT NOT NULL DEFAULT '{}',
  observation_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS funding_scan_summaries_model_time_idx
  ON funding_scan_summaries(research_model_version, observed_at DESC);
