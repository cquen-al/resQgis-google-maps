"""Fetch source records once; never invent missing facilities or boundaries."""
import concurrent.futures
import json
from pathlib import Path
from datetime import datetime, timezone
import requests

DATA = Path(__file__).parent / 'data'
ENDPOINT = 'https://overpass-api.de/api/interpreter'
QUERIES = {
    'city': '[out:json][timeout:120];rel(14141553);out geom;',
    'facilities': '[out:json][timeout:120];nwr[amenity~"^(hospital|fire_station|police)$"](8.7438542,125.4423327,9.0559447,125.7356281);out center tags;',
    'barangays': '[out:json][timeout:120];area[boundary=administrative][name=Butuan]->.a;rel(area.a)[boundary=administrative][admin_level=10];out geom;'
}

def fetch(item):
    key,query=item
    r=requests.post(ENDPOINT,data={'data':query},timeout=180,
                    headers={'User-Agent':'ButuanResQGIS/0.1 educational GIS data import'})
    r.raise_for_status(); data=r.json()
    if data.get('remark'): raise RuntimeError(data['remark'])
    if key=='city' and len(data.get('elements',[]))!=1:
        raise RuntimeError('City boundary must resolve to exactly one relation; inspect source.')
    DATA.mkdir(exist_ok=True)
    (DATA/f'osm_{key}.json').write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
    print(key,len(data['elements']),flush=True)
    return key

if __name__=='__main__':
    for item in QUERIES.items():
        if not (DATA/f'osm_{item[0]}.json').exists(): fetch(item)
    (DATA/'provenance.json').write_text(json.dumps({
        'source':'OpenStreetMap contributors', 'license':'ODbL 1.0',
        'license_url':'https://www.openstreetmap.org/copyright',
        'endpoint':ENDPOINT,'retrieved_at':datetime.now(timezone.utc).isoformat(),
        'queries':QUERIES,
        'limitations':['Volunteer-mapped data may be incomplete or out of date.',
          'Facility operating status has not been verified; imported status is unverified.',
          'OSM way/relation facilities use returned bounding-box centers, not surveyed entrances.',
          'Barangay coverage is only the available OSM polygons; missing areas are not inferred.',
          'No evacuation centers or hazard polygons have been fabricated.']},indent=2),encoding='utf-8')
