'use strict';

const DashboardPage = (() => {
  let _range = null;

  function _isoLocal(value = new Date()) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function _defaultRange() {
    const now = new Date();
    return { from: _isoLocal(new Date(now.getFullYear(), now.getMonth(), 1)), to: _isoLocal(now) };
  }

  function render() {
    const user = Auth.getCurrent();
    const name = _esc((user?.fullName || user?.username || 'مستخدم').split(/\s+/).slice(0, 2).join(' '));
    const dayText = new Intl.DateTimeFormat('ar-EG', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(new Date());
    _range = _defaultRange();

    return `
      <div class="page active dashboard-ops" id="page-dashboard">
        <section class="dash-welcome">
          <div>
            <span class="dash-eyebrow">نظرة تشغيلية موحّدة</span>
            <h1>مرحباً، ${name}</h1>
            <p>${dayText} — المبيعات والمخزون والمهام التي تحتاج تدخلك.</p>
          </div>
          <span class="dash-system-status"><i></i> النظام يعمل بصورة طبيعية</span>
        </section>

        <section class="dash-range-panel" aria-label="تحديد فترة التقرير">
          <div class="dash-range-title">
            <span class="dash-range-icon"><i class="fas fa-calendar-days"></i></span>
            <div><strong>فترة التقرير</strong><small>كل مؤشرات المبيعات أدناه تتبع الفترة نفسها</small></div>
          </div>
          <div class="dash-presets" id="dashPresets">
            <button type="button" data-preset="today">اليوم</button>
            <button type="button" data-preset="7">7 أيام</button>
            <button type="button" data-preset="month" class="active">هذا الشهر</button>
            <button type="button" data-preset="90">90 يومًا</button>
          </div>
          <label class="dash-date-field"><span>من تاريخ</span><input type="date" id="dashFrom" value="${_range.from}"></label>
          <label class="dash-date-field"><span>إلى تاريخ</span><input type="date" id="dashTo" value="${_range.to}"></label>
          <button type="button" class="btn btn-primary dash-apply" id="dashApply"><i class="fas fa-filter"></i> تطبيق</button>
          <button type="button" class="btn btn-ghost dash-full-report" id="dashOpenReports"><i class="fas fa-chart-column"></i> التقارير التفصيلية</button>
        </section>

        <div class="dash-period-note" id="dashPeriodNote"></div>
        <div id="dashContent">
          <div class="metric-grid">${Array(4).fill('<div class="metric-card"><div class="skeleton" style="height:90px"></div></div>').join('')}</div>
        </div>
      </div>`;
  }

  async function afterRender() {
    document.getElementById('dashOpenReports')?.addEventListener('click', () => App.navigate('reports'));
    document.getElementById('dashApply')?.addEventListener('click', _loadSelectedRange);
    document.getElementById('dashPresets')?.addEventListener('click', e => {
      const button = e.target.closest('[data-preset]');
      if (!button) return;
      const now = new Date();
      let from = new Date(now);
      if (button.dataset.preset === '7') from.setDate(now.getDate() - 6);
      else if (button.dataset.preset === '90') from.setDate(now.getDate() - 89);
      else if (button.dataset.preset === 'month') from = new Date(now.getFullYear(), now.getMonth(), 1);
      document.getElementById('dashFrom').value = _isoLocal(from);
      document.getElementById('dashTo').value = _isoLocal(now);
      document.querySelectorAll('#dashPresets button').forEach(b => b.classList.toggle('active', b === button));
      _loadSelectedRange();
    });
    await _loadSelectedRange();
    try {
      const backup = await DB.getBackupStatus();
      if (backup?.stale) Toast.warn('النسخ الاحتياطي متأخر', 'مضت 3 أيام أو أكثر بدون نسخة احتياطية سليمة.');
      if(backup?.secondary?.state==='not_configured')Toast.warn('حماية النسخ غير مكتملة','لم يتم تحديد مكان نسخة إضافية خارج مجلد المشروع. راجع إعدادات النسخ الاحتياطي.');
      else if(backup?.secondary?.state!=='ok')Toast.warn('النسخة الإضافية تحتاج مراجعة','وصّل القرص الخارجي أو راجع اتصال مجلد الشبكة ثم أنشئ نسخة جديدة.');
    } catch (_) { /* لا نوقف لوحة التحكم بسبب فحص النسخ */ }
  }

  async function _loadSelectedRange() {
    const from = document.getElementById('dashFrom')?.value;
    const to = document.getElementById('dashTo')?.value;
    if (!from || !to) return Toast.warn('الفترة غير مكتملة', 'اختر تاريخ البداية وتاريخ النهاية');
    if (from > to) return Toast.warn('الفترة غير صحيحة', 'تاريخ البداية يجب أن يسبق تاريخ النهاية');

    _range = { from, to };
    const applyButton = document.getElementById('dashApply');
    if (applyButton) {
      applyButton.disabled = true;
      applyButton.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> تحديث';
    }
    const content = document.getElementById('dashContent');
    content?.classList.add('is-loading');

    try {
      const [report, low, agingStock, aging, deliveryStats, repairStats] = await Promise.all([
        DB.getDashboardReport(from, to), DB.getLowStock(), DB.getStockAgingReport().catch(()=>null),
        DB.getDebtAgingReport().catch(()=>({customers:[],totals:{}})),
        DB.getDeliveryStats().catch(()=>({preparing:0,on_road:0,pending_stops:0,problem_stops:0,amount_in_transit:0})),
        DB.getRepairStats().catch(()=>null),
      ]);
      _draw(report, low || [], agingStock?.buckets?.over90 || [], aging, deliveryStats, repairStats);
    } catch (error) {
      if (content) content.innerHTML = `<div class="alert err"><i class="fas fa-circle-xmark"></i> تعذر تحميل لوحة التحكم: ${_esc(error.message)}</div>`;
    } finally {
      content?.classList.remove('is-loading');
      if (applyButton) {
        applyButton.disabled = false;
        applyButton.innerHTML = '<i class="fas fa-filter"></i> تطبيق';
      }
    }
  }

  function _metric(icon, label, value, note, tone) {
    return `
      <article class="dash-metric ${tone}">
        <span class="dash-metric-icon"><i class="fas ${icon}"></i></span>
        <div class="dash-metric-copy"><small>${label}</small><strong>${value}</strong><span>${note}</span></div>
      </article>`;
  }

  function _formatRangeDate(value) {
    return new Date(`${value}T12:00:00`).toLocaleDateString('ar-EG', {day:'numeric', month:'short', year:'numeric'});
  }

  function _formatBucket(value, granularity) {
    if (granularity === 'month') {
      const [year, month] = value.split('-').map(Number);
      return new Date(year, month - 1, 1).toLocaleDateString('ar-EG', {month:'short', year:'2-digit'});
    }
    return new Date(`${value}T12:00:00`).toLocaleDateString('ar-EG', {day:'numeric', month:'short'});
  }

  function _draw(report, low, agedDevices, aging, deliveryStats, repairStats) {
    const summary = report.summary || {};
    const growth = summary.growthPct;
    const growthNote = growth === null || growth === undefined
      ? 'لا توجد فترة سابقة للمقارنة'
      : `${growth >= 0 ? 'ارتفاع' : 'انخفاض'} ${Math.abs(growth)}% عن الفترة السابقة`;
    const overLimitCustomers = (aging?.customers || []).filter(c =>
      c.customer_type === 'جملة' && c.credit_limit > 0 && c.total > c.credit_limit);
    const alerts = [
      ...overLimitCustomers.slice(0, 2).map(c => ({icon:'fa-credit-card', level:'danger', name:c.customer_name, detail:`مستحق ${Fmt.money(c.total)} — الحد ${Fmt.money(c.credit_limit)}`, label:'تجاوز سقف الائتمان'})),
      ...low.slice(0, 2).map(m => ({icon:'fa-box-open', level:'warn', name:m.name, detail:`متبقي ${m.stock} — حد الطلب ${m.minStock}`, label:'مخزون منخفض'})),
      ...agedDevices.slice(0, 2).map(u => ({icon:'fa-hourglass-half', level:'danger', name:u.name, detail:`${u.serial} — في المخزون منذ ${u.age_days} يوم`, label:'جهاز راكد'})),
      ...((repairStats?.overdue) ? [{icon:'fa-screwdriver-wrench', level:'warn', name:'صيانة متأخرة', detail:`${repairStats.overdue} تذكرة تجاوزت موعد التسليم`, label:'صيانة'}] : []),
    ].slice(0, 6);
    const series = report.series || {labels:[], values:[], granularity:'day'};
    const periodNote = document.getElementById('dashPeriodNote');
    if (periodNote) periodNote.innerHTML = `<i class="fas fa-chart-line"></i> تعرض النتائج من <strong>${_formatRangeDate(report.from)}</strong> إلى <strong>${_formatRangeDate(report.to)}</strong>`;

    const content = document.getElementById('dashContent');
    if (!content) return;
    content.innerHTML = `
      <div class="dash-metrics-grid">
        ${_metric('fa-sack-dollar', 'صافي المبيعات', Fmt.money(summary.revenue || 0), growthNote, 'teal')}
        ${_metric('fa-receipt', 'الفواتير المكتملة', Fmt.num(summary.count || 0), `خصومات ${Fmt.money(summary.discount || 0)}`, 'blue')}
        ${_metric('fa-chart-simple', 'متوسط الفاتورة', Fmt.money(summary.average || 0), `ضريبة محصلة ${Fmt.money(summary.tax || 0)}`, 'violet')}
        ${_metric('fa-coins', 'الربح الإجمالي التقديري', Fmt.money(summary.estimatedProfit || 0), `تكلفة تقديرية ${Fmt.money(summary.estimatedCost || 0)}`, 'amber')}
      </div>

      <section class="dash-quick-section">
        <div class="dash-section-heading"><div><strong>مؤشرات إدارية</strong><small>الديون والصيانة والتوزيع في نظرة واحدة</small></div></div>
        <div class="dash-metrics-grid">
          ${_metric('fa-file-invoice-dollar', 'إجمالي الديون المستحقة', Fmt.money(aging?.totals?.total || 0), overLimitCustomers.length ? `${overLimitCustomers.length} عميل تجاوز سقف الائتمان` : 'لا يوجد تجاوز لسقف الائتمان', overLimitCustomers.length ? 'amber' : 'teal')}
          ${_metric('fa-truck-fast', 'رحلات جارية', Fmt.num((deliveryStats?.preparing||0)+(deliveryStats?.on_road||0)), `${Fmt.num(deliveryStats?.pending_stops||0)} توقف قيد الانتظار`, 'blue')}
          ${_metric('fa-triangle-exclamation', 'مشاكل توصيل', Fmt.num(deliveryStats?.problem_stops||0), 'تحتاج متابعة السائق', deliveryStats?.problem_stops ? 'amber' : 'teal')}
          ${_metric('fa-hourglass-half', 'مبلغ قيد التحصيل (COD)', Fmt.money(deliveryStats?.amount_in_transit||0), 'من شحنات لم تُسلَّم بعد', 'violet')}
        </div>
      </section>

      <section class="dash-quick-section">
        <div class="dash-section-heading"><div><strong>إجراءات سريعة</strong><small>أكثر المهام استخدامًا أثناء الوردية</small></div></div>
        <div class="dash-quick-grid">
          <button onclick="App.navigate('sales')"><i class="fas fa-cart-plus"></i><span><strong>فاتورة بيع</strong><small>بدء عملية بيع جديدة</small></span><i class="fas fa-chevron-left"></i></button>
          <button onclick="App.navigate('products');setTimeout(()=>ProductsPage.openAddModal(),250)"><i class="fas fa-boxes-stacked"></i><span><strong>إضافة صنف</strong><small>تسجيل جهاز أو منتج</small></span><i class="fas fa-chevron-left"></i></button>
          <button onclick="App.navigate('repairs')"><i class="fas fa-screwdriver-wrench"></i><span><strong>الصيانة</strong><small>${repairStats ? `${repairStats.open} تذكرة مفتوحة` : 'استلام وتسليم الأجهزة'}</small></span><i class="fas fa-chevron-left"></i></button>
          <button onclick="App.navigate('warranty')"><i class="fas fa-shield-halved"></i><span><strong>فحص الضمان</strong><small>بحث برقم IMEI أو الفاتورة</small></span><i class="fas fa-chevron-left"></i></button>
          <button onclick="App.navigate('shortage')"><i class="fas fa-clipboard-list"></i><span><strong>كشكول النواقص</strong><small>مراجعة الأصناف المطلوبة</small></span><i class="fas fa-chevron-left"></i></button>
          <button onclick="App.navigate('delivery')"><i class="fas fa-truck-fast"></i><span><strong>الشحن والتوزيع</strong><small>متابعة الرحلات والتوصيل</small></span><i class="fas fa-chevron-left"></i></button>
          <button onclick="App.navigate('reports')"><i class="fas fa-chart-column"></i><span><strong>التقارير</strong><small>تحليل المبيعات والأرباح</small></span><i class="fas fa-chevron-left"></i></button>
        </div>
      </section>

      <div class="dash-main-grid">
        <section class="dash-panel dash-sales-panel">
          <header><div><strong>اتجاه المبيعات</strong><small>حسب الفترة المحددة</small></div><span>${series.granularity === 'month' ? 'شهري' : 'يومي'}</span></header>
          <div class="dash-chart-wrap">${series.values.length ? '<div class="bar-chart tall" id="dashRangeChart"></div>' : '<div class="dash-empty"><i class="fas fa-chart-column"></i><strong>لا توجد مبيعات في هذه الفترة</strong><span>اختر فترة أخرى أو ابدأ عملية بيع جديدة</span></div>'}</div>
          <div class="dash-payment-row">${(report.payments || []).length ? report.payments.map(p => `<span><i class="fas fa-credit-card"></i>${_esc(p.method || 'غير محدد')} <strong>${Fmt.money(p.total)}</strong></span>`).join('') : '<small>لا توجد طرق دفع مسجلة للفترة</small>'}</div>
        </section>
        <section class="dash-panel dash-alert-panel">
          <header><div><strong>تحتاج تدخلك الآن</strong><small>تنبيهات لحظية وليست مرتبطة بفترة التقرير</small></div><button onclick="App.navigate('products')">فتح المخزون</button></header>
          <div class="dash-alert-list">${alerts.length ? alerts.map(item => `
            <div class="dash-alert-row ${item.level}">
              <i class="fas ${item.icon}"></i><div><strong>${_esc(item.name)}</strong><small>${_esc(item.detail)}</small></div><span>${item.label}</span>
            </div>`).join('') : '<div class="dash-empty compact"><i class="fas fa-circle-check"></i><strong>المخزون مستقر</strong><span>لا توجد تنبيهات عاجلة</span></div>'}</div>
        </section>
      </div>

      <div class="dash-lower-grid">
        <section class="dash-panel">
          <header><div><strong>الأصناف الأكثر مبيعًا</strong><small>الترتيب داخل الفترة المحددة</small></div></header>
          <div class="tbl-wrap"><table class="dtable dash-table"><thead><tr><th>الصنف</th><th>الكمية</th><th>الإيراد</th></tr></thead><tbody>
            ${(report.topProducts || []).length ? report.topProducts.map((m, index) => `<tr><td><span class="dash-rank">${index + 1}</span><strong>${_esc(m.name)}</strong></td><td>${Fmt.num(m.qty)}</td><td>${Fmt.money(m.revenue)}</td></tr>`).join('') : '<tr><td colspan="3" class="text-center text-muted">لا توجد أصناف مباعة في الفترة</td></tr>'}
          </tbody></table></div>
        </section>
        <section class="dash-panel">
          <header><div><strong>آخر الفواتير</strong><small>أحدث العمليات داخل الفترة</small></div><button onclick="App.navigate('invoices')">كل الفواتير</button></header>
          <div class="dash-recent-list">${(report.recentSales || []).length ? report.recentSales.map(sale => `
            <div class="dash-recent-row"><i class="fas fa-receipt"></i><div><strong>${_esc(sale.invoice_num)}</strong><small>${_esc(sale.customer_name || 'عميل نقدي')} · ${_esc(sale.payment_method || 'غير محدد')}</small></div><span><strong>${Fmt.money(sale.total)}</strong><small>${_esc(sale.sale_date)} ${_esc(sale.sale_time)}</small></span></div>`).join('') : '<div class="dash-empty compact"><i class="fas fa-receipt"></i><strong>لا توجد فواتير</strong><span>خلال الفترة المحددة</span></div>'}</div>
        </section>
      </div>`;

    if (series.values.length) {
      requestAnimationFrame(() => renderBarChart(
        'dashRangeChart',
        series.labels.map(label => _formatBucket(label, series.granularity)),
        series.values,
        'linear-gradient(180deg,#37b9ad,#11766e)',
      ));
    }
  }

  return { render, afterRender };
})();
