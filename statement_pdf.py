# ══════════════════════════════════════════════════════════════
#  STATEMENT_PDF.PY — كشف حساب عميل (Statement of Account) بصيغة PDF
#  يعيد استخدام أدوات الرسم العربي المُتحقَّق منها في delivery_pdf.py
# ══════════════════════════════════════════════════════════════
import os
import json
import tempfile
from contextlib import closing

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

import api
from delivery_pdf import _draw_arabic, MM, _fetch_shop_name

ROW_H = 10 * MM
_HEADER_BG = (15, 117, 107)   # يطابق c.setFillColorRGB(0.06, 0.46, 0.42) بمقياس 0-255
_SHADE_BG = (247, 250, 250)   # يطابق c.setFillColorRGB(0.97, 0.98, 0.98)
_WHITE_BG = (255, 255, 255)


def _draw_header(c, page_w, page_h, shop_name, customer, date_from, date_to):
    right = page_w - 14 * MM
    y = page_h - 16 * MM
    _draw_arabic(c, shop_name, right, y, font_size=16, bold=True)
    y -= 8 * MM
    c.setStrokeColorRGB(0.6, 0.6, 0.6)
    c.line(14 * MM, y, page_w - 14 * MM, y)
    y -= 8 * MM
    _draw_arabic(c, "كشف حساب عميل", right, y, font_size=13, bold=True, color=(10, 90, 110))
    y -= 9 * MM
    label = customer["company_name"] or customer["name"]
    _draw_arabic(c, f"العميل:  {label}", right, y, font_size=11)
    y -= 6 * MM
    if customer["customer_type"] == "جملة":
        _draw_arabic(c, f"نوع العميل:  عميل جملة  —  سقف الائتمان: {customer['credit_limit']:.2f}", right, y, font_size=10)
        y -= 6 * MM
    period = f"{date_from or 'البداية'}  إلى  {date_to or 'اليوم'}"
    _draw_arabic(c, f"الفترة:  {period}", right, y, font_size=10, color=(90, 90, 90))
    y -= 12 * MM
    return y


def _draw_table_header(c, page_w, y):
    right = page_w - 14 * MM
    c.setFillColorRGB(0.06, 0.46, 0.42)
    c.rect(14 * MM, y - 6, page_w - 28 * MM, ROW_H, fill=1, stroke=0)
    c.setFillColorRGB(1, 1, 1)
    _draw_arabic(c, "رقم الفاتورة", right, y, font_size=9, bold=True, color=(255, 255, 255), bg=_HEADER_BG)
    _draw_arabic(c, "التاريخ", right - 45 * MM, y, font_size=9, bold=True, color=(255, 255, 255), bg=_HEADER_BG)
    _draw_arabic(c, "طريقة الدفع", right - 80 * MM, y, font_size=9, bold=True, color=(255, 255, 255), bg=_HEADER_BG)
    _draw_arabic(c, "المبلغ", right - 120 * MM, y, font_size=9, bold=True, color=(255, 255, 255), bg=_HEADER_BG)
    _draw_arabic(c, "الرصيد التراكمي", right - 150 * MM, y, font_size=9, bold=True, color=(255, 255, 255), bg=_HEADER_BG)
    return y - ROW_H


def generate_customer_statement_pdf(customer_id: str, date_from: str, date_to: str, output_path: str):
    with closing(api._conn()) as con:
        shop_name = _fetch_shop_name(con)
        data = json.loads(api.ShopAPI().get_customer_statement(customer_id, date_from, date_to))
    if not data.get("ok"):
        raise ValueError(data.get("error", "تعذر إنشاء كشف الحساب"))
    payload = data["data"]
    customer = payload["customer"]
    invoices = payload["invoices"]
    totals = payload["totals"]

    page_w, page_h = A4
    c = canvas.Canvas(output_path, pagesize=A4)
    y = _draw_header(c, page_w, page_h, shop_name, customer, date_from, date_to)
    y = _draw_table_header(c, page_w, y)

    right = page_w - 14 * MM
    row_i = 0
    for inv in invoices:
        if y < 30 * MM:
            c.showPage()
            y = page_h - 20 * MM
            y = _draw_table_header(c, page_w, y)
        row_bg = _WHITE_BG
        _draw_arabic(c, inv["invoice_num"], right, y, font_size=9, bg=row_bg)
        _draw_arabic(c, inv["sale_date"] or "—", right - 45 * MM, y, font_size=9, bg=row_bg)
        _draw_arabic(c, inv["payment_method"], right - 80 * MM, y, font_size=9, bg=row_bg)
        c.setFont("Helvetica", 9)
        c.setFillColorRGB(0.1, 0.1, 0.1)
        c.drawCentredString(right - 130 * MM, y - 3, f"{inv['total']:.2f}")
        c.setFillColorRGB(0.7, 0.1, 0.1) if inv["running_balance"] > 0 else c.setFillColorRGB(0.1, 0.5, 0.1)
        c.drawCentredString(right - 160 * MM, y - 3, f"{inv['running_balance']:.2f}")
        y -= ROW_H
        row_i += 1

    if not invoices:
        _draw_arabic(c, "لا توجد فواتير في هذه الفترة", right, y, font_size=10, color=(120, 120, 120))
        y -= ROW_H

    y -= 6 * MM
    c.setStrokeColorRGB(0.6, 0.6, 0.6)
    c.line(14 * MM, y, page_w - 14 * MM, y)
    y -= 9 * MM
    _draw_arabic(c, f"إجمالي الفواتير:  {totals['total_invoiced']:.2f}", right, y, font_size=11, bold=True)
    y -= 7 * MM
    _draw_arabic(c, f"إجمالي المسدد:  {totals['total_paid']:.2f}", right, y, font_size=11, bold=True, color=(15, 118, 110))
    y -= 7 * MM
    _draw_arabic(c, f"الرصيد المستحق:  {totals['total_outstanding']:.2f}", right, y, font_size=13, bold=True,
                 color=(180, 30, 30) if totals["total_outstanding"] > 0 else (15, 118, 110))

    c.save()
    return output_path


def register_routes(app):
    from flask import send_file, abort, request

    @app.route("/api/customer_statement_pdf/<customer_id>")
    def customer_statement_pdf(customer_id):
        try:
            date_from = request.args.get("date_from") or None
            date_to = request.args.get("date_to") or None
            fd, path = tempfile.mkstemp(suffix=".pdf")
            os.close(fd)
            generate_customer_statement_pdf(customer_id, date_from, date_to, path)
            return send_file(path, mimetype="application/pdf", as_attachment=False,
                              download_name=f"statement_{customer_id}.pdf")
        except Exception as e:
            abort(500, description=str(e))
