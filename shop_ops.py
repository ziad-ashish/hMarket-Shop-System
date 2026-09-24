"""Operational safeguards: explicit units, serial/IMEI tracking helpers and durable POS drafts."""
import base64
import json
import math
import uuid
from contextlib import closing
from datetime import date, datetime

from flask import g, jsonify, request, Response
import api


def init_schema(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS pos_drafts (
        user_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, version INTEGER NOT NULL,
        payload TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sale_requests (
        user_id TEXT NOT NULL, request_id TEXT NOT NULL, response TEXT NOT NULL,
        PRIMARY KEY(user_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS backup_runs (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, local_path TEXT,
        secondary_path TEXT, secondary_error TEXT, user_id TEXT
    );
    CREATE TABLE IF NOT EXISTS backup_config (id INTEGER PRIMARY KEY CHECK(id=1), directory TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS barcode_unit_reviews (product_id TEXT PRIMARY KEY REFERENCES products(id));
    """)
    existing = {r[1] for r in con.execute('PRAGMA table_info(purchase_items)')}
    for column, definition in [('purchase_unit','TEXT'), ('sale_unit','TEXT'), ('conversion_factor','INTEGER')]:
        if column not in existing:
            con.execute(f'ALTER TABLE purchase_items ADD COLUMN {column} {definition}')


def light_columns(con, alias=''):
    """أعمدة المنتج بدون الصورة + حالة الصورة + الرصيد القابل للبيع.
    رصيد المنتجات ذات الأرقام التسلسلية (IMEI) يساوي دائمًا عدد الوحدات المتاحة."""
    prefix = alias + '.' if alias else ''
    names = [r[1] for r in con.execute('PRAGMA table_info(products)') if r[1] != 'image_data']
    return (','.join(prefix + '"' + name + '"' for name in names)
            + f",({prefix}image_data IS NOT NULL AND {prefix}image_data!='') AS has_image"
            + f",{prefix}stock AS sellable_stock")


def add_months(day, months):
    """تاريخ بعد عدد أشهر (يُثبَّت اليوم على آخر يوم في الشهر عند الحاجة)."""
    import calendar
    months = int(months or 0)
    idx = day.year * 12 + (day.month - 1) + months
    year, month = divmod(idx, 12)
    month += 1
    return day.replace(year=year, month=month, day=min(day.day, calendar.monthrange(year, month)[1]))


def clean_serials(values, label="الأرقام التسلسلية"):
    """تنظيف قائمة IMEI/Serial: إزالة الفراغات، منع الفارغ والمكرر داخل القائمة."""
    if isinstance(values, str):
        values = [v for v in values.replace(',', '\n').replace('،', '\n').splitlines()]
    result, seen = [], set()
    for value in values or []:
        code = str(value or '').strip().upper()
        if not code:
            continue
        if len(code) < 4 or len(code) > 40 or any(ch.isspace() for ch in code):
            raise ValueError(f"رقم تسلسلي غير صالح: {code}")
        if code in seen:
            raise ValueError(f"رقم مكرر في القائمة: {code}")
        seen.add(code)
        result.append(code)
    return result


def allocate_serials(con, sale_id, product, serials, sale_date, price_each, customer_id, customer_name):
    """يبيع الوحدات المحددة: كل رقم يجب أن يخص المنتج وأن يكون متاحًا. يرجع (التكلفة الكلية, نهاية الضمان)."""
    serials = clean_serials(serials)
    total_cost, warranty_end = 0.0, None
    months = int(product['warranty_months'] or 0)
    if months:
        warranty_end = add_months(date.fromisoformat(sale_date), months).isoformat()
    for code in serials:
        unit = con.execute("SELECT * FROM serial_units WHERE serial=? OR serial2=?", (code, code)).fetchone()
        if not unit or unit['product_id'] != product['id']:
            raise ValueError(f"الرقم {code} غير مسجل لهذا الصنف")
        if unit['status'] != 'متاح':
            raise ValueError(f"الرقم {code} غير متاح للبيع (الحالة: {unit['status']})")
        con.execute("""UPDATE serial_units SET status='مباع', sale_id=?, sold_date=?, sold_price=?,
            customer_id=?, customer_name=?, warranty_months=?, warranty_end=? WHERE id=?""",
            (sale_id, sale_date, price_each, customer_id, customer_name, months, warranty_end, unit['id']))
        total_cost += float(unit['cost'] or 0)
    return total_cost, warranty_end


def release_serials(con, sale_id):
    """يعيد وحدات فاتورة ملغاة/مرتجعة إلى المخزون المتاح."""
    con.execute("""UPDATE serial_units SET status='متاح', sale_id=NULL, sold_date=NULL, sold_price=NULL,
        customer_id=NULL, customer_name=NULL, warranty_end=NULL WHERE sale_id=?""", (sale_id,))


def permission(con, key):
    row = con.execute('SELECT role FROM users WHERE id=?', (g.user_id,)).fetchone()
    return row and api._has_perm(row['role'], key)


def register_routes(app):
    @app.get('/api/product_image/<mid>')
    def product_image(mid):
        with closing(api._conn()) as con:
            row = con.execute('SELECT image_data FROM products WHERE id=? AND is_active=1', (mid,)).fetchone()
        if not row or not row[0]:
            return '', 404
        from camera_api import validate_image
        try:
            value = validate_image(row[0])
            header, data = value.split(',', 1)
            return Response(base64.b64decode(data), mimetype=header[5:].split(';')[0], headers={'X-Content-Type-Options':'nosniff'})
        except ValueError:
            return '', 404

    @app.route('/api/barcode_units/<mid>', methods=['GET','POST'])
    def barcode_units(mid):
        with closing(api._conn()) as con:
            if not permission(con, 'products'):
                return jsonify(ok=False, error='تعديل وحدات الباركود يحتاج صلاحية إدارة الأصناف'), 403
            con.execute('BEGIN IMMEDIATE')
            product = con.execute('SELECT * FROM products WHERE id=? AND is_active=1', (mid,)).fetchone()
            if not product:
                return jsonify(ok=False, error='الصنف غير موجود'), 404
            codes = list(dict.fromkeys(c for c in (product['shop_barcode'], product['company_barcode'], product['barcode']) if c))
            codes = list(dict.fromkeys(codes + [r[0] for r in con.execute('SELECT barcode FROM product_barcodes WHERE product_id=?',(mid,))]))
            if request.method == 'POST':
                try:
                    entries = request.get_json().get('entries')
                    if not isinstance(entries, list) or len(entries) != len(codes):
                        raise ValueError('حدد وحدة كل باركود أساسي')
                    seen = set()
                    for entry in entries:
                        code, unit = entry.get('barcode'), str(entry.get('unit','')).strip()
                        quantity = float(entry.get('quantity',0))
                        if code not in codes or code in seen or not unit or len(unit)>40 or not math.isfinite(quantity) or not quantity.is_integer() or not 1<=quantity<=10000:
                            raise ValueError('وحدة الباركود أو عدد وحدات البيع غير صحيح')
                        seen.add(code)
                        duplicate = con.execute('SELECT product_id FROM product_barcodes WHERE barcode=?', (code,)).fetchone()
                        other = con.execute('SELECT id FROM products WHERE id!=? AND is_active=1 AND (barcode=? OR company_barcode=? OR shop_barcode=?)', (mid,code,code,code)).fetchone()
                        if other or (duplicate and duplicate[0]!=mid):
                            raise ValueError('الباركود مستخدم لصنف آخر؛ يجب حل التعارض أولًا')
                        con.execute('INSERT INTO product_barcodes VALUES(?,?,?,?,?) ON CONFLICT(barcode) DO UPDATE SET unit_name=excluded.unit_name,sale_quantity=excluded.sale_quantity',
                                    (code,mid,unit,int(quantity),datetime.now().isoformat()))
                    api._audit(con,g.user_id,'CONFIGURE_BARCODE_UNITS','product',mid,'تم تحديد وحدات الباركود؛ بدون تعديل المخزون')
                    con.execute('DELETE FROM barcode_unit_reviews WHERE product_id=?',(mid,))
                    con.commit()
                except (ValueError,TypeError,AttributeError) as exc:
                    con.rollback()
                    return jsonify(ok=False,error=str(exc)),400
            entries=[]
            for code in codes:
                saved=con.execute('SELECT unit_name,sale_quantity FROM product_barcodes WHERE barcode=? AND product_id=?',(code,mid)).fetchone()
                entries.append({'barcode':code,'unit':saved[0] if saved else product['sale_unit'], 'quantity':saved[1] if saved else None})
            return jsonify(ok=True,data={'entries':entries,'name':product['name'],'saleUnit':product['sale_unit'],'purchaseUnit':product['purchase_unit'],'factor':product['conversion_factor']})

    @app.route('/api/pos_draft', methods=['GET','POST'])
    def pos_draft():
        with closing(api._conn()) as con:
            if not permission(con,'sales'):
                return jsonify(ok=False,error='لا توجد صلاحية البيع'),403
            if request.method=='GET':
                row=con.execute('SELECT * FROM pos_drafts WHERE user_id=?',(g.user_id,)).fetchone()
                return jsonify(ok=True,data={'id':row['draft_id'],'version':row['version'],'payload':json.loads(row['payload']),'updatedAt':row['updated_at']} if row else None)
            try:
                d=request.get_json();payload=d.get('payload');draft_id=str(d.get('id',''))
                if d.get('owner',g.user_id)!=g.user_id:
                    raise ValueError('تغير الحساب؛ لم يتم حفظ مسودة مستخدم آخر')
                if not draft_id or len(draft_id)>80 or not isinstance(payload,dict):
                    raise ValueError('بيانات المسودة غير صحيحة')
                items=payload.get('cart',[])
                if not isinstance(items,list) or len(items)>500:
                    raise ValueError('عدد أصناف المسودة غير صحيح')
                seen=set()
                for item in items:
                    qty=float(item.get('qty',0));mid=item.get('productId')
                    if mid in seen or not math.isfinite(qty) or not 0<qty<=1000000:
                        raise ValueError('كميات المسودة غير صحيحة')
                    seen.add(mid)
                for item in items:
                    serials = item.get('serials')
                    if serials is not None and (not isinstance(serials, list) or len(serials) > 1000):
                        raise ValueError('الأرقام التسلسلية في المسودة غير صحيحة')
                raw=json.dumps(payload,ensure_ascii=False)
                if len(raw.encode('utf8'))>7500000:
                    raise ValueError('المسودة أكبر من الحد المسموح')
                con.execute('BEGIN IMMEDIATE')
                if con.execute('SELECT 1 FROM sale_requests WHERE user_id=? AND request_id=?',(g.user_id,draft_id)).fetchone():
                    raise ValueError('هذه المسودة صدرت لها فاتورة بالفعل. أعد تحميل نقطة البيع')
                old=con.execute('SELECT * FROM pos_drafts WHERE user_id=?',(g.user_id,)).fetchone()
                version=old['version'] if old else 0
                if d.get('version')!=version or (old and old['draft_id']!=draft_id):
                    return jsonify(ok=False,error='المسودة تغيرت في نافذة أخرى. أعد فتح نقطة البيع قبل المتابعة'),409
                con.execute('INSERT INTO pos_drafts VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload,version=excluded.version,updated_at=excluded.updated_at',
                            (g.user_id,draft_id,version+1,raw,datetime.now().isoformat()))
                # الحفظ التلقائي للمسودة يحدث كثيراً، لذلك لا يُسجل كسجل رقابي.
                # المسودة نفسها محفوظة في pos_drafts ويمكن استكمالها دون تضخيم audit_log.
                con.commit()
                return jsonify(ok=True,data={'id':draft_id,'version':version+1})
            except (ValueError,TypeError,AttributeError) as exc:
                con.rollback();return jsonify(ok=False,error=str(exc)),400
