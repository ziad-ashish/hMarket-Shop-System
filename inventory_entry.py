"""Atomic supplier invoice entries and managed inventory categories."""
import json
import math
import secrets
from datetime import datetime, date
from flask import request, jsonify, g
import api
from camera_api import validate_image


def init_schema(con):
    con.executescript('''
    CREATE TABLE IF NOT EXISTS inventory_categories(name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS inventory_entry_requests(token TEXT PRIMARY KEY, response TEXT NOT NULL);
    ''')
    con.execute("INSERT OR IGNORE INTO inventory_categories SELECT DISTINCT category FROM products WHERE is_service=0 AND category IS NOT NULL AND category<>'خدمات'")


def number(value, minimum=0):
    value = float(value)
    if not math.isfinite(value) or value < minimum:
        raise ValueError('قيمة عددية غير صحيحة')
    return value


def register_routes(app):
    @app.post('/api/manage_inventory_category')
    def manage_inventory_category():
        con = api._conn()
        try:
            d = request.get_json() or {}
            name = str(d.get('name') or '').strip()
            if not name or len(name)>80 or name=='خدمات':
                raise ValueError('أدخل اسم تصنيف صالح؛ الخدمات تُدار من الصيانة')
            con.execute('BEGIN IMMEDIATE')
            if d.get('action')=='delete':
                target = str(d.get('replacement') or '').strip()
                count = con.execute('SELECT COUNT(*) FROM products WHERE category=?', (name,)).fetchone()[0]
                if count:
                    if target==name or not con.execute('SELECT 1 FROM inventory_categories WHERE name=?',(target,)).fetchone():
                        raise ValueError('اختر تصنيفاً آخر لنقل الأصناف إليه قبل الحذف')
                    con.execute('UPDATE products SET category=? WHERE category=?',(target,name))
                con.execute('DELETE FROM inventory_categories WHERE name=?',(name,))
            else:
                con.execute('INSERT OR IGNORE INTO inventory_categories VALUES(?)',(name,))
            api._audit(con,g.user_id,'CATEGORY','inventory',name,d.get('action','add'))
            con.commit()
            return jsonify(ok=True,data=True)
        except Exception as exc:
            con.rollback(); return jsonify(ok=False,error=str(exc)),400
        finally: con.close()

    @app.post('/api/inventory_invoice_line')
    def inventory_invoice_line():
        con = api._conn()
        try:
            d=request.get_json() or {}; token=str(d.get('token') or '')
            if not token or len(token)>100: raise ValueError('معرف الحفظ مطلوب')
            con.execute('BEGIN IMMEDIATE')
            previous=con.execute('SELECT response FROM inventory_entry_requests WHERE token=?',(token,)).fetchone()
            if previous: return jsonify(ok=True,data=json.loads(previous[0]))
            now=datetime.now().isoformat(); pid=d.get('invoice_id')
            if pid:
                po=con.execute("SELECT * FROM purchases WHERE id=? AND source='inventory_invoice'",(pid,)).fetchone()
                if not po: raise ValueError('الفاتورة غير موجودة')
            else:
                image=validate_image(d.get('image'))
                if not image: raise ValueError('أرفق صورة الفاتورة')
                supplier=con.execute('SELECT * FROM suppliers WHERE id=? AND is_active=1',(d.get('supplier_id'),)).fetchone()
                if not supplier: raise ValueError('اختر المورد')
                invoice_date=date.fromisoformat(d.get('invoice_date') or date.today().isoformat()).isoformat()
                pid=api._new_id('PO'); po_num='PO-'+str(datetime.now().year)+'-'+secrets.token_hex(5).upper()
                con.execute('INSERT INTO purchases(id,po_num,supplier_id,supplier_name,status,total_cost,created_by,created_at,received_at,invoice_date,supplier_invoice_num,invoice_image_data,source) VALUES(?,?,?,?,?,0,?,?,?,?,?,?,?)',
                    (pid,po_num,supplier['id'],supplier['name'],'مستلم',g.user_id,now,now,invoice_date,str(d.get('invoice_num') or '').strip(),image,'inventory_invoice'))
                con.execute('UPDATE suppliers SET total_orders=total_orders+1,last_order=? WHERE id=?',(invoice_date,supplier['id']))
            item=d.get('item') or {}; product_id=item.get('product_id')
            qty=number(item.get('quantity'),0.001); cost=number(item.get('cost')); price=number(item.get('price'))
            copies=number(item.get('copies',0),0)
            wholesale_raw=item.get('wholesale_price')
            wholesale_price=None if wholesale_raw in (None,'') else number(wholesale_raw)
            wholesale_min_qty=number(item.get('wholesale_min_qty',1),1)
            if not wholesale_min_qty.is_integer(): raise ValueError('أقل كمية للجملة يجب أن تكون عددًا صحيحًا')
            if not copies.is_integer() or copies>200: raise ValueError('عدد الملصقات من صفر إلى 200')
            if product_id:
                product=con.execute('SELECT * FROM products WHERE id=? AND is_active=1',(product_id,)).fetchone()
                if not product or product['is_service']: raise ValueError('اختر منتجاً مخزنياً')
                factor=float(product['conversion_factor'] or 1)
            else:
                name=str(item.get('name') or '').strip(); category=str(item.get('category') or '').strip()
                if not name or not con.execute('SELECT 1 FROM inventory_categories WHERE name=?',(category,)).fetchone():
                    raise ValueError('اسم المنتج وتصنيفه مطلوبان')
                unit=item.get('sale_unit') or 'قطعة'; purchase_unit=item.get('purchase_unit') or unit
                factor=number(item.get('factor',1),0.001)
                if unit not in ('متر','كيلو','لتر') and not factor.is_integer(): raise ValueError('معامل تحويل القطع يجب أن يكون صحيحاً')
                product_id=api._new_id('PR')
                con.execute('INSERT INTO products(id,name,category,price,cost,stock,unit,sale_unit,purchase_unit,conversion_factor,wholesale_price,wholesale_min_qty,supplier_id) VALUES(?,?,?,?,?,0,?,?,?,?,?,?,(SELECT supplier_id FROM purchases WHERE id=?))',
                    (product_id,name,category,price,cost/factor,unit,unit,purchase_unit,factor,wholesale_price,int(wholesale_min_qty),pid))
                product=con.execute('SELECT * FROM products WHERE id=?',(product_id,)).fetchone()
            if not qty.is_integer() and product['purchase_unit'] not in ('متر','كيلو','لتر'): raise ValueError('عدد العبوات يجب أن يكون صحيحاً')
            stock_qty=round(qty*factor,6)
            if product['track_serial']:
                from shop_ops import clean_serials
                serials=clean_serials(item.get('serials'))
                if len(serials)!=stock_qty: raise ValueError('أدخل رقم IMEI لكل جهاز')
                api._insert_serial_units(con,product,[{'serial':s} for s in serials],cost/factor,purchase_id=pid)
            else:
                con.execute('UPDATE products SET stock=ROUND(stock+?,6) WHERE id=?',(stock_qty,product_id))
            old=max(0,float(product['stock'] or 0))
            average=round((old*float(product['cost'] or 0)+qty*cost)/(old+stock_qty),6)
            barcode=product['shop_barcode'] or product['barcode']
            con.execute('UPDATE products SET cost=?,price=?,wholesale_price=?,wholesale_min_qty=? WHERE id=?',
                (average,price,wholesale_price,int(wholesale_min_qty),product_id))
            con.execute('INSERT INTO purchase_items(purchase_id,product_id,product_name,qty_ordered,qty_received,unit_cost,total_cost,purchase_unit,sale_unit,conversion_factor) VALUES(?,?,?,?,?,?,?,?,?,?)',
                (pid,product_id,product['name'],qty,qty,cost,qty*cost,product['purchase_unit'],product['sale_unit'],factor))
            con.execute('UPDATE purchases SET total_cost=total_cost+?,received_at=? WHERE id=?',(qty*cost,now,pid))
            api._audit(con,g.user_id,'RECEIVE','purchase',pid,f"{product['name']} +{stock_qty}")
            result=dict(invoice_id=pid,product_id=product_id,name=product['name'],barcode=barcode,copies=int(copies),stock_added=stock_qty,total=round(qty*cost,2))
            con.execute('INSERT INTO inventory_entry_requests VALUES(?,?)',(token,json.dumps(result)))
            con.commit(); return jsonify(ok=True,data=result)
        except Exception as exc:
            con.rollback(); return jsonify(ok=False,error=str(exc)),400
        finally: con.close()
