# Third-party assets and sources

- Turf 7.2.0: https://github.com/Turfjs/turf/tree/v7.2.0 â€” MIT.
- Lucide 0.468.0: https://github.com/lucide-icons/lucide/tree/0.468.0 â€” ISC.
- OpenStreetMap source data: https://www.openstreetmap.org/copyright â€” ODbL 1.0.
- OSM standard tiles: https://operations.osmfoundation.org/policies/tiles/.
- PostGIS documentation: https://postgis.net/docs/.

Browser packages are vendored to avoid a runtime CDN dependency. Preserve their license headers and the accompanying license files in `static/vendor` when redistributing.

## Google Maps migration

Google Maps JavaScript API supplies the active basemap and overlays. Places API (New) supplies autocomplete, Geocoding API supplies address conversion, and Routes API supplies driving directions. Google branding and map attribution are displayed by its JavaScript API. See https://cloud.google.com/maps-platform/terms and each API's documentation.

The current page uses Google Maps through the compatibility layer in `static/google-map.js`; it does not load Leaflet. OpenStreetMap attribution applies only to retained legacy source data. Turf and Lucide remain in use.
