# Butuan ResQGIS

Butuan ResQGIS is a Flask/PostGIS emergency-resource GIS for exploring hospitals, fire stations, police-related facilities, barangay boundaries, and verified community incident reports in Butuan City.

The application is a geographic information and planning tool. It is not an emergency dispatch system and does not independently certify facility capacity, availability, response time, or public access.

## What the project does

- Displays a Google Maps basemap with facility markers.
- Loads hospital, fire station, and police-related facility records sourced from Google Places.
- Lets users search for places and select coordinates on the map.
- Uses Google Geocoding and Places for address/location workflows.
- Uses Google Routes for nearest-facility driving routes, road distance, duration, and route geometry.
- Displays city and barangay boundary polygons from the spatial database.
- Provides three analysis modes:
  - **Nearest Facilities**: ranks nearby active facilities by Google driving distance when a route is available.
  - **Service Coverage**: draws PostGIS geographic buffers around selected facilities.
  - **Barangay Accessibility**: measures each barangay's nearest selected facility from `ST_PointOnSurface` of the barangay polygon.
- Allows users to report incidents with optional private photos.
- Provides administrator authentication, facility management, incident review, and status management.
- Supports optional GeoServer WMS boundary overlays.

## Technology stack

### Backend

- Python 3
- Flask
- Waitress production WSGI server
- Psycopg 3
- PostgreSQL with PostGIS
- Python-dotenv for environment configuration
- Werkzeug password hashing and Flask sessions
- Requests for Google API and GeoServer HTTP requests
- Pillow for uploaded-image validation

### Frontend

- Server-rendered HTML templates with Jinja
- Modern JavaScript
- CSS with responsive desktop/mobile layouts
- Google Maps JavaScript API
- Google Places API (New)
- Google Geocoding API
- Google Routes API
- Vendored Lucide icons and Turf.js

The project contains a small Leaflet-compatible interface in `static/google-map.js`. It preserves the existing `L.*` application calls while creating Google Maps objects underneath. The active page does not load Leaflet map tiles.

### Infrastructure

- Docker and Docker Compose
- `postgis/postgis` database container
- Optional Caddy reverse proxy for HTTPS
- Persistent PostgreSQL and application volumes

## Data sources and accuracy

### Facility verification and data quality

Facility records are not considered authoritative merely because they appear in
Google Places, OpenStreetMap, or another map provider. Each facility has a
separate `verification_status` with one of `VERIFIED`,
`NEEDS_VERIFICATION`, or `INACTIVE`, plus the authoritative source name, source
URL, and `last_verified` date. Existing facilities are conservatively
initialized as `NEEDS_VERIFICATION`; no facility is deleted or automatically
promoted to `VERIFIED`.

The public facility map and all three spatial analyses (Nearest Facility,
Service Coverage, and Barangay Accessibility) require both
`verification_status='VERIFIED'` and `status='active'`. Administrators can
review all facility records and record evidence from appropriate sources such
as DOH/official health registries, BFP, PNP, Butuan City government, CDRRMO,
OCD, or DSWD. Google Places remains discovery/source metadata, not proof of
government legitimacy or current operation.

### Facilities

Public facility records are selected from:

- Google Places hospitals
- Google Places fire stations
- Google Places police-related places
- Administrator-created facilities with `source_id IS NULL`

Legacy non-Google facility records remain in the database for provenance but are excluded from the public facility and analysis queries. Evacuation centers are not exposed as a supported facility type.

The application should describe the records as **Google Places emergency-related facilities**. Google source verification confirms the listing, name, category, and coordinates at import/check time; it does not independently certify emergency capacity, availability, staffing, or public access.

Import or refresh Google facilities with:

```powershell
& .\.venv\Scripts\python.exe -m flask --app app:create_app import-google-places
```

The importer stores Google Place IDs as `google:<place_id>` and keeps the Google Maps source URL with each record.

### Boundaries

Barangay polygons are stored in PostGIS and used for map context, barangay assignment, filtering, and accessibility analysis. The current project contains 86 available barangay polygons imported from the publicly available Philippine Statistics Authority (PSA) / GeoRiskPH ArcGIS service:

```text
https://ulap-nga.georisk.gov.ph/arcgis/rest/services/PSA/BarangayPopMF/MapServer/0/query
```

The import filters `city_name` for Butuan City, preserves PSA barangay codes and attributes, validates the geometries with PostGIS, and stores each boundary with a `psa_barangay/<brgy_code>` source identifier. The Butuan City boundary is generated by dissolving the imported barangay polygons; it is not fabricated.

OpenStreetMap data is retained only for legacy/source workflows and older imported facility snapshots. It is not the active source of the current barangay boundary layer.

### GeoServer

GeoServer is an optional GIS map-service component used by ResQGIS to publish spatial layers as OGC Web Map Service (WMS) overlays. It does not replace Google Maps. Google Maps remains the interactive basemap, while GeoServer supplies server-rendered GIS layers that can be turned on or off from the **Layers** panel.

