"""Import emergency facilities from Google Places API (New)."""
import requests


PLACE_TYPES = {
    'hospital': 'hospital',
    'fire_station': 'fire_station',
    'police': 'police',
}


def import_places(conn, api_key):
    imported = 0

    for facility_type in PLACE_TYPES:
        for place in search_places(api_key, facility_type):
            location = place.get('location', {})
            latitude = location.get('latitude')
            longitude = location.get('longitude')
            place_id = place.get('id')
            name = place.get('displayName', {}).get('text')

            if not all((latitude, longitude, place_id, name)):
                continue

            conn.execute(
                '''
                INSERT INTO facilities(
                    name, facility_type, address, contact_number,
                    geom, source_id, source_url, location_method
                )
                VALUES(
                    %s, %s, %s, %s,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                    %s, %s, %s
                )
                ON CONFLICT(source_id) DO UPDATE SET
                    name=EXCLUDED.name,
                    address=EXCLUDED.address,
                    contact_number=EXCLUDED.contact_number,
                    geom=EXCLUDED.geom,
                    location_method=EXCLUDED.location_method
                ''',
                (
                    name,
                    facility_type,
                    place.get('formattedAddress', ''),
                    place.get('nationalPhoneNumber', ''),
                    longitude,
                    latitude,
                    f'google:{place_id}',
                    f'https://www.google.com/maps/search/?api=1&query=Google&query_place_id={place_id}',
                    'Google Places location',
                ),
            )
            imported += 1

    return imported


def search_places(api_key, facility_type):
    if facility_type not in PLACE_TYPES:
        raise ValueError('Unsupported Google facility type.')

    response = requests.post(
        'https://places.googleapis.com/v1/places:searchText',
        headers={
            'X-Goog-Api-Key': api_key,
            'X-Goog-FieldMask': (
                'places.id,places.displayName,places.formattedAddress,'
                'places.location,places.nationalPhoneNumber,places.types'
            ),
        },
        json={
            'textQuery': f'{facility_type.replace("_", " ")} in Butuan City, Philippines',
            'includedType': PLACE_TYPES[facility_type],
            'languageCode': 'en',
            'regionCode': 'PH',
            'locationBias': {
                'circle': {
                    'center': {
                        'latitude': 8.947,
                        'longitude': 125.535,
                    },
                    'radius': 20000,
                }
            },
            'maxResultCount': 20,
        },
        timeout=(3, 20),
    )
    response.raise_for_status()
    return response.json().get('places', [])
