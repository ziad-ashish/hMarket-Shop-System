# ══════════════════════════════════════════════════════════════
#  DELIVERY_PDF.PY — توليد بوليصة شحن PDF بالباركود لكل توقف
#
#  ملاحظات فنية مهمة:
#  • reportlab لا يدعم تشكيل الحروف العربية (ligatures) ولا اتجاه RTL
#    تلقائيًا، فبنرسم كل سطر عربي كصورة عبر Pillow (اللي بيستخدم raqm
#    داخليًا لدعم التشكيل والاتجاه الصحيح) ثم نُدرجها كصورة داخل الـ PDF.
#  • الباركود (Code128) مدمج في reportlab نفسه (reportlab.graphics.barcode)
#    فمفيش داعي لمكتبة خارجية زيادة.
#  • الخط: بما إن التطبيق يعمل على ويندوز فقط (run.bat / pywebview)،
#    بنستخدم خط النظام (Tahoma ثم Arial) اللي بيدعم العربي بشكل كامل
#    فوق كل نسخ ويندوز، من غير ما نحتاج نوزّع ملف خط خاص بينا.
# ══════════════════════════════════════════════════════════════
import os
import io
import socket
import tempfile
from contextlib import closing

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A5, A4
from reportlab.pdfgen import canvas
from reportlab.graphics.barcode import code128
from reportlab.graphics.barcode import qr
from reportlab.graphics.shapes import Drawing
from reportlab.graphics import renderPDF

import api

MM = 72.0 / 25.4  # نقطة لكل مليمتر (لتسهيل القياسات)

_FONT_CANDIDATES = [
    r"C:\Windows\Fonts\tahoma.ttf",
    r"C:\Windows\Fonts\tahomabd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSerif.ttf",   # احتياطي لبيئات غير ويندوز (تطوير فقط)
    "/usr/share/fonts/truetype/freefont/FreeMono.ttf",
]


def _find_font(bold: bool = False) -> str | None:
    candidates = _FONT_CANDIDATES
    if bold:
        candidates = [r"C:\Windows\Fonts\tahomabd.ttf", r"C:\Windows\Fonts\arialbd.ttf",
                      "/usr/share/fonts/truetype/freefont/FreeSerifBold.ttf"] + _FONT_CANDIDATES
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def _arabic_image(text: str, font_size: int = 22, bold: bool = False, color=(20, 20, 20), bg=(255, 255, 255)):
    """يرسم نصًا عربيًا (أو مختلطًا مع أرقام/لاتيني) كصورة PNG بخلفية معتمة
    (غير شفافة) تطابق لون الخلفية في مكان الرسم، بالاتجاه والتشكيل الصحيحين.
    ملاحظة مهمة: نتعمّد عدم استخدام قناة شفافية (alpha) هنا — الصور الشفافة
    الصغيرة المرسومة بجانب مستطيلات ملوّنة (drawImage مع mask="auto") تسبب
    قصًّا بصريًا خاطئًا في بعض محركات عرض PDF (poppler) بسبب تعارض SMask؛
    استخدام خلفية معتمة مطابقة يتجنّب المشكلة تمامًا."""
    if not text:
        text = ""
    font_path = _find_font(bold)
    try:
        font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default()
    except Exception:
        font = ImageFont.load_default()

    tmp = Image.new("RGB", (10, 10), bg)
    d = ImageDraw.Draw(tmp)
    try:
        bbox = d.textbbox((0, 0), text, font=font, direction="rtl")
    except Exception:
        bbox = d.textbbox((0, 0), text, font=font)
    w = max(1, bbox[2] - bbox[0] + 8)
    h = max(1, bbox[3] - bbox[1] + 8)

    img = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(img)
    try:
        d.text((w - 4, 4), text, font=font, fill=color, direction="rtl", anchor="ra")
    except Exception:
        d.text((4, 4), text, font=font, fill=color)
    return img


