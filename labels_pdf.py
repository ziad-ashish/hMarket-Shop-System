# ══════════════════════════════════════════════════════════════
#  LABELS_PDF.PY — توليد شيت ملصقات سعر/باركود للأصناف (A4، شبكة 3×8)
#  يعيد استخدام نفس أسلوب رسم النص العربي المُتحقَّق منه في delivery_pdf.py
#  (Pillow لرسم النص عربيًا بشكل صحيح، ثم تضمينه كصورة داخل reportlab).
# ══════════════════════════════════════════════════════════════
import os
import tempfile
from contextlib import closing

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.graphics.barcode import code128

import api
from delivery_pdf import _draw_arabic, _pil_to_reader, MM  # إعادة استخدام دوال الرسم المُختبرة

COLS, ROWS = 3, 8          # 24 ملصقًا لكل صفحة A4
MARGIN = 8 * MM
GUTTER = 2 * MM


def _label_size(page_w, page_h):
    label_w = (page_w - 2 * MARGIN - (COLS - 1) * GUTTER) / COLS
    label_h = (page_h - 2 * MARGIN - (ROWS - 1) * GUTTER) / ROWS
    return label_w, label_h


def _draw_one_label(c: canvas.Canvas, x: float, y: float, w: float, h: float, product: dict):
    """يرسم ملصقًا واحدًا (اسم الصنف + السعر + الباركود) داخل المربع المحدد."""
    c.setStrokeColorRGB(0.82, 0.82, 0.82)
    c.roundRect(x, y, w, h, 2 * MM, stroke=1, fill=0)

    pad = 2.5 * MM
    right = x + w - pad
    top = y + h - pad - 2

    _draw_arabic(c, product["name"], right, top, font_size=8.5, bold=True, max_width=w - 2 * pad)

    price_text = f"{product['price']:.2f}"
    c.setFont("Helvetica-Bold", 13)
    c.setFillColorRGB(0.05, 0.35, 0.32)
    c.drawCentredString(x + w / 2, y + h * 0.42, price_text)

    code = product.get("barcode") or product["id"]
    bar_h = h * 0.22
    bc = code128.Code128(str(code), barHeight=bar_h, barWidth=0.28 * MM)
    if bc.width > w - 2 * pad:
        # تقليل عرض الشرطة إذا كان الكود طويلًا حتى يظل داخل حدود الملصق
        bc = code128.Code128(str(code), barHeight=bar_h, barWidth=max(0.16, (w - 2 * pad) / bc.width * 0.28) * MM)
    bc_x = x + (w - bc.width) / 2
    bc.drawOn(c, bc_x, y + pad)


def generate_labels_pdf(product_ids: list, copies_per_item: int, output_path: str):
    with closing(api._conn()) as con:
        placeholders = ",".join("?" * len(product_ids))
        rows = con.execute(
            f"SELECT id, name, price, barcode FROM products WHERE id IN ({placeholders})", product_ids
        ).fetchall()
        products = [dict(r) for r in rows]

    if not products:
        raise ValueError("لم يتم العثور على أصناف صالحة لطباعة ملصقات لها")

    # تكرار كل صنف بعدد النسخ المطلوب
    all_labels = []
    for m in products:
        all_labels.extend([m] * max(1, copies_per_item))

    page_w, page_h = A4
    label_w, label_h = _label_size(page_w, page_h)
    c = canvas.Canvas(output_path, pagesize=A4)

    per_page = COLS * ROWS
    for page_start in range(0, len(all_labels), per_page):
        page_labels = all_labels[page_start:page_start + per_page]
        for idx, product in enumerate(page_labels):
            row = idx // COLS
            col = idx % COLS
            x = MARGIN + col * (label_w + GUTTER)
            y = page_h - MARGIN - (row + 1) * label_h - row * GUTTER
            _draw_one_label(c, x, y, label_w, label_h, product)
        c.showPage()
    c.save()
    return output_path


def register_routes(app):
    from flask import send_file, abort, request

    @app.route("/api/print_labels")
    def print_labels():
        try:
            product_ids_raw = request.args.get("product_ids", "")
            product_ids = [m for m in product_ids_raw.split(",") if m]
            copies = int(request.args.get("copies", 12))
            if not product_ids:
                abort(400, description="لم يتم تحديد أي صنف")
            fd, path = tempfile.mkstemp(suffix=".pdf")
            os.close(fd)
            generate_labels_pdf(product_ids, copies, path)
            return send_file(path, mimetype="application/pdf", as_attachment=False,
                              download_name="price_labels.pdf")
        except Exception as e:
            abort(500, description=str(e))
