/* ════════════════════════════════════════════════════════════
   PAGE: PROMOTIONS — العروض والخصومات
   عروض خصم (نسبة أو مبلغ ثابت) على أصناف معينة، بحد أدنى للكمية
   وفترة سريان اختيارية، تُطبَّق تلقائيًا في نقطة البيع.
════════════════════════════════════════════════════════════ */
'use strict';

const PromotionsPage = (() => {
  let _promotions = [], _products = [];
  const canManage = () => ['مدير النظام', 'مشرف المحل'].includes(Auth.getCurrent()?.role);

  function render() {
    return `
<div class="page active" id="page-promotions">
  <div class="pg-header">
    <div class="pg-title-group">
      <h1 class="pg-title">
        <div class="pg-title-icon" style="background:#fef3c7;color:#b45309"><i class="fas fa-tags"></i></div>
        العروض والخصومات
      </h1>
      <p class="pg-subtitle">خصومات مؤقتة على أصناف معينة، تُطبَّق تلقائيًا عند البيع</p>
    </div>
    <div class="pg-actions">
      <button class="btn btn-primary" id="addPromoBtn" ${canManage()?'':'style="display:none"'}><i class="fas fa-plus"></i> عرض جديد</button>
    </div>
  </div>
  <div id="promoContent">
    <div class="empty-state"><div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div><h3 class="es-title">جارٍ التحميل...</h3></div>
  </div>
</div>`;
  }

  async function afterRender() {
    document.getElementById('addPromoBtn')?.addEventListener('click', () => _promoForm());
    await _load();
  }

  async function _load() {
    try {
      const [promos, products] = await Promise.all([DB.getPromotions(), DB.getProducts()]);
      _promotions = promos || []; _products = products || [];
      _renderList();
    } catch (e) { Toast.err('خطأ', e.message); }
  }

  function _isCurrentlyActive(p) {
    if (!p.is_active) return false;
    const today = new Date().toISOString().slice(0, 10);
    if (p.start_date && p.start_date > today) return false;
    if (p.end_date && p.end_date < today) return false;
    return true;
  }

  function _renderList() {
    const el = document.getElementById('promoContent'); if (!el) return;
    if (!_promotions.length) {
      el.innerHTML = `<div class="empty-state">
        <div class="es-icon"><i class="fas fa-tags"></i></div>
        <h3 class="es-title">لا توجد عروض بعد</h3>
        <p class="es-desc">أنشئ عرضًا لتصريف مخزون قريب من الانتهاء أو لتحفيز المبيعات</p>
      </div>`;
      return;
    }
    el.innerHTML = `<div class="card"><div class="card-body p0"><div class="tbl-wrap"><table class="dtable">
      <thead><tr><th>العرض</th><th>الصنف</th><th>الخصم</th><th>أقل كمية</th><th>الفترة</th><th>الحالة</th><th>الإجراءات</th></tr></thead>
      <tbody>${_promotions.map(p => {
        const active = _isCurrentlyActive(p);
        const discountText = p.discount_type === 'percent' ? `${p.discount_value}%` : Fmt.money(p.discount_value);
        const effPrice = p.discount_type === 'percent' ? p.product_price * (1 - p.discount_value / 100) : Math.max(0, p.product_price - p.discount_value);
        return `<tr>
          <td class="font-bold">${_esc(p.name)}</td>
          <td>${_esc(p.product_name)}<br><small style="color:var(--tx-3)">${Fmt.money(p.product_price)} ← <span style="color:var(--teal-600);font-weight:700">${Fmt.money(effPrice)}</span></small></td>
          <td>${discountText}</td>
          <td>${Fmt.num(p.min_qty)} ${_esc(p.unit||'')}</td>
          <td style="font-size:.78rem">${p.start_date||'—'} إلى ${p.end_date||'بلا نهاية'}</td>
          <td><span class="badge ${active?'bdg-ok':p.is_active?'bdg-slate':'bdg-err'}">${active?'نشط الآن':p.is_active?'مجدول/منتهي':'موقوف'}</span></td>
          <td>${canManage()?`<div class="td-actions">
            <button class="btn btn-outline btn-icon sm" data-edit="${_esc(p.id)}"><i class="fas fa-pen"></i></button>
            <button class="btn btn-danger btn-icon sm" data-del="${_esc(p.id)}"><i class="fas fa-trash"></i></button>
          </div>`:'—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div></div></div>`;
    el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => _promoForm(_promotions.find(p=>p.id===b.dataset.edit))));
    el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      Modal.confirm('حذف العرض', 'هل تريد حذف هذا العرض؟', async () => {
        try { await DB.deletePromotion(b.dataset.del); Toast.ok('تم', 'تم الحذف'); await _load(); }
        catch (e) { Toast.err('خطأ', e.message); }
      });
    }));
  }

  function _promoForm(p = null) {
    const productOptions = _products.map(m => `<option value="${_esc(m.id)}" ${p?.product_id===m.id?'selected':''}>${_esc(m.name)} (${Fmt.money(m.price)})</option>`).join('');
    Modal.open({
      title: p ? '<i class="fas fa-pen"></i> تعديل عرض' : '<i class="fas fa-tags"></i> عرض جديد',
      body: `
      <div class="form-group"><label class="form-label">اسم العرض <span class="req">*</span></label>
        <input class="form-control" id="pmName" value="${_esc(p?.name||'')}" placeholder="خصم تصريف مخزون"></div>
      <div class="form-group"><label class="form-label">الصنف <span class="req">*</span></label>
        <select class="form-control" id="pmProduct">${productOptions}</select></div>
      <div class="form-row cols-2">
        <div class="form-group"><label class="form-label">نوع الخصم</label>
          <select class="form-control" id="pmType">
            <option value="percent" ${p?.discount_type==='percent'||!p?'selected':''}>نسبة مئوية %</option>
            <option value="fixed" ${p?.discount_type==='fixed'?'selected':''}>مبلغ ثابت</option>
          </select></div>
        <div class="form-group"><label class="form-label">قيمة الخصم</label>
          <input class="form-control" id="pmValue" type="number" min="0" step="0.01" value="${p?.discount_value||0}"></div>
      </div>
      <div class="form-group"><label class="form-label">أقل كمية لتفعيل العرض</label>
        <input class="form-control" id="pmMinQty" type="number" min="1" value="${p?.min_qty||1}"></div>
      <div class="form-row cols-2">
        <div class="form-group"><label class="form-label">من تاريخ (اختياري)</label><input class="form-control" id="pmStart" type="date" value="${p?.start_date||''}"></div>
        <div class="form-group"><label class="form-label">إلى تاريخ (اختياري)</label><input class="form-control" id="pmEnd" type="date" value="${p?.end_date||''}"></div>
      </div>
      ${p ? `<label style="display:flex;align-items:center;gap:.5rem;font-size:.85rem"><input type="checkbox" id="pmActive" ${p.is_active?'checked':''}> العرض مفعّل</label>` : ''}`,
      foot: `<button class="btn btn-primary" id="pmSaveBtn"><i class="fas fa-check"></i> حفظ</button>
             <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });
    document.getElementById('pmSaveBtn')?.addEventListener('click', async () => {
      const payload = {
        name: document.getElementById('pmName').value.trim(),
        productId: document.getElementById('pmProduct').value,
        discountType: document.getElementById('pmType').value,
        discountValue: parseFloat(document.getElementById('pmValue').value) || 0,
        minQty: parseInt(document.getElementById('pmMinQty').value) || 1,
        startDate: document.getElementById('pmStart').value || null,
        endDate: document.getElementById('pmEnd').value || null,
        isActive: document.getElementById('pmActive') ? document.getElementById('pmActive').checked : true,
      };
      if (!payload.name || !payload.productId) { Toast.err('بيانات ناقصة', 'اسم العرض والصنف مطلوبان'); return; }
      try {
        if (p) await DB.updatePromotion(p.id, payload); else await DB.addPromotion(payload);
        Toast.ok('تم', 'تم حفظ العرض'); Modal.close(); await _load();
      } catch (e) { Toast.err('خطأ', e.message); }
    });
  }

  return { render, afterRender };
})();
