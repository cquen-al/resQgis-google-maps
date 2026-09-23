# ResQGIS Google Maps setup

The project is ready for your key. Its current folder is:

`C:\Users\User\OneDrive\SJIT FILES\resqgis`

## 1. Enable the four APIs

In your [Google Cloud project](https://console.cloud.google.com/), attach billing and enable:

- Maps JavaScript API
- Routes API
- Places API (New)
- Geocoding API

## 2. Configure your one API key

Open **APIs & Services → Credentials**, then open your existing API key.

Under **API restrictions**, select **Restrict key** and allow all four APIs:

- Maps JavaScript API
- Routes API
- Places API (New)
- Geocoding API

This version shares the same key between the browser and Flask's server-side Routes requests. For this mixed client/server setup, use **Application restrictions → None**. Website/referrer restrictions block server-side Routes calls, while server-IP restrictions do not support a general browser deployment.

The shared key is visible in the browser. API restrictions limit which services it can call but do not prevent another person from reusing it for those services. Set conservative API quotas and billing alerts for local development. Google recommends separate application-restricted keys for public client/server deployments; see its [key security guidance](https://developers.google.com/maps/api-security-best-practices). No Google Cloud settings have been changed automatically.

## 3. Put the key in `.env`

Open:

`C:\Users\User\OneDrive\SJIT FILES\resqgis\.env`

Only these two Google settings are needed:

```dotenv
GOOGLE_MAPS_API_KEY=YOUR_GOOGLE_API_KEY_HERE
GOOGLE_MAP_ID=DEMO_MAP_ID
```

The old `GOOGLE_MAPS_BROWSER_KEY` and `GOOGLE_ROUTES_API_KEY` settings have been replaced. Keep your existing database and other settings. Do not replace your entire `.env` file with `.env.example`.

`DEMO_MAP_ID` is a development map ID, not another API key. It enables advanced markers during development. For production, create a JavaScript map ID in Google Maps Platform → Map Management.

The same `GOOGLE_MAPS_API_KEY` is used by Maps JavaScript, Places and Geocoding in the browser and Routes in Flask. Keep `.env` out of Git and avoid sharing the key in screenshots or chat.

## 4. Restart ResQGIS

Stop the existing ResQGIS server in its terminal with Ctrl+C. Open PowerShell in the project folder, then run:

```powershell
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
& .\.venv\Scripts\python.exe app.py
```

Leave that terminal running and open [ResQGIS](http://127.0.0.1:8000/). This uses the existing PostgreSQL/PostGIS database configured in `.env`; PostgreSQL must be running. The application loads `.env` automatically. Existing process environment variables take precedence over `.env`, so clear stale `GOOGLE_*` variables if you previously set them in the terminal.

The old `start-local.ps1` references an external preview runtime; use the commands above for this project folder.

For Docker, after editing `.env`, recreate the web container:

```powershell
docker compose up -d --build web
```

The current local database has already been migrated to Active/Inactive status. For another installation, run the idempotent schema upgrade once:

```powershell
& .\.venv\Scripts\python.exe -m flask --app app:create_app init-db
```

Do not re-import data merely to configure Google keys.

## 4a. Import Google facilities

The public facility map uses Google Places records, not the older OpenStreetMap facility snapshot. After configuring the key and database, run:

```powershell
& .\.venv\Scripts\python.exe -m flask --app app:create_app import-google-places
```

This imports or updates Google Places hospitals, fire stations and police stations within the Butuan search area. Evacuation centers are intentionally excluded. The importer stores the Google place ID and source link so records can be refreshed without creating duplicates.

## 5. Check the four integrations

1. **Map:** Google Maps appears with facility markers. Test zoom, boundary toggles and a facility card.
2. **Places:** Open **Search a location** on the map and type a landmark such as “Robinsons Butuan”. Select a Google suggestion.
3. **Geocoding:** In the same panel, enter an address or `8.947, 125.535` and select **Locate**. The result shows an address. Coordinates use latitude first, longitude second.
4. **Location selection:** For a report, facility or analysis, choose its location button, then select a place or click the map. PostGIS still checks whether the point is inside Butuan and assigns its barangay. Reverse geocoding supplies a display address.
5. **Routes:** In **Analysis → Nearest facilities**, choose a location, facility type and result count, then run analysis. The results display driving routes, road distance and estimated travel time. Click a result to highlight its route.

Routes run **from the selected location to the facility**, useful for finding access to care or other facilities. They are not a dispatch calculation from a station to an incident. Google driving directions do not establish emergency-vehicle privileges, flood safety or operational facility capacity.

## How routing works

PostGIS selects up to three times the requested result count by straight-line distance, using Active facilities only. Google Routes calculates traffic-aware driving directions for those candidates, then ResQGIS ranks successful routes by road distance. This is a shortlist, not an exhaustive citywide road-distance search. Requests are processed with at most five concurrent Google calls. The backend limits route analyses to 12 per minute per client IP (clients behind a proxy may share this limit).

One analysis can make multiple Routes requests: three displayed results means up to nine candidate route calls; ten results means up to thirty calls. Configure API quotas and billing alerts in Google Cloud. No Google response is permanently cached by this integration.

A facility with no available driving route is shown as a point with its straight-line distance clearly labeled; no artificial road line is drawn. Key, quota, network and provider errors produce a message instead of silently substituting another routing provider.

## Troubleshooting

| Message or symptom | Check |
| --- | --- |
| Google Maps is not configured | Fill `GOOGLE_MAPS_API_KEY`, save `.env`, restart the server. |
| Google authorization failed / map watermark | Billing, enabled APIs, the shared key and application restrictions for mixed browser/server usage. |
| Place search unavailable | Places API (New) must be enabled and allowed on the shared key. |
| Address lookup fails | Geocoding API must be enabled and allowed on the shared key. |
| Google Routes is not configured | Fill `GOOGLE_MAPS_API_KEY` and restart the server. |
| Routes authorization failed | Routes API, billing, shared-key API restrictions; website restrictions block server-side Routes requests. |
| Quota exhausted | Google Cloud quotas and billing; try again after the limit resets. |
| Database unavailable | PostgreSQL service and the existing `DATABASE_URL`. |

## Verification completed

- 15 Python tests passed, including real PostGIS integration tests in a disposable database and simulated Google Routes responses.
- Python and JavaScript syntax checks passed.
- The missing-key startup message was checked in the browser.
- All 30 existing Unverified facility records were migrated to Active without deleting facilities.
- Live Google map rendering, Places, Geocoding, Routes and GeoServer overlays still need your configured key/services for end-to-end verification.

Official references: [Maps JavaScript](https://developers.google.com/maps/documentation/javascript/overview), [Places autocomplete](https://developers.google.com/maps/documentation/javascript/place-autocomplete-new), [Geocoding](https://developers.google.com/maps/documentation/javascript/geocoding), [Routes](https://developers.google.com/maps/documentation/routes/compute_route_directions).
