# خريطة مشروع hMarket Shop System

هذا الملف هو نقطة البداية قبل البحث في المشروع. استخدم الجدول التالي للوصول إلى مكان الميزة مباشرة، ثم استخدم `rg` داخل الملفات المحددة فقط.

## مسار الطلب داخل النظام

```text
index.html
  → src/js/app.js (التشغيل، التنقل، البحث العام)
  → src/js/pages/<page>.js (واجهة الشاشة وسلوكها)
  → src/js/data.js (طلبات HTTP وتوحيد أسماء الحقول)
  → routes.py أو أحد ملفات المسارات المتخصصة
  → api.py / shop_ops.py (منطق العمل وSQLite)
  → shop.db
```

## ملفات التشغيل والبنية الأساسية

| الملف | المسؤولية |
|---|---|
| `run.bat` | نقطة التشغيل على Windows وفحص Python والمتطلبات. |
| `main.py` | تهيئة قاعدة البيانات وتشغيل Flask داخل نافذة PyWebView. |
| `index.html` | هيكل التطبيق العام، القائمة الجانبية، الشريط العلوي، وترتيب تحميل CSS/JS. |
| `src/js/app.js` | تسجيل الدخول، التنقل بين الصفحات، البحث العام، التنبيهات، والتهيئة. |
| `src/js/data.js` | طبقة الاتصال الموحدة بكل `/api/...` وتحويل حقول Python إلى JavaScript. |
| `src/js/utils.js` | النوافذ المنبثقة، الرسائل، التنسيق، CSV، الباركود، والتقسيم إلى صفحات. |
| `routes.py` | أغلب مسارات Flask العامة وربطها بدوال `ShopAPI`. |
| `api.py` | مخطط SQLite، migrations، البيانات التجريبية، ومنطق العمل الرئيسي. |
| `server_auth.py` | جلسة HTTP وتسجيل الدخول وحماية المسارات. |
| `shop_ops.py` | عمليات المتجر المتخصصة، الصلاحيات، المسودات، وبعض استعلامات المخزون. |
| `shop.db` | قاعدة البيانات المحلية الفعلية (غير متتبعة في Git). |

## دليل الشاشات

| الشاشة | الواجهة | أهم منطق Backend |
|---|---|---|
| لوحة التحكم | `src/js/pages/dashboard.js` | تقارير الإحصاءات في `api.py` و`reports_excel.py`. |
| الأصناف والمخزون | `src/js/pages/products.js` | قسم PRODUCTS في `routes.py` و`api.py`. |
| نقطة البيع | `src/js/pages/sales.js`, `src/js/pos-draft.js` | قسم SALES في `routes.py` و`api.py`. |
| الفواتير | `src/js/pages/invoices.js` | دوال المبيعات والإلغاء في `api.py`. |
| المشتريات | `src/js/pages/purchases.js` | قسم PURCHASES في `routes.py` و`inventory_entry.py`. |
| الجرد | `src/js/pages/stocktake.js` | STOCKTAKE / STOCK LEDGER في `routes.py` و`api.py`. |
| النواقص | `src/js/pages/shortage.js` | `get_low_stock` واقتراحات الشراء. |
| العملاء | `src/js/pages/customers.js` | قسم CUSTOMERS في `routes.py` و`api.py`. |
| الموردون | `src/js/pages/suppliers.js` | قسم SUPPLIERS في `routes.py` و`api.py`. |
| الصيانة | `src/js/pages/repairs.js` | قسم REPAIRS في `routes.py` و`api.py`. |
| الضمان وIMEI | `src/js/pages/warranty.js` | SERIAL / IMEI + WARRANTY في `routes.py`, `api.py`, `camera_api.py`. |
| الحسابات | `src/js/pages/accounts.js` | ACCOUNTS وCASH SESSIONS في `routes.py` و`api.py`. |
| الديون | `src/js/pages/debts.js` | دوال debts وcustomer statements في `api.py`. |
| الموارد البشرية | `src/js/pages/hr.js` | HR & PAYROLL في `routes.py` و`api.py`. |
| الشحن والتوزيع | `src/js/pages/delivery.js` | DELIVERY في `routes.py`, `delivery_pdf.py`, `tracking_page.py`. |
| العروض | `src/js/pages/promotions.js` | PROMOTIONS في `routes.py` و`api.py`. |
| التقارير | `src/js/pages/reports.js` | STATS / REPORTS في `api.py` و`reports_excel.py`. |
| الإعدادات | `src/js/pages/settings.js` | SETTINGS، المستخدمون، النسخ الاحتياطي، وسجل التدقيق. |

