# ══════════════════════════════════════════════════════════════
#  API.PY  —  Python backend bridge  (SQLite + PyWebView)
#  نظام إدارة محل أدوات كهربائية وموبايلات: مخزون، IMEI، ضمان، صيانة، مبيعات
#
#  FIXES applied previously:
#  [1] UUID-based IDs
#  [2] get_low_stock excludes stock=0
#  [3] FK REFERENCES + ON DELETE CASCADE on sale_items
#  [4] Per-year invoice seq via MAX(invoice_seq)
#
#  NEW FEATURES (this file):
#  [1.2] add_sale: stock pre-check + atomic rollback
#  [1.4] void_sale: marks invoice "ملغاة", restores stock
#  [1.5] orphan-safe delete: is_active archiving for product/customer/supplier
#  [1.6] atomic invoice numbering with BEGIN IMMEDIATE
#  [1.7] barcode uniqueness check in add_product
#  [2.8] pbkdf2_hmac password hashing (upgrade path from sha256/plain)
#  [2.10] login lockout: 5 failures → 2-minute temp lock
#  [3.13] role permission check helper _require_role()
#  [3.14] backup_database / restore_database
#  [3.15] get_profit_report
#  [3.16] audit_log table + get_audit_log
# ══════════════════════════════════════════════════════════════

import sqlite3, json, os, uuid, hashlib, hmac, secrets, csv, io, math, re

def light_columns(con, alias=""):
    from shop_ops import light_columns as columns
    return columns(con, alias)

from datetime import datetime, date, timedelta

DB_PATH     = os.path.join(os.path.dirname(__file__), "shop.db")
BACKUP_DIR  = os.path.join(os.path.dirname(__file__), "backups")
EXPORT_DIR  = os.path.join(os.path.dirname(__file__), "exports")

# ── in-memory login-failure tracker {username: (count, lockout_until)} ──
_LOGIN_FAILURES: dict = {}
_MAX_ATTEMPTS   = 5
_LOCKOUT_SECS   = 120


# ── low-level helpers ──────────────────────────────────────────
def _conn():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con

def _rows(cur):     return [dict(r) for r in cur.fetchall()]
def _ok(data=None): return json.dumps({"ok": True,  "data": data}, ensure_ascii=False, default=str)
def _err(msg: str): return json.dumps({"ok": False, "error": msg}, ensure_ascii=False)

def _new_id(prefix: str): return f"{prefix}-{uuid.uuid4().hex[:6].upper()}"

def auto_backup():
    """نسخة محلية متسقة ثم نسخة إضافية إن حدد المدير مكانها."""
    from backup_store import run_backup
    return run_backup()["path"]


# ── FIX [1.6]: atomic invoice numbering ───────────────────────
def _next_invoice(con):
    """Must be called inside a BEGIN IMMEDIATE transaction."""
    year = datetime.now().year
    row  = con.execute(
        "SELECT COALESCE(MAX(invoice_seq),0) FROM sales WHERE invoice_year=?", (year,)
    ).fetchone()
    seq = row[0] + 1
    return f"INV-{year}-{seq:03d}", seq, year


# ── FIX [2.8]: pbkdf2_hmac password hashing ───────────────────
_PBKDF2_ITERS = 260_000

def _hash_password(pwd: str, salt: str = None) -> str:
    """Returns  'pbkdf2:<salt>:<hash>'  so we can detect the format."""
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256", pwd.encode("utf-8"), salt.encode("utf-8"), _PBKDF2_ITERS
    )
    return f"pbkdf2:{salt}:{dk.hex()}"

def _verify_password(pwd: str, stored: str) -> bool:
    """Supports pbkdf2 (new), raw sha256 (old), and plain (seed legacy)."""
    if stored.startswith("pbkdf2:"):
        _, salt, _ = stored.split(":", 2)
        return hmac.compare_digest(_hash_password(pwd, salt), stored)
    # legacy sha256
    if stored == hashlib.sha256(pwd.encode()).hexdigest():
        return True
    # legacy plain (seeds before hashing was added)
    return stored == pwd


# ── audit log helper ──────────────────────────────────────────
def _audit(con, user_id: str, action: str, entity: str,
           entity_id: str, details: str = ""):
    if action in {"SAVE_POS_DRAFT", "SAVE_SCAN_DRAFT"} or entity in {"pos_draft", "scan_draft"}:
        return
    con.execute(
        "INSERT INTO audit_log(id,user_id,action,entity,entity_id,timestamp,details) "
        "VALUES(?,?,?,?,?,?,?)",
        (_new_id("AL"), user_id or "system", action, entity,
         entity_id, datetime.now().isoformat(), details)
    )


# ── role permission helper ────────────────────────────────────
_ROLE_PERMS = {
    "مدير النظام": {"all"},
    "مشرف المحل":  {"sales","products","customers","suppliers","reports","invoices","delivery_fleet","promotions","repairs"},
    "بائع":        {"sales","products_view","invoices_view","repairs"},
    "فني صيانة":   {"repairs","products_view"},
}
_ALLOWED_ROLES = frozenset(_ROLE_PERMS)


def _password_policy_error(password, allow_forced_default=False):
    if not isinstance(password, str):
        return "كلمة المرور غير صالحة"
    if allow_forced_default and password == "123456":
        return ""
    if len(password) < 8:
        return "كلمة المرور يجب ألا تقل عن 8 أحرف"
    if len(password) > 128:
        return "كلمة المرور أطول من الحد المسموح"
    return ""

def _has_perm(role: str, perm: str) -> bool:
    perms = _ROLE_PERMS.get(role, set())
    return "all" in perms or perm in perms


# ══════════════════════════════════════════════════════════════
#  SCHEMA INIT
# ══════════════════════════════════════════════════════════════
def init_db():
    con = _conn()
    con.executescript("""
    CREATE TABLE IF NOT EXISTS products (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        brand           TEXT,                       -- الماركة: سامسونج / شاومي / Total ...
        model           TEXT,                       -- الموديل أو رقم القطعة
        category        TEXT NOT NULL,
        price           REAL NOT NULL,
        cost            REAL    DEFAULT 0,
        stock           INTEGER DEFAULT 0,
        min_stock       INTEGER DEFAULT 5,
        unit            TEXT    DEFAULT 'قطعة',
        supplier_id     TEXT,
        barcode         TEXT,
        company_barcode TEXT,                       -- باركود الشركة المصنّعة
        shop_barcode    TEXT,                       -- باركود المحل الداخلي
        location        TEXT,
        description     TEXT,
        image_data      TEXT,
        track_serial    INTEGER DEFAULT 0,          -- 1 = يُباع برقم IMEI / Serial لكل وحدة
        warranty_months INTEGER DEFAULT 0,          -- مدة الضمان بالشهور (0 = بدون ضمان)
        is_service      INTEGER DEFAULT 0,          -- 1 = خدمة (بدون مخزون)
        purchase_unit   TEXT,
        sale_unit       TEXT,
        conversion_factor INTEGER DEFAULT 1,
        wholesale_price REAL,                       -- NULL = بدون سعر جملة
        wholesale_min_qty INTEGER DEFAULT 1,
        is_active       INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS customers (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        phone         TEXT NOT NULL,
        address       TEXT,
        notes         TEXT,
        created_at    TEXT,
        customer_type TEXT DEFAULT 'فرد',        -- فرد / جملة (تاجر)
        company_name  TEXT,
        tax_num       TEXT,
        credit_limit  REAL DEFAULT 0,             -- سقف الآجل لعملاء الجملة
        is_active     INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS suppliers (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        contact       TEXT,
        phone         TEXT,
        email         TEXT,
        address       TEXT,
        tax_num       TEXT,
        payment_terms TEXT,
        status        TEXT    DEFAULT 'نشط',
        rating        INTEGER DEFAULT 3,
        total_orders  INTEGER DEFAULT 0,
        last_order    TEXT,
        is_active     INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS purchases (
        id             TEXT PRIMARY KEY,
        po_num         TEXT UNIQUE,
        supplier_id    TEXT,
        supplier_name  TEXT,
        status         TEXT DEFAULT 'مفتوح',
        total_cost     REAL DEFAULT 0,
        notes          TEXT,
        created_by     TEXT,
        created_at     TEXT,
        received_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
        product_id      TEXT,
        product_name    TEXT,
        qty_ordered INTEGER DEFAULT 0,
        qty_received INTEGER DEFAULT 0,
        unit_cost   REAL DEFAULT 0,
        total_cost  REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS accounts (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL,
        balance     REAL DEFAULT 0,
        notes       TEXT,
        is_active   INTEGER DEFAULT 1,
        created_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
        id          TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL REFERENCES accounts(id),
        type        TEXT NOT NULL,
        amount      REAL NOT NULL,
        description TEXT,
        ref_type    TEXT,
        ref_id      TEXT,
        created_by  TEXT,
        created_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS cash_sessions (
        id           TEXT PRIMARY KEY,
        opened_by    TEXT,
        opened_at    TEXT,
        closed_by    TEXT,
        closed_at    TEXT,
        opening_cash REAL DEFAULT 0,
        closing_cash REAL DEFAULT 0,
        expected_cash REAL DEFAULT 0,
        difference   REAL DEFAULT 0,
        sales_total  REAL DEFAULT 0,
        status       TEXT DEFAULT 'مفتوحة'
    );

    CREATE TABLE IF NOT EXISTS employees (
        id           TEXT PRIMARY KEY,
        full_name    TEXT NOT NULL,
        role         TEXT,
        phone        TEXT,
        national_id  TEXT,
        hire_date    TEXT,
        salary       REAL DEFAULT 0,
        hourly_rate  REAL DEFAULT 0,
        is_active    INTEGER DEFAULT 1,
        notes        TEXT
    );

    CREATE TABLE IF NOT EXISTS payroll (
        id           TEXT PRIMARY KEY,
        employee_id  TEXT NOT NULL REFERENCES employees(id),
        period       TEXT NOT NULL,
        base_salary  REAL DEFAULT 0,
        bonus        REAL DEFAULT 0,
        deductions   REAL DEFAULT 0,
        net_pay      REAL DEFAULT 0,
        paid_at      TEXT,
        paid_by      TEXT,
        notes        TEXT
    );

    -- ── وحدة الشحن والتوزيع ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS drivers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        phone       TEXT,
        national_id TEXT,
        license_num TEXT,
        notes       TEXT,
        is_active   INTEGER DEFAULT 1,
        created_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS vehicles (
        id           TEXT PRIMARY KEY,
        plate_number TEXT NOT NULL,
        vehicle_type TEXT,
        capacity_note TEXT,
        notes        TEXT,
        is_active    INTEGER DEFAULT 1,
        created_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS delivery_trips (
        id           TEXT PRIMARY KEY,
        trip_num     TEXT UNIQUE,
        driver_id    TEXT REFERENCES drivers(id),
        vehicle_id   TEXT REFERENCES vehicles(id),
        status       TEXT DEFAULT 'قيد التجهيز',
        notes        TEXT,
        created_by   TEXT,
        created_at   TEXT,
        dispatched_at TEXT,
        completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS delivery_stops (
        id              TEXT PRIMARY KEY,
        trip_id         TEXT NOT NULL REFERENCES delivery_trips(id) ON DELETE CASCADE,
        seq             INTEGER DEFAULT 0,
        customer_id      TEXT,
        customer_name    TEXT,
        address         TEXT,
        phone           TEXT,
        barcode         TEXT UNIQUE,
        payment_mode    TEXT DEFAULT 'مسبق',
        expected_amount REAL DEFAULT 0,
        collected_amount REAL DEFAULT 0,
        status          TEXT DEFAULT 'قيد الانتظار',
        notes           TEXT,
        created_at      TEXT,
        delivered_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS delivery_stop_sales (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        stop_id TEXT NOT NULL REFERENCES delivery_stops(id) ON DELETE CASCADE,
        sale_id TEXT NOT NULL REFERENCES sales(id),
        amount  REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS promotions (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        product_id         TEXT NOT NULL REFERENCES products(id),
        discount_type  TEXT NOT NULL DEFAULT 'percent',   -- percent | fixed
        discount_value REAL NOT NULL DEFAULT 0,
        min_qty        INTEGER DEFAULT 1,
        start_date     TEXT,
        end_date       TEXT,
        is_active      INTEGER DEFAULT 1,
        created_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_promotions_product ON promotions(product_id);

    CREATE TABLE IF NOT EXISTS recurring_routes (
        id                   TEXT PRIMARY KEY,
        customer_id           TEXT NOT NULL REFERENCES customers(id),
        weekday              INTEGER NOT NULL,   -- 0=الإثنين ... 6=الأحد (Python date.weekday())
        driver_id            TEXT REFERENCES drivers(id),
        vehicle_id           TEXT REFERENCES vehicles(id),
        payment_mode         TEXT DEFAULT 'مسبق',
        is_active            INTEGER DEFAULT 1,
        last_generated_date  TEXT,
        notes                TEXT,
        created_at           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_routes_weekday ON recurring_routes(weekday);

    CREATE TABLE IF NOT EXISTS stock_adjustments (
        id          TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id),
        qty_before  INTEGER NOT NULL,
        qty_after   INTEGER NOT NULL,
        qty_change  INTEGER NOT NULL,
        reason      TEXT,
        notes       TEXT,
        user_id     TEXT,
        created_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stock_adjustments_product ON stock_adjustments(product_id);

    CREATE INDEX IF NOT EXISTS idx_purchases_supplier  ON purchases(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_items_po   ON purchase_items(purchase_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_acc    ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_date   ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_payroll_emp         ON payroll(employee_id);
    CREATE INDEX IF NOT EXISTS idx_stops_trip          ON delivery_stops(trip_id);
    CREATE INDEX IF NOT EXISTS idx_stops_barcode       ON delivery_stops(barcode);
    CREATE INDEX IF NOT EXISTS idx_stop_sales_stop     ON delivery_stop_sales(stop_id);


    CREATE TABLE IF NOT EXISTS sales (
        id              TEXT PRIMARY KEY,
        invoice_num     TEXT UNIQUE,
        invoice_seq     INTEGER DEFAULT 0,
        invoice_year    INTEGER DEFAULT 0,
        customer_id     TEXT,
        customer_name   TEXT,
        subtotal        REAL,
        discount        REAL DEFAULT 0,
        tax             REAL DEFAULT 0,
        total           REAL,
        payment_method  TEXT,
        cashier         TEXT,
        sale_date       TEXT,
        sale_time       TEXT,
        status          TEXT DEFAULT 'مكتمل',
        voided_by       TEXT,
        voided_at       TEXT,
        customer_amount REAL DEFAULT 0,          -- المطلوب من العميل بعد خصم النقاط
        loyalty_discount REAL DEFAULT 0,
        source          TEXT DEFAULT 'pos'       -- pos | repair
    );

    CREATE TABLE IF NOT EXISTS sale_items (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id  TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        product_id TEXT,
        name     TEXT,
        qty      INTEGER,
        price    REAL,
        total    REAL,
        cost     REAL DEFAULT 0,                 -- تكلفة الوحدة وقت البيع (لحساب الربح بدقة)
        serials  TEXT,                           -- أرقام IMEI/Serial المباعة (JSON)
        warranty_months INTEGER DEFAULT 0,
        warranty_end TEXT
    );

    CREATE TABLE IF NOT EXISTS debts (
        id TEXT PRIMARY KEY, customer_id TEXT, sale_id TEXT UNIQUE REFERENCES sales(id),
        amount REAL NOT NULL, paid_amount REAL DEFAULT 0, due_date TEXT,
        status TEXT DEFAULT 'مستحق', notes TEXT, created_at TEXT, updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS serial_units (
        id            TEXT PRIMARY KEY,
        product_id    TEXT NOT NULL REFERENCES products(id),
        serial        TEXT NOT NULL UNIQUE,      -- IMEI 1 أو Serial Number
        serial2       TEXT,                      -- IMEI 2 (للأجهزة ثنائية الشريحة)
        variant       TEXT,                      -- اللون / السعة ...
        status        TEXT NOT NULL DEFAULT 'متاح',   -- متاح | مباع | تالف | مرتجع للمورد
        cost          REAL DEFAULT 0,
        purchase_id   TEXT,
        received_date TEXT,
        sale_id       TEXT,
        sold_date     TEXT,
        sold_price    REAL,
        customer_id   TEXT,
        customer_name TEXT,
        warranty_months INTEGER DEFAULT 0,
        warranty_end  TEXT,
        notes         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_serial_product ON serial_units(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_serial_sale    ON serial_units(sale_id);
    CREATE INDEX IF NOT EXISTS idx_serial2        ON serial_units(serial2);

    CREATE TABLE IF NOT EXISTS repair_tickets (
        id             TEXT PRIMARY KEY,
        ticket_num     TEXT UNIQUE,
        customer_id    TEXT,
        customer_name  TEXT NOT NULL,
        phone          TEXT,
        device_type    TEXT DEFAULT 'موبايل',     -- موبايل / تابلت / أداة كهربائية / أخرى
        device_brand   TEXT,
        device_model   TEXT,
        imei           TEXT,
        accessories    TEXT,                      -- ما تم استلامه مع الجهاز
        issue          TEXT NOT NULL,
        diagnosis      TEXT,
        status         TEXT DEFAULT 'استلام',
        estimated_cost REAL DEFAULT 0,
        labor_cost     REAL DEFAULT 0,
        deposit        REAL DEFAULT 0,
        in_warranty    INTEGER DEFAULT 0,         -- 1 = صيانة تحت الضمان (بدون مقابل)
        technician_id  TEXT,
        technician_name TEXT,
        promised_date  TEXT,
        received_at    TEXT,
        completed_at   TEXT,
        delivered_at   TEXT,
        sale_id        TEXT,
        warranty_days  INTEGER DEFAULT 30,        -- ضمان الصيانة بعد التسليم
        warranty_end   TEXT,
        notes          TEXT,
        created_by     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_repair_status ON repair_tickets(status);
    CREATE INDEX IF NOT EXISTS idx_repair_imei   ON repair_tickets(imei);

    CREATE TABLE IF NOT EXISTS repair_parts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id  TEXT NOT NULL REFERENCES repair_tickets(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        name       TEXT,
        qty        INTEGER NOT NULL DEFAULT 1,
        price      REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS repair_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id  TEXT NOT NULL REFERENCES repair_tickets(id) ON DELETE CASCADE,
        status     TEXT,
        note       TEXT,
        user_id    TEXT,
        created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS loyalty_points (
        customer_id TEXT PRIMARY KEY, points REAL DEFAULT 0, last_updated TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        username    TEXT UNIQUE NOT NULL,
        password    TEXT NOT NULL,
        full_name   TEXT NOT NULL,
        role        TEXT DEFAULT 'بائع',
        phone       TEXT,
        email       TEXT,
        created_at  TEXT,
        last_login  TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
        id        TEXT PRIMARY KEY,
        user_id   TEXT,
        action    TEXT,
        entity    TEXT,
        entity_id TEXT,
        timestamp TEXT,
        details   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_date     ON sales(sale_date);
    CREATE INDEX IF NOT EXISTS idx_sales_year_seq ON sales(invoice_year, invoice_seq);
    CREATE INDEX IF NOT EXISTS idx_items_sale     ON sale_items(sale_id);
    CREATE INDEX IF NOT EXISTS idx_items_product      ON sale_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_debts_status   ON debts(status,due_date);
    CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_entity   ON audit_log(entity, entity_id);
    """)

    # إصدارات سابقة كانت تسجل كل حفظ تلقائي لمسودات البيع والمسح، ما كان
    # يملأ سجل النشاط بآلاف الأسطر غير الرقابية. نحذف الضوضاء القديمة مرة
    # عند التشغيل ونترك صفحات SQLite الحرة لإعادة استخدامها مستقبلاً.
    con.execute("DELETE FROM audit_log WHERE action IN ('SAVE_POS_DRAFT','SAVE_SCAN_DRAFT') OR entity IN ('pos_draft','scan_draft')")

    # ── migrations ──
    from camera_api import init_schema
    init_schema(con)
    def _add_col(table, col, typedef):
        cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()}
        if col not in cols:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typedef}")

    # أعمدة أُضيفت بعد الإصدار الأول لجداول لا يعاد إنشاؤها
    _add_col("suppliers", "is_active",    "INTEGER DEFAULT 1")
    _add_col("purchases", "invoice_image_data", "TEXT")
    _add_col("purchases", "supplier_invoice_num", "TEXT")
    _add_col("purchases", "invoice_date", "TEXT")
    _add_col("purchases", "source", "TEXT DEFAULT 'manual'")
    _add_col("sales", "payment_proof_image", "TEXT")
    _add_col("cash_sessions", "card_total",     "REAL DEFAULT 0")
    _add_col("cash_sessions", "transfer_total", "REAL DEFAULT 0")
    _add_col("cash_sessions", "credit_total",   "REAL DEFAULT 0")
    _add_col("cash_sessions", "actual_card",    "REAL DEFAULT 0")
    _add_col("cash_sessions", "actual_transfer","REAL DEFAULT 0")
    _add_col("cash_sessions", "actual_credit",  "REAL DEFAULT 0")
    con.execute("UPDATE products SET purchase_unit=COALESCE(NULLIF(purchase_unit,''),unit,'قطعة')")
    con.execute("UPDATE products SET sale_unit=COALESCE(NULLIF(sale_unit,''),unit,'قطعة')")
    con.execute("UPDATE products SET conversion_factor=1 WHERE conversion_factor IS NULL OR conversion_factor<1")
    from shop_ops import init_schema as init_operations_schema
    init_operations_schema(con)
    from inventory_entry import init_schema as init_inventory_schema
    init_inventory_schema(con)
    # خدمة أجرة اليد العاملة تُستخدم في فواتير الصيانة
    con.execute(
        "INSERT OR IGNORE INTO products(id,name,category,price,cost,stock,min_stock,unit,purchase_unit,sale_unit,"
        "conversion_factor,is_service,is_active) VALUES('SRV-LABOR','أجرة صيانة (يد عاملة)','خدمات',0,0,0,0,'خدمة','خدمة','خدمة',1,1,1)"
    )
    # back-fill invoice_seq / invoice_year
    needs_fill = con.execute(
        "SELECT COUNT(*) FROM sales WHERE invoice_seq=0 AND invoice_num IS NOT NULL"
    ).fetchone()[0]
    if needs_fill:
        for row in con.execute("SELECT id,invoice_num FROM sales").fetchall():
            try:
                parts = row["invoice_num"].split("-")
                con.execute(
                    "UPDATE sales SET invoice_year=?,invoice_seq=? WHERE id=?",
                    (int(parts[1]), int(parts[2]), row["id"])
                )
            except Exception:
                pass

    con.commit()
    con.close()


# ══════════════════════════════════════════════════════════════
#  SEED
# ══════════════════════════════════════════════════════════════
def _luhn_imei(body14: str) -> str:
    """يضيف رقم التحقق (Luhn) لجسم IMEI من 14 رقمًا فيصبح 15 رقمًا صحيحًا."""
    total = 0
    for i, ch in enumerate(reversed(body14)):
        n = int(ch)
        if i % 2 == 0:
            n *= 2
            if n > 9: n -= 9
        total += n
    return body14 + str((10 - total % 10) % 10)


