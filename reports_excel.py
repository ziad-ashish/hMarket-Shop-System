# ══════════════════════════════════════════════════════════════
#  REPORTS_EXCEL.PY — تصدير التقارير التحليلية لملف Excel منسّق
#  (الصلاحية، مقارنة الموردين، أعمار الديون، اقتراحات الشراء،
#   أداء السائقين، ربحية العملاء)
# ══════════════════════════════════════════════════════════════
import json
import os
import tempfile

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

import api

_HEADER_FILL = PatternFill("solid", fgColor="0F766E")   # teal-700
_HEADER_FONT = Font(name="Arial", bold=True, color="FFFFFF", size=11)
_TITLE_FONT  = Font(name="Arial", bold=True, size=14, color="0F172A")
_BASE_FONT   = Font(name="Arial", size=10.5)
_MONEY_FMT   = '#,##0.00'
_THIN        = Side(style="thin", color="D1D5DB")
_BORDER      = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)


def _new_sheet(wb, title, headers, money_cols=()):
    ws = wb.active if wb.active.max_row == 1 and wb.active.max_column == 1 and not wb.active["A1"].value else wb.create_sheet(title)
    ws.title = title[:31]
    ws.sheet_view.rightToLeft = True
    for i, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=i, value=h)
        c.font = _HEADER_FONT
        c.fill = _HEADER_FILL
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = _BORDER
    ws.freeze_panes = "A2"
    ws.row_dimensions[1].height = 22
    return ws


def _write_rows(ws, rows, money_cols=()):
    for r_idx, row in enumerate(rows, start=2):
        for c_idx, val in enumerate(row, start=1):
            c = ws.cell(row=r_idx, column=c_idx, value=val)
            c.font = _BASE_FONT
            c.border = _BORDER
            c.alignment = Alignment(horizontal="center", vertical="center")
            if c_idx in money_cols and isinstance(val, (int, float)):
                c.number_format = _MONEY_FMT
    for i in range(1, ws.max_column + 1):
        best = max([len(str(ws.cell(row=r, column=i).value or "")) for r in range(1, ws.max_row + 1)], default=10)
        ws.column_dimensions[get_column_letter(i)].width = min(max(best + 4, 12), 42)


def _build_stock_aging_sheet(wb):
    data = json.loads(api.ShopAPI().get_stock_aging_report())["data"]
    ws = _new_sheet(wb, "أعمار مخزون الأجهزة", ["الجهاز", "الفئة", "IMEI / Serial", "المواصفات", "تاريخ الاستلام", "عدد الأيام", "التكلفة", "سعر البيع"])
    all_rows = data["buckets"]["over90"] + data["buckets"]["d90"] + data["buckets"]["d60"] + data["buckets"]["d30"]
    rows = [[r["name"], r["category"], r["serial"], r.get("variant") or "—", r["received_date"] or "—", r["age_days"], r["cost"], r["price"]] for r in all_rows]
    _write_rows(ws, rows, money_cols={7, 8})


def _build_supplier_prices_sheet(wb):
    data = json.loads(api.ShopAPI().get_supplier_price_comparison())["data"]
    ws = _new_sheet(wb, "مقارنة الموردين", ["الصنف", "المورد", "آخر سعر", "أفضل سعر", "تاريخ آخر توريد", "عدد الأوامر", "الأفضل"])
    rows = []
    for item in data:
        for s in item["suppliers"]:
            rows.append([item["product_name"], s["supplier_name"], s["last_price"], s["best_price"],
                         s["last_date"] or "—", s["orders_count"], "نعم" if s["is_best"] else ""])
    _write_rows(ws, rows, money_cols={3, 4})