The current local GeoServer workspace is `resqgis`, with these published layers:

| Layer | Purpose |
| --- | --- |
| `resqgis:boundaries` | Butuan City boundary overlay |
| `resqgis:facilities` | GeoServer-rendered facility points, if needed |
| `resqgis:incident_reports` | GeoServer-rendered incident points, if needed |

The application currently enables `resqgis:boundaries` as the optional overlay. That GeoServer layer should be backed by the same PSA-derived boundary data in PostGIS. Facilities and incidents continue to use the application's APIs and Google Maps markers because those layers provide the interactive filters, popups, status handling, and analysis behavior.

#### GeoServer connection flow

1. GeoServer publishes a layer in the `resqgis` workspace.
2. ResQGIS reads `GEOSERVER_WMS_URL` and `GEOSERVER_LAYER` from `.env`.
3. The browser requests map tiles from the Flask `/api/geoserver` proxy when the GeoServer checkbox is enabled.
4. Flask validates the requested tile bounds and forwards a WMS `GetMap` request to GeoServer.
5. GeoServer renders the selected layer as a PNG image in the Google Maps projection (`EPSG:3857`).
6. The frontend places the returned images above the Google basemap and below interactive facility, incident, and analysis markers.

The proxy keeps the GeoServer URL and layer configuration on the server side and gives the frontend a same-origin endpoint. The application does not use the GeoServer administration page as a map endpoint.

To inspect the service manually, use a WMS capabilities request:

```text
http://localhost:8081/geoserver/resqgis/wms?service=WMS&version=1.3.0&request=GetCapabilities
```

Opening only `/geoserver/resqgis/wms` produces a missing-parameter error because a WMS request type is required.

### Distance methods

- **Nearest Facilities** uses Google Routes driving distance and route geometry after a spatial shortlist.
- **Service Coverage** uses geographic PostGIS buffers. It does not represent travel time.
- **Barangay Accessibility** uses:

  ```sql
  ST_Distance(
      facility.geom::geography,
      ST_PointOnSurface(barangay.geom)::geography
  )
  ```

  This is representative-point-to-facility geographic distance. It is not polygon-edge distance, road distance, traffic-aware response time, or a conventional centroid calculation.

## Project structure

| Path | Purpose |
| --- | --- |
| `app.py` | Flask application, API routes, authentication, database queries, CLI commands, and spatial analysis |
| `google_places.py` | Google Places search and database upsert logic |
| `google_services.py` | Google Routes request and route-geometry validation |
| `templates/index.html` | Main application UI |
| `static/app.js` | Frontend state, API calls, markers, overlays, filters, and analysis rendering |
| `static/google-map.js` | Google Maps compatibility layer for the existing map abstraction |
| `static/app.css` | Application styling and responsive layout |
| `schema.sql` | PostgreSQL/PostGIS schema and constraints |
| `import_data.py` | Legacy/source data import and boundary loading |
| `fetch_osm.py` | Legacy OSM data retrieval helper |
| `data/` | Boundary, provenance, and legacy source data |
| `tests/` | Integration and Google service tests |
| `serve.py` | Waitress launcher for local/container execution |
| `Dockerfile` | Web-container image definition |
| `compose.yaml` | Local PostgreSQL/PostGIS and web services |
| `compose.public.yaml` | Public/HTTPS deployment composition |

## Requirements

- Windows PowerShell, Linux shell, or macOS terminal
- Python 3
- PostgreSQL 17 with PostGIS 3.5, or Docker Desktop
- A Google Cloud project with billing enabled
- Enabled Google APIs:
  - Maps JavaScript API
  - Places API
  - Geocoding API
  - Routes API
- A Google Maps JavaScript Map ID

## Configuration

Copy the example environment file:

```powershell
Copy-Item .env.example .env
```

Set values in `.env`:

```dotenv
SECRET_KEY=replace-with-a-long-random-secret
DATABASE_URL=postgresql://resqgis:password@localhost:5432/resqgis
GOOGLE_MAPS_API_KEY=your-google-api-key
GOOGLE_MAP_ID=your-google-map-id
SESSION_COOKIE_SECURE=false
```

Optional GeoServer settings:

```dotenv
GEOSERVER_WMS_URL=http://localhost:8081/geoserver/resqgis/wms
GEOSERVER_LAYER=resqgis:boundaries
```

`GEOSERVER_WMS_URL` must be the WMS service endpoint, not the GeoServer Web Administration URL and not a complete `GetCapabilities` URL. `GEOSERVER_LAYER` must match the published workspace-qualified layer name shown in GeoServer under **Data → Layers**.

After changing these values, restart the Flask/Waitress process. When both values are present, the **GeoServer boundary layer** checkbox appears in the map's **Layers** panel. Unchecking it removes the WMS overlay without removing the Google basemap or the application's interactive layers.

