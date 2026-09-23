import base64
import json
import unittest
from contextlib import closing
import api
from camera_api import validate_image
import test_web_auth as web_auth

PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOYQAAAAASUVORK5CYII='


class CameraWorkflowTests(unittest.TestCase):
    setUp = web_auth.WebAuthenticationTests.setUp
    tearDown = web_auth.WebAuthenticationTests.tearDown
    login = web_auth.WebAuthenticationTests.login

    def product(self, **extra):
        data={"name":"Camera test product","category":"test","stock":40,"price":10,"cost":4,"unit":"قطعة","sale_unit":"قطعة","purchase_unit":"علبة","conversion_factor":20,**extra}
        result=json.loads(api.ShopAPI().add_product(json.dumps(data)))
        self.assertTrue(result['ok'],result)
        return result['data']

    def test_migration_is_repeatable(self):
        api.init_db();api.init_db()
        with closing(api._conn()) as con:
            for table in ('product_barcodes','serial_units','scan_drafts'):
                self.assertIsNotNone(con.execute("SELECT name FROM sqlite_master WHERE name=?",(table,)).fetchone())

    def test_alias_units_are_explicit_and_unique(self):
        self.login();mid=self.product(shop_barcode='SHOP-UNIT-TEST')
        response=self.client.post('/api/link_barcode',json={"barcode":"BOX-TEST","product_id":mid,"unit":"علبة","quantity":20})
        self.assertTrue(response.json['ok'],response.json)
        match=self.client.get('/api/scan_resolve?code=BOX-TEST').json['data']
        self.assertEqual((match['id'],match['scan_quantity']),(mid,20))
        self.assertEqual(self.client.get('/api/scan_resolve?code=SHOP-UNIT-TEST').json['data']['scan_quantity'],1)
        self.assertFalse(self.client.post('/api/link_barcode',json={"barcode":"SHOP-UNIT-TEST","product_id":mid,"unit":"قطعة","quantity":1}).json['ok'])
        self.assertFalse(json.loads(api.ShopAPI().add_product(json.dumps({"name":"duplicate","barcode":"BOX-TEST"})))['ok'])

    def test_cashier_cannot_link_barcodes_or_read_scan_drafts(self):
        self.login(username='cashier',password='123456')
        self.assertEqual(self.client.post('/api/link_barcode',json={}).status_code,403)
        self.assertEqual(self.client.get('/api/scan_draft/inventory').status_code,403)

    def test_draft_versions_isolate_users_and_do_not_mutate_stock(self):
        self.login();mid=self.product()
        saved=self.client.post('/api/scan_draft/inventory',json={"version":0,"items":[{"id":mid,"quantity":7}]}).json
        self.assertTrue(saved['ok'],saved)
        self.assertEqual(saved['data']['version'],1)
        self.assertEqual(self.client.post('/api/scan_draft/inventory',json={"version":0,"items":[]}).status_code,409)
        self.assertEqual(json.loads(api.ShopAPI().get_product(mid))['data']['stock'],40)
        self.login(username='supervisor',password='123456')
        self.assertEqual(self.client.get('/api/scan_draft/inventory').json['data']['items'],[])
        self.assertFalse(self.client.post('/api/scan_draft/inventory',json={"version":0,"items":[{"id":mid,"quantity":1.5}]}).json['ok'])

    def test_scanning_an_imei_resolves_the_device_and_serial(self):
        self.login()
        pid=self.product(name='Phone',track_serial=1,stock=0,unit='جهاز',sale_unit='جهاز',purchase_unit='جهاز',conversion_factor=1,warranty_months=12)
        added=json.loads(api.ShopAPI().add_serial_units(json.dumps({"product_id":pid,"serials":["353510009999991"],"cost":5})))
        self.assertTrue(added['ok'],added)
        match=self.client.get('/api/scan_resolve?code=353510009999991').json['data']
        self.assertEqual((match['id'],match['scan_serial'],match['scan_quantity']),(pid,'353510009999991',1))
        self.assertIsNone(self.client.get('/api/scan_resolve?code=000000000000000').json['data'])

    def test_images_reject_oversize_or_mismatched_content(self):
        self.assertEqual(validate_image(PNG),PNG)
        for bad in ('https://external/image.jpg','data:image/jpeg;base64,aGVsbG8=','x'*1400001):
            with self.assertRaises(ValueError):validate_image(bad)

    def test_receiving_uses_purchase_units_and_rejects_foreign_or_excess_items(self):
        mid=self.product();service=api.ShopAPI()
        with closing(api._conn()) as con:
            supplier=con.execute('SELECT id FROM suppliers LIMIT 1').fetchone()[0]
        created=json.loads(service.add_purchase(json.dumps({"supplier_id":supplier,"items":[{"product_id":mid,"product_name":"test","qty_ordered":2,"unit_cost":80}]})))
        self.assertTrue(created['ok'],created);pid=created['data']['id']
        with closing(api._conn()) as con:line=con.execute('SELECT id FROM purchase_items WHERE purchase_id=?',(pid,)).fetchone()[0]
        self.assertFalse(json.loads(service.receive_purchase(pid,json.dumps({"items":[{"item_id":line,"qty_received":3}]})))['ok'])
        for cost in (-1, float('nan'), float('inf')):
            self.assertFalse(json.loads(service.receive_purchase(pid,json.dumps({"items":[{"item_id":line,"qty_received":1,"unit_cost":cost}]})))['ok'])
        self.assertEqual(json.loads(service.get_product(mid))['data']['stock'],40)
        good=json.loads(service.receive_purchase(pid,json.dumps({"items":[{"item_id":line,"qty_received":1,"unit_cost":80}]})))
        self.assertTrue(good['ok'],good)
        self.assertEqual(json.loads(service.get_product(mid))['data']['stock'],60)
        free=json.loads(service.receive_purchase(pid,json.dumps({"items":[{"item_id":line,"qty_received":1,"unit_cost":0}]})))
        self.assertTrue(free['ok'],free)
        self.assertEqual(json.loads(service.get_product(mid))['data']['cost'],3)   # متوسط مرجّح: (60×4 + 20×0) ÷ 80


if __name__=='__main__':unittest.main()