def _build_debt_aging_sheet(wb):
    data = json.loads(api.ShopAPI().get_debt_aging_report())["data"]
    ws = _new_sheet(wb, "أعمار الديون", ["العميل", "النوع", "0-30 يوم", "31-60 يوم", "61-90 يوم", "+90 يوم", "الإجمالي", "سقف الائتمان"])
    rows = [[c["customer_name"], c["customer_type"], c["b0_30"], c["b31_60"], c["b61_90"], c["b90_plus"], c["total"], c["credit_limit"]] for c in data["customers"]]
    _write_rows(ws, rows, money_cols={3, 4, 5, 6, 7, 8})


def _build_purchase_suggestions_sheet(wb):
    data = json.loads(api.ShopAPI().get_purchase_suggestions())["data"]
    ws = _new_sheet(wb, "اقتراحات الشراء", ["الصنف", "الفئة", "المخزون الحالي", "الحد الأدنى", "الكمية المقترحة", "الأولوية", "أفضل مورد", "أفضل سعر", "التكلفة التقديرية"])
    rows = [[r["name"], r["category"], r["current_stock"], r["min_stock"], r["suggested_qty"], r["urgency"],
             r["best_supplier_name"], r["best_price"], r["estimated_cost"]] for r in data]
    _write_rows(ws, rows, money_cols={8, 9})


def _build_driver_performance_sheet(wb):
    data = json.loads(api.ShopAPI().get_driver_performance_report())["data"]
    ws = _new_sheet(wb, "أداء السائقين", ["السائق", "إجمالي التوقفات", "تم التسليم", "مرتجع", "مشكلة", "قيد الانتظار", "نسبة النجاح %", "إجمالي المحصّل"])
    rows = [[r["driver_name"], r["total_stops"], r["delivered"], r["returned"], r["problem"], r["pending"], r["success_rate"], r["total_collected"]] for r in data]
    _write_rows(ws, rows, money_cols={8})


def _build_customer_profitability_sheet(wb):
    data = json.loads(api.ShopAPI().get_customer_profitability_report())["data"]
    ws = _new_sheet(wb, "ربحية العملاء", ["العميل", "النوع", "عدد الفواتير", "الإيراد", "تكلفة البضاعة", "هامش الربح", "نسبة الهامش %"])
    rows = [[r["customer_name"], r["customer_type"], r["orders_count"], r["revenue"], r["cogs"], r["profit"], r["margin_pct"]] for r in data]
    _write_rows(ws, rows, money_cols={4, 5, 6})


_BUILDERS = {
    "stock_aging": _build_stock_aging_sheet,
    "supplier_prices": _build_supplier_prices_sheet,
    "debt_aging": _build_debt_aging_sheet,
    "purchase_suggestions": _build_purchase_suggestions_sheet,
    "driver_performance": _build_driver_performance_sheet,
    "customer_profitability": _build_customer_profitability_sheet,
}

_TITLES = {
    "stock_aging": "أعمار_مخزون_الأجهزة",
    "supplier_prices": "مقارنة_الموردين",
    "debt_aging": "أعمار_الديون",
    "purchase_suggestions": "اقتراحات_الشراء",
    "driver_performance": "أداء_السائقين",
    "customer_profitability": "ربحية_العملاء",
}


def generate_report_excel(report_key: str, output_path: str):
    if report_key not in _BUILDERS:
        raise ValueError(f"نوع تقرير غير معروف: {report_key}")
    wb = Workbook()
    _BUILDERS[report_key](wb)
    wb.save(output_path)
    return output_path


def register_routes(app):
    from flask import send_file, abort, request

    @app.route("/api/export_report_excel")
    def export_report_excel():
        report_key = request.args.get("report", "")
        if report_key not in _BUILDERS:
            abort(400, description="نوع تقرير غير معروف")
        try:
            fd, path = tempfile.mkstemp(suffix=".xlsx")
            os.close(fd)
            generate_report_excel(report_key, path)
            filename = f"{_TITLES.get(report_key, report_key)}.xlsx"
            return send_file(path, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                              as_attachment=True, download_name=filename)
        except Exception as e:
            abort(500, description=str(e))
