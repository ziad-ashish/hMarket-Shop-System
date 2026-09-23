# ══════════════════════════════════════════════════════════════
#  MAIN.PY  —  Shop Management System  |  Desktop App
#  Engine  : PyWebView 6.x
#  Backend : api.py  (SQLite)
# ══════════════════════════════════════════════════════════════

import os
import socket
import threading
import time
import webview
from flask import Flask
from api import init_db, seed_if_empty, auto_backup, _conn
from routes import register_routes
from tracking_page import register_routes as register_tracking_routes

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TRACKING_PORT = 8765


def _backup_worker():
    """نسخة عند بدء التشغيل ثم كل 24 ساعة، بدون تعطيل واجهة البائع."""
    while True:
        try:
            auto_backup()
        except Exception as exc:
            print(f"[backup] تعذر إنشاء النسخة الاحتياطية: {exc}")
        time.sleep(24 * 60 * 60)


def _local_lan_ip():
    """يحدد عنوان IP الخاص بالجهاز على الشبكة المحلية (بدون إرسال بيانات فعليًا،
    مجرد إنشاء اتصال UDP وهمي لمعرفة الواجهة الصادرة)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def _tracking_worker():
    """يشغّل خادمًا منفصلًا وصغيرًا لا يحتوي إلا على صفحة تتبع الشحنة العامة
    (بدون أي واجهة API حساسة)، متاحًا على الشبكة المحلية بالكامل (0.0.0.0)
    فقط إذا فعّل صاحب المحل الخيار من الإعدادات — الخادم الرئيسي للتطبيق
    يبقى دائمًا محصورًا على هذا الجهاز (127.0.0.1) بواسطة PyWebView."""
    try:
        con = _conn()
        row = con.execute("SELECT value FROM settings WHERE key='public_tracking_enabled'").fetchone()
        enabled = bool(row and row[0] == "1")
        port_row = con.execute("SELECT value FROM settings WHERE key='public_tracking_port'").fetchone()
        port = int(port_row[0]) if port_row and port_row[0] else DEFAULT_TRACKING_PORT
        con.close()
    except Exception:
        enabled, port = False, DEFAULT_TRACKING_PORT

    if not enabled:
        return

    tracking_app = Flask("shop_tracking")
    register_tracking_routes(tracking_app)
    ip = _local_lan_ip()
    print(f"[tracking] صفحة تتبع الشحنات متاحة على الشبكة المحلية: http://{ip}:{port}/track")
    try:
        tracking_app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
    except Exception as exc:
        print(f"[tracking] تعذر تشغيل خادم التتبع العام على المنفذ {port}: {exc}")


def create_app():
    """Create the local web application used by the desktop window."""
    app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
    app.config['MAX_CONTENT_LENGTH'] = 8 * 1024 * 1024
    register_routes(app)

    @app.get("/")
    def index():
        return app.send_static_file("index.html")

    return app


def main():
    init_db()
    seed_if_empty()
    threading.Thread(target=_backup_worker, name="shop-auto-backup", daemon=True).start()
    threading.Thread(target=_tracking_worker, name="shop-public-tracking", daemon=True).start()

    app = create_app()

    webview.create_window(
        title            = "Shop Management System",
        # Passing the Flask app makes PyWebView host it on a local HTTP server.
        # This keeps the UI, REST API and SQLite database on the same backend.
        url              = app,
        width            = 1380,
        height           = 820,
        min_size         = (1024, 680),
        resizable        = True,
        text_select      = False,
        background_color = "#0d2b2e",
    )

    # أدوات المطور تجعل WebView يفتح نافذة Edge DevTools وتشوّش تشغيل المحل.
    # تبقى مغلقة في نسخة الاستخدام اليومي، ويمكن تفعيلها مؤقتاً أثناء التطوير فقط.
    webview.start(debug=False)


if __name__ == "__main__":
    main()

