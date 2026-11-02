-- Only what is needed to send one alert: no account, no name, no device id.
CREATE TABLE IF NOT EXISTS spots (
  endpoint     TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  cnn          TEXT NOT NULL,
  side         TEXT NOT NULL,
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  fire_at      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spots_fire_at ON spots (fire_at);
