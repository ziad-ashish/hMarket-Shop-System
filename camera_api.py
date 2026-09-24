"""Camera workflow data: barcode units, IMEI/serial resolving and private scan drafts."""
import base64
import json
import math
from contextlib import closing
from datetime import datetime
from flask import g, jsonify, request
import api


def init_schema(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS product_barcodes (
        barcode TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
        unit_name TEXT NOT NULL, sale_quantity INTEGER NOT NULL CHECK(sale_quantity>0), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scan_drafts (
        user_id TEXT NOT NULL, scope TEXT NOT NULL, data TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id,scope)
    );
    """)


def validate_image(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str) or len(value) > 1400000:
        raise ValueError("الصورة أكبر من الحد المسموح (حوالي 1 ميجابايت)")
    for mime, signature in (("jpeg", b"\xff\xd8\xff"), ("png", b"\x89PNG\r\n\x1a\n"), ("webp", b"RIFF")):
        prefix = f"data:image/{mime};base64,"
        if value.startswith(prefix):
            try:
                data = base64.b64decode(value[len(prefix):], validate=True)
            except Exception:
                raise ValueError("بيانات الصورة غير صالحة")
            if not data.startswith(signature) or (mime == "webp" and data[8:12] != b"WEBP"):
                raise ValueError("نوع الصورة لا يطابق محتواها")
            return value
    raise ValueError("الصور المسموحة: JPG وPNG وWebP فقط")


def resolve(con, code):
    row = con.execute(f"""SELECT {api.light_columns(con)} FROM products WHERE is_active=1 AND
        (shop_barcode=? OR company_barcode=? OR barcode=?)
        ORDER BY CASE WHEN shop_barcode=? THEN 1 WHEN company_barcode=? THEN 2 ELSE 3 END LIMIT 1""",
        (code, code, code, code, code)).fetchone()
    if row:
        result = dict(row)
        configured = con.execute('SELECT unit_name,sale_quantity FROM product_barcodes WHERE barcode=? AND product_id=?',(code,row['id'])).fetchone()
        needs_setup = bool(con.execute('SELECT 1 FROM barcode_unit_reviews WHERE product_id=?',(row['id'],)).fetchone()) or (not configured and int(row['conversion_factor'] or 1)>1)
        result.update(scan_quantity=configured['sale_quantity'] if configured else 1,
                      scan_unit=configured['unit_name'] if configured else row['sale_unit'] or row['unit'],
                      scan_requires_configuration=needs_setup, matched_barcode=code)
        return result
    row = con.execute(f"""SELECT {api.light_columns(con,'m')}, b.sale_quantity AS scan_quantity, b.unit_name AS scan_unit
        FROM product_barcodes b JOIN products m ON m.id=b.product_id
        WHERE b.barcode=? AND m.is_active=1""", (code,)).fetchone()
    if not row:
        # رقم IMEI / Serial لجهاز موجود بالمخزون: يرجع الصنف مع الرقم المحدد للبيع.
        unit = con.execute("""SELECT product_id, serial, status FROM serial_units WHERE serial=? OR serial2=?""", (code, code)).fetchone()
        if not unit: return None
        product = con.execute(f"SELECT {api.light_columns(con)} FROM products WHERE id=? AND is_active=1", (unit['product_id'],)).fetchone()
        if not product: return None
        result = dict(product)
        result.update(scan_quantity=1, scan_unit=product['sale_unit'] or product['unit'], scan_requires_configuration=False,
                      matched_barcode=code, scan_serial=unit['serial'], scan_serial_status=unit['status'])
        return result
    needs_setup=bool(con.execute('SELECT 1 FROM barcode_unit_reviews WHERE product_id=?',(row['id'],)).fetchone())
    return dict(row, matched_barcode=code, scan_requires_configuration=needs_setup)


def register_camera_routes(app):
    def permission(con, key):
        row = con.execute("SELECT role FROM users WHERE id=?", (g.user_id,)).fetchone()
        return row and api._has_perm(row["role"], key)

    @app.get("/api/scan_resolve")
    def scan_resolve():
        code = request.args.get("code", "").strip()
        if not code or len(code) > 120:
            return jsonify(ok=False, error="الباركود غير صالح"), 400
        with closing(api._conn()) as con:
            result = resolve(con, code)
            if result:
                result.pop("image_data", None)
            return jsonify(ok=True, data=result)

    @app.post("/api/link_barcode")
    def link_barcode():
        d = request.get_json()
        with closing(api._conn()) as con:
            if not permission(con, "products"):
                return jsonify(ok=False, error="ربط الباركود يحتاج صلاحية إدارة الأصناف"), 403
            try:
                if not isinstance(d, dict) or not isinstance(d.get("barcode"), str) or not isinstance(d.get("unit"), str):
                    raise ValueError("أرسل بيانات الباركود والوحدة بشكل صحيح")
                code, unit = str(d.get("barcode", "")).strip(), str(d.get("unit", "")).strip()
                quantity = float(d.get("quantity", 0))
                if not code or len(code)>120 or not unit or len(unit)>40 or not math.isfinite(quantity) or not quantity.is_integer() or not 1<=quantity<=10000:
                    raise ValueError("حدد باركودًا ووحدة وعددًا صحيحًا من وحدات البيع")
                con.execute("BEGIN IMMEDIATE")
                product=con.execute("SELECT * FROM products WHERE id=? AND is_active=1",(d.get("product_id"),)).fetchone()
                if not product:
                    raise ValueError("الصنف غير موجود")
                if resolve(con, code) or con.execute("SELECT 1 FROM product_barcodes WHERE barcode=?",(code,)).fetchone():
                    raise ValueError("هذا الباركود مرتبط بالفعل. لا يمكن استبدال ارتباطه تلقائيًا")
                con.execute("INSERT INTO product_barcodes VALUES(?,?,?,?,?)",(code,product["id"],unit,int(quantity),datetime.now().isoformat()))
                api._audit(con,g.user_id,"LINK_BARCODE","product",product["id"],f"{code}: {unit} = {int(quantity)} وحدة بيع")
                con.commit()
                return jsonify(ok=True,data=None)
            except (ValueError, TypeError) as e:
                con.rollback(); return jsonify(ok=False,error=str(e)),400

    @app.route("/api/scan_draft/<path:scope>", methods=["GET","POST"])
    def scan_draft(scope):
        if scope != "inventory" and not scope.startswith("receive-"):
            return jsonify(ok=False,error="نوع المسودة غير صالح"),400
        if len(scope)>100:
            return jsonify(ok=False,error="معرف المسودة غير صالح"),400
        with closing(api._conn()) as con:
            if not permission(con,"products"):
                return jsonify(ok=False,error="المسودات تحتاج صلاحية إدارة الأصناف"),403
            if request.method=="GET":
                row=con.execute("SELECT * FROM scan_drafts WHERE user_id=? AND scope=?",(g.user_id,scope)).fetchone()
                return jsonify(ok=True,data={"items":json.loads(row["data"]),"version":row["version"],"updatedAt":row["updated_at"]} if row else {"items":[],"version":0})
            try:
                d=request.get_json();items=d.get("items",[])
                if not isinstance(items,list) or len(items)>500:raise ValueError("المسودة لا تتجاوز 500 صنف")
                clean=[];seen=set()
                for item in items:
                    mid=item.get("id");qty=float(item.get("quantity",0))
                    if mid in seen or not math.isfinite(qty) or not qty.is_integer() or not 0<=qty<=1000000:raise ValueError("كميات المسودة غير صالحة")
                    product=con.execute("SELECT name,stock FROM products WHERE id=? AND is_active=1",(mid,)).fetchone()
                    if not product:raise ValueError("يوجد صنف غير موجود في المسودة")
                    seen.add(mid);clean.append({"id":mid,"name":product["name"],"quantity":int(qty),"expected":product["stock"]})
                con.execute("BEGIN IMMEDIATE")
                row=con.execute("SELECT version FROM scan_drafts WHERE user_id=? AND scope=?",(g.user_id,scope)).fetchone()
                version=row[0] if row else 0
                if d.get("version")!=version:
                    con.rollback();return jsonify(ok=False,error="المسودة تغيرت في نافذة أخرى. أغلقها وافتحها من جديد قبل المتابعة"),409
                con.execute("INSERT INTO scan_drafts VALUES(?,?,?,?,?) ON CONFLICT(user_id,scope) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at",(g.user_id,scope,json.dumps(clean,ensure_ascii=False),version+1,datetime.now().isoformat()))
                # مسودة العد تتحدث مع كل مسحة؛ ليست تغييراً مالياً أو مخزونياً
                # ولذلك لا تدخل سجل الرقابة حتى يظل مفيداً وخفيفاً.
                con.commit();return jsonify(ok=True,data={"items":clean,"version":version+1})
            except (ValueError,TypeError,AttributeError) as e:
                con.rollback();return jsonify(ok=False,error=str(e)),400
