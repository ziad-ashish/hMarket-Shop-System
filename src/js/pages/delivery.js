/* ════════════════════════════════════════════════════════════
   PAGE: DELIVERY — الشحن والتوزيع
   • رحلات توزيع تضم عدة فواتير لنفس العميل، مع سائق وسيارة
   • باركود تتبع لكل توقف حتى إتمام التسليم (دفع مسبق أو عند التسليم)
   • تسوية المديونية تلقائيًا عند تحصيل الدفع عند التسليم
   • إدارة السائقين والسيارات
════════════════════════════════════════════════════════════ */
'use strict';

const DeliveryPage = (() => {
  let _tab = 'trips';
  let _trips = [], _drivers = [], _vehicles = [], _stats = {}, _recurringRoutes = [];

  /* إدارة الأسطول (سائقين/سيارات/رحلات دورية) صلاحية محصورة على مدير النظام
     ومشرف المحل؛ البائع يقدر ينفّذ التوصيل يوميًا بس مش يعدّل
     إعدادات الأسطول. هذا للعرض فقط — الحماية الحقيقية على الخادم. */
  const canManageFleet = () => ['مدير النظام', 'مشرف المحل'].includes(Auth.getCurrent()?.role);

  function render() {
    return `
<div class="page active" id="page-delivery">
  <div class="pg-header">
    <div class="pg-title-group">
      <h1 class="pg-title">
        <div class="pg-title-icon" style="background:#e0f2fe;color:#0369a1"><i class="fas fa-truck-fast"></i></div>
        الشحن والتوزيع
      </h1>
      <p class="pg-subtitle">رحلات التوصيل، السائقون، السيارات، وتتبع الشحنات بالباركود</p>
    </div>
    <div class="pg-actions">
      <button class="btn btn-primary" id="dlvNewTripBtn"><i class="fas fa-route"></i> رحلة جديدة</button>
    </div>
  </div>

  <div class="stats-grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr));margin-bottom:1.2rem" id="dlvStats"></div>

  <div class="tabs" id="dlvTabs" style="margin-bottom:1rem">
    <button class="tab-btn active" data-tab="trips"><i class="fas fa-route"></i> الرحلات</button>
    <button class="tab-btn" data-tab="recurring"><i class="fas fa-repeat"></i> رحلات دورية</button>
    <button class="tab-btn" data-tab="scan"><i class="fas fa-barcode"></i> مسح باركود</button>
    <button class="tab-btn" data-tab="drivers"><i class="fas fa-id-card"></i> السائقون</button>
    <button class="tab-btn" data-tab="vehicles"><i class="fas fa-truck"></i> السيارات</button>
  </div>

  <div id="dlvContent">
    <div class="empty-state"><div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div><h3 class="es-title">جارٍ التحميل...</h3></div>
  </div>
</div>`;
  }

  async function afterRender() {
    document.getElementById('dlvNewTripBtn')?.addEventListener('click', openNewTrip);
    document.getElementById('dlvTabs')?.addEventListener('click', e => {
      const btn = e.target.closest('.tab-btn'); if (!btn) return;
      _tab = btn.dataset.tab;
      document.querySelectorAll('#dlvTabs .tab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderTab();
    });
    await _loadAll();
    renderTab();
  }

  async function _loadAll() {
    try {
      const [trips, drivers, vehicles, stats, recurring] = await Promise.all([
        DB.getDeliveryTrips(), DB.getDrivers(), DB.getVehicles(), DB.getDeliveryStats(), DB.getRecurringRoutes()
      ]);
      _trips = trips || []; _drivers = drivers || []; _vehicles = vehicles || []; _stats = stats || {};
      _recurringRoutes = recurring || [];
      _renderStats();
    } catch (e) { Toast.err('خطأ', e.message); }
  }

  function _renderStats() {
    const el = document.getElementById('dlvStats'); if (!el) return;
    const cards = [
      { label: 'قيد التجهيز', val: _stats.preparing || 0, color: 'var(--tx-3)' },
      { label: 'في الطريق', val: _stats.on_road || 0, color: 'var(--amb-600)' },
      { label: 'توقفات معلّقة', val: _stats.pending_stops || 0, color: 'var(--warn)' },
      { label: 'مشاكل تسليم', val: _stats.problem_stops || 0, color: 'var(--err)' },
      { label: 'مبلغ قيد التحصيل', val: Fmt.money(_stats.amount_in_transit || 0), color: 'var(--teal-600)' },
    ];
    el.innerHTML = cards.map(c => `<div class="rpt-card"><div class="rpt-card-val" style="color:${c.color}">${c.val}</div><div class="rpt-card-lbl">${c.label}</div></div>`).join('');
  }

  function renderTab() {
    const el = document.getElementById('dlvContent'); if (!el) return;
    if (_tab === 'trips') return _renderTrips(el);
    if (_tab === 'recurring') return _renderRecurring(el);
    if (_tab === 'scan') return _renderScan(el);
    if (_tab === 'drivers') return _renderDrivers(el);
    if (_tab === 'vehicles') return _renderVehicles(el);
  }

  /* ═══════════════ TRIPS ═══════════════ */
  const STATUS_BADGE = {
    'قيد التجهيز': 'bdg-slate', 'في الطريق': 'bdg-amb', 'مكتملة': 'bdg-ok', 'ملغاة': 'bdg-err',
  };

  function _renderTrips(el) {
    if (!_trips.length) {
      el.innerHTML = `<div class="empty-state">
        <div class="es-icon"><i class="fas fa-route"></i></div>
        <h3 class="es-title">لا توجد رحلات توزيع بعد</h3>
        <button class="btn btn-primary btn-sm" id="dlvEmptyNewTrip"><i class="fas fa-route"></i> إنشاء رحلة جديدة</button>
      </div>`;
      document.getElementById('dlvEmptyNewTrip')?.addEventListener('click', openNewTrip);
      return;
    }
    el.innerHTML = `<div class="card"><div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
      <thead><tr><th>رقم الرحلة</th><th>السائق</th><th>السيارة</th><th>التوقفات</th><th>تم التسليم</th><th>الحالة</th><th>المتوقع تحصيله</th><th>المحصّل</th><th>الإجراءات</th></tr></thead>
      <tbody>${_trips.map(t => `<tr data-id="${_esc(t.id)}" style="cursor:pointer">
        <td class="font-bold">${_esc(t.trip_num)}</td>
        <td>${_esc(t.driver_name || '—')}</td>
        <td>${_esc(t.plate_number || '—')}</td>
        <td>${Fmt.num(t.stops_count || 0)}</td>
        <td>${Fmt.num(t.delivered_count || 0)}</td>
        <td><span class="badge ${STATUS_BADGE[t.status] || 'bdg-slate'}">${_esc(t.status)}</span></td>
        <td>${Fmt.money(t.total_expected || 0)}</td>
        <td style="color:var(--teal-600);font-weight:700">${Fmt.money(t.total_collected || 0)}</td>
        <td><button class="btn btn-outline btn-sm" data-open="${_esc(t.id)}">فتح</button></td>
      </tr>`).join('')}</tbody>
    </table></div></div></div>`;
    el.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => openTripDetail(tr.dataset.id)));
  }

  function openNewTrip() {
    const driverOptions = _drivers.map(d => `<option value="${_esc(d.id)}">${_esc(d.name)}</option>`).join('');
    const vehicleOptions = _vehicles.map(v => `<option value="${_esc(v.id)}">${_esc(v.plate_number)}</option>`).join('');
    Modal.open({
      title: '<i class="fas fa-route"></i> رحلة توزيع جديدة',
      body: `
      <div class="form-row cols-2">
        <div class="form-group"><label class="form-label">السائق</label>
          <select class="form-control" id="ntDriver"><option value="">— بدون تحديد الآن —</option>${driverOptions}</select></div>
        <div class="form-group"><label class="form-label">السيارة</label>
          <select class="form-control" id="ntVehicle"><option value="">— بدون تحديد الآن —</option>${vehicleOptions}</select></div>
      </div>
      <div class="form-group"><label class="form-label">ملاحظات</label><textarea class="form-control" id="ntNotes" rows="2"></textarea></div>
      <p style="font-size:.78rem;color:var(--tx-3)">يمكنك تحديد السائق والسيارة لاحقًا، لكن لازمين قبل إخراج الرحلة للطريق.</p>`,
      foot: `<button class="btn btn-primary" id="ntSaveBtn"><i class="fas fa-check"></i> إنشاء الرحلة</button>
             <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    document.getElementById('ntSaveBtn')?.addEventListener('click', async () => {
      try {
        const r = await DB.addDeliveryTrip({
          driverId: document.getElementById('ntDriver').value || null,
          vehicleId: document.getElementById('ntVehicle').value || null,
          notes: document.getElementById('ntNotes').value.trim(),
        });
        Toast.ok('تم', `تم إنشاء الرحلة ${r.trip_num}`);
        Modal.close();
        await _loadAll();
        openTripDetail(r.id);
      } catch (e) { Toast.err('خطأ', e.message); }
    });
  }

  async function openTripDetail(tripId) {
    let trip;
    try { trip = await DB.getDeliveryTrip(tripId); } catch (e) { Toast.err('خطأ', e.message); return; }
    if (!trip) { Toast.err('خطأ', 'الرحلة غير موجودة'); return; }
    const canEdit = trip.status === 'قيد التجهيز' || trip.status === 'في الطريق';
    const stopsHtml = (trip.stops || []).length ? trip.stops.map(s => `
      <div class="card" style="margin-bottom:.7rem">
        <div class="card-body" style="display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem;flex-wrap:wrap">
          <div>
            <div style="font-weight:700">${_esc(s.customer_name)} <span class="badge ${s.status==='تم التسليم'?'bdg-ok':s.status==='مرتجع'?'bdg-err':s.status==='مشكلة'?'bdg-warn':'bdg-slate'}">${_esc(s.status)}</span></div>
            <div style="font-size:.78rem;color:var(--tx-3);margin-top:.2rem"><code>${_esc(s.barcode)}</code> — ${_esc(s.payment_mode)} — ${(s.invoices||[]).map(i=>_esc(i.invoice_num)).join('، ')}</div>
          </div>
          <div style="text-align:left">
            <div style="font-weight:700;color:var(--teal-600)">${Fmt.money(s.expected_amount)}</div>
            <div style="display:flex;gap:.3rem;margin-top:.3rem;justify-content:flex-end">
              <button class="btn btn-outline btn-icon sm" data-track-link="${_esc(s.barcode)}" title="نسخ رابط تتبع الشحنة للعميل"><i class="fas fa-link"></i></button>
              <button class="btn btn-outline btn-icon sm" data-print-stop="${_esc(s.id)}" title="طباعة بوليصة"><i class="fas fa-print"></i></button>
              ${s.status==='تم التسليم'||s.status==='مرتجع'?'':`<button class="btn btn-outline btn-sm" data-stop="${_esc(s.id)}"><i class="fas fa-check"></i> تحديث الحالة</button>`}
            </div>
          </div>
        </div>
      </div>`).join('') : '<p style="color:var(--tx-3);font-size:.85rem">لا توجد توقفات بعد</p>';

    Modal.open({
      title: `<i class="fas fa-route"></i> ${_esc(trip.trip_num)} <span class="badge ${STATUS_BADGE[trip.status]||'bdg-slate'}" style="margin-inline-start:.5rem">${_esc(trip.status)}</span>`,
      size: 'lg',
      body: `
        <div class="detail-row"><span class="dr-label">السائق</span><span class="dr-val">${_esc(trip.driver_name||'—')} ${trip.driver_phone?`(${_esc(trip.driver_phone)})`:''}</span></div>
        <div class="detail-row"><span class="dr-label">السيارة</span><span class="dr-val">${_esc(trip.plate_number||'—')}</span></div>
        <div class="divider"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem">
          <strong style="font-size:.88rem"><i class="fas fa-box"></i> التوقفات (${(trip.stops||[]).length})</strong>
          <div style="display:flex;gap:.4rem">
            ${(trip.stops||[]).length ? `<button class="btn btn-outline btn-sm" id="printAllBtn"><i class="fas fa-print"></i> طباعة كل البوليصات</button>` : ''}
            <button class="btn btn-outline btn-sm" id="printManifestBtn"><i class="fas fa-clipboard-list"></i> كشف الرحلة</button>
            ${canEdit ? `<button class="btn btn-amber btn-sm" id="addStopBtn"><i class="fas fa-plus"></i> إضافة توقف</button>` : ''}
          </div>
        </div>
        <div id="stopsList">${stopsHtml}</div>
      `,
      foot: `
        ${trip.status==='قيد التجهيز' ? `<button class="btn btn-primary" id="dispatchBtn"><i class="fas fa-truck-fast"></i> إخراج الرحلة للطريق</button>` : ''}
        ${(trip.status==='قيد التجهيز') ? `<button class="btn btn-danger" id="cancelTripBtn"><i class="fas fa-ban"></i> إلغاء الرحلة</button>` : ''}
        <button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>`,
    });

    document.getElementById('addStopBtn')?.addEventListener('click', () => openAddStop(tripId));
    document.getElementById('printAllBtn')?.addEventListener('click', () => window.open(`/api/delivery_slip_pdf/trip/${tripId}`, '_blank'));
    document.getElementById('printManifestBtn')?.addEventListener('click', () => window.open(`/api/trip_manifest_pdf/${tripId}`, '_blank'));
    document.querySelectorAll('[data-print-stop]').forEach(btn => {
      btn.addEventListener('click', () => window.open(`/api/delivery_slip_pdf/stop/${btn.dataset.printStop}`, '_blank'));
    });
    document.querySelectorAll('[data-track-link]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = `${location.origin}/track?barcode=${encodeURIComponent(btn.dataset.trackLink)}`;
        try { await navigator.clipboard.writeText(url); Toast.ok('تم النسخ', 'رابط التتبع جاهز للمشاركة مع العميل'); }
        catch (_) { Modal.open({ title: 'رابط تتبع الشحنة', body: `<input class="form-control" readonly value="${_esc(url)}" onclick="this.select()">`, foot: `<button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>` }); }
      });
    });
    document.querySelectorAll('[data-stop]').forEach(btn => {
      btn.addEventListener('click', () => openUpdateStop(btn.dataset.stop, tripId));
    });
    document.getElementById('dispatchBtn')?.addEventListener('click', async () => {
      try { await DB.dispatchTrip(tripId); Toast.ok('تم', 'الرحلة في الطريق الآن'); Modal.close(); await _loadAll(); renderTab(); }
      catch (e) { Toast.err('خطأ', e.message); }
    });
    document.getElementById('cancelTripBtn')?.addEventListener('click', () => {
      Modal.confirm('إلغاء الرحلة', 'هل تريد إلغاء هذه الرحلة؟ لن تُحتسب توقفاتها المفتوحة.', async () => {
        try { await DB.cancelTrip(tripId); Toast.ok('تم', 'تم إلغاء الرحلة'); Modal.close(); await _loadAll(); renderTab(); }
        catch (e) { Toast.err('خطأ', e.message); }
      });
    });
  }

  function openAddStop(tripId) {
    const customerOptions = (window._dlvCustomersCache || []).map(p => `<option value="${_esc(p.id)}">${_esc(p.name)}</option>`).join('');
    Modal.open({
      title: '<i class="fas fa-plus"></i> إضافة توقف',
      body: `
      <div class="form-group"><label class="form-label">العميل <span class="req">*</span></label>
        <select class="form-control" id="asCustomer"><option value="">اختر العميل...</option></select>
        <small style="color:var(--tx-3);font-size:.75rem">اكتب اسم العميل في الحقل بعد فتحه لو القائمة طويلة</small>
      </div>
      <div class="form-group" id="asInvoicesWrap" style="display:none">
        <label class="form-label">الفواتير غير المرتبطة بأي شحنة</label>
        <div id="asInvoices" style="max-height:180px;overflow:auto;border:1px solid var(--bd);border-radius:8px;padding:.5rem"></div>
      </div>
      <div class="form-row cols-2">
        <div class="form-group"><label class="form-label">طريقة الدفع</label>
          <select class="form-control" id="asPaymentMode">
            <option value="مسبق">مدفوع مسبقًا</option>
            <option value="عند التسليم">تحصيل عند التسليم (COD)</option>
          </select></div>
        <div class="form-group"><label class="form-label">ملاحظات</label><input class="form-control" id="asNotes"></div>
      </div>`,
      foot: `<button class="btn btn-primary" id="asSaveBtn"><i class="fas fa-check"></i> إضافة</button>
             <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    _populateCustomerSelect();
    document.getElementById('asCustomer')?.addEventListener('change', async e => {
      const pid = e.target.value;
      const wrap = document.getElementById('asInvoicesWrap');
      const list = document.getElementById('asInvoices');
      if (!pid) { wrap.style.display = 'none'; return; }
      wrap.style.display = 'block';
      list.innerHTML = '<div style="font-size:.8rem;color:var(--tx-3)">جارٍ التحميل...</div>';
      try {
        const sales = await DB.getUnassignedSalesForCustomer(pid);
        if (!sales.length) { list.innerHTML = '<div style="font-size:.8rem;color:var(--tx-3)">لا توجد فواتير متاحة لهذا العميل</div>'; return; }
        list.innerHTML = sales.map(s => `<label style="display:flex;align-items:center;gap:.5rem;padding:.3rem 0;font-size:.82rem">
          <input type="checkbox" class="as-sale-chk" value="${_esc(s.id)}">
          <span>${_esc(s.invoice_num)} — ${Fmt.money(s.total)} — ${_esc(s.payment_method)} — ${Fmt.dateShort(s.sale_date)}</span>
        </label>`).join('');
      } catch (err) { list.innerHTML = `<div style="color:var(--err);font-size:.8rem">${_esc(err.message)}</div>`; }
    });
    document.getElementById('asSaveBtn')?.addEventListener('click', async () => {
      const customerId = document.getElementById('asCustomer').value;
      const saleIds = [...document.querySelectorAll('.as-sale-chk:checked')].map(c => c.value);
      if (!customerId) { Toast.err('بيانات ناقصة', 'اختر العميل'); return; }
      if (!saleIds.length) { Toast.err('بيانات ناقصة', 'اختر فاتورة واحدة على الأقل'); return; }
      try {
        await DB.addDeliveryStop(tripId, {
          customerId, saleIds,
          paymentMode: document.getElementById('asPaymentMode').value,
          notes: document.getElementById('asNotes').value.trim(),
        });
        Toast.ok('تم', 'تمت إضافة التوقف');
        Modal.close();
        openTripDetail(tripId);
      } catch (e) { Toast.err('خطأ', e.message); }
    });
  }

  async function _populateCustomerSelect() {
    const sel = document.getElementById('asCustomer'); if (!sel) return;
    try {
      const customers = await DB.getCustomers();
      window._dlvCustomersCache = customers;
      sel.innerHTML = '<option value="">اختر العميل...</option>' +
        customers.map(p => `<option value="${_esc(p.id)}">${_esc(p.name)}${p.customerType==='جملة'?' (جملة)':''}</option>`).join('');
    } catch (_) {}
  }

  function openUpdateStop(stopId, tripId) {
    Modal.open({
      title: '<i class="fas fa-truck-ramp-box"></i> تحديث حالة التوقف',
      body: `
      <div class="form-group"><label class="form-label">الحالة الجديدة</label>
        <select class="form-control" id="usStatus">
          <option value="تم التسليم">تم التسليم</option>
          <option value="مرتجع">مرتجع</option>
          <option value="مشكلة">مشكلة</option>
        </select></div>
      <div class="form-group" id="usCollectedWrap"><label class="form-label">المبلغ المحصّل</label>
        <input class="form-control" id="usCollected" type="number" min="0" step="0.01" value="0"></div>
      <div class="form-group"><label class="form-label">ملاحظات</label><input class="form-control" id="usNotes"></div>`,
      foot: `<button class="btn btn-primary" id="usSaveBtn"><i class="fas fa-check"></i> حفظ</button>
             <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    document.getElementById('usStatus')?.addEventListener('change', e => {
      document.getElementById('usCollectedWrap').style.display = e.target.value === 'تم التسليم' ? '' : 'none';
    });
    document.getElementById('usSaveBtn')?.addEventListener('click', async () => {
      try {
        await DB.updateStopStatus(stopId, {
          status: document.getElementById('usStatus').value,
          collectedAmount: parseFloat(document.getElementById('usCollected').value) || 0,
          notes: document.getElementById('usNotes').value.trim(),
        });
        Toast.ok('تم', 'تم تحديث حالة التوقف');
        Modal.close();
        await _loadAll();
        openTripDetail(tripId);
      } catch (e) { Toast.err('خطأ', e.message); }
    });
  }

  /* ═══════════════ BARCODE SCAN ═══════════════ */
  function _renderScan(el) {
    el.innerHTML = `
    <div class="card" style="max-width:520px">
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">امسح أو أدخل باركود الشحنة</label>
          <div style="display:flex;gap:.5rem">
            <input class="form-control" id="scanInput" placeholder="SHP-XXXXXXXXXX" autofocus>
            <button class="btn btn-primary" id="scanBtn"><i class="fas fa-magnifying-glass"></i> بحث</button>
          </div>
        </div>
        <div id="scanResult"></div>
      </div>
    </div>`;
    const doScan = async () => {
      const code = document.getElementById('scanInput').value.trim();
      if (!code) return;
      const resultEl = document.getElementById('scanResult');
      resultEl.innerHTML = '<div style="font-size:.85rem;color:var(--tx-3)">جارٍ البحث...</div>';
      try {
        const stop = await DB.getStopByBarcode(code);
        if (!stop) { resultEl.innerHTML = '<div class="alert err">لم يتم العثور على شحنة بهذا الباركود</div>'; return; }
        resultEl.innerHTML = `
        <div class="divider"></div>
        <div class="detail-row"><span class="dr-label">العميل</span><span class="dr-val">${_esc(stop.customer_name)}</span></div>
        <div class="detail-row"><span class="dr-label">الرحلة</span><span class="dr-val">${_esc(stop.trip_num)} (${_esc(stop.trip_status)})</span></div>
        <div class="detail-row"><span class="dr-label">السائق</span><span class="dr-val">${_esc(stop.driver_name||'—')}</span></div>
        <div class="detail-row"><span class="dr-label">طريقة الدفع</span><span class="dr-val">${_esc(stop.payment_mode)}</span></div>
        <div class="detail-row"><span class="dr-label">المبلغ المتوقع</span><span class="dr-val" style="color:var(--teal-600);font-weight:700">${Fmt.money(stop.expected_amount)}</span></div>
        <div class="detail-row"><span class="dr-label">الحالة</span><span class="dr-val"><span class="badge ${stop.status==='تم التسليم'?'bdg-ok':stop.status==='مرتجع'?'bdg-err':stop.status==='مشكلة'?'bdg-warn':'bdg-slate'}">${_esc(stop.status)}</span></span></div>
        <div class="detail-row"><span class="dr-label">الفواتير</span><span class="dr-val">${(stop.invoices||[]).map(i=>_esc(i.invoice_num)).join('، ')}</span></div>
        <div style="display:flex;gap:.5rem;margin-top:.6rem">
          <button class="btn btn-outline btn-sm" id="scanPrintBtn"><i class="fas fa-print"></i> طباعة البوليصة</button>
          ${stop.status!=='تم التسليم'&&stop.status!=='مرتجع' ? `<button class="btn btn-primary btn-sm" id="scanUpdateBtn"><i class="fas fa-check"></i> تحديث حالة التسليم</button>` : ''}
        </div>`;
        document.getElementById('scanPrintBtn')?.addEventListener('click', () => window.open(`/api/delivery_slip_pdf/stop/${stop.id}`, '_blank'));
        document.getElementById('scanUpdateBtn')?.addEventListener('click', () => openUpdateStop(stop.id, null));
      } catch (e) { resultEl.innerHTML = `<div class="alert err">${_esc(e.message)}</div>`; }
    };
    document.getElementById('scanBtn')?.addEventListener('click', doScan);
    document.getElementById('scanInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') doScan(); });
  }

  /* ═══════════════ DRIVERS ═══════════════ */
  function _renderDrivers(el) {
    el.innerHTML = `
    <div style="margin-bottom:.8rem;text-align:left">${canManageFleet()?'<button class="btn btn-amber btn-sm" id="addDriverBtn"><i class="fas fa-plus"></i> إضافة سائق</button>':''}</div>
    <div class="card"><div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
      <thead><tr><th>الاسم</th><th>الهاتف</th><th>رقم الرخصة</th><th>ملاحظات</th><th>الإجراءات</th></tr></thead>
      <tbody>${_drivers.length ? _drivers.map(d => `<tr>
        <td class="font-bold">${_esc(d.name)}</td><td dir="ltr">${_esc(d.phone||'—')}</td>
        <td>${_esc(d.license_num||'—')}</td><td>${_esc(d.notes||'—')}</td>
        <td>${canManageFleet()?`<div class="td-actions">
          <button class="btn btn-outline btn-icon sm" data-edit="${_esc(d.id)}"><i class="fas fa-pen"></i></button>
          <button class="btn btn-danger btn-icon sm" data-del="${_esc(d.id)}"><i class="fas fa-trash"></i></button>
        </div>`:'—'}</td>
      </tr>`).join('') : '<tr><td colspan="5"><div class="empty-state"><h3 class="es-title">لا يوجد سائقون</h3></div></td></tr>'}</tbody>
    </table></div></div></div>`;
    document.getElementById('addDriverBtn')?.addEventListener('click', () => _driverForm());
    el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => _driverForm(_drivers.find(d=>d.id===b.dataset.edit))));
    el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      Modal.confirm('حذف السائق', 'هل تريد حذف هذا السائق؟', async () => {
        try { await DB.deleteDriver(b.dataset.del); Toast.ok('تم', 'تم الحذف'); await _loadAll(); renderTab(); }
        catch (e) { Toast.err('خطأ', e.message); }
      });
    }));
  }

  function _driverForm(d = null) {
    Modal.open({
      title: d ? '<i class="fas fa-pen"></i> تعديل سائق' : '<i class="fas fa-id-card"></i> إضافة سائق',
      body: `
      <div class="form-group"><label class="form-label">الاسم <span class="req">*</span></label><input class="form-control" id="drName" value="${_esc(d?.name||'')}"></div>
      <div class="form-row cols-2">
        <div class="form-group"><label class="form-label">الهاتف</label><input class="form-control" id="drPhone" dir="ltr" value="${_esc(d?.phone||'')}"></div>
        <div class="form-group"><label class="form-label">رقم الرخصة</label><input class="form-control" id="drLicense" value="${_esc(d?.license_num||'')}"></div>
      </div>
      <div class="form-group"><label class="form-label">ملاحظات</label><input class="form-control" id="drNotes" value="${_esc(d?.notes||'')}"></div>`,
      foot: `<button class="btn btn-primary" id="drSaveBtn"><i class="fas fa-check"></i> حفظ</button>
             <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    document.getElementById('drSaveBtn')?.addEventListener('click', async () => {
      const payload = { name: document.getElementById('drName').value.trim(), phone: document.getElementById('drPhone').value.trim(),
        licenseNum: document.getElementById('drLicense').value.trim(), notes: document.getElementById('drNotes').value.trim() };
      if (!payload.name) { Toast.err('بيانات ناقصة', 'اسم السائق مطلوب'); return; }
      try {
        if (d) await DB.updateDriver(d.id, payload); else await DB.addDriver(payload);
        Toast.ok('تم', 'تم الحفظ'); Modal.close(); await _loadAll(); renderTab();
      } catch (e) { Toast.err('خطأ', e.message); }
    });
  }

  /* ═══════════════ VEHICLES ═══════════════ */
  function _renderVehicles(el) {
    el.innerHTML = `
    <div style="margin-bottom:.8rem;text-align:left">${canManageFleet()?'<button class="btn btn-amber btn-sm" id="addVehicleBtn"><i class="fas fa-plus"></i> إضافة سيارة</button>':''}</div>
    <div class="card"><div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
      <thead><tr><th>رقم اللوحة</th><th>النوع</th><th>السعة</th><th>ملاحظات</th><th>الإجراءات</th></tr></thead>
      <tbody>${_vehicles.length ? _vehicles.map(v => `<tr>
        <td class="font-bold" dir="ltr">${_esc(v.plate_number)}</td><td>${_esc(v.vehicle_type||'—')}</td>
        <td>${_esc(v.capacity_note||'—')}</td><td>${_esc(v.notes||'—')}</td>
        <td>${canManageFleet()?`<div class="td-actions">
          <button class="btn btn-outline btn-icon sm" data-edit="${_esc(v.id)}"><i class="fas fa-pen"></i></button>
          <button class="btn btn-danger btn-icon sm" data-del="${_esc(v.id)}"><i class="fas fa-trash"></i></button>
        </div>`:'—'}</td>
      </tr>`).join('') : '<tr><td colspan="5"><div class="empty-state"><h3 class="es-title">لا توجد سيارات</h3></div></td></tr>'}</tbody>
    </table></div></div></div>`;
    document.getElementById('addVehicleBtn')?.addEventListener('click', () => _vehicleForm());
    el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => _vehicleForm(_vehicles.find(v=>v.id===b.dataset.edit))));
    el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      Modal.confirm('حذف السيارة', 'هل تريد حذف هذه السيارة؟', async () => {
        try { await DB.deleteVehicle(b.dataset.del); Toast.ok('تم', 'تم الحذف'); await _loadAll(); renderTab(); }
        catch (e) { Toast.err('خطأ', e.message); }
      });
    }));
  }

  function _vehicleForm(v = null) {
    Modal.open({
      title: v ? '<i class="fas fa-pen"></i> تعديل سيارة' : '<i class="fas fa-truck"></i> إضافة سيارة',
      body: `
      <div class="form-group"><label class="form-label">رقم اللوحة <span class="req">*</span></label><input class="form-control" id="vhPlate" dir="ltr" value="${_esc(v?.plate_number||'')}"></div>
      <div class="form-row cols-2">
        <div class="form-group"><label class="form-label">النوع</label><input class="form-control" id="vhType" value="${_esc(v?.vehicle_type||'')}" placeholder="فان / دراجة نارية / نصف نقل"></div>
        <div class="form-group"><label class="form-label">السعة</label><input class="form-control" id="vhCapacity" value="${_esc(v?.capacity_note||'')}"></div>
      </div>
      <div class="form-group"><label class="form-label">ملاحظات</label><input class="form-control" id="vhNotes" value="${_esc(v?.notes||'')}"></div>`,
      foot: `<button class="btn btn-primary" id="vhSaveBtn"><i class="fas fa-check"></i> حفظ</button>
             <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    document.getElementById('vhSaveBtn')?.addEventListener('click', async () => {
      const payload = { plateNumber: document.getElementById('vhPlate').value.trim(), vehicleType: document.getElementById('vhType').value.trim(),
        capacityNote: document.getElementById('vhCapacity').value.trim(), notes: document.getElementById('vhNotes').value.trim() };
      if (!payload.plateNumber) { Toast.err('بيانات ناقصة', 'رقم اللوحة مطلوب'); return; }
      try {
        if (v) await DB.updateVehicle(v.id, payload); else await DB.addVehicle(payload);
        Toast.ok('تم', 'تم الحفظ'); Modal.close(); await _loadAll(); renderTab();
      } catch (e) { Toast.err('خطأ', e.message); }
    });
  }

  /* ═══════════════ RECURRING ROUTES — الرحلات الدورية ═══════════════ */
  const WEEKDAYS = ['الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];

  function _renderRecurring(el) {
    el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem;flex-wrap:wrap;gap:.5rem">
      <button class="btn btn-primary btn-sm" id="genTodayBtn"><i class="fas fa-bolt"></i> توليد رحلات اليوم (${WEEKDAYS[new Date().getDay()===0?6:new Date().getDay()-1]})</button>
      <button class="btn btn-amber btn-sm" id="addRecurringBtn" ${canManageFleet()?'':'style="display:none"'}><i class="fas fa-plus"></i> جدولة رحلة دورية</button>
    </div>
    <div class="card"><div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
      <thead><tr><th>العميل</th><th>يوم الأسبوع</th><th>السائق</th><th>السيارة</th><th>طريقة الدفع</th><th>آخر توليد</th><th>الحالة</th><th>الإجراءات</th></tr></thead>
      <tbody>${_recurringRoutes.length ? _recurringRoutes.map(r => `<tr>
        <td class="font-bold">${_esc(r.customer_name||'—')}</td>
        <td>${WEEKDAYS[r.weekday]}</td>
        <td>${_esc(r.driver_name||'—')}</td>
        <td>${_esc(r.plate_number||'—')}</td>
        <td>${_esc(r.payment_mode)}</td>
        <td style="font-size:.8rem;color:var(--tx-3)">${r.last_generated_date||'—'}</td>
        <td><span class="badge ${r.is_active?'bdg-ok':'bdg-slate'}">${r.is_active?'مفعّلة':'موقوفة'}</span></td>
        <td>${canManageFleet()?`<div class="td-actions">
          <button class="btn btn-outline btn-icon sm" data-edit="${_esc(r.id)}"><i class="fas fa-pen"></i></button>
          <button class="btn btn-danger btn-icon sm" data-del="${_esc(r.id)}"><i class="fas fa-trash"></i></button>
        </div>`:'—'}</td>
      </tr>`).join('') : '<tr><td colspan="8"><div class="empty-state"><h3 class="es-title">لا توجد رحلات دورية مجدولة</h3><p class="es-desc">جدولة عميل يطلب توصيلًا أسبوعيًا يوفر وقت تجهيز الرحلات يدويًا</p></div></td></tr>'}</tbody>
    </table></div></div></div>`;

    document.getElementById('genTodayBtn')?.addEventListener('click', async () => {
      try {
        const res = await DB.generateTodaysRecurringTrips();
        if (res.trips_created > 0) Toast.ok('تم', `تم إنشاء ${res.trips_created} رحلة و${res.stops_created} توقف`);
        else Toast.info('لا جديد', res.message || 'لا توجد فواتير جديدة للعملاء المجدولين اليوم');
        await _loadAll(); renderTab();
      } catch (e) { Toast.err('خطأ', e.message); }
    });
    document.getElementById('addRecurringBtn')?.addEventListener('click', () => _recurringForm());
    el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => _recurringForm(_recurringRoutes.find(r=>r.id===b.dataset.edit))));
    el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      Modal.confirm('حذف الجدولة', 'هل تريد حذف هذه الرحلة الدورية؟', async () => {
        try { await DB.deleteRecurringRoute(b.dataset.del); Toast.ok('تم', 'تم الحذف'); await _loadAll(); renderTab(); }
        catch (e) { Toast.err('خطأ', e.message); }
      });
    }));
  }

  async function _recurringForm(r = null) {
    let customers = [];
    try { customers = await DB.getCustomers(); } catch (_) {}
    const customerOptions = customers.map(p => `<option value="${_esc(p.id)}" ${r?.customer_id===p.id?'selected':''}>${_esc(p.name)}</option>`).join('');
    const driverOptions = _drivers.map(d => `<option value="${_esc(d.id)}" ${r?.driver_id===d.id?'selected':''}>${_esc(d.name)}</option>`).join('');
    const vehicleOptions = _vehicles.map(v => `<option value="${_esc(v.id)}" ${r?.vehicle_id===v.id?'selected':''}>${_esc(v.plate_number)}</option>`).join('');
    Modal.open({
      title: r ? '<i class="fas fa-pen"></i> تعديل رحلة دورية' : '<i class="fas fa-repeat"></i> جدولة رحلة دورية',
      body: `
      <div class="form-group"><label class="form-label">العميل <span class="req">*</span></label>
        <select class="form-control" id="rrCustomer">${customerOptions}</select></div>
      <div class="form-row cols-2">
        <div class="form-group"><label class="form-label">يوم الأسبوع</label>
          <select class="form-control" id="rrWeekday">${WEEKDAYS.map((w,i)=>`<option value="${i}" ${r?.weekday===i?'selected':''}>${w}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">طريقة الدفع</label>
          <select class="form-control" id="rrPayment">
            <option value="مسبق" ${!r||r.payment_mode==='مسبق'?'selected':''}>مدفوع مسبقًا</option>
            <option value="عند التسليم" ${r?.payment_mode==='عند التسليم'?'selected':''}>تحصيل عند التسليم</option>
          </select></div>
      </div>
      <div class="form-row cols-2">
        <div class="form-group"><label class="form-label">السائق (اختياري)</label>
          <select class="form-control" id="rrDriver"><option value="">— غير محدد —</option>${driverOptions}</select></div>
        <div class="form-group"><label class="form-label">السيارة (اختياري)</label>
          <select class="form-control" id="rrVehicle"><option value="">— غير محدد —</option>${vehicleOptions}</select></div>
      </div>
      <div class="form-group"><label class="form-label">ملاحظات</label><input class="form-control" id="rrNotes" value="${_esc(r?.notes||'')}"></div>
      ${r ? `<label style="display:flex;align-items:center;gap:.5rem;font-size:.85rem"><input type="checkbox" id="rrActive" ${r.is_active?'checked':''}> الجدولة مفعّلة</label>` : ''}
      <p style="font-size:.78rem;color:var(--tx-3);margin-top:.5rem">عند الضغط على "توليد رحلات اليوم"، سيتم تجميع كل فواتير هذا العميل غير المرتبطة بشحنة في توقف واحد ضمن رحلة مشتركة مع باقي عملاء نفس السائق/السيارة.</p>`,
      foot: `<button class="btn btn-primary" id="rrSaveBtn"><i class="fas fa-check"></i> حفظ</button>
             <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    document.getElementById('rrSaveBtn')?.addEventListener('click', async () => {
      const payload = {
        customerId: document.getElementById('rrCustomer').value,
        weekday: parseInt(document.getElementById('rrWeekday').value),
        driverId: document.getElementById('rrDriver').value || null,
        vehicleId: document.getElementById('rrVehicle').value || null,
        paymentMode: document.getElementById('rrPayment').value,
        notes: document.getElementById('rrNotes').value.trim(),
        isActive: document.getElementById('rrActive') ? document.getElementById('rrActive').checked : true,
      };
      if (!payload.customerId) { Toast.err('بيانات ناقصة', 'اختر العميل'); return; }
      try {
        if (r) await DB.updateRecurringRoute(r.id, payload); else await DB.addRecurringRoute(payload);
        Toast.ok('تم', 'تم حفظ الجدولة'); Modal.close(); await _loadAll(); renderTab();
      } catch (e) { Toast.err('خطأ', e.message); }
    });
  }

  return { render, afterRender };
})();
