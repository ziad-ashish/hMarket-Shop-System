/* ════════════════════════════════════════════════════════════
   PAGE: PRODUCTS & INVENTORY
   أصناف المحل: موبايلات (بأرقام IMEI) • إكسسوارات • أدوات كهربائية • قطع غيار • خدمات
════════════════════════════════════════════════════════════ */
'use strict';

const ProductsPage = (() => {
  let _filter = 'all';
  let _search = '';
  let _cat    = '';
  let _allProducts = [];
  let _agedIds = new Set();
  let _savedImage;            // undefined = بدون تغيير، null = إزالة، نص = صورة جديدة (base64)

  const DEFAULT_CATEGORIES = ['موبايلات', 'إكسسوارات موبايل', 'أدوات كهربائية', 'مستلزمات كهرباء', 'قطع غيار', 'خدمات'];
  const UNITS = ['قطعة', 'جهاز', 'طقم', 'متر', 'كيلو', 'لتر', 'علبة', 'كرتونة', 'بكرة', 'لفة', 'خدمة'];

  /* ── PAGE SHELL ─────────────────────────────────────── */
  function render() {
    return `
<div class="page active" id="page-products">
  <div class="pg-header">
    <div class="pg-title-group">
      <h1 class="pg-title">
        <div class="pg-title-icon" style="background:var(--amb-100);color:var(--amb-700)"><i class="fas fa-boxes-stacked"></i></div>
        الأصناف والمخزون
      </h1>
      <p class="pg-subtitle">موبايلات بأرقام IMEI • إكسسوارات • أدوات كهربائية • قطع غيار • خدمات</p>
    </div>
    <div class="pg-actions">
      <button type="button" class="btn btn-ghost" id="addInventoryInvoice"><i class="fas fa-file-invoice"></i> إضافة فاتورة</button>
      <button class="btn btn-ghost btn-sm" id="productExportBtn"><i class="fas fa-download"></i> تصدير</button>
      <button class="btn btn-amber" id="productAddBtn"><i class="fas fa-plus"></i> إضافة صنف</button>
    </div>
  </div>

  <div class="inventory-strip" id="productInsightBar">
    <div class="inventory-strip-loading">جارٍ قراءة حالة المخزون...</div>
  </div>

  <div class="tabs" id="productTabs">
    <button class="tab-btn active" data-f="all">الكل</button>
    <button class="tab-btn" data-f="low">مخزون منخفض</button>
    <button class="tab-btn" data-f="out">نفد المخزون</button>
    <button class="tab-btn" data-f="devices">أجهزة IMEI</button>
    <button class="tab-btn" data-f="aged">أجهزة راكدة +90 يوم</button>
  </div>

  <div class="toolbar">
    <div class="tb-srch">
      <i class="fas fa-magnifying-glass"></i>
      <input type="search" id="productSearch" placeholder="بحث بالاسم أو الماركة أو الموديل أو الباركود..." />
    </div>
    <div class="cat-filters" id="catFilters"></div>
    <button class="btn btn-ghost" id="manageCategories">إدارة التصنيفات</button>
  </div>

  <div class="card">
    <div class="card-body p0">
      <div class="tbl-wrap">
        <table class="dtable">
          <thead><tr>
            <th></th><th>الباركود</th><th>الصنف</th><th>التصنيف</th><th>السعر</th>
            <th>المخزون</th><th>الضمان</th><th>الموقع</th><th>الإجراءات</th>
          </tr></thead>
          <tbody id="productTbody">
            <tr><td colspan="9"><div class="empty-state">
              <div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div>
              <h3 class="es-title">جارٍ التحميل...</h3>
            </div></td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="card-foot"><div class="pagination" id="productPager"></div></div>
  </div>
</div>`;
  }

  async function afterRender() {
    document.getElementById('addInventoryInvoice').onclick = () => InventoryEntry.open().catch(e => Toast.err('تعذر فتح الفاتورة',e.message));
    document.getElementById('manageCategories').onclick = () => InventoryEntry.categories(_loadData);
    document.getElementById('capturedInvoiceBtn')?.addEventListener('click', () => document.getElementById('capturedInvoiceFile')?.click());
    document.getElementById('capturedInvoiceFile')?.addEventListener('change', async event => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      if (!file) return;
      try {
        const imageData = await _prepareInvoiceImage(file);
        await openCapturedInvoiceModal(imageData, file.name);
      } catch (error) { Toast.err('تعذر فتح الفاتورة', error.message); }
      finally { input.value = ''; }
    });
    document.getElementById('productAddBtn')?.addEventListener('click', () => openAddModal());
    document.getElementById('productExportBtn')?.addEventListener('click', exportData);
    document.getElementById('productImportBtn')?.addEventListener('click', () => document.getElementById('productImportFile')?.click());
    document.getElementById('productImportFile')?.addEventListener('change', async e => {
      const file = e.target.files?.[0]; if (!file) return;
      try {
        const result = await DB.importProductsCSV(file);
        Toast.ok('اكتمل الاستيراد', `تم حفظ ${result.saved} ورفض ${result.rejected}`);
        await _loadData();
        if (result.errors?.length) console.table(result.errors);
      } catch (err) { Toast.err('فشل الاستيراد', err.message); }
      finally { e.target.value = ''; }
    });

    document.getElementById('productTabs')?.addEventListener('click', e => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      _filter = btn.dataset.f;
      document.querySelectorAll('#productTabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTable();
    });

    document.getElementById('productSearch')?.addEventListener('input', debounce(e => {
      _search = e.target.value.trim();
      renderTable();
    }, 300));

    document.getElementById('catFilters')?.addEventListener('click', e => {
      const chip = e.target.closest('.cat-chip');
      if (!chip) return;
      _cat = chip.dataset.cat;
      document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderTable();
    });

    await _loadData();
  }

  async function _loadData() {
    try {
      const [products, cats, low, aging] = await Promise.all([
        DB.getProducts(), DB.getCategories(), DB.getLowStock(), DB.getStockAgingReport().catch(() => null),
      ]);
      _allProducts = (products || []).filter(p => !p.isService);
      const aged = aging?.buckets?.over90 || [];
      _agedIds = new Set(aged.map(u => u.product_id));

      const stocked = _allProducts.filter(m => !m.isService);
      const costValue = stocked.reduce((sum, m) => sum + (m.cost * m.stock), 0);
      const retailValue = stocked.reduce((sum, m) => sum + (m.price * m.stock), 0);
      const bar = document.getElementById('productInsightBar');
      if (bar) bar.innerHTML = `
        <div class="inv-metric primary"><span class="inv-metric-icon"><i class="fas fa-boxes-stacked"></i></span><div><small>إجمالي الأصناف</small><strong>${Fmt.num(_allProducts.length)}</strong></div></div>
        <div class="inv-metric"><span class="inv-metric-icon"><i class="fas fa-coins"></i></span><div><small>قيمة المخزون بالتكلفة</small><strong>${Fmt.money(costValue)}</strong></div></div>
        <div class="inv-metric"><span class="inv-metric-icon"><i class="fas fa-chart-line"></i></span><div><small>القيمة البيعية المتوقعة</small><strong>${Fmt.money(retailValue)}</strong></div></div>
        <div class="inv-metric alerting"><span class="inv-metric-icon"><i class="fas fa-triangle-exclamation"></i></span><div><small>تحتاج إجراء</small><strong>${Fmt.num(low.length + aged.length)}</strong></div></div>`;

      const btns = document.querySelectorAll('#productTabs .tab-btn');
      if (btns.length === 5) {
        btns[0].innerHTML = `الكل <span class="badge bdg-slate">${_allProducts.length}</span>`;
        btns[1].innerHTML = `مخزون منخفض <span class="badge bdg-warn">${low.length}</span>`;
        btns[2].innerHTML = `نفد المخزون <span class="badge bdg-err">${stocked.filter(m => m.stock === 0).length}</span>`;
        btns[3].innerHTML = `أجهزة IMEI <span class="badge bdg-slate">${_allProducts.filter(m => m.trackSerial).length}</span>`;
        btns[4].innerHTML = `أجهزة راكدة +90 يوم <span class="badge bdg-err">${aged.length}</span>`;
      }

      const chips = document.getElementById('catFilters');
      if (chips) chips.innerHTML =
        `<button class="cat-chip ${_cat ? '' : 'active'}" data-cat="">الكل</button>` +
        (cats || []).map(c => `<button class="cat-chip ${c === _cat ? 'active' : ''}" data-cat="${_esc(c)}">${_esc(c)}</button>`).join('');
      renderTable();
    } catch (e) { Toast.err('خطأ', e.message); }
  }

  function renderTable() {
    const tbody = document.getElementById('productTbody');
    if (!tbody) return;

    let list = [..._allProducts];
    if (_search) {
      const q = _search.toLowerCase();
      list = list.filter(m =>
        m.name.toLowerCase().includes(q) ||
        (m.brand && m.brand.toLowerCase().includes(q)) ||
        (m.model && m.model.toLowerCase().includes(q)) ||
        [m.barcode, m.companyBarcode, m.shopBarcode].some(b => b && b.includes(q)));
    }
    if (_cat) list = list.filter(m => m.category === _cat);
    if (_filter === 'low')     list = list.filter(m => !m.isService && m.stock <= m.minStock);
    if (_filter === 'out')     list = list.filter(m => !m.isService && m.stock === 0);
    if (_filter === 'devices') list = list.filter(m => m.trackSerial);
    if (_filter === 'aged')    list = list.filter(m => _agedIds.has(m.id));

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">
        <div class="es-icon"><i class="fas fa-box-open"></i></div>
        <h3 class="es-title">لا توجد أصناف مطابقة</h3>
      </div></td></tr>`;
      const pager = document.getElementById('productPager'); if (pager) pager.innerHTML = '';
      return;
    }

    const pg = Paginator(list, 15);
    const draw = () => {
      tbody.innerHTML = pg.slice().map(m => `
        <tr>
          <td>${m.imageUrl
            ? `<img loading="lazy" src="${_esc(m.imageUrl)}" alt="" style="width:36px;height:36px;object-fit:contain;border-radius:6px;border:1px solid var(--bd)">`
            : `<div style="width:36px;height:36px;border-radius:6px;border:1px solid var(--bd);display:flex;align-items:center;justify-content:center;color:var(--tx-3)"><i class="fas ${m.trackSerial ? 'fa-mobile-screen' : m.isService ? 'fa-screwdriver-wrench' : 'fa-plug'}"></i></div>`}</td>
          <td><strong>${_esc(m.barcode || m.shopBarcode || m.companyBarcode || '—')}</strong></td>
          <td>${_esc(m.name)}
            <small style="display:block;color:var(--tx-3)">${_esc([m.brand, m.model].filter(x => x && x !== '-').join(' · ') || '—')}</small></td>
          <td>${_esc(m.category || '—')}</td>
          <td>${Fmt.money(m.price)}${m.wholesalePrice != null ? `<small style="display:block;color:var(--tx-3)">جملة: ${Fmt.money(m.wholesalePrice)} (من ${m.wholesaleMinQty})</small>` : ''}</td>
          <td>${m.isService
            ? '<span class="badge bdg-slate">خدمة</span>'
            : `<strong style="color:var(--teal-600)">${Fmt.num(m.stock)} ${_esc(m.saleUnit || m.unit)}</strong>
               ${m.trackSerial ? '<small style="display:block;color:var(--tx-3)"><i class="fas fa-barcode"></i> بأرقام IMEI</small>'
                 : (m.conversionFactor > 1 ? `<small style="display:block;color:var(--tx-3)">≈ ${Fmt.num(Math.floor(m.stock / m.conversionFactor))} ${_esc(m.purchaseUnit || m.unit)}</small>` : '')}
               ${_agedIds.has(m.id) ? '<span class="badge bdg-err" style="margin-top:2px">راكد +90 يوم</span>' : ''}`}</td>
          <td>${m.warrantyMonths ? `${Fmt.num(m.warrantyMonths)} شهر` : '—'}</td>
          <td>${_esc(m.location || '—')}</td>
          <td>
            <div class="td-actions">
              ${m.trackSerial ? `<button class="btn btn-ghost btn-icon sm" data-action="serials" data-id="${m.id}" title="أرقام IMEI / Serial"><i class="fas fa-list-ol"></i></button>` : ''}
              ${m.isService ? '' : `<button class="btn btn-ghost btn-icon sm" data-action="units" data-id="${m.id}" title="ضبط وحدات الباركود" aria-label="ضبط وحدات الباركود"><i class="fas fa-barcode"></i></button>
              <button class="btn btn-ghost btn-icon sm" data-action="ledger" data-id="${m.id}" title="سجل حركة المخزون"><i class="fas fa-clock-rotate-left"></i></button>`}
              <button class="btn btn-ghost btn-icon sm" data-action="label" data-id="${m.id}" title="طباعة ملصق سعر/باركود"><i class="fas fa-tag"></i></button>
              <button class="btn btn-ghost btn-icon sm" data-action="edit" data-id="${m.id}" title="تعديل"><i class="fas fa-pen"></i></button>
              <button class="btn btn-ghost btn-icon sm" data-action="delete" data-id="${m.id}" title="حذف"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>`).join('');

      tbody.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const m = _allProducts.find(x => x.id === btn.dataset.id);
          if (!m) return;
          const act = btn.dataset.action;
          if (act === 'serials') openSerialsModal(m);
          if (act === 'units')   CameraWorkflows.configureUnits(m.id);
          if (act === 'ledger')  openStockLedgerModal(m);
          if (act === 'label')   openLabelPrintModal(m);
          if (act === 'edit')    openEditModal(m);
          if (act === 'delete')  deleteProduct(m);
        });
      });
      pg.render(document.getElementById('productPager'));
    };
    draw();
    document.getElementById('productPager')?.addEventListener('click', draw);
  }

  /* ══════════════════════════════════════════════════════
     نموذج الإضافة / التعديل (نفس النموذج للحالتين)
  ════════════════════════════════════════════════════════ */
  function _generateShopBarcode() {
    const base = `29${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 10)}`;
    const weightedSum = [...base].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
    return base + ((10 - (weightedSum % 10)) % 10);
  }

  function _kindOf(p) { return p?.isService ? 'service' : p?.trackSerial ? 'device' : 'item'; }

  async function _formHTML(p) {
    const [categories, suppliers] = await Promise.all([DB.getCategories(), DB.getSuppliers().catch(() => [])]);
    const cats = [...new Set([...(categories || []), ...(p?.category ? [p.category] : [])])];
    const catOptions = cats.map(c => `<option value="${_esc(c)}" ${p?.category === c ? 'selected' : ''}>${_esc(c)}</option>`).join('');
    const suppOptions = (suppliers || []).map(s => `<option value="${_esc(s.id)}" ${p?.supplierId === s.id ? 'selected' : ''}>${_esc(s.name)}</option>`).join('');
    const unitOptions = sel => [...new Set([...UNITS, sel].filter(Boolean))].map(u => `<option ${u === sel ? 'selected' : ''}>${_esc(u)}</option>`).join('');
    const kind = _kindOf(p);
    const v = (x, d = '') => _esc(x ?? d);
    return `
<form class="product-form" id="productForm" autocomplete="off" onsubmit="return false">
  <div class="mf-layout">
    <aside class="mf-rail">
      <div class="mf-rail-mark"><i class="fas fa-plug-circle-bolt"></i></div>
      <h3>ملخص الصنف</h3>
      <p>راجع أهم البيانات قبل الحفظ.</p>
      <div class="mf-img-upload" id="imgUploadArea" title="انقر لاختيار صورة">
        <div class="mf-img-placeholder" id="imgPlaceholder" style="${p?.imageUrl ? 'display:none' : ''}">
          <i class="fas fa-image"></i><span>صورة الصنف<br><em>اختياري</em></span>
        </div>
        <img id="imgPreview" class="mf-img-preview" style="${p?.imageUrl ? 'display:block' : 'display:none'}" alt="صورة الصنف" src="${_esc(p?.imageUrl || '')}">
        <button type="button" class="mf-img-remove" id="imgRemoveBtn" style="${p?.imageUrl ? 'display:flex' : 'display:none'}" title="حذف الصورة"><i class="fas fa-times"></i></button>
        <input type="file" id="fProductImageFile" accept="image/*" style="display:none">
      </div>
      <div class="mf-summary-product">
        <strong id="summaryProductName">${v(p?.name, 'صنف جديد')}</strong>
        <small id="summaryProductCategory">${v(p?.category, 'لم يتم اختيار التصنيف')}</small>
      </div>
      <dl class="mf-summary-list">
        <div><dt>سعر البيع</dt><dd id="summaryProductPrice">${p ? Fmt.money(p.price) : '—'}</dd></div>
        <div><dt>الرصيد</dt><dd id="summaryProductStock">${p ? Fmt.num(p.stock) : '0'}</dd></div>
        <div><dt>هامش الربح</dt><dd id="marginCalc">—</dd></div>
      </dl>
      <div class="mf-rail-tip"><i class="fas fa-shield-halved"></i><span>يتم التحقق من تكرار الباركود تلقائيًا</span></div>
    </aside>

    <div class="mf-workspace">
      <section class="mf-section">
        <div class="mf-section-title"><span>01</span><div><strong>تعريف الصنف</strong><small>الاسم والماركة والتصنيف</small></div></div>
        <div class="mf-grid cols-2">
          <label class="mf-field"><span>اسم الصنف <b>*</b></span>
            <input id="fProductName" class="form-control" placeholder="سامسونج جالكسي A15 - 128GB" value="${v(p?.name)}"></label>
          <label class="mf-field"><span>الماركة</span>
            <input id="fProductBrand" class="form-control" placeholder="Samsung / Total / Philips" value="${v(p?.brand)}"></label>
          <label class="mf-field"><span>الموديل / رقم القطعة</span>
            <input id="fProductModel" class="form-control" placeholder="Galaxy A15" value="${v(p?.model)}"></label>
          <label class="mf-field"><span>التصنيف <b>*</b></span>
            <select id="fProductCategory" class="form-control"><option value="">اختر التصنيف</option>${catOptions}</select></label>
          <label class="mf-field"><span>المورد</span>
            <select id="fProductSupplier" class="form-control"><option value="">بدون مورد محدد</option>${suppOptions}</select></label>
          <label class="mf-field"><span>نوع الصنف <b>*</b></span>
            <select id="fProductKind" class="form-control">
              <option value="item" ${kind === 'item' ? 'selected' : ''}>صنف عادي (بالكمية)</option>
              <option value="device" ${kind === 'device' ? 'selected' : ''}>جهاز بأرقام IMEI / Serial (موبايل، تابلت...)</option>
              <option value="service" ${kind === 'service' ? 'selected' : ''}>خدمة (بدون مخزون)</option>
            </select></label>
        </div>
      </section>

      <section class="mf-section">
        <div class="mf-section-title"><span>02</span><div><strong>الباركود</strong><small>باركود الشركة على العبوة، وباركود المحل الداخلي للملصقات</small></div></div>
        <div class="mf-grid cols-2">
          <label class="mf-field"><span>باركود الشركة المصنّعة <em class="mf-bc-tag mf-bc-tag-neutral">موجود على العبوة</em></span>
            <div class="mf-barcode-wrap"><div class="mf-barcode-scan-icon"><i class="fas fa-barcode"></i></div>
              <input id="fProductCompanyBarcode" class="form-control" inputmode="numeric" placeholder="امسح باركود الشركة هنا" value="${v(p?.companyBarcode || p?.barcode)}"></div>
            <div class="mf-barcode-preview" id="previewCompanyBarcode"></div></label>
          <label class="mf-field"><span>باركود المحل <em class="mf-bc-tag">داخلي</em></span>
            <div class="mf-barcode-wrap"><div class="mf-barcode-scan-icon mf-bc-shop"><i class="fas fa-qrcode"></i></div>
              <input id="fProductShopBarcode" class="form-control" inputmode="numeric" placeholder="امسح أو ولّد باركود المحل" value="${v(p?.shopBarcode)}">
              <button type="button" class="mf-bc-gen mf-bc-gen-ph" id="genShopBarcode" title="توليد باركود داخلي جديد"><i class="fas fa-wand-magic-sparkles"></i></button></div>
            <div class="mf-barcode-preview" id="previewShopBarcode"></div></label>
        </div>
        <div class="mf-autofill-hint" id="autofillHint" style="display:none">
          <i class="fas fa-circle-check"></i><span id="autofillHintText"></span>
        </div>
      </section>

      <section class="mf-section">
        <div class="mf-section-title"><span>03</span><div><strong>التسعير والمخزون والضمان</strong><small>الأسعار والكميات ومدة الضمان</small></div></div>
        <div class="mf-grid cols-3">
          <label class="mf-field"><span>تكلفة وحدة البيع / المتر <b>*</b></span>
            <div class="mf-money"><input id="fProductCostPrice" class="form-control" type="number" min="0" step="0.01" value="${v(p?.cost)}"><em>ج.م</em></div></label>
          <label class="mf-field"><span>سعر البيع <b>*</b></span>
            <div class="mf-money"><input id="fProductSellPrice" class="form-control" type="number" min="0" step="0.01" value="${v(p?.price)}"><em>ج.م</em></div></label>
          <label class="mf-field"><span>سعر الجملة <em class="mf-bc-tag mf-bc-tag-neutral">اختياري</em></span>
            <div class="mf-money"><input id="fProductWholesalePrice" class="form-control" type="number" min="0" step="0.01" placeholder="اتركه فارغًا لعدم تفعيله" value="${p?.wholesalePrice != null ? v(p.wholesalePrice) : ''}"><em>ج.م</em></div></label>
          <label class="mf-field"><span>أقل كمية لسعر الجملة</span>
            <input id="fProductWholesaleMinQty" class="form-control" type="number" min="1" value="${v(p?.wholesaleMinQty, 1)}"></label>
          <label class="mf-field"><span>مدة الضمان (بالشهور)</span>
            <input id="fProductWarranty" class="form-control" type="number" min="0" max="120" value="${v(p?.warrantyMonths, 0)}"></label>
          <label class="mf-field" data-stockonly data-noserial><span><input type="checkbox" id="fProductDivisible" ${p?.conversionFactor > 1 ? 'checked' : ''}> شراء عبوة وبيع بالتجزئة</span><small>مثال: بكرة 100 متر؛ الرصيد والأسعار أدناه للمتر.</small></label>
          <label class="mf-field" data-stockonly><span>وحدة البيع <b>*</b></span>
            <select id="fProductUnitType" class="form-control">${unitOptions(p?.saleUnit || p?.unit || 'قطعة')}</select></label>
          <label class="mf-field" data-stockonly data-noserial><span>وحدة الشراء</span>
            <select id="fProductPurchaseUnit" class="form-control">${unitOptions(p?.purchaseUnit || p?.unit || 'قطعة')}</select></label>
          <label class="mf-field" data-stockonly data-noserial><span>عدد وحدات البيع في وحدة الشراء</span>
            <input id="fProductConversionFactor" class="form-control" type="number" min="1" value="${v(p?.conversionFactor, 1)}"></label>
          <label class="mf-field" data-stockonly data-noserial><span>الرصيد بوحدة البيع (مثال: أمتار) <b>*</b></span>
            <input id="fProductQuantityPerBox" class="form-control" type="number" min="0" step="any" value="${v(p?.stock, 0)}"></label>
          <label class="mf-field" data-stockonly><span>ملصقات تُطبع بعد الحفظ (0 بدون طباعة)</span><input id="fProductLabelCopies" class="form-control" type="number" min="0" max="200" value="0"></label>
          <label class="mf-field" data-stockonly><span>حد إعادة الطلب</span>
            <input id="fProductMinStock" class="form-control" type="number" min="0" value="${v(p?.minStock, 5)}"></label>
          <label class="mf-field"><span>موقع التخزين</span>
            <input id="fProductLocation" class="form-control" placeholder="مثال: A-01-02" value="${v(p?.location)}"></label>
          <label class="mf-field mf-wide"><span>ملاحظات</span>
            <textarea id="fProductNotes" class="form-control" rows="2" placeholder="مواصفات أو ملاحظات إضافية">${v(p?.description)}</textarea></label>
        </div>
        <p class="form-hint" id="serialNote" style="display:none;margin-top:.6rem">
          <i class="fas fa-circle-info"></i> رصيد الأجهزة يساوي عدد أرقام IMEI المسجلة. بعد الحفظ سجّل الأجهزة من زر
          <b>«أرقام IMEI»</b> أو عند استلام أمر الشراء.
        </p>
      </section>
    </div>
  </div>
</form>`;
  }

  function _bindForm(existing) {
    const $ = id => document.getElementById(id);
    const applyKind = () => {
      const kind = $('fProductKind')?.value;
      document.querySelectorAll('#productForm [data-stockonly]').forEach(el => el.style.display = kind === 'service' ? 'none' : '');
      document.querySelectorAll('#productForm [data-noserial]').forEach(el => { if (kind !== 'service') el.style.display = kind === 'device' ? 'none' : ''; });
      const note = $('serialNote'); if (note) note.style.display = kind === 'device' ? '' : 'none';
      if (kind === 'service' && $('fProductCategory') && !$('fProductCategory').value) $('fProductCategory').value = 'خدمات';
    };
    $('fProductKind')?.addEventListener('change', applyKind);
    $('fProductDivisible')?.addEventListener('change', () => {
      if ($('fProductDivisible').checked) { $('fProductUnitType').value='متر'; $('fProductPurchaseUnit').value='بكرة'; $('fProductConversionFactor').value=100; }
      else { $('fProductPurchaseUnit').value=$('fProductUnitType').value; $('fProductConversionFactor').value=1; }
    });
    applyKind();

    const updateMargin = () => {
      const cost = Number($('fProductCostPrice')?.value) || 0;
      const price = Number($('fProductSellPrice')?.value) || 0;
      const margin = price - cost;
      const pct = cost > 0 ? Math.round((margin / cost) * 100) : 0;
      const el = $('marginCalc');
      if (el) { el.textContent = price > 0 ? `${margin.toFixed(2)} ج.م (${pct}%)` : '—'; el.classList.toggle('negative', margin < 0); }
    };
    ['fProductCostPrice', 'fProductSellPrice'].forEach(id => $(id)?.addEventListener('input', updateMargin));
    updateMargin();

    const syncSummary = () => {
      const p = Number($('fProductSellPrice')?.value);
      $('summaryProductName').textContent = $('fProductName')?.value.trim() || 'صنف جديد';
      $('summaryProductCategory').textContent = $('fProductCategory')?.value || 'لم يتم اختيار التصنيف';
      $('summaryProductPrice').textContent = p > 0 ? Fmt.money(p) : '—';
      $('summaryProductStock').textContent = $('fProductQuantityPerBox')?.value || '0';
    };
    ['fProductName', 'fProductCategory', 'fProductSellPrice', 'fProductQuantityPerBox'].forEach(id => $(id)?.addEventListener('input', syncSummary));

    /* الصورة */
    const imgArea = $('imgUploadArea'), imgInput = $('fProductImageFile'), imgPreview = $('imgPreview'),
      imgHolder = $('imgPlaceholder'), imgRemove = $('imgRemoveBtn');
    imgArea?.addEventListener('click', e => { if (!e.target.closest('#imgRemoveBtn')) imgInput?.click(); });
    const photoBtn = document.createElement('button');
    photoBtn.type = 'button'; photoBtn.className = 'btn btn-ghost'; photoBtn.textContent = 'تصوير الصنف';
    imgArea?.after(photoBtn);
    const usePhoto = image => { _savedImage = image; imgPreview.src = image; imgPreview.style.display = 'block'; imgHolder.style.display = 'none'; imgRemove.style.display = 'flex'; };
    photoBtn.onclick = () => CameraStudio.open({ title: 'تصوير الصنف', onPhoto: async image => usePhoto(image) });
    imgInput?.addEventListener('change', async e => {
      const file = e.target.files?.[0]; if (!file) return;
      try { usePhoto(await CameraStudio.compressFile(file)); } catch (err) { Toast.err('تعذر إضافة الصورة', err.message); }
    });
    imgRemove?.addEventListener('click', () => {
      _savedImage = null; imgInput.value = '';
      imgPreview.style.display = 'none'; imgHolder.style.display = 'flex'; imgRemove.style.display = 'none';
    });

    /* الباركود */
    const renderBC = (inputId, previewId) => {
      const val = $(inputId)?.value.trim(); const el = $(previewId);
      if (el) el.innerHTML = val ? BarcodeGenerator.generateSVG(val, { height: 32, includeText: true }) : '';
    };
    $('genShopBarcode')?.addEventListener('click', () => { $('fProductShopBarcode').value = _generateShopBarcode(); renderBC('fProductShopBarcode', 'previewShopBarcode'); });
    [['fProductCompanyBarcode', 'previewCompanyBarcode'], ['fProductShopBarcode', 'previewShopBarcode']].forEach(([i, pv]) => {
      let timer; $(i)?.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => renderBC(i, pv), 400); });
      renderBC(i, pv);
    });

    /* تنبيه عند مسح باركود مسجل لصنف آخر (في الإضافة فقط) */
    if (!existing) {
      $('fProductCompanyBarcode')?.addEventListener('change', async () => {
        const code = $('fProductCompanyBarcode').value.trim();
        if (code.length < 4) return;
        try {
          const found = await DB.getProductByBarcode(code);
          if (!found) return;
          const set = (id, val) => { const el = $(id); if (el && val && !el.value) el.value = val; };
          set('fProductName', found.name); set('fProductBrand', found.brand); set('fProductModel', found.model);
          set('fProductNotes', found.description); set('fProductLocation', found.location);
          const hint = $('autofillHint');
          if (hint) { $('autofillHintText').textContent = `هذا الباركود مسجّل بالفعل للصنف «${found.name}» — لن يُقبل تكراره عند الحفظ`; hint.style.display = 'flex'; }
          syncSummary();
        } catch (_) { /* غير موجود */ }
      });
    }
  }

  function _readForm() {
    const g = id => document.getElementById(id);
    const kind = g('fProductKind')?.value || 'item';
    const isService = kind === 'service', isDevice = kind === 'device';
    const unit = isService ? 'خدمة' : (g('fProductUnitType')?.value || 'قطعة');
    const data = {
      name: g('fProductName')?.value.trim(),
      brand: g('fProductBrand')?.value.trim(),
      model: g('fProductModel')?.value.trim(),
      category: g('fProductCategory')?.value,
      companyBarcode: g('fProductCompanyBarcode')?.value.trim(),
      shopBarcode: g('fProductShopBarcode')?.value.trim(),
      barcode: g('fProductCompanyBarcode')?.value.trim(),
      cost: parseFloat(g('fProductCostPrice')?.value),
      price: parseFloat(g('fProductSellPrice')?.value),
      wholesalePrice: g('fProductWholesalePrice')?.value !== '' ? parseFloat(g('fProductWholesalePrice')?.value) : null,
      wholesaleMinQty: parseInt(g('fProductWholesaleMinQty')?.value) || 1,
      warrantyMonths: parseInt(g('fProductWarranty')?.value) || 0,
      unit, saleUnit: unit,
      purchaseUnit: (isService || isDevice) ? unit : (g('fProductPurchaseUnit')?.value || unit),
      conversionFactor: (isService || isDevice) ? 1 : (parseInt(g('fProductConversionFactor')?.value) || 1),
      minStock: isService ? 0 : (parseInt(g('fProductMinStock')?.value) || 0),
      location: g('fProductLocation')?.value?.trim(),
      supplierId: g('fProductSupplier')?.value,
      description: g('fProductNotes')?.value.trim(),
      trackSerial: isDevice, isService,
    };
    if (!data.shopBarcode && !isService) data.shopBarcode = _generateShopBarcode();
    if (!isDevice && !isService) data.stock = Number(g('fProductQuantityPerBox')?.value);
    if (_savedImage !== undefined) data.imageData = _savedImage;
    return data;
  }

  function _validate(d) {
    if (!d.name || !d.category || !Number.isFinite(d.cost) || !Number.isFinite(d.price) || d.cost < 0 || d.price < 0) {
      Toast.err('بيانات غير مكتملة', 'راجع الاسم والتصنيف وسعري الشراء والبيع'); return false;
    }
    if (d.stock !== undefined && (!Number.isFinite(d.stock) || d.stock < 0 || (!['متر','كيلو','لتر'].includes(d.unit) && !Number.isInteger(d.stock)))) {
      Toast.err('كمية غير صحيحة', 'الكمية الحالية يجب أن تكون رقمًا صحيحًا غير سالب'); return false;
    }
    return true;
  }

  async function openAddModal() {
    _savedImage = undefined;
    const body = await _formHTML(null);
    Modal.open({
      title: '<span class="mf-modal-title"><i class="fas fa-plus"></i> إضافة صنف</span>',
      body, size: 'lg',
      foot: `
        <div class="mf-foot-note"><i class="fas fa-circle-info"></i> يمكنك تعديل البيانات لاحقًا</div>
        <div class="mf-foot-actions">
          <button type="button" class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>
          <button type="button" class="btn btn-primary" id="saveProductBtn"><i class="fas fa-check"></i> حفظ</button>
        </div>`,
    });
    _bindForm(null);
    document.getElementById('saveProductBtn')?.addEventListener('click', async e => {
      const data = _readForm();
      if (!_validate(data)) return;
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const copies = Math.min(200, Math.max(0, Math.floor(Number(document.getElementById('fProductLabelCopies')?.value) || 0)));
        const id = await DB.addProduct(data);
        if (copies && !data.isService) window.open(`/api/print_labels?product_ids=${encodeURIComponent(id)}&copies=${copies}`, '_blank');
        Toast.ok('تم الحفظ', `تم حفظ «${data.name}»`);
        Modal.close();
        await _loadData();
        if (data.trackSerial) Toast.info('الخطوة التالية', 'سجّل أرقام IMEI للأجهزة من زر «أرقام IMEI» في سطر الصنف');
      } catch (err) { Toast.err('خطأ', err.message); btn.disabled = false; }
    });
    setTimeout(() => document.getElementById('fProductName')?.focus(), 80);
  }

  async function openEditModal(product) {
    _savedImage = undefined;
    const body = await _formHTML(product);
    Modal.open({
      title: `<span class="mf-modal-title"><i class="fas fa-pen"></i> تعديل: ${_esc(product.name)}</span>`,
      body, size: 'lg',
      foot: `<div class="mf-foot-actions">
          <button type="button" class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>
          <button type="button" class="btn btn-primary" id="saveProductBtn"><i class="fas fa-check"></i> حفظ التعديلات</button>
        </div>`,
    });
    _bindForm(product);
    document.getElementById('saveProductBtn')?.addEventListener('click', async e => {
      const data = _readForm();
      if (!_validate(data)) return;
      const btn = e.currentTarget; btn.disabled = true;
      try {
        await DB.updateProduct(product.id, data);
        Toast.ok('تم', 'تم تحديث الصنف بنجاح');
        Modal.close();
        await _loadData();
      } catch (err) { Toast.err('خطأ', err.message); btn.disabled = false; }
    });
  }

  /* ══════════════════════════════════════════════════════
     أرقام IMEI / Serial للأجهزة
  ════════════════════════════════════════════════════════ */
  const STATUS_BADGE = { 'متاح': 'bdg-ok', 'مباع': 'bdg-slate', 'تالف': 'bdg-err', 'مرتجع للمورد': 'bdg-amb' };

  async function openSerialsModal(product, statusFilter = '') {
    Modal.open({
      title: `<i class="fas fa-list-ol"></i> أرقام IMEI / Serial — ${_esc(product.name)}`,
      size: 'lg',
      body: `<div class="empty-state"><div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div><h3 class="es-title">جارٍ التحميل...</h3></div>`,
      foot: `<button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>`,
    });
    try {
      const units = await DB.getSerialUnits(product.id, statusFilter || null);
      const count = s => units.filter(u => u.status === s).length;
      const body = `
        <div class="detail-row"><span class="dr-label">متاح بالمخزون</span><span class="dr-val" style="font-weight:700">${Fmt.num(product.stock)} جهاز</span></div>
        <div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin:.8rem 0">
          <select id="serStatus" class="form-control" style="max-width:190px">
            ${['', 'متاح', 'مباع', 'تالف', 'مرتجع للمورد'].map(s => `<option value="${s}" ${s === statusFilter ? 'selected' : ''}>${s || 'كل الحالات'}</option>`).join('')}
          </select>
          <button class="btn btn-amber btn-sm" id="serAddBtn"><i class="fas fa-plus"></i> إضافة أجهزة</button>
        </div>
        <div class="tbl-wrap" style="max-height:380px;overflow:auto">
          <table class="dtable">
            <thead><tr><th>IMEI / Serial</th><th>المواصفات</th><th>الحالة</th><th>التكلفة</th><th>الاستلام</th><th>البيع / الضمان</th><th></th></tr></thead>
            <tbody>${units.length ? units.map(u => `<tr>
              <td dir="ltr" style="text-align:right"><strong>${_esc(u.serial)}</strong>${u.serial2 ? `<small style="display:block;color:var(--tx-3)">${_esc(u.serial2)}</small>` : ''}</td>
              <td>${_esc(u.variant || '—')}</td>
              <td><span class="badge ${STATUS_BADGE[u.status] || 'bdg-slate'}">${_esc(u.status)}</span></td>
              <td>${Fmt.money(u.cost || 0)}</td>
              <td style="font-size:.8rem">${u.received_date ? Fmt.dateShort(u.received_date) : '—'}</td>
              <td style="font-size:.8rem">${u.status === 'مباع' ? `${_esc(u.customer_name || '—')}<br>${Fmt.warrantyBadge(u.warranty_end)}` : '—'}</td>
              <td>${u.status !== 'مباع' ? `<select class="form-control" data-unit="${_esc(u.id)}" style="min-width:110px">
                  ${['متاح', 'تالف', 'مرتجع للمورد'].map(s => `<option ${s === u.status ? 'selected' : ''}>${s}</option>`).join('')}</select>` : ''}</td>
            </tr>`).join('') : '<tr><td colspan="7"><div class="empty-state"><h3 class="es-title">لا توجد أرقام مسجلة</h3></div></td></tr>'}</tbody>
          </table>
        </div>
        <p class="form-hint" style="margin-top:.6rem">متاح: ${count('متاح')} • مباع: ${count('مباع')} • تالف/مرتجع: ${count('تالف') + count('مرتجع للمورد')}</p>`;
      Modal.open({
        title: `<i class="fas fa-list-ol"></i> أرقام IMEI / Serial — ${_esc(product.name)}`,
        size: 'lg', body, foot: `<button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>`,
      });
      document.getElementById('serStatus')?.addEventListener('change', e => openSerialsModal(product, e.target.value));
      document.getElementById('serAddBtn')?.addEventListener('click', () => openAddSerialsModal(product));
      document.querySelectorAll('[data-unit]').forEach(sel => sel.addEventListener('change', async () => {
        try {
          await DB.updateSerialUnit(sel.dataset.unit, { status: sel.value });
          Toast.ok('تم', 'تم تحديث حالة الجهاز');
          await _loadData();
          openSerialsModal(_allProducts.find(x => x.id === product.id) || product, statusFilter);
        } catch (err) { Toast.err('خطأ', err.message); }
      }));
    } catch (e) { Toast.err('خطأ', e.message); }
  }

  function openAddSerialsModal(product) {
    Modal.open({
      title: `<i class="fas fa-plus"></i> إضافة أجهزة — ${_esc(product.name)}`,
      body: `
        <div class="form-group"><label class="form-label">أرقام IMEI / Serial (رقم في كل سطر) <b>*</b></label>
          <textarea id="serNumbers" class="form-control" rows="7" dir="ltr" placeholder="353510001000059&#10;353510001000067"></textarea>
          <div style="display:flex;justify-content:space-between;margin-top:.3rem">
            <small id="serCount" style="color:var(--tx-3)">0 رقم</small>
            <button type="button" class="btn btn-ghost btn-sm" id="serScanBtn"><i class="fas fa-camera"></i> مسح بالكاميرا</button>
          </div></div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">تكلفة الجهاز</label>
            <input id="serCost" class="form-control" type="number" min="0" step="0.01" value="${product.cost || 0}"></div>
          <div class="form-group"><label class="form-label">المواصفات (لون / سعة)</label>
            <input id="serVariant" class="form-control" placeholder="أسود 128GB"></div>
        </div>
        <p class="form-hint">ماسح الباركود يكتب الرقم ثم Enter تلقائيًا. الأرقام المكررة أو المسجلة سابقًا تُرفض.</p>`,
      foot: `<button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>
             <button class="btn btn-primary" id="serSaveBtn"><i class="fas fa-check"></i> تسجيل الأجهزة</button>`,
    });
    const ta = document.getElementById('serNumbers');
    const parse = () => ta.value.split(/[\n,،]+/).map(s => s.trim()).filter(Boolean);
    ta.addEventListener('input', () => { document.getElementById('serCount').textContent = `${parse().length} رقم`; });
    document.getElementById('serScanBtn')?.addEventListener('click', () => {
      CameraStudio.open({
        mode: 'scan', title: 'مسح IMEI / Serial', acceptLabel: 'إضافة الرقم',
        lookup: async code => ({ title: 'رقم ممسوح', detail: code, code }),
        onAccept: async (_r, code) => { ta.value = (ta.value ? ta.value.replace(/\n?$/, '\n') : '') + code + '\n'; ta.dispatchEvent(new Event('input')); },
      });
    });
    document.getElementById('serSaveBtn')?.addEventListener('click', async e => {
      const serials = parse();
      if (!serials.length) { Toast.err('أدخل رقمًا واحدًا على الأقل'); return; }
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const res = await DB.addSerialUnits({
          product_id: product.id, serials,
          cost: document.getElementById('serCost').value, variant: document.getElementById('serVariant').value.trim(),
        });
        Toast.ok('تم التسجيل', `تمت إضافة ${res.added} جهاز للمخزون`);
        await _loadData();
        openSerialsModal(_allProducts.find(x => x.id === product.id) || product);
      } catch (err) { Toast.err('خطأ', err.message); btn.disabled = false; }
    });
  }

  /* ══════════════════════════════════════════════════════
     سجل الحركة / الملصقات / الحذف / التصدير
  ════════════════════════════════════════════════════════ */
  async function openStockLedgerModal(product) {
    Modal.open({
      title: `<i class="fas fa-clock-rotate-left"></i> سجل حركة: ${_esc(product.name)}`,
      size: 'lg',
      body: `<div class="empty-state"><div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div><h3 class="es-title">جارٍ التحميل...</h3></div>`,
      foot: `<button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>`,
    });
    try {
      const res = await DB.getStockLedger(product.id);
      const movs = res.movements || [];
      const TYPE_STYLE = { 'بيع': 'bdg-err', 'شراء': 'bdg-ok', 'إلغاء/مرتجع بيع': 'bdg-amb', 'تسوية جرد': 'bdg-warn' };
      const body = `
        <div class="detail-row"><span class="dr-label">المخزون الحالي</span><span class="dr-val" style="font-weight:700">${Fmt.num(res.product.stock)} ${_esc(res.product.unit || '')}</span></div>
        <div class="divider"></div>
        <div class="tbl-wrap" style="max-height:420px;overflow:auto">
        <table class="dtable">
          <thead><tr><th>التاريخ</th><th>النوع</th><th>التغيير</th><th>الرصيد بعدها</th><th>المرجع</th></tr></thead>
          <tbody>${movs.length ? movs.map(m => `<tr>
            <td style="font-size:.8rem">${m.ev_date ? Fmt.dateShort(m.ev_date) : '—'}</td>
            <td><span class="badge ${TYPE_STYLE[m.type] || 'bdg-slate'}">${_esc(m.type)}</span></td>
            <td style="font-weight:700;color:${m.qty_change >= 0 ? 'var(--ok)' : 'var(--err)'}">${m.qty_change >= 0 ? '+' : ''}${Fmt.num(m.qty_change)}</td>
            <td>${Fmt.num(m.balance_after)}</td>
            <td style="font-size:.8rem">${_esc(m.reference || '—')} ${m.notes ? `<br><small style="color:var(--tx-3)">${_esc(m.notes)}</small>` : ''}</td>
          </tr>`).join('') : '<tr><td colspan="5"><div class="empty-state"><h3 class="es-title">لا توجد حركة مسجّلة لهذا الصنف</h3></div></td></tr>'}</tbody>
        </table></div>`;
      Modal.open({
        title: `<i class="fas fa-clock-rotate-left"></i> سجل حركة: ${_esc(product.name)}`,
        size: 'lg', body, foot: `<button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>`,
      });
    } catch (e) { Toast.err('خطأ', e.message); }
  }

  function openLabelPrintModal(product) {
    Modal.open({
      title: '<i class="fas fa-tag"></i> طباعة ملصق سعر/باركود',
      body: `
      <div class="detail-row"><span class="dr-label">الصنف</span><span class="dr-val">${_esc(product.name)}</span></div>
      <div class="detail-row"><span class="dr-label">السعر الحالي</span><span class="dr-val">${Fmt.money(product.price)}</span></div>
      <div class="form-group" style="margin-top:.8rem"><label class="form-label">عدد الملصقات</label>
        <input class="form-control" id="lblCopies" type="number" min="1" max="200" value="12"></div>
      <p style="font-size:.78rem;color:var(--tx-3)">سيتم توليد ملف PDF جاهز للطباعة على ورق ملصقات (شبكة 3×8)، كل ملصق فيه اسم الصنف والسعر وباركود قابل للمسح.</p>`,
      foot: `<button class="btn btn-primary" id="lblPrintBtn"><i class="fas fa-print"></i> طباعة</button>
             <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    document.getElementById('lblPrintBtn')?.addEventListener('click', () => {
      const copies = Math.max(1, Math.min(200, parseInt(document.getElementById('lblCopies').value) || 12));
      window.open(`/api/print_labels?product_ids=${encodeURIComponent(product.id)}&copies=${copies}`, '_blank');
      Modal.close();
    });
  }

  function deleteProduct(product) {
    Modal.confirm('حذف الصنف', `هل أنت متأكد من حذف «${_esc(product.name)}»؟ إن كان مرتبطًا بفواتير أو أرقام IMEI فسيُؤرشف بدل الحذف.`, async () => {
      try {
        const res = await DB.deleteProduct(product.id);
        if (res?.archived) Toast.info('تمت الأرشفة', res.message); else Toast.ok('تم', 'تم حذف الصنف');
        await _loadData();
      } catch (e) { Toast.err('خطأ', e.message); }
    });
  }

  async function exportData() {
    const button = document.getElementById('productExportBtn');
    if (button) button.disabled = true;
    try {
      const result = await DB.exportProductsCSV();
      Modal.open({
        title: '<i class="fas fa-file-csv"></i> تم حفظ ملف التصدير',
        body: `<div class="alert ok" style="margin-bottom:.8rem">تم تصدير ${Fmt.num(result.rows)} صنف بنجاح.</div>
          <div class="form-group"><label class="form-label">مكان الملف على الجهاز</label>
            <input class="form-control" id="exportedFilePath" dir="ltr" readonly value="${_esc(result.path)}"></div>
          <p class="form-hint">افتح مجلد المشروع ثم مجلد <strong>exports</strong>. اسم الملف: <strong>${_esc(result.filename)}</strong></p>`,
        foot: `<button class="btn btn-ghost" id="copyExportPath"><i class="fas fa-copy"></i> نسخ المسار</button>
          <button class="btn btn-primary" onclick="Modal.close()">حسنًا</button>`,
      });
      document.getElementById('copyExportPath')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(result.path); Toast.ok('تم النسخ', 'تم نسخ مسار الملف'); }
        catch (_) { document.getElementById('exportedFilePath')?.select(); }
      });
    } catch (error) { Toast.err('فشل التصدير', error.message); }
    finally { if (button) button.disabled = false; }
  }

  function _prepareInvoiceImage(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      return Promise.reject(new Error('اختر صورة JPG أو PNG أو WebP'));
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('تعذرت قراءة الصورة'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('ملف الصورة غير صالح'));
        img.onload = () => {
          const maxSide = 1600;
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const context = canvas.getContext('2d');
          context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(img, 0, 0, canvas.width, canvas.height);
          let quality = .86, data = canvas.toDataURL('image/jpeg', quality);
          while (data.length > 1350000 && quality > .45) { quality -= .1; data = canvas.toDataURL('image/jpeg', quality); }
          if (data.length > 1400000) return reject(new Error('الصورة كبيرة جداً حتى بعد ضغطها'));
          resolve(data);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function openDetailsModal(productOrId) {
    const product = typeof productOrId === 'string' ? await DB.getProduct(productOrId) : productOrId;
    if (!product) return Toast.err('غير موجود', 'تعذر العثور على بيانات الصنف');
    const barcode = product.shopBarcode || product.companyBarcode || product.barcode || '—';
    const stockState = product.isService ? '<span class="badge bdg-slate">خدمة</span>' : Fmt.stockBadge(product.stock, product.minStock);
    Modal.open({
      title: '<i class="fas fa-box-open"></i> تفاصيل الصنف', size: 'lg',
      body: `<div class="product-details-view">
        <div class="pdv-hero">
          <div class="pdv-image">${product.imageUrl ? `<img src="${_esc(product.imageUrl)}" alt="${_esc(product.name)}">` : `<i class="fas ${product.trackSerial ? 'fa-mobile-screen' : product.isService ? 'fa-screwdriver-wrench' : 'fa-box'}"></i>`}</div>
          <div><h2>${_esc(product.name)}</h2><p>${_esc([product.brand, product.model].filter(Boolean).join(' · ') || product.category || '')}</p>${stockState}</div>
          <strong class="pdv-price">${Fmt.money(product.price)}</strong>
        </div>
        <div class="pdv-grid">
          <div><span>التصنيف</span><strong>${_esc(product.category || '—')}</strong></div>
          <div><span>الباركود</span><strong dir="ltr">${_esc(barcode)}</strong></div>
          <div><span>المخزون</span><strong>${product.isService ? 'لا ينطبق' : `${Fmt.num(product.stock)} ${_esc(product.saleUnit || product.unit)}`}</strong></div>
          <div><span>الضمان</span><strong>${product.warrantyMonths ? `${Fmt.num(product.warrantyMonths)} شهر` : 'بدون ضمان'}</strong></div>
          <div><span>الموقع</span><strong>${_esc(product.location || '—')}</strong></div>
          <div><span>الحد الأدنى</span><strong>${product.isService ? '—' : Fmt.num(product.minStock)}</strong></div>
        </div>
        ${product.description ? `<div class="pdv-note"><span>الوصف / الملاحظات</span><p>${_esc(product.description)}</p></div>` : ''}
      </div>`,
      foot: `<button type="button" class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>
        <button type="button" class="btn btn-primary" id="productToSaleBtn"><i class="fas fa-cash-register"></i> إضافة إلى فاتورة بيع</button>`,
    });
    document.getElementById('productToSaleBtn')?.addEventListener('click', () => {
      sessionStorage.setItem('pos_pending_product', product.id);
      Modal.close(); App.navigate('sales');
    });
  }

  async function openCapturedInvoiceModal(imageData, fileName = '') {
    const [suppliers, products] = await Promise.all([DB.getSuppliers(), DB.getProducts()]);
    let rowSeq = 0;
    const productOptions = (products || []).filter(p => !p.isService).map(p =>
      `<option value="${_esc(p.id)}" data-cost="${Number(p.cost || 0) * Number(p.conversionFactor || 1)}">${_esc(p.name)} — ${_esc(p.purchaseUnit || p.unit)}</option>`
    ).join('');
    const today = new Date().toISOString().slice(0, 10);
    const body = `
      <div style="display:grid;grid-template-columns:minmax(260px,.8fr) minmax(420px,1.2fr);gap:1rem;align-items:start" class="captured-invoice-layout">
        <div style="position:sticky;top:0">
          <div style="border:1px solid var(--border);border-radius:10px;background:var(--surface-2);padding:.6rem;text-align:center">
            <img src="${imageData}" alt="صورة فاتورة المورد" style="display:block;width:100%;max-height:520px;object-fit:contain;border-radius:7px;background:#fff">
          </div>
          <small style="display:block;margin-top:.4rem;color:var(--tx-3)">${_esc(fileName)} — الصورة محفوظة داخل الفاتورة</small>
        </div>
        <div>
          <div class="mf-grid cols-2">
            <label class="mf-field"><span>المورد <b>*</b></span><select id="capInvoiceSupplier" class="form-control"><option value="">اختر المورد</option>${(suppliers || []).map(s => `<option value="${_esc(s.id)}">${_esc(s.name)}</option>`).join('')}</select></label>
            <label class="mf-field"><span>رقم فاتورة المورد</span><input id="capInvoiceNumber" class="form-control" maxlength="100" placeholder="مثال: INV-1258"></label>
            <label class="mf-field"><span>تاريخ الفاتورة <b>*</b></span><input id="capInvoiceDate" class="form-control" type="date" value="${today}"></label>
            <label class="mf-field"><span>ملاحظات</span><input id="capInvoiceNotes" class="form-control" placeholder="أي ملاحظات على الاستلام"></label>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin:.9rem 0 .5rem"><strong>بنود الفاتورة القابلة للتعديل</strong><button type="button" class="btn btn-ghost btn-sm" id="capInvoiceAddItem"><i class="fas fa-plus"></i> إضافة بند</button></div>
          <div id="capInvoiceItems"></div>
          <div style="text-align:left;margin-top:.7rem">الإجمالي: <strong id="capInvoiceTotal" style="color:var(--teal-600)">0.00 ج.م</strong></div>
        </div>
      </div>`;
    Modal.open({
      title: '<i class="fas fa-file-image"></i> مراجعة فاتورة مصوّرة', size: 'lg', body,
      foot: `<div class="mf-foot-note"><i class="fas fa-circle-info"></i> الحفظ لا يغيّر المخزون؛ الاعتماد يتم من صفحة المشتريات</div><div class="mf-foot-actions"><button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button><button class="btn btn-primary" id="saveCapturedInvoice"><i class="fas fa-check"></i> حفظ ضمن الفواتير المستلمة</button></div>`,
    });

    const calculate = () => {
      let total = 0;
      document.querySelectorAll('.captured-invoice-item').forEach(row => {
        total += (Number(row.querySelector('[data-qty]')?.value) || 0) * (Number(row.querySelector('[data-cost]')?.value) || 0);
      });
      const el = document.getElementById('capInvoiceTotal'); if (el) el.textContent = Fmt.money(total);
    };
    const addRow = () => {
      const key = ++rowSeq;
      const row = document.createElement('div'); row.className = 'captured-invoice-item';
      row.style.cssText = 'display:grid;grid-template-columns:minmax(180px,1fr) 82px 105px 34px;gap:.45rem;align-items:center;margin-bottom:.5rem';
      row.innerHTML = `<select class="form-control" data-product><option value="">اختر الصنف</option>${productOptions}</select><input class="form-control" data-qty type="number" min="1" step="1" value="1" title="كمية وحدة الشراء"><input class="form-control" data-cost type="number" min="0" step="0.01" value="0" title="تكلفة وحدة الشراء"><button type="button" class="btn btn-ghost btn-icon sm" title="حذف البند" style="color:var(--err)"><i class="fas fa-trash"></i></button>`;
      row.querySelector('[data-product]').addEventListener('change', event => { row.querySelector('[data-cost]').value = event.target.selectedOptions[0]?.dataset.cost || 0; calculate(); });
      row.querySelectorAll('input').forEach(input => input.addEventListener('input', calculate));
      row.querySelector('button').addEventListener('click', () => { row.remove(); calculate(); });
      document.getElementById('capInvoiceItems').appendChild(row); calculate();
      return key;
    };
    document.getElementById('capInvoiceAddItem').addEventListener('click', addRow); addRow();
    document.getElementById('saveCapturedInvoice').addEventListener('click', async event => {
      const button = event.currentTarget; if (button.disabled) return;
      const supplierId = document.getElementById('capInvoiceSupplier').value;
      const items = [...document.querySelectorAll('.captured-invoice-item')].map(row => ({
        product_id: row.querySelector('[data-product]').value,
        qty_ordered: Number(row.querySelector('[data-qty]').value),
        unit_cost: Number(row.querySelector('[data-cost]').value),
      })).filter(item => item.product_id && item.qty_ordered > 0);
      if (!supplierId) return Toast.warn('بيانات ناقصة', 'اختر المورد');
      if (!items.length) return Toast.warn('بيانات ناقصة', 'أضف صنفاً واحداً على الأقل');
      button.disabled = true;
      try {
        const result = await DB.addCapturedPurchase({ supplier_id: supplierId, supplier_invoice_num: document.getElementById('capInvoiceNumber').value.trim(), invoice_date: document.getElementById('capInvoiceDate').value, notes: document.getElementById('capInvoiceNotes').value.trim(), invoice_image_data: imageData, items });
        Toast.ok('تم حفظ الفاتورة', `${result.po_num} — يمكنك الآن إضافة منتجاتها للمخزون من صفحة المشتريات`);
        Modal.close(); App.navigate('purchases');
      } catch (error) { Toast.err('فشل حفظ الفاتورة', error.message); button.disabled = false; }
    });
  }

  return { render, afterRender, openAddModal, openEditModal, openDetailsModal, prepareInvoiceImage: _prepareInvoiceImage };
})();
