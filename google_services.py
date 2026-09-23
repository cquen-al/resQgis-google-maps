"""Google Routes transport, kept separate from Flask and database code."""
import math
import requests


class GoogleRoutesError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def compute_route(key, origin_lon, origin_lat, dest_lon, dest_lat):
    def waypoint(lon, lat):
        return {'location': {'latLng': {'latitude': lat, 'longitude': lon}}}

    try:
        response = requests.post(
            'https://routes.googleapis.com/directions/v2:computeRoutes',
            headers={
                'X-Goog-Api-Key': key,
                'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.geoJsonLinestring',
            },
            json={
                'origin': waypoint(origin_lon, origin_lat),
                'destination': waypoint(dest_lon, dest_lat),
                'travelMode': 'DRIVE',
                'routingPreference': 'TRAFFIC_AWARE',
                'polylineEncoding': 'GEO_JSON_LINESTRING',
                'polylineQuality': 'HIGH_QUALITY',
                'computeAlternativeRoutes': False,
                'units': 'METRIC',
            },
            timeout=(3, 12),
        )
        if response.status_code in (401, 403):
            raise GoogleRoutesError('Google Routes authorization failed. Check the server key, API restrictions and billing.', 503)
        if response.status_code == 429:
            raise GoogleRoutesError('Google Routes quota is temporarily exhausted. Try again later.', 503)
        response.raise_for_status()
        payload = response.json()
        if not payload.get('routes'):
            return None
        route = payload['routes'][0]
        distance = float(route['distanceMeters'])
        duration = float(route['duration'].removesuffix('s'))
        geometry = route['polyline']['geoJsonLinestring']
        if (not math.isfinite(distance) or not math.isfinite(duration)
                or distance < 0 or duration < 0
                or geometry.get('type') != 'LineString'
                or len(geometry.get('coordinates', [])) < 2):
            raise ValueError('Invalid route')
        return distance, duration, geometry
    except requests.Timeout:
        raise GoogleRoutesError('Google Routes timed out. Please try again.', 504) from None
    except (requests.RequestException, ValueError, KeyError, TypeError):
        raise GoogleRoutesError('Google Routes could not return driving directions. Please try again.') from None
