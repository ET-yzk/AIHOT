-- What the platform last sent to the Feishu projection table (DES §6.4, CT-4). The table is a mirror:
-- one row per projected portal row, keyed by the portal's own id, holding the record's Feishu token and
-- a hash of the values last accepted by the API. A row whose hash still matches is never sent again, so
-- an idle cycle makes no API call at all; a token that no longer exists in the table is forgotten by the
-- projection job itself, not here. Nothing in the platform reads this table for anything but the next
-- projection cycle: a projection is never a data source.
CREATE TABLE IF NOT EXISTS projection_rows (
  job          text NOT NULL,
  entity_key   text NOT NULL,
  row_token    text NOT NULL,
  row_hash     text NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job, entity_key)
);
