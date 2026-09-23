"""Real PostGIS integration tests in a disposable, isolated database.

Run with DATABASE_URL pointing to a local development superuser. The tests create
and drop ONLY a uniquely named resqgis_test_* database, never the source database.
All geometries are copied from the actual imported OSM source data.
"""
import io
import os
import unittest
from unittest.mock import patch
import uuid
from pathlib import Path
import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from werkzeug.security import generate_password_hash
from app import create_app
from import_data import run

class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config=conninfo_to_dict(os.environ['DATABASE_URL'])
        config['dbname']='postgres';cls.admin_url=make_conninfo(**config)
        cls.name='resqgis_test_'+uuid.uuid4().hex[:12]
        with psycopg.connect(cls.admin_url,autocommit=True) as conn:
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(cls.name)))
        config['dbname']=cls.name;cls.url=make_conninfo(**config)
        with psycopg.connect(cls.url,row_factory=dict_row) as conn:
            conn.execute((Path(__file__).parents[1]/'schema.sql').read_text())
            run(conn)
            conn.execute('INSERT INTO users(username,password_hash) VALUES(%s,%s)',('testadmin',generate_password_hash('integration-only-password')))
            cls.real=conn.execute("SELECT name,ST_X(geom) AS longitude,ST_Y(geom) AS latitude FROM facilities WHERE barangay_id IS NOT NULL LIMIT 1").fetchone()
            cls.bpoint=conn.execute("SELECT name,ST_X(ST_PointOnSurface(geom)) AS longitude,ST_Y(ST_PointOnSurface(geom)) AS latitude FROM boundaries WHERE kind='barangay' LIMIT 1").fetchone()
            conn.commit()
        cls.app=create_app({'TESTING':True,'SECRET_KEY':'integration-only-key','DATABASE_URL':cls.url,'UPLOAD_FOLDER':str(Path(__file__).parents[1]/'instance/test-uploads')})

    @classmethod
    def tearDownClass(cls):
        if os.name=='nt':
            # PostgreSQL 18 on this Windows preview can wait indefinitely for a
            # ProcSignalBarrier on DROP DATABASE. Remove every test object and
            # extension instead; the empty disposable database can be removed
            # by the database owner after server restart.
            with psycopg.connect(cls.url,autocommit=True) as conn:
                conn.execute('DROP SCHEMA public CASCADE')
        else:
            with psycopg.connect(cls.admin_url,autocommit=True) as conn:
                conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(cls.name)))
        folder=Path(cls.app.config['UPLOAD_FOLDER'])
        if folder.exists():
            for p in folder.glob('*.jpg'):p.unlink()
            folder.rmdir()

    def setUp(self):
        self.client=self.app.test_client();self.csrf=self.client.get('/api/session').json['csrf']
        with psycopg.connect(self.url) as conn:conn.execute('DELETE FROM rate_limits')

    def post(self,path,data=None,**kw):
        return self.client.post(path,json=data,headers={'X-CSRF-Token':self.csrf},**kw)

    def login(self):
        response=self.post('/api/login',{'username':'testadmin','password':'integration-only-password'})
        self.assertEqual(response.status_code,200);self.csrf=response.json['csrf']

    def point(self):return {k:self.real[k] for k in ('latitude','longitude')}

    def test_01_real_data_and_search(self):
        response=self.client.get('/api/facilities');self.assertEqual(response.status_code,200)
        self.assertGreater(len(response.json['features']),10)
        for f in response.json['features']:self.assertTrue(f['properties']['source_url'].startswith('https://www.openstreetmap.org/'))
        hospitals=self.client.get('/api/facilities?facility_type=hospital').json['features']
        self.assertTrue(all(f['properties']['facility_type']=='hospital' for f in hospitals))
        self.assertEqual(self.client.get('/api/facilities?q=zzzz_no_match').json['features'],[])
        self.assertEqual(self.client.get('/api/facilities?facility_type=invalid').status_code,400)

    def test_02_csrf_and_admin_authorization(self):
        self.assertEqual(self.client.post('/api/incidents',json={}).status_code,403)
        self.assertEqual(self.post('/api/facilities',{}).status_code,401)
        self.assertEqual(self.client.get('/api/admin/stats').status_code,401)
        self.assertEqual(self.client.get('/api/incidents?admin=1').status_code,401)
        self.assertEqual(self.client.get('/api/incidents/1/photo').status_code,401)
        self.assertEqual(self.post('/api/login',{'username':'testadmin','password':'wrong'}).status_code,401)

    def test_03_location_and_validation(self):
        p={k:self.bpoint[k] for k in ('latitude','longitude')}
        result=self.post('/api/location',p);self.assertEqual(result.status_code,200)
        self.assertEqual(result.json['barangay']['name'],self.bpoint['name'])
        self.assertEqual(self.post('/api/location',{'latitude':0,'longitude':0}).status_code,422)
        self.assertEqual(self.post('/api/location',{'latitude':'NaN','longitude':125.5}).status_code,400)
        self.assertEqual(self.post('/api/location',{'latitude':True,'longitude':125.5}).status_code,400)
        self.assertEqual(self.post('/api/incidents',dict(self.point(),incident_type='fire',description='short')).status_code,400)

    def test_04_report_lifecycle_privacy(self):
        response=self.post('/api/incidents',dict(self.point(),incident_type='other',description='Automated integration test report; not a real incident.'))
        self.assertEqual(response.status_code,201);rid=response.json['id']
        self.assertNotIn(rid,[f['properties']['id'] for f in self.client.get('/api/incidents').json['features']])
        self.login()
        response=self.client.patch(f'/api/incidents/{rid}',json={'status':'verified'},headers={'X-CSRF-Token':self.csrf})
        self.assertEqual(response.status_code,200)
        self.assertIn(rid,[f['properties']['id'] for f in self.client.get('/api/incidents').json['features']])
        self.client.patch(f'/api/incidents/{rid}',json={'status':'resolved'},headers={'X-CSRF-Token':self.csrf})
        self.assertNotIn(rid,[f['properties']['id'] for f in self.client.get('/api/incidents').json['features']])

    def test_05_facility_crud(self):
        self.login();data=dict(self.point(),name='Integration fixture at an existing mapped location',facility_type='hospital',status='active',address='Test database only')
        r=self.post('/api/facilities',data);self.assertEqual(r.status_code,201);fid=r.json['id']
        data['name']='Updated integration fixture'
        r=self.client.patch(f'/api/facilities/{fid}',json=data,headers={'X-CSRF-Token':self.csrf});self.assertEqual(r.status_code,200)
        self.assertEqual(len(self.client.get('/api/facilities?q=Updated%20integration').json['features']),1)
        r=self.client.delete(f'/api/facilities/{fid}',headers={'X-CSRF-Token':self.csrf});self.assertEqual(r.status_code,200)
        self.assertEqual(len(self.client.get('/api/facilities?q=Updated%20integration').json['features']),0)

    @patch.dict(os.environ, {'GOOGLE_MAPS_API_KEY':'test-only-key'})
    @patch('google_services.compute_route')
    def test_06_analysis_math_and_status(self, route):
        def result(key, lon, lat, dest_lon, dest_lat):
            return (abs(dest_lon-lon)*100000+abs(dest_lat-lat)*100000, 120,
                    {'type':'LineString','coordinates':[[lon,lat],[dest_lon,dest_lat]]})
        route.side_effect=result
        data=dict(self.point(),facility_type='hospital',count=3,radius_km=3)
        nearest=self.post('/api/analysis/nearest',data)
        self.assertEqual(nearest.status_code,200)
        distances=[f['properties']['road_distance_m'] for f in nearest.json['features']]
        self.assertEqual(len(distances),3)
        self.assertEqual(distances,sorted(distances))
        self.assertTrue(all(f['properties']['status']=='active' for f in nearest.json['features']))
        self.assertTrue(all(f['geometry']['type']=='LineString' for f in nearest.json['features']))
        route.side_effect=None; route.return_value=None
        missing=self.post('/api/analysis/nearest',data)
        self.assertTrue(all(not f['properties']['road_route_available'] and f['geometry']['type']=='Point' for f in missing.json['features']))
        with patch.dict(os.environ, {'GOOGLE_MAPS_API_KEY':''}):
            self.assertEqual(self.post('/api/analysis/nearest',data).status_code,503)
        with psycopg.connect(self.url) as conn:
            conn.execute("UPDATE facilities SET status='inactive' WHERE facility_type='hospital'")
        try:
            route.reset_mock()
            inactive=self.post('/api/analysis/nearest',data)
            self.assertEqual(inactive.json['features'],[])
            route.assert_not_called()
        finally:
            with psycopg.connect(self.url) as conn:
                conn.execute("UPDATE facilities SET status='active' WHERE facility_type='hospital'")
        coverage=self.post('/api/analysis/coverage',data)
        self.assertEqual(coverage.status_code,200)
        self.assertGreater(len(coverage.json['features']),0)
        self.assertTrue(all(f['geometry']['type'] in ('Polygon','MultiPolygon') for f in coverage.json['features']))
        access=self.post('/api/analysis/accessibility',data)
        self.assertEqual(access.status_code,200)
        self.assertEqual(len(access.json['results']),self.client.get('/api/meta').json['boundary_count'])
        self.assertTrue(all(0<=r['covered_percent']<=100 for r in access.json['results']))
        self.assertEqual(self.post('/api/analysis/coverage',dict(data,radius_km=999)).status_code,400)

    def test_07_upload_and_photo_access(self):
        from PIL import Image
        stream=io.BytesIO();Image.new('RGB',(10,10),'white').save(stream,'PNG');stream.seek(0)
        data=dict(self.point(),incident_type='other',description='Photo test in isolated database only.',photo=(stream,'test.png'))
        r=self.client.post('/api/incidents',data=data,headers={'X-CSRF-Token':self.csrf},content_type='multipart/form-data')
        self.assertEqual(r.status_code,201);rid=r.json['id']
        self.assertEqual(self.client.get(f'/api/incidents/{rid}/photo').status_code,401)
        self.login();r=self.client.get(f'/api/incidents/{rid}/photo');self.assertEqual(r.status_code,200);self.assertEqual(r.mimetype,'image/jpeg')

    def test_08_rate_limit_and_logout(self):
        for _ in range(5):
            self.assertEqual(self.post('/api/incidents',dict(self.point(),incident_type='other',description='Rate limit test in isolated database only.')).status_code,201)
        self.assertEqual(self.post('/api/incidents',dict(self.point(),incident_type='other',description='Rate limit test in isolated database only.')).status_code,429)
        self.login();self.assertEqual(self.post('/api/logout').status_code,200)
        self.assertEqual(self.client.get('/api/admin/stats').status_code,401)

    def test_09_security_headers(self):
        r=self.client.get('/');self.assertEqual(r.status_code,200)
        self.assertEqual(r.headers['X-Frame-Options'],'DENY')
        self.assertIn("script-src 'self'",r.headers['Content-Security-Policy'])
        self.assertEqual(self.client.get('/api/facilities').headers['Cache-Control'],'no-store')

    def test_10_idempotent_import_and_source_alias(self):
        with psycopg.connect(self.url,row_factory=dict_row) as conn:
            before=conn.execute('SELECT count(*) AS n FROM facilities').fetchone()['n']
            run(conn)
            after=conn.execute('SELECT count(*) AS n FROM facilities').fetchone()['n']
            self.assertEqual(before,after)
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM facility_source_aliases').fetchone()['n'],1)

if __name__=='__main__':unittest.main()
