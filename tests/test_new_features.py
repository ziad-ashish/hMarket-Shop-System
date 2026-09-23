import json
import os
import tempfile
import unittest

import api


def _ok(raw):
    result = json.loads(raw)
    assert result["ok"], result
    return result["data"]


class ShopFeaturesTests(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.old_path = api.DB_PATH
        api.DB_PATH = self.path
        api.init_db()
        self.api = api.ShopAPI()

    def tearDown(self):
        api.DB_PATH = self.old_path
        if os.path.exists(self.path):
            os.unlink(self.path)

    def _product(self, **extra):
        data = {"name": "شاحن اختبار", "category": "اختبار", "price": 10, "cost": 5, "stock": 40,
                "unit": "قطعة", "sale_unit": "قطعة", "purchase_unit": "علبة", "conversion_factor": 20}
        data.update(extra)
        return _ok(self.api.add_product(json.dumps(data)))

    def _phone(self, serials=("353510000000001", "353510000000002"), warranty=12):
        pid = self._product(name="موبايل اختبار", track_serial=1, warranty_months=warranty, stock=0, unit="جهاز", sale_unit="جهاز",
                            purchase_unit="جهاز", conversion_factor=1, cost=100, price=150)
        _ok(self.api.add_serial_units(json.dumps({"product_id": pid, "serials": list(serials), "cost": 100})))
        return pid

    @staticmethod
    def _line(pid, qty=1, price=10, **extra):
        return dict({"productId": pid, "name": "x", "qty": qty, "price": price}, **extra)

    def test_serial_sale_requires_matching_imei_and_sets_warranty(self):
        pid = self._phone()
        self.assertEqual(_ok(self.api.get_product(pid))["stock"], 2)
        no_imei = json.loads(self.api.add_sale(json.dumps({"items": [self._line(pid, 1, 150)]})))
        self.assertFalse(no_imei["ok"])
        sale = _ok(self.api.add_sale(json.dumps({"customer_name": "عميل", "items": [self._line(pid, 1, 150, serials=["353510000000001"])]})))
        self.assertEqual(_ok(self.api.get_product(pid))["stock"], 1)
        info = _ok(self.api.lookup_serial("353510000000001"))
        self.assertEqual(info["unit"]["status"], "مباع")
        self.assertTrue(info["unit"]["warranty_active"])
        again = json.loads(self.api.add_sale(json.dumps({"items": [self._line(pid, 1, 150, serials=["353510000000001"])]})))
        self.assertFalse(again["ok"])
        self.assertTrue(_ok(self.api.search_warranty("353510000000001")))
        _ok(self.api.void_sale(sale["id"]))
        self.assertEqual(_ok(self.api.get_product(pid))["stock"], 2)
        self.assertEqual(_ok(self.api.lookup_serial("353510000000001"))["unit"]["status"], "متاح")

    def test_duplicate_serials_are_rejected_and_stock_follows_units(self):
        pid = self._phone()
        dup = json.loads(self.api.add_serial_units(json.dumps({"product_id": pid, "serials": ["353510000000002"]})))
        self.assertFalse(dup["ok"])
        unit = _ok(self.api.get_serial_units(pid, "متاح"))[0]
        _ok(self.api.update_serial_unit(unit["id"], json.dumps({"status": "تالف"})))
        self.assertEqual(_ok(self.api.get_product(pid))["stock"], 1)
        blocked = json.loads(self.api.update_product(pid, json.dumps({"stock": 99})))
        self.assertTrue(blocked["ok"])
        self.assertEqual(_ok(self.api.get_product(pid))["stock"], 1)   # الرصيد لا يُعدَّل يدويًا للأجهزة

    def test_service_items_do_not_touch_stock_and_labor_service_is_protected(self):
        service = self._product(name="خدمة", is_service=1, stock=0, unit="خدمة", sale_unit="خدمة", price=30)
        _ok(self.api.add_sale(json.dumps({"items": [self._line(service, 2, 30)]})))
        self.assertEqual(_ok(self.api.get_product(service))["stock"], 0)
        self.assertFalse(json.loads(self.api.delete_product("SRV-LABOR"))["ok"])

    def test_credit_sale_creates_debt_and_void_cancels_it(self):
        pid = self._product()
        con = api._conn()
        con.execute("INSERT INTO customers(id,name,phone) VALUES(?,?,?)", ("C1", "عميل", "1"))
        con.commit(); con.close()
        sale = _ok(self.api.add_sale(json.dumps({"customer_id": "C1", "customer_name": "عميل", "payment_method": "آجل",
                                                  "items": [self._line(pid, 1, 10)]})))
        self.assertEqual(len(_ok(self.api.get_debts())), 1)
        _ok(self.api.void_sale(sale["id"]))
        self.assertEqual(_ok(self.api.get_debts()), [])
        self.assertEqual(_ok(self.api.get_customer_debt("C1"))["balance"], 0)

    def test_repair_flow_invoices_parts_and_deducts_stock(self):
        part = self._product(name="شاشة", price=200, cost=120, stock=3)
        ticket = _ok(self.api.add_repair(json.dumps({"customer_name": "عميل", "phone": "0100", "issue": "شاشة مكسورة",
                                                     "device_model": "A15", "deposit": 50, "labor_cost": 100,
                                                     "parts": [{"product_id": part, "qty": 1}]})))
        early = json.loads(self.api.deliver_repair(ticket["id"], "{}"))
        self.assertFalse(early["ok"])                                   # لا تسليم قبل الجاهزية
        _ok(self.api.update_repair(ticket["id"], json.dumps({"status": "جاهز للتسليم", "parts": [{"product_id": part, "qty": 1}]})))
        done = _ok(self.api.deliver_repair(ticket["id"], json.dumps({"payment_method": "نقدي"})))
        self.assertEqual(done["total"], 300)
        self.assertEqual(done["remaining"], 250)
        self.assertEqual(_ok(self.api.get_product(part))["stock"], 2)
        self.assertEqual(_ok(self.api.get_repair(ticket["id"]))["status"], "تم التسليم")
        self.assertFalse(json.loads(self.api.update_repair(ticket["id"], json.dumps({"diagnosis": "x"})))["ok"])

    def test_warranty_repair_consumes_parts_without_invoice(self):
        part = self._product(name="بطارية", price=100, cost=60, stock=2)
        ticket = _ok(self.api.add_repair(json.dumps({"customer_name": "عميل", "issue": "بطارية", "in_warranty": True,
                                                     "parts": [{"product_id": part, "qty": 1}]})))
        _ok(self.api.update_repair(ticket["id"], json.dumps({"status": "جاهز للتسليم"})))
        done = _ok(self.api.deliver_repair(ticket["id"], "{}"))
        self.assertIsNone(done["sale_id"])
        self.assertEqual(_ok(self.api.get_product(part))["stock"], 1)

    def test_csv_import_reports_rejected_rows(self):
        csv_text = ("name,brand,model,category,barcode,price,cost,stock,unit,location,min_stock,warranty_months,track_serial\n"
                    "A,B,M,C,123,10,5,2,قطعة,A1,1,6,0\nB,B,M,C,123,10,5,2,قطعة,A1,1,6,0\n")
        result = _ok(self.api.import_products(csv_text))
        self.assertEqual(result["saved"], 1)
        self.assertEqual(result["rejected"], 1)

    def test_partial_product_update_preserves_barcode_and_unit_fields(self):
        pid = self._product()
        con = api._conn()
        con.execute("UPDATE products SET company_barcode='COMP',shop_barcode='SHOP' WHERE id=?", (pid,))
        con.commit(); con.close()
        _ok(self.api.update_product(pid, json.dumps({"name": "اسم معدل", "price": 12})))
        product = _ok(self.api.get_product(pid))
        self.assertEqual(product["company_barcode"], "COMP")
        self.assertEqual(product["shop_barcode"], "SHOP")
        self.assertEqual(product["conversion_factor"], 20)

    def test_sale_tax_is_taken_from_settings_and_zero_is_respected(self):
        pid = self._product()
        con = api._conn()
        con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('tax_rate','0')")
        con.commit(); con.close()
        result = _ok(self.api.add_sale(json.dumps({"items": [self._line(pid, 2, 10)], "tax": 999, "total": 1019})))
        stored = _ok(self.api.get_sale(result["id"]))
        self.assertEqual(stored["tax"], 0)
        self.assertEqual(stored["total"], 20)

    def test_purchase_receiving_requires_imei_for_devices_and_averages_cost(self):
        pid = self._phone(serials=("353510000000101",))
        po = _ok(self.api.add_purchase(json.dumps({"supplier_id": None, "items": [{"product_id": pid, "qty_ordered": 2, "unit_cost": 120}]})))
        item = _ok(self.api.get_purchase(po["id"]))["items"][0]
        bad = json.loads(self.api.receive_purchase(po["id"], json.dumps({"items": [{"item_id": item["id"], "qty_received": 2, "serials": ["353510000000201"]}]})))
        self.assertFalse(bad["ok"])
        good = json.loads(self.api.receive_purchase(po["id"], json.dumps({"items": [{"item_id": item["id"], "qty_received": 2, "unit_cost": 120, "serials": ["353510000000201", "353510000000202"]}]})))
        self.assertTrue(good["ok"], good)
        self.assertEqual(_ok(self.api.get_product(pid))["stock"], 3)


if __name__ == "__main__":
    unittest.main()
