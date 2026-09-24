/* ════════════════════════════════════════════════════════════
   PAGE: SETTINGS  (async)
   إدارة الإعدادات العامة وقسم إدارة المستخدمين والصلاحيات
════════════════════════════════════════════════════════════ */
'use strict';

const SettingsPage = (() => {

  const NAV = [
    { id: 'guide',      label: 'دليل استخدام النظام', group: 'المساعدة', icon: 'fa-book-open', keywords: 'شرح مساعدة مرجع دليل أيقونات أزرار استخدام' },
    { id: 'general',    label: 'بيانات المحل',     group: 'الهوية والمحل', icon: 'fa-store', keywords: 'المحل الاسم الهاتف العنوان العملة بيانات' },
    { id: 'appearance', label: 'الهوية والمظهر',      group: 'الهوية والمحل', icon: 'fa-image', keywords: 'الشعار الاسم الوضع الداكن الفاتح الثيم الألوان' },
    { id: 'inventory',  label: 'المخزون والتنبيهات',   group: 'التشغيل اليومي', icon: 'fa-boxes-stacked', keywords: 'الكمية الحد الأدنى تنبيه مخزون صنف' },
    { id: 'invoice',    label: 'البيع والفواتير',     group: 'التشغيل اليومي', icon: 'fa-receipt', keywords: 'الضريبة الدفع الخصم الكاشير الإيصال الملاحظة' },
    { id: 'devices',    label: 'الطباعة والباركود',   group: 'الأجهزة والتكامل', icon: 'fa-print', keywords: 'الطابعة الباركود الورق الحرارية الأجهزة' },
    { id: 'users',      label: 'المستخدمون والصلاحيات', group: 'الإدارة والأمان', icon: 'fa-user-shield', keywords: 'الحسابات الصلاحيات كلمة المرور الأدوار الموظفين', adminOnly: true },
    { id: 'activity',   label: 'سجل النشاط',          group: 'الإدارة والأمان', icon: 'fa-clock-rotate-left', keywords: 'التدقيق العمليات الإجراءات المستخدم التاريخ', adminOnly: true },
    { id: 'backup',     label: 'النسخ والاستعادة',    group: 'صيانة النظام', icon: 'fa-database', keywords: 'قاعدة البيانات استرجاع حفظ نسخة احتياطية', adminOnly: true },
    { id: 'network',    label: 'الشبكة وتتبع الشحنات', group: 'صيانة النظام', icon: 'fa-network-wired', keywords: 'شبكة تتبع رابط عام شحنة باركود خارجي', adminOnly: true },
    { id: 'health',     label: 'فحص سلامة البيانات',   group: 'صيانة النظام', icon: 'fa-heart-pulse', keywords: 'فحص تشخيص تضارب مخزون تشغيلات سلامة صحة قاعدة بيانات', adminOnly: true },
  ];

  const USER_GUIDE = [
    {title:'لوحة التحكم',icon:'fa-chart-pie',summary:'ملخص حركة المحل والتنبيهات.',steps:['تعرض المبيعات والفواتير والديون والمخزون المنخفض.','غيّر الفترة لمراجعة اليوم أو الأسبوع أو الشهر.','اضغط على التنبيه للانتقال إلى القسم المرتبط.']},
    {title:'الأصناف والمخزون',icon:'fa-boxes-stacked',summary:'إضافة المنتجات والأسعار والباركود.',steps:['زر + يضيف صنفًا جديدًا؛ الباركود اختياري.','أدخل سعر القطاعي وسعر الجملة وأقل كمية للجملة.','القلم للتعديل، العين للتفاصيل، سلة المهملات للحذف/الأرشفة، والساعة لحركة الصنف.']},
    {title:'نقطة البيع',icon:'fa-cash-register',summary:'إصدار فاتورة واختيار العميل وطريقة الدفع.',steps:['ابحث عن الصنف أو امسح الباركود، ثم أضفه للسلة.','ابح عن العميل أو أضف اسمًا جديدًا، وحدد سعر قطاعي/جملة.','فعّل أو أوقف العروض، وأدخل الخصم اليدوي إن لزم.','البطاقة والتحويل يتطلبان صورة إثات دفع؛ الآجل يُسجل مديونية.']},
    {title:'الفواتير',icon:'fa-file-invoice-dollar',summary:'مراجعة وطباعة وإلغاء فواتير البيع.',steps:['العين تفتح الفاتورة، والطابعة تطبعها.','إثات الدفع يظهر لفواتير البطاقة/التحويل.','علامة المنع تلغي الفاتورة وتعيد المخزون؛ العملية حساسة.']},
    {title:'الصيانة والضمان',icon:'fa-screwdriver-wrench',summary:'تذاكر الإصلاح وIMEI والضمان.',steps:['سجّل العميل والجهاز والعطل عند الاستلام.','حدّث الحالة والتشخيص وقطع الغيار والأجرة.','عند التسليم يمكن إصدار فاتورة؛ وشاشة الضمان تبحث بـIMEI/Serial.']},
    {title:'المشتريات والنواقص والجرد',icon:'fa-cart-flatbed',summary:'إدخال البضاعة ومطابقة المخزون.',steps:['أمر الشراء يحفظ الكميات المطلوبة؛ الاستلام يزيد المخزون.','فاتورة المشتريات تحفظ صورة الفاتورة، سعر القطاعي والجملة.','كشكول النواقص يجمع الأصناف المطلوبة؛ الجرد يسجل الفرق بين الفعلي والنظام.']},
    {title:'الشحن والتوزيع',icon:'fa-truck-fast',summary:'الرحلات والسائقون وحالة التسليم.',steps:['أنشئ رحلة واختر السائق والسيارة وفواتير العملاء.','الموقع يعرض العنوان، والباركود يحدد الشحنة، وعلامة الصح تسجل التسليم.','التحصيل عند التسليم يُسجل على الشحنة.']},
    {title:'العروض والخصومات',icon:'fa-tags',summary:'أسعار مؤقتة تعمل بكمية وفترة.',steps:['حدد الصنف، نسبة/مبلغ الخصم، أقل كمية، وفترة السريان.','يظهر العرض في نقطة البيع؛ ويمكن تشغيله أو إيقافه لكل فاتورة.','عند تعدد الأسعار يُستخدم السعر الأقل المنطبق.']},
    {title:'الحسابات وديون العملاء',icon:'fa-wallet',summary:'حركة الأموال والبيع الآجل.',steps:['الحسابات تسجل الدخل والمصروف والمرجع.','ديون العملاء تظهر فواتير الآجل والمدفوع والمتبقي.','زر «تسجيل دفعة» يخفض الرصيد المستحق.']},
    {title:'العملاء والموردون',icon:'fa-users',summary:'ملفات التعامل والفواتير والأرصدة.',steps:['حدد نوع العميل: فرد/قطاعي أو جملة، وأضف سقف الائتمان عند الحاجة.','ملف العميل يعرض الفواتير والضمان وكشف الحساب.','الضغط على اسم المورد يفتح بياناته والمعاملات وفواتير الشراء والأصناف.']},
    {title:'الموارد البشرية والتقارير',icon:'fa-chart-bar',summary:'الموظفون والرواتب وتحليل الأداء.',steps:['الموارد البشرية تحفظ الموظفين والرواتب والدفعات.','التقارير تعرض المبيعات والأرباح والمخزون وربحية العملاء.','استخدم الفلاتر والتصدير للحصول على كشوف دقيقة.']},
    {title:'الإعدادات والأمان',icon:'fa-gear',summary:'الهوية والطباعة والمستخدمون والنسخ.',steps:['بيانات المحل والمظهر تغير الاسم والشعار والثيم.','البيع والفواتير يضبط الضريبة والخصم وطريقة الدفع، والأجهزة تضبط الطابعة والباركود.','المدير يدير الصلاحيات وسجل النشاط والنسخ الاحتياطي وفحص البيانات.']},
  ];

  const ROLES = [
    { id: 'مدير النظام',    label: 'مدير النظام',    icon: 'fa-shield-halved', cls: 'admin',      bdg: 'bdg-amb' },
    { id: 'مشرف المحل', label: 'مشرف المحل', icon: 'fa-user-tie',   cls: 'pharmacist', bdg: 'bdg-teal' },
    { id: 'بائع',   label: 'بائع',   icon: 'fa-user',    cls: 'assistant',  bdg: 'bdg-slate' },
    { id: 'فني صيانة',   label: 'فني صيانة',   icon: 'fa-screwdriver-wrench',    cls: 'technician',  bdg: 'bdg-amb' },
  ];

  const ROLE_PERMS_INFO = {
    'مدير النظام': [
      { ok: true, text: 'إدارة المخزون والأصناف وتعديل الأسعار' },
      { ok: true, text: 'نقطة البيع وإصدار وإلغاء الفواتير' },
      { ok: true, text: 'تقارير المبيعات والأرباح والتحليلات المالية' },
      { ok: true, text: 'إدارة العملاء وسجلات الموردين' },
      { ok: true, text: 'إدارة الشحن والتوزيع (السائقين، السيارات، الرحلات الدورية)' },
      { ok: true, text: 'إنشاء وتعديل العروض والخصومات' },
      { ok: true, text: 'إدارة حسابات المستخدمين وتعيين الصلاحيات' },
      { ok: true, text: 'النسخ الاحتياطي وتعديل إعدادات النظام' },
    ],
    'مشرف المحل': [
      { ok: true, text: 'إدارة المخزون والأصناف وتعديل الأسعار' },
      { ok: true, text: 'نقطة البيع وإصدار الفواتير' },
      { ok: true, text: 'تقارير المبيعات وحركة الأصناف' },
      { ok: true, text: 'إدارة العملاء وسجلات الموردين' },
      { ok: true, text: 'إدارة الشحن والتوزيع (السائقين، السيارات، الرحلات الدورية)' },
      { ok: true, text: 'إنشاء وتعديل العروض والخصومات' },
      { ok: false, text: 'إدارة المستخدمين وتعديل إعدادات النظام' },
      { ok: false, text: 'النسخ الاحتياطي واستعادة قاعدة البيانات' },
    ],
    'بائع': [
      { ok: true, text: 'نقطة البيع وإتمام عمليات الشراء' },
      { ok: true, text: 'استعراض قائمة الأصناف والأسعار' },
      { ok: true, text: 'استعراض الفواتير' },
      { ok: true, text: 'تنفيذ التوصيل اليومي (تجهيز رحلة، تسليم، مسح باركود)' },
      { ok: false, text: 'تعديل أو حذف الأصناف والمخزون' },
      { ok: false, text: 'إضافة/تعديل سائقين وسيارات ورحلات دورية' },
      { ok: false, text: 'إنشاء أو تعديل العروض والخصومات' },
      { ok: false, text: 'التقارير المالية والأرباح' },
      { ok: true, text: 'استلام أجهزة الصيانة وتسليمها بفاتورة' },
      { ok: false, text: 'إدارة المستخدمين والإعدادات' },
    ],
    'فني صيانة': [
      { ok: true, text: 'استلام الأجهزة وتحديث حالة تذاكر الصيانة' },
      { ok: true, text: 'إضافة قطع الغيار المستخدمة وتسعير الأجرة' },
      { ok: true, text: 'استعراض الأصناف وقطع الغيار' },
      { ok: false, text: 'نقطة البيع والفواتير والتقارير' },
      { ok: false, text: 'تعديل الأصناف أو الأسعار' },
      { ok: false, text: 'إدارة المستخدمين والإعدادات' },
    ]
  };

  function _isAdmin() {
    return Auth?.getCurrent?.()?.role === 'مدير النظام';
  }

  function _visibleNav() {
    return NAV.filter(n => !n.adminOnly || _isAdmin());
  }

  function render() {
    return `
<div class="page active" id="page-settings">
  <header class="google-settings-head settings-studio-head">
    <div class="settings-title-block"><span class="settings-kicker">مركز التحكم</span><h1>إعدادات تك ماركت</h1><p>إدارة هوية المحل والتشغيل والأمان من مكان واحد</p></div>
    <div class="settings-search-wrap">
      <i class="fas fa-magnifying-glass"></i>
      <input type="search" id="settingsSearch" placeholder="البحث في الإعدادات" autocomplete="off" />
      <button type="button" id="settingsSearchClear" class="hidden" aria-label="مسح البحث"><i class="fas fa-xmark"></i></button>
    </div><div class="settings-system-state"><span></span><div><strong>النظام متصل</strong><small>قاعدة البيانات تعمل بصورة طبيعية</small></div></div>
  </header>
  <div class="settings-layout google-settings-layout settings-studio-layout">
    <aside class="settings-nav-card settings-studio-nav"><div id="setNav"></div><div class="settings-about"><i class="fas fa-circle-info"></i><span>تك ماركت</span><small>الإصدار 2.0</small></div></aside>
    <main class="settings-content" id="setContent">
      <div class="empty-state">
        <div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div>
        <h3 class="es-title">جارٍ تحميل الإعدادات...</h3>
      </div>
    </main><aside class="settings-preview" id="setPreview"></aside>
  </div>
</div>`;
  }

  const KEYS = {
    shopName:     'shop_name',
    shopPhone:    'shop_phone',
    shopAddr:     'shop_address',
    currency:         'currency_symbol',
    shopLogo:     'shop_logo',
    themeMode:        'ui_theme_mode',
    themeAccent:      'ui_theme_accent',
    lowStockDefault:  'low_stock_default',
    taxRate:          'tax_rate',
    invoiceNote:      'invoice_footer_note',
    showTax:          'invoice_show_tax',
    showCashier:      'invoice_show_cashier',
    defaultPayment:   'sales_default_payment',
    maxDiscount:      'sales_max_discount_percent',
  };

  let _vals = {};
  let _activeTab = 'general';
  let _allUsers = [];
  let _filteredUsers = [];
  let _searchQuery = '';
  let _selectedRoleFilter = 'all';

  async function afterRender() {
    _activeTab = 'general';
    try {
      const entries = await Promise.all(
        Object.entries(KEYS).map(async ([name, key]) => [name, await DB.getSetting(key)])
      );
      _vals = Object.fromEntries(entries);
      const storeName = document.getElementById('settingsStoreName');
      if (storeName) storeName.textContent = _vals.shopName || 'تك ماركت';
      _renderNav();
      _renderTab('general');
      _setupSettingsSearch();
    } catch (e) {
      const c = document.getElementById('setContent');
      if (c) c.innerHTML = `<div class="alert err"><i class="fas fa-circle-xmark"></i> ${_esc(e.message)}</div>`;
    }
  }

  function _renderNav(filter = '') {
    const nav = document.getElementById('setNav');
    if (!nav) return;
    const q = filter.trim().toLowerCase();
    const visible = _visibleNav().filter(n => !q || `${n.label} ${n.keywords || ''}`.toLowerCase().includes(q));
    let lastGroup = '';
    nav.innerHTML = visible.map(n => {
      const group = n.group !== lastGroup ? `<div class="set-nav-group">${n.group}</div>` : '';
      lastGroup = n.group;
      return `${group}<button class="set-nav-item ${_activeTab === n.id ? 'active' : ''}" data-tab="${n.id}" type="button"><span class="set-nav-icon"><i class="fas ${n.icon}"></i></span><span>${n.label}</span></button>`;
    }).join('') || '<div class="settings-nav-empty">لا توجد نتائج</div>';
    nav.querySelectorAll('.set-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        _activeTab = item.dataset.tab;
        _renderNav();
        _renderTab(_activeTab);
      });
    });
  }

  function _renderPreview(tab, draft = {}) {
    const p = document.getElementById('setPreview');
    if (!p) return;
    const v = { ..._vals, ...draft };
    const name = _esc(v.shopName) || 'تك ماركت';
    const devices = DeviceSettings.get();
    const previews = {
      general: `<div class="sp-label">معاينة الهوية</div><div class="sp-shop"><span class="sp-logo">${v.shopLogo?`<img src="${v.shopLogo}" alt=""/>`:'<i class="fas fa-store"></i>'}</span><strong>${name}</strong><small>${_esc(v.shopPhone)||'رقم الهاتف غير مسجل'}</small><p>${_esc(v.shopAddr)||'أضف عنوان المحل ليظهر في الفواتير'}</p></div>`,
      appearance: `<div class="sp-label">مظهر النظام</div><div class="sp-screen"><div class="sp-screen-bar"><i class="fas fa-mobile-screen-button"></i><span>${name}</span></div><div class="sp-screen-body"><b>لوحة التحكم</b><span></span><span></span><span></span></div></div><p class="sp-note"><i class="fas fa-eye"></i> الهوية تظهر في تسجيل الدخول والفواتير.</p>`,
      inventory: `<div class="sp-label">مثال تنبيه</div><div class="sp-alert warn"><i class="fas fa-box-open"></i><div><strong>مخزون منخفض</strong><small>سيظهر التنبيه عند ${_esc(v.lowStockDefault)||10} وحدات</small></div></div><div class="sp-alert"><i class="fas fa-hourglass-half"></i><div><strong>جهاز راكد</strong><small>أجهزة IMEI بالمخزون أكثر من 90 يومًا</small></div></div>`,
      invoice: `<div class="sp-label">معاينة الفاتورة</div><div class="sp-receipt"><div class="sp-r-head"><strong>${name}</strong><small>فاتورة بيع تجريبية</small></div><div class="sp-r-row"><span>صنف تجريبي</span><b>100.00</b></div>${v.showTax!=='0'&&Number(v.taxRate)>0?`<div class="sp-r-row"><span>الضريبة ${_esc(v.taxRate)}%</span><b>${Number(v.taxRate).toFixed(2)}</b></div>`:''}<div class="sp-r-total"><span>الإجمالي</span><b>${(100+(v.showTax!=='0'&&Number(v.taxRate)>0?Number(v.taxRate):0)).toFixed(2)} ${_esc(v.currency)||'ر.س'}</b></div><p>${_esc(v.invoiceNote)||'شكرًا لتعاملكم معنا'}</p></div>`,
      devices: `<div class="sp-label">حالة الأجهزة</div><div class="sp-device"><i class="fas fa-print"></i><div><strong>الطابعة الحرارية</strong><small>${devices.receiptPrinter?'مفعّلة وجاهزة للطباعة':'موقوفة من مركز الأجهزة'}</small></div><span class="sp-dot ${devices.receiptPrinter?'':'idle'}"></span></div><div class="sp-device"><i class="fas fa-barcode"></i><div><strong>قارئ الباركود</strong><small>${devices.barcodeScan?'مفعّل في نقطة البيع':'موقوف'}</small></div><span class="sp-dot ${devices.barcodeScan?'':'idle'}"></span></div><div class="sp-device"><i class="fas fa-camera"></i><div><strong>كاميرا الجهاز</strong><small>${devices.cameraEnabled?'مفعّلة؛ تعمل عند منح الإذن':'موقوفة'}</small></div><span class="sp-dot ${devices.cameraEnabled?'':'idle'}"></span></div>`,
      users: `<div class="sp-label">الأمان والصلاحيات</div><div class="sp-security"><i class="fas fa-shield-halved"></i><strong>وصول محمي حسب الدور</strong><p>إدارة الحسابات وكلمات المرور وصلاحيات التشغيل الحساسة.</p></div>`,
      backup: `<div class="sp-label">سلامة البيانات</div><div class="sp-security"><i class="fas fa-database"></i><strong>نسخ SQLite متسقة</strong><p>احتفظ بنسخة حديثة قبل أي استعادة أو تغيير كبير.</p></div>`,
      activity: `<div class="sp-label">المراقبة</div><div class="sp-security"><i class="fas fa-clock-rotate-left"></i><strong>كل عملية قابلة للتتبع</strong><p>راجع المستخدم والوقت ونوع التغيير من سجل النشاط.</p></div>`
      ,guide: `<div class="sp-label">مرجع النظام</div><div class="sp-security"><i class="fas fa-book-open"></i><strong>الشرح دائمًا متاح</strong><p>ابح عن اسم الشاشة أو الزر وافتح القسم لمعرفة خطوات العمل.</p></div><div class="sp-alert"><i class="fas fa-magnifying-glass"></i><div><strong>${USER_GUIDE.length} قسمًا مشروحًا</strong><small>مع معجم للأيقونات الشائعة</small></div></div>`
    };
    p.innerHTML = `<div class="sp-head"><span>معاينة مباشرة</span><i class="fas fa-wand-magic-sparkles"></i></div><div class="sp-body">${previews[tab] || previews.general}</div><div class="sp-foot"><i class="fas fa-circle-info"></i> تتحدث المعاينة مع تغييراتك قبل الحفظ</div>`;
  }

  function _setupSettingsSearch() {
    const input=document.getElementById('settingsSearch'), clear=document.getElementById('settingsSearchClear');
    if(!input) return;
    const search=()=>{
      const q=input.value.trim(); clear?.classList.toggle('hidden',!q); _renderNav(q);
      if(q){const match=_visibleNav().find(n=>`${n.label} ${n.keywords || ''}`.toLowerCase().includes(q.toLowerCase()));if(match&&match.id!==_activeTab){_activeTab=match.id;_renderNav(q);_renderTab(match.id);}}
    };
    input.addEventListener('input',debounce(search,120));
    clear?.addEventListener('click',()=>{input.value='';_renderNav();clear.classList.add('hidden');input.focus();});
  }

  function _renderTab(tab) {
    const content = document.getElementById('setContent');
    if (!content) return;
    CameraStudio.close();
    _renderPreview(tab);

    if (tab === 'guide') {
      const iconLegend = [
        ['fa-plus','إضافة سجل جديد'],['fa-eye','عرض التفاصيل'],['fa-pen','تعديل'],['fa-trash','حذف أو أرشفة'],
        ['fa-floppy-disk','حفظ'],['fa-print','طباعة'],['fa-download','تصدير'],['fa-magnifying-glass','بحث'],['fa-camera','تصوير/مسح'],
        ['fa-barcode','باركود'],['fa-clock-rotate-left','سجل الحركة'],['fa-ban','إلغاء'],['fa-circle-check','تأكيد/مكتمل'],['fa-triangle-exclamation','تنبيه'],
        ['fa-file-invoice','فاتورة'],['fa-coins','مبلغ/تحصيل'],['fa-location-dot','موقع أو عنوان'],['fa-xmark','إغلاق أو مسح الاختيار']
      ];
      content.innerHTML = `
        <div class="guide-hero"><div><span class="settings-kicker">المرجع الشامل</span><h2>دليل استخدام تك ماركت</h2><p>اكتب اسم الشاشة أو الزر الذي تريد معرفته، ثم افتح القسم.</p></div><i class="fas fa-book-open-reader"></i></div>
        <div class="guide-search"><i class="fas fa-magnifying-glass"></i><input class="form-control" id="guideSearch" type="search" placeholder="ابح: فاتورة، باركود، عميل، جرد..."><button class="btn btn-ghost btn-sm" id="guideExpandAll"><i class="fas fa-angles-down"></i> فتح الكل</button></div>
        <div class="guide-sections" id="guideSections">${USER_GUIDE.map((g,index)=>`<details class="guide-section" data-guide-text="${_esc(`${g.title} ${g.summary} ${g.steps.join(' ')}`)}" ${index===0?'open':''}><summary><span class="guide-section-icon"><i class="fas ${g.icon}"></i></span><span><strong>${_esc(g.title)}</strong><small>${_esc(g.summary)}</small></span><i class="fas fa-chevron-down"></i></summary><ol>${g.steps.map(step=>`<li>${_esc(step)}</li>`).join('')}</ol></details>`).join('')}</div>
        <div class="card guide-icons-card"><div class="card-head"><h3 class="card-title"><i class="fas fa-icons"></i> معجم الأيقونات والأزرار</h3></div><div class="card-body"><div class="guide-icon-grid">${iconLegend.map(([icon,label])=>`<div><i class="fas ${icon}"></i><span>${label}</span></div>`).join('')}</div><p class="form-hint"><i class="fas fa-circle-info"></i> قد تختفي بعض الأزرار حسب صلاحيات حسابك.</p></div></div>`;
      const guideSearch=document.getElementById('guideSearch');
      guideSearch?.addEventListener('input',()=>{const q=normalizeArabicText(guideSearch.value.trim());document.querySelectorAll('.guide-section').forEach(section=>{const match=!q||normalizeArabicText(section.dataset.guideText).includes(q);section.hidden=!match;if(q&&match)section.open=true;});});
      document.getElementById('guideExpandAll')?.addEventListener('click',()=>{const sections=[...document.querySelectorAll('.guide-section:not([hidden])')];const openAll=sections.some(section=>!section.open);sections.forEach(section=>section.open=openAll);});
    }

    if (tab === 'general') {
      content.innerHTML = `
        <div class="card">
          <div class="card-head"><h3 class="card-title"><i class="fas fa-store"></i> بيانات المحل الأساسية</h3></div>
          <div class="card-body">
            <div class="form-row cols-2">
              <div class="form-group">
                <label class="form-label">رقم الهاتف</label>
                <input class="form-control" id="setShopPhone" value="${_esc(_vals.shopPhone)}" placeholder="01xxxxxxxxx" />
              </div>
              <div class="form-group">
                <label class="form-label">العنوان</label>
                <input class="form-control" id="setShopAddr" value="${_esc(_vals.shopAddr)}" placeholder="العنوان بالكامل" />
              </div>
            </div>
            <div class="form-group" style="max-width:260px">
              <label class="form-label">رمز العملة الافتراضية</label>
              <input class="form-control" id="setCurrency" value="${_esc(_vals.currency) || 'ج.م'}" placeholder="ج.م" />
            </div>
          </div>
          <div class="card-foot" style="display:flex;justify-content:flex-end">
            <button class="btn btn-primary btn-sm" id="setSaveGeneral"><i class="fas fa-floppy-disk"></i> حفظ التغييرات</button>
          </div>
        </div>`;
      document.getElementById('setSaveGeneral')?.addEventListener('click', () => _save({
        shopPhone: document.getElementById('setShopPhone').value.trim(),
        shopAddr:  document.getElementById('setShopAddr').value.trim(),
        currency:      document.getElementById('setCurrency').value.trim(),
      }));
      ['setShopPhone','setShopAddr','setCurrency'].forEach(id=>document.getElementById(id)?.addEventListener('input',()=>_renderPreview('general',{shopPhone:document.getElementById('setShopPhone').value,shopAddr:document.getElementById('setShopAddr').value,currency:document.getElementById('setCurrency').value})));
    }

    if (tab === 'appearance') {
      const mode = _vals.themeMode === 'dark' ? 'dark' : 'light';
      content.innerHTML = `
        <div class="card" style="margin-bottom:1rem">
          <div class="card-head"><h3 class="card-title"><i class="fas fa-signature"></i> الاسم والشعار</h3></div>
          <div class="card-body">
            <div class="form-group">
              <label class="form-label">اسم المحل</label>
              <input class="form-control" id="setShopName" value="${_esc(_vals.shopName)}" placeholder="تك ماركت" />
            </div>
            <div class="form-group">
              <label class="form-label">شعار المحل (Logo)</label>
              <div style="display:flex;align-items:center;gap:1rem">
                <div id="setLogoPreview" style="width:58px;height:58px;border-radius:12px;background:var(--surface-2);border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">
                  ${_vals.shopLogo ? `<img src="${_vals.shopLogo}" style="width:100%;height:100%;object-fit:cover" />` : `<i class="fas fa-store" style="color:var(--tx-3);font-size:1.5rem"></i>`}
                </div>
                <div style="display:flex;flex-direction:column;gap:.4rem">
                  <label class="btn btn-ghost btn-sm" style="cursor:pointer;width:fit-content">
                    <i class="fas fa-upload"></i> اختيار صورة
                    <input type="file" id="setLogoInput" accept="image/*" hidden />
                  </label>
                  <button class="btn btn-ghost btn-sm" id="setLogoRemove" style="width:fit-content"><i class="fas fa-trash"></i> إزالة الشعار</button>
                </div>
              </div>
            </div>
          </div>
          <div class="card-foot" style="display:flex;justify-content:flex-end">
            <button class="btn btn-primary btn-sm" id="setSaveIdentity"><i class="fas fa-floppy-disk"></i> حفظ الشعار والاسم</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3 class="card-title"><i class="fas fa-palette"></i> المظهر والألوان</h3></div>
          <div class="card-body">
            <div class="form-group">
              <label class="form-label">وضع العرض (Theme)</label>
              <div style="display:flex;gap:.5rem;max-width:320px">
                <button class="tab-btn ${mode==='light'?'active':''}" id="setModeLight" type="button" style="flex:1;justify-content:center"><i class="fas fa-sun"></i> فاتح</button>
                <button class="tab-btn ${mode==='dark'?'active':''}" id="setModeDark" type="button" style="flex:1;justify-content:center"><i class="fas fa-moon"></i> داكن</button>
              </div>
            </div>
            <div class="alert info"><i class="fas fa-circle-info"></i><div><strong>هوية لونية ثابتة</strong><br><span>يستخدم النظام لونًا موحدًا لضمان وضوح النصوص والتنبيهات في الوضعين.</span></div></div>
          </div>
        </div>`;

      document.getElementById('setLogoInput')?.addEventListener('change', e => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 900*1024) { Toast.err('الصورة كبيرة جداً', 'يرجى اختيار صورة أصغر من 900KB'); return; }
        const reader = new FileReader();
        reader.onload = () => {
          _vals.shopLogo = reader.result;
          const prev = document.getElementById('setLogoPreview');
          if (prev) prev.innerHTML = `<img src="${reader.result}" style="width:100%;height:100%;object-fit:cover" />`;
          _renderPreview('appearance');
        };
        reader.readAsDataURL(file);
      });
      document.getElementById('setLogoRemove')?.addEventListener('click', () => {
        _vals.shopLogo = '';
        const prev = document.getElementById('setLogoPreview');
        if (prev) prev.innerHTML = `<i class="fas fa-store" style="color:var(--tx-3);font-size:1.5rem"></i>`;
        _renderPreview('appearance');
      });
      document.getElementById('setSaveIdentity')?.addEventListener('click', () => _save({
        shopName: document.getElementById('setShopName').value.trim(),
        shopLogo: _vals.shopLogo || '',
      }, true));
      document.getElementById('setShopName')?.addEventListener('input',e=>_renderPreview('appearance',{shopName:e.target.value}));

      document.getElementById('setModeLight')?.addEventListener('click', () => _setMode('light'));
      document.getElementById('setModeDark')?.addEventListener('click', () => _setMode('dark'));

    }

    if (tab === 'inventory') {
      content.innerHTML = `
        <div class="card">
          <div class="card-head"><h3 class="card-title"><i class="fas fa-boxes-stacked"></i> تنبيهات المخزون</h3></div>
          <div class="card-body">
            <div class="form-group">
              <label class="form-label">الحد الأدنى الافتراضي للمخزون</label>
              <input class="form-control" id="setLowStock" type="number" min="0" value="${_esc(_vals.lowStockDefault) || 10}" />
            </div>
          </div>
          <div class="card-foot" style="display:flex;justify-content:flex-end">
            <button class="btn btn-primary btn-sm" id="setSaveInventory"><i class="fas fa-floppy-disk"></i> حفظ</button>
          </div>
        </div>`;
      document.getElementById('setSaveInventory')?.addEventListener('click', () => _save({
        lowStockDefault: document.getElementById('setLowStock').value,
      }));
      document.getElementById('setLowStock')?.addEventListener('input',()=>_renderPreview('inventory',{lowStockDefault:document.getElementById('setLowStock').value}));
    }

    if (tab === 'invoice') {
      content.innerHTML = `
        <div class="card">
          <div class="card-head"><h3 class="card-title"><i class="fas fa-file-invoice"></i> إعدادات الفواتير والضريبة</h3></div>
          <div class="card-body">
            <div class="form-group" style="max-width:200px">
              <label class="form-label">نسبة الضريبة (%)</label>
              <input class="form-control" id="setTaxRate" type="number" min="0" step="0.01" value="${_esc(_vals.taxRate) || 0}" />
            </div>
            <div class="form-row cols-2">
              <div class="form-group"><label class="form-label">طريقة الدفع الافتراضية</label><select class="form-control" id="setDefaultPayment"><option value="نقدي" ${_vals.defaultPayment!=='بطاقة'?'selected':''}>نقدي</option><option value="بطاقة" ${_vals.defaultPayment==='بطاقة'?'selected':''}>بطاقة</option></select></div>
              <div class="form-group"><label class="form-label">الحد الأقصى للخصم (%)</label><input class="form-control" id="setMaxDiscount" type="number" min="0" max="100" value="${_esc(_vals.maxDiscount)||100}" /></div>
            </div>
            <div class="form-group">
              <label class="form-label">ملاحظة أسفل الفاتورة</label>
              <input class="form-control" id="setInvoiceNote" value="${_esc(_vals.invoiceNote)}" placeholder="شكراً لتعاملكم معنا" />
            </div>
            <div class="form-group">
              <label class="form-label">خيارات عرض الفاتورة</label>
              <div style="display:flex;flex-direction:column;gap:.55rem">
                <label style="display:flex;align-items:center;gap:.55rem;font-size:.83rem;color:var(--tx-2);cursor:pointer">
                  <input type="checkbox" id="setShowTax" ${_vals.showTax !== '0' ? 'checked' : ''} />
                  إظهار سطر الضريبة في الفاتورة المطبوعة
                </label>
                <label style="display:flex;align-items:center;gap:.55rem;font-size:.83rem;color:var(--tx-2);cursor:pointer">
                  <input type="checkbox" id="setShowCashier" ${_vals.showCashier !== '0' ? 'checked' : ''} />
                  إظهار اسم البائع/المستخدم المسجل في الفاتورة
                </label>
              </div>
            </div>
          </div>
          <div class="card-foot" style="display:flex;justify-content:flex-end">
            <button class="btn btn-primary btn-sm" id="setSaveInvoice"><i class="fas fa-floppy-disk"></i> حفظ</button>
          </div>
        </div>`;
      document.getElementById('setSaveInvoice')?.addEventListener('click', () => _save({
        taxRate:     document.getElementById('setTaxRate').value,
        invoiceNote: document.getElementById('setInvoiceNote').value.trim(),
        showTax:     document.getElementById('setShowTax').checked ? '1' : '0',
        showCashier: document.getElementById('setShowCashier').checked ? '1' : '0',
        defaultPayment: document.getElementById('setDefaultPayment').value,
        maxDiscount: document.getElementById('setMaxDiscount').value,
      }));
      ['setTaxRate','setInvoiceNote','setShowTax','setShowCashier','setDefaultPayment','setMaxDiscount'].forEach(id=>document.getElementById(id)?.addEventListener('input',()=>_renderPreview('invoice',{taxRate:document.getElementById('setTaxRate').value,invoiceNote:document.getElementById('setInvoiceNote').value,showTax:document.getElementById('setShowTax').checked?'1':'0'})));
    }

    if (tab === 'devices') _renderDevicesTab(content);
    if (tab === 'users')   _renderUsersTab(content);
    if (tab === 'backup')  _renderBackupTab(content);
    if (tab === 'network') _renderNetworkTab(content);
    if (tab === 'health')  _renderHealthTab(content);
    if (tab === 'activity') _renderActivityTab(content);
  }

  /* ════════════════════════════════════════════════════════
     BACKUP & RESTORE
  ════════════════════════════════════════════════════════ */
  async function _renderBackupTab(content) {
    content.innerHTML = `<div class="card"><div class="card-body"><div class="empty-state"><div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div><h3 class="es-title">جارٍ قراءة النسخ الاحتياطية...</h3></div></div></div>`;
    try {
      const [backups,secondary] = await Promise.all([DB.listBackups(),_api("secondary_backup")]);
      content.innerHTML = `
        <div class="settings-section-head"><div><h2>النسخ الاحتياطي والاستعادة</h2><p>احمِ بيانات المبيعات والمخزون والمستخدمين من الفقد.</p></div><button class="btn btn-primary" id="createBackupBtn"><i class="fas fa-plus"></i> إنشاء نسخة الآن</button></div>
        <div class="settings-callout safe"><i class="fas fa-shield-halved"></i><div><strong>النسخ تحفظ محليًا</strong><span>يتم إنشاء لقطة سليمة من SQLite دون إيقاف العمل، ويُحتفظ بآخر 5 نسخ فقط تلقائيًا.</span></div></div>
        <div class="backup-emergency-guide"><div><i class="fas fa-life-ring"></i><span><strong>خطة الطوارئ لو المشروع وقع</strong><small>1) احتفظ بملف .db على فلاشة/قرص آخر. 2) ثبّت نسخة جديدة من المشروع. 3) افتح هذه الشاشة واضغط استيراد. 4) بعد الفحص اضغط استعادة وأعد تشغيل البرنامج.</small></span></div></div>
        <div class="card"><div class="card-head"><span class="card-title">نسخة إضافية خارج المشروع</span></div><div class="card-body">
          <p>اختر مجلدًا على قرص خارجي أو جهاز آخر. مجلد آخر على نفس القرص لا يحمي من تلف القرص.</p>
          <label for="secondaryBackupDir">المسار الكامل للمجلد</label><input id="secondaryBackupDir" class="form-control" dir="ltr" value="${_esc(secondary.directory||'')}" placeholder="E:\\ShopBackups">
          <p role="status">الحالة: ${({ok:'آخر نسخة إضافية سليمة',failed:'فشل آخر نسخ إضافي',stale:'لم تُنشأ نسخة إضافية حديثة',not_configured:'لم يُحدد مكان'})[secondary.state]} ${secondary.last_success?'· '+_esc(new Date(secondary.last_success).toLocaleString('ar-EG')):''}</p>
          <p>${_esc(secondary.error||'')}</p><button class="btn btn-primary" id="saveSecondaryBackup">حفظ المكان</button>
          <small>اترك المسار فارغًا لإيقاف النسخة الإضافية. الحفظ لا ينقل بيانات؛ استخدم إنشاء نسخة الآن للاختبار.</small>
        </div></div>
        <div class="card"><div class="card-head"><span class="card-title"><i class="fas fa-file-import"></i> نقل الداتا إلى نسخة أخرى من المشروع</span></div><div class="card-body">
          <p>اختر ملف <strong>.db</strong> من القرص الخارجي. سيفحص النظام سلامة SQLite وجداول المشروع قبل إضافته لقائمة النسخ.</p>
          <input type="file" id="importBackupFile" accept=".db,application/vnd.sqlite3,application/octet-stream" hidden>
          <button class="btn btn-outline" id="importBackupBtn"><i class="fas fa-upload"></i> استيراد نسخة من جهاز آخر</button>
          <p class="form-hint"><i class="fas fa-triangle-exclamation"></i> الاستيراد لا يغيّر الداتا مباشرة؛ بعده ستراجع الملف في القائمة ثم تضغط «استعادة» بنفسك.</p>
        </div></div>
        <div class="card"><div class="card-head"><span class="card-title"><i class="fas fa-clock-rotate-left"></i> النسخ المتاحة</span><span class="badge bdg-slate">${backups.length}</span></div><div class="card-body p0">
          ${backups.length ? `<div class="backup-list">${backups.map((b,i)=>`<div class="backup-row"><span class="backup-icon"><i class="fas fa-database"></i></span><div class="backup-meta"><strong>${_esc(b.filename)}</strong><small>${new Date(b.modified).toLocaleString('ar-EG')} · ${b.size_kb} KB</small></div>${i===0?'<span class="badge bdg-ok">الأحدث</span>':''}<button class="btn btn-ghost btn-sm restore-backup" data-path="${_esc(b.path)}"><i class="fas fa-clock-rotate-left"></i> استعادة</button></div>`).join('')}</div>` : '<div class="empty-state"><div class="es-icon"><i class="fas fa-database"></i></div><h3 class="es-title">لا توجد نسخ بعد</h3><p class="es-sub">أنشئ أول نسخة احتياطية قبل إدخال بيانات التشغيل الفعلية.</p></div>'}
        </div></div>`;
      document.getElementById('saveSecondaryBackup').onclick=async event=>{
        const button=event.currentTarget;button.disabled=true;
        try{await _api('secondary_backup',{body:{directory:document.getElementById('secondaryBackupDir').value.trim()}});Toast.ok('تم حفظ المكان','أنشئ نسخة الآن للتأكد من الوصول وسلامة النسخة');await _renderBackupTab(content);}catch(error){Toast.err('تعذر حفظ المكان',error.message);button.disabled=false;}
      };
      const importInput=document.getElementById('importBackupFile');
      document.getElementById('importBackupBtn')?.addEventListener('click',()=>importInput?.click());
      importInput?.addEventListener('change',async()=>{const file=importInput.files?.[0];if(!file)return;const button=document.getElementById('importBackupBtn');button.disabled=true;button.innerHTML='<i class="fas fa-circle-notch fa-spin"></i> جارٍ الفحص والاستيراد';try{const form=new FormData();form.append('file',file);const response=await fetch('/api/import_backup',{method:'POST',body:form,credentials:'same-origin'});const payload=await response.json();if(!response.ok||!payload.ok)throw new Error(payload.error||'فشل الاستيراد');Toast.ok('تم فحص النسخة واستيرادها','ظهرت في القائمة؛ اضغط استعادة لتطبيقها');await _renderBackupTab(content);}catch(error){Toast.err('رُفضت النسخة',error.message);button.disabled=false;button.innerHTML='<i class="fas fa-upload"></i> استيراد نسخة من جهاز آخر';}finally{importInput.value='';}});
      document.getElementById('createBackupBtn')?.addEventListener('click', async e => {
        const btn=e.currentTarget; btn.disabled=true; btn.innerHTML='<i class="fas fa-circle-notch fa-spin"></i> جارٍ الإنشاء';
        try { const result=await DB.backupDatabase(); if(result.secondary_error)Toast.warn('المحلية محفوظة؛ الإضافية فشلت',result.secondary_error);else if(result.retention_warning)Toast.warn('تم إنشاء النسخة مع تنبيه',result.retention_warning);else Toast.ok('تم إنشاء النسخة', result.secondary_path?'تم التحقق من النسختين والاحتفاظ بآخر 5 نسخ':result.filename || 'تم حفظ قاعدة البيانات'); _renderBackupTab(content); }
        catch(err){Toast.err('فشل النسخ',err.message);btn.disabled=false;btn.innerHTML='<i class="fas fa-plus"></i> إنشاء نسخة الآن';}
      });
      content.querySelectorAll('.restore-backup').forEach(btn=>btn.addEventListener('click',()=>{
        const path=btn.dataset.path;
        Modal.confirm('استعادة قاعدة البيانات','سيتم حفظ نسخة من الوضع الحالي أولًا، ثم استعادة النسخة المختارة. يجب إعادة تشغيل التطبيق بعد العملية.',async()=>{
          try{await DB.restoreDatabase(path);Toast.ok('تمت الاستعادة','أعد تشغيل التطبيق لتحميل البيانات المستعادة');}
          catch(err){Toast.err('فشلت الاستعادة',err.message);}
        },'تأكيد الاستعادة','btn-danger');
      }));
    } catch(e) { content.innerHTML=`<div class="alert err"><i class="fas fa-circle-xmark"></i> ${_esc(e.message)}</div>`; }
  }

  /* ════════════════════════════════════════════════════════
     NETWORK — صفحة تتبع الشحنات العامة على الشبكة المحلية
     ════════════════════════════════════════════════════════ */
  async function _renderNetworkTab(content) {
    content.innerHTML = `<div class="card"><div class="card-body"><div class="empty-state"><div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div><h3 class="es-title">جارٍ التحميل...</h3></div></div></div>`;
    try {
      const [enabledSetting, portSetting] = await Promise.all([
        DB.getSetting('public_tracking_enabled'), DB.getSetting('public_tracking_port'),
      ]);
      const enabled = enabledSetting === '1';
      const port = portSetting || '8765';
      content.innerHTML = `
        <div class="settings-section-head"><div><h2>الشبكة وتتبع الشحنات العام</h2><p>اسمح لعملاء الجملة بمتابعة حالة شحناتهم بأنفسهم عبر رابط عام، بدون تسجيل دخول.</p></div></div>

        <div class="settings-callout warn"><i class="fas fa-triangle-exclamation"></i><div>
          <strong>هذا الخيار يفتح منفذًا على الشبكة المحلية</strong>
          <span>صفحة التتبع فقط (بدون أي بيانات حساسة أو صلاحيات دخول) تصبح متاحة لأي جهاز على نفس شبكة Wi-Fi/الشبكة المحلية. للوصول من خارج المكان (الإنترنت)، يلزم ضبط توجيه المنفذ (Port Forwarding) في الراوتر يدويًا — وهذا خارج نطاق هذا التطبيق ويتطلب خبرة تقنية أو مساعدة فني شبكات.</span>
        </div></div>

        <div class="card"><div class="card-head"><span class="card-title"><i class="fas fa-link"></i> تفعيل صفحة التتبع العامة</span></div>
          <div class="card-body">
            <label style="display:flex;align-items:center;gap:.6rem;font-size:.9rem;margin-bottom:1rem">
              <input type="checkbox" id="netTrackingEnabled" ${enabled?'checked':''}>
              تفعيل الوصول لصفحة التتبع من الشبكة المحلية
            </label>
            <label for="netTrackingPort">رقم المنفذ (Port)</label>
            <input id="netTrackingPort" class="form-control" type="number" min="1024" max="65535" value="${_esc(port)}" style="max-width:200px" dir="ltr">
            <small>غيّره فقط لو المنفذ الحالي مستخدم من برنامج آخر على جهازك.</small>
            <div style="margin-top:1rem"><button class="btn btn-primary" id="netSaveBtn"><i class="fas fa-check"></i> حفظ</button></div>
            <p role="status" style="margin-top:.8rem;font-size:.85rem;color:var(--tx-3)"><i class="fas fa-circle-info"></i> التغيير يتطلب <strong>إعادة تشغيل التطبيق</strong> ليبدأ أو يتوقف خادم التتبع.</p>
          </div>
        </div>

        ${enabled ? `
        <div class="card"><div class="card-head"><span class="card-title"><i class="fas fa-qrcode"></i> رابط التتبع الحالي</span></div>
          <div class="card-body">
            <p style="font-size:.85rem;color:var(--tx-3)">شارك هذا الرابط (أو رابط مشابه) مع عميل الجملة، مع رقم الباركود المطبوع على بوليصة الشحن:</p>
            <input class="form-control" dir="ltr" readonly value="http://<عنوان-جهازك-على-الشبكة>:${_esc(port)}/track" onclick="this.select()">
            <small>عنوان جهازك الفعلي على الشبكة يظهر في نافذة تشغيل البرنامج (Console) عند بدء التشغيل، أو اسأل فني الشبكة عندك.</small>
          </div>
        </div>` : ''}
      `;
      document.getElementById('netSaveBtn')?.addEventListener('click', async () => {
        const isEnabled = document.getElementById('netTrackingEnabled').checked;
        const portVal = parseInt(document.getElementById('netTrackingPort').value) || 8765;
        try {
          await DB.setSetting('public_tracking_enabled', isEnabled ? '1' : '0');
          await DB.setSetting('public_tracking_port', String(portVal));
          Toast.ok('تم الحفظ', 'أعد تشغيل التطبيق لتطبيق التغيير');
          _renderNetworkTab(content);
        } catch (e) { Toast.err('خطأ', e.message); }
      });
    } catch(e) { content.innerHTML=`<div class="alert err"><i class="fas fa-circle-xmark"></i> ${_esc(e.message)}</div>`; }
  }

  /* ════════════════════════════════════════════════════════
     HEALTH CHECK — فحص سلامة البيانات (تشخيصي، قراءة فقط)
     ════════════════════════════════════════════════════════ */
  const SEVERITY_STYLE = {
    critical: { badge: 'bdg-err',  icon: 'fa-circle-exclamation', color: 'var(--err)' },
    warning:  { badge: 'bdg-warn', icon: 'fa-triangle-exclamation', color: 'var(--warn)' },
    info:     { badge: 'bdg-slate',icon: 'fa-circle-info', color: 'var(--tx-3)' },
  };

  async function _renderHealthTab(content) {
    content.innerHTML = `<div class="empty-state"><div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div><h3 class="es-title">جارٍ الفحص...</h3></div>`;
    await _runHealthCheck(content);
  }

  async function _runHealthCheck(content) {
    try {
      const res = await DB.getHealthCheck();
      const overallStyle = res.overall === 'critical' ? { color: 'var(--err)', text: 'توجد مشاكل حرجة تحتاج مراجعة' }
        : res.overall === 'warning' ? { color: 'var(--warn)', text: 'توجد ملاحظات تستحق المراجعة' }
        : res.overall === 'incomplete' ? { color: 'var(--warn)', text: 'الفحص غير مكتمل — توجد أجزاء غير مُهيأة أو لم تُختبر' }
        : { color: 'var(--ok)', text: 'الفحوصات الداخلية التي تم تنفيذها نجحت' };

      const problemChecks = res.checks.filter(c => c.count > 0);
      const cleanChecks = res.checks.filter(c => c.count === 0);
      const diagnostics=res.diagnostics||[];
      const diagStyle={ok:{icon:'fa-circle-check',color:'var(--ok)',label:'تم فحصه'},warning:{icon:'fa-triangle-exclamation',color:'var(--warn)',label:'يحتاج انتباه'},error:{icon:'fa-circle-xmark',color:'var(--err)',label:'فشل الفحص'},not_configured:{icon:'fa-plug-circle-xmark',color:'var(--tx-3)',label:'غير مُهيأ'},not_tested:{icon:'fa-circle-question',color:'var(--tx-3)',label:'لم يُختبر'}};

      content.innerHTML = `
        <div class="settings-section-head"><div><h2>تشخيص النظام والبيانات</h2><p>يعرض فقط ما تم فحصه فعلياً، ويميّز بوضوح بين السليم وغير المُهيأ وغير القابل للاختبار آلياً.</p></div>
          <button class="btn btn-primary" id="rerunHealthBtn"><i class="fas fa-rotate"></i> إعادة الفحص</button>
        </div>

        <div class="alert warn" style="margin-bottom:1rem"><i class="fas fa-circle-info"></i><div><strong>هذه النتيجة لا تعني أن الطابعة أو الكاميرا أو قارئ الباركود يعمل.</strong><br><small>الأجهزة الخارجية لا تُعتبر سليمة إلا بعد توصيلها وتشغيل اختبارها من شاشة الأجهزة.</small></div></div>

        <div class="card" style="margin-bottom:1rem">
          <div class="card-body" style="text-align:center;padding:1.5rem">
            <div style="font-size:1.4rem;font-weight:800;color:${overallStyle.color}">${overallStyle.text}</div>
            <div style="font-size:.78rem;color:var(--tx-3);margin-top:.3rem">آخر فحص: ${Fmt.dateShort ? Fmt.dateShort(res.checked_at) : res.checked_at}</div>
          </div>
        </div>

        <div class="card" style="margin-bottom:1rem"><div class="card-head"><h3 class="card-title"><i class="fas fa-stethoscope"></i> ما تم فحصه فعلياً</h3></div><div class="card-body">
          ${diagnostics.map(d=>{const st=diagStyle[d.status]||diagStyle.not_tested;return `<div style="display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:.65rem;align-items:center;padding:.65rem 0;border-bottom:1px solid var(--border-2)"><i class="fas ${st.icon}" style="color:${st.color}"></i><div><strong style="display:block;font-size:.86rem">${_esc(d.title)}</strong><small style="color:var(--tx-3)">${_esc(d.details)}</small></div><span class="badge bdg-slate" style="color:${st.color}">${st.label}</span></div>`}).join('')}
        </div></div>

        ${problemChecks.map(c => {
          const st = SEVERITY_STYLE[c.severity] || SEVERITY_STYLE.info;
          return `<div class="card" style="margin-bottom:.8rem">
            <div class="card-head" style="justify-content:space-between">
              <span class="card-title"><i class="fas ${st.icon}" style="color:${st.color}"></i> ${_esc(c.title)}</span>
              <span class="badge ${st.badge}">${c.count}</span>
            </div>
            <div class="card-body" style="padding-top:.5rem">
              <ul style="margin:0;padding-inline-start:1.2rem;font-size:.85rem;line-height:1.9">
                ${c.items.map(item => `<li>${_esc(item)}</li>`).join('')}
              </ul>
              ${c.count > c.items.length ? `<div style="font-size:.78rem;color:var(--tx-3);margin-top:.4rem">و${c.count - c.items.length} أخرى...</div>` : ''}
            </div>
          </div>`;
        }).join('')}

        ${cleanChecks.length ? `<div class="card"><div class="card-body">
          <div style="font-size:.82rem;color:var(--tx-3);margin-bottom:.5rem">فحوصات سليمة:</div>
          ${cleanChecks.map(c => `<div style="display:flex;align-items:center;gap:.5rem;font-size:.82rem;padding:.3rem 0;color:var(--ok)"><i class="fas fa-circle-check"></i> ${_esc(c.title)}</div>`).join('')}
        </div></div>` : ''}
      `;
      document.getElementById('rerunHealthBtn')?.addEventListener('click', () => _renderHealthTab(content));
    } catch(e) { content.innerHTML=`<div class="alert err"><i class="fas fa-circle-xmark"></i> ${_esc(e.message)}</div>`; }
  }

  /* ════════════════════════════════════════════════════════
     ACTIVITY LOG
  ════════════════════════════════════════════════════════ */
  async function _renderActivityTab(content) {
    content.innerHTML = `<div class="card"><div class="card-body"><div class="empty-state"><div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div><h3 class="es-title">جارٍ تحميل سجل النشاط...</h3></div></div></div>`;
    try {
      const result=await DB.getAuditLog(500,0), items=result.items||[];
      const actionLabel={ADD:'إضافة',UPDATE:'تعديل',DELETE:'حذف',ARCHIVE:'أرشفة',VOID:'إلغاء',RESTORE:'استعادة نسخة',BACKUP:'إنشاء نسخة',IMPORT_BACKUP:'استيراد نسخة',CONFIGURE_BACKUP:'تعديل مسار النسخ',ADD_SALE:'إصدار فاتورة',ADD_DEBT:'تسجيل مديونية',PAY_DEBT:'سداد مديونية',VOID_SALE:'إلغاء فاتورة',ADD_SERIALS:'إضافة أجهزة',UPDATE_SERIAL:'تعديل جهاز',STOCKTAKE_ADJUST:'تسوية مخزون',LOGIN:'دخول',LOGOUT:'خروج',CHANGE_PASSWORD:'تغيير كلمة مرور',RESET_PASSWORD:'إعادة ضبط كلمة مرور',ADD_USER:'إضافة مستخدم',UPDATE_USER:'تعديل مستخدم',DELETE_USER:'حذف مستخدم',RECEIVE:'استلام',CANCEL:'إلغاء',UPDATE_SETTING:'تعديل إعداد'};
      const entityLabel={product:'صنف',customer:'عميل',repair:'صيانة',serial_unit:'جهاز',supplier:'مورد',sale:'فاتورة',user:'مستخدم',debt:'مديونية',purchase:'مشتريات',database:'قاعدة البيانات',setting:'إعداد',account:'حساب',transaction:'معاملة مالية',cash_session:'وردية خزينة',promotion:'عرض',delivery_trip:'رحلة توزيع',delivery_stop:'تسليم'};
      const category=x=>x.entity==='user'?'security':x.entity==='database'?'backup':['sale','debt','account','transaction','cash_session'].includes(x.entity)?'money':['product','serial_unit','purchase'].includes(x.entity)?'stock':'other';
      const categoryLabel={all:'الكل',money:'المبيعات والمال',stock:'المخزون والمشتريات',security:'الأمان والمستخدمون',backup:'النسخ والاستعادة',other:'أخرى'};
      const render=()=>{
        const q=(document.getElementById('auditSearch')?.value||'').trim().toLowerCase(), cat=document.getElementById('auditCategory')?.value||'all';
        const shown=items.filter(x=>(cat==='all'||category(x)===cat)&&(!q||[x.action,x.entity,x.details,x.entity_id,x.full_name,x.user_id].some(v=>String(v||'').toLowerCase().includes(q))));
        const host=document.getElementById('auditRows');if(!host)return;
        host.innerHTML=shown.length?`<div class="audit-list">${shown.map(x=>`<div class="audit-row"><span class="audit-dot ${String(x.action).toLowerCase()}"></span><div class="audit-main"><strong>${_esc(actionLabel[x.action]||x.action)} — ${_esc(entityLabel[x.entity]||x.entity)}</strong><small>${_esc(x.details||x.entity_id||'بدون تفاصيل')}</small></div><div class="audit-who"><strong>${_esc(x.full_name||x.user_id||'النظام')}</strong><small>${new Date(x.timestamp).toLocaleString('ar-EG')}</small></div></div>`).join('')}</div>`:'<div class="empty-state"><div class="es-icon"><i class="fas fa-filter-circle-xmark"></i></div><h3 class="es-title">لا توجد نتائج مطابقة</h3></div>';
        document.getElementById('auditShown').textContent=`${shown.length} ظاهرة`;
      };
      content.innerHTML=`<div class="settings-section-head"><div><h2>سجل الرقابة الفعلي</h2><p>يعرض التغييرات المهمة فقط؛ الحفظ التلقائي للمسودات لا يُسجل هنا.</p></div><span class="badge bdg-slate">${result.total||items.length} عملية مهمة</span></div>
        <div class="card" style="margin-bottom:1rem"><div class="card-body"><div class="form-row"><label>بحث في التفاصيل أو المستخدم<input id="auditSearch" class="form-control" placeholder="فاتورة، اسم مستخدم، صنف..."></label><label>نوع النشاط<select id="auditCategory" class="form-control">${Object.entries(categoryLabel).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><label>النتائج<span id="auditShown" class="form-control" style="display:flex;align-items:center">0 ظاهرة</span></label></div></div></div>
        <div class="card"><div class="card-body p0" id="auditRows"></div></div>`;
      document.getElementById('auditSearch').addEventListener('input',render);
      document.getElementById('auditCategory').addEventListener('change',render);
      render();
    } catch(e){content.innerHTML=`<div class="alert err"><i class="fas fa-circle-xmark"></i> ${_esc(e.message)}</div>`;}
  }

  /* ════════════════════════════════════════════════════════
     DEVICES TAB — printer + barcode scanner
  ════════════════════════════════════════════════════════ */
  function _renderDevicesTab(content) {
    const dv = DeviceSettings.get();
    content.innerHTML = `
      <div class="settings-section-head"><div><h2>مركز الطباعة والأجهزة</h2><p>شغّل أو أوقف كل جهاز على هذه المحطة. الإعدادات محلية لهذا الجهاز فقط.</p></div></div>
      <div class="device-control-grid">
        ${[['receiptPrinter','fa-receipt','طابعة الفواتير','طباعة فواتير البيع وإيصالات الصيانة'],['labelPrinter','fa-tags','طابعة الملصقات','طباعة باركود وسعر الصنف'],['barcodeScan','fa-barcode','قارئ الباركود','الماسح USB أو اللاسلكي في نقطة البيع'],['cameraEnabled','fa-camera','الكاميرا','التصوير ومسح الباركود وإثات الدفع']].map(([key,icon,title,desc])=>`<label class="device-control-card ${dv[key]?'enabled':'disabled'}"><span class="device-control-icon"><i class="fas ${icon}"></i></span><span><strong>${title}</strong><small>${desc}</small><b>${dv[key]?'مفعّل':'موقوف'}</b></span><input type="checkbox" data-device-toggle="${key}" ${dv[key]?'checked':''}><em></em></label>`).join('')}
      </div>

      <div class="card" style="margin-bottom:1rem">
        <div class="card-head"><h3 class="card-title"><i class="fas fa-print"></i> إعدادات الطابعة الحرارية (Receipt Printer)</h3></div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">مقاس ورق الفاتورة الافتراضي</label>
            <div style="display:flex;gap:.5rem;max-width:360px">
              <button class="tab-btn ${dv.paperWidth==='80'?'active':''}" id="devPaper80" type="button" style="flex:1;justify-content:center">80mm (Standard POS)</button>
              <button class="tab-btn ${dv.paperWidth==='58'?'active':''}" id="devPaper58" type="button" style="flex:1;justify-content:center">58mm (Compact Mini)</button>
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:.55rem;font-size:.83rem;color:var(--tx-2);cursor:pointer;margin-top:.6rem">
            <input type="checkbox" id="devAutoPrint" ${dv.autoPrint?'checked':''} ${dv.receiptPrinter?'':'disabled'} />
            طباعة الفاتورة تلقائياً فور إتمام عملية البيع
          </label>
        </div>
        <div class="card-foot" style="display:flex;justify-content:flex-start;gap:.75rem">
          <button class="btn btn-ghost btn-sm" id="devTestPrint" ${dv.receiptPrinter?'':'disabled'}><i class="fas fa-receipt"></i> طباعة فاتورة تجريبية</button>
          <button class="btn btn-ghost btn-sm" id="devTestSticker" ${dv.labelPrinter?'':'disabled'}><i class="fas fa-barcode"></i> طباعة ملصق باركود تجريبي</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:1rem">
        <div class="card-head"><h3 class="card-title"><i class="fas fa-barcode"></i> قارئ الباركود (Barcode Scanner)</h3></div>
        <div class="card-body">
          <label style="display:flex;align-items:center;gap:.55rem;font-size:.83rem;color:var(--tx-2);cursor:pointer">
            <input type="checkbox" id="devBarcodeOn" ${dv.barcodeScan?'checked':''} />
            تفعيل استقبال مسح الباركود في نقطة البيع
          </label>
          <p style="font-size:.76rem;color:var(--tx-3);margin-top:.5rem;line-height:1.7">
            قارئ الباركود (USB / Wireless) يعمل تلقائياً كمدخل سريع. عند مسح باركود صنف أو رقم IMEI في شاشة نقطة البيع، سيتم التعرف عليه وإضافته للسلة فوراً.
          </p>
          <div class="form-group" style="margin-top:.75rem;max-width:340px">
            <label class="form-label">اختبار قارئ الباركود</label>
            <input class="form-control" id="devBarcodeTest" placeholder="امسح بالماسح الضوئي أو اكتب واضغط Enter" dir="ltr" ${dv.barcodeScan?'':'disabled'} />
            <div id="devBarcodeResult" style="font-size:.8rem;margin-top:.5rem;color:var(--tx-3)"></div>
          </div>
        </div>
      </div>

      <div class="camera-launch-card">
        <span aria-hidden="true"><i class="fas fa-camera"></i></span>
        <div><h3>الكاميرا والمسح</h3><p>اختبر الجهاز والدقة هنا. التصوير وربط صور الأصناف، والمسح داخل البيع والجرد والاستلام وقراءة أرقام IMEI.</p>
        <button class="btn btn-primary" id="cameraTestBtn" ${dv.cameraEnabled?'':'disabled'}>اختبار الكاميرا</button>
        <button class="btn btn-ghost" id="cameraScanTestBtn" ${dv.cameraEnabled?'':'disabled'}>اختبار قراءة الباركود</button></div>
      </div>`;

    document.querySelectorAll('[data-device-toggle]').forEach(input=>input.addEventListener('change',()=>{
      const patch={[input.dataset.deviceToggle]:input.checked};
      if(input.dataset.deviceToggle==='receiptPrinter'&&!input.checked)patch.autoPrint=false;
      DeviceSettings.set(patch);Toast.ok('تم حفظ حالة الجهاز',input.checked?'تم التشغيل':'تم الإيقاف');_renderDevicesTab(content);
    }));

    const setPaper = w => { DeviceSettings.set({ paperWidth: w }); _renderDevicesTab(content); };
    document.getElementById('devPaper80')?.addEventListener('click', () => setPaper('80'));
    document.getElementById('devPaper58')?.addEventListener('click', () => setPaper('58'));
    document.getElementById('devAutoPrint')?.addEventListener('change', e => {
      DeviceSettings.set({ autoPrint: e.target.checked });
      Toast.ok('تم حفظ الإعدادات');
    });
    document.getElementById('devBarcodeOn')?.addEventListener('change', e => {
      DeviceSettings.set({ barcodeScan: e.target.checked });
      Toast.ok('تم حفظ الإعدادات');
    });

    document.getElementById('cameraTestBtn')?.addEventListener('click', () => CameraStudio.open({title:'اختبار كاميرا الجهاز'}));
    document.getElementById('cameraScanTestBtn')?.addEventListener('click', () => CameraWorkflows.scan({title:'اختبار الباركود', onAccept:async()=>{}, acceptLabel:'تم الاختبار'}));

    document.getElementById('devTestPrint')?.addEventListener('click', () => {
      const tmp = document.createElement('div');
      tmp.id = 'devTestReceipt';
      tmp.className = 'receipt';
      tmp.style.display = 'none';
      const sampleBarcode = BarcodeGenerator.generateSVG('INV-2026-TEST', { height: 26, includeText: true });
      tmp.innerHTML = `
        <div class="rcp-head"><div class="rcp-title">${_esc(_vals.shopName) || 'تك ماركت'}</div>
        <div class="rcp-sub">طباعة تجريبية — اختبار الطابعة</div></div>
        <div class="rcp-div"></div>
        <div class="rcp-row"><span>شاحن سريع 25 وات</span><span>450.00 ج.م</span></div>
        <div class="rcp-row"><span>كابل Type-C</span><span>120.00 ج.م</span></div>
        <div class="rcp-div"></div>
        <div class="rcp-row total"><span>الإجمالي التجريبي</span><span>570.00 ج.م</span></div>
        <div class="rcp-barcode">${sampleBarcode}</div>
        <div class="rcp-foot-note">تمت الطباعة بنجاح من نظام المحل</div>`;
      document.body.appendChild(tmp);
      printElement('devTestReceipt', 'طباعة تجريبية');
      setTimeout(() => tmp.remove(), 2000);
    });

    document.getElementById('devTestSticker')?.addEventListener('click', () => {
      printBarcodeStickers({
        name: 'شاحن سريع 25 وات',
        price: 450.00,
        barcode: '6001000000002',
        brand: 'Samsung',
        model: 'EP-TA800'
      }, 1, _vals.shopName || 'تك ماركت');
      Toast.ok('طباعة ملصق', 'تم إرسال الملصق التجريبي للطابعة');
    });

    document.getElementById('devBarcodeTest')?.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      const code = e.target.value.trim();
      const box = document.getElementById('devBarcodeResult');
      if (!code || !box) return;
      try {
        const products = await DB.getProducts();
        const product = products.find(m => m.barcode === code || m.id.toLowerCase() === code.toLowerCase());
        box.innerHTML = product
          ? `<span style="color:var(--ok)"><i class="fas fa-circle-check"></i> ${product.name} — ${Fmt.money(product.price)} (مخزون: ${product.stock})</span>`
          : `<span style="color:var(--err)"><i class="fas fa-circle-xmark"></i> لا يوجد صنف مسجل بهذا الباركود (${code})</span>`;
      } catch (err) { box.textContent = err.message; }
      e.target.value = '';
    });
  }


  /* ════════════════════════════════════════════════════════
     USERS TAB — قسم إدارة المستخدمين والصلاحيات المتكامل
  ════════════════════════════════════════════════════════ */
  async function _renderUsersTab(content) {
    const me = Auth.getCurrent();
    if (!_isAdmin()) {
      content.innerHTML = `
        <div class="card">
          <div class="card-head"><h3 class="card-title"><i class="fas fa-lock"></i> إدارة المستخدمين</h3></div>
          <div class="card-body">
            <div class="alert warn" style="display:flex;align-items:center;gap:.75rem">
              <i class="fas fa-shield-halved" style="font-size:1.5rem"></i>
              <div>
                <strong>غير مصرح:</strong> هذه الصفحة مخصصة لمدير النظام فقط.
                <div style="font-size:.8rem;margin-top:.2rem">دورك الحالي في النظام هو: <strong>${me?.role || 'مستخدم'}</strong></div>
              </div>
            </div>
          </div>
        </div>`;
      return;
    }

    content.innerHTML = `
      <!-- بطاقات الإحصائيات السريعة للمستخدمين -->
      <div class="usr-stats-grid" id="usrStatsGrid">
        <div class="usr-stat-card">
          <div class="usr-stat-ico" style="background:var(--teal-50);color:var(--teal-600)"><i class="fas fa-users"></i></div>
          <div>
            <div class="usr-stat-num" id="statTotalUsers">—</div>
            <div class="usr-stat-lbl">إجمالي المستخدمين</div>
          </div>
        </div>
        <div class="usr-stat-card">
          <div class="usr-stat-ico" style="background:var(--amb-100);color:var(--amb-700)"><i class="fas fa-shield-halved"></i></div>
          <div>
            <div class="usr-stat-num" id="statAdmins">—</div>
            <div class="usr-stat-lbl">مديرو النظام</div>
          </div>
        </div>
        <div class="usr-stat-card">
          <div class="usr-stat-ico" style="background:var(--ok-light);color:var(--ok)"><i class="fas fa-user-tie"></i></div>
          <div>
            <div class="usr-stat-num" id="statPharmacists">—</div>
            <div class="usr-stat-lbl">مشرفو المحل</div>
          </div>
        </div>
        <div class="usr-stat-card">
          <div class="usr-stat-ico" style="background:var(--sl-100);color:var(--sl-700)"><i class="fas fa-user"></i></div>
          <div>
            <div class="usr-stat-num" id="statAssistants">—</div>
            <div class="usr-stat-lbl">البائعون</div>
          </div>
        </div>
      </div>

      <!-- بطاقة جدول المستخدمين الرئيسية -->
      <div class="card">
        <div class="card-head" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.75rem">
          <div>
            <h3 class="card-title"><i class="fas fa-users-gear"></i> إدارة المستخدمين</h3>
            <p style="font-size:.76rem;color:var(--tx-3);margin-top:.2rem">إدارة حسابات فريق العمل، تعيين الصلاحيات، وإعادة تعيين كلمات المرور</p>
          </div>
          <button class="btn btn-primary btn-sm" id="usrAddBtn"><i class="fas fa-user-plus"></i> إضافة مستخدم جديد</button>
        </div>

        <!-- شريط التصفية والبحث -->
        <div class="usr-filter-row">
          <div style="display:flex;align-items:center;gap:.6rem;flex:1;flex-wrap:wrap">
            <div class="input-wrap usr-search-input" style="position:relative">
              <input type="search" id="usrSearchInp" class="form-control" placeholder="بحث بالاسم، اسم المستخدم، الهاتف..." style="padding-right:2.2rem;font-size:.83rem" />
              <i class="fas fa-magnifying-glass" style="position:absolute;right:.8rem;top:50%;transform:translateY(-50%);color:var(--tx-3)"></i>
            </div>
            <select class="form-control" id="usrRoleFilter" style="width:160px;font-size:.83rem;padding:.5rem .8rem">
              <option value="all">جميع الأدوار</option>
              <option value="مدير النظام">مدير النظام</option>
              <option value="مشرف المحل">مشرف المحل</option>
              <option value="بائع">بائع</option>
            </select>
          </div>
          <div id="usrCountBadge" style="font-size:.78rem;font-weight:700;color:var(--tx-3)"></div>
        </div>

        <div class="card-body p0">
          <div class="tbl-wrap">
            <table class="dtable">
              <thead><tr>
                <th>المستخدم</th>
                <th>اسم الدخول</th>
                <th>الصلاحية / الدور</th>
                <th>بيانات التواصل</th>
                <th>آخر تسجيل دخول</th>
                <th style="text-align:center">الإجراءات</th>
              </tr></thead>
              <tbody id="usrTbody">
                <tr><td colspan="6"><div class="empty-state">
                  <div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div>
                  <h3 class="es-title">جارٍ تحميل المستخدمين...</h3>
                </div></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- دليل الصلاحيات والأدوار التوضيحي -->
      <div class="role-guide-card">
        <div class="role-guide-head" id="roleGuideToggle">
          <span><i class="fas fa-circle-info" style="color:var(--teal-500);margin-left:.4rem"></i> دليل الصلاحيات والأدوار في النظام</span>
          <i class="fas fa-chevron-down" id="roleGuideIcon" style="transition:transform var(--t-fast)"></i>
        </div>
        <div class="role-guide-body" id="roleGuideBody">
          <div class="role-guide-col" style="border-right:3px solid var(--amb-500)">
            <h4><span class="badge bdg-amb"><i class="fas fa-shield-halved"></i> مدير النظام</span></h4>
            <ul>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> كامل الصلاحيات دون قيود</li>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> إدارة حسابات المستخدمين وكلمات المرور</li>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> تقارير الأرباح والتحليلات المالية</li>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> النسخ الاحتياطي واستعادة البيانات</li>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> تعديل إعدادات وهوية المحل</li>
            </ul>
          </div>
          <div class="role-guide-col" style="border-right:3px solid var(--teal-500)">
            <h4><span class="badge bdg-teal"><i class="fas fa-user-tie"></i> مشرف المحل</span></h4>
            <ul>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> البيع وإصدار الفواتير</li>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> إضافة وتعديل الأصناف والمخزون</li>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> إدارة سجلات العملاء والموردين</li>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> استعراض تقارير المبيعات</li>
              <li><i class="fas fa-xmark no" style="color:var(--tx-3);margin-left:.3rem"></i> لا يمكنه تعديل إعدادات النظام أو المستخدمين</li>
            </ul>
          </div>
          <div class="role-guide-col" style="border-right:3px solid var(--sl-500)">
            <h4><span class="badge bdg-slate"><i class="fas fa-user"></i> بائع</span></h4>
            <ul>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> البيع وإتمام المعاملات في POS</li>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> استعراض قائمة الأصناف والأسعار</li>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> استعراض فواتير اليوم</li>
              <li><i class="fas fa-xmark no" style="color:var(--tx-3);margin-left:.3rem"></i> لا يمكنه تعديل بيانات الأصناف أو الأسعار</li>
              <li><i class="fas fa-xmark no" style="color:var(--tx-3);margin-left:.3rem"></i> لا يمكنه الوصول للتقارير والإعدادات</li>
            </ul>
          </div>
          <div class="role-guide-col" style="border-right:3px solid var(--amb-500)">
            <h4><span class="badge bdg-amb"><i class="fas fa-screwdriver-wrench"></i> فني صيانة</span></h4>
            <ul>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> استلام الأجهزة وتحديث تذاكر الصيانة</li>
              <li><i class="fas fa-check ok" style="color:var(--ok);margin-left:.3rem"></i> إضافة قطع الغيار المستخدمة</li>
              <li><i class="fas fa-xmark no" style="color:var(--tx-3);margin-left:.3rem"></i> لا يمكنه البيع أو الوصول للتقارير</li>
            </ul>
          </div>
        </div>
      </div>
    `;

    document.getElementById('usrAddBtn')?.addEventListener('click', () => _openUserForm());

    const searchInp = document.getElementById('usrSearchInp');
    searchInp?.addEventListener('input', e => {
      _searchQuery = e.target.value.trim().toLowerCase();
      _filterAndRenderUsers();
    });

    const roleFilter = document.getElementById('usrRoleFilter');
    roleFilter?.addEventListener('change', e => {
      _selectedRoleFilter = e.target.value;
      _filterAndRenderUsers();
    });

    const guideToggle = document.getElementById('roleGuideToggle');
    const guideBody = document.getElementById('roleGuideBody');
    const guideIcon = document.getElementById('roleGuideIcon');
    guideToggle?.addEventListener('click', () => {
      const isClosed = guideBody.style.display === 'none';
      guideBody.style.display = isClosed ? 'grid' : 'none';
      if (guideIcon) guideIcon.style.transform = isClosed ? 'rotate(0deg)' : 'rotate(180deg)';
    });

    await _loadUsers();
  }

  async function _loadUsers() {
    try {
      _allUsers = await DB.getUsers();
      _updateStats();
      _filterAndRenderUsers();
    } catch (e) {
      const tbody = document.getElementById('usrTbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="6"><div class="alert err">${_esc(e.message)}</div></td></tr>`;
    }
  }

  function _updateStats() {
    const total = _allUsers.length;
    const admins = _allUsers.filter(u => u.role === 'مدير النظام').length;
    const pharmacists = _allUsers.filter(u => u.role === 'مشرف المحل').length;
    const assistants = _allUsers.filter(u => u.role === 'بائع').length;

    const elTotal = document.getElementById('statTotalUsers');
    const elAdmins = document.getElementById('statAdmins');
    const elPharm = document.getElementById('statPharmacists');
    const elAsst = document.getElementById('statAssistants');

    if (elTotal) elTotal.textContent = total;
    if (elAdmins) elAdmins.textContent = admins;
    if (elPharm) elPharm.textContent = pharmacists;
    if (elAsst) elAsst.textContent = assistants;
  }

  function _filterAndRenderUsers() {
    let list = _allUsers;
    if (_selectedRoleFilter !== 'all') {
      list = list.filter(u => u.role === _selectedRoleFilter);
    }
    if (_searchQuery) {
      list = list.filter(u =>
        (u.fullName || '').toLowerCase().includes(_searchQuery) ||
        (u.username || '').toLowerCase().includes(_searchQuery) ||
        (u.phone || '').includes(_searchQuery) ||
        (u.email || '').toLowerCase().includes(_searchQuery)
      );
    }
    _filteredUsers = list;

    const countBadge = document.getElementById('usrCountBadge');
    if (countBadge) countBadge.textContent = `${list.length} مستخدم`;

    _renderUsersTable(list);
  }

  function _getRoleMeta(role) {
    return ROLES.find(r => r.id === role) || { label: role, icon: 'fa-user', cls: 'assistant', bdg: 'bdg-slate' };
  }

  function _getAvatarInitials(name) {
    if (!name) return 'U';
    const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return parts.map(p => p[0]).join('') || name[0] || 'U';
  }

  function _renderUsersTable(users) {
    const tbody = document.getElementById('usrTbody');
    if (!tbody) return;

    if (!users.length) {
      tbody.innerHTML = `
        <tr><td colspan="6">
          <div class="empty-state" style="padding:2rem 1rem">
            <div class="es-icon" style="background:var(--sl-100);color:var(--sl-500)"><i class="fas fa-users-slash"></i></div>
            <h3 class="es-title">لا يوجد مستخدمون مطابقون للبحث</h3>
            <p class="es-text">جرب تغيير كلمات البحث أو تصفية الأدوار</p>
          </div>
        </td></tr>`;
      return;
    }

    const me = Auth.getCurrent();
    tbody.innerHTML = users.map(u => {
      const isMe = u.id === me?.id;
      const roleMeta = _getRoleMeta(u.role);
      const initials = _getAvatarInitials(u.fullName);

      return `
        <tr>
          <!-- المستخدم والاسم -->
          <td>
            <div style="display:flex;align-items:center;gap:.75rem">
              <div class="usr-avatar ${roleMeta.cls}">${initials}</div>
              <div>
                <div style="font-weight:700;color:var(--tx);display:flex;align-items:center;gap:.4rem">
                  ${_esc(u.fullName)}
                  ${isMe ? '<span class="badge bdg-teal" style="font-size:.65rem;padding:2px 6px"><i class="fas fa-user-check"></i> أنت</span>' : ''}
                </div>
                <div style="font-size:.72rem;color:var(--tx-3)">معرف: ${u.id}</div>
              </div>
            </div>
          </td>

          <!-- اسم الدخول -->
          <td>
            <span style="font-family:monospace;font-size:.86rem;font-weight:600;color:var(--tx);direction:ltr;display:inline-block;background:var(--surface-2);padding:2px 8px;border-radius:var(--r-xs);border:1px solid var(--border-2)">
              @${_esc(u.username)}
            </span>
          </td>

          <!-- الصلاحية -->
          <td>
            <span class="badge ${roleMeta.bdg}">
              <i class="fas ${roleMeta.icon}"></i> ${roleMeta.label}
            </span>
          </td>

          <!-- بيانات التواصل -->
          <td>
            <div style="font-size:.78rem;color:var(--tx-2);display:flex;flex-direction:column;gap:2px">
              ${u.phone ? `<div><i class="fas fa-phone" style="width:14px;color:var(--tx-3)"></i> <span dir="ltr">${_esc(u.phone)}</span></div>` : ''}
              ${u.email ? `<div><i class="fas fa-envelope" style="width:14px;color:var(--tx-3)"></i> <span dir="ltr">${_esc(u.email)}</span></div>` : ''}
              ${!u.phone && !u.email ? '<span style="color:var(--tx-3)">—</span>' : ''}
            </div>
          </td>

          <!-- آخر تسجيل دخول -->
          <td>
            <div style="font-size:.78rem;color:var(--tx-2)">
              ${u.lastLogin ? `
                <div style="font-weight:600"><i class="fas fa-clock" style="color:var(--teal-500);margin-left:3px"></i> ${u.lastLogin.split('T')[0]}</div>
                <div style="font-size:.7rem;color:var(--tx-3)">${(u.lastLogin.split('T')[1]||'').slice(0,5)}</div>
              ` : '<span class="badge bdg-slate" style="font-size:.68rem">لم يسجل دخول بعد</span>'}
            </div>
          </td>

          <!-- الإجراءات -->
          <td>
            <div class="td-actions" style="justify-content:center">
              <button class="btn btn-ghost btn-icon sm" data-action="edit" data-id="${u.id}" title="تعديل بيانات المستخدم">
                <i class="fas fa-pen"></i>
              </button>
              <button class="btn btn-outline btn-icon sm" data-action="pwd" data-id="${u.id}" title="إعادة تعيين كلمة المرور">
                <i class="fas fa-key"></i>
              </button>
              <button class="btn btn-danger btn-icon sm" data-action="del" data-id="${u.id}" title="${isMe ? 'لا يمكن حذف حسابك الحالي' : 'حذف المستخدم'}" ${isMe ? 'disabled style="opacity:.3;cursor:not-allowed"' : ''}>
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const u = _allUsers.find(x => x.id === btn.dataset.id);
        if (!u) return;
        if (btn.dataset.action === 'edit') _openUserForm(u);
        if (btn.dataset.action === 'pwd')  _openResetPwd(u);
        if (btn.dataset.action === 'del')  _deleteUser(u);
      });
    });
  }

  function _generateRandomPassword(len = 8) {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$';
    let res = '';
    for (let i = 0; i < len; i++) {
      res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res;
  }

  function _renderRolePermsPreview(role) {
    const perms = ROLE_PERMS_INFO[role] || [];
    return `
      <div class="role-perm-box">
        <div class="role-perm-title">
          <i class="fas fa-list-check" style="color:var(--teal-500)"></i>
          <span>صلاحيات دور (${_esc(role)}):</span>
        </div>
        <div class="role-perm-list">
          ${perms.map(p => `
            <div class="role-perm-item">
              <i class="fas ${p.ok ? 'fa-circle-check ok' : 'fa-circle-xmark no'}"></i>
              <span>${p.text}</span>
            </div>
          `).join('')}
        </div>
      </div>`;
  }

  function _openUserForm(u) {
    const isEdit = !!u;
    const currentRole = u?.role || 'مشرف المحل';

    Modal.open({
      title: isEdit ? `<i class="fas fa-user-pen"></i> تعديل بيانات: ${u.fullName}` : '<i class="fas fa-user-plus"></i> إضافة مستخدم جديد',
      size: 'lg',
      body: `
        <div class="form-row cols-2">
          <div class="form-group">
            <label class="form-label"><i class="fas fa-id-card" style="color:var(--teal-500)"></i> الاسم الكامل <span class="req">*</span></label>
            <input class="form-control" id="fUsrName" value="${_esc(u?.fullName)}" placeholder="مثال: د. سارة أحمد" required />
          </div>
          <div class="form-group">
            <label class="form-label"><i class="fas fa-at" style="color:var(--teal-500)"></i> اسم المستخدم (Login) <span class="req">*</span></label>
            <input class="form-control" id="fUsrUsername" value="${_esc(u?.username)}" dir="ltr" placeholder="مثال: sarah_ahmed" required />
          </div>
        </div>

        <div class="form-row cols-2">
          <div class="form-group">
            <label class="form-label"><i class="fas fa-user-tag" style="color:var(--teal-500)"></i> الدور الوظيفي / الصلاحية <span class="req">*</span></label>
            <select class="form-control" id="fUsrRole">
              ${ROLES.map(r => `<option value="${r.id}" ${currentRole === r.id ? 'selected' : ''}>${r.label}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label"><i class="fas fa-phone" style="color:var(--teal-500)"></i> رقم الهاتف</label>
            <input class="form-control" id="fUsrPhone" value="${_esc(u?.phone)}" dir="ltr" placeholder="01xxxxxxxxx" />
          </div>
        </div>

        <div class="form-group">
          <label class="form-label"><i class="fas fa-envelope" style="color:var(--teal-500)"></i> البريد الإلكتروني</label>
          <input class="form-control" id="fUsrEmail" type="email" value="${_esc(u?.email)}" dir="ltr" placeholder="user@shop.com" />
        </div>

        ${!isEdit ? `
          <div class="form-group" style="background:var(--surface-2);padding:.85rem;border-radius:var(--r-sm);border:1px solid var(--border-2)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.35rem">
              <label class="form-label" style="margin-bottom:0"><i class="fas fa-key" style="color:var(--teal-500)"></i> كلمة المرور الأولى</label>
              <button type="button" class="btn btn-ghost btn-sm" id="btnGenPwd" style="font-size:.74rem;padding:2px 8px">
                <i class="fas fa-wand-magic-sparkles"></i> توليد كلمة مرور
              </button>
            </div>
            <div class="input-wrap" style="position:relative">
              <input class="form-control" id="fUsrPassword" type="password" value="123456" placeholder="كلمة المرور (الافتراضية: 123456)" dir="ltr" />
              <button type="button" id="btnToggleUsrPwd" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--tx-3);cursor:pointer">
                <i class="fas fa-eye"></i>
              </button>
            </div>
            <div style="font-size:.73rem;color:var(--tx-3);margin-top:.3rem">
              <i class="fas fa-info-circle"></i> يمكن للمستخدم تغيير كلمة مروره بعد تسجيل الدخول.
            </div>
          </div>
        ` : ''}

        <!-- معاينة صلاحيات الدور المختار -->
        <div id="rolePermPreviewContainer">
          ${_renderRolePermsPreview(currentRole)}
        </div>
      `,
      foot: `
        <button class="btn btn-primary" id="saveUsrBtn"><i class="fas fa-check"></i> ${isEdit ? 'حفظ التعديلات' : 'إضافة المستخدم'}</button>
        <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>
      `,
    });

    // تحديث معاينة الصلاحيات عند تغيير الدور
    document.getElementById('fUsrRole')?.addEventListener('change', e => {
      const container = document.getElementById('rolePermPreviewContainer');
      if (container) container.innerHTML = _renderRolePermsPreview(e.target.value);
    });

    // زر توليد كلمة المرور
    document.getElementById('btnGenPwd')?.addEventListener('click', () => {
      const pwdInp = document.getElementById('fUsrPassword');
      if (pwdInp) {
        pwdInp.value = _generateRandomPassword(8);
        pwdInp.type = 'text';
        Toast.ok('تم توليد كلمة مرور عشوائية');
      }
    });

    // زر إظهار/إخفاء كلمة المرور
    document.getElementById('btnToggleUsrPwd')?.addEventListener('click', () => {
      const pwdInp = document.getElementById('fUsrPassword');
      const icon = document.querySelector('#btnToggleUsrPwd i');
      if (!pwdInp) return;
      const isPwd = pwdInp.type === 'password';
      pwdInp.type = isPwd ? 'text' : 'password';
      if (icon) icon.className = isPwd ? 'fas fa-eye-slash' : 'fas fa-eye';
    });

    document.getElementById('saveUsrBtn')?.addEventListener('click', () => _saveUser(u?.id));
  }

  async function _saveUser(id) {
    const fullName = document.getElementById('fUsrName')?.value.trim();
    const username = document.getElementById('fUsrUsername')?.value.trim();
    const role     = document.getElementById('fUsrRole')?.value;
    const phone    = document.getElementById('fUsrPhone')?.value.trim();
    const email    = document.getElementById('fUsrEmail')?.value.trim();

    if (!fullName || !username) {
      Toast.err('بيانات ناقصة', 'الاسم الكامل واسم المستخدم حقول إجبارية');
      return;
    }

    const payload = {
      full_name: fullName,
      username:  username,
      role:      role,
      phone:     phone,
      email:     email,
    };

    const pwdInput = document.getElementById('fUsrPassword');
    if (pwdInput) payload.password = pwdInput.value.trim() || '123456';

    const saveBtn = document.getElementById('saveUsrBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جارٍ الحفظ...'; }

    try {
      if (id) {
        await DB.updateUser(id, payload);
        Toast.ok('تم تحديث المستخدم', `تم تحديث بيانات ${fullName} بنجاح`);
      } else {
        await DB.addUser(payload);
        Toast.ok('تمت إضافة المستخدم', `تم إنشاء حساب جديد لـ ${fullName}`);
      }
      Modal.close();
      await _loadUsers();
    } catch (e) {
      Toast.err('تعذر حفظ المستخدم', e.message);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-check"></i> حفظ'; }
    }
  }

  function _openResetPwd(u) {
    Modal.open({
      title: `<i class="fas fa-key"></i> إعادة تعيين كلمة المرور: ${u.fullName}`,
      size: 'md',
      body: `
        <div style="display:flex;align-items:center;gap:.75rem;padding:.85rem;background:var(--surface-2);border-radius:var(--r-sm);margin-bottom:1rem">
          <div class="usr-avatar ${_getRoleMeta(u.role).cls}">${_getAvatarInitials(u.fullName)}</div>
          <div>
            <div style="font-weight:700;color:var(--tx)">${_esc(u.fullName)}</div>
            <div style="font-size:.76rem;color:var(--tx-3)">اسم الدخول: @${_esc(u.username)} | الصلاحية: ${_esc(u.role)}</div>
          </div>
        </div>

        <div class="form-group">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.35rem">
            <label class="form-label" style="margin-bottom:0">كلمة المرور الجديدة</label>
            <div style="display:flex;gap:.35rem">
              <button type="button" class="btn btn-ghost btn-sm" id="btnPresetDefault" style="font-size:.72rem;padding:2px 7px">
                تعيين: 123456
              </button>
              <button type="button" class="btn btn-ghost btn-sm" id="btnGenPwdReset" style="font-size:.72rem;padding:2px 7px">
                <i class="fas fa-wand-magic-sparkles"></i> توليد عشوائي
              </button>
            </div>
          </div>
          <div class="input-wrap" style="position:relative">
            <input class="form-control" id="fNewPwd" type="text" value="123456" placeholder="أدخل كلمة المرور الجديدة" dir="ltr" required />
            <button type="button" id="btnToggleResetPwd" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--tx-3);cursor:pointer">
              <i class="fas fa-eye-slash"></i>
            </button>
          </div>
          <div style="font-size:.73rem;color:var(--tx-3);margin-top:.35rem">
            سيُطلب من المستخدم استخدام كلمة المرور هذه عند تسجيل الدخول القادم.
          </div>
        </div>
      `,
      foot: `
        <button class="btn btn-primary" id="savePwdBtn"><i class="fas fa-check"></i> تحديث كلمة المرور</button>
        <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>
      `,
    });

    document.getElementById('btnPresetDefault')?.addEventListener('click', () => {
      const inp = document.getElementById('fNewPwd');
      if (inp) inp.value = '123456';
    });

    document.getElementById('btnGenPwdReset')?.addEventListener('click', () => {
      const inp = document.getElementById('fNewPwd');
      if (inp) {
        inp.value = _generateRandomPassword(8);
        Toast.ok('تم توليد كلمة مرور عشوائية');
      }
    });

    document.getElementById('btnToggleResetPwd')?.addEventListener('click', () => {
      const pwdInp = document.getElementById('fNewPwd');
      const icon = document.querySelector('#btnToggleResetPwd i');
      if (!pwdInp) return;
      const isPwd = pwdInp.type === 'password';
      pwdInp.type = isPwd ? 'text' : 'password';
      if (icon) icon.className = isPwd ? 'fas fa-eye-slash' : 'fas fa-eye';
    });

    document.getElementById('savePwdBtn')?.addEventListener('click', async () => {
      const pwd = document.getElementById('fNewPwd')?.value.trim() || '123456';
      const btn = document.getElementById('savePwdBtn');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جارٍ التحديث...'; }
      try {
        await DB.resetUserPassword(u.id, pwd);
        Toast.ok('تم تغيير كلمة المرور', `تم تعيين كلمة المرور الجديدة لـ ${u.fullName}`);
        Modal.close();
      } catch (e) {
        Toast.err('فشل إعادة التعيين', e.message);
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> تحديث كلمة المرور'; }
      }
    });
  }

  function _deleteUser(u) {
    const me = Auth.getCurrent();
    if (me && me.id === u.id) {
      Toast.err('إجراء غير مسموح', 'لا يمكنك حذف حسابك الشخصي المسجل به حالياً');
      return;
    }
    Modal.confirm(
      'حذف المستخدم',
      `هل أنت متأكد من رغبتك في حذف حساب "${u.fullName}" (@${u.username}) نهائياً من النظام؟ لن يتمكن المستخدم من الدخول بعد ذلك.`,
      async () => {
        try {
          await DB.deleteUser(u.id);
          Toast.ok('تم الحذف', `تم حذف حساب ${u.fullName} بنجاح`);
          await _loadUsers();
        } catch (e) {
          Toast.err('فشل الحذف', e.message);
        }
      }
    );
  }

  function _setMode(mode) {
    Theme.applyMode(mode);
    _save({ themeMode: mode }, false, true);
  }

  async function _save(fields, refreshBranding, silentRerender) {
    try {
      await Promise.all(Object.entries(fields).map(([name, val]) => DB.setSetting(KEYS[name], val)));
      Object.assign(_vals, fields);
      if (refreshBranding || 'shopName' in fields || 'shopLogo' in fields) App.applyBranding();
      if (silentRerender) { _renderTab(_activeTab); return; }
      Toast.ok('تم حفظ الإعدادات بنجاح');
    } catch (e) {
      Toast.err(e.message || 'فشل حفظ الإعدادات');
    }
  }

  function _esc(v) {
    return v === null || v === undefined ? '' : String(v).replace(/"/g, '&quot;');
  }

  return { render, afterRender };
})();
