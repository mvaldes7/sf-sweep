-- Sign-photo reports (issue #10). Applied only to the sf-sweep-reports D1 database.
-- Do not run this against the sf-sweep alerts database.

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
  cnn TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('L', 'R')),
  street TEXT,
  limits TEXT,
  blockside TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  days TEXT,
  from_time TEXT,
  to_time TEXT,
  weeks TEXT,
  holidays INTEGER,
  note TEXT,
  photo_key TEXT NOT NULL,
  photo_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  review_note TEXT,
  correction_json TEXT
);

CREATE INDEX IF NOT EXISTS reports_status_created ON reports (status, created_at DESC);
