/* ════════════════════════════════════════════════════════════
   PAGE: CUSTOMERS  (async)
════════════════════════════════════════════════════════════ */
'use strict';

const CustomersPage = (() => {
  let _search   = '';
  let _view     = 'cards';
  let _allPats  = [];
  let _allSales = [];

  function render() {
    return `
<div class="page active" id="page-customers">
  <div class="pg-header">
    <div class="pg-title-group">
      <h1 class="pg-title">
        <div class="pg-title-icon" style="background:var(--ok-light);color:var(--ok)"><i class="fas fa-users"></i></div>
        إدارة العملاء
      </h1>
      <p class="pg-subtitle">ملفات العملاء ومشترياتهم والمديونيات</p>
    </div>
    <div class="pg-actions">
      <button class="btn btn-ghost btn-sm" id="ptExportBtn"><i class="fas fa-download"></i> تصدير</button>
      <button class="btn btn-primary" id="ptAddBtn"><i class="fas fa-user-plus"></i> إضافة عميل</button>
    </div>
  </div>

  <div class="toolbar">
    <div class="tb-srch">
      <i class="fas fa-magnifying-glass"></i>
      <input type="search" id="ptSearch" placeholder="بحث بالاسم أو الهاتف..." />
    </div>
    <button class="btn btn-ghost btn-sm" id="ptViewToggle"><i class="fas fa-table-list"></i> جدول</button>
  </div>

  <div id="ptCards" class="g2" style="margin-bottom:1rem">
    ${Array(4).fill('<div class="skeleton" style="height:110px;border-radius:14px"></div>').join('')}
  </div>
  <div id="ptTable" class="card hidden">
    <div class="card-body p0">
      <div class="tbl-wrap">
        <table class="dtable">
          <thead><tr>
            <th>الكود</th><th>الاسم</th><th>الهاتف</th><th>النوع</th>
            <th>العنوان</th><th>تاريخ التسجيل</th><th>الإجراءات</th>
          </tr></thead>
          <tbody id="ptTbody"></tbody>
        </table>
      </div>
    </div>
    <div class="card-foot"><div class="pagination" id="ptPager"></div></div>
  </div>
</div>`;
  }

  async function afterRender() {
    document.getElementById('ptAddBtn')?.addEventListener('click', openAdd);
    document.getElementById('ptExportBtn')?.addEventListener('click', exportData);
    document.getElementById('ptSearch')?.addEventListener('input', debounce(e=>{_search=e.target.value.trim();renderView();},300));
    document.getElementById('ptViewToggle')?.addEventListener('click', ()=>{
      _view = _view==='cards'?'table':'cards';
      const btn=document.getElementById('ptViewToggle');
      btn.innerHTML=_view==='cards'?'<i class="fas fa-table-list"></i> جدول':'<i class="fas fa-id-card"></i> بطاقات';
      renderView();
    });
    await _load();
  }

  async function _load() {
    try {
      [_allPats, _allSales] = await Promise.all([DB.getCustomers(), DB.getSales()]);
      renderView();
    } catch(e) { Toast.err('خطأ',e.message); }
  }

  function _filtered() {
    let l = [..._allPats];
    // FEAT [1]: Arabic-aware search
    if (_search) {
      const q = normalizeArabicText(_search);
      l = l.filter(p =>
        normalizeArabicText(p.name).includes(q) ||
        p.phone.includes(_search)
      );
    }
    return l;
  }

  function renderView() {
    const list = _filtered();
    if (_view==='cards') {
      document.getElementById('ptCards')?.classList.remove('hidden');
      document.getElementById('ptTable')?.classList.add('hidden');
      _renderCards(list);
    } else {
      document.getElementById('ptCards')?.classList.add('hidden');
      document.getElementById('ptTable')?.classList.remove('hidden');
      _renderTable(list);
    }
  }

  function _renderCards(list) {
    const el=document.getElementById('ptCards');
    if (!el) return;
    if (!list.length) {
      el.innerHTML=`<div class="empty-state" style="grid-column:1/-1">
        <div class="es-icon"><i class="fas fa-users"></i></div>
        <h3 class="es-title">لا يوجد عملاء</h3>
        <button class="btn btn-primary btn-sm" id="emptyAddPt"><i class="fas fa-user-plus"></i> إضافة عميل</button>
      </div>`;
      document.getElementById('emptyAddPt')?.addEventListener('click', openAdd);
      return;
    }
    el.innerHTML = list.map(p=>{
      const color = getAvatarColor(p.name);
      const sales = _allSales.filter(s=>s.customerId===p.id);
      return `
      <div class="pt-card" data-id="${_esc(p.id)}">
        <div style="width:50px;height:50px;min-width:50px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:1.1rem;font-weight:700;color:#fff">${_esc(p.name.slice(0,2))}</div>
        <div class="pt-info">
          <div class="pt-name">${_esc(p.name)} ${p.customerType==='جملة'?'<span class="badge bdg-amb"><i class="fas fa-truck-fast"></i> جملة</span>':''}</div>
          <div class="pt-meta"><i class="fas fa-phone" style="font-size:.7rem"></i> ${_esc(p.phone)} ${p.address?` &nbsp;•&nbsp; ${_esc(p.address)}`:''}</div>
          <div class="pt-tags">
            <span class="badge bdg-slate"><i class="fas fa-receipt"></i> ${sales.length} فاتورة</span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:.4rem">
          <button class="btn btn-outline btn-icon sm" data-action="edit" data-id="${_esc(p.id)}" title="تعديل"><i class="fas fa-pen"></i></button>
          <button class="btn btn-danger btn-icon sm" data-action="del"  data-id="${_esc(p.id)}" title="حذف"><i class="fas fa-trash"></i></button>
        </div>
      </div>`;
    }).join('');

    el.querySelectorAll('.pt-card').forEach(card=>{
      card.addEventListener('click', e=>{
        if (e.target.closest('[data-action]')) return;
        viewPt(card.dataset.id);
      });
    });
    el.querySelectorAll('[data-action]').forEach(btn=>{
      btn.addEventListener('click', e=>{
        e.stopPropagation();
        if (btn.dataset.action==='edit') openEdit(btn.dataset.id);
        if (btn.dataset.action==='del')  deletePt(btn.dataset.id);
      });
    });
  }

  function _renderTable(list) {
    const tbody=document.getElementById('ptTbody');
    const pager=document.getElementById('ptPager');
    if (!tbody) return;
    if (!list.length) {
      tbody.innerHTML=`<tr><td colspan="7"><div class="empty-state"><div class="es-icon"><i class="fas fa-users"></i></div><h3 class="es-title">لا يوجد عملاء</h3></div></td></tr>`;
      if(pager)pager.innerHTML=''; return;
    }
    const pg=Paginator(list,8);
    const draw=()=>{
      tbody.innerHTML=pg.slice().map(p=>`
        <tr data-id="${_esc(p.id)}" style="cursor:pointer">
          <td><code style="font-size:.75rem">${_esc(p.id)}</code></td>
          <td class="font-bold">${_esc(p.name)} ${p.customerType==='جملة'?'<span class="badge bdg-amb" style="margin-inline-start:.3rem"><i class="fas fa-truck-fast"></i> جملة</span>':''}</td>
          <td dir="ltr">${_esc(p.phone)}</td>
          <td>${p.customerType==='جملة'?'جملة':'فرد'}</td>
          <td>${_esc(p.address||'—')}</td>
          <td>${Fmt.dateShort(p.createdAt)}</td>
          <td>
            <div class="td-actions">
              <button class="btn btn-outline btn-icon sm" data-action="edit" data-id="${_esc(p.id)}"><i class="fas fa-pen"></i></button>
              <button class="btn btn-danger btn-icon sm" data-action="del"  data-id="${_esc(p.id)}"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>`).join('');

      tbody.querySelectorAll('tr[data-id]').forEach(tr=>{
        tr.addEventListener('click', e=>{if(!e.target.closest('[data-action]')) viewPt(tr.dataset.id);});
      });
      tbody.querySelectorAll('[data-action]').forEach(btn=>{
        btn.addEventListener('click', e=>{ e.stopPropagation();
          if(btn.dataset.action==='edit') openEdit(btn.dataset.id);
          if(btn.dataset.action==='del')  deletePt(btn.dataset.id);
        });
      });
      pg.render(pager);
    };
    draw();
    document.getElementById('ptPager')?.addEventListener('click', draw);
  }

  function _formHTML(p={}) {
    const isWholesale = p.customerType === 'جملة';
    return `
    <div class="form-row cols-3">
      <div class="form-group"><label class="form-label">نوع العميل</label>
        <select class="form-control" id="fPtCustomerType">
          <option value="فرد" ${!isWholesale?'selected':''}>عميل فرد (تجزئة)</option>
          <option value="جملة" ${isWholesale?'selected':''}>عميل جملة (تاجر / محل)</option>
        </select></div>
      <div class="form-group" id="fPtCompanyWrap" style="${isWholesale?'':'display:none'}"><label class="form-label">اسم المنشأة / المحل</label>
        <input class="form-control" id="fPtCompanyName" value="${_esc(p.companyName||'')}" /></div>
      <div class="form-group" id="fPtTaxWrap" style="${isWholesale?'':'display:none'}"><label class="form-label">الرقم الضريبي</label>
        <input class="form-control" id="fPtTaxNum" value="${_esc(p.taxNum||'')}" /></div>
    </div>
    <div class="form-row cols-2">
      <div class="form-group"><label class="form-label">الاسم الكامل <span class="req">*</span></label>
        <input class="form-control" id="fPtName" value="${_esc(p.name||'')}" /></div>
      <div class="form-group"><label class="form-label">رقم الجوال <span class="req">*</span></label>
        <input class="form-control" id="fPtPhone" value="${_esc(p.phone||'')}" dir="ltr" /></div>
    </div>
    <div class="form-group"><label class="form-label">العنوان</label>
      <input class="form-control" id="fPtAddr" value="${_esc(p.address||'')}" /></div>
    <div class="form-row cols-2" id="fPtCreditWrap" style="${isWholesale?'':'display:none'}">
      <div class="form-group"><label class="form-label">سقف الائتمان (الآجل) <em style="font-weight:400;color:var(--tx-3)">— صفر = بدون حد</em></label>
        <input class="form-control" id="fPtCreditLimit" type="number" min="0" step="0.01" value="${p.creditLimit||0}"></div>
    </div>
    <div class="form-group"><label class="form-label">ملاحظات</label>
      <textarea class="form-control" id="fPtNotes" rows="2">${_esc(p.notes||'')}</textarea></div>`;
  }

  function openAdd() {
    Modal.open({
      title:'<i class="fas fa-user-plus"></i> إضافة عميل جديد',
      size:'lg', body:_formHTML(),
      foot:`<button class="btn btn-primary" id="savePtBtn"><i class="fas fa-check"></i> حفظ</button>
            <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    _wireCustomerTypeToggle();
    document.getElementById('savePtBtn')?.addEventListener('click',()=>_save(null));
  }

  function openEdit(id) {
    const p=_allPats.find(x=>x.id===id); if(!p) return;
    Modal.open({
      title:`<i class="fas fa-pen"></i> تعديل: ${_esc(p.name)}`,
      size:'lg', body:_formHTML(p),
      foot:`<button class="btn btn-primary" id="savePtBtn"><i class="fas fa-check"></i> حفظ</button>
            <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    _wireCustomerTypeToggle();
    document.getElementById('savePtBtn')?.addEventListener('click',()=>_save(id));
  }

  function _wireCustomerTypeToggle() {
    const sel=document.getElementById('fPtCustomerType');
    sel?.addEventListener('change', ()=>{
      const show = sel.value==='جملة';
      ['fPtCompanyWrap','fPtTaxWrap','fPtCreditWrap'].forEach(id=>{
        const el=document.getElementById(id); if(el) el.style.display = show?'':'none';
      });
    });
  }

  async function _save(id) {
    const v={
      name:            document.getElementById('fPtName')?.value.trim(),
      phone:           document.getElementById('fPtPhone')?.value.trim(),
      address:         document.getElementById('fPtAddr')?.value.trim(),
      notes:           document.getElementById('fPtNotes')?.value.trim(),
      customerType:    document.getElementById('fPtCustomerType')?.value||'فرد',
      companyName:     document.getElementById('fPtCompanyName')?.value.trim(),
      taxNum:          document.getElementById('fPtTaxNum')?.value.trim(),
      creditLimit:     Math.max(0,parseFloat(document.getElementById('fPtCreditLimit')?.value)||0),
    };
    if(!v.name||!v.phone){Toast.err('بيانات ناقصة','الاسم والهاتف مطلوبان');return;}
    try {
      if(id){await DB.updateCustomer(id,v);Toast.ok('تم التحديث',`تم تعديل ${v.name}`);}
      else  {await DB.addCustomer(v);      Toast.ok('تمت الإضافة',`تمت إضافة ${v.name}`);}
      Modal.close(); await _load();
    } catch(e){Toast.err('خطأ',e.message);}
  }

  function viewPt(id) {
    const p=_allPats.find(x=>x.id===id); if(!p) return;
    const sales=_allSales.filter(s=>s.customerId===id);
    const color=getAvatarColor(p.name);
    Modal.open({
      title:`<i class="fas fa-user"></i> ${_esc(p.name)}`,
      size:'lg',
      body:`
        <div style="display:flex;gap:1rem;align-items:flex-start;margin-bottom:1rem">
          <div style="width:62px;height:62px;min-width:62px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:1.4rem;font-weight:700;color:#fff">${_esc(p.name.slice(0,2))}</div>
          <div>
            <div style="font-size:1.1rem;font-weight:700">${_esc(p.name)}</div>
            <div style="color:var(--tx-3);font-size:.82rem;margin-top:3px" dir="ltr">${_esc(p.phone)}</div>
          </div>
        </div>
        <div class="detail-row"><span class="dr-label">الجوال</span><span class="dr-val" dir="ltr">${_esc(p.phone)}</span></div>
        <div class="detail-row"><span class="dr-label">نوع العميل</span><span class="dr-val">${p.customerType==='جملة'?`<span class="badge bdg-amb"><i class="fas fa-truck-fast"></i> عميل جملة</span> ${_esc(p.companyName||'')}`:'عميل فرد (تجزئة)'}</span></div>
        ${p.customerType==='جملة'?`<div class="detail-row"><span class="dr-label">سقف الائتمان</span><span class="dr-val">${p.creditLimit>0?Fmt.money(p.creditLimit):'بدون حد'}</span></div>`:''}
        <div class="detail-row"><span class="dr-label">العنوان</span><span class="dr-val">${_esc(p.address||'—')}</span></div>
        <div class="detail-row"><span class="dr-label">الملاحظات</span><span class="dr-val">${_esc(p.notes||'—')}</span></div>
        <div class="detail-row"><span class="dr-label">تاريخ التسجيل</span><span class="dr-val">${Fmt.date(p.createdAt)}</span></div>
        <div class="divider"></div>
        <div style="font-weight:700;font-size:.88rem;margin-bottom:.75rem"><i class="fas fa-receipt" style="color:var(--teal-500)"></i> سجل المشتريات (${sales.length})</div>
        <div id="ptWarrantyBox"></div>
        ${sales.length?`<div class="tbl-wrap"><table class="dtable">
          <thead><tr><th>الفاتورة</th><th>التاريخ</th><th>الإجمالي</th><th>الدفع</th></tr></thead>
          <tbody>${sales.map(s=>`<tr>
            <td>${_esc(s.invoiceNum)}</td><td>${Fmt.dateShort(s.date)}</td>
            <td style="font-weight:700;color:var(--teal-600)">${Fmt.money(s.total)}</td>
            <td><span class="badge bdg-teal">${_esc(s.paymentMethod)}</span></td>
          </tr>`).join('')}</tbody>
        </table></div>`:`<p style="color:var(--tx-3);font-size:.84rem">لا توجد فواتير بعد</p>`}`,
      foot:`<button class="btn btn-outline" onclick="window.open('/api/customer_statement_pdf/${id}','_blank')"><i class="fas fa-file-invoice-dollar"></i> كشف حساب PDF</button>
            <button class="btn btn-outline" onclick="Modal.close();CustomersPage.openEdit('${id}')"><i class="fas fa-pen"></i> تعديل</button>
            <button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>`,
    });
    _loadWarrantyBox(p);
  }

  async function _loadWarrantyBox(p) {
    const box=document.getElementById('ptWarrantyBox'); if(!box) return;
    const q=(p.phone||'').length>=3?p.phone:p.name;
    try {
      const rows=(await DB.searchWarranty(q)).filter(r=>r.customer_name===p.name&&r.sale_status!=='ملغاة').slice(0,8);
      if(!rows.length){box.innerHTML='';return;}
      box.innerHTML=`<div style="font-weight:700;font-size:.88rem;margin:.9rem 0 .5rem"><i class="fas fa-shield-halved" style="color:var(--teal-500)"></i> الأجهزة والضمانات</div>
        <div class="tbl-wrap"><table class="dtable"><thead><tr><th>الصنف</th><th>IMEI</th><th>الفاتورة</th><th>الضمان</th></tr></thead>
        <tbody>${rows.map(r=>`<tr><td>${_esc(r.name)}</td><td dir="ltr" style="font-size:.75rem">${(r.serials||[]).map(_esc).join('<br>')||'—'}</td>
        <td>${_esc(r.invoice_num)}</td><td>${Fmt.warrantyBadge(r.warranty_end)}</td></tr>`).join('')}</tbody></table></div>`;
    } catch(_) { /* بدون صلاحية أو لا توجد بيانات */ }
  }

  function deletePt(id) {
    const p=_allPats.find(x=>x.id===id); if(!p) return;
    Modal.confirm('حذف العميل',`هل تريد حذف ${p.name}؟`, async()=>{
      try{await DB.deleteCustomer(id);Toast.ok('تم الحذف',`تم حذف ${p.name}`);await _load();}
      catch(e){Toast.err('خطأ',e.message);}
    });
  }

  function exportData() {
    exportCSV('العملاء',
      ['الكود','الاسم','الهاتف','العنوان','نوع_العميل','اسم_المنشأة','سقف_الائتمان'],
      _allPats.map(p=>[p.id,p.name,p.phone,p.address,p.customerType||'فرد',p.companyName||'',p.creditLimit||0])
    );
  }

  return { render, afterRender, openAdd, openEdit, viewPt };
})();