Restrict the browser API key by HTTP referrer and restrict server-side keys by API and server policy. Never commit `.env` or expose secrets in screenshots, logs, or source control.

## Local setup

### 1. Create the virtual environment

```powershell
py -3 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 2. Prepare PostgreSQL/PostGIS

Create a database and enable PostGIS, then set `DATABASE_URL` in `.env`.

Initialize the schema:

```powershell
& .\.venv\Scripts\python.exe -m flask --app app:create_app init-db
```

### 3. Import boundaries and optional legacy source data

For an empty installation that needs the PSA/GeoRisk barangay boundary file:

```powershell
& .\.venv\Scripts\python.exe -m flask --app app:create_app import-osm
```

Despite the command's historical name, this command currently loads `data/butuan_barangays.geojson`, which is the PSA/GeoRisk barangay dataset, and generates the city boundary from those polygons. Do not run it just to configure Google APIs; it reloads boundary records and legacy source records.

### 4. Import Google Places facilities

```powershell
& .\.venv\Scripts\python.exe -m flask --app app:create_app import-google-places
```

### 5. Create an administrator

There is no default administrator account:

```powershell
& .\.venv\Scripts\python.exe -m flask --app app:create_app create-admin
```

The command prompts for credentials. Use a strong password of at least 12 characters.

### 6. Run the website

Recommended local launcher:

```powershell
& .\.venv\Scripts\python.exe .\serve.py
```

Alternatively:

```powershell
& .\.venv\Scripts\python.exe .\app.py
```

Open <http://127.0.0.1:8000/>.

## How the application works

1. Flask loads configuration from `.env` and creates a database connection when an API request needs one.
2. The browser loads the Google Maps compatibility layer and creates one map instance.
3. Facility, incident, metadata, and boundary APIs populate the existing map layers.
4. Facility filters call `/api/facilities`; selected barangays are matched by stored assignment or spatial containment in the barangay polygon.
5. Analysis requests call the corresponding Flask endpoint:
   - `/api/analysis/nearest`
   - `/api/analysis/coverage`
   - `/api/analysis/accessibility`
6. PostGIS performs spatial filtering, buffers, containment, and geographic distance calculations.
7. Google Routes supplies driving route details for nearest-facility results.
8. When enabled, the frontend requests GeoServer WMS tiles through `/api/geoserver`; Flask forwards them to the configured GeoServer layer.
9. The frontend draws WMS overlays, routes, buffers, colored barangay polygons, popups, and result summaries without creating duplicate map instances.
10. Clear Analysis removes analysis overlays and restores normal facility and barangay layers.

## Docker setup

Set `DB_PASSWORD` and `SECRET_KEY` in `.env`, then run:

```powershell
docker compose up -d --build
docker compose exec web flask --app app:create_app init-db
docker compose exec web flask --app app:create_app import-osm
docker compose exec web flask --app app:create_app import-google-places
docker compose exec web flask --app app:create_app create-admin
```

The local web service is exposed at <http://127.0.0.1:8000/>. PostgreSQL is kept inside the Compose network and its data is stored in the `pgdata` volume.

If GeoServer runs directly on the Windows host, `http://localhost:8081` is normally correct. If the Flask application runs inside Docker while GeoServer runs on the host, `localhost` inside the web container refers to the container itself; use `http://host.docker.internal:8081/geoserver/resqgis/wms` instead. If both services run in Compose, use the GeoServer Compose service name as the hostname.

For public HTTPS deployment, use the public Compose configuration, configure a domain and reverse proxy, set `SESSION_COOKIE_SECURE=true`, and keep database/application volumes backed up.

## Testing and validation

JavaScript syntax:

```powershell
node --check static/app.js
node --check static/google-map.js
```

Python compilation:

```powershell
& .\.venv\Scripts\python.exe -m py_compile app.py google_places.py google_services.py
```

Integration tests:

```powershell
& .\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Integration tests require a PostgreSQL server that permits disposable test databases. Google Routes calls are mocked by the tests; no paid Google request is required for the unit test path.

## Security and operational notes

- Keep `.env`, API keys, database credentials, session secrets, and uploaded photos private.
- Passwords are stored as Werkzeug hashes, not plaintext.
- State-changing requests use CSRF protection.
- Uploaded images are size/type validated and stored under `instance/uploads`.
- Facility status means application eligibility, not confirmed emergency readiness.
- Google Places data should be periodically refreshed and manually reviewed for duplicates, incorrect categories, closed listings, and non-public offices.
- The application is not a substitute for emergency dispatch, official facility directories, road conditions, traffic information, or capacity confirmation.

## Related documentation

- [Google Maps setup](GOOGLE_MAPS_SETUP.md)
- [Third-party licenses and attribution](THIRD_PARTY.md)
- [Verification checklist](VERIFICATION.md)
