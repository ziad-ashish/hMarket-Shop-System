/* ════════════════════════════════════════════════════════════
   PAGE: WARRANTY & IMEI — الضمان وأرقام IMEI
   بحث بالـ IMEI أو رقم الفاتورة أو تليفون/اسم العميل أو اسم الصنف
════════════════════════════════════════════════════════════ */
'use strict';

const WarrantyPage = (() => {
  function render() {
    return `
<div class="page active" id="page-warranty">
  <div class="pg-header">
    <div class="pg-title-group">
      <h1 class="pg-title">
        <div class="pg-title-icon" style="background:var(--ok-light);color:var(--ok)"><i class="fas fa-shield-halved"></i></div>
        الضمان وأرقام IMEI
      </h1>
      <p class="pg-subtitle">تحقق من حالة ضمان أي جهاز وتاريخ بيعه وسجل صيانته</p>
    </div>
  </div>

  <div class="card" style="margin-bottom:1rem"><div class="card-body">
    <div style="display:flex;gap:.6rem;flex-wrap:wrap">
      <div class="tb-srch" style="flex:1;min-width:260px"><i class="fas fa-magnifying-glass"></i>
        <input type="search" id="wrSearch" placeholder="امسح أو اكتب IMEI / رقم الفاتورة / تليفون العميل / الاسم..." autofocus /></div>
      <button class="btn btn-primary" id="wrBtn"><i class="fas fa-search"></i> بحث</button>
      <button class="btn btn-ghost" id="wrCam"><i class="fas fa-camera"></i> مسح</button>
    </div>
  </div></div>

  <div id="wrResult"><div class="empty-state"><div class="es-icon"><i class="fas fa-shield-halved"></i></div>
    <h3 class="es-title">ابدأ بإدخال رقم IMEI أو بيانات العميل</h3></div></div>
</div>`;
  }

  async function afterRender() {
    const input = document.getElementById('wrSearch');
    document.getElementById('wrBtn')?.addEventListener('click', () => search(input.value));
    input?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(input.value); } });
    document.getElementById('wrCam')?.addEventListener('click', () => CameraStudio.open({
      mode: 'scan', title: 'مسح IMEI / رقم الفاتورة', acceptLabel: 'بحث',
      lookup: async code => ({ title: 'تمت القراءة', detail: code, code }),
      onAccept: async (_r, code) => { input.value = code; CameraStudio.close(); search(code); },
    }));
    input?.focus();
  }

  async function search(raw) {
    const q = String(raw || '').trim();
    const host = document.getElementById('wrResult'); if (!host) return;
    if (q.length < 3) { Toast.warn('اكتب 3 أحرف/أرقام على الأقل'); return; }
    host.innerHTML = `<div class="empty-state"><div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div></div>`;
    try {
      const looksSerial = /^[A-Za-z0-9]{8,40}$/.test(q) && /\d/.test(q);
      const [unitRes, rows] = await Promise.all([
        looksSerial ? DB.lookupSerial(q).catch(() => null) : Promise.resolve(null),
        DB.searchWarranty(q).catch(() => []),
      ]);
      host.innerHTML = (unitRes?.found ? _unitCard(unitRes) : (unitRes && unitRes.repairs?.length ? _repairsOnly(unitRes) : '')) + _resultsTable(rows);
      host.querySelectorAll('[data-ticket]').forEach(b => b.addEventListener('click', () => { App.navigate('repairs'); setTimeout(() => RepairsPage.openTicket(b.dataset.ticket), 350); }));
    } catch (e) { host.innerHTML = ''; Toast.err('خطأ', e.message); }
  }

  function _unitCard(r) {
    const u = r.unit;
    const sold = u.status === 'مباع';
    const badge = sold ? Fmt.warrantyBadge(u.warranty_end) : `<span class="badge bdg-ok">${_esc(u.status)} بالمخزون</span>`;
    return `
    <div class="card" style="margin-bottom:1rem"><div class="card-body">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:.6rem;align-items:center">
        <div><div style="font-size:1.1rem;font-weight:800">${_esc(u.product_name)}</div>
          <div dir="ltr" style="color:var(--tx-3)">${_esc(u.serial)}${u.serial2 ? ` / ${_esc(u.serial2)}` : ''}</div></div>
        <div style="font-size:1rem">${badge}</div>
      </div>
      <div class="divider"></div>
      <div class="detail-row"><span class="dr-label">الحالة</span><span class="dr-val">${_esc(u.status)}</span></div>
      ${u.variant ? `<div class="detail-row"><span class="dr-label">المواصفات</span><span class="dr-val">${_esc(u.variant)}</span></div>` : ''}
      ${sold ? `
        <div class="detail-row"><span class="dr-label">العميل</span><span class="dr-val">${_esc(u.customer_name || '—')}</span></div>
        <div class="detail-row"><span class="dr-label">الفاتورة</span><span class="dr-val">${_esc(r.sale?.invoice_num || '—')} ${r.sale?.status === 'ملغاة' ? '<span class="badge bdg-err">ملغاة</span>' : ''}</span></div>
        <div class="detail-row"><span class="dr-label">تاريخ البيع</span><span class="dr-val">${u.sold_date ? Fmt.date(u.sold_date) : '—'}</span></div>
        <div class="detail-row"><span class="dr-label">مدة الضمان</span><span class="dr-val">${u.warranty_months ? `${u.warranty_months} شهر — حتى ${Fmt.date(u.warranty_end)}` : 'بدون ضمان'}</span></div>` : ''}
      ${_repairsList(r.repairs)}
    </div></div>`;
  }

  function _repairsOnly(r) {
    return `<div class="card" style="margin-bottom:1rem"><div class="card-body">
      <div style="font-weight:700">الجهاز غير مسجل في مبيعات المحل ولكن له سجل صيانة</div>${_repairsList(r.repairs)}</div></div>`;
  }

  function _repairsList(repairs) {
    if (!repairs?.length) return '';
    return `<div class="divider"></div><div style="font-weight:700;font-size:.88rem;margin-bottom:.4rem"><i class="fas fa-screwdriver-wrench" style="color:var(--teal-500)"></i> سجل الصيانة</div>
      ${repairs.map(x => `<div style="display:flex;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid var(--bd);font-size:.84rem">
        <span><button class="btn btn-ghost btn-sm" data-ticket="${_esc(x.id)}">${_esc(x.ticket_num)}</button> ${_esc(x.issue)}</span>
        <span><span class="badge bdg-slate">${_esc(x.status)}</span> ${x.in_warranty ? '<span class="badge bdg-ok">ضمان</span>' : ''}</span></div>`).join('')}`;
  }

  function _resultsTable(rows) {
    if (!rows.length) return `<div class="empty-state"><h3 class="es-title">لا توجد فواتير بضمان مطابقة</h3></div>`;
    return `<div class="card"><div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
      <thead><tr><th>الفاتورة</th><th>التاريخ</th><th>العميل</th><th>الصنف</th><th>IMEI / Serial</th><th>الضمان</th></tr></thead>
      <tbody>${rows.map(r => `<tr ${r.sale_status === 'ملغاة' ? 'style="opacity:.55"' : ''}>
        <td><strong>${_esc(r.invoice_num)}</strong>${r.sale_status === 'ملغاة' ? ' <span class="badge bdg-err">ملغاة</span>' : ''}</td>
        <td>${Fmt.dateShort(r.sale_date)}</td>
        <td>${_esc(r.customer_name || '—')}<small style="display:block;color:var(--tx-3)" dir="ltr">${_esc(r.customer_phone || '')}</small></td>
        <td>${_esc(r.name)}</td>
        <td dir="ltr" style="font-size:.75rem">${(r.serials || []).map(_esc).join('<br>') || '—'}</td>
        <td>${r.sale_status === 'ملغاة' ? '—' : Fmt.warrantyBadge(r.warranty_end)}<small style="display:block;color:var(--tx-3)">${r.warranty_months} شهر</small></td>
      </tr>`).join('')}</tbody></table></div></div></div>`;
  }

  return { render, afterRender };
})();
