/* ════════════════════════════════════════════════════════════
   PAGE: REPAIRS — الصيانة
   تذاكر صيانة الموبايلات والأدوات الكهربائية: استلام → فحص → إصلاح → تسليم بفاتورة
════════════════════════════════════════════════════════════ */
'use strict';

const RepairsPage = (() => {
  const STATUSES = ['استلام', 'قيد الفحص', 'بانتظار موافقة العميل', 'قيد الإصلاح', 'جاهز للتسليم'];
  const BADGE = {
    'استلام': 'bdg-slate', 'قيد الفحص': 'bdg-amb', 'بانتظار موافقة العميل': 'bdg-warn',
    'قيد الإصلاح': 'bdg-teal', 'جاهز للتسليم': 'bdg-ok', 'تم التسليم': 'bdg-slate', 'ملغي': 'bdg-err',
  };
  const DEVICE_TYPES = ['موبايل', 'تابلت', 'لابتوب', 'أداة كهربائية', 'أخرى'];

  let _filter = 'مفتوحة';
  let _search = '';
  let _rows = [];
  let _technicians = [];
  let _parts = [];      // أصناف يمكن استخدامها كقطع غيار

  function render() {
    return `
<div class="page active" id="page-repairs">
  <div class="pg-header">
    <div class="pg-title-group">
      <h1 class="pg-title">
        <div class="pg-title-icon" style="background:var(--amb-100);color:var(--amb-700)"><i class="fas fa-screwdriver-wrench"></i></div>
        الصيانة
      </h1>
      <p class="pg-subtitle">استلام الأجهزة وتتبع الإصلاح وتسليمها بفاتورة</p>
    </div>
    <div class="pg-actions">
      <button class="btn btn-amber" id="repAddBtn"><i class="fas fa-plus"></i> استلام جهاز للصيانة</button>
    </div>
  </div>

  <div class="inventory-strip" id="repStats"><div class="inventory-strip-loading">جارٍ التحميل...</div></div>

  <div class="tabs" id="repTabs">
    ${['مفتوحة', ...STATUSES, 'تم التسليم', 'ملغي', 'الكل'].map(s => `<button class="tab-btn ${s === _filter ? 'active' : ''}" data-f="${s}">${s}</button>`).join('')}
  </div>

  <div class="toolbar">
    <div class="tb-srch"><i class="fas fa-magnifying-glass"></i>
      <input type="search" id="repSearch" placeholder="بحث برقم التذكرة أو اسم العميل أو الهاتف أو IMEI..." /></div>
  </div>

  <div class="card"><div class="card-body p0"><div class="tbl-wrap">
    <table class="dtable">
      <thead><tr><th>التذكرة</th><th>العميل</th><th>الجهاز</th><th>العطل</th><th>الحالة</th><th>الفني</th><th>الموعد</th><th>الإجمالي</th><th></th></tr></thead>
      <tbody id="repTbody"><tr><td colspan="9"><div class="empty-state"><div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div></div></td></tr></tbody>
    </table>
  </div></div><div class="card-foot"><div class="pagination" id="repPager"></div></div></div>
</div>`;
  }

  async function afterRender() {
    document.getElementById('repAddBtn')?.addEventListener('click', openAdd);
    document.getElementById('repSearch')?.addEventListener('input', debounce(e => { _search = e.target.value.trim(); _load(); }, 300));
    document.getElementById('repTabs')?.addEventListener('click', e => {
      const btn = e.target.closest('.tab-btn'); if (!btn) return;
      _filter = btn.dataset.f;
      document.querySelectorAll('#repTabs .tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      _load();
    });
    try { _technicians = await DB.getTechnicians(); } catch (_) { _technicians = []; }
    try { _parts = (await DB.getProducts()).filter(p => !p.isService && !p.trackSerial); } catch (_) { _parts = []; }
    await _load();
  }

  async function _load() {
    try {
      const status = _filter === 'الكل' ? null : _filter;
      const [rows, stats] = await Promise.all([DB.getRepairs(status, _search || null), DB.getRepairStats()]);
      _rows = rows || [];
      const el = document.getElementById('repStats');
      if (el) el.innerHTML = `
        <div class="inv-metric primary"><span class="inv-metric-icon"><i class="fas fa-screwdriver-wrench"></i></span><div><small>تذاكر مفتوحة</small><strong>${Fmt.num(stats.open)}</strong></div></div>
        <div class="inv-metric ${stats.overdue ? 'alerting' : ''}"><span class="inv-metric-icon"><i class="fas fa-clock"></i></span><div><small>متأخرة عن الموعد</small><strong>${Fmt.num(stats.overdue)}</strong></div></div>
        <div class="inv-metric"><span class="inv-metric-icon"><i class="fas fa-circle-check"></i></span><div><small>جاهزة للتسليم</small><strong>${Fmt.num(stats.by_status?.['جاهز للتسليم'] || 0)}</strong></div></div>
        <div class="inv-metric"><span class="inv-metric-icon"><i class="fas fa-coins"></i></span><div><small>إيراد الصيانة هذا الشهر</small><strong>${Fmt.money(stats.month_revenue || 0)}</strong></div></div>`;
      _renderTable();
    } catch (e) { Toast.err('خطأ', e.message); }
  }

  function _renderTable() {
    const tbody = document.getElementById('repTbody'); if (!tbody) return;
    if (!_rows.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="es-icon"><i class="fas fa-screwdriver-wrench"></i></div><h3 class="es-title">لا توجد تذاكر</h3></div></td></tr>`;
      const pager = document.getElementById('repPager'); if (pager) pager.innerHTML = '';
      return;
    }
    const pg = Paginator(_rows, 12);
    const draw = () => {
      tbody.innerHTML = pg.slice().map(r => `
        <tr data-id="${_esc(r.id)}" style="cursor:pointer">
          <td><strong>${_esc(r.ticket_num)}</strong><small style="display:block;color:var(--tx-3)">${Fmt.dateShort(r.received_at)}</small></td>
          <td>${_esc(r.customer_name)}<small style="display:block;color:var(--tx-3)" dir="ltr">${_esc(r.phone || '')}</small></td>
          <td>${_esc([r.device_brand, r.device_model].filter(Boolean).join(' ') || r.device_type)}
            ${r.imei ? `<small style="display:block;color:var(--tx-3)" dir="ltr">${_esc(r.imei)}</small>` : ''}</td>
          <td style="max-width:200px">${_esc(r.issue)}</td>
          <td><span class="badge ${BADGE[r.status] || 'bdg-slate'}">${_esc(r.status)}</span>
            ${r.in_warranty ? '<span class="badge bdg-ok" style="margin-inline-start:.25rem">ضمان</span>' : ''}</td>
          <td>${_esc(r.technician_name || '—')}</td>
          <td>${r.promised_date ? Fmt.dateShort(r.promised_date) : '—'}${r.overdue ? '<span class="badge bdg-err" style="margin-inline-start:.25rem">متأخر</span>' : ''}</td>
          <td>${r.in_warranty ? 'بدون مقابل' : Fmt.money(r.total || 0)}</td>
          <td><button class="btn btn-ghost btn-icon sm" title="فتح"><i class="fas fa-folder-open"></i></button></td>
        </tr>`).join('');
      tbody.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => openTicket(tr.dataset.id)));
      pg.render(document.getElementById('repPager'));
    };
    draw();
    document.getElementById('repPager')?.addEventListener('click', draw);
  }

  /* ══════════ استلام جهاز ══════════ */
  async function openAdd() {
    let customers = [];
    try { customers = await DB.getCustomers(); } catch (_) { /* لا صلاحية */ }
    const techOpts = `<option value="">— بدون تحديد —</option>` + _technicians.map(t => `<option value="${_esc(t.id)}">${_esc(t.full_name)}</option>`).join('');
    Modal.open({
      title: '<i class="fas fa-plus"></i> استلام جهاز للصيانة', size: 'lg',
      body: `
      <div class="form-row cols-3">
        <div class="form-group"><label class="form-label">عميل مسجل</label>
          <select class="form-control" id="rpCustomer"><option value="">— عميل جديد / عادي —</option>
            ${customers.map(c => `<option value="${_esc(c.id)}">${_esc(c.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">اسم العميل <span class="req">*</span></label><input class="form-control" id="rpName"></div>
        <div class="form-group"><label class="form-label">رقم التليفون</label><input class="form-control" id="rpPhone" dir="ltr"></div>
      </div>
      <div class="form-row cols-3">
        <div class="form-group"><label class="form-label">نوع الجهاز</label>
          <select class="form-control" id="rpType">${DEVICE_TYPES.map(t => `<option>${t}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">الماركة</label><input class="form-control" id="rpBrand" placeholder="Samsung"></div>
        <div class="form-group"><label class="form-label">الموديل</label><input class="form-control" id="rpModel" placeholder="Galaxy A15"></div>
      </div>
      <div class="form-row cols-2">
        <div class="form-group"><label class="form-label">IMEI / Serial</label><input class="form-control" id="rpImei" dir="ltr" placeholder="لفحص الضمان تلقائيًا">
          <small id="rpWarrantyHint" style="display:block;margin-top:.25rem"></small></div>
        <div class="form-group"><label class="form-label">المرفقات المستلمة</label><input class="form-control" id="rpAcc" placeholder="شاحن، شريحة، جراب..."></div>
      </div>
      <div class="form-group"><label class="form-label">وصف العطل <span class="req">*</span></label><textarea class="form-control" id="rpIssue" rows="2"></textarea></div>
      <div class="form-row cols-3">
        <div class="form-group"><label class="form-label">التكلفة التقديرية</label><input class="form-control" id="rpEst" type="number" min="0" step="0.01" value="0"></div>
        <div class="form-group"><label class="form-label">عربون مدفوع</label><input class="form-control" id="rpDeposit" type="number" min="0" step="0.01" value="0"></div>
        <div class="form-group"><label class="form-label">موعد التسليم المتوقع</label><input class="form-control" id="rpPromised" type="date"></div>
      </div>
      <div class="form-row cols-2">
        <div class="form-group"><label class="form-label">الفني</label><select class="form-control" id="rpTech">${techOpts}</select></div>
        <div class="form-group" style="display:flex;align-items:flex-end"><label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="rpWarranty"> صيانة تحت الضمان (بدون مقابل)</label></div>
      </div>`,
      foot: `<button class="btn btn-primary" id="rpSaveBtn"><i class="fas fa-check"></i> حفظ وطباعة إيصال الاستلام</button>
             <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    const $ = id => document.getElementById(id);
    $('rpCustomer')?.addEventListener('change', () => {
      const c = customers.find(x => x.id === $('rpCustomer').value);
      if (c) { $('rpName').value = c.name; $('rpPhone').value = c.phone || ''; }
    });
    $('rpImei')?.addEventListener('change', async () => {
      const code = $('rpImei').value.trim(); const hint = $('rpWarrantyHint'); hint.textContent = '';
      if (code.length < 4) return;
      try {
        const r = await DB.lookupSerial(code);
        if (!r.found) { hint.style.color = 'var(--tx-3)'; hint.textContent = 'الجهاز غير مسجل من مبيعات المحل'; return; }
        const u = r.unit;
        if (u.status === 'مباع' && u.warranty_active) {
          hint.style.color = 'var(--ok)'; hint.textContent = `الجهاز بضمان المحل حتى ${Fmt.dateShort(u.warranty_end)} (${u.customer_name || ''})`;
          $('rpWarranty').checked = true;
          if (!$('rpBrand').value) $('rpModel').value = $('rpModel').value || u.product_name || '';
        } else if (u.status === 'مباع') {
          hint.style.color = 'var(--err)'; hint.textContent = 'انتهى ضمان هذا الجهاز';
        } else { hint.style.color = 'var(--warn)'; hint.textContent = `الجهاز مسجل بالمخزون وحالته: ${u.status}`; }
      } catch (_) { /* تجاهل */ }
    });
    $('rpSaveBtn')?.addEventListener('click', async e => {
      const data = {
        customer_id: $('rpCustomer').value || null, customer_name: $('rpName').value.trim(), phone: $('rpPhone').value.trim(),
        device_type: $('rpType').value, device_brand: $('rpBrand').value.trim(), device_model: $('rpModel').value.trim(),
        imei: $('rpImei').value.trim(), accessories: $('rpAcc').value.trim(), issue: $('rpIssue').value.trim(),
        estimated_cost: parseFloat($('rpEst').value) || 0, deposit: parseFloat($('rpDeposit').value) || 0,
        promised_date: $('rpPromised').value || null, technician_id: $('rpTech').value || null,
        in_warranty: $('rpWarranty').checked,
      };
      if (!data.customer_name || !data.issue) { Toast.err('بيانات ناقصة', 'اسم العميل ووصف العطل مطلوبان'); return; }
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const res = await DB.addRepair(data);
        Toast.ok('تم الاستلام', `رقم التذكرة ${res.ticket_num}`);
        Modal.close();
        await _load();
        const ticket = await DB.getRepair(res.id);
        _printTicket(ticket);
      } catch (err) { Toast.err('خطأ', err.message); btn.disabled = false; }
    });
  }

  /* ══════════ إيصال الاستلام ══════════ */
  async function _printTicket(t) {
    let shop = 'تك ماركت';
    try { shop = (await DB.getSetting('shop_name')) || shop; } catch (_) {}
    const box = document.createElement('div');
    box.id = 'tempRepairPrint'; box.style.display = 'none';
    box.innerHTML = `<div class="receipt">
      <div class="rcp-head"><div class="rcp-title">${_esc(shop)}</div><div class="rcp-sub">إيصال استلام جهاز للصيانة</div>
        <div class="rcp-sub" style="margin-top:.3rem">${Fmt.dateShort(t.received_at)}</div></div>
      <div class="rcp-div"></div>
      <div class="rcp-row"><span>رقم التذكرة</span><span>${_esc(t.ticket_num)}</span></div>
      <div class="rcp-row"><span>العميل</span><span>${_esc(t.customer_name)}</span></div>
      <div class="rcp-row"><span>التليفون</span><span dir="ltr">${_esc(t.phone || '—')}</span></div>
      <div class="rcp-row"><span>الجهاز</span><span>${_esc([t.device_brand, t.device_model].filter(Boolean).join(' ') || t.device_type)}</span></div>
      ${t.imei ? `<div class="rcp-row"><span>IMEI</span><span dir="ltr">${_esc(t.imei)}</span></div>` : ''}
      <div class="rcp-row"><span>العطل</span><span>${_esc(t.issue)}</span></div>
      ${t.accessories ? `<div class="rcp-row"><span>المرفقات</span><span>${_esc(t.accessories)}</span></div>` : ''}
      ${t.promised_date ? `<div class="rcp-row"><span>الموعد المتوقع</span><span>${Fmt.dateShort(t.promised_date)}</span></div>` : ''}
      ${t.deposit > 0 ? `<div class="rcp-row bold"><span>العربون المدفوع</span><span>${Fmt.money(t.deposit)}</span></div>` : ''}
      <div class="rcp-div"></div>
      <div class="rcp-barcode">${BarcodeGenerator.generateSVG(t.ticket_num, { height: 28, includeText: true })}</div>
      <div class="rcp-foot-note">يرجى إحضار هذا الإيصال عند استلام الجهاز • المحل غير مسؤول عن الأجهزة بعد 30 يومًا من إشعار الجاهزية</div>
    </div>`;
    document.body.appendChild(box);
    printElement('tempRepairPrint', `إيصال ${t.ticket_num}`);
    setTimeout(() => box.remove(), 2500);
  }

  /* ══════════ تفاصيل التذكرة ══════════ */
  async function openTicket(id) {
    let t;
    try { t = await DB.getRepair(id); } catch (e) { Toast.err('خطأ', e.message); return; }
    if (!t) return;
    const closed = t.status === 'تم التسليم' || t.status === 'ملغي';
    const techOpts = `<option value="">— بدون تحديد —</option>` + _technicians.map(x => `<option value="${_esc(x.id)}" ${x.id === t.technician_id ? 'selected' : ''}>${_esc(x.full_name)}</option>`).join('');
    const partOpts = `<option value="">اختر قطعة غيار...</option>` + _parts.map(p => `<option value="${_esc(p.id)}" data-price="${p.price}">${_esc(p.name)} — ${Fmt.money(p.price)} (${Fmt.num(p.stock)} متاح)</option>`).join('');
    const dis = closed ? 'disabled' : '';
    const body = `
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:.6rem;margin-bottom:.8rem">
        <div><strong style="font-size:1.05rem">${_esc(t.ticket_num)}</strong>
          <span class="badge ${BADGE[t.status] || 'bdg-slate'}" style="margin-inline-start:.4rem">${_esc(t.status)}</span>
          ${t.in_warranty ? '<span class="badge bdg-ok">تحت الضمان</span>' : ''}${t.overdue ? '<span class="badge bdg-err">متأخر</span>' : ''}</div>
        <small style="color:var(--tx-3)">استلام: ${Fmt.date(t.received_at)}</small>
      </div>
      <div class="detail-row"><span class="dr-label">العميل</span><span class="dr-val">${_esc(t.customer_name)} — <span dir="ltr">${_esc(t.phone || '—')}</span></span></div>
      <div class="detail-row"><span class="dr-label">الجهاز</span><span class="dr-val">${_esc([t.device_type, t.device_brand, t.device_model].filter(Boolean).join(' · '))}${t.imei ? ` — <span dir="ltr">${_esc(t.imei)}</span>` : ''}</span></div>
      <div class="detail-row"><span class="dr-label">العطل</span><span class="dr-val">${_esc(t.issue)}</span></div>
      ${t.accessories ? `<div class="detail-row"><span class="dr-label">المرفقات</span><span class="dr-val">${_esc(t.accessories)}</span></div>` : ''}
      <div class="divider"></div>
      <div class="form-row cols-3">
        <div class="form-group"><label class="form-label">الحالة</label>
          <select class="form-control" id="tkStatus" ${dis}>${STATUSES.map(s => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">الفني</label><select class="form-control" id="tkTech" ${dis}>${techOpts}</select></div>
        <div class="form-group"><label class="form-label">موعد التسليم</label><input class="form-control" id="tkPromised" type="date" value="${_esc(t.promised_date || '')}" ${dis}></div>
      </div>
      <div class="form-group"><label class="form-label">التشخيص / ما تم إصلاحه</label><textarea class="form-control" id="tkDiag" rows="2" ${dis}>${_esc(t.diagnosis || '')}</textarea></div>
      <div class="form-row cols-3">
        <div class="form-group"><label class="form-label">أجرة اليد العاملة</label><input class="form-control" id="tkLabor" type="number" min="0" step="0.01" value="${t.labor_cost || 0}" ${dis}></div>
        <div class="form-group"><label class="form-label">عربون مدفوع</label><input class="form-control" id="tkDeposit" type="number" min="0" step="0.01" value="${t.deposit || 0}" ${dis}></div>
        <div class="form-group" style="display:flex;align-items:flex-end"><label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="tkWarranty" ${t.in_warranty ? 'checked' : ''} ${dis}> تحت الضمان (بدون مقابل)</label></div>
      </div>
      <div style="font-weight:700;font-size:.88rem;margin:.6rem 0 .4rem"><i class="fas fa-microchip" style="color:var(--teal-500)"></i> قطع الغيار المستخدمة</div>
      <div class="tbl-wrap"><table class="dtable"><thead><tr><th>القطعة</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th><th></th></tr></thead>
        <tbody id="tkParts"></tbody></table></div>
      ${closed ? '' : `<div style="display:flex;gap:.5rem;margin-top:.5rem"><select class="form-control" id="tkPartSel" style="flex:1">${partOpts}</select>
        <button class="btn btn-outline btn-sm" id="tkAddPart"><i class="fas fa-plus"></i> إضافة</button></div>`}
      <div class="detail-row" style="margin-top:.8rem"><span class="dr-label">الإجمالي المستحق</span><span class="dr-val" id="tkTotal" style="font-weight:800;color:var(--teal-600)"></span></div>
      <div class="detail-row"><span class="dr-label">المتبقي بعد العربون</span><span class="dr-val" id="tkRemaining"></span></div>
      ${t.warranty_end ? `<div class="detail-row"><span class="dr-label">ضمان الصيانة</span><span class="dr-val">${Fmt.warrantyBadge(t.warranty_end)}</span></div>` : ''}
      <div class="divider"></div>
      <div style="font-weight:700;font-size:.88rem;margin-bottom:.4rem"><i class="fas fa-timeline" style="color:var(--teal-500)"></i> سجل التذكرة</div>
      <div style="max-height:150px;overflow:auto;font-size:.8rem">${(t.log || []).map(l => `<div style="padding:.25rem 0;border-bottom:1px solid var(--bd)">
        <span class="badge ${BADGE[l.status] || 'bdg-slate'}">${_esc(l.status || '')}</span> ${_esc(l.note || '')}
        <small style="color:var(--tx-3);float:left">${Fmt.date(l.created_at)}</small></div>`).join('')}</div>`;

    Modal.open({
      title: `<i class="fas fa-screwdriver-wrench"></i> ${_esc(t.ticket_num)} — ${_esc(t.customer_name)}`, size: 'lg', body,
      foot: `${closed ? '' : `<button class="btn btn-primary" id="tkSave"><i class="fas fa-floppy-disk"></i> حفظ</button>
        ${t.status === 'جاهز للتسليم' ? '<button class="btn btn-amber" id="tkDeliver"><i class="fas fa-hand-holding-dollar"></i> تسليم وفوترة</button>' : ''}
        <button class="btn btn-danger" id="tkCancel"><i class="fas fa-ban"></i> إلغاء التذكرة</button>`}
        <button class="btn btn-ghost" id="tkPrint"><i class="fas fa-print"></i> إيصال</button>
        <button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>`,
    });

    const $ = i => document.getElementById(i);
    let parts = (t.parts || []).map(p => ({ product_id: p.product_id, name: p.name, qty: p.qty, price: p.price }));
    const totals = () => {
      const partsTotal = parts.reduce((s, p) => s + p.qty * p.price, 0);
      const warranty = $('tkWarranty')?.checked;
      const total = warranty ? 0 : (parseFloat($('tkLabor')?.value) || 0) + partsTotal;
      $('tkTotal').textContent = warranty ? 'بدون مقابل (ضمان)' : Fmt.money(total);
      $('tkRemaining').textContent = Fmt.money(Math.max(0, total - (parseFloat($('tkDeposit')?.value) || 0)));
    };
    const drawParts = () => {
      $('tkParts').innerHTML = parts.length ? parts.map((p, i) => `<tr><td>${_esc(p.name)}</td>
        <td><input class="form-control" type="number" min="1" value="${p.qty}" data-qty="${i}" style="width:70px" ${dis}></td>
        <td><input class="form-control" type="number" min="0" step="0.01" value="${p.price}" data-price="${i}" style="width:90px" ${dis}></td>
        <td>${Fmt.money(p.qty * p.price)}</td>
        <td>${closed ? '' : `<button class="btn btn-ghost btn-icon sm" data-del="${i}"><i class="fas fa-trash"></i></button>`}</td></tr>`).join('')
        : '<tr><td colspan="5" style="color:var(--tx-3);text-align:center">لا توجد قطع</td></tr>';
      $('tkParts').querySelectorAll('[data-qty]').forEach(inp => inp.addEventListener('change', () => { parts[+inp.dataset.qty].qty = Math.max(1, parseInt(inp.value) || 1); drawParts(); }));
      $('tkParts').querySelectorAll('[data-price]').forEach(inp => inp.addEventListener('change', () => { parts[+inp.dataset.price].price = Math.max(0, parseFloat(inp.value) || 0); drawParts(); }));
      $('tkParts').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { parts.splice(+b.dataset.del, 1); drawParts(); }));
      totals();
    };
    drawParts();
    ['tkLabor', 'tkDeposit', 'tkWarranty'].forEach(i => $(i)?.addEventListener('input', totals));
    $('tkAddPart')?.addEventListener('click', () => {
      const sel = $('tkPartSel'); const pid = sel.value; if (!pid) return;
      const prod = _parts.find(p => p.id === pid); if (!prod) return;
      const existing = parts.find(p => p.product_id === pid);
      if (existing) existing.qty += 1; else parts.push({ product_id: pid, name: prod.name, qty: 1, price: prod.price });
      sel.value = ''; drawParts();
    });

    const collect = () => ({
      status: $('tkStatus').value, technician_id: $('tkTech').value || null, promised_date: $('tkPromised').value || null,
      diagnosis: $('tkDiag').value.trim(), labor_cost: parseFloat($('tkLabor').value) || 0, deposit: parseFloat($('tkDeposit').value) || 0,
      in_warranty: $('tkWarranty').checked, parts,
    });
    $('tkSave')?.addEventListener('click', async () => {
      try { await DB.updateRepair(id, collect()); Toast.ok('تم الحفظ', 'تم تحديث التذكرة'); Modal.close(); await _load(); }
      catch (e) { Toast.err('خطأ', e.message); }
    });
    $('tkPrint')?.addEventListener('click', () => _printTicket(t));
    $('tkCancel')?.addEventListener('click', () => {
      Modal.confirm('إلغاء التذكرة', `إلغاء ${t.ticket_num}؟ ${t.deposit > 0 ? `لا تنسَ رد العربون (${Fmt.money(t.deposit)}) للعميل.` : ''}`, async () => {
        try { await DB.cancelRepair(id, 'إلغاء من الشاشة'); Toast.ok('تم', 'تم إلغاء التذكرة'); await _load(); }
        catch (e) { Toast.err('خطأ', e.message); }
      });
    });
    $('tkDeliver')?.addEventListener('click', async () => {
      try { await DB.updateRepair(id, collect()); } catch (e) { Toast.err('خطأ', e.message); return; }   // نحفظ آخر تعديلات قبل الفوترة
      const fresh = await DB.getRepair(id);
      openDeliver(fresh);
    });
  }

  /* ══════════ التسليم والفوترة ══════════ */
  function openDeliver(t) {
    const free = t.in_warranty || (t.total <= 0 && !(t.parts || []).length);
    Modal.open({
      title: `<i class="fas fa-hand-holding-dollar"></i> تسليم ${_esc(t.ticket_num)}`, size: 'sm',
      body: free
        ? `<p>الصيانة تحت الضمان / بدون مقابل. سيُخصم استهلاك القطع من المخزون بدون فاتورة.</p>`
        : `<div class="detail-row"><span class="dr-label">الإجمالي</span><span class="dr-val" style="font-weight:800">${Fmt.money(t.total)}</span></div>
           <div class="detail-row"><span class="dr-label">العربون المدفوع</span><span class="dr-val">${Fmt.money(t.deposit || 0)}</span></div>
           <div class="detail-row"><span class="dr-label">المتبقي للتحصيل</span><span class="dr-val" style="color:var(--teal-600);font-weight:800">${Fmt.money(t.remaining)}</span></div>
           <div class="form-group" style="margin-top:.8rem"><label class="form-label">طريقة الدفع</label>
             <select class="form-control" id="dlvMethod"><option>نقدي</option><option>بطاقة</option><option>تحويل</option>${t.customer_id ? '<option>آجل</option>' : ''}</select></div>
           <div id="dlvCredit" style="display:none"><div class="form-group"><label class="form-label">دفع الآن</label><input class="form-control" id="dlvPaid" type="number" min="0" step="0.01" value="0"></div>
             <div class="form-group"><label class="form-label">تاريخ الاستحقاق</label><input class="form-control" id="dlvDue" type="date"></div></div>`,
      foot: `<button class="btn btn-primary" id="dlvOk"><i class="fas fa-check"></i> تأكيد التسليم</button><button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    const $ = i => document.getElementById(i);
    $('dlvMethod')?.addEventListener('change', () => { $('dlvCredit').style.display = $('dlvMethod').value === 'آجل' ? '' : 'none'; });
    $('dlvOk')?.addEventListener('click', async e => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const res = await DB.deliverRepair(t.id, free ? {} : {
          payment_method: $('dlvMethod').value, cashier: Auth?.getCurrent?.()?.fullName || '',
          credit_paid_amount: parseFloat($('dlvPaid')?.value) || 0, due_date: $('dlvDue')?.value || null,
        });
        Modal.close();
        Toast.ok('تم التسليم', res.invoiceNum ? `فاتورة ${res.invoiceNum} — المتبقي المحصّل ${Fmt.money(res.remaining)}` : 'تم التسليم بدون فاتورة');
        await _load();
      } catch (err) { Toast.err('خطأ', err.message); btn.disabled = false; }
    });
  }

  return { render, afterRender, openTicket };
})();
