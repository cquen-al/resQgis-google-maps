CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS users (
 id bigserial PRIMARY KEY, username text UNIQUE NOT NULL,
 password_hash text NOT NULL, role text NOT NULL DEFAULT 'admin' CHECK(role='admin'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS boundaries (
 id bigserial PRIMARY KEY, source_id text UNIQUE NOT NULL, name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('city','barangay')), source_url text NOT NULL,
 geom geometry(MultiPolygon,4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS boundaries_geom_idx ON boundaries USING gist(geom);
CREATE TABLE IF NOT EXISTS facilities (
 id bigserial PRIMARY KEY, name text NOT NULL,
 facility_type text NOT NULL CHECK(facility_type IN ('hospital','fire_station','police','evacuation')),
 address text NOT NULL DEFAULT '', contact_number text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
 verification_status text NOT NULL DEFAULT 'NEEDS_VERIFICATION'
   CHECK(verification_status IN ('VERIFIED','NEEDS_VERIFICATION','INACTIVE')),
 verification_source_name text NOT NULL DEFAULT '',
 verification_source_url text NOT NULL DEFAULT '',
 last_verified date,
 barangay_id bigint REFERENCES boundaries(id) ON DELETE SET NULL,
 geom geometry(Point,4326) NOT NULL, source_id text UNIQUE,
 source_url text NOT NULL DEFAULT '', location_method text NOT NULL DEFAULT 'map selection',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS facilities_geom_idx ON facilities USING gist(geom);
CREATE INDEX IF NOT EXISTS facilities_geog_idx ON facilities USING gist((geom::geography));
CREATE TABLE IF NOT EXISTS facility_source_aliases (
 source_id text PRIMARY KEY, facility_id bigint NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
 source_url text NOT NULL, reason text NOT NULL
);
CREATE TABLE IF NOT EXISTS incident_reports (
 id bigserial PRIMARY KEY,
 incident_type text NOT NULL CHECK(incident_type IN ('flood','fire','accident','medical','other')),
 description text NOT NULL CHECK(length(description) BETWEEN 10 AND 2000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','responding','resolved')),
 barangay_id bigint REFERENCES boundaries(id) ON DELETE SET NULL,
 geom geometry(Point,4326) NOT NULL, photo_path text,
 reported_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_geom_idx ON incident_reports USING gist(geom);
CREATE TABLE IF NOT EXISTS rate_limits (
 bucket text PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), hits integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS audit_log (
 id bigserial PRIMARY KEY, user_id bigint REFERENCES users(id), action text NOT NULL,
 record_id bigint, created_at timestamptz NOT NULL DEFAULT now()
);

-- Upgrade existing installations without deleting facilities or other data.
ALTER TABLE facilities DROP CONSTRAINT IF EXISTS facilities_status_check;
UPDATE facilities SET status='active', updated_at=now() WHERE status='unverified';
ALTER TABLE facilities ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE facilities ADD CONSTRAINT facilities_status_check CHECK(status IN ('active','inactive'));

ALTER TABLE facilities
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'NEEDS_VERIFICATION';
ALTER TABLE facilities
  ADD COLUMN IF NOT EXISTS verification_source_name text NOT NULL DEFAULT '';
ALTER TABLE facilities
  ADD COLUMN IF NOT EXISTS verification_source_url text NOT NULL DEFAULT '';
ALTER TABLE facilities
  ADD COLUMN IF NOT EXISTS last_verified date;
UPDATE facilities
SET verification_status='NEEDS_VERIFICATION'
WHERE verification_status IS NULL OR verification_status NOT IN
  ('VERIFIED','NEEDS_VERIFICATION','INACTIVE');
ALTER TABLE facilities DROP CONSTRAINT IF EXISTS facilities_verification_status_check;
ALTER TABLE facilities ADD CONSTRAINT facilities_verification_status_check
  CHECK(verification_status IN ('VERIFIED','NEEDS_VERIFICATION','INACTIVE'));
