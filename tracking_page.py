# ══════════════════════════════════════════════════════════════
#  TRACKING_PAGE.PY — صفحة تتبع شحنة عامة للعميل (بدون تسجيل دخول)
#  العميل بيدخل بالباركود المطبوع على بوليصة الشحن ويشوف حالة شحنته.
#  ملاحظة أمنية: أي مسار خارج بادئة /api/ لا يمر بفحص الجلسة (راجع
#  server_auth.py)، فهذا المسار عام بتصميمه — لذلك نعرض أقل بيانات
#  كافية (الحالة والفواتير والمبلغ)، ولا نعرض أرقام هواتف أو تفاصيل
#  داخلية عن السائق/السيارة.
# ══════════════════════════════════════════════════════════════
from contextlib import closing
from flask import Response
import api

_STATUS_STYLE = {
    "قيد الانتظار": ("#64748b", "في انتظار خروج الرحلة للطريق"),
    "في الطريق":    ("#d97706", "الشحنة في الطريق إليك الآن"),
    "تم التسليم":   ("#0f766e", "تم تسليم الشحنة بنجاح"),
    "مرتجع":        ("#dc2626", "تم إرجاع الشحنة"),
    "مشكلة":        ("#dc2626", "هناك مشكلة في التسليم — سيتم التواصل معك"),
}

_PAGE_SHELL = """<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>تتبع الشحنة — {shop_name}</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: Tahoma, Arial, sans-serif; background:#f8fafc; margin:0; padding:2rem 1rem;
         display:flex; justify-content:center; color:#1e293b; }}
  .card {{ background:#fff; border-radius:16px; box-shadow:0 4px 24px rgba(0,0,0,.08); max-width:480px;
           width:100%; padding:2rem; }}
  h1 {{ font-size:1.15rem; margin:0 0 .3rem; color:#0f172a; }}
  .sub {{ color:#64748b; font-size:.85rem; margin-bottom:1.5rem; }}
  form {{ display:flex; gap:.5rem; margin-bottom:1rem; }}
  input[type=text] {{ flex:1; padding:.7rem .9rem; border:1px solid #cbd5e1; border-radius:10px; font-size:1rem; }}
  button {{ background:#0f766e; color:#fff; border:none; padding:.7rem 1.2rem; border-radius:10px;
            font-size:.95rem; cursor:pointer; }}
  .status-badge {{ display:inline-block; padding:.4rem 1rem; border-radius:999px; color:#fff; font-weight:700;
                    font-size:.95rem; margin-bottom:.6rem; }}
  .status-note {{ color:#475569; font-size:.9rem; margin-bottom:1.2rem; }}
  .row {{ display:flex; justify-content:space-between; padding:.55rem 0; border-bottom:1px solid #f1f5f9;
          font-size:.88rem; }}
  .row span:first-child {{ color:#64748b; }}
  .row span:last-child {{ font-weight:600; }}
  .amount {{ font-size:1.4rem; font-weight:800; color:#0f766e; text-align:center; margin:1rem 0; }}
  .error {{ text-align:center; color:#dc2626; padding:1.5rem 0; }}
  .footer {{ text-align:center; color:#94a3b8; font-size:.75rem; margin-top:1.5rem; }}
</style>
</head>
<body>
  <div class="card">
    <h1>{shop_name}</h1>
    <div class="sub">تتبع حالة شحنتك</div>
    <form method="get" action="/track">
      <input type="text" name="barcode" placeholder="أدخل رقم الباركود (مثال: SHP-XXXXXXXXXX)" value="{barcode_value}">
      <button type="submit">بحث</button>
    </form>
    {body}
    <div class="footer">{shop_name} — نظام إدارة المبيعات والتوصيل</div>
  </div>
</body>
</html>"""


def _render_stop(stop, invoices, shop_name):
    color, note = _STATUS_STYLE.get(stop["status"], ("#64748b", ""))
    invoices_html = "".join(
        f'<div class="row"><span>{inv["invoice_num"]}</span><span>{inv["total"]:.2f}</span></div>'
        for inv in invoices
    ) or '<div class="row"><span>لا توجد فواتير مرتبطة</span></div>'

    body = f"""
    <div style="text-align:center">
      <span class="status-badge" style="background:{color}">{stop["status"]}</span>
    </div>
    <div class="status-note" style="text-align:center">{note}</div>
    <div class="row"><span>رقم الشحنة</span><span>{stop["barcode"]}</span></div>
    <div class="row"><span>طريقة الدفع</span><span>{stop["payment_mode"]}</span></div>
    {invoices_html}
    <div class="amount">{stop["expected_amount"]:.2f}</div>
    """
    return _PAGE_SHELL.format(shop_name=shop_name, barcode_value=stop["barcode"], body=body)


def _render_not_found(shop_name, barcode_value):
    body = '<div class="error"><i>لم يتم العثور على شحنة بهذا الرقم.<br>تأكد من الرقم المطبوع على بوليصة الشحن.</i></div>'
    return _PAGE_SHELL.format(shop_name=shop_name, barcode_value=barcode_value or "", body=body)


def _render_empty(shop_name):
    body = '<div class="sub" style="text-align:center;margin-top:1rem">أدخل رقم الباركود المطبوع على بوليصة الشحن لمعرفة حالة طلبك.</div>'
    return _PAGE_SHELL.format(shop_name=shop_name, barcode_value="", body=body)


def register_routes(app):
    from flask import request

    @app.route("/track")
    def track_shipment():
        barcode = (request.args.get("barcode") or "").strip()
        with closing(api._conn()) as con:
            name_row = con.execute("SELECT value FROM settings WHERE key='shop_name'").fetchone()
            shop_name = (name_row[0] if name_row and name_row[0] else "تك ماركت")

            if not barcode:
                return Response(_render_empty(shop_name), mimetype="text/html")

            stop = con.execute("SELECT * FROM delivery_stops WHERE barcode=?", (barcode,)).fetchone()
            if not stop:
                return Response(_render_not_found(shop_name, barcode), mimetype="text/html", status=404)

            invoices = con.execute("""
                SELECT s.invoice_num, s.total FROM delivery_stop_sales dss
                JOIN sales s ON s.id = dss.sale_id WHERE dss.stop_id=?
            """, (stop["id"],)).fetchall()

        return Response(_render_stop(stop, invoices, shop_name), mimetype="text/html")