def _draw_arabic(c: canvas.Canvas, text: str, right_x: float, y: float, font_size: int = 11,
                  bold: bool = False, color=(20, 20, 20), max_width: float = None, bg=(255, 255, 255)):
    """يرسم سطر عربي على الـ canvas محاذى لليمين عند الإحداثي right_x.
    الرسم يتم عبر صورة PNG (Pillow مع raqm) لضمان تشكيل واتجاه صحيحين،
    ثم تحجيمها لتطابق ارتفاع الخط المطلوب بالنقاط (points) بدقة. الصورة
    معتمة (bg) عمدًا — راجع التعليق في _arabic_image لسبب تجنّب الشفافية."""
    render_px = font_size * 8  # دقة رسم أعلى من الحجم النهائي لضمان وضوح بعد التصغير
    img = _arabic_image(text, font_size=render_px, bold=bold, color=color, bg=bg)
    target_h = font_size * 1.15  # نقطة PDF — يقارب ارتفاع السطر البصري المعتاد لنفس font_size
    scale = target_h / img.height
    draw_w = img.width * scale
    draw_h = img.height * scale
    if max_width and draw_w > max_width:
        ratio = max_width / draw_w
        draw_w *= ratio
        draw_h *= ratio
    c.saveState()
    c.drawImage(_pil_to_reader(img), right_x - draw_w, y - draw_h * 0.78, width=draw_w, height=draw_h)
    c.restoreState()
    return draw_h


def _pil_to_reader(img: Image.Image):
    from reportlab.lib.utils import ImageReader
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return ImageReader(buf)