def seed_if_empty():
    con = _conn()

    # ── users seed ──
    if con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        today = date.today().isoformat()
        users = [
            (_new_id("U"), "admin",       _hash_password("admin123"),  "أحمد محمد",     "مدير النظام", "01000000001", "admin@techmarket.local",   today, None),
            (_new_id("U"), "supervisor",  _hash_password("123456"),    "خالد السعيد",   "مشرف المحل",  "01000000002", "khaled@techmarket.local",  today, None),
            (_new_id("U"), "cashier",     _hash_password("123456"),    "نورا عبد الله", "بائع",        "01000000003", "noura@techmarket.local",   today, None),
            (_new_id("U"), "technician",  _hash_password("123456"),    "كريم عادل",     "فني صيانة",   "01000000004", "karim@techmarket.local",   today, None),
        ]
        con.executemany(
            "INSERT INTO users(id,username,password,full_name,role,phone,email,created_at,last_login)"
            " VALUES(?,?,?,?,?,?,?,?,?)", users
        )
        con.commit()

    if con.execute("SELECT COUNT(*) FROM products WHERE id!='SRV-LABOR'").fetchone()[0] > 0:
        con.close(); return

    from shop_ops import add_months
    today_d   = date.today()
    today     = today_d.isoformat()
    year      = today_d.year

    # ── الإعدادات الافتراضية ──
    for key, value in {
        "shop_name": "تك ماركت", "shop_phone": "01000000000", "shop_address": "شارع الجمهورية، مصر",
        "currency_symbol": "ج.م", "tax_rate": "0", "loyalty_amount_per_point": "100", "loyalty_point_value": "1",
        "default_repair_warranty_days": "30",
    }.items():
        con.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (key, value))

    # ── الموردون ──
    suppliers = [
        ("S001","الشركة المصرية للموبايلات","محمود سعيد","01001234567","info@egy-mobiles.example","القاهرة، وسط البلد","200-100-345","30 يوم","نشط",5,45,(today_d-timedelta(days=10)).isoformat(),1),
        ("S002","النور للإلكترونيات والإكسسوارات","سامي العتيبي","01112345678","sales@alnour-el.example","الإسكندرية، سموحة","200-200-456","15 يوم","نشط",4,38,(today_d-timedelta(days=15)).isoformat(),1),
        ("S003","الأمل للأدوات الكهربائية","هاني الدسوقي","01223456789","info@alamal-tools.example","القاهرة، شبرا الخيمة","200-300-567","45 يوم","نشط",4,22,(today_d-timedelta(days=30)).isoformat(),1),
        ("S004","التقنية لقطع الغيار","ليلى الشناوي","01234567890","parts@altiqnia.example","الجيزة، الدقي","200-400-678","نقدًا","غير نشط",3,15,(today_d-timedelta(days=60)).isoformat(),1),
    ]
    con.executemany("INSERT INTO suppliers(id,name,contact,phone,email,address,tax_num,payment_terms,status,rating,total_orders,last_order,is_active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", suppliers)

    # ── الأصناف ──
    # (id, name, brand, model, category, price, cost, stock, min, unit, supplier, barcode, location, desc, track, warranty, service, purchase_unit, factor, wholesale, wholesale_min)
    P = lambda *a, **k: (a, k)
    catalog = [
        # موبايلات (تُباع برقم IMEI؛ المخزون = عدد الوحدات المتاحة)
        ("PH-IP13","آيفون 13 - 128GB","Apple","iPhone 13","موبايلات",34500,31800,0,2,"جهاز","S001","6900000100013","A-1","آيفون 13 ذاكرة 128 جيجا",1,12),
        ("PH-A15","سامسونج جالكسي A15 - 128GB","Samsung","Galaxy A15","موبايلات",9800,8900,0,3,"جهاز","S001","6900000100015","A-2","شاشة 6.5 بوصة، كاميرا 50 ميجا",1,24),
        ("PH-RN13","شاومي ريدمي نوت 13 - 256GB","Xiaomi","Redmi Note 13","موبايلات",12200,11100,0,3,"جهاز","S001","6900000100016","A-3","شاشة AMOLED، شحن سريع 33 وات",1,18),
        ("PH-OP58","أوبو A58 - 128GB","Oppo","A58","موبايلات",8500,7700,0,3,"جهاز","S001","6900000100017","A-4","بطارية 5000 mAh",1,12),
        ("PH-INF40","إنفينكس هوت 40i - 128GB","Infinix","Hot 40i","موبايلات",5900,5200,0,4,"جهاز","S002","6900000100018","A-5","اقتصادي للاستخدام اليومي",1,12),
        ("PH-RC55","ريلمي C55 - 128GB","Realme","C55","موبايلات",7400,6700,0,3,"جهاز","S002","6900000100019","A-6","شحن سريع 33 وات",1,12),
        # إكسسوارات الموبايل
        ("AC-CH25","شاحن سريع 25 وات (Type-C)","Samsung","EP-TA800","إكسسوارات موبايل",450,300,40,10,"قطعة","S002","6900000200001","B-1","شاحن أصلي",0,6),
        ("AC-CBC1","كابل Type-C - 1 متر","Anker","A8852","إكسسوارات موبايل",120,60,120,30,"قطعة","S002","6900000200002","B-2","كابل شحن ونقل بيانات",0,3),
        ("AC-CBL1","كابل آيفون Lightning - 1 متر","Apple","MFi","إكسسوارات موبايل",250,150,35,10,"قطعة","S002","6900000200003","B-3","كابل معتمد MFi",0,6),
        ("AC-TWS","سماعة بلوتوث لاسلكية TWS","Soundcore","P20i","إكسسوارات موبايل",550,330,22,8,"قطعة","S002","6900000200004","B-4","سماعة أذن لاسلكية",0,6),
        ("AC-PB10","باور بانك 10000 mAh","Anker","A1229","إكسسوارات موبايل",780,520,18,6,"قطعة","S002","6900000200005","B-5","شحن سريع 22.5 وات",0,12),
        ("AC-CASE","جراب حماية سيليكون","-","-","إكسسوارات موبايل",90,40,90,20,"قطعة","S002","6900000200006","B-6","متوفر لمعظم الموديلات",0,0),
        ("AC-SCR","اسكرين حماية زجاج","-","-","إكسسوارات موبايل",60,20,150,40,"قطعة","S002","6900000200007","B-7","زجاج مقوى 9H",0,0),
        ("AC-SD128","كارت ذاكرة microSD 128GB","SanDisk","Ultra","إكسسوارات موبايل",380,270,25,8,"قطعة","S002","6900000200008","B-8","سرعة 120MB/s",0,12),
        # أدوات كهربائية
        ("TL-DRL13","دريل كهربائي 13 مم - 750 وات","Total","TG1071336","أدوات كهربائية",1650,1250,12,4,"قطعة","S003","6900000300001","C-1","دريل بمقبض جانبي",0,12),
        ("TL-GRD45","صاروخ 4.5 بوصة - 900 وات","Bosch","GWS 900","أدوات كهربائية",1350,1000,9,3,"قطعة","S003","6900000300002","C-2","صاروخ قطع وجلخ",0,12),
        ("TL-SCRD","مفك شحن 12 فولت","Total","TDLI12325","أدوات كهربائية",1950,1500,6,3,"قطعة","S003","6900000300003","C-3","بطاريتين وشاحن",0,12),
        ("TL-SET32","طقم مفكات 32 قطعة","Stanley","-","أدوات كهربائية",320,190,20,5,"طقم","S003","6900000300004","C-4","طقم مفكات دقيقة ومتعددة",0,0),
        # مستلزمات كهرباء
        ("EL-LED12","لمبة LED 12 وات","Philips","-","مستلزمات كهرباء",45,28,200,50,"قطعة","S003","6900000400001","D-1","إضاءة بيضاء",0,6),
        ("EL-EXT5","مشترك كهرباء 5 مخارج - 4 متر","Schneider","-","مستلزمات كهرباء",210,140,30,10,"قطعة","S003","6900000400002","D-2","بحماية من الحمل الزائد",0,6),
        ("EL-CBL15","كابل كهرباء 3×1.5 مم","الكابلات المصرية","-","مستلزمات كهرباء",68,50,400,100,"متر","S003","6900000400003","D-3","نحاس 100%",0,0),
        ("EL-MCB16","قاطع كهرباء 16 أمبير","Schneider","-","مستلزمات كهرباء",95,60,45,15,"قطعة","S003","6900000400004","D-4","قاطع أوتوماتيك",0,12),
        ("EL-TAPE","شريط عازل","3M","-","مستلزمات كهرباء",18,9,100,25,"قطعة","S003","6900000400005","D-5","شريط عزل كهربائي",0,0),
        ("EL-FLD50","كشاف LED 50 وات","Philips","-","مستلزمات كهرباء",380,240,14,5,"قطعة","S003","6900000400006","D-6","مقاوم للماء IP65",0,12),
        # قطع غيار
        ("SP-SCR-A15","شاشة سامسونج A15 أصلية","Samsung","Galaxy A15","قطع غيار",1450,1050,5,2,"قطعة","S004","6900000500001","E-1","شاشة كاملة بالإطار",0,3),
        ("SP-BAT-A15","بطارية سامسونج A15","Samsung","Galaxy A15","قطع غيار",420,260,10,3,"قطعة","S004","6900000500002","E-2","بطارية أصلية",0,3),
        ("SP-BAT-IP13","بطارية آيفون 13","Apple","iPhone 13","قطع غيار",950,620,4,2,"قطعة","S004","6900000500003","E-3","بطارية عالية الجودة",0,3),
        ("SP-PORT-C","بورت شحن Type-C","-","-","قطع غيار",120,55,25,8,"قطعة","S004","6900000500004","E-4","بورت شحن بديل",0,1),
        # خدمات
        ("SRV-PROT","تركيب اسكرين حماية","-","-","خدمات",30,0,0,0,"خدمة","","", "","تركيب مع تنظيف الشاشة",0,0),
        ("SRV-DATA","نقل بيانات بين جهازين","-","-","خدمات",100,0,0,0,"خدمة","","", "","نقل صور وجهات اتصال وتطبيقات",0,0),
        ("SRV-SOFT","تفليش / تحديث سوفت وير","-","-","خدمات",150,0,0,0,"خدمة","","", "","تحديث النظام أو إعادة ضبط المصنع",0,0),
    ]
    # وحدات الشراء المتعددة وأسعار الجملة (أمثلة)
    pack = {"EL-LED12": ("كرتونة", 10), "EL-CBL15": ("لفة", 100), "AC-CASE": ("علبة", 12)}
    wholesale = {"PH-INF40": (5650, 2), "AC-CH25": (400, 5), "AC-CBC1": (95, 10), "EL-LED12": (38, 20)}
    # عدد الوحدات (متاحة، مباعة) لكل جهاز لتوليد أرقام IMEI
    unit_plan = {"PH-IP13": (4, 0), "PH-A15": (6, 1), "PH-RN13": (5, 1), "PH-OP58": (3, 0), "PH-INF40": (8, 3), "PH-RC55": (2, 0)}

    rows = []
    for (pid, name, brand, model, cat, price, cost, stock, mn, unit, sup, barcode, loc, desc, track, warr) in catalog:
        service = 1 if cat == "خدمات" else 0
        if track:
            stock = unit_plan[pid][0]
        punit, factor = pack.get(pid, (unit, 1))
        wp, wmin = wholesale.get(pid, (None, 1))
        rows.append((pid, name, brand, model, cat, price, cost, stock, mn, unit, sup or None, barcode or None, loc or None,
                     desc, track, warr, service, punit, unit, factor, wp, wmin, 1))
    con.executemany(
        "INSERT OR IGNORE INTO products(id,name,brand,model,category,price,cost,stock,min_stock,unit,supplier_id,barcode,location,"
        "description,track_serial,warranty_months,is_service,purchase_unit,sale_unit,conversion_factor,wholesale_price,wholesale_min_qty,is_active)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    prod = {r[0]: r for r in rows}

    # ── العملاء ──
    customers = [
        ("C001","محمد أحمد علي","01012345678","شبين الكوم، المنوفية","عميل منتظم",(today_d-timedelta(days=400)).isoformat(),"فرد",None,None,0,1),
        ("C002","فاطمة حسن محمود","01112345678","الإسكندرية، سموحة","",(today_d-timedelta(days=300)).isoformat(),"فرد",None,None,0,1),
        ("C003","خالد عبد الله السعيد","01212345678","القاهرة، مدينة نصر","يفضل الأجهزة الأصلية",(today_d-timedelta(days=250)).isoformat(),"فرد",None,None,0,1),
        ("C004","سارة محمود إبراهيم","01512345678","طنطا، الغربية","",(today_d-timedelta(days=200)).isoformat(),"فرد",None,None,0,1),
        ("C005","عمر يوسف الشافعي","01098765432","المنصورة، الدقهلية","مقاول كهرباء",(today_d-timedelta(days=150)).isoformat(),"فرد",None,None,0,1),
        ("C006","مؤسسة الفتح للاتصالات","01087654321","القاهرة، العتبة","تاجر جملة — يشتري بالآجل",(today_d-timedelta(days=120)).isoformat(),"جملة","مؤسسة الفتح للاتصالات","300-555-111",50000,1),
    ]
    con.executemany("INSERT INTO customers(id,name,phone,address,notes,created_at,customer_type,company_name,tax_num,credit_limit,is_active) VALUES(?,?,?,?,?,?,?,?,?,?,?)", customers)
    cust = {c[0]: c for c in customers}

    # ── أرقام IMEI للأجهزة ──
    counter = [100000]
    units_avail, units_sold = {}, {}
    for pid, (n_av, n_sold) in unit_plan.items():
        p = prod[pid]
        brand_code = 350000 + list(unit_plan).index(pid) * 1000
        def make():
            counter[0] += 1
            return _luhn_imei(f"35{brand_code:06d}{counter[0]:06d}")
        received = (today_d - timedelta(days=20 + list(unit_plan).index(pid) * 9)).isoformat()
        units_avail[pid] = []
        for _ in range(n_av):
            uid, sn = _new_id("SU"), make()
            units_avail[pid].append(uid)
            con.execute("INSERT INTO serial_units(id,product_id,serial,status,cost,received_date) VALUES(?,?,?,'متاح',?,?)",
                        (uid, pid, sn, p[6], received))
        units_sold[pid] = []
        for _ in range(n_sold):
            uid, sn = _new_id("SU"), make()
            units_sold[pid].append((uid, sn))
            con.execute("INSERT INTO serial_units(id,product_id,serial,status,cost,received_date) VALUES(?,?,?,'مباع',?,?)",
                        (uid, pid, sn, p[6], received))

    # ── الفواتير ──
    def sale(seq, sid, cid, cname, day_offset, time_s, method, items, discount=0.0, paid=None, due_days=30):
        s_date = (today_d - timedelta(days=day_offset)).isoformat()
        subtotal = sum(price * qty for _, qty, price in items)
        total = round(subtotal - discount, 2)
        con.execute(
            "INSERT INTO sales(id,invoice_num,invoice_seq,invoice_year,customer_id,customer_name,subtotal,discount,tax,total,"
            "payment_method,cashier,sale_date,sale_time,status,customer_amount,loyalty_discount,source)"
            " VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,?,'مكتمل',?,0,'pos')",
            (sid, f"INV-{year}-{seq:03d}", seq, year, cid, cname, subtotal, discount, total, method, "أحمد محمد", s_date, time_s, total))
        for pid, qty, price in items:
            p = prod[pid]; months = p[15]
            w_end = add_months(date.fromisoformat(s_date), months).isoformat() if months else None
            serials, cost = None, p[6]
            if p[14]:
                picked = [units_sold[pid].pop(0) for _ in range(qty)]
                serials = json.dumps([sn for _, sn in picked], ensure_ascii=False)
                for uid, sn in picked:
                    con.execute("UPDATE serial_units SET sale_id=?,sold_date=?,sold_price=?,customer_id=?,customer_name=?,warranty_months=?,warranty_end=? WHERE id=?",
                                (sid, s_date, price, cid, cname, months, w_end, uid))
            con.execute(
                "INSERT INTO sale_items(sale_id,product_id,name,qty,price,total,cost,serials,warranty_months,warranty_end) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (sid, pid, p[1], qty, price, price * qty, cost, serials, months, w_end))
        if method == "آجل":
            paid = paid or 0
            status = "مسدد" if paid >= total else "مسدد جزئياً" if paid > 0 else "مستحق"
            con.execute(
                "INSERT INTO debts(id,customer_id,sale_id,amount,paid_amount,due_date,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (_new_id("DEBT"), cid, sid, total, paid, (date.fromisoformat(s_date) + timedelta(days=due_days)).isoformat(),
                 status, "", s_date, s_date))

    sale(1, "SL001", "C001", "محمد أحمد علي", 0, "09:15", "نقدي", [("PH-INF40", 1, 5900), ("AC-CASE", 1, 90), ("AC-SCR", 1, 60), ("SRV-PROT", 1, 30)])
    sale(2, "SL002", "C002", "فاطمة حسن محمود", 0, "10:30", "بطاقة", [("AC-CH25", 1, 450), ("AC-CBC1", 2, 120), ("AC-TWS", 1, 550)])
    sale(3, "SL003", "C003", "خالد عبد الله السعيد", 1, "11:45", "نقدي", [("PH-A15", 1, 9800), ("AC-SD128", 1, 380)], discount=100)
    sale(4, "SL004", None, "عميل عادي", 1, "14:20", "نقدي", [("EL-LED12", 6, 45), ("EL-EXT5", 1, 210), ("EL-TAPE", 2, 18)])
    sale(5, "SL005", "C005", "عمر يوسف الشافعي", 2, "16:00", "تحويل", [("TL-DRL13", 1, 1650), ("TL-SET32", 1, 320), ("TL-GRD45", 1, 1350)])
    sale(6, "SL006", "C004", "سارة محمود إبراهيم", 2, "09:00", "بطاقة", [("PH-RN13", 1, 12200)])
    sale(7, "SL007", "C006", "مؤسسة الفتح للاتصالات", 3, "12:10", "آجل", [("PH-INF40", 2, 5650)], paid=5000)

    # ── حسابات افتراضية ──
    if con.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] == 0:
        accounts_seed = [
            (_new_id("AC"), "الصندوق الرئيسي",     "نقدي",     0.0, "الصندوق الرئيسي للمحل",     1, today),
            (_new_id("AC"), "البنك",                "بنكي",     0.0, "الحساب البنكي",             1, today),
            (_new_id("AC"), "محفظة إلكترونية",      "بنكي",     0.0, "فودافون كاش / إنستاباي",    1, today),
            (_new_id("AC"), "مصروفات التشغيل",      "مصروف",    0.0, "مصروفات المحل اليومية",     1, today),
            (_new_id("AC"), "إيجار المحل",          "مصروف",    0.0, "إيجار شهري",               1, today),
            (_new_id("AC"), "رواتب الموظفين",       "مصروف",    0.0, "رواتب وأجور",              1, today),
        ]
        con.executemany("INSERT INTO accounts(id,name,type,balance,notes,is_active,created_at) VALUES(?,?,?,?,?,?,?)", accounts_seed)

    # ── موظفون ──
    if con.execute("SELECT COUNT(*) FROM employees").fetchone()[0] == 0:
        con.execute("INSERT INTO employees(id,full_name,role,phone,national_id,hire_date,salary,hourly_rate,is_active,notes) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    ("EMP-ADMIN1", "أحمد محمد", "مدير المحل", "01000000001", "", today, 9000.0, 50.0, 1, ""))
        con.execute("INSERT INTO employees(id,full_name,role,phone,national_id,hire_date,salary,hourly_rate,is_active,notes) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    ("EMP-TECH01", "كريم عادل", "فني صيانة", "01000000004", "", today, 6500.0, 35.0, 1, ""))

    # ── تذاكر صيانة تجريبية ──
    now = datetime.now()
    def ticket(seq, cid, cname, phone, dtype, brand, model, imei, issue, status, est, labor, deposit, days_ago, parts=(), diagnosis=""):
        tid = _new_id("RP")
        rec = (now - timedelta(days=days_ago)).isoformat()
        con.execute(
            "INSERT INTO repair_tickets(id,ticket_num,customer_id,customer_name,phone,device_type,device_brand,device_model,imei,issue,diagnosis,"
            "status,estimated_cost,labor_cost,deposit,technician_id,technician_name,promised_date,received_at,created_by)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (tid, f"RP-{year}-{seq:03d}", cid, cname, phone, dtype, brand, model, imei, issue, diagnosis, status, est, labor, deposit,
             "EMP-TECH01", "كريم عادل", (today_d + timedelta(days=2)).isoformat(), rec, "system"))
        con.execute("INSERT INTO repair_log(ticket_id,status,note,user_id,created_at) VALUES(?,?,?,?,?)", (tid, "استلام", "استلام الجهاز", "system", rec))
        if status != "استلام":
            con.execute("INSERT INTO repair_log(ticket_id,status,note,user_id,created_at) VALUES(?,?,?,?,?)", (tid, status, "", "system", now.isoformat()))
        for pid, qty in parts:
            con.execute("INSERT INTO repair_parts(ticket_id,product_id,name,qty,price) VALUES(?,?,?,?,?)", (tid, pid, prod[pid][1], qty, prod[pid][5]))
    ticket(1, "C002", "فاطمة حسن محمود", "01112345678", "موبايل", "Samsung", "Galaxy A15", "", "الشاشة مكسورة والتاتش لا يعمل", "قيد الإصلاح", 1900, 300, 500, 1,
           parts=[("SP-SCR-A15", 1)], diagnosis="تغيير الشاشة بالكامل")
    ticket(2, "C003", "خالد عبد الله السعيد", "01212345678", "موبايل", "Apple", "iPhone 13", "", "البطارية تفرغ بسرعة والجهاز يسخن", "جاهز للتسليم", 1200, 250, 300, 3,
           parts=[("SP-BAT-IP13", 1)], diagnosis="تغيير البطارية")
    ticket(3, None, "عميل عادي", "01555555555", "موبايل", "Xiaomi", "Redmi Note 13", "", "لا يشحن", "قيد الفحص", 0, 0, 0, 0)

    con.commit()
    con.close()


# ══════════════════════════════════════════════════════════════
#  API CLASS
# ══════════════════════════════════════════════════════════════
#  مساعدات المنتجات والأرقام التسلسلية والضمان
# ══════════════════════════════════════════════════════════════
def _barcode_conflict(con, d, pid=None):
    """يرجع رسالة خطأ إن كان أي باركود مستخدمًا لصنف آخر، وإلا None."""
    from camera_api import resolve
    labels = (("barcode", "الباركود"), ("company_barcode", "باركود الشركة"), ("shop_barcode", "باركود المحل"))
    for key, label in labels:
        code = str(d.get(key) or "").strip()
        if not code:
            continue
        dup = con.execute(f"SELECT name FROM products WHERE {key}=? AND is_active=1 AND id!=?", (code, pid or "")).fetchone()
        if dup:
            return f"{label} '{code}' مستخدم بالفعل للصنف: {dup['name']}"
        match = resolve(con, code)
        alias = con.execute("SELECT product_id FROM product_barcodes WHERE barcode=?", (code,)).fetchone()
        if (match and match["id"] != pid) or (alias and alias[0] != pid):
            return "الباركود مرتبط بصنف أو وحدة أخرى بالفعل"
    return None


def _insert_serial_units(con, product, entries, cost, purchase_id=None, received_date=None, variant=None, notes=None):
    """يسجّل وحدات (IMEI/Serial) لصنف متتبَّع ويزيد رصيده بعددها. يرجع عدد الوحدات المضافة."""
    from shop_ops import clean_serials
    received_date = received_date or date.today().isoformat()
    count = 0
    seen = set()
    for entry in entries:
        if isinstance(entry, str):
            entry = {"serial": entry}
        serial = clean_serials([entry.get("serial")])
        if not serial:
            continue
        serial = serial[0]
        serial2 = clean_serials([entry.get("serial2")]) if entry.get("serial2") else []
        serial2 = serial2[0] if serial2 else None
        for code in filter(None, (serial, serial2)):
            if code in seen:
                raise ValueError(f"رقم مكرر في القائمة: {code}")
            seen.add(code)
            used = con.execute("SELECT serial FROM serial_units WHERE serial=? OR serial2=?", (code, code)).fetchone()
            if used:
                raise ValueError(f"الرقم {code} مسجل بالفعل في المخزون")
        con.execute(
            "INSERT INTO serial_units(id,product_id,serial,serial2,variant,status,cost,purchase_id,received_date,notes)"
            " VALUES(?,?,?,?,?,'متاح',?,?,?,?)",
            (_new_id("SU"), product["id"], serial, serial2, entry.get("variant") or variant, cost, purchase_id, received_date,
             entry.get("notes") or notes))
        count += 1
    if count:
        con.execute("UPDATE products SET stock=stock+? WHERE id=?", (count, product["id"]))
    return count


def _restore_sale_stock(con, sale_id):
    """يرجع مخزون فاتورة ملغاة أو مرتجعة (كمية الأصناف + وحدات IMEI)."""
    from shop_ops import release_serials
    items = _rows(con.execute(
        "SELECT si.product_id, si.qty, COALESCE(p.is_service,0) AS is_service FROM sale_items si "
        "LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=?", (sale_id,)))
    for it in items:
        if it["product_id"] and not it["is_service"]:
            con.execute("UPDATE products SET stock=stock+? WHERE id=?", (it["qty"], it["product_id"]))
    release_serials(con, sale_id)


def _warranty_state(warranty_end):
    """حالة الضمان: (نشط؟, الأيام المتبقية)."""
    if not warranty_end:
        return False, None
    days = (date.fromisoformat(warranty_end) - date.today()).days
    return days >= 0, days


def _log_adjustment(con, product_id, before, after, reason, user_id=None, notes=""):
    """يسجّل حركة تسوية مخزون في stock_adjustments (تظهر في سجل حركة الصنف)."""
    con.execute(
        "INSERT INTO stock_adjustments(id,product_id,qty_before,qty_after,qty_change,reason,notes,user_id,created_at)"
        " VALUES(?,?,?,?,?,?,?,?,?)",
        (_new_id("ADJ"), product_id, before, after, after - before, reason, notes, user_id, datetime.now().isoformat()))


REPAIR_STATUSES = ("استلام", "قيد الفحص", "بانتظار موافقة العميل", "قيد الإصلاح", "جاهز للتسليم", "تم التسليم", "ملغي")


# ══════════════════════════════════════════════════════════════
class ShopAPI:

    # ── PRODUCTS ─────────────────────────────────────────────
    def get_products(self, limit: int = 100, offset: int = 0, q: str = None):
        con = _conn()
        try:
            where = ["is_active = 1"]
            params = []
            if q:
                like = f"%{str(q).strip()}%"
                where.append("(name LIKE ? OR brand LIKE ? OR model LIKE ? OR category LIKE ? OR barcode LIKE ? OR company_barcode LIKE ? OR shop_barcode LIKE ?)")
                params += [like, like, like, like, like, like, like]
            where_clause = " AND ".join(where)
            rows = _rows(con.execute(
                f"SELECT {light_columns(con)} FROM products WHERE {where_clause} "
                f"ORDER BY name ASC LIMIT ? OFFSET ?",
                params + [limit, offset]))
            total = con.execute(
                f"SELECT COUNT(*) FROM products WHERE {where_clause}", params
            ).fetchone()[0]
            con.close()
            return _ok({"products": rows, "total": total, "limit": limit, "offset": offset, "has_more": (offset + limit) < total})
        except Exception as e:
            con.close()
            return _err(str(e))

    def get_product(self, mid: str, include_image: bool = True):
        con = _conn()
        columns = light_columns(con) + (",image_data" if include_image else "")
        row = con.execute(f"SELECT {columns} FROM products WHERE id=?", (mid,)).fetchone()
        con.close(); return _ok(dict(row) if row else None)

    def get_product_by_barcode(self, barcode: str):
        """أولوية المطابقة: باركود المحل ثم الشركة ثم الباركود القديم ثم رقم IMEI/Serial."""
        from camera_api import resolve
        con = _conn()
        try: return _ok(resolve(con, barcode))
        finally: con.close()

    def export_products_csv(self):
        """يحفظ كشف الأصناف فعليًا على القرص بدل الاعتماد على تنزيل WebView."""
        con = None
        try:
            con = _conn()
            rows = _rows(con.execute(
                "SELECT barcode,shop_barcode,company_barcode,name,brand,model,category,cost,price,stock,"
                "warranty_months,location,is_service FROM products WHERE is_active=1 ORDER BY name"
            ))
            os.makedirs(EXPORT_DIR, exist_ok=True)
            filename = f"products_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.csv"
            path = os.path.abspath(os.path.join(EXPORT_DIR, filename))
            with open(path, "w", encoding="utf-8-sig", newline="") as output:
                writer = csv.writer(output)
                writer.writerow(["الباركود", "الصنف", "الماركة", "الموديل", "التصنيف", "سعر الشراء", "سعر البيع", "المخزون", "الضمان (شهر)", "الموقع"])
                for row in rows:
                    writer.writerow([
                        row.get("barcode") or row.get("shop_barcode") or row.get("company_barcode") or "",
                        row.get("name") or "", row.get("brand") or "", row.get("model") or "", row.get("category") or "",
                        row.get("cost") or 0, row.get("price") or 0, "" if row.get("is_service") else row.get("stock", 0),
                        row.get("warranty_months") or 0, row.get("location") or "",
                    ])
            return _ok({"filename": filename, "path": path, "rows": len(rows)})
        except Exception as exc:
            return _err(f"تعذر حفظ ملف التصدير: {exc}")
        finally:
            if con is not None: con.close()

    def add_product(self, data: str, user_id: str = None):
        con = None
        try:
            d = json.loads(data)
            from camera_api import validate_image
            validate_image(d.get("image_data"))
            name = str(d.get("name") or "").strip()
            if not name:
                return _err("اسم الصنف مطلوب")
            price = float(d.get("price") or 0)
            cost = float(d.get("cost") or 0)
            if not (math.isfinite(price) and math.isfinite(cost)) or price < 0 or cost < 0:
                return _err("السعر والتكلفة يجب أن يكونا رقمين غير سالبين")
            track = 1 if d.get("track_serial") else 0
            service = 1 if d.get("is_service") else 0
            if track and service:
                return _err("لا يمكن أن يكون الصنف خدمة ومتتبعًا بالرقم التسلسلي في نفس الوقت")
            con = _conn()
            conflict = _barcode_conflict(con, d)
            if conflict:
                return _err(conflict)
            stock = 0 if (track or service) else float(d.get("stock") or 0)
            if not math.isfinite(stock) or stock < 0 or (not float(stock).is_integer() and d.get('unit') not in ('متر','كيلو','لتر')):
                return _err("الرصيد لا يمكن أن يكون سالبًا")
            factor = 1 if (track or service) else max(1, int(d.get("conversion_factor") or 1))
            unit = d.get("unit") or ("خدمة" if service else "قطعة")
            nid = _new_id("PR")
            con.execute(
                "INSERT INTO products(id,name,brand,model,category,price,cost,stock,min_stock,unit,supplier_id,barcode,"
                "company_barcode,shop_barcode,location,description,image_data,track_serial,warranty_months,is_service,"
                "purchase_unit,sale_unit,conversion_factor,wholesale_price,wholesale_min_qty,is_active)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)",
                (nid, name, d.get("brand"), d.get("model"), d.get("category") or "أخرى", price, cost, stock,
                 int(d.get("min_stock") if d.get("min_stock") not in (None, "") else 5), unit,
                 d.get("supplier_id") or None,
                 str(d.get("barcode") or "").strip() or None, str(d.get("company_barcode") or "").strip() or None,
                 str(d.get("shop_barcode") or "").strip() or None,
                 d.get("location"), d.get("description"), d.get("image_data"), track,
                 max(0, int(d.get("warranty_months") or 0)), service,
                 d.get("purchase_unit") or unit, d.get("sale_unit") or unit, factor,
                 (float(d["wholesale_price"]) if d.get("wholesale_price") not in (None, "") else None),
                 max(1, int(d.get("wholesale_min_qty") or 1))))
            if stock:
                _log_adjustment(con, nid, 0, stock, "رصيد افتتاحي", user_id)
            _audit(con, user_id, "ADD", "product", nid, name)
            con.commit(); return _ok(nid)
        except Exception as e:
            return _err(str(e))
        finally:
            if con: con.close()

    def update_product(self, mid: str, data: str, user_id: str = None):
        con = None
        try:
            d = json.loads(data)
            con = _conn()
            old = con.execute("SELECT * FROM products WHERE id=?", (mid,)).fetchone()
            if not old:
                return _err("الصنف غير موجود")
            conflict = _barcode_conflict(con, d, mid)
            if conflict:
                return _err(conflict)
            if d.get("image_data") and d["image_data"] != old["image_data"]:
                from camera_api import validate_image
                validate_image(d["image_data"])

            def val(key):
                return d[key] if key in d and d.get(key) is not None else old[key]

            price, cost = float(val("price") or 0), float(val("cost") or 0)
            if not (math.isfinite(price) and math.isfinite(cost)) or price < 0 or cost < 0:
                return _err("السعر والتكلفة يجب أن يكونا رقمين غير سالبين")
            track = (1 if d.get("track_serial") else 0) if "track_serial" in d else old["track_serial"]
            service = (1 if d.get("is_service") else 0) if "is_service" in d else old["is_service"]
            if track and service:
                return _err("لا يمكن أن يكون الصنف خدمة ومتتبعًا بالرقم التسلسلي في نفس الوقت")
            available = con.execute("SELECT COUNT(*) FROM serial_units WHERE product_id=? AND status='متاح'", (mid,)).fetchone()[0]
            if track and not old["track_serial"] and old["stock"] > 0:
                return _err("الصنف عليه رصيد بدون أرقام IMEI. صفّر الرصيد أولاً (جرد) ثم فعّل التتبع وسجّل الأجهزة")
            if old["track_serial"] and not track and available:
                return _err("لا يمكن إيقاف التتبع وفي المخزون أجهزة مسجلة بأرقامها")
            if service and old["stock"] > 0 and not old["is_service"]:
                return _err("لا يمكن تحويل صنف عليه رصيد إلى خدمة")
            new_stock = float(val("stock") or 0)
            if track or service:
                new_stock = old["stock"]           # رصيد الأجهزة = عدد الوحدات المتاحة، ولا يُعدَّل يدويًا
            if not math.isfinite(new_stock) or new_stock < 0 or (not float(new_stock).is_integer() and val('unit') not in ('متر','كيلو','لتر')):
                return _err("الرصيد لا يمكن أن يكون سالبًا")
            sale_unit = val("sale_unit") or val("unit") or "قطعة"
            factor = 1 if (track or service) else max(1, int(val("conversion_factor") or 1))
            if sale_unit != old["sale_unit"] and old["stock"] > 0:
                return _err("لا يمكن تغيير وحدة البيع مع وجود مخزون")
            if sale_unit != old["sale_unit"] or factor != int(old["conversion_factor"] or 1):
                con.execute("INSERT OR IGNORE INTO barcode_unit_reviews VALUES(?)", (mid,))
            con.execute(
                "UPDATE products SET name=?,brand=?,model=?,category=?,price=?,cost=?,stock=?,min_stock=?,unit=?,supplier_id=?,"
                "barcode=?,company_barcode=?,shop_barcode=?,location=?,description=?,image_data=?,track_serial=?,"
                "warranty_months=?,is_service=?,purchase_unit=?,sale_unit=?,conversion_factor=?,wholesale_price=?,wholesale_min_qty=?"
                " WHERE id=?",
                (str(val("name")).strip(), val("brand"), val("model"), val("category"), price, cost, new_stock,
                 int(val("min_stock") or 0), val("unit"), val("supplier_id") or None,
                 (str(d.get("barcode") or "").strip() or None) if "barcode" in d else old["barcode"],
                 (str(d.get("company_barcode") or "").strip() or None) if "company_barcode" in d else old["company_barcode"],
                 (str(d.get("shop_barcode") or "").strip() or None) if "shop_barcode" in d else old["shop_barcode"],
                 val("location"), val("description"), d.get("image_data") if "image_data" in d else old["image_data"],
                 track, max(0, int(val("warranty_months") or 0)), service,
                 val("purchase_unit") or val("unit") or "قطعة", sale_unit, factor,
                 (float(d["wholesale_price"]) if d.get("wholesale_price") not in (None, "") else None) if "wholesale_price" in d else old["wholesale_price"],
                 max(1, int(val("wholesale_min_qty") or 1)), mid))
            if new_stock != old["stock"]:
                _log_adjustment(con, mid, old["stock"], new_stock, "تعديل يدوي من شاشة الصنف", user_id)
            details = f"تغيير السعر: {old['price']} → {price}" if old["price"] != price else ""
            _audit(con, user_id, "UPDATE", "product", mid, details or str(val("name")))
            con.commit(); return _ok()
        except Exception as e:
            return _err(str(e))
        finally:
            if con: con.close()

    def delete_product(self, mid: str, user_id: str = None):
        # الصنف المرتبط بسجلات يُؤرشف بدل الحذف حتى لا تتأثر الفواتير القديمة
        con = None
        try:
            if mid == "SRV-LABOR":
                return _err("خدمة أجرة الصيانة أساسية في النظام ولا يمكن حذفها")
            con = _conn()
            row = con.execute("SELECT name FROM products WHERE id=?", (mid,)).fetchone()
            if not row:
                return _err("الصنف غير موجود")
            name = row["name"]
            linked = con.execute("SELECT COUNT(*) FROM sale_items WHERE product_id=?", (mid,)).fetchone()[0]
            for table in ("serial_units", "product_barcodes", "barcode_unit_reviews", "repair_parts", "purchase_items"):
                linked += con.execute(f"SELECT COUNT(*) FROM {table} WHERE product_id=?", (mid,)).fetchone()[0]
            if linked:
                con.execute("UPDATE products SET is_active=0 WHERE id=?", (mid,))
                _audit(con, user_id, "ARCHIVE", "product", mid, f"{name} — له {linked} سجل مرتبط")
                con.commit()
                return _ok({"archived": True, "message": f"تم أرشفة '{name}' بدلاً من حذفه لأنه مرتبط بـ {linked} سجل (فواتير/أرقام/مشتريات)."})
            con.execute("DELETE FROM products WHERE id=?", (mid,))
            _audit(con, user_id, "DELETE", "product", mid, name)
            con.commit(); return _ok({"archived": False})
        except Exception as e:
            return _err(str(e))
        finally:
            if con: con.close()

    def get_low_stock(self):
        con = _conn()
        rows = _rows(con.execute(
            f"SELECT {light_columns(con)} FROM products WHERE is_active=1 AND is_service=0 AND stock>0 AND stock<=min_stock ORDER BY stock"))
        con.close(); return _ok(rows)

    def get_stock_aging_report(self):
        """أعمار مخزون الأجهزة (IMEI): كم يوم بقي كل جهاز متاحًا؟ الشرائح: حتى 30 / 60 / 90 / أكثر من 90 يوم،
        مع قيمة التكلفة المجمدة في الأجهزة الراكدة."""
        con = _conn()
        today = date.today().isoformat()
        rows = _rows(con.execute("""
            SELECT u.id AS unit_id, u.product_id, p.name, p.category, u.serial, u.serial2, u.variant, u.cost, p.price,
                   u.received_date, CAST(julianday(?) - julianday(COALESCE(NULLIF(u.received_date,''), ?)) AS INTEGER) AS age_days
            FROM serial_units u JOIN products p ON p.id = u.product_id
            WHERE u.status = 'متاح' AND p.is_active = 1
            ORDER BY age_days DESC, p.name
        """, (today, today)))
        buckets = {"d30": [], "d60": [], "d90": [], "over90": []}
        totals = {k: 0.0 for k in buckets}
        for r in rows:
            age = r["age_days"] or 0
            key = "d30" if age <= 30 else "d60" if age <= 60 else "d90" if age <= 90 else "over90"
            buckets[key].append(r)
            totals[key] += r["cost"] or 0
        con.close()
        return _ok({"buckets": buckets, "totals": totals, "count": {k: len(v) for k, v in buckets.items()}})

    # ── SERIAL / IMEI ─────────────────────────────────────────
    def get_serial_units(self, product_id: str = None, status: str = None, q: str = None, limit: int = 100, offset: int = 0):
        con = _conn()
        where, params = ["1=1"], []
        if product_id:
            where.append("u.product_id=?"); params.append(product_id)
        if status:
            where.append("u.status=?"); params.append(status)
        if q:
            like = f"%{str(q).strip()}%"
            where.append("(u.serial LIKE ? OR u.serial2 LIKE ? OR u.customer_name LIKE ? OR p.name LIKE ?)")
            params += [like, like, like, like]
        where_clause = ' AND '.join(where)
        rows = _rows(con.execute(
            f"SELECT u.*, p.name AS product_name, p.brand, p.model FROM serial_units u JOIN products p ON p.id=u.product_id "
            f"WHERE {where_clause} ORDER BY u.received_date DESC, u.serial LIMIT ? OFFSET ?",
            (*params, max(1, min(int(limit), 2000)), max(0, int(offset)))))
        for r in rows:
            r["warranty_active"], r["warranty_days_left"] = _warranty_state(r.get("warranty_end"))
        total = con.execute(
            f"SELECT COUNT(*) FROM serial_units u JOIN products p ON p.id=u.product_id WHERE {where_clause}", params
        ).fetchone()[0]
        con.close()
        return _ok({"units": rows, "total": total, "limit": limit, "offset": offset, "has_more": (offset + limit) < total})

    def add_serial_units(self, data: str, user_id: str = None):
        """تسجيل أجهزة (IMEI/Serial) في المخزون بدون أمر شراء. يزيد رصيد الصنف بعدد الوحدات."""
        con = None
        try:
            d = json.loads(data)
            con = _conn(); con.execute("BEGIN IMMEDIATE")
            product = con.execute("SELECT * FROM products WHERE id=? AND is_active=1", (d.get("product_id"),)).fetchone()
            if not product:
                raise ValueError("الصنف غير موجود")
            if not product["track_serial"]:
                raise ValueError("هذا الصنف غير مفعّل له التتبع بالرقم التسلسلي")
            from shop_ops import clean_serials
            entries = d.get("units")
            if entries is None:
                entries = [{"serial": s} for s in clean_serials(d.get("serials"))]
            if not entries:
                raise ValueError("أدخل رقم IMEI/Serial واحدًا على الأقل")
            cost = float(d["cost"]) if d.get("cost") not in (None, "") else float(product["cost"] or 0)
            if cost < 0:
                raise ValueError("التكلفة لا يمكن أن تكون سالبة")
            before = product["stock"]
            n = _insert_serial_units(con, product, entries, cost, variant=d.get("variant"), notes=d.get("notes"))
            _log_adjustment(con, product["id"], before, before + n, "إضافة أجهزة بالرقم التسلسلي", user_id)
            _audit(con, user_id, "ADD_SERIALS", "product", product["id"], f"{product['name']} — {n} وحدة")
            con.commit(); return _ok({"added": n})
        except Exception as e:
            if con: con.rollback()
            return _err(str(e))
        finally:
            if con: con.close()

    def update_serial_unit(self, unit_id: str, data: str, user_id: str = None):
        """تعديل بيانات وحدة أو نقل حالتها بين: متاح / تالف / مرتجع للمورد. الوحدات المباعة لا تُعدَّل حالتها من هنا."""
        con = None
        try:
            d = json.loads(data)
            con = _conn(); con.execute("BEGIN IMMEDIATE")
            unit = con.execute("SELECT * FROM serial_units WHERE id=?", (unit_id,)).fetchone()
            if not unit:
                raise ValueError("الوحدة غير موجودة")
            new_status = d.get("status") or unit["status"]
            if new_status not in ("متاح", "تالف", "مرتجع للمورد", "مباع"):
                raise ValueError("حالة غير صحيحة")
            if unit["status"] == "مباع" and new_status != "مباع":
                raise ValueError("الوحدة مباعة. ألغِ الفاتورة لإرجاعها للمخزون")
            if new_status == "مباع" and unit["status"] != "مباع":
                raise ValueError("سجّل البيع من شاشة المبيعات")
            delta = (1 if new_status == "متاح" else 0) - (1 if unit["status"] == "متاح" else 0)
            con.execute("UPDATE serial_units SET status=?, variant=?, notes=?, cost=? WHERE id=?",
                        (new_status, d.get("variant", unit["variant"]), d.get("notes", unit["notes"]),
                         float(d.get("cost", unit["cost"]) or 0), unit_id))
            if delta:
                con.execute("UPDATE products SET stock=stock+? WHERE id=?", (delta, unit["product_id"]))
                stock = con.execute("SELECT stock FROM products WHERE id=?", (unit["product_id"],)).fetchone()[0]
                _log_adjustment(con, unit["product_id"], stock - delta, stock, f"{unit['serial']}: {unit['status']} ← {new_status}", user_id)
            _audit(con, user_id, "UPDATE_SERIAL", "serial_unit", unit_id, f"{unit['serial']}: {unit['status']} → {new_status}")
            con.commit(); return _ok()
        except Exception as e:
            if con: con.rollback()
            return _err(str(e))
        finally:
            if con: con.close()

    def lookup_serial(self, code: str):
        """بحث كامل عن جهاز برقمه: المخزون، الفاتورة، حالة الضمان، وسجل الصيانة."""
        code = str(code or "").strip().upper()
        if not code:
            return _err("أدخل رقم IMEI أو Serial")
        con = _conn()
        unit = con.execute(
            "SELECT u.*, p.name AS product_name, p.brand, p.model FROM serial_units u JOIN products p ON p.id=u.product_id "
            "WHERE u.serial=? OR u.serial2=?", (code, code)).fetchone()
        repairs = _rows(con.execute(
            "SELECT id,ticket_num,status,issue,received_at,delivered_at,in_warranty FROM repair_tickets WHERE imei=? ORDER BY received_at DESC", (code,)))
        if not unit:
            con.close()
            return _ok({"found": False, "repairs": repairs})
        u = dict(unit)
        u["warranty_active"], u["warranty_days_left"] = _warranty_state(u.get("warranty_end"))
        sale = con.execute("SELECT id,invoice_num,sale_date,customer_name,status FROM sales WHERE id=?", (u["sale_id"],)).fetchone() if u["sale_id"] else None
        con.close()
        return _ok({"found": True, "unit": u, "sale": dict(sale) if sale else None, "repairs": repairs})

    def search_warranty(self, query: str):
        """بحث الضمان برقم الفاتورة أو IMEI أو اسم/تليفون العميل أو اسم الصنف."""
        q = str(query or "").strip()
        if len(q) < 3:
            return _err("اكتب 3 أحرف/أرقام على الأقل للبحث")
        like = f"%{q}%"
        con = _conn()
        rows = _rows(con.execute("""
            SELECT si.id AS item_id, s.id AS sale_id, s.invoice_num, s.sale_date, s.status AS sale_status,
                   s.customer_name, c.phone AS customer_phone, si.name, si.qty, si.serials, si.warranty_months, si.warranty_end
            FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN customers c ON c.id = s.customer_id
            WHERE si.warranty_months > 0
              AND (s.invoice_num LIKE ? OR s.customer_name LIKE ? OR c.phone LIKE ? OR si.serials LIKE ? OR si.name LIKE ?)
            ORDER BY s.sale_date DESC, s.sale_time DESC LIMIT 100
        """, (like, like, like, like, like)))
        for r in rows:
            r["warranty_active"], r["warranty_days_left"] = _warranty_state(r.get("warranty_end"))
            try: r["serials"] = json.loads(r["serials"]) if r.get("serials") else []
            except ValueError: r["serials"] = []
        con.close(); return _ok(rows)

    def get_supplier_price_comparison(self, product_id: str = None):
        """مقارنة أسعار الموردين لصنف (أو لكل الأصناف) بناءً على تاريخ أوامر الشراء
        المستلمة فعليًا، مع تمييز أفضل سعر متاح."""
        con = _conn()
        where = "WHERE pi.qty_received > 0"
        params = []
        if product_id:
            where += " AND pi.product_id = ?"
            params.append(product_id)
        rows = _rows(con.execute(f"""
            SELECT pi.product_id, pi.product_name, p.supplier_id, p.supplier_name,
                   pi.unit_cost, p.received_at, p.po_num
            FROM purchase_items pi
            JOIN purchases p ON p.id = pi.purchase_id
            {where} AND p.status IN ('مستلم','مستلم جزئياً')
            ORDER BY pi.product_id, p.received_at DESC
        """, params))
        con.close()

        grouped = {}
        for r in rows:
            g = grouped.setdefault(r["product_id"], {"product_name": r["product_name"], "suppliers": {}})
            sup = g["suppliers"].setdefault(r["supplier_id"], {
                "supplier_id": r["supplier_id"], "supplier_name": r["supplier_name"],
                "last_price": r["unit_cost"], "last_date": r["received_at"],
                "best_price": r["unit_cost"], "orders_count": 0,
            })
            sup["orders_count"] += 1
            if r["unit_cost"] < sup["best_price"]:
                sup["best_price"] = r["unit_cost"]
            if r["received_at"] and (not sup["last_date"] or r["received_at"] > sup["last_date"]):
                sup["last_date"] = r["received_at"]
                sup["last_price"] = r["unit_cost"]

        result = []
        for product_id, g in grouped.items():
            suppliers = list(g["suppliers"].values())
            suppliers.sort(key=lambda s: s["last_price"])
            for s in suppliers:
                s["is_best"] = (s["last_price"] == min(x["last_price"] for x in suppliers))
            result.append({"product_id": product_id, "product_name": g["product_name"], "suppliers": suppliers})
        result.sort(key=lambda x: x["product_name"] or "")
        return _ok(result)

    # ══════════════ العروض والخصومات — PROMOTIONS ══════════════
    def get_promotions(self, active_only: bool = False):
        con = _conn()
        where = ""
        if active_only:
            today = date.today().isoformat()
            where = (f" WHERE pr.is_active=1 AND (pr.start_date IS NULL OR pr.start_date='' OR pr.start_date<='{today}') "
                     f"AND (pr.end_date IS NULL OR pr.end_date='' OR pr.end_date>='{today}')")
        rows = _rows(con.execute(f"""
            SELECT pr.*, m.name AS product_name, m.price AS product_price, m.unit
            FROM promotions pr JOIN products m ON m.id = pr.product_id
            {where} ORDER BY pr.created_at DESC
        """))
        con.close()
        return _ok(rows)

    def add_promotion(self, data: str, user_id: str = None):
        try:
            d, con = json.loads(data), _conn()
            if not d.get("name") or not d.get("product_id"):
                con.close(); return _err("اسم العرض والصنف مطلوبان")
            if d.get("discount_type") not in ("percent", "fixed"):
                con.close(); return _err("نوع الخصم غير صحيح")
            nid = _new_id("PROMO")
            con.execute(
                "INSERT INTO promotions(id,name,product_id,discount_type,discount_value,min_qty,start_date,end_date,is_active,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,1,?)",
                (nid, d["name"], d["product_id"], d["discount_type"], float(d.get("discount_value") or 0),
                 max(1, int(d.get("min_qty") or 1)), d.get("start_date") or None, d.get("end_date") or None,
                 datetime.now().isoformat())
            )
            _audit(con, user_id, "ADD", "promotion", nid, d["name"])
            con.commit(); con.close(); return _ok(nid)
        except Exception as e: return _err(str(e))

    def update_promotion(self, promo_id: str, data: str, user_id: str = None):
        try:
            d, con = json.loads(data), _conn()
            row = con.execute("SELECT * FROM promotions WHERE id=?", (promo_id,)).fetchone()
            if not row: con.close(); return _err("العرض غير موجود")
            val = lambda k: d[k] if k in d else row[k]
            con.execute(
                "UPDATE promotions SET name=?,product_id=?,discount_type=?,discount_value=?,min_qty=?,"
                "start_date=?,end_date=?,is_active=? WHERE id=?",
                (val("name"), val("product_id"), val("discount_type"), float(val("discount_value") or 0),
                 max(1, int(val("min_qty") or 1)), val("start_date"), val("end_date"),
                 1 if val("is_active") else 0, promo_id)
            )
            _audit(con, user_id, "UPDATE", "promotion", promo_id, val("name"))
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def delete_promotion(self, promo_id: str, user_id: str = None):
        try:
            con = _conn()
            con.execute("DELETE FROM promotions WHERE id=?", (promo_id,))
            _audit(con, user_id, "DELETE", "promotion", promo_id, "")
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    # ══════════════ الرحلات الدورية المجدولة — RECURRING ROUTES ══════════════
    def get_recurring_routes(self):
        con = _conn()
        rows = _rows(con.execute("""
            SELECT rr.*, p.name AS customer_name, p.phone AS customer_phone,
                   d.name AS driver_name, v.plate_number
            FROM recurring_routes rr
            LEFT JOIN customers p ON p.id = rr.customer_id
            LEFT JOIN drivers d ON d.id = rr.driver_id
            LEFT JOIN vehicles v ON v.id = rr.vehicle_id
            ORDER BY rr.weekday, rr.created_at
        """))
        con.close()
        return _ok(rows)

    def add_recurring_route(self, data: str, user_id: str = None):
        try:
            d, con = json.loads(data), _conn()
            if not d.get("customer_id") or d.get("weekday") is None:
                con.close(); return _err("العميل ويوم الأسبوع مطلوبان")
            nid = _new_id("RR")
            con.execute(
                "INSERT INTO recurring_routes(id,customer_id,weekday,driver_id,vehicle_id,payment_mode,is_active,last_generated_date,notes,created_at) "
                "VALUES(?,?,?,?,?,?,1,NULL,?,?)",
                (nid, d["customer_id"], int(d["weekday"]), d.get("driver_id"), d.get("vehicle_id"),
                 d.get("payment_mode") or "مسبق", d.get("notes"), datetime.now().isoformat())
            )
            _audit(con, user_id, "ADD", "recurring_route", nid, "")
            con.commit(); con.close(); return _ok(nid)
        except Exception as e: return _err(str(e))

    def update_recurring_route(self, route_id: str, data: str, user_id: str = None):
        try:
            d, con = json.loads(data), _conn()
            row = con.execute("SELECT * FROM recurring_routes WHERE id=?", (route_id,)).fetchone()
            if not row: con.close(); return _err("الرحلة الدورية غير موجودة")
            val = lambda k: d[k] if k in d else row[k]
            con.execute(
                "UPDATE recurring_routes SET customer_id=?,weekday=?,driver_id=?,vehicle_id=?,payment_mode=?,is_active=?,notes=? WHERE id=?",
                (val("customer_id"), int(val("weekday")), val("driver_id"), val("vehicle_id"),
                 val("payment_mode"), 1 if val("is_active") else 0, val("notes"), route_id)
            )
            _audit(con, user_id, "UPDATE", "recurring_route", route_id, "")
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def delete_recurring_route(self, route_id: str, user_id: str = None):
        try:
            con = _conn()
            con.execute("DELETE FROM recurring_routes WHERE id=?", (route_id,))
            _audit(con, user_id, "DELETE", "recurring_route", route_id, "")
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def generate_todays_recurring_trips(self, user_id: str = None):
        """يفحص كل الرحلات الدورية المجدولة ليوم الأسبوع الحالي، ويجمع
        العملاء اللي عندهم فواتير غير مرتبطة بشحنة في رحلات توزيع فعلية
        (رحلة واحدة لكل مجموعة سائق+سيارة)، مرة واحدة فقط في اليوم.
        يعتمد على add_delivery_trip / add_delivery_stop الموجودتين لضمان
        نفس قواعد التحقق (حالة الفاتورة، عدم التكرار، توليد الباركود...)."""
        today = date.today()
        today_str = today.isoformat()
        today_weekday = today.weekday()

        con = _conn()
        routes = _rows(con.execute("""
            SELECT * FROM recurring_routes
            WHERE is_active=1 AND weekday=? AND (last_generated_date IS NULL OR last_generated_date != ?)
        """, (today_weekday, today_str)))
        con.close()

        if not routes:
            return _ok({"trips_created": 0, "stops_created": 0, "skipped_no_invoices": 0,
                        "message": "لا توجد رحلات دورية مجدولة اليوم أو تم توليدها بالفعل"})

        groups = {}
        for r in routes:
            groups.setdefault((r["driver_id"] or "", r["vehicle_id"] or ""), []).append(r)

        trips_created = stops_created = skipped = 0
        for (driver_id, vehicle_id), group_routes in groups.items():
            pending = []
            for r in group_routes:
                sales = json.loads(self.get_unassigned_sales_for_customer(r["customer_id"]))["data"]
                if sales:
                    pending.append((r, [s["id"] for s in sales]))
                else:
                    skipped += 1
                con2 = _conn()
                con2.execute("UPDATE recurring_routes SET last_generated_date=? WHERE id=?", (today_str, r["id"]))
                con2.commit(); con2.close()

            if not pending:
                continue

            trip_res = json.loads(self.add_delivery_trip(json.dumps({
                "driver_id": driver_id or None, "vehicle_id": vehicle_id or None,
                "notes": "تم إنشاؤها تلقائيًا من الرحلات الدورية المجدولة",
            }), user_id))
            if not trip_res.get("ok"):
                continue
            trip_id = trip_res["data"]["id"]
            trips_created += 1

            for r, sale_ids in pending:
                stop_res = json.loads(self.add_delivery_stop(trip_id, json.dumps({
                    "customer_id": r["customer_id"], "sale_ids": sale_ids,
                    "payment_mode": r["payment_mode"] or "مسبق", "notes": r["notes"],
                }), user_id))
                if stop_res.get("ok"):
                    stops_created += 1

        return _ok({"trips_created": trips_created, "stops_created": stops_created, "skipped_no_invoices": skipped})

    def get_categories(self):
        con  = _conn()
        rows = [r[0] for r in con.execute(
            "SELECT name FROM inventory_categories UNION SELECT DISTINCT category FROM products WHERE is_active=1 AND is_service=0 AND category<>'خدمات' ORDER BY 1"
        ).fetchall()]
        con.close(); return _ok(rows)

    # ══════════════ الجرد الدوري وسجل حركة المخزون — STOCKTAKE / LEDGER ══════════════
    def get_stocktake_worksheet(self, category: str = None):
        """قائمة الأصناف النشطة لتعبئة الجرد الفعلي مقابلها (بدون الخدمات).
        الأجهزة المتتبعة بـ IMEI تُعرض للاطلاع فقط لأن رصيدها = عدد الوحدات المسجلة."""
        con = _conn()
        where = "WHERE is_active=1 AND is_service=0"
        params = []
        if category:
            where += " AND category=?"
            params.append(category)
        rows = _rows(con.execute(
            f"SELECT id, name, category, unit, stock, cost, track_serial FROM products {where} ORDER BY category, name", params))
        con.close()
        return _ok(rows)

    def submit_stocktake(self, data: str, user_id: str = None):
        """يقارن الكمية المعدودة فعليًا بكل صنف بالمخزون المسجَّل ويسوّي الفرق،
        ويسجّل حركة في stock_adjustments لكل فرق. الأجهزة المتتبعة بـ IMEI لا تُسوَّى من هنا."""
        con = None
        try:
            d = json.loads(data)
            items = d.get("items", [])
            notes = d.get("notes", "")
            con = _conn(); con.execute("BEGIN IMMEDIATE")
            adjusted = 0
            increase_value = 0.0
            decrease_value = 0.0
            skipped = []
            for item in items:
                mid = item.get("product_id")
                counted = item.get("counted_qty")
                if mid is None or counted is None:
                    continue
                counted = int(counted)
                if counted < 0:
                    raise ValueError("الكمية المعدودة لا يمكن أن تكون سالبة")
                product = con.execute("SELECT * FROM products WHERE id=?", (mid,)).fetchone()
                if not product or product["is_service"]:
                    continue
                current = product["stock"]
                diff = counted - current
                if diff == 0:
                    continue
                if product["track_serial"]:
                    skipped.append(product["name"])
                    continue
                cost = product["cost"] or 0
                if diff > 0:
                    increase_value += diff * cost
                else:
                    decrease_value += -diff * cost
                con.execute("UPDATE products SET stock=? WHERE id=?", (counted, mid))
                _log_adjustment(con, mid, current, counted, "جرد دوري", user_id, notes)
                _audit(con, user_id, "STOCKTAKE_ADJUST", "product", mid, f"{current} → {counted} ({diff:+d})")
                adjusted += 1
            con.commit()
            return _ok({"adjusted_count": adjusted, "increase_value": round(increase_value, 2),
                        "decrease_value": round(decrease_value, 2), "skipped_serial": skipped})
        except Exception as e:
            if con: con.rollback()
            return _err(str(e))
        finally:
            if con: con.close()

    def get_stock_ledger(self, product_id: str, date_from: str = None, date_to: str = None):
        """سجل حركة صنف واحد: كل بيع وشراء ومرتجع وتسوية جرد، مرتّبة زمنيًا
        مع رصيد متحرك (يُحسب رجوعًا من رصيد المخزون الحالي)."""
        con = _conn()
        product = con.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()
        if not product:
            con.close()
            return _err("الصنف غير موجود")

        date_filter = ""
        params_extra = []
        if date_from:
            date_filter += " AND date(ev_date) >= date(?)"
            params_extra.append(date_from)
        if date_to:
            date_filter += " AND date(ev_date) <= date(?)"
            params_extra.append(date_to)

        rows = _rows(con.execute(f"""
            SELECT * FROM (
                SELECT s.sale_date AS ev_date, 'بيع' AS type, -si.qty AS qty_change,
                       s.invoice_num AS reference, '' AS notes
                FROM sale_items si JOIN sales s ON s.id = si.sale_id
                WHERE si.product_id = ? AND s.status != 'ملغاة'
                UNION ALL
                SELECT s.voided_at AS ev_date, 'إلغاء/مرتجع بيع' AS type, si.qty AS qty_change,
                       s.invoice_num AS reference, '' AS notes
                FROM sale_items si JOIN sales s ON s.id = si.sale_id
                WHERE si.product_id = ? AND s.status = 'ملغاة' AND s.voided_at IS NOT NULL
                UNION ALL
                SELECT p.received_at AS ev_date, 'شراء' AS type, pi.qty_received AS qty_change,
                       p.po_num AS reference, '' AS notes
                FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
                WHERE pi.product_id = ? AND pi.qty_received > 0 AND p.received_at IS NOT NULL
                UNION ALL
                SELECT created_at AS ev_date, 'تسوية جرد' AS type, qty_change AS qty_change,
                       reason AS reference, notes AS notes
                FROM stock_adjustments WHERE product_id = ?
            ) WHERE ev_date IS NOT NULL {date_filter}
            ORDER BY ev_date DESC
        """, [product_id, product_id, product_id, product_id] + params_extra))

        balance = product["stock"]
        for r in rows:
            r["balance_after"] = balance
            balance -= r["qty_change"]
        con.close()
        return _ok({"product": {"id": product["id"], "name": product["name"], "unit": product["unit"], "stock": product["stock"]}, "movements": rows})

    # ══════════════ فحص سلامة البيانات — HEALTH CHECK ══════════════
    def get_health_check(self):
        """فحص حقيقي للقاعدة والملفات والنسخ، مع عدم الادعاء بفحص أجهزة
        خارجية لا يستطيع الخادم الوصول إليها."""
        con = _conn()
        today = date.today().isoformat()
        checks = []
        diagnostics = []

        def diagnostic(key, title, status, details, checked=True):
            diagnostics.append({"key": key, "title": title, "status": status,
                                "details": details, "checked": checked})

        # SQLite نفسها: فحص الصفحات والعلاقات المرجعية، لا مجرد عدّ سجلات.
        quick = con.execute("PRAGMA quick_check").fetchone()[0]
        diagnostic("sqlite", "سلامة ملف قاعدة البيانات",
                   "ok" if quick == "ok" else "error",
                   "PRAGMA quick_check: ok" if quick == "ok" else str(quick))
        foreign_errors = con.execute("PRAGMA foreign_key_check").fetchall()
        diagnostic("foreign_keys", "العلاقات بين الجداول",
                   "ok" if not foreign_errors else "error",
                   "لا توجد مراجع مكسورة" if not foreign_errors else f"يوجد {len(foreign_errors)} مرجع مكسور")

        db_exists = os.path.isfile(DB_PATH)
        db_size = os.path.getsize(DB_PATH) if db_exists else 0
        diagnostic("database_file", "ملف البيانات والتخزين المحلي",
                   "ok" if db_exists and os.access(DB_PATH, os.R_OK | os.W_OK) else "error",
                   f"{round(db_size/1024/1024, 2)} MB — قابل للقراءة والكتابة" if db_exists else "ملف قاعدة البيانات غير موجود")

        # النسخ الاحتياطية تُفحص فعلياً بفتح أحدث ملف وتشغيل quick_check عليه.
        try:
            from backup_store import managed_backups, status as backup_status
            backup_paths = managed_backups()
            if backup_paths:
                latest_backup = backup_paths[0]
                with sqlite3.connect(f"file:{latest_backup}?mode=ro", uri=True) as backup_con:
                    backup_quick = backup_con.execute("PRAGMA quick_check").fetchone()[0]
                age_hours = (datetime.now() - datetime.fromtimestamp(os.path.getmtime(latest_backup))).total_seconds()/3600
                diagnostic("local_backup", "آخر نسخة احتياطية محلية",
                           "ok" if backup_quick == "ok" and age_hours < 72 else "warning",
                           f"{os.path.basename(latest_backup)} — منذ {age_hours:.1f} ساعة — الفحص: {backup_quick}")
            else:
                diagnostic("local_backup", "النسخة الاحتياطية المحلية", "warning", "لا توجد نسخة احتياطية")
            secondary = backup_status()
            if not secondary.get("configured"):
                diagnostic("secondary_backup", "نسخة خارج الجهاز", "not_configured",
                           "غير مُهيأة؛ لم يتم اختبار قرص خارجي أو مسار شبكة", False)
            else:
                diagnostic("secondary_backup", "نسخة خارج الجهاز",
                           "ok" if secondary.get("state") == "ok" else "warning",
                           secondary.get("error") or ("آخر نسخ ناجح: " + str(secondary.get("last_success") or "لا يوجد")))
        except (OSError, sqlite3.Error, ValueError) as exc:
            diagnostic("backups", "فحص النسخ الاحتياطية", "error", str(exc))

        # لا يمكن للخادم إثبات حالة أجهزة المتصفح من دون اختبار فعلي من المستخدم.
        diagnostic("external_devices", "الطابعات والقارئ والكاميرا", "not_tested",
                   "لا يوجد تكامل مباشر مع أجهزة خارجية؛ اختبر كل جهاز من مركز الطباعة والأجهزة", False)

        def add_check(key, title, severity, rows, detail_fn):
            checks.append({
                "key": key, "title": title, "severity": severity,
                "count": len(rows), "items": [detail_fn(r) for r in rows[:50]],
            })

        # 1) أجهزة متتبعة: الرصيد المسجل لا يساوي عدد الوحدات المتاحة
        rows = _rows(con.execute("""
            SELECT p.id, p.name, p.stock, (SELECT COUNT(*) FROM serial_units u WHERE u.product_id=p.id AND u.status='متاح') AS available
            FROM products p WHERE p.is_active=1 AND p.track_serial=1
              AND p.stock != (SELECT COUNT(*) FROM serial_units u WHERE u.product_id=p.id AND u.status='متاح')
        """))
        add_check("serial_stock_mismatch", "تضارب بين رصيد الجهاز وعدد أرقام IMEI المتاحة", "critical", rows,
                   lambda r: f"{r['name']} — الرصيد: {r['stock']} / الأرقام المتاحة: {r['available']}")

        # 2) وحدات مسجلة مباعة لفاتورة ملغاة أو غير موجودة
        rows = _rows(con.execute("""
            SELECT u.serial, p.name, u.sale_id FROM serial_units u JOIN products p ON p.id=u.product_id
            WHERE u.status='مباع' AND (u.sale_id IS NULL
                OR NOT EXISTS (SELECT 1 FROM sales s WHERE s.id=u.sale_id AND s.status!='ملغاة'))
        """))
        add_check("orphan_serial_sales", "أجهزة مسجلة مباعة بدون فاتورة سارية", "critical", rows,
                   lambda r: f"{r['name']} — {r['serial']}")

        # 2b) أصناف برصيد سالب
        rows = _rows(con.execute("SELECT id, name, stock FROM products WHERE is_active=1 AND stock<0"))
        add_check("negative_stock", "أصناف برصيد سالب", "critical", rows,
                   lambda r: f"{r['name']} — الرصيد: {r['stock']}")

        # 3) عملاء جملة تجاوزوا سقف الائتمان حاليًا
        rows = _rows(con.execute("""
            SELECT p.id, p.name, p.credit_limit, COALESCE(SUM(d.amount-d.paid_amount),0) AS outstanding
            FROM customers p JOIN debts d ON d.customer_id=p.id AND d.status NOT IN ('مسدد','ملغى')
            WHERE p.customer_type='جملة' AND p.credit_limit>0
            GROUP BY p.id HAVING outstanding > p.credit_limit
        """))
        add_check("over_credit_limit", "عملاء جملة تجاوزوا سقف الائتمان", "warning", rows,
                   lambda r: f"{r['name']} — المستحق: {r['outstanding']:.2f} / الحد: {r['credit_limit']:.2f}")

        # 4) فواتير مرتبطة بعميل غير موجود (محذوف أو معطوب المرجع)
        rows = _rows(con.execute("""
            SELECT s.id, s.invoice_num FROM sales s
            WHERE s.customer_id IS NOT NULL AND s.customer_id!=''
              AND NOT EXISTS (SELECT 1 FROM customers p WHERE p.id=s.customer_id)
        """))
        add_check("orphan_sales", "فواتير مرتبطة بعميل غير موجود", "info", rows,
                   lambda r: f"فاتورة {r['invoice_num']}")

        # 5) تذاكر صيانة جاهزة للتسليم منذ أكثر من 14 يومًا
        rows = _rows(con.execute("""
            SELECT ticket_num, customer_name, device_model, completed_at FROM repair_tickets
            WHERE status='جاهز للتسليم' AND completed_at IS NOT NULL AND date(completed_at) < date(?, '-14 days')
        """, (today,)))
        add_check("stale_repairs", "أجهزة صيانة جاهزة ولم تُسلَّم منذ أكثر من 14 يوم", "info", rows,
                   lambda r: f"{r['ticket_num']} — {r['customer_name']} ({r['device_model'] or '—'})")

        # 6) عروض نشطة (is_active=1) لكن فترتها انتهت فعليًا
        rows = _rows(con.execute("""
            SELECT pr.id, pr.name, pr.end_date FROM promotions pr
            WHERE pr.is_active=1 AND pr.end_date IS NOT NULL AND pr.end_date!='' AND pr.end_date < ?
        """, (today,)))
        add_check("stale_promotions", "عروض منتهية لكن ما زالت مفعّلة", "info", rows,
                   lambda r: f"{r['name']} — انتهى في {r['end_date']}")

        con.close()
        overall = "critical" if any(c["severity"] == "critical" and c["count"] > 0 for c in checks) \
            else "warning" if any(c["severity"] == "warning" and c["count"] > 0 for c in checks) \
            else "ok"
        if any(d["status"] == "error" for d in diagnostics): overall = "critical"
        elif any(d["status"] == "warning" for d in diagnostics) and overall == "ok": overall = "warning"
        elif any(not d["checked"] for d in diagnostics) and overall == "ok": overall = "incomplete"
        return _ok({"overall": overall, "checked_at": datetime.now().isoformat(),
                    "checks": checks, "diagnostics": diagnostics,
                    "scope": "internal_data_and_backup",
                    "external_verified": False})

    def create_performance_indexes(self):
        """استدع هذه مرة واحدة لإنشاء indexes لتسريع الاستعلامات
        🎯 تحسن الأداء بـ 5-10x"""
        con = _conn()
        try:
            # Indexes للمبيعات (الاستعلام الأكثر استخدامًا)
            con.execute("CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date DESC, sale_time DESC)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id)")
            # Indexes للأصناف
            con.execute("CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active, name)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)")
            # Indexes للعملاء
            con.execute("CREATE INDEX IF NOT EXISTS idx_customers_active ON customers(is_active, name)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)")
            # Indexes لـ serial units
            con.execute("CREATE INDEX IF NOT EXISTS idx_serial_received ON serial_units(received_date DESC)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_serial_product ON serial_units(product_id)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_serial_status ON serial_units(status)")
            # Indexes للمشتريات
            con.execute("CREATE INDEX IF NOT EXISTS idx_purchase_received ON purchases(received_at)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_items(product_id)")
            # Indexes للتسليم
            con.execute("CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery_trips(status)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_delivery_stops_trip ON delivery_stops(trip_id)")
            con.commit()
            con.close()
            return _ok({"message": "✔ Performance indexes created successfully"})
        except Exception as e:
            con.close()
            return _err(f"Index creation error: {str(e)}")

    # ── CUSTOMERS ──────────────────────────────────────────────
    def get_customers(self, limit: int = 100, offset: int = 0, q: str = None):
        con = _conn()
        try:
            where = ["is_active = 1"]
            params = []
            if q:
                like = f"%{str(q).strip()}%"
                where.append("(name LIKE ? OR phone LIKE ? OR company_name LIKE ?)")
                params += [like, like, like]
            where_clause = " AND ".join(where)
            rows = _rows(con.execute(
                f"SELECT * FROM customers WHERE {where_clause} ORDER BY name ASC LIMIT ? OFFSET ?",
                params + [limit, offset]))
            total = con.execute(
                f"SELECT COUNT(*) FROM customers WHERE {where_clause}", params
            ).fetchone()[0]
            con.close()
            return _ok({"customers": rows, "total": total, "limit": limit, "offset": offset, "has_more": (offset + limit) < total})
        except Exception as e:
            con.close()
            return _err(str(e))

    def get_customer(self, pid: str):
        con = _conn()
        row = con.execute("SELECT * FROM customers WHERE id=?", (pid,)).fetchone()
        con.close(); return _ok(dict(row) if row else None)

    def add_customer(self, data: str, user_id: str = None):
        con = None
        try:
            d = json.loads(data)
            name, phone = str(d.get("name") or "").strip(), str(d.get("phone") or "").strip()
            quick_pos = bool(d.get("quick_pos"))
            if not name or (not phone and not quick_pos):
                return _err("اسم العميل ورقم التليفون مطلوبان")
            customer_type = d.get("customer_type") or "فرد"
            if customer_type not in ("فرد", "جملة"):
                return _err("نوع العميل غير صحيح")
            con = _conn()
            if quick_pos:
                existing = con.execute(
                    "SELECT id FROM customers WHERE is_active=1 AND lower(trim(name))=lower(?) ORDER BY created_at LIMIT 1",
                    (name,)).fetchone()
                if existing:
                    return _ok(existing["id"])
            nid = _new_id("C")
            con.execute(
                "INSERT INTO customers(id,name,phone,address,notes,created_at,customer_type,company_name,tax_num,credit_limit,is_active)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,1)",
                (nid, name, phone, d.get("address"), d.get("notes"), date.today().isoformat(),
                 customer_type, d.get("company_name"), d.get("tax_num"), float(d.get("credit_limit") or 0)))
            _audit(con, user_id, "ADD", "customer", nid, name)
            con.commit(); return _ok(nid)
        except Exception as e:
            return _err(str(e))
        finally:
            if con: con.close()

    def update_customer(self, pid: str, data: str, user_id: str = None):
        con = None
        try:
            d = json.loads(data)
            name, phone = str(d.get("name") or "").strip(), str(d.get("phone") or "").strip()
            if not name or not phone:
                return _err("اسم العميل ورقم التليفون مطلوبان")
            customer_type = d.get("customer_type") or "فرد"
            if customer_type not in ("فرد", "جملة"):
                return _err("نوع العميل غير صحيح")
            con = _conn()
            con.execute(
                "UPDATE customers SET name=?,phone=?,address=?,notes=?,customer_type=?,company_name=?,tax_num=?,credit_limit=? WHERE id=?",
                (name, phone, d.get("address"), d.get("notes"), customer_type, d.get("company_name"), d.get("tax_num"),
                 float(d.get("credit_limit") or 0), pid))
            _audit(con, user_id, "UPDATE", "customer", pid, name)
            con.commit(); return _ok()
        except Exception as e:
            return _err(str(e))
        finally:
            if con: con.close()

    def delete_customer(self, pid: str, user_id: str = None):
        # FIX [1.5]: orphan-safe delete — archive if has sales history
        try:
            con = _conn()
            row = con.execute("SELECT name FROM customers WHERE id=?", (pid,)).fetchone()
            if not row:
                con.close(); return _err("العميل غير موجود")
            name = row["name"]
            linked = con.execute(
                "SELECT COUNT(*) FROM sales WHERE customer_id=?", (pid,)
            ).fetchone()[0]
            if linked:
                con.execute("UPDATE customers SET is_active=0 WHERE id=?", (pid,))
                _audit(con, user_id, "ARCHIVE", "customer", pid,
                       f"{name} — له {linked} فاتورة")
                con.commit(); con.close()
                return _ok({"archived": True, "message":
                    f"تم أرشفة '{name}' بدلاً من حذفه لأنه مرتبط بـ {linked} فاتورة مبيعات."})
            con.execute("DELETE FROM customers WHERE id=?", (pid,))
            _audit(con, user_id, "DELETE", "customer", pid, name)
            con.commit(); con.close(); return _ok({"archived": False})
        except Exception as e: return _err(str(e))

    # ── SUPPLIERS ─────────────────────────────────────────────
    def get_suppliers(self):
        con  = _conn()
        rows = _rows(con.execute(
            "SELECT * FROM suppliers WHERE is_active=1 ORDER BY name"))
        con.close(); return _ok(rows)

    def get_supplier(self, sid: str):
        con = _conn()
        row = con.execute("SELECT * FROM suppliers WHERE id=?", (sid,)).fetchone()
        con.close(); return _ok(dict(row) if row else None)

    def add_supplier(self, data: str, user_id: str = None):
        try:
            d, con = json.loads(data), _conn()
            nid = _new_id("S")
            con.execute(
                "INSERT INTO suppliers(id,name,contact,phone,email,address,tax_num,"
                "payment_terms,status,rating,total_orders,last_order,is_active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)",
                (nid, d.get("name"), d.get("contact"), d.get("phone"),
                 d.get("email"), d.get("address"), d.get("tax_num"),
                 d.get("payment_terms","30 يوم"), d.get("status","نشط"),
                 d.get("rating",3), 0, None)
            )
            _audit(con, user_id, "ADD", "supplier", nid, d.get("name",""))
            con.commit(); con.close(); return _ok(nid)
        except Exception as e: return _err(str(e))

    def update_supplier(self, sid: str, data: str, user_id: str = None):
        try:
            d, con = json.loads(data), _conn()
            con.execute(
                "UPDATE suppliers SET name=?,contact=?,phone=?,email=?,address=?,"
                "tax_num=?,payment_terms=?,status=?,rating=? WHERE id=?",
                (d.get("name"), d.get("contact"), d.get("phone"), d.get("email"),
                 d.get("address"), d.get("tax_num"), d.get("payment_terms"),
                 d.get("status"), d.get("rating"), sid)
            )
            _audit(con, user_id, "UPDATE", "supplier", sid, d.get("name",""))
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def delete_supplier(self, sid: str, user_id: str = None):
        # FIX [1.5]: orphan-safe — check linked products
        try:
            con = _conn()
            row = con.execute("SELECT name FROM suppliers WHERE id=?", (sid,)).fetchone()
            if not row:
                con.close(); return _err("المورد غير موجود")
            name = row["name"]
            linked = con.execute(
                "SELECT COUNT(*) FROM products WHERE supplier_id=? AND is_active=1", (sid,)
            ).fetchone()[0]
            if linked:
                con.execute("UPDATE suppliers SET is_active=0 WHERE id=?", (sid,))
                _audit(con, user_id, "ARCHIVE", "supplier", sid,
                       f"{name} — مرتبط بـ {linked} صنف")
                con.commit(); con.close()
                return _ok({"archived": True, "message":
                    f"تم أرشفة '{name}' بدلاً من حذفه لأنه مورّد لـ {linked} صنف."})
            con.execute("DELETE FROM suppliers WHERE id=?", (sid,))
            _audit(con, user_id, "DELETE", "supplier", sid, name)
            con.commit(); con.close(); return _ok({"archived": False})
        except Exception as e: return _err(str(e))

    # ── SALES ─────────────────────────────────────────────────
    def get_sales(self, limit: int = 100, offset: int = 0):
        con   = _conn()
        try:
            sales = _rows(con.execute(
                "SELECT id,invoice_num,invoice_seq,invoice_year,customer_id,customer_name,subtotal,discount,tax,total,"
                "payment_method,cashier,sale_date,sale_time,status,voided_by,voided_at,customer_amount,loyalty_discount,source,"
                "CASE WHEN payment_proof_image IS NOT NULL AND payment_proof_image<>'' THEN 1 ELSE 0 END AS has_payment_proof "
                "FROM sales ORDER BY sale_date DESC, sale_time DESC LIMIT ? OFFSET ?",
                (limit, offset)))
            for s in sales:
                s["has_payment_proof"] = bool(s["has_payment_proof"])
                s["items"] = _rows(con.execute(
                    "SELECT * FROM sale_items WHERE sale_id=?", (s["id"],)))
            total = con.execute("SELECT COUNT(*) FROM sales").fetchone()[0]
            con.close()
            return _ok({"sales": sales, "total": total, "limit": limit, "offset": offset, "has_more": (offset + limit) < total})
        except Exception as e:
            con.close()
            return _err(str(e))

    def get_sale(self, sale_id: str):
        con = _conn()
        row = con.execute(
            "SELECT id,invoice_num,invoice_seq,invoice_year,customer_id,customer_name,subtotal,discount,tax,total,"
            "payment_method,cashier,sale_date,sale_time,status,voided_by,voided_at,customer_amount,loyalty_discount,source,"
            "CASE WHEN payment_proof_image IS NOT NULL AND payment_proof_image<>'' THEN 1 ELSE 0 END AS has_payment_proof "
            "FROM sales WHERE id=?", (sale_id,)).fetchone()
        if not row: con.close(); return _ok(None)
        s = dict(row)
        s["has_payment_proof"] = bool(s["has_payment_proof"])
        s["items"] = _rows(con.execute(
            "SELECT * FROM sale_items WHERE sale_id=?", (sale_id,)))
        con.close(); return _ok(s)

    def get_sale_payment_proof(self, sale_id: str):
        con = _conn()
        row = con.execute("SELECT payment_proof_image FROM sales WHERE id=?", (sale_id,)).fetchone()
        con.close()
        if not row: return _err("الفاتورة غير موجودة")
        return _ok(row["payment_proof_image"])

    def search_sales(self, query: str, limit: int = 5):
        """بحث خفيف للبحث العام؛ تفاصيل البنود تُحمّل فقط عند فتح الفاتورة."""
        term = str(query or "").strip()
        if not term:
            return _ok([])
        con = _conn()
        try:
            like = f"%{term}%"
            rows = _rows(con.execute(
                "SELECT id,invoice_num,customer_name,total,payment_method,sale_date,sale_time,status "
                "FROM sales WHERE invoice_num LIKE ? OR customer_name LIKE ? "
                "ORDER BY sale_date DESC,sale_time DESC LIMIT ?",
                (like, like, max(1, min(int(limit), 20)))))
            return _ok(rows)
        finally:
            con.close()

    def global_search(self, query: str, per_type: int = 5):
        """بحث موحّد خفيف عبر الكيانات التشغيلية الرئيسية في النظام."""
        term = str(query or "").strip()
        if not term:
            return _ok([])
        like = f"%{term}%"
        limit = max(1, min(int(per_type or 5), 10))
        con = _conn()
        results = []

        def add(kind, page, sql, params, title, subtitle, query_field=None):
            for row in _rows(con.execute(sql, (*params, limit))):
                results.append({
                    "type": kind, "page": page, "id": row.get("id"),
                    "title": str(row.get(title) or ""),
                    "subtitle": str(row.get(subtitle) or ""),
                    "query": str(row.get(query_field) or term) if query_field else term,
                })

        try:
            add("product", "products",
                "SELECT p.id,p.name,COALESCE(NULLIF(p.brand,''),p.category,'صنف') subtitle FROM products p "
                "WHERE p.is_active=1 AND (p.name LIKE ? OR p.brand LIKE ? OR p.model LIKE ? OR p.category LIKE ? OR "
                "p.barcode LIKE ? OR p.company_barcode LIKE ? OR p.shop_barcode LIKE ? OR EXISTS "
                "(SELECT 1 FROM serial_units u WHERE u.product_id=p.id AND (u.serial LIKE ? OR u.serial2 LIKE ?))) "
                "ORDER BY p.name LIMIT ?", (like,)*9, "name", "subtitle")
            add("sale", "invoices",
                "SELECT id,invoice_num,customer_name||' — '||printf('%.2f',total) subtitle FROM sales "
                "WHERE invoice_num LIKE ? OR customer_name LIKE ? ORDER BY sale_date DESC,sale_time DESC LIMIT ?",
                (like,like), "invoice_num", "subtitle")
            add("customer", "customers",
                "SELECT id,name,COALESCE(NULLIF(phone,''),NULLIF(company_name,''),'عميل') subtitle FROM customers "
                "WHERE is_active=1 AND (name LIKE ? OR phone LIKE ? OR company_name LIKE ? OR tax_num LIKE ?) ORDER BY name LIMIT ?",
                (like,)*4, "name", "subtitle")
            add("supplier", "suppliers",
                "SELECT id,name,COALESCE(NULLIF(phone,''),NULLIF(contact,''),'مورد') subtitle FROM suppliers "
                "WHERE is_active=1 AND (name LIKE ? OR contact LIKE ? OR phone LIKE ? OR email LIKE ? OR tax_num LIKE ?) ORDER BY name LIMIT ?",
                (like,)*5, "name", "subtitle", "name")
            add("repair", "repairs",
                "SELECT id,ticket_num,customer_name||' — '||COALESCE(device_brand||' '||device_model,device_type,'صيانة') subtitle FROM repair_tickets "
                "WHERE ticket_num LIKE ? OR customer_name LIKE ? OR phone LIKE ? OR imei LIKE ? OR device_brand LIKE ? OR device_model LIKE ? ORDER BY received_at DESC LIMIT ?",
                (like,)*6, "ticket_num", "subtitle")
            add("purchase", "purchases",
                "SELECT id,po_num,COALESCE(NULLIF(supplier_name,''),'أمر شراء')||' — '||status subtitle FROM purchases "
                "WHERE po_num LIKE ? OR supplier_name LIKE ? OR supplier_invoice_num LIKE ? ORDER BY created_at DESC LIMIT ?",
                (like,)*3, "po_num", "subtitle", "po_num")
            add("employee", "hr",
                "SELECT id,full_name,COALESCE(NULLIF(role,''),NULLIF(phone,''),'موظف') subtitle FROM employees "
                "WHERE is_active=1 AND (full_name LIKE ? OR role LIKE ? OR phone LIKE ? OR national_id LIKE ?) ORDER BY full_name LIMIT ?",
                (like,)*4, "full_name", "subtitle")
            add("delivery", "delivery",
                "SELECT id,barcode,customer_name||' — '||status subtitle FROM delivery_stops "
                "WHERE barcode LIKE ? OR customer_name LIKE ? OR phone LIKE ? OR address LIKE ? ORDER BY created_at DESC LIMIT ?",
                (like,)*4, "barcode", "subtitle", "barcode")
            add("trip", "delivery",
                "SELECT id,trip_num,status subtitle FROM delivery_trips WHERE trip_num LIKE ? OR notes LIKE ? ORDER BY created_at DESC LIMIT ?",
                (like,like), "trip_num", "subtitle", "trip_num")
            return _ok(results[:40])
        finally:
            con.close()

    def add_sale(self, data: str, user_id: str = None):
        # FIX [1.2]: stock pre-check + atomic rollback
        # FIX [1.6]: BEGIN IMMEDIATE for atomic invoice numbering
        try:
            d   = json.loads(data)
            con = sqlite3.connect(DB_PATH)
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA foreign_keys=ON")
            con.execute("BEGIN IMMEDIATE")           # FIX [1.6]: atomic lock

            request_id = d.get("draft_id")
            if request_id:
                previous = con.execute("SELECT response FROM sale_requests WHERE user_id=? AND request_id=?",(user_id,request_id)).fetchone()
                if previous:
                    con.close(); return _ok(json.loads(previous[0]))
                draft = con.execute("SELECT draft_id,version FROM pos_drafts WHERE user_id=?",(user_id,)).fetchone()
                if not draft or draft["draft_id"] != request_id or draft["version"] != d.get("draft_version"):
                    con.rollback(); con.close(); return _err("المسودة تغيرت أو غير محفوظة؛ راجع نقطة البيع")

            # ── FIX [1.2]: validate stock for ALL items before any INSERT ──
            items = d.get("items", [])
            if not items: raise ValueError("السلة فارغة")
            from shop_ops import clean_serials, allocate_serials
            seen_products = set()
            products_by_id = {}
            for item in items:
                quantity = float(item.get("qty", 0))
                if not math.isfinite(quantity) or quantity <= 0 or item.get("productId") in seen_products:
                    raise ValueError("كميات البيع يجب أن تكون أعدادًا صحيحة موجبة بدون أصناف مكررة")
                item["qty"] = quantity
                price_value = float(item.get("price", 0))
                if not math.isfinite(price_value) or price_value < 0:
                    raise ValueError("سعر الصنف غير صحيح")
                item["price"] = price_value
                seen_products.add(item["productId"])
                product_row = con.execute("SELECT * FROM products WHERE id=? AND is_active=1", (item["productId"],)).fetchone()
                if not product_row:
                    raise ValueError(f"الصنف '{item.get('name', item['productId'])}' غير موجود في قاعدة البيانات")
                products_by_id[item["productId"]] = product_row
                if not quantity.is_integer() and (product_row['track_serial'] or (product_row['sale_unit'] or product_row['unit']) not in ('متر','كيلو','لتر')):
                    raise ValueError('الكميات الكسرية متاحة للمتر والكيلو واللتر فقط')
                if product_row["is_service"]:
                    continue
                if product_row["stock"] < item["qty"]:
                    raise ValueError(
                        f"المخزون غير كافٍ للصنف '{product_row['name']}': "
                        f"المتاح {product_row['stock']}، المطلوب {item['qty']}")
                if product_row["track_serial"]:
                    item["serials"] = clean_serials(item.get("serials"))
                    if len(item["serials"]) != item["qty"]:
                        raise ValueError(
                            f"'{product_row['name']}' يُباع برقم IMEI/Serial لكل جهاز: حدّد {item['qty']} رقم (المحدد {len(item['serials'])})")

            # الضريبة مصدرها الإعدادات فقط، وليس القيمة القادمة من المتصفح.
            subtotal_value = round(sum(float(i["price"]) * float(i["qty"]) for i in items), 2)
            discount_value = max(0.0, min(float(d.get("discount", 0) or 0), subtotal_value))
            tax_row = con.execute("SELECT value FROM settings WHERE key='tax_rate'").fetchone()
            try: configured_tax_pct = max(0.0, float(tax_row[0])) if tax_row else 0.0
            except (TypeError, ValueError): configured_tax_pct = 0.0
            tax_amount = round((subtotal_value - discount_value) * configured_tax_pct / 100, 2)

            nid = _new_id("SL")
            inv, seq, yr = _next_invoice(con)   # safe inside IMMEDIATE
            now    = datetime.now()
            s_date = now.strftime("%Y-%m-%d")
            s_time = now.strftime("%H:%M")

            total_due = round(subtotal_value - discount_value + tax_amount, 2)
            payment_method = str(d.get("payment_method", "نقدي") or "نقدي").strip()
            payment_proof = d.get("payment_proof_image")
            from camera_api import validate_image
            validate_image(payment_proof)
            credit_paid = 0.0
            if payment_method == "آجل":
                credit_name = str(d.get("credit_customer_name", "") or "").strip()
                credit_phone = str(d.get("credit_phone", "") or "").strip()
                linked_customer = None
                if d.get("customer_id"):
                    linked_customer = con.execute("SELECT id,name,phone FROM customers WHERE id=? AND is_active=1", (d["customer_id"],)).fetchone()
                    if not linked_customer:
                        raise ValueError("العميل المختار غير موجود")
                    # Backward-compatible API callers can use the already registered name.
                    credit_name = credit_name or str(linked_customer["name"] or "").strip()
                    credit_phone = credit_phone or str(linked_customer["phone"] or "").strip()
                if len(credit_name) < 2 or len(credit_name) > 100:
                    raise ValueError("البيع الآجل يتطلب اسم عميل صحيح")
                if len(credit_phone) > 30:
                    raise ValueError("رقم هاتف العميل غير صحيح")
                try:
                    credit_paid = float(d.get("credit_paid_amount", 0) or 0)
                except (TypeError, ValueError):
                    raise ValueError("المبلغ المدفوع غير صحيح")
                if not math.isfinite(credit_paid) or credit_paid < 0:
                    raise ValueError("المبلغ المدفوع يجب أن يكون صفرًا أو أكثر")
                credit_paid = round(credit_paid, 2)
                if not d.get("customer_id"):
                    d["customer_id"] = _new_id("C")
                    con.execute("INSERT INTO customers(id,name,phone,created_at,is_active) VALUES(?,?,?,?,1)",
                                (d["customer_id"], credit_name, credit_phone or "", date.today().isoformat()))
                    _audit(con, user_id, "ADD", "customer", d["customer_id"], "إنشاء تلقائي من بيع آجل: "+credit_name)
                d["customer_name"] = credit_name
            customer_amount = total_due
            loyalty_discount = 0.0
            if d.get("use_loyalty") and d.get("customer_id"):
                lp = con.execute("SELECT points FROM loyalty_points WHERE customer_id=?", (d.get("customer_id"),)).fetchone()
                valrow = con.execute("SELECT value FROM settings WHERE key='loyalty_point_value'").fetchone()
                point_value = max(0, float(valrow[0] if valrow else 1))
                available = float(lp["points"] if lp else 0)
                loyalty_discount = round(min(customer_amount, available * point_value), 2)
                used_points = loyalty_discount / point_value if point_value else 0
                if used_points:
                    con.execute("UPDATE loyalty_points SET points=MAX(0,points-?),last_updated=? WHERE customer_id=?",
                                (used_points,now.isoformat(),d.get("customer_id")))
                    customer_amount = round(customer_amount-loyalty_discount,2)
                    total_due = round(total_due-loyalty_discount,2)

            if payment_method == "آجل" and credit_paid > customer_amount:
                raise ValueError("المبلغ المدفوع أكبر من المطلوب على العميل")

            # سقف ائتمان عملاء الجملة: يمنع تجاوز الحد المتفق عليه عند البيع الآجل.
            if payment_method == "آجل" and d.get("customer_id"):
                cust = con.execute(
                    "SELECT customer_type, credit_limit, name FROM customers WHERE id=?",
                    (d.get("customer_id"),)
                ).fetchone()
                if cust and cust["customer_type"] == "جملة" and (cust["credit_limit"] or 0) > 0:
                    outstanding = con.execute(
                        "SELECT COALESCE(SUM(amount-paid_amount),0) FROM debts "
                        "WHERE customer_id=? AND status IN ('مستحق','مسدد جزئياً')",
                        (d.get("customer_id"),)
                    ).fetchone()[0]
                    new_debt = max(0.0, customer_amount - credit_paid)
                    if outstanding + new_debt > cust["credit_limit"]:
                        raise ValueError(
                            f"تجاوز سقف الائتمان المسموح لعميل الجملة '{cust['name']}': "
                            f"المستحق حاليًا {outstanding:.2f} + هذه الفاتورة {new_debt:.2f} "
                            f"يتجاوز الحد {cust['credit_limit']:.2f}"
                        )

            con.execute(
                "INSERT INTO sales(id,invoice_num,invoice_seq,invoice_year,"
                "customer_id,customer_name,subtotal,discount,tax,total,"
                "payment_method,cashier,sale_date,sale_time,status,customer_amount,loyalty_discount,source,payment_proof_image)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pos',?)",
                (nid, inv, seq, yr,
                 d.get("customer_id"), d.get("customer_name"),
                 subtotal_value, discount_value, tax_amount, total_due,
                 payment_method, d.get("cashier",""),
                 s_date, s_time, "مكتمل", customer_amount, loyalty_discount, payment_proof)
            )
            from shop_ops import add_months
            for item in items:
                product_row = products_by_id[item["productId"]]
                line_total = round(item["price"] * item["qty"], 2)
                serials_json, unit_cost, w_end = None, float(product_row["cost"] or 0), None
                months = int(product_row["warranty_months"] or 0)
                if product_row["is_service"]:
                    unit_cost, months = 0.0, 0
                elif product_row["track_serial"]:
                    total_cost, w_end = allocate_serials(con, nid, product_row, item["serials"], s_date, item["price"],
                                                         d.get("customer_id"), d.get("customer_name"))
                    unit_cost = round(total_cost / item["qty"], 2)
                    serials_json = json.dumps(item["serials"], ensure_ascii=False)
                if months and not w_end:
                    w_end = add_months(date.fromisoformat(s_date), months).isoformat()
                con.execute(
                    "INSERT INTO sale_items(sale_id,product_id,name,qty,price,total,cost,serials,warranty_months,warranty_end)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (nid, item["productId"], product_row["name"], item["qty"], item["price"], line_total,
                     unit_cost, serials_json, months, w_end))
                if not product_row["is_service"]:
                    con.execute("UPDATE products SET stock = stock - ? WHERE id=?", (item["qty"], item["productId"]))
            if payment_method == "آجل":
                debt_id = _new_id("DEBT")
                debt_status = "مسدد" if credit_paid >= customer_amount else "مسدد جزئياً" if credit_paid > 0 else "مستحق"
                con.execute(
                    "INSERT INTO debts(id,customer_id,sale_id,amount,paid_amount,due_date,status,notes,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (debt_id,d.get("customer_id"),nid,customer_amount,credit_paid,d.get("due_date") or (date.today()+timedelta(days=30)).isoformat(),
                     debt_status,d.get("debt_notes",""),now.isoformat(),now.isoformat())
                )
                _audit(con,user_id,"ADD_DEBT","debt",debt_id,f"{inv} — مدفوع {credit_paid:.2f} — متبقي {customer_amount-credit_paid:.2f}")

            # نقاط ولاء قابلة للتخصيص (الافتراضي نقطة لكل 100 من العملة).
            if d.get("customer_id"):
                setting = con.execute("SELECT value FROM settings WHERE key='loyalty_amount_per_point'").fetchone()
                threshold = max(1, float(setting[0] if setting else 100))
                earned = customer_amount / threshold
                con.execute("INSERT INTO loyalty_points(customer_id,points,last_updated) VALUES(?,?,?) "
                            "ON CONFLICT(customer_id) DO UPDATE SET points=points+excluded.points,last_updated=excluded.last_updated",
                            (d.get("customer_id"),earned,now.isoformat()))
            _audit(con, user_id, "ADD_SALE", "sale", nid, inv)
            response = {"id": nid, "invoiceNum": inv, "date": s_date, "time": s_time,
                        "total":total_due,"customerAmount":customer_amount,
                        "loyaltyDiscount":loyalty_discount,"customerId":d.get("customer_id"),
                        "customerName":d.get("customer_name"),"creditPaid":credit_paid,
                        "creditRemaining":round(customer_amount-credit_paid,2) if payment_method == "آجل" else 0}
            if request_id:
                con.execute("INSERT INTO sale_requests VALUES(?,?,?)",(user_id,request_id,json.dumps(response)))
                con.execute("DELETE FROM pos_drafts WHERE user_id=? AND draft_id=?",(user_id,request_id))
            con.commit(); con.close()
            return _ok(response)
        except Exception as e:
            try: con.rollback(); con.close()
            except Exception: pass
            return _err(str(e))

    # ── REPAIRS / الصيانة ─────────────────────────────────────
    @staticmethod
    def _repair_ticket_num(con):
        year = date.today().year
        last = con.execute("SELECT ticket_num FROM repair_tickets WHERE ticket_num LIKE ? ORDER BY ticket_num DESC LIMIT 1",
                           (f"RP-{year}-%",)).fetchone()
        seq = int(last[0].rsplit("-", 1)[1]) + 1 if last else 1
        return f"RP-{year}-{seq:03d}"

    @staticmethod
    def _repair_full(con, ticket_id):
        row = con.execute("SELECT * FROM repair_tickets WHERE id=?", (ticket_id,)).fetchone()
        if not row:
            return None
        t = dict(row)
        t["parts"] = _rows(con.execute("SELECT * FROM repair_parts WHERE ticket_id=? ORDER BY id", (ticket_id,)))
        t["parts_total"] = round(sum(p["qty"] * p["price"] for p in t["parts"]), 2)
        t["total"] = 0.0 if t["in_warranty"] else round(float(t["labor_cost"] or 0) + t["parts_total"], 2)
        t["remaining"] = round(max(0.0, t["total"] - float(t["deposit"] or 0)), 2)
        t["log"] = _rows(con.execute("SELECT * FROM repair_log WHERE ticket_id=? ORDER BY id", (ticket_id,)))
        t["overdue"] = bool(t["promised_date"] and t["status"] not in ("تم التسليم", "ملغي") and t["promised_date"] < date.today().isoformat())
        t["repair_warranty_active"], t["repair_warranty_days_left"] = _warranty_state(t.get("warranty_end"))
        return t

    def get_repairs(self, status: str = None, q: str = None):
        con = _conn()
        where, params = ["1=1"], []
        if status == "مفتوحة":
            where.append("status NOT IN ('تم التسليم','ملغي')")
        elif status:
            where.append("status=?"); params.append(status)
        if q:
            like = f"%{str(q).strip()}%"
            where.append("(ticket_num LIKE ? OR customer_name LIKE ? OR phone LIKE ? OR imei LIKE ? OR device_model LIKE ?)")
            params += [like] * 5
        rows = _rows(con.execute(
            f"SELECT r.*, COALESCE((SELECT SUM(qty*price) FROM repair_parts WHERE ticket_id=r.id),0) AS parts_total "
            f"FROM repair_tickets r WHERE {' AND '.join(where)} ORDER BY received_at DESC LIMIT 500", params))
        today = date.today().isoformat()
        for r in rows:
            r["total"] = 0.0 if r["in_warranty"] else round(float(r["labor_cost"] or 0) + float(r["parts_total"] or 0), 2)
            r["overdue"] = bool(r["promised_date"] and r["status"] not in ("تم التسليم", "ملغي") and r["promised_date"] < today)
        con.close(); return _ok(rows)

    def get_repair(self, ticket_id: str):
        con = _conn()
        t = self._repair_full(con, ticket_id)
        con.close(); return _ok(t)

    def get_technicians(self):
        """قائمة الفنيين لاختيارهم في تذاكر الصيانة (متاحة لمن يملك صلاحية الصيانة، بدون بيانات الرواتب)."""
        con = _conn()
        rows = _rows(con.execute("SELECT id, full_name FROM employees WHERE is_active=1 ORDER BY (role LIKE '%فني%') DESC, full_name"))
        con.close(); return _ok(rows)

    def get_repair_stats(self):
        con = _conn()
        by_status = {r[0]: r[1] for r in con.execute("SELECT status, COUNT(*) FROM repair_tickets GROUP BY status")}
        overdue = con.execute(
            "SELECT COUNT(*) FROM repair_tickets WHERE status NOT IN ('تم التسليم','ملغي') AND promised_date IS NOT NULL AND promised_date<date('now')").fetchone()[0]
        month = date.today().isoformat()[:7]
        revenue = con.execute(
            "SELECT COALESCE(SUM(s.total),0) FROM repair_tickets r JOIN sales s ON s.id=r.sale_id WHERE s.status='مكتمل' AND substr(r.delivered_at,1,7)=?", (month,)).fetchone()[0]
        con.close()
        return _ok({"by_status": by_status, "open": sum(v for k, v in by_status.items() if k not in ("تم التسليم", "ملغي")),
                    "overdue": overdue, "month_revenue": revenue})

    @staticmethod
    def _save_repair_parts(con, ticket_id, parts):
        con.execute("DELETE FROM repair_parts WHERE ticket_id=?", (ticket_id,))
        seen = set()
        for part in parts or []:
            pid = part.get("product_id")
            qty = float(part.get("qty") or 0)
            if not qty.is_integer() or qty < 1:
                raise ValueError("كمية قطعة الغيار يجب أن تكون عددًا صحيحًا موجبًا")
            if pid in seen:
                raise ValueError("قطعة غيار مكررة؛ عدّل كميتها بدل تكرارها")
            seen.add(pid)
            product = con.execute("SELECT * FROM products WHERE id=? AND is_active=1", (pid,)).fetchone()
            if not product:
                raise ValueError("قطعة الغيار غير موجودة")
            if product["track_serial"]:
                raise ValueError("الأجهزة المتتبعة بـ IMEI لا تُضاف كقطع غيار")
            price = float(part.get("price") if part.get("price") not in (None, "") else product["price"])
            if not math.isfinite(price) or price < 0:
                raise ValueError("سعر قطعة الغيار غير صحيح")
            con.execute("INSERT INTO repair_parts(ticket_id,product_id,name,qty,price) VALUES(?,?,?,?,?)",
                        (ticket_id, pid, product["name"], int(qty), price))

    def add_repair(self, data: str, user_id: str = None):
        """استلام جهاز للصيانة وفتح تذكرة. يرجع رقم التذكرة."""
        con = None
        try:
            d = json.loads(data)
            name = str(d.get("customer_name") or "").strip()
            issue = str(d.get("issue") or "").strip()
            if not name or not issue:
                return _err("اسم العميل ووصف العطل مطلوبان")
            con = _conn(); con.execute("BEGIN IMMEDIATE")
            deposit = float(d.get("deposit") or 0)
            est = float(d.get("estimated_cost") or 0)
            if min(deposit, est) < 0 or not math.isfinite(deposit + est):
                raise ValueError("المبالغ لا يمكن أن تكون سالبة")
            tech_id = d.get("technician_id") or None
            tech_name = None
            if tech_id:
                emp = con.execute("SELECT full_name FROM employees WHERE id=?", (tech_id,)).fetchone()
                tech_name = emp[0] if emp else None
            imei = str(d.get("imei") or "").strip().upper() or None
            in_warranty = 1 if d.get("in_warranty") else 0
            tid = _new_id("RP")
            now = datetime.now().isoformat()
            setting = con.execute("SELECT value FROM settings WHERE key='default_repair_warranty_days'").fetchone()
            try: default_days = int(setting[0]) if setting else 30
            except (TypeError, ValueError): default_days = 30
            num = self._repair_ticket_num(con)
            con.execute(
                "INSERT INTO repair_tickets(id,ticket_num,customer_id,customer_name,phone,device_type,device_brand,device_model,imei,"
                "accessories,issue,diagnosis,status,estimated_cost,labor_cost,deposit,in_warranty,technician_id,technician_name,"
                "promised_date,received_at,warranty_days,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (tid, num, d.get("customer_id") or None, name, str(d.get("phone") or "").strip(), d.get("device_type") or "موبايل",
                 d.get("device_brand"), d.get("device_model"), imei, d.get("accessories"), issue, d.get("diagnosis"), "استلام",
                 est, float(d.get("labor_cost") or 0), deposit, in_warranty, tech_id, tech_name,
                 d.get("promised_date") or None, now, int(d.get("warranty_days") if d.get("warranty_days") not in (None, "") else default_days),
                 d.get("notes"), user_id))
            if d.get("parts"):
                self._save_repair_parts(con, tid, d["parts"])
            con.execute("INSERT INTO repair_log(ticket_id,status,note,user_id,created_at) VALUES(?,?,?,?,?)",
                        (tid, "استلام", "استلام الجهاز" + (f" — عربون {deposit:g}" if deposit else ""), user_id, now))
            _audit(con, user_id, "ADD_REPAIR", "repair", tid, f"{num} — {name}")
            con.commit()
            return _ok({"id": tid, "ticket_num": num})
        except Exception as e:
            if con: con.rollback()
            return _err(str(e))
        finally:
            if con: con.close()

    def update_repair(self, ticket_id: str, data: str, user_id: str = None):
        """تعديل التذكرة: التشخيص، التكاليف، الفني، قطع الغيار، والحالة (مع تسجيلها في السجل)."""
        con = None
        try:
            d = json.loads(data)
            con = _conn(); con.execute("BEGIN IMMEDIATE")
            old = con.execute("SELECT * FROM repair_tickets WHERE id=?", (ticket_id,)).fetchone()
            if not old:
                raise ValueError("التذكرة غير موجودة")
            if old["status"] in ("تم التسليم", "ملغي"):
                raise ValueError("التذكرة مغلقة ولا يمكن تعديلها")
            new_status = d.get("status") or old["status"]
            if new_status not in REPAIR_STATUSES or new_status in ("تم التسليم", "ملغي"):
                raise ValueError("للتسليم استخدم زر «تسليم وفوترة»، وللإلغاء زر «إلغاء التذكرة»")

            def val(key):
                return d[key] if key in d and d[key] is not None else old[key]

            labor, est, deposit = float(val("labor_cost") or 0), float(val("estimated_cost") or 0), float(val("deposit") or 0)
            if min(labor, est, deposit) < 0 or not math.isfinite(labor + est + deposit):
                raise ValueError("المبالغ لا يمكن أن تكون سالبة")
            tech_id = val("technician_id") or None
            tech_name = old["technician_name"]
            if "technician_id" in d:
                emp = con.execute("SELECT full_name FROM employees WHERE id=?", (tech_id,)).fetchone() if tech_id else None
                tech_name = emp[0] if emp else None
            completed_at = old["completed_at"]
            if new_status == "جاهز للتسليم" and old["status"] != "جاهز للتسليم":
                completed_at = datetime.now().isoformat()
            imei = str(val("imei") or "").strip().upper() or None
            con.execute(
                "UPDATE repair_tickets SET customer_id=?,customer_name=?,phone=?,device_type=?,device_brand=?,device_model=?,imei=?,"
                "accessories=?,issue=?,diagnosis=?,status=?,estimated_cost=?,labor_cost=?,deposit=?,in_warranty=?,technician_id=?,"
                "technician_name=?,promised_date=?,completed_at=?,warranty_days=?,notes=? WHERE id=?",
                (val("customer_id"), val("customer_name"), val("phone"), val("device_type"), val("device_brand"), val("device_model"), imei,
                 val("accessories"), val("issue"), val("diagnosis"), new_status, est, labor, deposit,
                 (1 if d.get("in_warranty") else 0) if "in_warranty" in d else old["in_warranty"], tech_id, tech_name,
                 val("promised_date") or None, completed_at, int(val("warranty_days") or 0), val("notes"), ticket_id))
            if "parts" in d:
                self._save_repair_parts(con, ticket_id, d["parts"])
            if new_status != old["status"]:
                con.execute("INSERT INTO repair_log(ticket_id,status,note,user_id,created_at) VALUES(?,?,?,?,?)",
                            (ticket_id, new_status, d.get("status_note") or "", user_id, datetime.now().isoformat()))
            _audit(con, user_id, "UPDATE_REPAIR", "repair", ticket_id, f"{old['ticket_num']} — {new_status}")
            con.commit(); return _ok()
        except Exception as e:
            if con: con.rollback()
            return _err(str(e))
        finally:
            if con: con.close()

    def deliver_repair(self, ticket_id: str, data: str = "{}", user_id: str = None):
        """تسليم الجهاز للعميل: يصدر فاتورة (أجرة + قطع غيار) ويخصم القطع من المخزون.
        الصيانة تحت الضمان بدون مقابل: تُخصم القطع من المخزون وتُسجَّل بدون فاتورة."""
        con = None
        try:
            d = json.loads(data or "{}")
            con = _conn(); con.execute("BEGIN IMMEDIATE")
            ticket = self._repair_full(con, ticket_id)
            if not ticket:
                raise ValueError("التذكرة غير موجودة")
            if ticket["status"] != "جاهز للتسليم":
                raise ValueError("لا يمكن التسليم قبل أن تصبح حالة التذكرة «جاهز للتسليم»")
            now = datetime.now()
            sale_id, invoice_num = None, None
            if ticket["in_warranty"] or ticket["total"] <= 0 and not ticket["parts"]:
                for part in ticket["parts"]:
                    product = con.execute("SELECT * FROM products WHERE id=?", (part["product_id"],)).fetchone()
                    if not product or product["stock"] < part["qty"]:
                        raise ValueError(f"المخزون غير كافٍ لقطعة الغيار '{part['name']}'")
                    con.execute("UPDATE products SET stock=stock-? WHERE id=?", (part["qty"], part["product_id"]))
                    _log_adjustment(con, part["product_id"], product["stock"], product["stock"] - part["qty"],
                                    "استهلاك في صيانة", user_id, ticket["ticket_num"])
                con.commit()
            else:
                con.rollback()
                payload = {
                    "items": [{"productId": p["product_id"], "name": p["name"], "qty": p["qty"], "price": p["price"]} for p in ticket["parts"]],
                    "customer_id": ticket["customer_id"], "customer_name": ticket["customer_name"],
                    "payment_method": d.get("payment_method") or "نقدي", "cashier": d.get("cashier", ""),
                    "discount": d.get("discount", 0), "credit_paid_amount": d.get("credit_paid_amount", 0),
                    "credit_customer_name": ticket["customer_name"], "credit_phone": ticket["phone"], "due_date": d.get("due_date"),
                }
                if ticket["labor_cost"] and float(ticket["labor_cost"]) > 0:
                    payload["items"].append({"productId": "SRV-LABOR", "name": f"أجرة صيانة — {ticket['ticket_num']}", "qty": 1, "price": float(ticket["labor_cost"])})
                con.close(); con = None
                result = json.loads(self.add_sale(json.dumps(payload, ensure_ascii=False), user_id))
                if not result.get("ok"):
                    return _err(result.get("error") or "تعذر إصدار فاتورة الصيانة")
                sale_id, invoice_num = result["data"]["id"], result["data"]["invoiceNum"]
                con = _conn(); con.execute("BEGIN IMMEDIATE")
                con.execute("UPDATE sales SET source='repair' WHERE id=?", (sale_id,))
            warranty_end = (date.today() + timedelta(days=int(ticket["warranty_days"] or 0))).isoformat() if ticket["warranty_days"] else None
            con.execute("UPDATE repair_tickets SET status='تم التسليم', delivered_at=?, sale_id=?, warranty_end=? WHERE id=?",
                        (now.isoformat(), sale_id, warranty_end, ticket_id))
            con.execute("INSERT INTO repair_log(ticket_id,status,note,user_id,created_at) VALUES(?,?,?,?,?)",
                        (ticket_id, "تم التسليم", f"فاتورة {invoice_num}" if invoice_num else "تسليم بدون فاتورة", user_id, now.isoformat()))
            _audit(con, user_id, "DELIVER_REPAIR", "repair", ticket_id, f"{ticket['ticket_num']} — {invoice_num or 'بدون فاتورة'}")
            con.commit()
            return _ok({"ticket_num": ticket["ticket_num"], "sale_id": sale_id, "invoiceNum": invoice_num,
                        "total": ticket["total"], "deposit": ticket["deposit"], "remaining": ticket["remaining"]})
        except Exception as e:
            if con:
                try: con.rollback()
                except Exception: pass
            return _err(str(e))
        finally:
            if con: con.close()

    def cancel_repair(self, ticket_id: str, reason: str = "", user_id: str = None):
        con = None
        try:
            con = _conn(); con.execute("BEGIN IMMEDIATE")
            old = con.execute("SELECT * FROM repair_tickets WHERE id=?", (ticket_id,)).fetchone()
            if not old:
                raise ValueError("التذكرة غير موجودة")
            if old["status"] in ("تم التسليم", "ملغي"):
                raise ValueError("التذكرة مغلقة بالفعل")
            con.execute("UPDATE repair_tickets SET status='ملغي' WHERE id=?", (ticket_id,))
            note = (reason or "") + (f" — يُرد العربون {old['deposit']:g}" if old["deposit"] else "")
            con.execute("INSERT INTO repair_log(ticket_id,status,note,user_id,created_at) VALUES(?,?,?,?,?)",
                        (ticket_id, "ملغي", note.strip(" —"), user_id, datetime.now().isoformat()))
            _audit(con, user_id, "CANCEL_REPAIR", "repair", ticket_id, old["ticket_num"])
            con.commit(); return _ok({"deposit_to_refund": old["deposit"]})
        except Exception as e:
            if con: con.rollback()
            return _err(str(e))
        finally:
            if con: con.close()

    def get_top_selling_products(self, limit: int = 50):
        con = _conn()
        rows = _rows(con.execute(
            f"SELECT {light_columns(con, 'm')},COALESCE(SUM(CASE WHEN s.status='مكتمل' THEN si.qty ELSE 0 END),0) sold_qty "
            "FROM products m LEFT JOIN sale_items si ON si.product_id=m.id LEFT JOIN sales s ON s.id=si.sale_id "
            "WHERE m.is_active=1 GROUP BY m.id ORDER BY sold_qty DESC,m.name LIMIT ?", (max(1,min(int(limit),500)),)
        ))
        con.close(); return _ok(rows)

    def search_products(self, query: str):
        q = f"%{(query or '').strip()}%"
        con = _conn()
        rows = _rows(con.execute(
            f"SELECT {light_columns(con)} FROM products WHERE is_active=1 AND (name LIKE ? OR brand LIKE ? OR model LIKE ? OR "
            "shop_barcode LIKE ? OR company_barcode LIKE ? OR barcode LIKE ? OR id IN "
            "(SELECT product_id FROM serial_units WHERE serial LIKE ? OR serial2 LIKE ?)) ORDER BY name LIMIT 100",
            (q,q,q,q,q,q,q,q)
        ))
        con.close(); return _ok(rows)

    def get_debts(self, overdue_only: bool = False):
        con=_conn(); where="WHERE d.status NOT IN ('مسدد','ملغى')"
        if overdue_only: where += " AND d.due_date<date('now')"
        rows=_rows(con.execute(
            f"SELECT d.*,p.name customer_name,p.phone FROM debts d LEFT JOIN customers p ON p.id=d.customer_id {where} ORDER BY d.due_date,d.created_at DESC"))
        con.close(); return _ok(rows)

    def pay_debt(self, debt_id: str, amount: float, user_id: str = None):
        try:
            amount=float(amount); con=_conn()
            row=con.execute("SELECT * FROM debts WHERE id=?",(debt_id,)).fetchone()
            if not row: con.close(); return _err("سجل الدين غير موجود")
            if row["status"]=="ملغى": con.close(); return _err("هذا الدين ملغى لأن الفاتورة ملغاة")
            remaining=float(row["amount"])-float(row["paid_amount"])
            if amount<=0 or amount>remaining: con.close(); return _err("قيمة الدفعة غير صحيحة")
            paid=float(row["paid_amount"])+amount; status="مسدد" if paid>=float(row["amount"]) else "مسدد جزئياً"
            con.execute("UPDATE debts SET paid_amount=?,status=?,updated_at=? WHERE id=?",(paid,status,datetime.now().isoformat(),debt_id))
            _audit(con,user_id,"PAY_DEBT","debt",debt_id,f"دفعة {amount} — {status}")
            con.commit(); con.close(); return _ok({"paid_amount":paid,"status":status})
        except Exception as e: return _err(str(e))

    def get_customer_debt(self, customer_id: str):
        con=_conn(); row=con.execute("SELECT COALESCE(SUM(amount-paid_amount),0) balance FROM debts WHERE customer_id=? AND status NOT IN ('مسدد','ملغى')",(customer_id,)).fetchone(); con.close()
        return _ok({"balance":float(row["balance"] or 0)})

    def get_customer_statement(self, customer_id: str, date_from: str = None, date_to: str = None):
        """كشف حساب عميل: كل فواتيره خلال فترة، مع رصيد الدين المتراكم لكل
        فاتورة آجلة، وإجمالي المفوتر والمسدد والمتبقي."""
        con = _conn()
        customer = con.execute("SELECT * FROM customers WHERE id=?", (customer_id,)).fetchone()
        if not customer:
            con.close()
            return _err("العميل غير موجود")

        where = "WHERE s.customer_id=? AND s.status != 'ملغاة'"
        params = [customer_id]
        if date_from:
            where += " AND date(s.sale_date) >= date(?)"
            params.append(date_from)
        if date_to:
            where += " AND date(s.sale_date) <= date(?)"
            params.append(date_to)

        rows = _rows(con.execute(f"""
            SELECT s.id, s.invoice_num, s.sale_date, s.sale_time, s.total, s.payment_method,
                   COALESCE(d.amount,0) AS debt_amount, COALESCE(d.paid_amount,0) AS debt_paid,
                   d.status AS debt_status, d.updated_at AS debt_updated_at
            FROM sales s LEFT JOIN debts d ON d.sale_id = s.id
            {where}
            ORDER BY s.sale_date, s.sale_time
        """, params))
        con.close()

        total_invoiced = 0.0
        total_outstanding = 0.0
        running_balance = 0.0
        for r in rows:
            total_invoiced += r["total"] or 0
            if r["payment_method"] == "آجل":
                outstanding = (r["debt_amount"] or 0) - (r["debt_paid"] or 0)
                running_balance += outstanding
                total_outstanding += outstanding
            r["running_balance"] = round(running_balance, 2)

        return _ok({
            "customer": {
                "id": customer["id"], "name": customer["name"], "phone": customer["phone"],
                "customer_type": customer["customer_type"], "company_name": customer["company_name"],
                "credit_limit": customer["credit_limit"],
            },
            "invoices": rows,
            "totals": {
                "total_invoiced": round(total_invoiced, 2),
                "total_outstanding": round(total_outstanding, 2),
                "total_paid": round(total_invoiced - total_outstanding, 2),
            }
        })

    def get_customer_profitability_report(self, customer_type: str = None):
        """تقرير ربحية العملاء: الإيراد وتكلفة البضاعة المباعة (COGS) وهامش الربح
        لكل عميل، بناءً على تكلفة الوحدة المسجلة وقت البيع."""
        con = _conn()
        where = "WHERE s.status != 'ملغاة' AND s.customer_id IS NOT NULL AND s.customer_id != ''"
        params = []
        if customer_type:
            where += " AND p.customer_type = ?"
            params.append(customer_type)
        rows = _rows(con.execute(f"""
            SELECT s.id AS sale_id, s.customer_id, p.name AS customer_name, p.customer_type,
                   s.total AS revenue,
                   COALESCE((SELECT SUM(si.qty * COALESCE(si.cost,0)) FROM sale_items si WHERE si.sale_id = s.id), 0) AS cogs
            FROM sales s
            LEFT JOIN customers p ON p.id = s.customer_id
            {where}
        """, params))
        con.close()

        by_customer = {}
        for r in rows:
            pid = r["customer_id"]
            g = by_customer.setdefault(pid, {
                "customer_id": pid, "customer_name": r["customer_name"] or "عميل محذوف",
                "customer_type": r["customer_type"] or "فرد",
                "orders_count": 0, "revenue": 0.0, "cogs": 0.0,
            })
            g["orders_count"] += 1
            g["revenue"] += r["revenue"] or 0
            g["cogs"] += r["cogs"] or 0

        result = []
        for g in by_customer.values():
            g["profit"] = round(g["revenue"] - g["cogs"], 2)
            g["margin_pct"] = round((g["profit"] / g["revenue"]) * 100, 1) if g["revenue"] else 0.0
            g["revenue"] = round(g["revenue"], 2)
            g["cogs"] = round(g["cogs"], 2)
            result.append(g)
        result.sort(key=lambda x: -x["profit"])
        return _ok(result)

    def get_debt_aging_report(self, customer_type: str = None):
        """تقرير أعمار الديون: تجميع المديونيات المستحقة لكل عميل في شرائح عمرية
        (0-30 / 31-60 / 61-90 / أكثر من 90 يوم) بناءً على تاريخ الفاتورة."""
        con = _conn()
        where = "WHERE d.status != 'مسدد'"
        params = []
        if customer_type:
            where += " AND p.customer_type = ?"
            params.append(customer_type)
        rows = _rows(con.execute(f"""
            SELECT d.id, d.customer_id, p.name AS customer_name, p.phone, p.customer_type, p.credit_limit,
                   (d.amount - d.paid_amount) AS balance,
                   julianday('now') - julianday(d.created_at) AS age_days
            FROM debts d LEFT JOIN customers p ON p.id = d.customer_id
            {where} AND (d.amount - d.paid_amount) > 0.01
        """, params))
        con.close()

        by_customer = {}
        for r in rows:
            pid = r["customer_id"] or "—"
            g = by_customer.setdefault(pid, {
                "customer_id": pid, "customer_name": r["customer_name"] or "عميل محذوف",
                "phone": r["phone"], "customer_type": r["customer_type"] or "فرد",
                "credit_limit": r["credit_limit"] or 0,
                "b0_30": 0.0, "b31_60": 0.0, "b61_90": 0.0, "b90_plus": 0.0, "total": 0.0,
            })
            age = r["age_days"] or 0
            bal = r["balance"] or 0
            if age <= 30: g["b0_30"] += bal
            elif age <= 60: g["b31_60"] += bal
            elif age <= 90: g["b61_90"] += bal
            else: g["b90_plus"] += bal
            g["total"] += bal

        result = sorted(by_customer.values(), key=lambda x: -x["total"])
        totals = {k: sum(g[k] for g in result) for k in ("b0_30", "b31_60", "b61_90", "b90_plus", "total")}
        return _ok({"customers": result, "totals": totals})

    def get_purchase_suggestions(self):
        """اقتراح شراء تلقائي: الأصناف اللي وصلت أو اقتربت من حد النواقص،
        مع اقتراح كمية إعادة الطلب وأفضل مورد سعرًا من تاريخ المشتريات."""
        con = _conn()
        low = _rows(con.execute("""
            SELECT id, name, category, stock, min_stock, unit, supplier_id, cost
            FROM products WHERE is_active = 1 AND is_service = 0 AND stock <= min_stock
            ORDER BY (CASE WHEN min_stock > 0 THEN CAST(stock AS REAL) / min_stock ELSE 0 END), name
        """))
        price_cmp_raw = json.loads(self.get_supplier_price_comparison())["data"]
        best_supplier_by_product = {row["product_id"]: row["suppliers"][0] for row in price_cmp_raw if row["suppliers"]}

        suppliers_map = {s["id"]: s["name"] for s in _rows(con.execute("SELECT id, name FROM suppliers"))}
        con.close()

        suggestions = []
        for m in low:
            suggested_qty = max(1, (m["min_stock"] or 0) * 2 - (m["stock"] or 0))
            best = best_supplier_by_product.get(m["id"])
            suggestions.append({
                "product_id": m["id"], "name": m["name"], "category": m["category"], "unit": m["unit"],
                "current_stock": m["stock"], "min_stock": m["min_stock"],
                "suggested_qty": suggested_qty,
                "urgency": "نفاذ تام" if m["stock"] == 0 else ("عاجل" if m["stock"] <= (m["min_stock"] or 0) / 2 else "طبيعي"),
                "current_supplier": suppliers_map.get(m["supplier_id"], "—"),
                "best_supplier_id": best["supplier_id"] if best else m["supplier_id"],
                "best_supplier_name": best["supplier_name"] if best else suppliers_map.get(m["supplier_id"], "—"),
                "best_price": best["last_price"] if best else (m["cost"] or 0),
                "estimated_cost": round(suggested_qty * (best["last_price"] if best else (m["cost"] or 0)), 2),
            })
        return _ok(suggestions)

    def get_driver_performance_report(self, date_from: str = None, date_to: str = None):
        """تقرير أداء السائقين: عدد التوصيلات، نسبة النجاح، المرتجع والمشاكل، وإجمالي المحصّل."""
        con = _conn()
        where = "WHERE 1=1"
        params = []
        if date_from: where += " AND date(dt.created_at) >= date(?)"; params.append(date_from)
        if date_to:   where += " AND date(dt.created_at) <= date(?)"; params.append(date_to)
        rows = _rows(con.execute(f"""
            SELECT drv.id AS driver_id, drv.name AS driver_name, drv.phone,
                   ds.status, COALESCE(ds.collected_amount,0) AS collected_amount
            FROM delivery_stops ds
            JOIN delivery_trips dt ON dt.id = ds.trip_id
            JOIN drivers drv ON drv.id = dt.driver_id
            {where}
        """, params))
        con.close()

        by_driver = {}
        for r in rows:
            g = by_driver.setdefault(r["driver_id"], {
                "driver_id": r["driver_id"], "driver_name": r["driver_name"], "phone": r["phone"],
                "total_stops": 0, "delivered": 0, "returned": 0, "problem": 0, "pending": 0,
                "total_collected": 0.0,
            })
            g["total_stops"] += 1
            g["total_collected"] += r["collected_amount"] or 0
            if r["status"] == "تم التسليم": g["delivered"] += 1
            elif r["status"] == "مرتجع": g["returned"] += 1
            elif r["status"] == "مشكلة": g["problem"] += 1
            else: g["pending"] += 1

        result = []
        for g in by_driver.values():
            closed = g["delivered"] + g["returned"] + g["problem"]
            g["success_rate"] = round((g["delivered"] / closed) * 100, 1) if closed else 0.0
            result.append(g)
        result.sort(key=lambda x: -x["delivered"])
        return _ok(result)

    def import_products(self, csv_text: str, user_id: str = None):
        """استيراد أصناف من CSV. الأعمدة الإلزامية: name,category,price,cost,stock,unit,min_stock.
        اختيارية: brand,model,barcode,location,warranty_months,track_serial (1 للأجهزة ذات IMEI؛ يُسجَّل رصيدها لاحقًا بأرقامها)."""
        required = {"name", "category", "price", "cost", "stock", "unit", "min_stock"}
        saved, rejected = [], []
        con = None
        try:
            reader = csv.DictReader(io.StringIO((csv_text or "").lstrip("\ufeff")))
            if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
                return _err("أعمدة CSV غير مطابقة للقالب المطلوب: " + "، ".join(sorted(required)))
            con = _conn()
            for line, row in enumerate(reader, start=2):
                try:
                    missing = [k for k in required if not str(row.get(k, "") or "").strip()]
                    if missing: raise ValueError("بيانات ناقصة: " + "، ".join(missing))
                    barcode = str(row.get("barcode") or "").strip()
                    if barcode and (con.execute("SELECT 1 FROM products WHERE barcode=? AND is_active=1", (barcode,)).fetchone()):
                        raise ValueError("باركود مكرر")
                    price, cost = float(row["price"]), float(row["cost"])
                    stock, min_stock = int(float(row["stock"])), int(float(row["min_stock"]))
                    if min(price, cost, stock, min_stock) < 0: raise ValueError("قيم سالبة غير مسموحة")
                    track = 1 if str(row.get("track_serial") or "").strip() in ("1", "نعم", "yes", "true") else 0
                    if track: stock = 0
                    unit = row["unit"].strip()
                    pid = _new_id("PR")
                    con.execute(
                        "INSERT INTO products(id,name,brand,model,category,barcode,price,cost,stock,unit,sale_unit,purchase_unit,"
                        "conversion_factor,location,min_stock,track_serial,warranty_months,is_active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,1)",
                        (pid, row["name"].strip(), (row.get("brand") or "").strip() or None, (row.get("model") or "").strip() or None,
                         row["category"].strip(), barcode or None, price, cost, stock, unit, unit, unit,
                         (row.get("location") or "").strip() or None, min_stock, track, max(0, int(float(row.get("warranty_months") or 0)))))
                    if stock: _log_adjustment(con, pid, 0, stock, "استيراد CSV", user_id)
                    saved.append({"line": line, "id": pid})
                except Exception as exc:
                    rejected.append({"line": line, "reason": str(exc)})
            _audit(con, user_id, "IMPORT_CSV", "product", "bulk", f"محفوظ {len(saved)}، مرفوض {len(rejected)}")
            con.commit(); return _ok({"saved": len(saved), "rejected": len(rejected), "errors": rejected})
        except Exception as e:
            return _err(str(e))
        finally:
            if con: con.close()

    def get_turnover_report(self, days: int = 30):
        days=max(1,min(int(days),365)); con=_conn()
        rows=_rows(con.execute(
            "SELECT m.id,m.name,m.stock,COALESCE(SUM(CASE WHEN s.sale_date>=date('now',?) AND s.status='مكتمل' THEN si.qty ELSE 0 END),0) sold "
            "FROM products m LEFT JOIN sale_items si ON si.product_id=m.id LEFT JOIN sales s ON s.id=si.sale_id "
            "WHERE m.is_active=1 GROUP BY m.id ORDER BY sold DESC",(f'-{days} days',)))
        for r in rows:
            avg=max(1,float(r["stock"])+float(r["sold"])/2); r["turnover_rate"]=round(float(r["sold"])/avg*30/days,3)
            r["classification"]="سريع" if r["turnover_rate"]>=1 else ("راكد" if r["turnover_rate"]<0.2 else "متوسط")
        con.close(); return _ok(rows)

    def get_loyalty(self, customer_id: str):
        con=_conn(); row=con.execute("SELECT points,last_updated FROM loyalty_points WHERE customer_id=?",(customer_id,)).fetchone(); con.close()
        return _ok(dict(row) if row else {"points":0,"last_updated":None})

    def void_sale(self, sale_id: str, user_id: str = None):
        """إلغاء فاتورة: يعيد المخزون ووحدات IMEI، ويلغي دين الآجل المرتبط بها، ويعيد تذكرة الصيانة (إن وُجدت) لحالة الجاهزية."""
        con = None
        try:
            con = _conn()
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone()
            if not row:
                con.rollback(); return _err("الفاتورة غير موجودة")
            if row["status"] == "ملغاة":
                con.rollback(); return _err("هذه الفاتورة ملغاة بالفعل")
            _restore_sale_stock(con, sale_id)
            now = datetime.now().isoformat()
            con.execute("UPDATE sales SET status='ملغاة', voided_by=?, voided_at=? WHERE id=?", (user_id or "system", now, sale_id))
            # الدين المرتبط بفاتورة ملغاة لا يجب أن يظل مطالبة على العميل
            con.execute("UPDATE debts SET status='ملغى', updated_at=? WHERE sale_id=? AND status!='مسدد'", (now, sale_id))
            ticket = con.execute("SELECT id FROM repair_tickets WHERE sale_id=?", (sale_id,)).fetchone()
            if ticket:
                con.execute("UPDATE repair_tickets SET status='جاهز للتسليم', delivered_at=NULL, sale_id=NULL WHERE id=?", (ticket["id"],))
                con.execute("INSERT INTO repair_log(ticket_id,status,note,user_id,created_at) VALUES(?,?,?,?,?)",
                            (ticket["id"], "جاهز للتسليم", f"إلغاء فاتورة التسليم {row['invoice_num']}", user_id, now))
            _audit(con, user_id, "VOID_SALE", "sale", sale_id, f"إلغاء {row['invoice_num']}")
            con.commit()
            return _ok({"invoiceNum": row["invoice_num"]})
        except Exception as e:
            if con: con.rollback()
            return _err(str(e))
        finally:
            if con: con.close()

    # ── STATS ─────────────────────────────────────────────────
    def get_stats(self):
        con   = _conn()
        today = date.today().isoformat()
        month = today[:7]

        total_products      = con.execute("SELECT COUNT(*) FROM products WHERE is_active=1 AND is_service=0").fetchone()[0]
        low_stock       = con.execute(
            "SELECT COUNT(*) FROM products WHERE is_active=1 AND is_service=0 AND stock>0 AND stock<=min_stock").fetchone()[0]
        out_of_stock    = con.execute(
            "SELECT COUNT(*) FROM products WHERE is_active=1 AND is_service=0 AND stock=0").fetchone()[0]
        aged_devices    = con.execute(
            "SELECT COUNT(*) FROM serial_units WHERE status='متاح' AND received_date IS NOT NULL AND received_date<=date('now','-90 days')").fetchone()[0]
        open_repairs    = con.execute(
            "SELECT COUNT(*) FROM repair_tickets WHERE status NOT IN ('تم التسليم','ملغي')").fetchone()[0]
        total_customers  = con.execute("SELECT COUNT(*) FROM customers WHERE is_active=1").fetchone()[0]
        total_suppliers = con.execute("SELECT COUNT(*) FROM suppliers WHERE is_active=1").fetchone()[0]
        total_sales     = con.execute("SELECT COUNT(*) FROM sales").fetchone()[0]
        total_revenue   = con.execute("SELECT COALESCE(SUM(total),0) FROM sales WHERE status='مكتمل'").fetchone()[0]
        today_row = con.execute(
            "SELECT COUNT(*),COALESCE(SUM(total),0) FROM sales WHERE sale_date=? AND status='مكتمل'",
            (today,)).fetchone()
        month_row = con.execute(
            "SELECT COALESCE(SUM(total),0) FROM sales WHERE sale_date LIKE ? AND status='مكتمل'",
            (month+'%',)).fetchone()
        con.close()
        return _ok({
            "totalProducts": total_products, "lowStock": low_stock,
            "outOfStock": out_of_stock, "agedDevices": aged_devices, "openRepairs": open_repairs,
            "totalCustomers": total_customers, "totalSuppliers": total_suppliers,
            "todayCount": today_row[0], "todayRevenue": today_row[1],
            "monthRevenue": month_row[0], "totalSales": total_sales,
            "totalRevenue": total_revenue,
        })

    def get_dashboard_report(self, from_date: str = None, to_date: str = None):
        """Operational sales summary for an explicit inclusive date range."""
        try:
            today = date.today()
            start = date.fromisoformat(from_date) if from_date else today.replace(day=1)
            end = date.fromisoformat(to_date) if to_date else today
        except (TypeError, ValueError):
            return _err("صيغة التاريخ غير صحيحة")

        if start > end:
            return _err("تاريخ البداية يجب أن يسبق تاريخ النهاية")
        if (end - start).days > 730:
            return _err("الحد الأقصى للفترة هو سنتان")

        start_s, end_s = start.isoformat(), end.isoformat()
        con = _conn()
        try:
            summary = con.execute(
                "SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS revenue, "
                "COALESCE(AVG(total),0) AS average, COALESCE(SUM(discount),0) AS discount, "
                "COALESCE(SUM(tax),0) AS tax "
                "FROM sales WHERE status='مكتمل' AND sale_date BETWEEN ? AND ?",
                (start_s, end_s),
            ).fetchone()

            cost = con.execute(
                "SELECT COALESCE(SUM(si.qty * COALESCE(si.cost,0)),0) "
                "FROM sale_items si JOIN sales s ON s.id=si.sale_id "
                "LEFT JOIN products m ON m.id=si.product_id "
                "WHERE s.status='مكتمل' AND s.sale_date BETWEEN ? AND ?",
                (start_s, end_s),
            ).fetchone()[0]

            span_days = (end - start).days + 1
            bucket_sql = "s.sale_date" if span_days <= 62 else "substr(s.sale_date,1,7)"
            series_rows = con.execute(
                f"SELECT {bucket_sql} AS bucket, COALESCE(SUM(s.total),0) AS revenue "
                "FROM sales s WHERE s.status='مكتمل' AND s.sale_date BETWEEN ? AND ? "
                "GROUP BY bucket ORDER BY bucket",
                (start_s, end_s),
            ).fetchall()

            top = _rows(con.execute(
                "SELECT si.name, SUM(si.qty) AS qty, SUM(si.total) AS revenue "
                "FROM sale_items si JOIN sales s ON s.id=si.sale_id "
                "WHERE s.status='مكتمل' AND s.sale_date BETWEEN ? AND ? "
                "GROUP BY si.name ORDER BY qty DESC, revenue DESC LIMIT 5",
                (start_s, end_s),
            ))

            recent = _rows(con.execute(
                "SELECT invoice_num, customer_name, total, sale_date, sale_time, payment_method "
                "FROM sales WHERE status='مكتمل' AND sale_date BETWEEN ? AND ? "
                "ORDER BY sale_date DESC, sale_time DESC LIMIT 6",
                (start_s, end_s),
            ))

            payments = _rows(con.execute(
                "SELECT payment_method AS method, COUNT(*) AS count, COALESCE(SUM(total),0) AS total "
                "FROM sales WHERE status='مكتمل' AND sale_date BETWEEN ? AND ? "
                "GROUP BY payment_method ORDER BY total DESC",
                (start_s, end_s),
            ))

            previous_end = start - timedelta(days=1)
            previous_start = previous_end - timedelta(days=span_days - 1)
            previous_revenue = con.execute(
                "SELECT COALESCE(SUM(total),0) FROM sales "
                "WHERE status='مكتمل' AND sale_date BETWEEN ? AND ?",
                (previous_start.isoformat(), previous_end.isoformat()),
            ).fetchone()[0]

            revenue = float(summary["revenue"] or 0)
            growth = None if not previous_revenue else round(
                ((revenue - previous_revenue) / previous_revenue) * 100, 1
            )
            return _ok({
                "from": start_s,
                "to": end_s,
                "summary": {
                    "count": int(summary["count"] or 0),
                    "revenue": round(revenue, 2),
                    "average": round(float(summary["average"] or 0), 2),
                    "discount": round(float(summary["discount"] or 0), 2),
                    "tax": round(float(summary["tax"] or 0), 2),
                    "estimatedCost": round(float(cost or 0), 2),
                    "estimatedProfit": round(revenue - float(cost or 0), 2),
                    "growthPct": growth,
                },
                "series": {
                    "labels": [r["bucket"] for r in series_rows],
                    "values": [round(float(r["revenue"] or 0), 2) for r in series_rows],
                    "granularity": "day" if span_days <= 62 else "month",
                },
                "topProducts": top,
                "recentSales": recent,
                "payments": payments,
            })
        finally:
            con.close()

    def get_monthly_sales(self):
        con  = _conn()
        year = datetime.now().year
        rows = con.execute(
            "SELECT strftime('%m',sale_date) AS m, COALESCE(SUM(total),0) AS t "
            "FROM sales WHERE sale_date LIKE ? AND status='مكتمل' GROUP BY m ORDER BY m",
            (f"{year}%",)).fetchall()
        con.close()
        values = [0.0]*12
        for r in rows: values[int(r[0])-1] = round(r[1], 2)
        return _ok({"labels":["يناير","فبراير","مارس","إبريل","مايو","يونيو",
                               "يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"],
                    "values": values})

    def get_top_products(self):
        con  = _conn()
        rows = _rows(con.execute(
            "SELECT si.name, SUM(si.qty) AS qty, SUM(si.total) AS revenue "
            "FROM sale_items si JOIN sales s ON s.id=si.sale_id "
            "WHERE s.status='مكتمل' GROUP BY si.name ORDER BY qty DESC LIMIT 5"))
        con.close(); return _ok(rows)

    def get_category_dist(self):
        con  = _conn()
        rows = _rows(con.execute(
            "SELECT category AS cat, COUNT(*) AS count "
            "FROM products WHERE is_active=1 GROUP BY category ORDER BY count DESC"))
        con.close(); return _ok(rows)

    def get_recent_activity(self):
        con  = _conn()
        rows = _rows(con.execute(
            "SELECT id,invoice_num,customer_name,total,sale_date,sale_time,status "
            "FROM sales ORDER BY sale_date DESC, sale_time DESC LIMIT 8"))
        con.close()
        return _ok([{
            "type":  "sale",
            "title": f"فاتورة {r['invoice_num']}",
            "desc":  f"{r['customer_name']} — {r['total']:.2f} ج.م",
            "time":  r["sale_time"], "date": r["sale_date"],
            "icon":  "fa-receipt",
            "color": "var(--err)" if r["status"]=="ملغاة" else "var(--teal-500)",
            "status": r["status"],
        } for r in rows])

    # ── PROFIT REPORT [3.15] ──────────────────────────────────
    def get_profit_report(self, period: str = "all"):
        """period: 'today' | 'month' | 'year' | 'all'"""
        con   = _conn()
        today = date.today().isoformat()
        month = today[:7]
        year  = today[:4]

        filter_sql = ""
        if period == "today": filter_sql = f" AND s.sale_date='{today}'"
        elif period == "month": filter_sql = f" AND s.sale_date LIKE '{month}%'"
        elif period == "year":  filter_sql = f" AND s.sale_date LIKE '{year}%'"

        # ربح كل صنف (بتكلفة الوحدة المسجلة وقت البيع)
        per_product = _rows(con.execute(f"""
            SELECT si.product_id, si.name,
                   SUM(si.qty) AS qty_sold,
                   SUM(si.total) AS revenue,
                   COALESCE(SUM(si.qty*COALESCE(si.cost,0))/NULLIF(SUM(si.qty),0),0) AS unit_cost,
                   SUM(si.qty*COALESCE(si.cost,0)) AS total_cost,
                   SUM(si.total) - SUM(si.qty*COALESCE(si.cost,0)) AS profit,
                   ROUND(
                     CASE WHEN SUM(si.total)>0
                          THEN (SUM(si.total)-SUM(si.qty*COALESCE(si.cost,0)))/SUM(si.total)*100
                          ELSE 0 END, 1
                   ) AS margin_pct
            FROM sale_items si
            JOIN sales s ON s.id=si.sale_id AND s.status='مكتمل'
            LEFT JOIN products m ON m.id=si.product_id
            WHERE 1=1{filter_sql}
            GROUP BY si.product_id, si.name
            ORDER BY profit DESC
        """))

        totals = con.execute(f"""
            SELECT COALESCE(SUM(si.total),0)                               AS revenue,
                   COALESCE(SUM(si.qty*COALESCE(si.cost,0)),0)              AS cost,
                   COALESCE(SUM(si.total)-SUM(si.qty*COALESCE(si.cost,0)),0) AS profit
            FROM sale_items si
            JOIN sales s ON s.id=si.sale_id AND s.status='مكتمل'
            LEFT JOIN products m ON m.id=si.product_id
            WHERE 1=1{filter_sql}
        """).fetchone()

        con.close()
        return _ok({
            "period": period,
            "revenue": round(totals["revenue"], 2),
            "cost":    round(totals["cost"],    2),
            "profit":  round(totals["profit"],  2),
            "margin_pct": round(
                totals["profit"] / totals["revenue"] * 100 if totals["revenue"] else 0, 1),
            "by_product": per_product,
        })

    # ── AUDIT LOG [3.16] ──────────────────────────────────────
    def get_audit_log(self, limit: int = 100, offset: int = 0):
        con  = _conn()
        rows = _rows(con.execute(
            "SELECT al.*, u.full_name "
            "FROM audit_log al "
            "LEFT JOIN users u ON u.id=al.user_id "
            "ORDER BY al.timestamp DESC LIMIT ? OFFSET ?",
            (limit, offset)
        ))
        total = con.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
        con.close(); return _ok({"items": rows, "total": total})

    # ── SETTINGS ──────────────────────────────────────────────
    def get_setting(self, key: str):
        con = _conn()
        row = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        con.close(); return _ok(row[0] if row else None)

    def set_setting(self, key: str, value: str, user_id: str = None):
        key = str(key or "").strip()
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", key):
            return _err("اسم الإعداد غير صالح")
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False)
        elif value is None:
            value = ""
        else:
            value = str(value)
        if len(value.encode("utf-8")) > 2_000_000:
            return _err("قيمة الإعداد أكبر من الحد المسموح")
        con = _conn()
        con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (key, value))
        _audit(con, user_id, "UPDATE_SETTING", "setting", key, "تم تحديث الإعداد")
        con.commit(); con.close(); return _ok()

    # ── BACKUP / RESTORE [3.14] ───────────────────────────────
    def backup_database(self, user_id="system"):
        from backup_store import run_backup
        try: return _ok(run_backup(user_id))
        except Exception as exc: return _err(str(exc))

    def get_backup_status(self):
        from backup_store import status as secondary_status
        from backup_store import managed_backups
        try:
            paths = managed_backups()
            if not paths:
                return _ok({"last_backup": None, "age_days": None, "stale": True, "secondary": secondary_status()})
            latest = max(paths, key=os.path.getmtime)
            modified = datetime.fromtimestamp(os.path.getmtime(latest))
            age_days = (datetime.now() - modified).total_seconds() / 86400
            return _ok({"last_backup": modified.isoformat(), "age_days": round(age_days, 2),
                        "stale": age_days >= 3, "filename": os.path.basename(latest), "secondary": secondary_status()})
        except Exception as e: return _err(str(e))

    def restore_database(self, backup_path: str, user_id: str = None):
        from backup_store import restore_backup
        try: return _ok(restore_backup(backup_path, user_id or "system"))
        except (OSError, sqlite3.Error, ValueError) as exc: return _err(str(exc))

    def list_backups(self):
        from backup_store import managed_backups
        try:
            result = []
            for fp in managed_backups()[:20]:
                f = os.path.basename(fp)
                stat = os.stat(fp)
                result.append({
                    "filename": f,
                    "path":     fp,
                    "size_kb":  round(stat.st_size / 1024, 1),
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                })
            return _ok(result)
        except Exception as e: return _err(str(e))

    # ── AUTH ──────────────────────────────────────────────────
    def login(self, username: str, password: str):
        # Normalize once so "Admin", " admin " and "admin" resolve to the
        # same account and share the same lockout counter.
        global _LOGIN_FAILURES
        username = (username or "").strip().casefold()
        password = password or ""
        if not username or not password:
            return _err("يرجى إدخال اسم المستخدم وكلمة المرور")
        if len(username) > 80 or len(password) > 128:
            return _err("اسم المستخدم أو كلمة المرور غير صحيحة")

        now = datetime.now()
        count, lockout_until = _LOGIN_FAILURES.get(username, (0, None))
        if lockout_until:
            if now < lockout_until:
                remaining = max(1, int((lockout_until - now).total_seconds()))
                return _err(f"الحساب مقفل مؤقتاً. حاول مرة أخرى بعد {remaining} ثانية.")
            # Lock expired: start with a clean counter instead of immediately
            # locking the user again on the next typo.
            _LOGIN_FAILURES.pop(username, None)
            count = 0

        def failed_attempt():
            next_count = count + 1
            if next_count >= _MAX_ATTEMPTS:
                until = now + timedelta(seconds=_LOCKOUT_SECS)
                _LOGIN_FAILURES[username] = (next_count, until)
                return _err(f"تم قفل الحساب مؤقتاً لمدة {_LOCKOUT_SECS//60} دقيقة بسبب محاولات دخول متكررة.")
            _LOGIN_FAILURES[username] = (next_count, None)
            remaining = _MAX_ATTEMPTS - next_count
            return _err(f"اسم المستخدم أو كلمة المرور غير صحيحة. متبقي {remaining} محاولة قبل القفل المؤقت.")

        con = None
        try:
            con = _conn()
            row = con.execute(
                "SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,)
            ).fetchone()
            if not row:
                return failed_attempt()
            user = dict(row)
            if not _verify_password(password, user["password"]):
                return failed_attempt()
            # Success — clear failures, upgrade hash if needed
            _LOGIN_FAILURES.pop(username, None)
            stored = user["password"]
            if not stored.startswith("pbkdf2:"):
                new_hash = _hash_password(password)
                con.execute("UPDATE users SET password=? WHERE id=?", (new_hash, user["id"]))
            now_iso = now.isoformat()
            con.execute("UPDATE users SET last_login=? WHERE id=?", (now_iso, user["id"]))
            _audit(con, user["id"], "LOGIN", "user", user["id"], "تسجيل دخول ناجح")
            con.commit()
            user.pop("password", None)
            # FIX [2.12]: flag default password
            user["is_default_password"] = password in ("admin123", "123456")
            return _ok(user)
        except Exception as e:
            return _err(str(e))
        finally:
            if con is not None:
                con.close()

    def get_users(self):
        con  = _conn()
        rows = _rows(con.execute(
            "SELECT id,username,full_name,role,phone,email,created_at,last_login FROM users ORDER BY full_name"))
        con.close(); return _ok(rows)

    def get_current_user(self, uid: str):
        con = _conn()
        row = con.execute(
            "SELECT id,username,full_name,role,phone,email,created_at,last_login FROM users WHERE id=?",
            (uid,)
        ).fetchone()
        con.close(); return _ok(dict(row) if row else None)

    def change_password(self, uid: str, old_pwd: str, new_pwd: str):
        policy_error = _password_policy_error(new_pwd)
        if policy_error:
            return _err(policy_error)
        if new_pwd == old_pwd:
            return _err("اختر كلمة مرور مختلفة عن الحالية")
        try:
            con = _conn()
            row = con.execute("SELECT password FROM users WHERE id=?", (uid,)).fetchone()
            if not row:
                con.close(); return _err("المستخدم غير موجود")
            if not _verify_password(old_pwd, row["password"]):
                con.close(); return _err("كلمة المرور الحالية غير صحيحة")
            con.execute("UPDATE users SET password=? WHERE id=?",
                        (_hash_password(new_pwd), uid))
            _audit(con, uid, "CHANGE_PASSWORD", "user", uid, "")
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    # ── FIX [3.13]: RBAC permission check ─────────────────────
    def check_permission(self, user_id: str, perm: str):
        con = _conn()
        row = con.execute("SELECT role FROM users WHERE id=?", (user_id,)).fetchone()
        con.close()
        if not row: return _err("المستخدم غير موجود")
        return _ok(_has_perm(row["role"], perm))

    # ── USER MANAGEMENT (admin only) ──────────────────────────
    def add_user(self, data: str, caller_id: str = None):
        try:
            d   = json.loads(data)
            username = str(d.get("username", "")).strip().casefold()
            full_name = str(d.get("full_name", "")).strip()
            role = str(d.get("role", "بائع"))
            pwd = d.get("password", "123456")
            if not 3 <= len(username) <= 50 or any(ch.isspace() or ord(ch) < 32 for ch in username):
                return _err("اسم المستخدم من 3 إلى 50 حرفًا وبدون مسافات")
            if not 2 <= len(full_name) <= 100:
                return _err("اسم المستخدم والاسم الكامل مطلوبان")
            if role not in _ALLOWED_ROLES:
                return _err("الدور الوظيفي غير صالح")
            policy_error = _password_policy_error(pwd, allow_forced_default=True)
            if policy_error:
                return _err(policy_error)
            con = _conn()
            # only admin can add users
            if caller_id:
                caller = con.execute("SELECT role FROM users WHERE id=?", (caller_id,)).fetchone()
                if not caller or caller["role"] != "مدير النظام":
                    con.close(); return _err("غير مصرح — هذه العملية للمدير فقط")
            # check username uniqueness
            dup = con.execute("SELECT id FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
            if dup:
                con.close(); return _err("اسم المستخدم موجود بالفعل")
            nid = _new_id("U")
            con.execute(
                "INSERT INTO users(id,username,password,full_name,role,phone,email,created_at,last_login)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (nid, username, _hash_password(pwd), full_name,
                 role, d.get("phone",""), d.get("email",""),
                 date.today().isoformat(), None)
            )
            _audit(con, caller_id, "ADD_USER", "user", nid, username)
            con.commit(); con.close(); return _ok(nid)
        except Exception as e: return _err(str(e))

    def update_user(self, uid: str, data: str, caller_id: str = None):
        try:
            d   = json.loads(data)
            username = str(d.get("username", "")).strip().casefold() if d.get("username") is not None else ""
            role = str(d.get("role", ""))
            if username and (not 3 <= len(username) <= 50 or any(ch.isspace() or ord(ch) < 32 for ch in username)):
                return _err("اسم المستخدم من 3 إلى 50 حرفًا وبدون مسافات")
            if role not in _ALLOWED_ROLES:
                return _err("الدور الوظيفي غير صالح")
            con = _conn()
            if caller_id:
                caller = con.execute("SELECT role FROM users WHERE id=?", (caller_id,)).fetchone()
                if not caller or caller["role"] != "مدير النظام":
                    con.close(); return _err("غير مصرح — هذه العملية للمدير فقط")
            # check username uniqueness (excluding self)
            if username:
                dup = con.execute(
                    "SELECT id FROM users WHERE username=? COLLATE NOCASE AND id!=?",
                    (username, uid)
                ).fetchone()
                if dup:
                    con.close(); return _err("اسم المستخدم موجود بالفعل")
            con.execute(
                "UPDATE users SET full_name=?, role=?, phone=?, email=?"
                + (", username=?" if username else "")
                + " WHERE id=?",
                ([d.get("full_name"), role, d.get("phone",""), d.get("email","")]
                 + ([username] if username else [])
                 + [uid])
            )
            _audit(con, caller_id, "UPDATE_USER", "user", uid, d.get("full_name",""))
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def delete_user(self, uid: str, caller_id: str = None):
        try:
            con = _conn()
            if caller_id:
                caller = con.execute("SELECT role FROM users WHERE id=?", (caller_id,)).fetchone()
                if not caller or caller["role"] != "مدير النظام":
                    con.close(); return _err("غير مصرح — هذه العملية للمدير فقط")
            if caller_id == uid:
                con.close(); return _err("لا يمكن حذف حسابك الشخصي")
            total = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            if total <= 1:
                con.close(); return _err("لا يمكن حذف المستخدم الوحيد في النظام")
            row = con.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()
            if not row:
                con.close(); return _err("المستخدم غير موجود")
            con.execute("DELETE FROM users WHERE id=?", (uid,))
            _audit(con, caller_id, "DELETE_USER", "user", uid, row["username"])
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def reset_user_password(self, uid: str, data: str, caller_id: str = None):
        try:
            d   = json.loads(data)
            con = _conn()
            if caller_id:
                caller = con.execute("SELECT role FROM users WHERE id=?", (caller_id,)).fetchone()
                if not caller or caller["role"] != "مدير النظام":
                    con.close(); return _err("غير مصرح — هذه العملية للمدير فقط")
            new_pwd = d.get("new_pwd","123456")
            policy_error = _password_policy_error(new_pwd, allow_forced_default=True)
            if policy_error:
                con.close(); return _err(policy_error)
            con.execute("UPDATE users SET password=? WHERE id=?", (_hash_password(new_pwd), uid))
            _audit(con, caller_id, "RESET_PASSWORD", "user", uid, "")
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    # ══════════════════════════════════════════════════════════════
    #  PURCHASES  — نظام المشتريات
    # ══════════════════════════════════════════════════════════════
    def get_purchases(self):
        con = _conn()
        rows = _rows(con.execute(
            "SELECT p.id,p.po_num,p.supplier_id,p.supplier_name,p.status,p.total_cost,p.notes,p.created_by,"
            "p.created_at,p.received_at,p.supplier_invoice_num,p.invoice_date,p.source,"
            "CASE WHEN p.invoice_image_data IS NOT NULL AND p.invoice_image_data<>'' THEN 1 ELSE 0 END AS has_invoice_image,"
            "s.name AS supplier_name_ref "
            "FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id "
            "ORDER BY p.created_at DESC"))
        for r in rows:
            r["items"] = _rows(con.execute(
                "SELECT * FROM purchase_items WHERE purchase_id=?", (r["id"],)))
        con.close(); return _ok(rows)

    def get_purchase(self, pid: str):
        con = _conn()
        row = con.execute(
            "SELECT id,po_num,supplier_id,supplier_name,status,total_cost,notes,created_by,created_at,received_at,"
            "supplier_invoice_num,invoice_date,source,CASE WHEN invoice_image_data IS NOT NULL AND invoice_image_data<>'' "
            "THEN 1 ELSE 0 END AS has_invoice_image FROM purchases WHERE id=?", (pid,)).fetchone()
        if not row: con.close(); return _ok(None)
        p = dict(row)
        p["items"] = _rows(con.execute(
            "SELECT pi.*, COALESCE(m.track_serial,0) AS track_serial FROM purchase_items pi "
            "LEFT JOIN products m ON m.id=pi.product_id WHERE pi.purchase_id=?", (pid,)))
        con.close(); return _ok(p)

    def get_purchase_invoice_image(self, pid: str):
        con = _conn()
        row = con.execute("SELECT invoice_image_data FROM purchases WHERE id=?", (pid,)).fetchone()
        con.close()
        if not row: return _err("الفاتورة غير موجودة")
        return _ok(row["invoice_image_data"])

    def add_captured_purchase(self, data: str, user_id: str = None):
        """حفظ فاتورة مورد مصوّرة للمراجعة قبل إدخال بنودها إلى المخزون."""
        con = None
        try:
            d = json.loads(data)
            from camera_api import validate_image
            validate_image(d.get("invoice_image_data"))
            if not d.get("invoice_image_data"): raise ValueError("اختر صورة الفاتورة")
            invoice_num = str(d.get("supplier_invoice_num") or "").strip()
            invoice_date = str(d.get("invoice_date") or date.today().isoformat()).strip()
            if len(invoice_num) > 100: raise ValueError("رقم فاتورة المورد طويل جداً")
            try: date.fromisoformat(invoice_date)
            except ValueError: raise ValueError("تاريخ الفاتورة غير صالح")
            items = d.get("items") or []
            if not items: raise ValueError("أضف صنفاً واحداً على الأقل للفاتورة")

            con = _conn(); con.execute("BEGIN IMMEDIATE")
            supplier = con.execute("SELECT name FROM suppliers WHERE id=? AND is_active=1", (d.get("supplier_id"),)).fetchone()
            if not supplier: raise ValueError("اختر مورداً صحيحاً")
            prepared = []
            for item in items:
                product = con.execute("SELECT * FROM products WHERE id=? AND is_active=1", (item.get("product_id"),)).fetchone()
                if not product: raise ValueError("أحد أصناف الفاتورة غير موجود")
                qty = float(item.get("qty_ordered", 0)); cost = float(item.get("unit_cost", 0))
                if not qty.is_integer() or qty <= 0: raise ValueError("كمية الفاتورة يجب أن تكون عدداً صحيحاً موجباً")
                if not 0 <= cost < float("inf"): raise ValueError("تكلفة الصنف غير صحيحة")
                prepared.append(dict(product_id=product["id"], product_name=product["name"], qty_ordered=int(qty),
                    unit_cost=cost, purchase_unit=product["purchase_unit"] or product["unit"],
                    sale_unit=product["sale_unit"] or product["unit"], conversion_factor=product["conversion_factor"] or 1))

            nid = _new_id("PO"); year = datetime.now().year
            seq = con.execute("SELECT COALESCE(MAX(CAST(SUBSTR(po_num,8) AS INTEGER)),0) FROM purchases").fetchone()[0] + 1
            po_num = f"PO-{year}-{seq:03d}"; now = datetime.now().isoformat()
            total = sum(i["qty_ordered"] * i["unit_cost"] for i in prepared)
            con.execute("INSERT INTO purchases(id,po_num,supplier_id,supplier_name,status,total_cost,notes,created_by,created_at,"
                "supplier_invoice_num,invoice_date,invoice_image_data,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (nid,po_num,d.get("supplier_id"),supplier["name"],"فاتورة مستلمة",total,str(d.get("notes") or "").strip(),
                 user_id,now,invoice_num or None,invoice_date,d["invoice_image_data"],"captured_invoice"))
            for item in prepared:
                con.execute("INSERT INTO purchase_items(purchase_id,product_id,product_name,qty_ordered,qty_received,unit_cost,total_cost,"
                    "purchase_unit,sale_unit,conversion_factor) VALUES(?,?,?,?,0,?,?,?,?,?)",
                    (nid,item["product_id"],item["product_name"],item["qty_ordered"],item["unit_cost"],
                     item["qty_ordered"]*item["unit_cost"],item["purchase_unit"],item["sale_unit"],item["conversion_factor"]))
            con.execute("UPDATE suppliers SET total_orders=total_orders+1,last_order=? WHERE id=?", (invoice_date,d.get("supplier_id")))
            _audit(con,user_id,"ADD_CAPTURED_INVOICE","purchase",nid,f"{po_num} — {invoice_num or 'بدون رقم'}")
            con.commit(); con.close(); return _ok({"id":nid,"po_num":po_num})
        except Exception as e:
            if con: con.rollback(); con.close()
            return _err(str(e))

    def add_purchase(self, data: str, user_id: str = None):
        """إنشاء أمر شراء جديد (status=مفتوح)"""
        con = None
        try:
            d = json.loads(data)
            con = _conn()
            con.execute("BEGIN IMMEDIATE")
            nid = _new_id("PO")
            year = datetime.now().year
            seq = con.execute(
                "SELECT COALESCE(MAX(CAST(SUBSTR(po_num,8) AS INTEGER)),0) FROM purchases"
            ).fetchone()[0] + 1
            po_num = f"PO-{year}-{seq:03d}"
            now = datetime.now().isoformat()

            supplier = con.execute("SELECT name FROM suppliers WHERE id=?",
                                   (d.get("supplier_id"),)).fetchone()
            sup_name = supplier["name"] if supplier else d.get("supplier_name","")

            if not d.get("items"): raise ValueError("أمر الشراء فارغ")
            for item in d["items"]:
                product = con.execute("SELECT * FROM products WHERE id=? AND is_active=1",(item.get("product_id"),)).fetchone()
                if not product: raise ValueError("صنف الشراء غير موجود")
                qty = float(item.get("qty_ordered",0))
                cost = float(item["unit_cost"]) if item.get("unit_cost") is not None else float(product["cost"] or 0)*(product["conversion_factor"] or 1)
                if not qty.is_integer() or qty <= 0 or not 0 <= cost < float("inf"):
                    raise ValueError("كمية الشراء أو التكلفة غير صحيحة")
                item.update(qty_ordered=int(qty),unit_cost=cost,product_name=product["name"],
                            purchase_unit=product["purchase_unit"] or product["unit"],sale_unit=product["sale_unit"] or product["unit"],conversion_factor=product["conversion_factor"] or 1)
            total_cost = sum(i["unit_cost"]*i["qty_ordered"] for i in d["items"])

            con.execute(
                "INSERT INTO purchases(id,po_num,supplier_id,supplier_name,status,total_cost,notes,created_by,created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (nid, po_num, d.get("supplier_id"), sup_name,
                 "مفتوح", total_cost, d.get("notes",""), user_id, now)
            )
            for item in d.get("items",[]):
                con.execute(
                    "INSERT INTO purchase_items(purchase_id,product_id,product_name,qty_ordered,qty_received,unit_cost,total_cost,purchase_unit,sale_unit,conversion_factor)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (nid, item.get("product_id"), item.get("product_name"),
                     item.get("qty_ordered",0), 0,
                     item.get("unit_cost",0),
                     item.get("unit_cost",0)*item.get("qty_ordered",0),item["purchase_unit"],item["sale_unit"],item["conversion_factor"])
                )
            # تحديث total_orders للمورد
            con.execute(
                "UPDATE suppliers SET total_orders=total_orders+1, last_order=? WHERE id=?",
                (now[:10], d.get("supplier_id"))
            )
            _audit(con, user_id, "ADD", "purchase", nid, po_num)
            con.commit(); con.close(); return _ok({"id": nid, "po_num": po_num})
        except Exception as e:
            if con: con.rollback(); con.close()
            return _err(str(e))

    def receive_purchase(self, pid: str, data: str, user_id: str = None):
        """استلام بضاعة — يُحدّث المخزون وحالة أمر الشراء"""
        con = None
        try:
            d = json.loads(data)
            con = _conn()
            con.execute("BEGIN IMMEDIATE")
            po = con.execute("SELECT * FROM purchases WHERE id=?", (pid,)).fetchone()
            if not po: con.close(); return _err("أمر الشراء غير موجود")
            if po["status"] == "مستلم": con.close(); return _err("تم استلام هذا الأمر بالكامل مسبقاً")
            if po["status"] == "ملغي": con.close(); return _err("لا يمكن استلام أمر ملغي")

            items_received = d.get("items", [])
            now = datetime.now().isoformat()
            seen = set()
            received_any = False

            for item in items_received:
                item_row = con.execute(
                    "SELECT * FROM purchase_items WHERE id=? AND purchase_id=?", (item["item_id"], pid)
                ).fetchone()
                if not item_row or item["item_id"] in seen: raise ValueError("صنف الاستلام لا يتبع الأمر أو مكرر")
                seen.add(item["item_id"])
                raw_qty = float(item.get("qty_received", 0))
                if not raw_qty.is_integer() or raw_qty < 0: raise ValueError("كمية الاستلام يجب أن تكون عددًا صحيحًا غير سالب")
                qty = int(raw_qty)
                if qty > item_row["qty_ordered"] - item_row["qty_received"]: raise ValueError("كمية الاستلام أكبر من المتبقي في الأمر")
                if qty == 0: continue
                received_any = True
                cost_value = item.get("unit_cost")
                unit_cost = float(item_row["unit_cost"] or 0) if cost_value is None else float(cost_value)
                if not 0 <= unit_cost < float("inf"):
                    raise ValueError("تكلفة الوحدة يجب أن تكون رقمًا غير سالب")

                con.execute(
                    "UPDATE purchase_items SET qty_received=qty_received+? WHERE id=?",
                    (qty, item["item_id"])
                )
                # تحديث المخزون
                if item_row["product_id"]:
                    product_units = con.execute("SELECT * FROM products WHERE id=?", (item_row["product_id"],)).fetchone()
                    if not product_units or (product_units["sale_unit"] or product_units["unit"]) != item_row["sale_unit"]:
                        raise ValueError("تغيرت وحدة البيع منذ إنشاء الأمر؛ أعد مراجعة أمر الشراء")
                    factor = max(1, int(item_row["conversion_factor"] or 1))
                    stock_qty = qty * factor
                    per_unit_cost = unit_cost / factor
                    if product_units["track_serial"]:
                        # الأجهزة تُستلم بأرقامها: كل IMEI/Serial وحدة مستقلة بتكلفتها
                        from shop_ops import clean_serials
                        serials = clean_serials(item.get("serials"))
                        if len(serials) != stock_qty:
                            raise ValueError(f"'{product_units['name']}': أدخل {stock_qty} رقم IMEI/Serial (المدخل {len(serials)})")
                        _insert_serial_units(con, product_units, [{"serial": s_} for s_ in serials], per_unit_cost,
                                             purchase_id=pid, received_date=date.today().isoformat())
                    else:
                        con.execute("UPDATE products SET stock=stock+? WHERE id=?", (stock_qty, item_row["product_id"]))
                    # سعر أمر الشراء لوحدة الشراء؛ نخزن تكلفة وحدة البيع (متوسط مرجّح للأصناف العادية).
                    if cost_value is not None:
                        old_stock = max(0, float(product_units["stock"] or 0))
                        if product_units["track_serial"] or old_stock == 0:
                            new_cost = per_unit_cost
                        else:
                            new_cost = round((old_stock * float(product_units["cost"] or 0) + stock_qty * per_unit_cost) / (old_stock + stock_qty), 4)
                        con.execute("UPDATE products SET cost=? WHERE id=?", (new_cost, item_row["product_id"]))

            # تحقق إذا كل الأصناف استُلمت
            if not received_any: raise ValueError("أدخل كمية مستلمة لصنف واحد على الأقل")
            total_ordered  = con.execute(
                "SELECT COALESCE(SUM(qty_ordered),0) FROM purchase_items WHERE purchase_id=?", (pid,)
            ).fetchone()[0]
            total_received = con.execute(
                "SELECT COALESCE(SUM(qty_received),0) FROM purchase_items WHERE purchase_id=?", (pid,)
            ).fetchone()[0]
            new_status = "مستلم" if total_received >= total_ordered else "مستلم جزئياً"

            con.execute(
                "UPDATE purchases SET status=?, received_at=? WHERE id=?",
                (new_status, now, pid)
            )
            _audit(con, user_id, "RECEIVE", "purchase", pid,
                   f"{po['po_num']} — {new_status} — تم تحويل وحدات الشراء إلى وحدات البيع")
            con.commit(); con.close()
            return _ok({"status": new_status})
        except Exception as e:
            if con: con.rollback(); con.close()
            return _err(str(e))

    def cancel_purchase(self, pid: str, user_id: str = None):
        try:
            con = _conn()
            po = con.execute("SELECT po_num,status FROM purchases WHERE id=?", (pid,)).fetchone()
            if not po: con.close(); return _err("أمر الشراء غير موجود")
            if po["status"] in ("مستلم",):
                con.close(); return _err("لا يمكن إلغاء أمر مستلم بالكامل")
            con.execute("UPDATE purchases SET status='ملغي' WHERE id=?", (pid,))
            _audit(con, user_id, "CANCEL", "purchase", pid, po["po_num"])
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    # ══════════════════════════════════════════════════════════════
    #  ACCOUNTS  — نظام الحسابات
    # ══════════════════════════════════════════════════════════════
    def get_accounts(self):
        con = _conn()
        rows = _rows(con.execute(
            "SELECT * FROM accounts WHERE is_active=1 ORDER BY type, name"))
        con.close(); return _ok(rows)

    def add_account(self, data: str, user_id: str = None):
        try:
            d = json.loads(data)
            con = _conn()
            nid = _new_id("AC")
            con.execute(
                "INSERT INTO accounts(id,name,type,balance,notes,is_active,created_at)"
                " VALUES(?,?,?,?,?,1,?)",
                (nid, d.get("name"), d.get("type"), d.get("balance",0),
                 d.get("notes",""), date.today().isoformat())
            )
            _audit(con, user_id, "ADD", "account", nid, d.get("name",""))
            con.commit(); con.close(); return _ok(nid)
        except Exception as e: return _err(str(e))

    def update_account(self, aid: str, data: str, user_id: str = None):
        try:
            d = json.loads(data)
            con = _conn()
            con.execute(
                "UPDATE accounts SET name=?,type=?,notes=? WHERE id=?",
                (d.get("name"), d.get("type"), d.get("notes",""), aid)
            )
            _audit(con, user_id, "UPDATE", "account", aid, d.get("name",""))
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def delete_account(self, aid: str, user_id: str = None):
        try:
            con = _conn()
            linked = con.execute(
                "SELECT COUNT(*) FROM transactions WHERE account_id=?", (aid,)
            ).fetchone()[0]
            if linked:
                con.execute("UPDATE accounts SET is_active=0 WHERE id=?", (aid,))
            else:
                con.execute("DELETE FROM accounts WHERE id=?", (aid,))
            _audit(con, user_id, "DELETE", "account", aid, "")
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def get_transactions(self, account_id: str = None, limit: int = 100, offset: int = 0):
        con = _conn()
        if account_id:
            rows = _rows(con.execute(
                "SELECT t.*, a.name AS account_name FROM transactions t "
                "LEFT JOIN accounts a ON a.id=t.account_id "
                "WHERE t.account_id=? ORDER BY t.created_at DESC LIMIT ? OFFSET ?",
                (account_id, limit, offset)))
            total = con.execute(
                "SELECT COUNT(*) FROM transactions WHERE account_id=?", (account_id,)
            ).fetchone()[0]
        else:
            rows = _rows(con.execute(
                "SELECT t.*, a.name AS account_name FROM transactions t "
                "LEFT JOIN accounts a ON a.id=t.account_id "
                "ORDER BY t.created_at DESC LIMIT ? OFFSET ?",
                (limit, offset)))
            total = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        con.close(); return _ok({"items": rows, "total": total})

    def add_transaction(self, data: str, user_id: str = None):
        try:
            d = json.loads(data)
            con = _conn()
            nid = _new_id("TR")
            amount = float(d.get("amount", 0))
            tx_type = d.get("type")  # دخل / مصروف / تحويل
            now = datetime.now().isoformat()

            con.execute(
                "INSERT INTO transactions(id,account_id,type,amount,description,ref_type,ref_id,created_by,created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (nid, d.get("account_id"), tx_type, amount,
                 d.get("description",""), d.get("ref_type"),
                 d.get("ref_id"), user_id, now)
            )
            # تحديث رصيد الحساب
            delta = amount if tx_type == "دخل" else -amount
            con.execute(
                "UPDATE accounts SET balance=balance+? WHERE id=?",
                (delta, d.get("account_id"))
            )
            _audit(con, user_id, "ADD", "transaction", nid, d.get("description",""))
            con.commit(); con.close(); return _ok(nid)
        except Exception as e: return _err(str(e))

    def get_financial_summary(self):
        con = _conn()
        today = date.today().isoformat()
        month = today[:7]

        accounts = _rows(con.execute("SELECT * FROM accounts WHERE is_active=1"))
        total_income = con.execute(
            "SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='دخل'"
        ).fetchone()[0]
        total_expense = con.execute(
            "SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='مصروف'"
        ).fetchone()[0]
        month_income = con.execute(
            "SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='دخل' AND created_at LIKE ?",
            (month+'%',)
        ).fetchone()[0]
        month_expense = con.execute(
            "SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='مصروف' AND created_at LIKE ?",
            (month+'%',)
        ).fetchone()[0]
        today_income = con.execute(
            "SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='دخل' AND created_at LIKE ?",
            (today+'%',)
        ).fetchone()[0]
        today_expense = con.execute(
            "SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='مصروف' AND created_at LIKE ?",
            (today+'%',)
        ).fetchone()[0]
        con.close()
        return _ok({
            "accounts": accounts,
            "total_income": round(total_income, 2),
            "total_expense": round(total_expense, 2),
            "net": round(total_income - total_expense, 2),
            "month_income": round(month_income, 2),
            "month_expense": round(month_expense, 2),
            "month_net": round(month_income - month_expense, 2),
            "today_income": round(today_income, 2),
            "today_expense": round(today_expense, 2),
        })

    # ══════════════════════════════════════════════════════════════
    #  CASH SESSIONS  — تسوية نهاية اليوم
    # ══════════════════════════════════════════════════════════════
    def get_active_session(self):
        con = _conn()
        row = con.execute(
            "SELECT * FROM cash_sessions WHERE status='مفتوحة' ORDER BY opened_at DESC LIMIT 1"
        ).fetchone()
        con.close(); return _ok(dict(row) if row else None)

    def open_session(self, data: str, user_id: str = None):
        try:
            d = json.loads(data)
            con = _conn()
            # لا يُسمح بجلستين مفتوحتين
            existing = con.execute(
                "SELECT id FROM cash_sessions WHERE status='مفتوحة'"
            ).fetchone()
            if existing:
                con.close(); return _err("توجد جلسة مفتوحة بالفعل. أغلق الجلسة الحالية أولاً.")
            nid = _new_id("CS")
            now = datetime.now().isoformat()
            con.execute(
                "INSERT INTO cash_sessions(id,opened_by,opened_at,opening_cash,status)"
                " VALUES(?,?,?,?,?)",
                (nid, user_id, now, d.get("opening_cash",0), "مفتوحة")
            )
            _audit(con, user_id, "OPEN_SESSION", "cash_session", nid, "")
            con.commit(); con.close(); return _ok(nid)
        except Exception as e: return _err(str(e))

    def close_session(self, sid: str, data: str, user_id: str = None):
        try:
            d = json.loads(data)
            con = _conn()
            session = con.execute(
                "SELECT * FROM cash_sessions WHERE id=?", (sid,)
            ).fetchone()
            if not session: con.close(); return _err("الجلسة غير موجودة")
            if session["status"] != "مفتوحة":
                con.close(); return _err("الجلسة مغلقة بالفعل")

            # حساب مبيعات النقد خلال الجلسة
            payment_rows = con.execute(
                "SELECT payment_method,COALESCE(SUM(total),0) total FROM sales "
                "WHERE status='مكتمل' AND sale_date=? GROUP BY payment_method",
                (date.today().isoformat(),)
            ).fetchall()
            totals={r["payment_method"]:float(r["total"] or 0) for r in payment_rows}
            sales_total=totals.get("نقدي",0); card_total=totals.get("بطاقة",0)
            transfer_total=totals.get("تحويل",0); credit_total=totals.get("آجل",0)

            opening = session["opening_cash"] or 0
            closing = float(d.get("closing_cash", 0))
            actual_card=float(d.get("actual_card",card_total)); actual_transfer=float(d.get("actual_transfer",transfer_total)); actual_credit=float(d.get("actual_credit",credit_total))
            expected = opening + sales_total
            diff = closing - expected
            now = datetime.now().isoformat()

            con.execute(
                "UPDATE cash_sessions SET closed_by=?,closed_at=?,closing_cash=?,"
                "expected_cash=?,difference=?,sales_total=?,card_total=?,transfer_total=?,credit_total=?,actual_card=?,actual_transfer=?,actual_credit=?,status='مغلقة' WHERE id=?",
                (user_id, now, closing, expected, diff, sales_total,card_total,transfer_total,credit_total,actual_card,actual_transfer,actual_credit,sid)
            )
            _audit(con, user_id, "CLOSE_SESSION", "cash_session", sid,
                   f"فرق={diff:.2f}")
            con.commit(); con.close()
            return _ok({
                "sales_total": round(sales_total, 2),
                "expected": round(expected, 2),
                "closing": round(closing, 2),
                "difference": round(diff, 2),
                "channels":{"cash":{"expected":round(expected,2),"actual":round(closing,2),"difference":round(diff,2)},
                            "card":{"expected":round(card_total,2),"actual":round(actual_card,2),"difference":round(actual_card-card_total,2)},
                            "transfer":{"expected":round(transfer_total,2),"actual":round(actual_transfer,2),"difference":round(actual_transfer-transfer_total,2)},
                            "credit":{"expected":round(credit_total,2),"actual":round(actual_credit,2),"difference":round(actual_credit-credit_total,2)}},
            })
        except Exception as e: return _err(str(e))

    def get_sessions(self):
        con = _conn()
        rows = _rows(con.execute(
            "SELECT * FROM cash_sessions ORDER BY opened_at DESC LIMIT 30"))
        con.close(); return _ok(rows)

    # ══════════════════════════════════════════════════════════════
    #  HR & PAYROLL  — الموظفون والأجور
    # ══════════════════════════════════════════════════════════════
    def get_employees(self):
        con = _conn()
        rows = _rows(con.execute(
            "SELECT * FROM employees WHERE is_active=1 ORDER BY full_name"))
        con.close(); return _ok(rows)

    def add_employee(self, data: str, user_id: str = None):
        try:
            d = json.loads(data)
            con = _conn()
            nid = _new_id("EMP")
            con.execute(
                "INSERT INTO employees(id,full_name,role,phone,national_id,hire_date,salary,hourly_rate,is_active,notes)"
                " VALUES(?,?,?,?,?,?,?,?,1,?)",
                (nid, d.get("full_name"), d.get("role"), d.get("phone"),
                 d.get("national_id"), d.get("hire_date"),
                 d.get("salary",0), d.get("hourly_rate",0),
                 d.get("notes",""))
            )
            _audit(con, user_id, "ADD", "employee", nid, d.get("full_name",""))
            con.commit(); con.close(); return _ok(nid)
        except Exception as e: return _err(str(e))

    def update_employee(self, eid: str, data: str, user_id: str = None):
        try:
            d = json.loads(data)
            con = _conn()
            con.execute(
                "UPDATE employees SET full_name=?,role=?,phone=?,national_id=?,"
                "hire_date=?,salary=?,hourly_rate=?,notes=? WHERE id=?",
                (d.get("full_name"), d.get("role"), d.get("phone"),
                 d.get("national_id"), d.get("hire_date"),
                 d.get("salary",0), d.get("hourly_rate",0),
                 d.get("notes",""), eid)
            )
            _audit(con, user_id, "UPDATE", "employee", eid, d.get("full_name",""))
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def delete_employee(self, eid: str, user_id: str = None):
        try:
            con = _conn()
            row = con.execute("SELECT full_name FROM employees WHERE id=?", (eid,)).fetchone()
            if not row: con.close(); return _err("الموظف غير موجود")
            con.execute("UPDATE employees SET is_active=0 WHERE id=?", (eid,))
            _audit(con, user_id, "DELETE", "employee", eid, row["full_name"])
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def get_payroll(self, employee_id: str = None):
        con = _conn()
        if employee_id:
            rows = _rows(con.execute(
                "SELECT p.*, e.full_name FROM payroll p "
                "LEFT JOIN employees e ON e.id=p.employee_id "
                "WHERE p.employee_id=? ORDER BY p.period DESC", (employee_id,)))
        else:
            rows = _rows(con.execute(
                "SELECT p.*, e.full_name FROM payroll p "
                "LEFT JOIN employees e ON e.id=p.employee_id "
                "ORDER BY p.period DESC LIMIT 60"))
        con.close(); return _ok(rows)

    def add_payroll(self, data: str, user_id: str = None):
        try:
            d = json.loads(data)
            con = _conn()
            emp = con.execute(
                "SELECT * FROM employees WHERE id=?", (d.get("employee_id"),)
            ).fetchone()
            if not emp: con.close(); return _err("الموظف غير موجود")
            nid = _new_id("PR")
            base  = float(d.get("base_salary", emp["salary"] or 0))
            bonus = float(d.get("bonus", 0))
            deductions = float(d.get("deductions", 0))
            net = base + bonus - deductions
            now = datetime.now().isoformat()
            con.execute(
                "INSERT INTO payroll(id,employee_id,period,base_salary,bonus,deductions,net_pay,paid_at,paid_by,notes)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (nid, d.get("employee_id"), d.get("period"),
                 base, bonus, deductions, net,
                 now, user_id, d.get("notes",""))
            )
            _audit(con, user_id, "ADD", "payroll", nid,
                   f"{emp['full_name']} — {d.get('period')} — {net:.2f}")
            con.commit(); con.close(); return _ok(nid)
        except Exception as e: return _err(str(e))

    def get_employee_performance(self, employee_id: str = None):
        """تقرير أداء الموظفين: مبيعات كل كاشير"""
        con = _conn()
        if employee_id:
            emp = con.execute(
                "SELECT full_name FROM employees WHERE id=?", (employee_id,)
            ).fetchone()
            cashier_name = emp["full_name"] if emp else None
            if cashier_name:
                rows = _rows(con.execute(
                    "SELECT sale_date, COUNT(*) AS count, SUM(total) AS revenue "
                    "FROM sales WHERE status='مكتمل' AND cashier=? "
                    "GROUP BY sale_date ORDER BY sale_date DESC LIMIT 30",
                    (cashier_name,)))
            else:
                rows = []
        else:
            rows = _rows(con.execute(
                "SELECT cashier, COUNT(*) AS count, SUM(total) AS revenue "
                "FROM sales WHERE status='مكتمل' AND cashier IS NOT NULL AND cashier != '' "
                "GROUP BY cashier ORDER BY revenue DESC"))
        con.close(); return _ok(rows)

    # ══════════════════════════════════════════════════════════
    #  وحدة الشحن والتوزيع (DELIVERY / DISTRIBUTION)
    # ══════════════════════════════════════════════════════════

    # ── DRIVERS ───────────────────────────────────────────────
    def get_drivers(self):
        con = _conn()
        rows = _rows(con.execute("SELECT * FROM drivers WHERE is_active=1 ORDER BY name"))
        con.close(); return _ok(rows)

    def add_driver(self, data: str, user_id: str = None):
        try:
            d, con = json.loads(data), _conn()
            name = str(d.get("name", "")).strip()
            if not name: con.close(); return _err("اسم السائق مطلوب")
            nid = _new_id("DRV")
            con.execute(
                "INSERT INTO drivers(id,name,phone,national_id,license_num,notes,is_active,created_at) "
                "VALUES(?,?,?,?,?,?,1,?)",
                (nid, name, d.get("phone"), d.get("national_id"), d.get("license_num"),
                 d.get("notes"), datetime.now().isoformat())
            )
            _audit(con, user_id, "ADD", "driver", nid, name)
            con.commit(); con.close(); return _ok(nid)
        except Exception as e: return _err(str(e))

    def update_driver(self, did: str, data: str, user_id: str = None):
        try:
            d, con = json.loads(data), _conn()
            old = con.execute("SELECT * FROM drivers WHERE id=?", (did,)).fetchone()
            if not old: con.close(); return _err("السائق غير موجود")
            def val(k): return d[k] if k in d and d.get(k) is not None else old[k]
            con.execute(
                "UPDATE drivers SET name=?,phone=?,national_id=?,license_num=?,notes=? WHERE id=?",
                (val("name"), val("phone"), val("national_id"), val("license_num"), val("notes"), did)
            )
            _audit(con, user_id, "UPDATE", "driver", did, val("name"))
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def delete_driver(self, did: str, user_id: str = None):
        try:
            con = _conn()
            row = con.execute("SELECT name FROM drivers WHERE id=?", (did,)).fetchone()
            if not row: con.close(); return _err("السائق غير موجود")
            linked = con.execute("SELECT COUNT(*) FROM delivery_trips WHERE driver_id=?", (did,)).fetchone()[0]
            if linked:
                con.execute("UPDATE drivers SET is_active=0 WHERE id=?", (did,))
                _audit(con, user_id, "ARCHIVE", "driver", did, f"{row['name']} — له {linked} رحلة")
                con.commit(); con.close()
                return _ok({"archived": True, "message": f"تم أرشفة السائق '{row['name']}' لارتباطه برحلات سابقة"})
            con.execute("DELETE FROM drivers WHERE id=?", (did,))
            _audit(con, user_id, "DELETE", "driver", did, row["name"])
            con.commit(); con.close(); return _ok({"archived": False})
        except Exception as e: return _err(str(e))

    # ── VEHICLES ──────────────────────────────────────────────
    def get_vehicles(self):
        con = _conn()
        rows = _rows(con.execute("SELECT * FROM vehicles WHERE is_active=1 ORDER BY plate_number"))
        con.close(); return _ok(rows)

    def add_vehicle(self, data: str, user_id: str = None):
        try:
            d, con = json.loads(data), _conn()
            plate = str(d.get("plate_number", "")).strip()
            if not plate: con.close(); return _err("رقم اللوحة مطلوب")
            nid = _new_id("VEH")
            con.execute(
                "INSERT INTO vehicles(id,plate_number,vehicle_type,capacity_note,notes,is_active,created_at) "
                "VALUES(?,?,?,?,?,1,?)",
                (nid, plate, d.get("vehicle_type"), d.get("capacity_note"), d.get("notes"),
                 datetime.now().isoformat())
            )
            _audit(con, user_id, "ADD", "vehicle", nid, plate)
            con.commit(); con.close(); return _ok(nid)
        except Exception as e: return _err(str(e))

    def update_vehicle(self, vid: str, data: str, user_id: str = None):
        try:
            d, con = json.loads(data), _conn()
            old = con.execute("SELECT * FROM vehicles WHERE id=?", (vid,)).fetchone()
            if not old: con.close(); return _err("المركبة غير موجودة")
            def val(k): return d[k] if k in d and d.get(k) is not None else old[k]
            con.execute(
                "UPDATE vehicles SET plate_number=?,vehicle_type=?,capacity_note=?,notes=? WHERE id=?",
                (val("plate_number"), val("vehicle_type"), val("capacity_note"), val("notes"), vid)
            )
            _audit(con, user_id, "UPDATE", "vehicle", vid, val("plate_number"))
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def delete_vehicle(self, vid: str, user_id: str = None):
        try:
            con = _conn()
            row = con.execute("SELECT plate_number FROM vehicles WHERE id=?", (vid,)).fetchone()
            if not row: con.close(); return _err("المركبة غير موجودة")
            linked = con.execute("SELECT COUNT(*) FROM delivery_trips WHERE vehicle_id=?", (vid,)).fetchone()[0]
            if linked:
                con.execute("UPDATE vehicles SET is_active=0 WHERE id=?", (vid,))
                _audit(con, user_id, "ARCHIVE", "vehicle", vid, f"{row['plate_number']} — لها {linked} رحلة")
                con.commit(); con.close()
                return _ok({"archived": True, "message": f"تم أرشفة المركبة '{row['plate_number']}' لارتباطها برحلات سابقة"})
            con.execute("DELETE FROM vehicles WHERE id=?", (vid,))
            _audit(con, user_id, "DELETE", "vehicle", vid, row["plate_number"])
            con.commit(); con.close(); return _ok({"archived": False})
        except Exception as e: return _err(str(e))

    # ── DELIVERY TRIPS ────────────────────────────────────────
    def get_delivery_trips(self, status: str = None):
        con = _conn()
        where = "WHERE 1=1"
        params = []
        if status:
            where += " AND t.status=?"
            params.append(status)
        rows = _rows(con.execute(f"""
            SELECT t.*, d.name AS driver_name, d.phone AS driver_phone,
                   v.plate_number, v.vehicle_type,
                   (SELECT COUNT(*) FROM delivery_stops s WHERE s.trip_id=t.id) AS stops_count,
                   (SELECT COUNT(*) FROM delivery_stops s WHERE s.trip_id=t.id AND s.status='تم التسليم') AS delivered_count,
                   (SELECT COALESCE(SUM(expected_amount),0) FROM delivery_stops s WHERE s.trip_id=t.id) AS total_expected,
                   (SELECT COALESCE(SUM(collected_amount),0) FROM delivery_stops s WHERE s.trip_id=t.id) AS total_collected
            FROM delivery_trips t
            LEFT JOIN drivers d ON d.id=t.driver_id
            LEFT JOIN vehicles v ON v.id=t.vehicle_id
            {where}
            ORDER BY t.created_at DESC
        """, params))
        con.close(); return _ok(rows)

    def get_delivery_trip(self, tid: str):
        con = _conn()
        trip = con.execute("""
            SELECT t.*, d.name AS driver_name, d.phone AS driver_phone,
                   v.plate_number, v.vehicle_type
            FROM delivery_trips t
            LEFT JOIN drivers d ON d.id=t.driver_id
            LEFT JOIN vehicles v ON v.id=t.vehicle_id
            WHERE t.id=?
        """, (tid,)).fetchone()
        if not trip: con.close(); return _ok(None)
        stops = _rows(con.execute(
            "SELECT * FROM delivery_stops WHERE trip_id=? ORDER BY seq, created_at", (tid,)))
        for s in stops:
            s["invoices"] = _rows(con.execute(
                "SELECT ds.sale_id, ds.amount, sl.invoice_num, sl.payment_method, sl.status "
                "FROM delivery_stop_sales ds JOIN sales sl ON sl.id=ds.sale_id WHERE ds.stop_id=?",
                (s["id"],)))
        con.close()
        result = dict(trip); result["stops"] = stops
        return _ok(result)

    def add_delivery_trip(self, data: str, user_id: str = None):
        try:
            d, con = json.loads(data), _conn()
            if d.get("driver_id"):
                if not con.execute("SELECT 1 FROM drivers WHERE id=? AND is_active=1", (d["driver_id"],)).fetchone():
                    con.close(); return _err("السائق المختار غير موجود")
            if d.get("vehicle_id"):
                if not con.execute("SELECT 1 FROM vehicles WHERE id=? AND is_active=1", (d["vehicle_id"],)).fetchone():
                    con.close(); return _err("المركبة المختارة غير موجودة")
            con.execute("BEGIN IMMEDIATE")
            today = date.today().isoformat().replace("-", "")
            seq = con.execute(
                "SELECT COUNT(*)+1 FROM delivery_trips WHERE trip_num LIKE ?", (f"TRP-{today}-%",)
            ).fetchone()[0]
            trip_num = f"TRP-{today}-{seq:03d}"
            nid = _new_id("TR")
            con.execute(
                "INSERT INTO delivery_trips(id,trip_num,driver_id,vehicle_id,status,notes,created_by,created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (nid, trip_num, d.get("driver_id"), d.get("vehicle_id"), "قيد التجهيز",
                 d.get("notes"), user_id, datetime.now().isoformat())
            )
            _audit(con, user_id, "ADD", "delivery_trip", nid, trip_num)
            con.commit(); con.close(); return _ok({"id": nid, "trip_num": trip_num})
        except Exception as e:
            try: con.rollback(); con.close()
            except Exception: pass
            return _err(str(e))

    def add_delivery_stop(self, trip_id: str, data: str, user_id: str = None):
        """يضيف توقفًا (شحنة) لعميل داخل رحلة، ويربط به فاتورة أو أكثر لنفس العميل،
        ويولّد باركود تتبّع فريد للتوقف."""
        try:
            d, con = json.loads(data), _conn()
            con.execute("BEGIN IMMEDIATE")
            trip = con.execute("SELECT * FROM delivery_trips WHERE id=?", (trip_id,)).fetchone()
            if not trip: raise ValueError("الرحلة غير موجودة")
            if trip["status"] not in ("قيد التجهيز", "في الطريق"):
                raise ValueError("لا يمكن إضافة توقفات لرحلة مكتملة أو ملغاة")
            customer_id = d.get("customer_id")
            customer = con.execute("SELECT * FROM customers WHERE id=? AND is_active=1", (customer_id,)).fetchone() if customer_id else None
            if not customer: raise ValueError("العميل المختار غير موجود")
            sale_ids = d.get("sale_ids") or []
            if not isinstance(sale_ids, list) or not sale_ids:
                raise ValueError("اختر فاتورة واحدة على الأقل لهذا التوقف")
            already_assigned = con.execute(
                "SELECT sale_id FROM delivery_stop_sales ds JOIN delivery_stops s ON s.id=ds.stop_id "
                "WHERE ds.sale_id IN ({}) AND s.status NOT IN ('مرتجع','مشكلة')".format(
                    ",".join("?" * len(sale_ids))), sale_ids
            ).fetchall()
            if already_assigned:
                raise ValueError("بعض الفواتير مرتبطة بالفعل بشحنة نشطة أخرى")
            total_amount = 0.0
            for sid in sale_ids:
                sale = con.execute(
                    "SELECT id,total,customer_id,status FROM sales WHERE id=? AND status='مكتمل'", (sid,)
                ).fetchone()
                if not sale: raise ValueError(f"فاتورة غير صالحة: {sid}")
                if sale["customer_id"] != customer_id:
                    raise ValueError("كل الفواتير المختارة يجب أن تخص نفس العميل")
                total_amount += sale["total"]
            payment_mode = d.get("payment_mode") or "مسبق"
            if payment_mode not in ("مسبق", "عند التسليم"):
                raise ValueError("طريقة الدفع غير صحيحة")
            seq = con.execute("SELECT COALESCE(MAX(seq),0)+1 FROM delivery_stops WHERE trip_id=?", (trip_id,)).fetchone()[0]
            barcode = "SHP-" + uuid.uuid4().hex[:10].upper()
            nid = _new_id("STP")
            con.execute(
                "INSERT INTO delivery_stops(id,trip_id,seq,customer_id,customer_name,address,phone,barcode,"
                "payment_mode,expected_amount,collected_amount,status,notes,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?)",
                (nid, trip_id, seq, customer_id, customer["name"], d.get("address") or customer["address"],
                 d.get("phone") or customer["phone"], barcode, payment_mode, total_amount,
                 "قيد الانتظار", d.get("notes"), datetime.now().isoformat())
            )
            for sid in sale_ids:
                amt = con.execute("SELECT total FROM sales WHERE id=?", (sid,)).fetchone()["total"]
                con.execute("INSERT INTO delivery_stop_sales(stop_id,sale_id,amount) VALUES(?,?,?)", (nid, sid, amt))
            _audit(con, user_id, "ADD", "delivery_stop", nid, f"{trip['trip_num']} — {customer['name']} — {barcode}")
            con.commit(); con.close()
            return _ok({"id": nid, "barcode": barcode, "expected_amount": total_amount})
        except Exception as e:
            try: con.rollback(); con.close()
            except Exception: pass
            return _err(str(e))

    def get_unassigned_sales_for_customer(self, customer_id: str):
        """فواتير العميل المكتملة غير المرتبطة حاليًا بأي شحنة نشطة — لاختيارها عند إضافة توقف."""
        con = _conn()
        rows = _rows(con.execute("""
            SELECT sl.id, sl.invoice_num, sl.total, sl.payment_method, sl.sale_date
            FROM sales sl
            WHERE sl.customer_id=? AND sl.status='مكتمل'
              AND sl.id NOT IN (
                  SELECT ds.sale_id FROM delivery_stop_sales ds
                  JOIN delivery_stops s ON s.id=ds.stop_id
                  WHERE s.status NOT IN ('مرتجع','مشكلة')
              )
            ORDER BY sl.sale_date DESC LIMIT 100
        """, (customer_id,)))
        con.close(); return _ok(rows)

    def dispatch_trip(self, trip_id: str, user_id: str = None):
        try:
            con = _conn()
            trip = con.execute("SELECT * FROM delivery_trips WHERE id=?", (trip_id,)).fetchone()
            if not trip: con.close(); return _err("الرحلة غير موجودة")
            if trip["status"] != "قيد التجهيز": con.close(); return _err("الرحلة ليست قيد التجهيز")
            stops = con.execute("SELECT COUNT(*) FROM delivery_stops WHERE trip_id=?", (trip_id,)).fetchone()[0]
            if not stops: con.close(); return _err("أضف توقفًا واحدًا على الأقل قبل بدء الرحلة")
            if not trip["driver_id"]: con.close(); return _err("حدد السائق قبل بدء الرحلة")
            now = datetime.now().isoformat()
            con.execute("UPDATE delivery_trips SET status='في الطريق', dispatched_at=? WHERE id=?", (now, trip_id))
            con.execute("UPDATE delivery_stops SET status='في الطريق' WHERE trip_id=? AND status='قيد الانتظار'", (trip_id,))
            _audit(con, user_id, "DISPATCH", "delivery_trip", trip_id, trip["trip_num"])
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def cancel_trip(self, trip_id: str, user_id: str = None):
        try:
            con = _conn()
            trip = con.execute("SELECT * FROM delivery_trips WHERE id=?", (trip_id,)).fetchone()
            if not trip: con.close(); return _err("الرحلة غير موجودة")
            if trip["status"] == "مكتملة": con.close(); return _err("لا يمكن إلغاء رحلة مكتملة")
            con.execute("UPDATE delivery_trips SET status='ملغاة' WHERE id=?", (trip_id,))
            con.execute("UPDATE delivery_stops SET status='مشكلة',notes=COALESCE(notes,'')||' — أُلغيت الرحلة' WHERE trip_id=? AND status NOT IN ('تم التسليم','مرتجع')", (trip_id,))
            _audit(con, user_id, "CANCEL", "delivery_trip", trip_id, trip["trip_num"])
            con.commit(); con.close(); return _ok()
        except Exception as e: return _err(str(e))

    def get_stop_by_barcode(self, barcode: str):
        con = _conn()
        row = con.execute("""
            SELECT s.*, t.trip_num, t.status AS trip_status, d.name AS driver_name
            FROM delivery_stops s
            JOIN delivery_trips t ON t.id=s.trip_id
            LEFT JOIN drivers d ON d.id=t.driver_id
            WHERE s.barcode=?
        """, (barcode.strip(),)).fetchone()
        if not row: con.close(); return _ok(None)
        result = dict(row)
        result["invoices"] = _rows(con.execute(
            "SELECT ds.sale_id, ds.amount, sl.invoice_num FROM delivery_stop_sales ds "
            "JOIN sales sl ON sl.id=ds.sale_id WHERE ds.stop_id=?", (row["id"],)))
        con.close(); return _ok(result)

    def update_stop_status(self, stop_id: str, data: str, user_id: str = None):
        """تحديث حالة التسليم: تم التسليم / مرتجع / مشكلة — مع تحصيل المبلغ عند التسليم
        وتسوية أي مديونية مرتبطة بالفواتير الآجلة تلقائيًا."""
        try:
            d, con = json.loads(data), _conn()
            con.execute("BEGIN IMMEDIATE")
            stop = con.execute("SELECT * FROM delivery_stops WHERE id=?", (stop_id,)).fetchone()
            if not stop: raise ValueError("الشحنة غير موجودة")
            if stop["status"] in ("تم التسليم", "مرتجع"):
                raise ValueError("هذه الشحنة مغلقة بالفعل")
            new_status = d.get("status")
            if new_status not in ("تم التسليم", "مرتجع", "مشكلة", "في الطريق"):
                raise ValueError("حالة غير صحيحة")
            collected = float(d.get("collected_amount") or 0)
            if collected < 0 or collected > stop["expected_amount"] + 0.01:
                raise ValueError("المبلغ المحصّل غير صحيح")
            now = datetime.now().isoformat()
            con.execute(
                "UPDATE delivery_stops SET status=?,collected_amount=?,notes=?,delivered_at=? WHERE id=?",
                (new_status, collected if new_status == "تم التسليم" else stop["collected_amount"],
                 d.get("notes", stop["notes"]),
                 now if new_status in ("تم التسليم", "مرتجع") else stop["delivered_at"], stop_id)
            )
            sale_ids = [r[0] for r in con.execute(
                "SELECT sale_id FROM delivery_stop_sales WHERE stop_id=?", (stop_id,)).fetchall()]

            # الشحنة المرتجعة: ترجيع الأصناف ووحدات IMEI للمخزون، وإلغاء الفاتورة
            # وأي دين مرتبط بيها — بنفس منطق إلغاء الفاتورة العادي، عشان المخزون والحسابات
            # تفضل متوازنة ومفيش صنف ولا فلوس ضايعة بسبب رفض العميل استلام الشحنة.
            if new_status == "مرتجع":
                for sid in sale_ids:
                    sale_row = con.execute("SELECT * FROM sales WHERE id=?", (sid,)).fetchone()
                    if not sale_row or sale_row["status"] == "ملغاة":
                        continue
                    _restore_sale_stock(con, sid)
                    con.execute(
                        "UPDATE sales SET status='ملغاة', voided_by=?, voided_at=? WHERE id=?",
                        (user_id or "system", now, sid)
                    )
                    con.execute("DELETE FROM debts WHERE sale_id=?", (sid,))
                    _audit(con, user_id, "RETURN_VOID_SALE", "sale", sid,
                           f"إلغاء بسبب مرتجع شحنة {stop['barcode']}")

            # تسوية المديونية تلقائيًا عند تحصيل مبلغ عند التسليم لفواتير آجلة مرتبطة
            if new_status == "تم التسليم" and stop["payment_mode"] == "عند التسليم" and collected > 0:
                remaining = collected
                for sid in sale_ids:
                    if remaining <= 0: break
                    debt = con.execute(
                        "SELECT * FROM debts WHERE sale_id=? AND status IN ('مستحق','مسدد جزئياً')", (sid,)
                    ).fetchone()
                    if not debt: continue
                    owed = debt["amount"] - debt["paid_amount"]
                    pay = min(remaining, owed)
                    new_paid = debt["paid_amount"] + pay
                    new_debt_status = "مسدد" if new_paid >= debt["amount"] - 0.01 else "مسدد جزئياً"
                    con.execute(
                        "UPDATE debts SET paid_amount=?,status=?,updated_at=? WHERE id=?",
                        (new_paid, new_debt_status, now, debt["id"])
                    )
                    remaining -= pay
            _audit(con, user_id, "UPDATE_STATUS", "delivery_stop", stop_id, f"{stop['barcode']} → {new_status}")
            # لو كل توقفات الرحلة اتقفلت، اقفل الرحلة تلقائيًا
            trip_id = stop["trip_id"]
            open_stops = con.execute(
                "SELECT COUNT(*) FROM delivery_stops WHERE trip_id=? AND status NOT IN ('تم التسليم','مرتجع','مشكلة')",
                (trip_id,)
            ).fetchone()[0]
            if open_stops == 0:
                con.execute("UPDATE delivery_trips SET status='مكتملة',completed_at=? WHERE id=? AND status!='ملغاة'", (now, trip_id))
            con.commit(); con.close(); return _ok()
        except Exception as e:
            try: con.rollback(); con.close()
            except Exception: pass
            return _err(str(e))

    def get_delivery_stats(self):
        con = _conn()
        row = con.execute("""
            SELECT
                (SELECT COUNT(*) FROM delivery_trips WHERE status='قيد التجهيز') AS preparing,
                (SELECT COUNT(*) FROM delivery_trips WHERE status='في الطريق') AS on_road,
                (SELECT COUNT(*) FROM delivery_stops WHERE status='قيد الانتظار' OR status='في الطريق') AS pending_stops,
                (SELECT COUNT(*) FROM delivery_stops WHERE status='مشكلة') AS problem_stops,
                (SELECT COALESCE(SUM(expected_amount),0) FROM delivery_stops WHERE status IN ('قيد الانتظار','في الطريق')) AS amount_in_transit
        """).fetchone()
        con.close(); return _ok(dict(row))

