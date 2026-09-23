/* ════════════════════════════════════════════════════════════
   PAGE: REPORTS  (async) — v2
   • تقرير الأرباح الكامل (API getProfitReport)
   • تبويب الأصناف الراكدة
   • فلتر الفترة الزمنية لتقرير الأرباح
════════════════════════════════════════════════════════════ */
'use strict';

const ReportsPage = (() => {

  let _data        = {};
  let _profitData  = null;
  let _profitPeriod = 'month';
  let _activeTab   = 'overview';

  /* زر "تصدير Excel" موحّد لأي تقرير من التقارير التحليلية الجديدة —
     يفتح رابط التصدير مباشرة في تبويب جديد (الخادم يبني الملف عند الطلب). */
  function _excelExportBtn(reportKey) {
    return `<button class="btn btn-outline btn-sm" data-xlsx="${reportKey}"><i class="fas fa-file-excel"></i> تصدير Excel</button>`;
  }
  function _wireExcelButtons(container) {
    container.querySelectorAll('[data-xlsx]').forEach(btn => {
      btn.addEventListener('click', () => window.open(`/api/export_report_excel?report=${btn.dataset.xlsx}`, '_blank'));
    });
  }

  function render() {
    return `
<div class="page active" id="page-reports">
  <div class="pg-header">
    <div class="pg-title-group">
      <h1 class="pg-title">
        <div class="pg-title-icon" style="background:var(--sl-100);color:var(--sl-600)"><i class="fas fa-chart-bar"></i></div>
        التقارير والإحصائيات
      </h1>
      <p class="pg-subtitle">تحليل شامل لأداء المحل</p>
    </div>
    <div class="pg-actions">
      <button class="btn btn-ghost btn-sm" id="rptExportBtn"><i class="fas fa-download"></i> تصدير</button>
      <button class="btn btn-ghost btn-sm" onclick="window.print()"><i class="fas fa-print"></i> طباعة</button>
    </div>
  </div>

  <div class="tabs" id="rptTabs">
    <button class="tab-btn active" data-tab="overview">نظرة عامة</button>
    <button class="tab-btn" data-tab="sales">تقرير المبيعات</button>
    <button class="tab-btn" data-tab="inventory">تقرير المخزون</button>
    <button class="tab-btn" data-tab="profit">الأرباح والتكاليف</button>
    <button class="tab-btn" data-tab="stagnant">الأصناف الراكدة</button>
    <button class="tab-btn" data-tab="financial">المالي</button>
    <button class="tab-btn" data-tab="turnover">دوران المخزون</button>
    <button class="tab-btn" data-tab="stock_aging">أعمار مخزون الأجهزة</button>
    <button class="tab-btn" data-tab="supplier_prices">مقارنة الموردين</button>
    <button class="tab-btn" data-tab="debt_aging">أعمار الديون</button>
    <button class="tab-btn" data-tab="driver_perf">أداء السائقين</button>
    <button class="tab-btn" data-tab="customer_profit">ربحية العملاء</button>
  </div>

  <div id="rptContent">
    <div class="empty-state">
      <div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div>
      <h3 class="es-title">جارٍ تحميل التقارير...</h3>
    </div>
  </div>
</div>`;
  }

  async function afterRender() {
    document.getElementById('rptExportBtn')?.addEventListener('click', () => _exportFull());
    document.getElementById('rptTabs')?.addEventListener('click', e => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      _activeTab = btn.dataset.tab;
      document.querySelectorAll('#rptTabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _renderTab(_activeTab);
    });

    try {
      const [stats, monthly, topProducts, catDist, sales, products, low, profit] = await Promise.all([
        DB.getStats(), DB.getMonthlySales(), DB.getTopProducts(), DB.getCatDist(),
        DB.getSales(), DB.getProducts(), DB.getLowStock(),
        DB.getProfitReport(_profitPeriod),
      ]);
      _data        = { stats, monthly, topProducts, catDist, sales, products, low };
      _profitData  = profit;
      _renderTab('overview');
    } catch(e) {
      document.getElementById('rptContent').innerHTML =
        `<div class="alert err"><i class="fas fa-circle-xmark"></i> ${_esc(e.message)}</div>`;
    }
  }

  /* ════════════════════════════════════════════════════════
     RENDER TAB
  ════════════════════════════════════════════════════════ */
  async function _renderTab(tab) {
    const { stats, monthly, topProducts, catDist, sales, products, low } = _data;
    const today   = new Date().toISOString().split('T')[0];
    const month   = new Date().toISOString().slice(0, 7);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

    const completed = (sales || []).filter(s => s.status === 'مكتمل');
    const todaySls  = completed.filter(s => s.date === today);
    const weekSls   = completed.filter(s => s.date >= weekAgo);
    const monthSls  = completed.filter(s => s.date.startsWith(month));
    const payMap    = {};
    completed.forEach(s => { payMap[s.paymentMethod] = (payMap[s.paymentMethod] || 0) + s.total; });

    const content = document.getElementById('rptContent');
    if (!content) return;

    if(tab==='turnover'){
      const rows=await DB.getTurnoverReport(30);content.innerHTML=`<div class="card"><div class="card-head"><span class="card-title">معدل دوران المخزون — آخر 30 يومًا</span></div><div class="card-body p0"><div class="tbl-wrap"><table class="dtable"><thead><tr><th>الصنف</th><th>المباع</th><th>المخزون</th><th>المعدل</th><th>التصنيف</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${_esc(r.name)}</td><td>${Fmt.num(r.sold)}</td><td>${Fmt.num(r.stock)}</td><td>${Fmt.num(r.turnover_rate)}</td><td><span class="badge ${r.classification==='سريع'?'bdg-ok':r.classification==='راكد'?'bdg-err':'bdg-warn'}">${_esc(r.classification)}</span></td></tr>`).join('')}</tbody></table></div></div></div>`;return;
    }
    if(tab==='stock_aging'){
      const rep=await DB.getStockAgingReport();
      const b=rep.buckets, t=rep.totals, c=rep.count;
      const bucketDefs=[
        {key:'over90',label:'راكد أكثر من 90 يومًا',color:'var(--err)'},
        {key:'d90',label:'من 61 إلى 90 يومًا',color:'var(--amb-600)'},
        {key:'d60',label:'من 31 إلى 60 يومًا',color:'var(--warn)'},
        {key:'d30',label:'حتى 30 يومًا',color:'var(--ok)'},
      ];
      content.innerHTML=`
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;margin-bottom:1.2rem">
        ${bucketDefs.map(d=>`<div class="rpt-card"><div class="rpt-card-val" style="color:${d.color}">${Fmt.num(c[d.key]||0)}</div><div class="rpt-card-lbl">${d.label}</div><div style="font-size:.75rem;color:var(--tx-3);margin-top:.2rem">تكلفة مجمّدة: ${Fmt.money(t[d.key]||0)}</div></div>`).join('')}
      </div>
      <div class="tabs" id="expBucketTabs" style="margin-bottom:.8rem">
        ${bucketDefs.map((d,i)=>`<button class="tab-btn ${i===0?'active':''}" data-bk="${d.key}">${d.label} (${c[d.key]||0})</button>`).join('')}
      </div>
      <div class="card">
        <div class="card-head" style="justify-content:space-between">
          <span class="card-title"><i class="fas fa-hourglass-half"></i> الأجهزة المتاحة بالمخزون حسب مدة بقائها</span>
          <div style="display:flex;gap:.4rem">
            ${_excelExportBtn('stock_aging')}
            <button class="btn btn-ghost btn-sm" id="expExportBtn"><i class="fas fa-download"></i> تصدير CSV</button>
          </div>
        </div>
        <div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
          <thead><tr><th>الجهاز</th><th>الفئة</th><th>IMEI / Serial</th><th>تاريخ الاستلام</th><th>الأيام بالمخزون</th><th>التكلفة</th><th>سعر البيع</th></tr></thead>
          <tbody id="expTbody"></tbody>
        </table></div></div>
      </div>`;
      let curBk='over90';
      const renderBucket=()=>{
        const rows=b[curBk]||[];
        document.getElementById('expTbody').innerHTML = rows.length ? rows.map(r=>`<tr>
          <td class="font-bold">${_esc(r.name)}${r.variant?`<small style="display:block;color:var(--tx-3)">${_esc(r.variant)}</small>`:''}</td><td>${_esc(r.category)}</td><td dir="ltr" style="text-align:right">${_esc(r.serial)}</td>
          <td>${r.received_date?Fmt.dateShort(r.received_date):'—'}</td>
          <td style="font-weight:700;color:${r.age_days>90?'var(--err)':r.age_days>60?'var(--amb-600)':r.age_days>30?'var(--warn)':'var(--ok)'}">${r.age_days} يوم</td>
          <td>${Fmt.money(r.cost)}</td><td>${Fmt.money(r.price)}</td>
        </tr>`).join('') : '<tr><td colspan="7"><div class="empty-state"><div class="es-icon"><i class="fas fa-circle-check"></i></div><h3 class="es-title">لا توجد أجهزة في هذه الشريحة</h3></div></td></tr>';
      };
      renderBucket();
      document.getElementById('expBucketTabs')?.addEventListener('click', e=>{
        const btn=e.target.closest('.tab-btn'); if(!btn) return;
        curBk=btn.dataset.bk;
        document.querySelectorAll('#expBucketTabs .tab-btn').forEach(x=>x.classList.remove('active'));
        btn.classList.add('active');
        renderBucket();
      });
      document.getElementById('expExportBtn')?.addEventListener('click', ()=>{
        const all=[...b.over90,...b.d90,...b.d60,...b.d30];
        exportCSV('أعمار_مخزون_الأجهزة',
          ['الجهاز','الفئة','IMEI','تاريخ الاستلام','الأيام بالمخزون','التكلفة','سعر البيع'],
          all.map(r=>[r.name,r.category,r.serial,r.received_date||'',r.age_days,r.cost,r.price])
        );
      });
      _wireExcelButtons(content);
      return;
    }
    if(tab==='supplier_prices'){
      const rows=await DB.getSupplierPriceComparison();
      content.innerHTML=`
      <div class="card" style="margin-bottom:1rem">
        <div class="card-body" style="padding:.75rem 1rem;display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap">
          <input type="text" class="form-control" id="spSearch" placeholder="ابحث عن صنف..." style="max-width:320px">
          ${_excelExportBtn('supplier_prices')}
        </div>
      </div>
      <div id="spList">${rows.length?'':'<div class="empty-state"><div class="es-icon"><i class="fas fa-truck-fast"></i></div><h3 class="es-title">لا توجد بيانات أسعار موردين بعد</h3><p class="es-desc">تظهر البيانات بعد استلام أوامر شراء من أكثر من مورد لنفس الصنف</p></div>'}</div>`;
      const renderList=(filter='')=>{
        const f=filter.trim().toLowerCase();
        const filtered=rows.filter(r=>!f||r.product_name?.toLowerCase().includes(f));
        document.getElementById('spList').innerHTML = filtered.map(item=>`
          <div class="card" style="margin-bottom:.9rem">
            <div class="card-head"><span class="card-title">${_esc(item.product_name)}</span></div>
            <div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
              <thead><tr><th>المورد</th><th>آخر سعر شراء</th><th>أفضل سعر مسجل</th><th>تاريخ آخر توريد</th><th>عدد الأوامر</th><th></th></tr></thead>
              <tbody>${item.suppliers.map(s=>`<tr ${s.is_best?'style="background:var(--ok-50,#f0fdf4)"':''}>
                <td class="font-bold">${_esc(s.supplier_name||'—')}</td>
                <td>${Fmt.money(s.last_price)}</td>
                <td>${Fmt.money(s.best_price)}</td>
                <td>${Fmt.dateShort(s.last_date)}</td>
                <td>${Fmt.num(s.orders_count)}</td>
                <td>${s.is_best?'<span class="badge bdg-ok"><i class="fas fa-star"></i> الأفضل سعرًا</span>':''}</td>
              </tr>`).join('')}</tbody>
            </table></div></div>
          </div>`).join('') || (filtered.length===0 && rows.length ? '<div class="empty-state"><h3 class="es-title">لا نتائج مطابقة</h3></div>' : '');
      };
      renderList();
      document.getElementById('spSearch')?.addEventListener('input', e=>renderList(e.target.value));
      _wireExcelButtons(content);
      return;
    }

    if(tab==='debt_aging'){
      const rep=await DB.getDebtAgingReport();
      const {customers,totals}=rep;
      content.innerHTML=`
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:1rem;margin-bottom:1.2rem">
        <div class="rpt-card"><div class="rpt-card-val">${Fmt.money(totals.b0_30||0)}</div><div class="rpt-card-lbl">0-30 يوم</div></div>
        <div class="rpt-card"><div class="rpt-card-val" style="color:var(--warn)">${Fmt.money(totals.b31_60||0)}</div><div class="rpt-card-lbl">31-60 يوم</div></div>
        <div class="rpt-card"><div class="rpt-card-val" style="color:var(--err)">${Fmt.money(totals.b61_90||0)}</div><div class="rpt-card-lbl">61-90 يوم</div></div>
        <div class="rpt-card"><div class="rpt-card-val" style="color:var(--err)">${Fmt.money(totals.b90_plus||0)}</div><div class="rpt-card-lbl">أكثر من 90 يوم</div></div>
        <div class="rpt-card"><div class="rpt-card-val" style="color:var(--teal-600)">${Fmt.money(totals.total||0)}</div><div class="rpt-card-lbl">إجمالي المستحق</div></div>
      </div>
      <div class="card"><div class="card-head" style="justify-content:flex-end">${_excelExportBtn('debt_aging')}</div><div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
        <thead><tr><th>العميل</th><th>النوع</th><th>0-30</th><th>31-60</th><th>61-90</th><th>+90</th><th>الإجمالي</th><th>سقف الائتمان</th></tr></thead>
        <tbody>${customers.length?customers.map(c=>{
          const overLimit = c.customer_type==='جملة' && c.credit_limit>0 && c.total>c.credit_limit;
          return `<tr>
          <td class="font-bold">${_esc(c.customer_name)} ${overLimit?'<span class="badge bdg-err" style="font-size:.62rem">تجاوز السقف</span>':''}</td>
          <td>${c.customer_type==='جملة'?'<span class="badge bdg-amb">جملة</span>':'فرد'}</td>
          <td>${c.b0_30?Fmt.money(c.b0_30):'—'}</td>
          <td style="color:var(--warn)">${c.b31_60?Fmt.money(c.b31_60):'—'}</td>
          <td style="color:var(--err)">${c.b61_90?Fmt.money(c.b61_90):'—'}</td>
          <td style="color:var(--err);font-weight:700">${c.b90_plus?Fmt.money(c.b90_plus):'—'}</td>
          <td style="font-weight:700">${Fmt.money(c.total)}</td>
          <td>${c.credit_limit>0?Fmt.money(c.credit_limit):'بدون حد'}</td>
        </tr>`;}).join(''):'<tr><td colspan="8"><div class="empty-state"><div class="es-icon" style="color:var(--ok)"><i class="fas fa-circle-check"></i></div><h3 class="es-title">لا توجد ديون مستحقة</h3></div></td></tr>'}</tbody>
      </table></div></div></div>`;
      _wireExcelButtons(content);
      return;
    }

    if(tab==='driver_perf'){
      const rows=await DB.getDriverPerformanceReport();
      content.innerHTML=`<div class="card"><div class="card-head" style="justify-content:flex-end">${_excelExportBtn('driver_performance')}</div><div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
        <thead><tr><th>السائق</th><th>إجمالي التوقفات</th><th>تم التسليم</th><th>مرتجع</th><th>مشكلة</th><th>قيد الانتظار</th><th>نسبة النجاح</th><th>إجمالي المحصّل</th></tr></thead>
        <tbody>${rows.length?rows.map(r=>`<tr>
          <td class="font-bold">${_esc(r.driver_name)}</td>
          <td>${Fmt.num(r.total_stops)}</td>
          <td style="color:var(--ok)">${Fmt.num(r.delivered)}</td>
          <td style="color:var(--err)">${Fmt.num(r.returned)}</td>
          <td style="color:var(--warn)">${Fmt.num(r.problem)}</td>
          <td>${Fmt.num(r.pending)}</td>
          <td><span class="badge ${r.success_rate>=80?'bdg-ok':r.success_rate>=50?'bdg-warn':'bdg-err'}">${r.success_rate}%</span></td>
          <td style="color:var(--teal-600);font-weight:700">${Fmt.money(r.total_collected)}</td>
        </tr>`).join(''):'<tr><td colspan="8"><div class="empty-state"><h3 class="es-title">لا توجد بيانات توصيل بعد</h3></div></td></tr>'}</tbody>
      </table></div></div></div>`;
      _wireExcelButtons(content);
      return;
    }

    if(tab==='customer_profit'){
      const rows=await DB.getCustomerProfitabilityReport();
      content.innerHTML=`<div class="card"><div class="card-head" style="justify-content:flex-end">${_excelExportBtn('customer_profitability')}</div><div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
        <thead><tr><th>العميل</th><th>النوع</th><th>عدد الفواتير</th><th>الإيراد</th><th>تكلفة البضاعة</th><th>هامش الربح</th><th>نسبة الهامش</th></tr></thead>
        <tbody>${rows.length?rows.map(r=>`<tr>
          <td class="font-bold">${_esc(r.customer_name)}</td>
          <td>${r.customer_type==='جملة'?'<span class="badge bdg-amb">جملة</span>':'فرد'}</td>
          <td>${Fmt.num(r.orders_count)}</td>
          <td>${Fmt.money(r.revenue)}</td>
          <td style="color:var(--tx-3)">${Fmt.money(r.cogs)}</td>
          <td style="font-weight:700;color:${r.profit>=0?'var(--teal-600)':'var(--err)'}">${Fmt.money(r.profit)}</td>
          <td><span class="badge ${r.margin_pct>=30?'bdg-ok':r.margin_pct>=10?'bdg-warn':'bdg-err'}">${r.margin_pct}%</span></td>
        </tr>`).join(''):'<tr><td colspan="7"><div class="empty-state"><h3 class="es-title">لا توجد بيانات مبيعات لعملاء بعد</h3></div></td></tr>'}</tbody>
      </table></div></div></div>`;
      _wireExcelButtons(content);
      return;
    }

    /* ── نظرة عامة ─────────────────────────────────────── */
    if (tab === 'overview') {
      content.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem">
        <div class="rpt-card"><div class="rpt-card-val" style="color:var(--teal-600)">${Fmt.money(todaySls.reduce((a, s) => a + s.total, 0))}</div><div class="rpt-card-lbl">إيرادات اليوم</div><div class="rpt-card-sub">${todaySls.length} عملية</div></div>
        <div class="rpt-card"><div class="rpt-card-val" style="color:var(--amb-600)">${Fmt.money(weekSls.reduce((a, s) => a + s.total, 0))}</div><div class="rpt-card-lbl">إيرادات الأسبوع</div><div class="rpt-card-sub">${weekSls.length} عملية</div></div>
        <div class="rpt-card"><div class="rpt-card-val" style="color:var(--ok)">${Fmt.money(monthSls.reduce((a, s) => a + s.total, 0))}</div><div class="rpt-card-lbl">إيرادات الشهر</div><div class="rpt-card-sub">${monthSls.length} عملية</div></div>
        <div class="rpt-card"><div class="rpt-card-val">${Fmt.money(stats.totalRevenue)}</div><div class="rpt-card-lbl">إجمالي الإيرادات</div><div class="rpt-card-sub">${stats.totalSales} فاتورة</div></div>
      </div>
      <div class="g2">
        <div class="card">
          <div class="card-head"><span class="card-title"><i class="fas fa-chart-bar"></i> الإيرادات الشهرية</span></div>
          <div class="card-body"><div class="bar-chart tall" id="rptMonthly"></div></div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title"><i class="fas fa-credit-card"></i> طرق الدفع</span></div>
          <div class="card-body"><div id="rptPayDonut"></div></div>
        </div>
      </div>
      <div class="card" style="margin-top:1.2rem">
        <div class="card-head"><span class="card-title"><i class="fas fa-trophy"></i> أكثر الأصناف مبيعاً</span></div>
        <div class="card-body">
          ${(topProducts || []).map((m, i) => {
            const max = topProducts[0]?.qty || 1;
            return `<div style="display:flex;align-items:center;gap:1rem;margin-bottom:.75rem">
              <span style="min-width:24px;font-weight:700;color:var(--tx-3)">${i + 1}</span>
              <span style="flex:1;font-weight:600">${_esc(m.name)}</span>
              <div style="flex:2"><div class="progress" style="height:9px">
                <div class="progress-fill" style="width:${Math.round(m.qty / max * 100)}%;background:${['var(--teal-500)', 'var(--amb-400)', 'var(--ok)', 'var(--sl-400)', 'var(--sl-300)'][i]}"></div>
              </div></div>
              <span style="min-width:50px;text-align:left;font-size:.8rem;color:var(--tx-3)">${Fmt.num(m.qty)}</span>
              <span style="min-width:90px;text-align:left;font-weight:700;color:var(--teal-600)">${Fmt.money(m.revenue)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>`;
      requestAnimationFrame(() => {
        renderBarChart('rptMonthly', monthly.labels.map(l => l.slice(0, 3)), monthly.values, 'var(--teal-500)');
        renderDonut('rptPayDonut',
          Object.entries(payMap).map(([label, value]) => ({ label, value: Math.round(value) })),
          completed.length, 'فاتورة');
      });

    /* ── تقرير المبيعات ─────────────────────────────────── */
    } else if (tab === 'sales') {
      content.innerHTML = `
      <div class="card">
        <div class="card-head"><span class="card-title"><i class="fas fa-receipt"></i> سجل المبيعات</span>
          <button class="btn btn-ghost btn-sm" id="expSalesBtn"><i class="fas fa-download"></i> تصدير</button></div>
        <div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
          <thead><tr><th>الفاتورة</th><th>التاريخ</th><th>العميل</th><th>أصناف</th><th>الخصم</th><th>الضريبة</th><th>الإجمالي</th><th>الدفع</th><th>الحالة</th></tr></thead>
          <tbody>${(sales || []).map(s => `<tr style="${s.status === 'ملغاة' ? 'opacity:.55' : ''}">
            <td><strong>${_esc(s.invoiceNum)}</strong></td>
            <td>${Fmt.dateShort(s.date)} ${_esc(s.time)}</td>
            <td>${_esc(s.customerName)}</td>
            <td>${(s.items || []).length}</td>
            <td>${s.discount > 0 ? Fmt.money(s.discount) : '—'}</td>
            <td>${Fmt.money(s.tax)}</td>
            <td style="font-weight:700;color:var(--teal-600)">${Fmt.money(s.total)}</td>
            <td><span class="badge bdg-teal">${_esc(s.paymentMethod)}</span></td>
            <td><span class="badge ${s.status === 'ملغاة' ? 'bdg-err' : 'bdg-ok'}">${_esc(s.status)}</span></td>
          </tr>`).join('')}</tbody>
        </table></div></div>
      </div>`;
      document.getElementById('expSalesBtn')?.addEventListener('click', () => _exportFull());

    /* ── تقرير المخزون ─────────────────────────────────── */
    } else if (tab === 'inventory') {
      const totSell = products.reduce((a, m) => a + (m.price * m.stock), 0);
      const totCost = products.reduce((a, m) => a + (m.cost * m.stock), 0);
      content.innerHTML = `
      <div class="g2" style="margin-bottom:1.2rem">
        <div class="card">
          <div class="card-head"><span class="card-title"><i class="fas fa-layer-group"></i> توزيع الأصناف</span></div>
          <div class="card-body"><div id="rptCatDonut"></div></div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title"><i class="fas fa-boxes-stacked"></i> ملخص المخزون</span></div>
          <div class="card-body">
            <div class="detail-row"><span class="dr-label">إجمالي الأصناف</span><span class="dr-val">${products.length}</span></div>
            <div class="detail-row"><span class="dr-label">قيمة المخزون (بيع)</span><span class="dr-val" style="color:var(--ok)">${Fmt.money(totSell)}</span></div>
            <div class="detail-row"><span class="dr-label">قيمة المخزون (تكلفة)</span><span class="dr-val" style="color:var(--teal-600)">${Fmt.money(totCost)}</span></div>
            <div class="detail-row"><span class="dr-label">الربح المتوقع</span><span class="dr-val" style="color:var(--amb-600)">${Fmt.money(totSell - totCost)}</span></div>
            <div class="detail-row"><span class="dr-label">مخزون منخفض</span><span class="dr-val" style="color:var(--err)">${low.length} صنف</span></div>
          </div>
        </div>
      </div>
      ${low.length ? `<div class="card">
        <div class="card-head"><span class="card-title" style="color:var(--warn)"><i class="fas fa-triangle-exclamation"></i> مخزون منخفض</span></div>
        <div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
          <thead><tr><th>الصنف</th><th>الفئة</th><th>المخزون</th><th>الحد الأدنى</th><th>الحالة</th></tr></thead>
          <tbody>${low.map(m => `<tr>
            <td class="font-bold">${_esc(m.name)}</td><td>${_esc(m.category)}</td>
            <td style="color:${m.stock === 0 ? 'var(--err)' : 'var(--warn)'};font-weight:700">${Fmt.num(m.stock)} ${_esc(m.unit)}</td>
            <td>${m.minStock}</td>
            <td>${m.stock === 0 ? '<span class="badge bdg-err">نفد</span>' : '<span class="badge bdg-warn">منخفض</span>'}</td>
          </tr>`).join('')}</tbody>
        </table></div></div>
      </div>` : ''}`;
      requestAnimationFrame(() => {
        renderDonut('rptCatDonut', catDist.slice(0, 6).map(c => ({ label: c.cat, value: c.count })), products.length, 'صنف');
      });

    /* ── تقرير الأرباح والتكاليف ────────────────────────── */
    } else if (tab === 'profit') {
      const p = _profitData || { revenue: 0, cost: 0, profit: 0, margin_pct: 0, by_product: [] };
      const marginColor = p.margin_pct >= 20 ? 'var(--ok)' : p.margin_pct >= 10 ? 'var(--warn)' : 'var(--err)';

      content.innerHTML = `
      <!-- فلتر الفترة -->
      <div class="card" style="margin-bottom:1rem">
        <div class="card-body" style="padding:.75rem 1rem">
          <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
            <span style="font-size:.8rem;font-weight:700;color:var(--tx-2)">الفترة الزمنية:</span>
            <div class="tabs" id="profitPeriodTabs" style="margin:0">
              ${[['today','اليوم'],['month','الشهر'],['year','السنة'],['all','الكل']].map(([v,l]) =>
                `<button class="tab-btn ${_profitPeriod === v ? 'active' : ''}" data-period="${v}">${l}</button>`
              ).join('')}
            </div>
            <span id="profitLoading" style="display:none;font-size:.8rem;color:var(--tx-3)"><i class="fas fa-circle-notch fa-spin"></i> جارٍ التحديث...</span>
          </div>
        </div>
      </div>

      <!-- بطاقات الملخص -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem">
        <div class="rpt-card">
          <div class="rpt-card-val" style="color:var(--teal-600)">${Fmt.money(p.revenue)}</div>
          <div class="rpt-card-lbl">إجمالي الإيرادات</div>
        </div>
        <div class="rpt-card">
          <div class="rpt-card-val" style="color:var(--err)">${Fmt.money(p.cost)}</div>
          <div class="rpt-card-lbl">إجمالي التكاليف</div>
        </div>
        <div class="rpt-card">
          <div class="rpt-card-val" style="color:${p.profit >= 0 ? 'var(--ok)' : 'var(--err)'}">${Fmt.money(p.profit)}</div>
          <div class="rpt-card-lbl">صافي الربح</div>
        </div>
        <div class="rpt-card">
          <div class="rpt-card-val" style="color:${marginColor}">${p.margin_pct}%</div>
          <div class="rpt-card-lbl">هامش الربح</div>
        </div>
      </div>

      <!-- شريط الربح البصري -->
      <div class="card" style="margin-bottom:1.2rem">
        <div class="card-head"><span class="card-title"><i class="fas fa-chart-pie"></i> توزيع الإيرادات</span></div>
        <div class="card-body">
          ${p.revenue > 0 ? `
          <div style="margin-bottom:.6rem;font-size:.8rem;color:var(--tx-2)">
            <span style="color:var(--teal-600);font-weight:700">الإيرادات ${Fmt.money(p.revenue)}</span>
            = <span style="color:var(--err)">تكاليف ${Fmt.money(p.cost)}</span>
            + <span style="color:var(--ok)">ربح ${Fmt.money(p.profit)}</span>
          </div>
          <div style="display:flex;height:20px;border-radius:8px;overflow:hidden;gap:2px">
            <div style="width:${Math.round(p.cost/p.revenue*100)}%;background:var(--err);opacity:.7" title="التكاليف ${Math.round(p.cost/p.revenue*100)}%"></div>
            <div style="flex:1;background:var(--ok);opacity:.85" title="الربح ${p.margin_pct}%"></div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:.35rem;font-size:.7rem;color:var(--tx-3)">
            <span>تكاليف ${Math.round(p.cost/p.revenue*100)}%</span>
            <span>ربح ${p.margin_pct}%</span>
          </div>` : '<p style="color:var(--tx-3);font-size:.85rem">لا توجد بيانات للفترة المحددة</p>'}
        </div>
      </div>

      <!-- تفاصيل per-product -->
      ${(p.by_product || []).length ? `
      <div class="card">
        <div class="card-head">
          <span class="card-title"><i class="fas fa-pills"></i> ربحية كل صنف</span>
          <button class="btn btn-ghost btn-sm" id="exportProfitBtn"><i class="fas fa-download"></i> تصدير</button>
        </div>
        <div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
          <thead><tr>
            <th>الصنف</th><th>الكمية المباعة</th><th>الإيرادات</th><th>التكاليف</th><th>الربح</th><th>الهامش</th>
          </tr></thead>
          <tbody>${p.by_product.map(m => {
            const mColor = m.margin_pct >= 20 ? 'var(--ok)' : m.margin_pct >= 10 ? 'var(--warn)' : 'var(--err)';
            return `<tr>
              <td class="font-bold">${_esc(m.name)}</td>
              <td>${Fmt.num(m.qty_sold)}</td>
              <td style="color:var(--teal-600);font-weight:700">${Fmt.money(m.revenue)}</td>
              <td style="color:var(--err)">${Fmt.money(m.total_cost)}</td>
              <td style="color:${m.profit >= 0 ? 'var(--ok)' : 'var(--err)'};font-weight:700">${Fmt.money(m.profit)}</td>
              <td><span class="badge" style="background:${mColor}20;color:${mColor}">${m.margin_pct}%</span></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div></div>
      </div>` : ''}`;

      // فلتر الفترة
      document.getElementById('profitPeriodTabs')?.addEventListener('click', async e => {
        const btn = e.target.closest('[data-period]');
        if (!btn) return;
        _profitPeriod = btn.dataset.period;
        const loading = document.getElementById('profitLoading');
        if (loading) loading.style.display = 'inline';
        try {
          _profitData = await DB.getProfitReport(_profitPeriod);
          _renderTab('profit');
        } catch(err) {
          Toast.err('خطأ', err.message);
          if (loading) loading.style.display = 'none';
        }
      });

      document.getElementById('exportProfitBtn')?.addEventListener('click', () => {
        exportCSV('تقرير_الأرباح',
          ['الصنف', 'الكمية المباعة', 'الإيرادات', 'التكاليف', 'الربح', 'الهامش %'],
          ((_profitData || {}).by_product || []).map(m =>
            [m.name, m.qty_sold, m.revenue, m.total_cost, m.profit, m.margin_pct])
        );
      });

    /* ── الأصناف الراكدة ────────────────────────────────── */
    } else if (tab === 'stagnant') {
      const { products, sales } = _data;

      // حساب الأصناف التي لم تُباع خلال آخر 90 يوم
      const cutoff90  = new Date(Date.now() - 90  * 86400000).toISOString().split('T')[0];
      const cutoff180 = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0];

      // بناء map لآخر تاريخ بيع لكل صنف
      const lastSaleMap = {};
      (sales || []).forEach(s => {
        if (s.status !== 'مكتمل') return;
        (s.items || []).forEach(item => {
          if (!lastSaleMap[item.name] || s.date > lastSaleMap[item.name]) {
            lastSaleMap[item.name] = s.date;
          }
        });
      });

      const stagnant = products
        .filter(m => m.stock > 0)
        .map(m => ({
          ...m,
          lastSale: lastSaleMap[m.name] || null,
          daysSince: lastSaleMap[m.name]
            ? Math.floor((Date.now() - new Date(lastSaleMap[m.name])) / 86400000)
            : 999,
        }))
        .filter(m => !lastSaleMap[m.name] || m.lastSale < cutoff90)
        .sort((a, b) => b.daysSince - a.daysSince);

      const very   = stagnant.filter(m => m.daysSince >= 180);
      const medium = stagnant.filter(m => m.daysSince >= 90 && m.daysSince < 180);
      const totalValue = stagnant.reduce((a, m) => a + m.cost * m.stock, 0);

      content.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem">
        <div class="rpt-card">
          <div class="rpt-card-val" style="color:var(--err)">${stagnant.length}</div>
          <div class="rpt-card-lbl">أصناف راكدة (+90 يوم)</div>
        </div>
        <div class="rpt-card">
          <div class="rpt-card-val" style="color:var(--err)">${very.length}</div>
          <div class="rpt-card-lbl">راكدة جداً (+180 يوم)</div>
        </div>
        <div class="rpt-card">
          <div class="rpt-card-val" style="color:var(--warn)">${medium.length}</div>
          <div class="rpt-card-lbl">راكدة (90-180 يوم)</div>
        </div>
        <div class="rpt-card">
          <div class="rpt-card-val" style="color:var(--err);font-size:1.1rem">${Fmt.money(totalValue)}</div>
          <div class="rpt-card-lbl">قيمة المخزون الراكد</div>
        </div>
      </div>

      ${stagnant.length === 0 ? `
        <div class="card"><div class="card-body">
          <div class="empty-state">
            <div class="es-icon" style="color:var(--ok)"><i class="fas fa-check-circle"></i></div>
            <h3 class="es-title">ممتاز — لا توجد أصناف راكدة</h3>
            <p class="es-sub">جميع الأصناف تتحرك بشكل منتظم خلال آخر 90 يوماً</p>
          </div>
        </div></div>` : `
      <div class="alert warn" style="margin-bottom:1rem">
        <i class="fas fa-triangle-exclamation"></i>
        <div><strong>تنبيه:</strong> هذه الأصناف لم تُباع منذ أكثر من 90 يوماً وتُمثّل رأس مال مجمّد. يُنصح بمراجعة سياسة الشراء وخفض أسعارها أو إعادتها للمورد.</div>
      </div>
      <div class="card">
        <div class="card-head">
          <span class="card-title"><i class="fas fa-box-archive"></i> قائمة الأصناف الراكدة</span>
          <button class="btn btn-ghost btn-sm" id="exportStagnantBtn"><i class="fas fa-download"></i> تصدير</button>
        </div>
        <div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
          <thead><tr>
            <th>الصنف</th><th>الفئة</th><th>المخزون</th><th>قيمة التكلفة</th><th>آخر بيع</th><th>أيام الركود</th><th>الحالة</th>
          </tr></thead>
          <tbody>${stagnant.map(m => {
            const isVery = m.daysSince >= 180;
            const neverSold = !m.lastSale;
            return `<tr>
              <td class="font-bold">${_esc(m.name)}</td>
              <td>${_esc(m.category)}</td>
              <td>${Fmt.num(m.stock)} ${_esc(m.unit)}</td>
              <td style="color:var(--err)">${Fmt.money(m.cost * m.stock)}</td>
              <td style="color:var(--tx-3)">${neverSold ? 'لم يُباع قط' : Fmt.dateShort(m.lastSale)}</td>
              <td style="font-weight:700;color:${isVery ? 'var(--err)' : 'var(--warn)'}">
                ${neverSold ? '∞' : m.daysSince + ' يوم'}
              </td>
              <td>
                <span class="badge ${isVery ? 'bdg-err' : 'bdg-warn'}">
                  ${neverSold ? 'لم يُباع قط' : isVery ? 'راكد جداً' : 'راكد'}
                </span>
              </td>
            </tr>`;
          }).join('')}</tbody>
        </table></div></div>
      </div>`}`;

      document.getElementById('exportStagnantBtn')?.addEventListener('click', () => {
        exportCSV('الأصناف_الراكدة',
          ['الصنف', 'الفئة', 'المخزون', 'الوحدة', 'التكلفة للوحدة', 'قيمة المخزون', 'آخر بيع', 'أيام الركود'],
          stagnant.map(m => [m.name, m.category, m.stock, m.unit, m.cost, m.cost * m.stock, m.lastSale || 'لم يُباع', m.daysSince === 999 ? 'لم يُباع قط' : m.daysSince])
        );
      });

    /* ── التقرير المالي ─────────────────────────────────── */
    } else if (tab === 'financial') {
      const totTax  = completed.reduce((a, s) => a + s.tax, 0);
      const totDisc = completed.reduce((a, s) => a + s.discount, 0);
      content.innerHTML = `
      <div class="g3" style="margin-bottom:1.2rem">
        <div class="rpt-card"><div class="rpt-card-val" style="color:var(--teal-600)">${Fmt.money(stats.totalRevenue)}</div><div class="rpt-card-lbl">إجمالي الإيرادات</div></div>
        <div class="rpt-card"><div class="rpt-card-val" style="color:var(--err)">${Fmt.money(totTax)}</div><div class="rpt-card-lbl">الضرائب المحصلة</div></div>
        <div class="rpt-card"><div class="rpt-card-val" style="color:var(--ok)">${Fmt.money(totDisc)}</div><div class="rpt-card-lbl">إجمالي الخصومات</div></div>
      </div>
      <div class="g2">
        <div class="card">
          <div class="card-head"><span class="card-title"><i class="fas fa-coins"></i> توزيع الإيرادات حسب الدفع</span></div>
          <div class="card-body">
            ${Object.entries(payMap).map(([method, amt]) => {
              const pct = Math.round(amt / (stats.totalRevenue || 1) * 100);
              return `<div style="margin-bottom:.85rem">
                <div style="display:flex;justify-content:space-between;margin-bottom:.3rem;font-size:.84rem">
                  <span class="font-bold">${method}</span>
                  <span style="color:var(--teal-600);font-weight:700">${Fmt.money(amt)} (${pct}%)</span>
                </div>
                <div class="progress"><div class="progress-fill" style="width:${pct}%;background:var(--teal-400)"></div></div>
              </div>`;
            }).join('')}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title"><i class="fas fa-calendar-days"></i> أداء اليوم</span></div>
          <div class="card-body">
            <div class="detail-row"><span class="dr-label">عدد الفواتير</span><span class="dr-val">${todaySls.length}</span></div>
            <div class="detail-row"><span class="dr-label">الإيرادات</span><span class="dr-val" style="color:var(--teal-600)">${Fmt.money(todaySls.reduce((a, s) => a + s.total, 0))}</span></div>
            <div class="detail-row"><span class="dr-label">متوسط الفاتورة</span><span class="dr-val">${Fmt.money(todaySls.reduce((a, s) => a + s.total, 0) / Math.max(todaySls.length, 1))}</span></div>
            <div class="detail-row"><span class="dr-label">الضرائب</span><span class="dr-val">${Fmt.money(todaySls.reduce((a, s) => a + s.tax, 0))}</span></div>
            <div class="detail-row"><span class="dr-label">الخصومات</span><span class="dr-val">${Fmt.money(todaySls.reduce((a, s) => a + s.discount, 0))}</span></div>
          </div>
        </div>
      </div>`;
    }
  }

  function _exportFull() {
    exportCSV('التقرير_الشامل',
      ['الفاتورة', 'التاريخ', 'العميل', 'المجموع', 'الخصم', 'الضريبة', 'الإجمالي', 'الدفع', 'الحالة'],
      ((_data.sales) || []).map(s => [s.invoiceNum, s.date, s.customerName, s.subtotal, s.discount, s.tax, s.total, s.paymentMethod, s.status])
    );
  }

  return { render, afterRender };
})();
