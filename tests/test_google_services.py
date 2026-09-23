import unittest
from unittest.mock import patch, Mock
import requests
from google_services import compute_route, GoogleRoutesError
from app import create_app


class GoogleRoutesTests(unittest.TestCase):
    @patch('google_services.requests.post')
    def test_request_coordinates_mask_and_response(self, post):
        geometry={'type':'LineString','coordinates':[[125.5,8.9],[125.6,8.95]]}
        post.return_value=Mock(status_code=200)
        post.return_value.json.return_value={'routes':[{'distanceMeters':1400,'duration':'123.4s','polyline':{'geoJsonLinestring':geometry}}]}
        self.assertEqual(compute_route('test-server-key',125.5,8.9,125.6,8.95),(1400,123.4,geometry))
        kwargs=post.call_args.kwargs
        self.assertEqual(kwargs['json']['origin']['location']['latLng'],{'latitude':8.9,'longitude':125.5})
        self.assertEqual(kwargs['json']['destination']['location']['latLng'],{'latitude':8.95,'longitude':125.6})
        self.assertEqual(kwargs['json']['routingPreference'],'TRAFFIC_AWARE')
        self.assertEqual(kwargs['headers']['X-Goog-Api-Key'],'test-server-key')
        self.assertIn('routes.polyline.geoJsonLinestring',kwargs['headers']['X-Goog-FieldMask'])

    @patch('google_services.requests.post')
    def test_no_route_has_no_fabricated_line(self,post):
        post.return_value=Mock(status_code=200)
        post.return_value.json.return_value={}
        self.assertIsNone(compute_route('key',1,2,3,4))

    @patch('google_services.requests.post')
    def test_provider_failures_are_actionable_and_do_not_leak_keys(self,post):
        for status in (403,429):
            post.return_value=Mock(status_code=status)
            with self.assertRaises(GoogleRoutesError) as caught:
                compute_route('secret-test-key',1,2,3,4)
            self.assertEqual(caught.exception.status,503)
            self.assertNotIn('secret-test-key',str(caught.exception))
        post.side_effect=requests.Timeout('secret-test-key')
        with self.assertRaises(GoogleRoutesError) as caught:
            compute_route('secret-test-key',1,2,3,4)
        self.assertEqual(caught.exception.status,504)
        self.assertNotIn('secret-test-key',str(caught.exception))

    @patch('google_services.requests.post')
    def test_malformed_route_rejected(self,post):
        post.return_value=Mock(status_code=200)
        post.return_value.json.return_value={'routes':[{'distanceMeters':-1,'duration':'20s','polyline':{'geoJsonLinestring':{'type':'LineString','coordinates':[[1,2],[3,4]]}}}]}
        with self.assertRaises(GoogleRoutesError): compute_route('key',1,2,3,4)

    @patch.dict('os.environ',{'GOOGLE_MAPS_API_KEY':'shared-test-key'})
    def test_browser_configuration_and_csp(self):
        app=create_app({'TESTING':True,'SECRET_KEY':'test-only'})
        response=app.test_client().get('/')
        html=response.get_data(as_text=True)
        self.assertIn('shared-test-key',html)
        self.assertNotIn('/static/vendor/leaflet',html)
        self.assertNotIn('include-unverified',html)
        self.assertIn('https://*.googleapis.com',response.headers['Content-Security-Policy'])

if __name__=='__main__': unittest.main()
