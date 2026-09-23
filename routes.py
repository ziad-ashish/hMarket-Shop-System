# ══════════════════════════════════════════════════════════════
#  ROUTES.PY  —  Flask REST API endpoints
#  كل method في ShopAPI بتبقى endpoint على /api/<method>
#  الـ JS بينادي fetch('/api/method', {method:'POST', body:...})
# ══════════════════════════════════════════════════════════════

import json
from flask import request, jsonify, g
from api import ShopAPI
from server_auth import install_auth, COOKIE
from shop_ops import permission
from contextlib import closing
import api as _api_module

_api = ShopAPI()


def _resp(raw: str):
    """تحوّل الـ JSON string اللي بترجعه api.py لـ Flask Response."""
    data = json.loads(raw)
    return jsonify(data)


def _require(perm_key, msg):
    """يتأكد إن المستخدم الحالي عنده الصلاحية المطلوبة، وإلا يرجّع 403.
    يُستخدم لحماية إعدادات العمل الحسّاسة (الأسطول، العروض، الجدولة الدورية)
    بنفس نمط الحماية المستخدم أصلًا في shop_ops.py."""
    with closing(_api_module._conn()) as con:
        if not permission(con, perm_key):
            return jsonify(ok=False, error=msg), 403
    return None


def register_routes(app):
    """بتسجل كل الـ routes على الـ Flask app."""
    install_auth(app)
    from camera_api import register_camera_routes
    register_camera_routes(app)
    from shop_ops import register_routes as register_operations_routes
    register_operations_routes(app)
    from backup_store import register_routes as register_backup_routes
    register_backup_routes(app)
    from delivery_pdf import register_routes as register_delivery_pdf_routes
    register_delivery_pdf_routes(app)
    from labels_pdf import register_routes as register_labels_pdf_routes
    register_labels_pdf_routes(app)
    from reports_excel import register_routes as register_reports_excel_routes
    register_reports_excel_routes(app)
    from tracking_page import register_routes as register_tracking_routes
    register_tracking_routes(app)
    from statement_pdf import register_routes as register_statement_routes
    register_statement_routes(app)

    # ── PRODUCTS ─────────────────────────────────────────────
    @app.route("/api/get_products")
    def get_products():
        return _resp(_api.get_products())

    @app.route("/api/get_product/<mid>")
    def get_product(mid):
        return _resp(_api.get_product(mid, include_image=request.args.get('image')=='1'))

    @app.route("/api/get_product_by_barcode/<path:barcode>")
    def get_product_by_barcode(barcode):
        return _resp(_api.get_product_by_barcode(barcode))

    @app.route("/api/add_product", methods=["POST"])
    def add_product():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_product(json.dumps(body), user_id))

    @app.route("/api/update_product/<mid>", methods=["POST"])
    def update_product(mid):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_product(mid, json.dumps(body), user_id))

    @app.route("/api/delete_product/<mid>", methods=["POST"])
    def delete_product(mid):
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.delete_product(mid, user_id))

    @app.route("/api/get_low_stock")
    def get_low_stock():
        return _resp(_api.get_low_stock())

    @app.route("/api/get_supplier_price_comparison")
    def get_supplier_price_comparison():
        return _resp(_api.get_supplier_price_comparison(request.args.get("product_id") or None))

    @app.route("/api/get_categories")
    def get_categories():
        return _resp(_api.get_categories())

    # ── STOCKTAKE / STOCK LEDGER — الجرد الدوري وسجل الحركة ──
    @app.route("/api/get_stocktake_worksheet")
    def get_stocktake_worksheet():
        return _resp(_api.get_stocktake_worksheet(request.args.get("category") or None))

    @app.route("/api/submit_stocktake", methods=["POST"])
    def submit_stocktake():
        denied = _require("products", "تسجيل الجرد يحتاج صلاحية إدارة المخزون")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.submit_stocktake(json.dumps(body), user_id))

    @app.route("/api/get_stock_ledger/<product_id>")
    def get_stock_ledger(product_id):
        return _resp(_api.get_stock_ledger(product_id, request.args.get("date_from") or None, request.args.get("date_to") or None))

    @app.route("/api/get_health_check")
    def get_health_check():
        return _resp(_api.get_health_check())

    # ── CUSTOMERS ──────────────────────────────────────────────
    @app.route("/api/get_customers")
    def get_customers():
        return _resp(_api.get_customers())

    @app.route("/api/get_customer/<pid>")
    def get_customer(pid):
        return _resp(_api.get_customer(pid))

    @app.route("/api/add_customer", methods=["POST"])
    def add_customer():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_customer(json.dumps(body), user_id))

    @app.route("/api/update_customer/<pid>", methods=["POST"])
    def update_customer(pid):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_customer(pid, json.dumps(body), user_id))

    @app.route("/api/delete_customer/<pid>", methods=["POST"])
    def delete_customer(pid):
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.delete_customer(pid, user_id))

    # ── SUPPLIERS ─────────────────────────────────────────────
    @app.route("/api/get_suppliers")
    def get_suppliers():
        return _resp(_api.get_suppliers())

    @app.route("/api/get_supplier/<sid>")
    def get_supplier(sid):
        return _resp(_api.get_supplier(sid))

    @app.route("/api/add_supplier", methods=["POST"])
    def add_supplier():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_supplier(json.dumps(body), user_id))

    @app.route("/api/update_supplier/<sid>", methods=["POST"])
    def update_supplier(sid):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_supplier(sid, json.dumps(body), user_id))

    @app.route("/api/delete_supplier/<sid>", methods=["POST"])
    def delete_supplier(sid):
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.delete_supplier(sid, user_id))

    # ── SALES ─────────────────────────────────────────────────
    @app.route("/api/get_sales")
    def get_sales():
        return _resp(_api.get_sales())

    @app.route("/api/get_sale/<sale_id>")
    def get_sale(sale_id):
        return _resp(_api.get_sale(sale_id))

    @app.route("/api/add_sale", methods=["POST"])
    def add_sale():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_sale(json.dumps(body), user_id))

    @app.route("/api/get_top_selling_products/<int:limit>")
    def get_top_selling_products(limit): return _resp(_api.get_top_selling_products(max(1, min(limit, 200))))

    @app.route("/api/search_products")
    def search_products(): return _resp(_api.search_products(request.args.get("q", "")))

    @app.route("/api/get_debts")
    def get_debts(): return _resp(_api.get_debts(request.args.get("overdue") == "1"))

    @app.route("/api/get_customer_debt/<customer_id>")
    def get_customer_debt(customer_id): return _resp(_api.get_customer_debt(customer_id))

    @app.route("/api/get_customer_statement/<customer_id>")
    def get_customer_statement(customer_id):
        return _resp(_api.get_customer_statement(customer_id, request.args.get("date_from") or None, request.args.get("date_to") or None))

    @app.route("/api/pay_debt/<debt_id>", methods=["POST"])
    def pay_debt(debt_id):
        body=request.get_json(force=True) or {}; uid=body.pop("__user_id",None)
        return _resp(_api.pay_debt(debt_id,body.get("amount",0),uid))

    @app.route("/api/import_products", methods=["POST"])
    def import_products():
        uid=g.user_id
        uploaded=request.files.get("file")
        if uploaded: text=uploaded.read().decode("utf-8-sig")
        else: text=(request.get_json(silent=True) or {}).get("csv","")
        return _resp(_api.import_products(text,uid))

    @app.route("/api/get_turnover_report")
    def get_turnover_report():
        try: days = int(request.args.get("days", 30))
        except (TypeError, ValueError): days = 30
        return _resp(_api.get_turnover_report(max(1, min(days, 366))))

    @app.route("/api/get_loyalty/<customer_id>")
    def get_loyalty(customer_id): return _resp(_api.get_loyalty(customer_id))

    @app.route("/api/void_sale/<sale_id>", methods=["POST"])
    def void_sale(sale_id):
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.void_sale(sale_id, user_id))

    # ── SERIAL / IMEI + WARRANTY ──────────────────────────────
    @app.route("/api/get_stock_aging_report")
    def get_stock_aging_report():
        return _resp(_api.get_stock_aging_report())

    @app.route("/api/get_serial_units")
    def get_serial_units():
        try: limit = int(request.args.get("limit", 500))
        except (TypeError, ValueError): limit = 500
        return _resp(_api.get_serial_units(request.args.get("product_id") or None, request.args.get("status") or None,
                                           request.args.get("q") or None, limit))

    @app.route("/api/add_serial_units", methods=["POST"])
    def add_serial_units():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_serial_units(json.dumps(body), user_id))

    @app.route("/api/update_serial_unit/<unit_id>", methods=["POST"])
    def update_serial_unit(unit_id):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_serial_unit(unit_id, json.dumps(body), user_id))

    @app.route("/api/lookup_serial/<path:code>")
    def lookup_serial(code):
        return _resp(_api.lookup_serial(code))

    @app.route("/api/search_warranty")
    def search_warranty():
        return _resp(_api.search_warranty(request.args.get("q", "")))

    # ── REPAIRS ───────────────────────────────────────────────
    @app.route("/api/get_repairs")
    def get_repairs():
        return _resp(_api.get_repairs(request.args.get("status") or None, request.args.get("q") or None))

    @app.route("/api/get_repair/<ticket_id>")
    def get_repair(ticket_id):
        return _resp(_api.get_repair(ticket_id))

    @app.route("/api/get_repair_stats")
    def get_repair_stats():
        return _resp(_api.get_repair_stats())

    @app.route("/api/get_technicians")
    def get_technicians():
        return _resp(_api.get_technicians())

    @app.route("/api/add_repair", methods=["POST"])
    def add_repair():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_repair(json.dumps(body), user_id))

    @app.route("/api/update_repair/<ticket_id>", methods=["POST"])
    def update_repair(ticket_id):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_repair(ticket_id, json.dumps(body), user_id))

    @app.route("/api/deliver_repair/<ticket_id>", methods=["POST"])
    def deliver_repair(ticket_id):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.deliver_repair(ticket_id, json.dumps(body), user_id))

    @app.route("/api/cancel_repair/<ticket_id>", methods=["POST"])
    def cancel_repair(ticket_id):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.cancel_repair(ticket_id, body.get("reason", ""), user_id))

    # ── STATS / REPORTS ───────────────────────────────────────
    @app.route("/api/get_stats")
    def get_stats():
        return _resp(_api.get_stats())

    @app.route("/api/get_dashboard_report")
    def get_dashboard_report():
        return _resp(_api.get_dashboard_report(
            request.args.get("from_date"),
            request.args.get("to_date"),
        ))

    @app.route("/api/get_monthly_sales")
    def get_monthly_sales():
        return _resp(_api.get_monthly_sales())

    @app.route("/api/get_top_products")
    def get_top_products():
        return _resp(_api.get_top_products())

    @app.route("/api/get_category_dist")
    def get_category_dist():
        return _resp(_api.get_category_dist())

    @app.route("/api/get_recent_activity")
    def get_recent_activity():
        return _resp(_api.get_recent_activity())

    @app.route("/api/get_profit_report")
    @app.route("/api/get_profit_report/<period>")
    def get_profit_report(period="all"):
        return _resp(_api.get_profit_report(period))

    # ── SETTINGS ──────────────────────────────────────────────
    @app.route("/api/get_setting/<key>")
    def get_setting(key):
        return _resp(_api.get_setting(key))

    @app.route("/api/set_setting", methods=["POST"])
    def set_setting():
        body = request.get_json(force=True) or {}
        return _resp(_api.set_setting(body.get("key",""), body.get("value",""), g.user_id))

    # ── BACKUP ────────────────────────────────────────────────
    @app.route("/api/backup_database", methods=["POST"])
    def backup_database():
        return _resp(_api.backup_database(g.user_id))

    @app.route("/api/get_backup_status")
    def get_backup_status():
        return _resp(_api.get_backup_status())

    @app.route("/api/list_backups")
    def list_backups():
        return _resp(_api.list_backups())

    @app.route("/api/restore_database", methods=["POST"])
    def restore_database():
        body = request.get_json(force=True) or {}
        return _resp(_api.restore_database(body.get("backup_path",""), g.user_id))

    # ── AUDIT LOG ─────────────────────────────────────────────
    @app.route("/api/get_audit_log")
    def get_audit_log():
        try: limit = int(request.args.get("limit", 100))
        except (TypeError, ValueError): limit = 100
        try: offset = int(request.args.get("offset", 0))
        except (TypeError, ValueError): offset = 0
        limit, offset = max(1, min(limit, 500)), max(0, offset)
        return _resp(_api.get_audit_log(limit, offset))

    # ── AUTH ──────────────────────────────────────────────────
    @app.route("/api/login", methods=["POST"])
    def login():
        body = request.get_json(force=True) or {}
        if not isinstance(body, dict) or not all(isinstance(body.get(k, ""), str) for k in ("username", "password")):
            return jsonify(ok=False, error="بيانات الدخول غير صالحة"), 400
        result = json.loads(_api.login(body.get("username",""), body.get("password","")))
        response = jsonify(result)
        if result.get("ok"):
            app.extensions["shop_issue_session"](response, result["data"]["id"])
        return response

    @app.get("/api/current_session")
    def current_session():
        return _resp(_api.get_current_user(g.user_id))

    @app.post("/api/logout")
    def logout():
        entry = app.extensions["shop_revoke_session"](audit=True)
        backup = None
        warning = ""
        if entry:
            try:
                from backup_store import run_backup
                backup = run_backup(entry["uid"])
            except Exception as exc:
                # A locked/unavailable backup disk must not trap the user in the session.
                warning = str(exc)
        response = jsonify(ok=True, data={"backup": backup, "backup_warning": warning})
        response.delete_cookie(COOKIE, path="/")
        return response

    @app.route("/api/get_users")
    def get_users():
        return _resp(_api.get_users())

    @app.route("/api/get_current_user/<uid>")
    def get_current_user(uid):
        if uid != g.user_id:
            return jsonify(ok=False, error="غير مصرح"), 403
        return _resp(_api.get_current_user(g.user_id))

    @app.route("/api/change_password", methods=["POST"])
    def change_password():
        body = request.get_json(force=True) or {}
        result = json.loads(_api.change_password(
            g.user_id,
            body.get("old_pwd",""),
            body.get("new_pwd","")
        ))
        response = jsonify(result)
        if result.get("ok"):
            app.extensions["shop_issue_session"](response, g.user_id)
        return response

    @app.route("/api/check_permission", methods=["POST"])
    def check_permission():
        body = request.get_json(force=True) or {}
        return _resp(_api.check_permission(
            g.user_id,
            body.get("perm","")
        ))

    # ── USER MANAGEMENT ───────────────────────────────────────
    @app.route("/api/add_user", methods=["POST"])
    def add_user():
        body      = request.get_json(force=True) or {}
        caller_id = body.pop("__user_id", None)
        return _resp(_api.add_user(json.dumps(body), caller_id))

    @app.route("/api/update_user/<uid>", methods=["POST"])
    def update_user(uid):
        body      = request.get_json(force=True) or {}
        caller_id = body.pop("__user_id", None)
        return _resp(_api.update_user(uid, json.dumps(body), caller_id))

    @app.route("/api/delete_user/<uid>", methods=["POST"])
    def delete_user(uid):
        body      = request.get_json(force=True) or {}
        caller_id = body.get("__user_id")
        return _resp(_api.delete_user(uid, caller_id))

    @app.route("/api/reset_user_password/<uid>", methods=["POST"])
    def reset_user_password(uid):
        body      = request.get_json(force=True) or {}
        caller_id = body.pop("__user_id", None)
        return _resp(_api.reset_user_password(uid, json.dumps(body), caller_id))

    # ── PURCHASES ─────────────────────────────────────────────
    @app.route("/api/get_purchases")
    def get_purchases():
        return _resp(_api.get_purchases())

    @app.route("/api/get_purchase/<pid>")
    def get_purchase(pid):
        return _resp(_api.get_purchase(pid))

    @app.route("/api/add_purchase", methods=["POST"])
    def add_purchase():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_purchase(json.dumps(body), user_id))

    @app.route("/api/receive_purchase/<pid>", methods=["POST"])
    def receive_purchase(pid):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.receive_purchase(pid, json.dumps(body), user_id))

    @app.route("/api/cancel_purchase/<pid>", methods=["POST"])
    def cancel_purchase(pid):
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.cancel_purchase(pid, user_id))

    # ── ACCOUNTS ──────────────────────────────────────────────
    @app.route("/api/get_accounts")
    def get_accounts():
        return _resp(_api.get_accounts())

    @app.route("/api/add_account", methods=["POST"])
    def add_account():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_account(json.dumps(body), user_id))

    @app.route("/api/update_account/<aid>", methods=["POST"])
    def update_account(aid):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_account(aid, json.dumps(body), user_id))

    @app.route("/api/delete_account/<aid>", methods=["POST"])
    def delete_account(aid):
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.delete_account(aid, user_id))

    @app.route("/api/get_transactions")
    def get_transactions():
        account_id = request.args.get("account_id")
        try: limit = int(request.args.get("limit", 100))
        except (TypeError, ValueError): limit = 100
        try: offset = int(request.args.get("offset", 0))
        except (TypeError, ValueError): offset = 0
        limit, offset = max(1, min(limit, 500)), max(0, offset)
        return _resp(_api.get_transactions(account_id, limit, offset))

    @app.route("/api/add_transaction", methods=["POST"])
    def add_transaction():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_transaction(json.dumps(body), user_id))

    @app.route("/api/get_financial_summary")
    def get_financial_summary():
        return _resp(_api.get_financial_summary())

    # ── CASH SESSIONS ─────────────────────────────────────────
    @app.route("/api/get_active_session")
    def get_active_session():
        return _resp(_api.get_active_session())

    @app.route("/api/open_session", methods=["POST"])
    def open_session():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.open_session(json.dumps(body), user_id))

    @app.route("/api/close_session/<sid>", methods=["POST"])
    def close_session(sid):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.close_session(sid, json.dumps(body), user_id))

    @app.route("/api/get_sessions")
    def get_sessions():
        return _resp(_api.get_sessions())

    # ── HR & PAYROLL ───────────────────────────────────────────
    @app.route("/api/get_employees")
    def get_employees():
        return _resp(_api.get_employees())

    @app.route("/api/add_employee", methods=["POST"])
    def add_employee():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_employee(json.dumps(body), user_id))

    @app.route("/api/update_employee/<eid>", methods=["POST"])
    def update_employee(eid):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_employee(eid, json.dumps(body), user_id))

    @app.route("/api/delete_employee/<eid>", methods=["POST"])
    def delete_employee(eid):
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.delete_employee(eid, user_id))

    @app.route("/api/get_payroll")
    def get_payroll():
        employee_id = request.args.get("employee_id")
        return _resp(_api.get_payroll(employee_id))

    @app.route("/api/add_payroll", methods=["POST"])
    def add_payroll():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_payroll(json.dumps(body), user_id))

    @app.route("/api/get_employee_performance")
    def get_employee_performance():
        employee_id = request.args.get("employee_id")
        return _resp(_api.get_employee_performance(employee_id))

    # ── SHIPPING & DISTRIBUTION — الشحن والتوزيع ────────────────
    @app.route("/api/get_drivers")
    def get_drivers():
        return _resp(_api.get_drivers())

    @app.route("/api/add_driver", methods=["POST"])
    def add_driver():
        denied = _require("delivery_fleet", "إدارة السائقين تحتاج صلاحية إدارة الأسطول")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_driver(json.dumps(body), user_id))

    @app.route("/api/update_driver/<did>", methods=["POST"])
    def update_driver(did):
        denied = _require("delivery_fleet", "إدارة السائقين تحتاج صلاحية إدارة الأسطول")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_driver(did, json.dumps(body), user_id))

    @app.route("/api/delete_driver/<did>", methods=["POST"])
    def delete_driver(did):
        denied = _require("delivery_fleet", "إدارة السائقين تحتاج صلاحية إدارة الأسطول")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.delete_driver(did, user_id))

    @app.route("/api/get_vehicles")
    def get_vehicles():
        return _resp(_api.get_vehicles())

    @app.route("/api/add_vehicle", methods=["POST"])
    def add_vehicle():
        denied = _require("delivery_fleet", "إدارة السيارات تحتاج صلاحية إدارة الأسطول")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_vehicle(json.dumps(body), user_id))

    @app.route("/api/update_vehicle/<vid>", methods=["POST"])
    def update_vehicle(vid):
        denied = _require("delivery_fleet", "إدارة السيارات تحتاج صلاحية إدارة الأسطول")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_vehicle(vid, json.dumps(body), user_id))

    @app.route("/api/delete_vehicle/<vid>", methods=["POST"])
    def delete_vehicle(vid):
        denied = _require("delivery_fleet", "إدارة السيارات تحتاج صلاحية إدارة الأسطول")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.delete_vehicle(vid, user_id))

    @app.route("/api/get_delivery_trips")
    def get_delivery_trips():
        status = request.args.get("status")
        return _resp(_api.get_delivery_trips(status))

    @app.route("/api/get_delivery_trip/<tid>")
    def get_delivery_trip(tid):
        return _resp(_api.get_delivery_trip(tid))

    @app.route("/api/add_delivery_trip", methods=["POST"])
    def add_delivery_trip():
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_delivery_trip(json.dumps(body), user_id))

    @app.route("/api/add_delivery_stop/<trip_id>", methods=["POST"])
    def add_delivery_stop(trip_id):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_delivery_stop(trip_id, json.dumps(body), user_id))

    @app.route("/api/get_unassigned_sales_for_customer/<customer_id>")
    def get_unassigned_sales_for_customer(customer_id):
        return _resp(_api.get_unassigned_sales_for_customer(customer_id))

    @app.route("/api/dispatch_trip/<trip_id>", methods=["POST"])
    def dispatch_trip(trip_id):
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.dispatch_trip(trip_id, user_id))

    @app.route("/api/cancel_trip/<trip_id>", methods=["POST"])
    def cancel_trip(trip_id):
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.cancel_trip(trip_id, user_id))

    @app.route("/api/get_stop_by_barcode/<path:barcode>")
    def get_stop_by_barcode(barcode):
        return _resp(_api.get_stop_by_barcode(barcode))

    @app.route("/api/update_stop_status/<stop_id>", methods=["POST"])
    def update_stop_status(stop_id):
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_stop_status(stop_id, json.dumps(body), user_id))

    @app.route("/api/get_delivery_stats")
    def get_delivery_stats():
        return _resp(_api.get_delivery_stats())

    @app.route("/api/get_debt_aging_report")
    def get_debt_aging_report():
        return _resp(_api.get_debt_aging_report(request.args.get("customer_type") or None))

    @app.route("/api/get_purchase_suggestions")
    def get_purchase_suggestions():
        return _resp(_api.get_purchase_suggestions())

    @app.route("/api/get_driver_performance_report")
    def get_driver_performance_report():
        return _resp(_api.get_driver_performance_report(
            request.args.get("date_from") or None, request.args.get("date_to") or None))

    @app.route("/api/get_customer_profitability_report")
    def get_customer_profitability_report():
        return _resp(_api.get_customer_profitability_report(request.args.get("customer_type") or None))

    # ── PROMOTIONS — العروض والخصومات ──
    @app.route("/api/get_promotions")
    def get_promotions():
        active_only = request.args.get("active_only") == "1"
        return _resp(_api.get_promotions(active_only))

    @app.route("/api/add_promotion", methods=["POST"])
    def add_promotion():
        denied = _require("promotions", "إنشاء العروض يحتاج صلاحية إدارة العروض")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_promotion(json.dumps(body), user_id))

    @app.route("/api/update_promotion/<promo_id>", methods=["POST"])
    def update_promotion(promo_id):
        denied = _require("promotions", "تعديل العروض يحتاج صلاحية إدارة العروض")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_promotion(promo_id, json.dumps(body), user_id))

    @app.route("/api/delete_promotion/<promo_id>", methods=["POST"])
    def delete_promotion(promo_id):
        denied = _require("promotions", "حذف العروض يحتاج صلاحية إدارة العروض")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.delete_promotion(promo_id, user_id))

    # ── RECURRING ROUTES — الرحلات الدورية المجدولة ──
    @app.route("/api/get_recurring_routes")
    def get_recurring_routes():
        return _resp(_api.get_recurring_routes())

    @app.route("/api/add_recurring_route", methods=["POST"])
    def add_recurring_route():
        denied = _require("delivery_fleet", "جدولة الرحلات الدورية تحتاج صلاحية إدارة الأسطول")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.add_recurring_route(json.dumps(body), user_id))

    @app.route("/api/update_recurring_route/<route_id>", methods=["POST"])
    def update_recurring_route(route_id):
        denied = _require("delivery_fleet", "تعديل الرحلات الدورية يحتاج صلاحية إدارة الأسطول")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.pop("__user_id", None)
        return _resp(_api.update_recurring_route(route_id, json.dumps(body), user_id))

    @app.route("/api/delete_recurring_route/<route_id>", methods=["POST"])
    def delete_recurring_route(route_id):
        denied = _require("delivery_fleet", "حذف الرحلات الدورية يحتاج صلاحية إدارة الأسطول")
        if denied: return denied
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.delete_recurring_route(route_id, user_id))

    @app.route("/api/generate_todays_recurring_trips", methods=["POST"])
    def generate_todays_recurring_trips():
        body    = request.get_json(force=True) or {}
        user_id = body.get("__user_id")
        return _resp(_api.generate_todays_recurring_trips(user_id))