## الكاميرا والباركود والطباعة

| الملف | المسؤولية |
|---|---|
| `src/js/camera.js` | تشغيل الكاميرا والتقاط الصور. |
| `src/js/camera-workflows.js` | تدفقات مسح الصنف والجرد والاستلام. |
| `camera_api.py` | حل الباركود/IMEI والتحقق من الصور ومسودات المسح. |
| `labels_pdf.py` | PDF ملصقات السعر والباركود. |
| `delivery_pdf.py` | مستندات الشحن والتوصيل. |
| `statement_pdf.py` | كشف حساب العميل PDF. |

## التصميم

يُحمّل CSS من `index.html`. عند تعارض القواعد راجع ترتيب التحميل أولًا.

| الملف | الاستخدام |
|---|---|
| `src/css/main.css` | الهيكل الأساسي والمكونات العامة. |
| `src/css/components.css` | مكونات إضافية وجداول ونماذج. |
| `src/css/professional.css` | التخصيص النهائي والكثافة والوضع الداكن؛ غالبًا قواعده هي الحاسمة. |
| `src/css/animations.css` | الحركة والمؤثرات. |
| `src/css/camera.css` | واجهات الكاميرا والمسح. |
| `src/css/login.css` | شاشة الدخول. |

## التخزين والملفات الناتجة

| المسار | المحتوى |
|---|---|
| `shop.db` | بيانات المتجر. |
| `backups/` | النسخ الاحتياطية المحلية. |
| `exports/` | ملفات CSV التي ينشئها التصدير داخل التطبيق. |
| `assets/` | الصور والخطوط والأصول الثابتة. |
| `tests/` | اختبارات Python وJavaScript. |

## أين أبدأ حسب نوع المشكلة؟

- زر أو نافذة أو حقل لا يعمل: ابدأ بملف الشاشة في `src/js/pages/` ثم `src/js/utils.js`.
- بيانات ناقصة أو طلب فاشل: تتبع الاستدعاء من `src/js/data.js` إلى `routes.py` ثم `api.py`.
- بطء شاشة: افحص الطلبات في `afterRender()` داخل ملف الشاشة، ثم الاستعلام المقابل في `api.py` والفهارس.
- مشكلة شكل أو تمرير: افحص العنصر في ملف الشاشة، ثم ابحث عن الكلاس في `professional.css` و`main.css`.
- مشكلة باركود أو IMEI: ابدأ بـ`camera_api.py` و`camera-workflows.js` ثم دوال serial في `api.py`.
- مشكلة صلاحيات أو دخول: `server_auth.py` ثم دالة `_require` في `routes.py` و`permission` في `shop_ops.py`.
- مشكلة تصدير الأصناف: `exportData()` في `products.js` → `exportProductsCSV()` في `data.js` → `/api/export_products_csv` في `routes.py` → `export_products_csv()` في `api.py`.

## أوامر فحص سريعة

```powershell
# البحث عن ميزة أو نص واجهة
rg -n "النص أو اسم الدالة" src routes.py api.py

# فحص Python
.\.python\python.exe -m py_compile api.py routes.py main.py

# فحص JavaScript
node --check src/js/app.js
node --check src/js/pages/products.js

# تشغيل الاختبارات
.\.python\python.exe -m unittest discover -s tests
node tests/test_auth_cache.cjs
node tests/test_camera.cjs
node tests/test_operations.cjs
```

## قواعد تمنع البحث العشوائي

1. حدد الشاشة من جدول الشاشات.
2. ابحث عن معرّف الزر أو اسم دالة الحدث في ملف الشاشة.
3. إذا وُجد استدعاء `DB.*`، انتقل إلى الدالة المطابقة في `data.js`.
4. طابق اسم `/api/...` مع `routes.py` ثم دالة `api.py`.
5. لا تعدّل `shop.db` يدويًا؛ أي تغيير في البنية يتم عبر تهيئة/migration في `api.py`.
6. بعد التعديل شغّل فحص التركيب والاختبار الأقرب للميزة فقط قبل تشغيل المجموعة الكاملة.
