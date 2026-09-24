"""Daily shop regressions. Never uses the shop's real database or backups."""
import json
import io
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import date, timedelta
import api
import backup_store
import test_web_auth as web_auth
from test_camera_api import PNG


class OperationsTests(unittest.TestCase):
    setUp = web_auth.WebAuthenticationTests.setUp
    tearDown = web_auth.WebAuthenticationTests.tearDown
    login = web_auth.WebAuthenticationTests.login

    def product(self, **extra):
        payload=dict(
            name='صنف اختبار',category='اختبار',price=10,cost=4,stock=40,unit='قطعة',
            purchase_unit='علبة',sale_unit='قطعة',conversion_factor=20)
        payload.update(extra)
        result=json.loads(api.ShopAPI().add_product(json.dumps(payload)))
        self.assertTrue(result['ok'],result)
        return result['data']

    def test_changed_units_require_review_without_deleting_barcode_mappings(self):
        self.login();mid=self.product(company_barcode='ORIGINAL')
        self.client.post('/api/barcode_units/'+mid,json={'entries':[{'barcode':'ORIGINAL','unit':'علبة','quantity':20}]})
        self.assertTrue(json.loads(api.ShopAPI().update_product(mid,json.dumps({'conversion_factor':10})))['ok'])
        self.assertTrue(self.client.get('/api/scan_resolve?code=ORIGINAL').json['data']['scan_requires_configuration'])
        with closing(api._conn()) as con:
            self.assertEqual(con.execute('SELECT sale_quantity FROM product_barcodes WHERE barcode=?',('ORIGINAL',)).fetchone()[0],20)

    def sale(self,mid,qty=1,**extra):
        return {'items':[{'productId':mid,'name':'صنف اختبار','qty':qty,'price':10,'total':10*qty}],**extra}

    def test_primary_barcode_requires_explicit_pack_size(self):
        self.login();mid=self.product(company_barcode='PACK20',shop_barcode='ONE')
        self.assertTrue(self.client.get('/api/scan_resolve?code=PACK20').json['data']['scan_requires_configuration'])
        result=self.client.post('/api/barcode_units/'+mid,json={'entries':[
            {'barcode':'PACK20','unit':'علبة','quantity':20},{'barcode':'ONE','unit':'قطعة','quantity':1}]}).json
        self.assertTrue(result['ok'],result)
        for code,quantity in [('PACK20',20),('ONE',1)]:
            result=self.client.get('/api/scan_resolve?code='+code).json['data']
            self.assertEqual(result['scan_quantity'],quantity)
            self.assertFalse(result['scan_requires_configuration'])
        result=json.loads(api.ShopAPI().update_product(mid,json.dumps({'name':'اسم معدل','company_barcode':'PACK20','shop_barcode':'ONE'})))
        self.assertTrue(result['ok'],result)

    def test_purchase_cost_and_conversion_are_snapshotted(self):
        mid=self.product();service=api.ShopAPI()
        result=json.loads(service.add_purchase(json.dumps({'supplier_id':'S001','items':[{'product_id':mid,'qty_ordered':2}]})))
        self.assertTrue(result['ok'],result);pid=result['data']['id']
        po=json.loads(service.get_purchase(pid))['data'];line=po['items'][0]
        self.assertEqual(line['unit_cost'],80);self.assertEqual(po['total_cost'],160)
        self.assertEqual(line['conversion_factor'],20)
        self.assertTrue(json.loads(service.update_product(mid,json.dumps({'conversion_factor':10})))['ok'])
        api.init_db()  # migrations must not rewrite the snapshot of an existing order
        received={'items':[{'item_id':line['id'],'qty_received':1,'unit_cost':80}]}
        self.assertTrue(json.loads(service.receive_purchase(pid,json.dumps(received)))['ok'])
        product=json.loads(service.get_product(mid))['data'];self.assertEqual(product['stock'],60);self.assertEqual(product['cost'],4)

    def test_captured_invoice_is_saved_before_stock_is_added(self):
        self.login();mid=self.product(stock=5)
        created=self.client.post('/api/add_captured_purchase',json={
            'supplier_id':'S001','supplier_invoice_num':'SUP-42','invoice_date':'2026-09-23',
            'invoice_image_data':PNG,'notes':'فاتورة مصورة للاختبار',
            'items':[{'product_id':mid,'qty_ordered':2,'unit_cost':100}],
        }).json
        self.assertTrue(created['ok'],created);pid=created['data']['id']
        self.assertEqual(json.loads(api.ShopAPI().get_product(mid))['data']['stock'],5)
        listed=next(p for p in self.client.get('/api/get_purchases').json['data'] if p['id']==pid)
        self.assertEqual(listed['status'],'فاتورة مستلمة');self.assertTrue(listed['has_invoice_image'])
        self.assertNotIn('invoice_image_data',listed)
        self.assertEqual(self.client.get('/api/purchase_invoice_image/'+pid).json['data'],PNG)
        line=listed['items'][0]
        received=self.client.post('/api/receive_purchase/'+pid,json={
            'items':[{'item_id':line['id'],'qty_received':2,'unit_cost':100}],
        }).json
        self.assertTrue(received['ok'],received);self.assertEqual(received['data']['status'],'مستلم')
        self.assertEqual(json.loads(api.ShopAPI().get_product(mid))['data']['stock'],45)

    def test_credit_sale_requires_name_and_records_first_payment(self):
        mid=self.product();service=api.ShopAPI()
        missing=json.loads(service.add_sale(json.dumps(self.sale(mid,payment_method='آجل',credit_paid_amount=2))))
        self.assertFalse(missing['ok'],missing)
        result=json.loads(service.add_sale(json.dumps(self.sale(
            mid,payment_method='آجل',credit_customer_name='عميل آجل',
            credit_phone='01012345678',credit_paid_amount=4))))
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['data']['creditPaid'],4)
        self.assertEqual(result['data']['creditRemaining'],6)
        with closing(api._conn()) as con:
            customer=con.execute('SELECT name,phone FROM customers WHERE id=?',(result['data']['customerId'],)).fetchone()
            debt=con.execute('SELECT amount,paid_amount,status FROM debts WHERE sale_id=?',(result['data']['id'],)).fetchone()
            self.assertEqual((customer['name'],customer['phone']),('عميل آجل','01012345678'))
            self.assertEqual((debt['amount'],debt['paid_amount'],debt['status']),(10,4,'مسدد جزئياً'))
        rejected=json.loads(service.add_sale(json.dumps(self.sale(
            mid,payment_method='آجل',credit_customer_name='عميل آخر',credit_paid_amount=11))))
        self.assertFalse(rejected['ok'],rejected)
        self.assertEqual(json.loads(service.get_product(mid))['data']['stock'],39)

    def test_pos_can_quick_add_and_reuse_customer_by_name(self):
        self.login(username='cashier',password='123456')
        first=self.client.post('/api/add_customer',json={'name':'عميل نقطة البيع','phone':'','quick_pos':1}).json
        self.assertTrue(first['ok'],first)
        second=self.client.post('/api/add_customer',json={'name':'  عميل نقطة البيع  ','phone':'','quick_pos':1}).json
        self.assertTrue(second['ok'],second)
        self.assertEqual(first['data'],second['data'])
        customer=self.client.get('/api/get_customer/'+first['data']).json['data']
        self.assertEqual(customer['name'],'عميل نقطة البيع')
        self.assertEqual(customer['phone'],'')

    def test_card_sale_stores_payment_proof_outside_invoice_lists(self):
        mid=self.product()
        result=json.loads(api.ShopAPI().add_sale(json.dumps(self.sale(
            mid,payment_method='بطاقة',payment_proof_image=PNG))))
        self.assertTrue(result['ok'],result)
        sale_id=result['data']['id']
        listed=json.loads(api.ShopAPI().get_sales())['data']['sales']
        sale=next(row for row in listed if row['id']==sale_id)
        self.assertTrue(sale['has_payment_proof'])
        self.assertNotIn('payment_proof_image',sale)
        detail=json.loads(api.ShopAPI().get_sale(sale_id))['data']
        self.assertTrue(detail['has_payment_proof'])
        proof=json.loads(api.ShopAPI().get_sale_payment_proof(sale_id))['data']
        self.assertEqual(proof,PNG)

    def test_inventory_entry_saves_wholesale_price_without_forcing_barcode(self):
        self.login()
        with closing(api._conn()) as con:
            con.execute("INSERT OR IGNORE INTO inventory_categories(name) VALUES('اختبار')")
            con.commit(); category='اختبار'
        response=self.client.post('/api/inventory_invoice_line',json={
            'token':'wholesale-entry-test','image':PNG,'supplier_id':'S001','invoice_num':'INV-WHOLESALE',
            'invoice_date':'2026-09-24','item':{
                'name':'صنف جديد بدون باركود','category':category,'purchase_unit':'قطعة','sale_unit':'قطعة',
                'factor':1,'quantity':2,'cost':80,'price':60,'wholesale_price':50,'wholesale_min_qty':3,'copies':0,
            },
        }).json
        self.assertTrue(response['ok'],response)
        product=json.loads(api.ShopAPI().get_product(response['data']['product_id']))['data']
        self.assertIsNone(product['barcode'])
        self.assertIsNone(product['shop_barcode'])
        self.assertEqual((product['price'],product['wholesale_price'],product['wholesale_min_qty']),(60,50,3))

    def test_void_restores_stock_and_cannot_repeat(self):
        mid=self.product();service=api.ShopAPI()
        rejected=json.loads(service.add_sale(json.dumps(self.sale(mid,50))))
        self.assertFalse(rejected['ok'],rejected)
        result=json.loads(service.add_sale(json.dumps(self.sale(mid,25))))
        self.assertTrue(result['ok'],result)
        self.assertEqual(json.loads(service.get_product(mid))['data']['stock'],15)
        self.assertTrue(json.loads(service.void_sale(result['data']['id']))['ok'])
        self.assertEqual(json.loads(service.get_product(mid))['data']['stock'],40)
        self.assertFalse(json.loads(service.void_sale(result['data']['id']))['ok'])

    def test_draft_restores_account_data_and_checkout_is_idempotent(self):
        self.login();mid=self.product()
        payload={'cart':[{'productId':mid,'qty':1,'price':10,'total':10,'serials':[]}], 'discount':0}
        saved=self.client.post('/api/pos_draft',json={'id':'draft-test','version':0,'payload':payload}).json
        self.assertTrue(saved['ok'],saved)
        with closing(api._conn()) as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM audit_log WHERE action='SAVE_POS_DRAFT'").fetchone()[0],0)
        self.client.post('/api/logout',json={});self.login()
        restored=self.client.get('/api/pos_draft').json['data']
        self.assertEqual(restored['payload'],payload)
        self.assertEqual(self.client.post('/api/pos_draft',json={'id':'draft-test','version':0,'payload':payload}).status_code,409)
        sale=self.sale(mid,draft_id=restored['id'],draft_version=restored['version'])
        first=self.client.post('/api/add_sale',json=sale).json
        second=self.client.post('/api/add_sale',json=sale).json
        self.assertTrue(first['ok'],first);self.assertEqual(first,second)
        self.assertIsNone(self.client.get('/api/pos_draft').json['data'])
        self.assertEqual(json.loads(api.ShopAPI().get_product(mid))['data']['stock'],39)
        self.assertFalse(self.client.post('/api/pos_draft',json={'id':'draft-test','version':0,'payload':payload}).json['ok'])

    def test_drafts_and_unit_permissions_are_isolated(self):
        self.login();mid=self.product()
        self.client.post('/api/pos_draft',json={'id':'admin-draft','version':0,'payload':{'cart':[]}})
        self.login(username='cashier',password='123456')
        self.assertIsNone(self.client.get('/api/pos_draft').json['data'])
        self.assertEqual(self.client.get('/api/barcode_units/'+mid).status_code,403)
        self.assertFalse(self.client.post('/api/pos_draft',json={'owner':'another-user','id':'wrong','version':0,'payload':{'cart':[]}}).json['ok'])
        self.assertEqual(self.client.get('/api/secondary_backup').status_code,403)

    def test_lists_omit_image_data_and_edits_preserve_photo(self):
        self.login();mid=self.product(image_data=PNG)
        for endpoint in ('get_products','get_top_selling_products/50','search_products?q=اختبار'):
            products=self.client.get('/api/'+endpoint).json['data']
            if isinstance(products,dict): products=products.get('products',[])
            row=next(m for m in products if m['id']==mid)
            self.assertNotIn('image_data',row);self.assertTrue(row['has_image'])
        self.assertTrue(json.loads(api.ShopAPI().update_product(mid,json.dumps({'name':'تعديل بلا صورة'})))['ok'])
        self.assertEqual(self.client.get('/api/product_image/'+mid).status_code,200)
        self.client.post('/api/logout',json={})
        self.assertEqual(self.client.get('/api/product_image/'+mid).status_code,401)

    def test_health_check_reports_real_scope_and_unverified_devices(self):
        self.login()
        result=self.client.get('/api/get_health_check').json
        self.assertTrue(result['ok'],result)
        data=result['data'];diagnostics={row['key']:row for row in data['diagnostics']}
        self.assertEqual(data['scope'],'internal_data_and_backup')
        self.assertFalse(data['external_verified'])
        self.assertIn(data['overall'],('warning','incomplete'))
        self.assertEqual(diagnostics['sqlite']['status'],'ok')
        self.assertEqual(diagnostics['foreign_keys']['status'],'ok')
        self.assertEqual(diagnostics['external_devices']['status'],'not_tested')
        self.assertFalse(diagnostics['external_devices']['checked'])

    def test_secondary_backup_is_verified_and_failure_keeps_local_copy(self):
        self.login();self.product()
        previous=api.BACKUP_DIR
        with tempfile.TemporaryDirectory() as extra:
            try:
                api.BACKUP_DIR=os.path.join(self.tmp.name,'backups')
                response=self.client.post('/api/secondary_backup',json={'directory':extra})
                self.assertTrue(response.json['ok'],response.json)
                result=backup_store.run_backup()
                self.assertTrue(os.path.isfile(result['secondary_path']))
                self.assertEqual(backup_store.status()['state'],'ok')
                with closing(sqlite3.connect(result['secondary_path'])) as con:
                    self.assertEqual(con.execute('PRAGMA quick_check').fetchone()[0],'ok')
                with closing(api._conn()) as con:
                    con.execute('UPDATE backup_config SET directory=?',(os.path.join(extra,'disconnected'),));con.commit()
                failed=backup_store.run_backup()
                self.assertTrue(failed['secondary_error']);self.assertTrue(os.path.isfile(failed['path']))
                self.assertEqual(backup_store.status()['state'],'failed')
            finally: api.BACKUP_DIR=previous

    def test_backup_retention_keeps_five_managed_files_only(self):
        self.login();self.product()
        previous=api.BACKUP_DIR
        with tempfile.TemporaryDirectory() as extra:
            try:
                api.BACKUP_DIR=os.path.join(self.tmp.name,'backups')
                self.assertTrue(self.client.post('/api/secondary_backup',json={'directory':extra}).json['ok'])
                unrelated=os.path.join(extra,'my_database.db')
                with open(unrelated,'wb') as handle: handle.write(b'keep me')
                with open(os.path.join(extra,'auto_shop_old.db'),'wb') as handle: handle.write(b'old managed backup')
                for _ in range(7): backup_store.run_backup()
                local=[name for name in os.listdir(api.BACKUP_DIR) if name.startswith('shop_')]
                secondary=[name for name in os.listdir(extra) if name.startswith(('shop_','auto_shop_'))]
                self.assertEqual(len(local),5)
                self.assertEqual(len(secondary),5)
                self.assertTrue(os.path.isfile(unrelated))
            finally: api.BACKUP_DIR=previous

    def test_restore_rejects_outside_or_invalid_files_and_restores_verified_snapshot(self):
        self.login()
        snapshot = backup_store.run_backup('system-test')
        outside = os.path.join(self.tmp.name, 'outside.db')
        with closing(sqlite3.connect(outside)) as con:
            con.execute('CREATE TABLE fake(value TEXT)')
        denied = self.client.post('/api/restore_database', json={'backup_path': outside}).json
        self.assertFalse(denied['ok'], denied)

        invalid = os.path.join(api.BACKUP_DIR, 'shop_backup_invalid.db')
        with closing(sqlite3.connect(invalid)) as con:
            con.execute('CREATE TABLE fake(value TEXT)')
        rejected = self.client.post('/api/restore_database', json={'backup_path': invalid}).json
        self.assertFalse(rejected['ok'], rejected)

        created = self.product(name='صنف بعد النسخة')
        restored = self.client.post('/api/restore_database', json={'backup_path': snapshot['path']}).json
        self.assertTrue(restored['ok'], restored)
        self.assertIsNone(json.loads(api.ShopAPI().get_product(created))['data'])
        self.assertTrue(os.path.isfile(restored['data']['pre_backup']))
        with closing(sqlite3.connect(restored['data']['pre_backup'])) as con:
            self.assertEqual(con.execute('PRAGMA quick_check').fetchone()[0], 'ok')

    def test_external_backup_import_is_verified_before_restore_list(self):
        self.login()
        snapshot=backup_store.run_backup('import-test')
        with open(snapshot['path'],'rb') as source:
            uploaded=self.client.post('/api/import_backup',data={'file':(io.BytesIO(source.read()),'old-project.db')},content_type='multipart/form-data').json
        self.assertTrue(uploaded['ok'],uploaded)
        self.assertTrue(uploaded['data']['filename'].startswith('imported_'))
        listed=self.client.get('/api/list_backups').json['data']
        self.assertTrue(any(row['filename']==uploaded['data']['filename'] for row in listed))
        bad=self.client.post('/api/import_backup',data={'file':(io.BytesIO(b'not sqlite'),'broken.db')},content_type='multipart/form-data').json
        self.assertFalse(bad['ok'],bad)


if __name__=='__main__':unittest.main()