def _local_lan_ip() -> str:
    """نفس منطق main.py لتحديد عنوان الجهاز على الشبكة المحلية، بدون استيراد
    main.py نفسها (تجنبًا لاستيراد pywebview هنا بلا داعٍ)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def _tracking_url_for(con, barcode: str):
    """رابط تتبع الشحنة إذا كانت صفحة التتبع العامة مفعّلة من الإعدادات، وإلا None."""
    row = con.execute("SELECT value FROM settings WHERE key='public_tracking_enabled'").fetchone()
    if not (row and row[0] == "1"):
        return None
    port_row = con.execute("SELECT value FROM settings WHERE key='public_tracking_port'").fetchone()
    port = port_row[0] if port_row and port_row[0] else "8765"
    return f"http://{_local_lan_ip()}:{port}/track?barcode={barcode}"


def _fetch_shop_name(con) -> str:
    row = con.execute("SELECT value FROM settings WHERE key='shop_name'").fetchone()
    return (row[0] if row and row[0] else "تك ماركت")


def _fetch_stop_full(con, stop_id: str):
    stop = con.execute("SELECT * FROM delivery_stops WHERE id=?", (stop_id,)).fetchone()
    if not stop:
        return None
    trip = con.execute("SELECT * FROM delivery_trips WHERE id=?", (stop["trip_id"],)).fetchone()
    driver = con.execute("SELECT * FROM drivers WHERE id=?", (trip["driver_id"],)).fetchone() if trip and trip["driver_id"] else None
    vehicle = con.execute("SELECT * FROM vehicles WHERE id=?", (trip["vehicle_id"],)).fetchone() if trip and trip["vehicle_id"] else None
    invoices = con.execute("""
        SELECT s.invoice_num, s.total, s.sale_date FROM delivery_stop_sales dss
        JOIN sales s ON s.id = dss.sale_id WHERE dss.stop_id = ?
    """, (stop_id,)).fetchall()
    return {"stop": stop, "trip": trip, "driver": driver, "vehicle": vehicle, "invoices": invoices}


def _draw_one_slip(c: canvas.Canvas, page_w: float, page_h: float, shop_name: str, data: dict, tracking_url: str = None):
    stop, trip, driver, vehicle, invoices = data["stop"], data["trip"], data["driver"], data["vehicle"], data["invoices"]
    right = page_w - 14 * MM
    y = page_h - 16 * MM

    # ── رأس البوليصة ──
    _draw_arabic(c, shop_name, right, y, font_size=17, bold=True)
    y -= 8 * MM
    c.setStrokeColorRGB(0.6, 0.6, 0.6)
    c.line(14 * MM, y, page_w - 14 * MM, y)
    y -= 7 * MM

    _draw_arabic(c, "بوليصة شحن وتوصيل", right, y, font_size=13, bold=True, color=(10, 90, 110))
    y -= 9 * MM

    def field(label, value):
        nonlocal y
        _draw_arabic(c, f"{label}:  {value or '—'}", right, y, font_size=10.5)
        y -= 6.2 * MM

    field("رقم الرحلة", trip["trip_num"] if trip else "—")
    field("السائق", driver["name"] if driver else "غير محدد")
    field("السيارة", vehicle["plate_number"] if vehicle else "غير محددة")
    y -= 1 * MM
    c.setStrokeColorRGB(0.85, 0.85, 0.85)
    c.line(14 * MM, y, page_w - 14 * MM, y)
    y -= 7 * MM

    field("العميل", stop["customer_name"])
    field("العنوان", stop["address"])
    field("الهاتف", stop["phone"])
    field("طريقة الدفع", stop["payment_mode"])
    y -= 1 * MM
    c.setStrokeColorRGB(0.85, 0.85, 0.85)
    c.line(14 * MM, y, page_w - 14 * MM, y)
    y -= 7 * MM

    _draw_arabic(c, "الفواتير المرفقة", right, y, font_size=11, bold=True)
    y -= 6.5 * MM
    for inv in invoices:
        _draw_arabic(c, f"{inv['invoice_num']}    —    {inv['total']:.2f}", right, y, font_size=10)
        y -= 5.8 * MM
    y -= 2 * MM

    c.setStrokeColorRGB(0.6, 0.6, 0.6)
    c.line(14 * MM, y, page_w - 14 * MM, y)
    y -= 9 * MM
    _draw_arabic(c, f"المبلغ المطلوب تحصيله: {stop['expected_amount']:.2f}", right, y,
                 font_size=13, bold=True, color=(150, 30, 30) if stop["payment_mode"] == "عند التسليم" else (20, 20, 20))
    y -= 12 * MM

    # ── الباركود ──
    bc = code128.Code128(stop["barcode"], barHeight=14 * MM, barWidth=0.42 * MM)
    bc_x = (page_w - bc.width) / 2
    bc.drawOn(c, bc_x, y - 14 * MM)
    c.setFont("Helvetica", 8)
    c.drawCentredString(page_w / 2, y - 18 * MM, stop["barcode"])

    # ── QR للتتبع (فقط إذا كانت صفحة التتبع العامة مفعّلة من الإعدادات) ──
    if tracking_url:
        qr_size = 20 * MM
        qr_widget = qr.QrCodeWidget(tracking_url)
        b = qr_widget.getBounds()
        qw, qh = b[2] - b[0], b[3] - b[1]
        d = Drawing(qr_size, qr_size, transform=[qr_size / qw, 0, 0, qr_size / qh, 0, 0])
        d.add(qr_widget)
        renderPDF.draw(d, c, page_w - 14 * MM - qr_size, y - 18 * MM)
        _draw_arabic(c, "امسح لتتبع الشحنة", page_w - 14 * MM, y - 20 * MM, font_size=7, color=(90, 90, 90), max_width=qr_size)

    y -= 26 * MM

    # ── توقيع الاستلام ──
    c.setStrokeColorRGB(0.75, 0.75, 0.75)
    c.line(14 * MM, y, 60 * MM, y)
    c.line(page_w - 60 * MM, y, page_w - 14 * MM, y)
    y -= 5 * MM
    _draw_arabic(c, "توقيع المستلم", page_w - 14 * MM, y, font_size=9, color=(90, 90, 90))
    c.setFont("Helvetica", 9)
    c.setFillColorRGB(0.35, 0.35, 0.35)
    c.drawString(14 * MM, y - 3, "Date:")
    _draw_arabic(c, "التاريخ", 14 * MM + 20 * MM, y, font_size=9, color=(90, 90, 90))


def generate_slip_pdf(stop_ids: list, output_path: str):
    """يولّد ملف PDF يحتوي على صفحة (بوليصة) لكل توقف من قائمة stop_ids."""
    with closing(api._conn()) as con:
        shop_name = _fetch_shop_name(con)
        slips = []
        for sid in stop_ids:
            d = _fetch_stop_full(con, sid)
            if d:
                d["tracking_url"] = _tracking_url_for(con, d["stop"]["barcode"])
                slips.append(d)

    if not slips:
        raise ValueError("لا توجد توقفات صالحة لطباعة بوليصة لها")

    page_w, page_h = A5
    c = canvas.Canvas(output_path, pagesize=A5)
    for i, data in enumerate(slips):
        _draw_one_slip(c, page_w, page_h, shop_name, data, tracking_url=data.get("tracking_url"))
        c.showPage()
    c.save()
    return output_path


# ══════════════ كشف الرحلة اليومي للسائق — TRIP MANIFEST ══════════════
_MANIFEST_ROW_H = 9 * MM


def _draw_manifest_header(c, page_w, page_h, shop_name, trip, driver, vehicle):
    right = page_w - 14 * MM
    y = page_h - 16 * MM
    _draw_arabic(c, shop_name, right, y, font_size=15, bold=True)
    y -= 8 * MM
    c.setStrokeColorRGB(0.6, 0.6, 0.6)
    c.line(14 * MM, y, page_w - 14 * MM, y)
    y -= 8 * MM
    _draw_arabic(c, "كشف رحلة توزيع يومي", right, y, font_size=13, bold=True, color=(10, 90, 110))
    y -= 8 * MM
    _draw_arabic(c, f"رقم الرحلة:  {trip['trip_num']}", right, y, font_size=10)
    y -= 6 * MM
    _draw_arabic(c, f"السائق:  {driver['name'] if driver else 'غير محدد'}", right, y, font_size=10)
    y -= 6 * MM
    _draw_arabic(c, f"السيارة:  {vehicle['plate_number'] if vehicle else 'غير محددة'}", right, y, font_size=10)
    y -= 6 * MM
    _draw_arabic(c, f"التاريخ:  {trip['created_at'][:10] if trip.get('created_at') else '—'}", right, y, font_size=10, color=(90, 90, 90))
    y -= 10 * MM
    return y


def _draw_manifest_table_header(c, page_w, y):
    right = page_w - 14 * MM
    bg = (15, 117, 107)
    c.setFillColorRGB(0.06, 0.46, 0.42)
    c.rect(14 * MM, y - 6, page_w - 28 * MM, _MANIFEST_ROW_H, fill=1, stroke=0)
    _draw_arabic(c, "#", right, y, font_size=9, bold=True, color=(255, 255, 255), bg=bg)
    _draw_arabic(c, "العميل", right - 12 * MM, y, font_size=9, bold=True, color=(255, 255, 255), bg=bg)
    _draw_arabic(c, "الدفع", right - 90 * MM, y, font_size=9, bold=True, color=(255, 255, 255), bg=bg)
    _draw_arabic(c, "الحالة", right - 120 * MM, y, font_size=9, bold=True, color=(255, 255, 255), bg=bg)
    _draw_arabic(c, "المبلغ", right - 155 * MM, y, font_size=9, bold=True, color=(255, 255, 255), bg=bg)
    return y - _MANIFEST_ROW_H


def generate_trip_manifest_pdf(trip_id: str, output_path: str):
    """كشف صفحة واحدة يلخّص كل توقفات رحلة توزيع، للسائق يتابع بيه يومه
    بدل ما يحمل بوليصة منفصلة لكل عميل. لا نستخدم أي تظليل متبادل بين
    الصفوف هنا عمدًا (راجع تعليق _arabic_image) لتفادي خلل رسم مكتشَف
    عند خلط صور نصية عربية مع مستطيلات ملوّنة متكررة بين الصفوف."""
    with closing(api._conn()) as con:
        shop_name = _fetch_shop_name(con)
        trip = con.execute("SELECT * FROM delivery_trips WHERE id=?", (trip_id,)).fetchone()
        if not trip:
            raise ValueError("الرحلة غير موجودة")
        driver = con.execute("SELECT * FROM drivers WHERE id=?", (trip["driver_id"],)).fetchone() if trip["driver_id"] else None
        vehicle = con.execute("SELECT * FROM vehicles WHERE id=?", (trip["vehicle_id"],)).fetchone() if trip["vehicle_id"] else None
        stops = con.execute("SELECT * FROM delivery_stops WHERE trip_id=? ORDER BY seq, created_at", (trip_id,)).fetchall()

    page_w, page_h = A4
    c = canvas.Canvas(output_path, pagesize=A4)
    y = _draw_manifest_header(c, page_w, page_h, shop_name, dict(trip), driver, vehicle)
    y = _draw_manifest_table_header(c, page_w, y)

    right = page_w - 14 * MM
    total_amount = 0.0
    for i, s in enumerate(stops, start=1):
        if y < 30 * MM:
            c.showPage()
            y = page_h - 20 * MM
            y = _draw_manifest_table_header(c, page_w, y)
        c.setFont("Helvetica", 9)
        c.setFillColorRGB(0.1, 0.1, 0.1)
        c.drawCentredString(right - 2 * MM, y - 3, str(i))
        _draw_arabic(c, s["customer_name"] or "—", right - 12 * MM, y, font_size=9, max_width=70 * MM)
        _draw_arabic(c, s["payment_mode"], right - 90 * MM, y, font_size=9)
        status_color = (15, 118, 110) if s["status"] == "تم التسليم" else (180, 30, 30) if s["status"] in ("مرتجع", "مشكلة") else (90, 90, 90)
        _draw_arabic(c, s["status"], right - 120 * MM, y, font_size=9, color=status_color)
        c.setFont("Helvetica", 9)
        c.setFillColorRGB(0.1, 0.1, 0.1)
        c.drawCentredString(right - 165 * MM, y - 3, f"{s['expected_amount']:.2f}")
        total_amount += s["expected_amount"] or 0
        y -= _MANIFEST_ROW_H

    if not stops:
        _draw_arabic(c, "لا توجد توقفات في هذه الرحلة", right, y, font_size=10, color=(120, 120, 120))
        y -= _MANIFEST_ROW_H

    y -= 6 * MM
    c.setStrokeColorRGB(0.6, 0.6, 0.6)
    c.line(14 * MM, y, page_w - 14 * MM, y)
    y -= 9 * MM
    _draw_arabic(c, f"عدد التوقفات:  {len(stops)}", right, y, font_size=11, bold=True)
    y -= 7 * MM
    _draw_arabic(c, f"إجمالي المبالغ المتوقعة:  {total_amount:.2f}", right, y, font_size=12, bold=True, color=(15, 118, 110))

    c.save()
    return output_path


def register_routes(app):
    from flask import send_file, abort

    @app.route("/api/delivery_slip_pdf/stop/<stop_id>")
    def delivery_slip_pdf_stop(stop_id):
        try:
            fd, path = tempfile.mkstemp(suffix=".pdf")
            os.close(fd)
            generate_slip_pdf([stop_id], path)
            return send_file(path, mimetype="application/pdf", as_attachment=False,
                              download_name=f"delivery_slip_{stop_id}.pdf")
        except Exception as e:
            abort(500, description=str(e))

    @app.route("/api/delivery_slip_pdf/trip/<trip_id>")
    def delivery_slip_pdf_trip(trip_id):
        try:
            with closing(api._conn()) as con:
                stop_ids = [r[0] for r in con.execute(
                    "SELECT id FROM delivery_stops WHERE trip_id=? ORDER BY seq, created_at", (trip_id,)
                ).fetchall()]
            if not stop_ids:
                abort(404, description="لا توجد توقفات في هذه الرحلة")
            fd, path = tempfile.mkstemp(suffix=".pdf")
            os.close(fd)
            generate_slip_pdf(stop_ids, path)
            return send_file(path, mimetype="application/pdf", as_attachment=False,
                              download_name=f"delivery_slips_{trip_id}.pdf")
        except Exception as e:
            abort(500, description=str(e))

    @app.route("/api/trip_manifest_pdf/<trip_id>")
    def trip_manifest_pdf(trip_id):
        try:
            fd, path = tempfile.mkstemp(suffix=".pdf")
            os.close(fd)
            generate_trip_manifest_pdf(trip_id, path)
            return send_file(path, mimetype="application/pdf", as_attachment=False,
                              download_name=f"trip_manifest_{trip_id}.pdf")
        except Exception as e:
            abort(500, description=str(e))
