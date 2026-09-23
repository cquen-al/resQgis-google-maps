# Verification â€” Google Maps migration, 22 September 2026

## Completed

- 15 Python tests passed: five Google Routes/configuration tests and ten real PostGIS integration tests.
- Google API transport was mocked: coordinate order, response field mask, GeoJSON parsing, road-distance ranking, unavailable routes, timeout, quota and authorization failures.
- Active-only analysis, inactive exclusion, facility CRUD, report lifecycle, private uploads, authentication, CSRF, source import and spatial calculations exercised in a disposable database.
- Python and both application JavaScript files passed syntax checks.
- The browser rendered the missing-Google-key message and the Active/Inactive options.
- All 30 legacy Unverified facility records in the current database were migrated to Active. Facility IDs and record counts were preserved.
- Single-key configuration uses GOOGLE_MAPS_API_KEY in the browser and server. The shared key is visible in HTML; database and other environment settings were preserved.

## Still requires live configuration

- Google map rendering and advanced markers with a valid shared API key.
- Places API (New), forward/reverse geocoding and real Google Routes responses.
- Mobile and desktop interaction checks with the live Google map.
- GeoServer WMS overlay, public deployment, Docker and HTTPS.

No paid Google calls were made. The keyless browser check does not establish successful live Google integration. Follow GOOGLE_MAPS_SETUP.md after adding your key.

Integration tests use a disposable database. On Windows their schema is removed but an empty test database remains, matching the existing test cleanup strategy.
