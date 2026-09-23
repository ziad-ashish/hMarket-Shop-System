/* ════════════════════════════════════════════════════════════
   PAGE: PURCHASES — نظام المشتريات
   • عرض أوامر الشراء مع حالتها
   • إنشاء أمر شراء جديد من كشكول النواقص أو يدوياً
   • استلام البضاعة وتحديث المخزون تلقائياً
   • إلغاء أمر شراء
════════════════════════════════════════════════════════════ */
'use strict';

const PurchasesPage = (() => {
  let _all      = [];
  let _search   = '';
  let _filter   = 'all';

  function render() {
    return `
<div class="page active" id="page-purchases">
  <div class="pg-header">
    <div class="pg-title-group">
      <h1 class="pg-title">
        <div class="pg-title-icon" style="background:#fef3c7;color:#b45309"><i class="fas fa-cart-flatbed"></i></div>
        أوامر الشراء
      </h1>
      <p class="pg-subtitle">إدارة طلبيات الشراء من الموردين</p>
    </div>
    <div class="pg-actions">
      <button class="btn btn-ghost btn-sm" id="poExportBtn"><i class="fas fa-download"></i> تصدير</button>
      <button class="btn btn-amber" id="poAddBtn"><i class="fas fa-plus"></i> أمر شراء جديد</button>
    </div>
  </div>

  <!-- إحصاء -->
  <div class="stats-grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr));margin-bottom:1.2rem" id="poStats"></div>

  <!-- تبويبات الحالة -->
  <div class="tabs" id="poTabs" style="margin-bottom:.8rem">
    <button class="tab-btn active" data-pf="all">الكل</button>
    <button class="tab-btn" data-pf="مفتوح">مفتوحة</button>
    <button class="tab-btn" data-pf="مستلم جزئياً">جزئي</button>
    <button class="tab-btn" data-pf="مستلم">مستلمة</button>
    <button class="tab-btn" data-pf="ملغي">ملغاة</button>
  </div>

  <div class="card">
    <div class="card-head">
      <div class="tb-srch">
        <i class="fas fa-magnifying-glass"></i>
        <input type="search" id="poSearch" placeholder="بحث بالرقم أو المورد..." />
      </div>
    </div>
    <div class="card-body p0">
      <div class="tbl-wrap">
        <table class="dtable">
          <thead><tr>
            <th>رقم الأمر</th><th>المورد</th><th>التاريخ</th><th>الأصناف</th>
            <th>الإجمالي</th><th>الحالة</th><th>الإجراءات</th>
          </tr></thead>
          <tbody id="poTbody">
            <tr><td colspan="7"><div class="empty-state">
              <div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div>
              <h3 class="es-title">جارٍ التحميل...</h3>
            </div></td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="card-foot"><div class="pagination" id="poPager"></div></div>
  </div>
</div>`;
  }

  async function afterRender() {
    document.getElementById('poAddBtn')?.addEventListener('click', openAddModal);
    document.getElementById('poExportBtn')?.addEventListener('click', exportData);
    document.getElementById('poSearch')?.addEventListener('input', debounce(e => {
      _search = e.target.value.trim(); renderTable();
    }, 300));
    document.getElementById('poTabs')?.addEventListener('click', e => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      _filter = btn.dataset.pf;
      document.querySelectorAll('#poTabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTable();
    });
    await _load();
  }

  async function _load() {
    try {
      _all = await DB.getPurchases() || [];

      const open    = _all.filter(p => p.status === 'مفتوح');
      const partial = _all.filter(p => p.status === 'مستلم جزئياً');
      const done    = _all.filter(p => p.status === 'مستلم');
      const total   = _all.reduce((a, p) => a + (p.total_cost || 0), 0);

      document.getElementById('poStats').innerHTML = `
        <div class="stat-card c-amber"><div class="sc-header"><div class="sc-icon"><i class="fas fa-cart-flatbed"></i></div></div><div class="sc-val">${_all.length}</div><div class="sc-label">إجمالي الأوامر</div></div>
        <div class="stat-card c-err"><div class="sc-header"><div class="sc-icon"><i class="fas fa-clock"></i></div></div><div class="sc-val">${open.length}</div><div class="sc-label">مفتوحة</div></div>
        <div class="stat-card c-warn"><div class="sc-header"><div class="sc-icon"><i class="fas fa-box-open"></i></div></div><div class="sc-val">${partial.length}</div><div class="sc-label">مستلمة جزئياً</div></div>
        <div class="stat-card c-ok"><div class="sc-header"><div class="sc-icon"><i class="fas fa-check"></i></div></div><div class="sc-val">${done.length}</div><div class="sc-label">مستلمة بالكامل</div></div>`;

      // badges التبويبات
      const tabs = document.querySelectorAll('#poTabs .tab-btn');
      if (tabs[0]) tabs[0].innerHTML = `الكل <span class="badge bdg-slate">${_all.length}</span>`;
      if (tabs[1]) tabs[1].innerHTML = `مفتوحة <span class="badge bdg-err">${open.length}</span>`;
      if (tabs[3]) tabs[3].innerHTML = `مستلمة <span class="badge bdg-ok">${done.length}</span>`;

      renderTable();
    } catch(e) { Toast.err('خطأ', e.message); }
  }

  function renderTable() {
    const tbody = document.getElementById('poTbody');
    const pager = document.getElementById('poPager');
    if (!tbody) return;

    let list = [..._all];
    if (_filter !== 'all') list = list.filter(p => p.status === _filter);
    if (_search) {
      const q = _search.toLowerCase();
      list = list.filter(p =>
        (p.po_num || '').toLowerCase().includes(q) ||
        (p.supplier_name || '').toLowerCase().includes(q)
      );
    }

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
        <div class="es-icon"><i class="fas fa-cart-flatbed"></i></div>
        <h3 class="es-title">لا توجد أوامر شراء</h3>
      </div></td></tr>`;
      if (pager) pager.innerHTML = ''; return;
    }

    const statusColor = { 'مفتوح': 'bdg-warn', 'مستلم جزئياً': 'bdg-amber', 'مستلم': 'bdg-ok', 'ملغي': 'bdg-err' };

    const pg = Paginator(list, 12);
    const draw = () => {
      tbody.innerHTML = pg.slice().map(p => `
        <tr>
          <td><strong>${p.po_num}</strong></td>
          <td>${p.supplier_name || '—'}</td>
          <td>${Fmt.dateShort(p.created_at ? p.created_at.split('T')[0] : '')}</td>
          <td>${(p.items || []).length} صنف</td>
          <td style="font-weight:700;color:var(--teal-600)">${Fmt.money(p.total_cost)}</td>
          <td><span class="badge ${statusColor[p.status] || 'bdg-slate'}">${p.status}</span></td>
          <td>
            <div class="td-actions">
              <button class="btn btn-ghost btn-icon sm" data-action="view"    data-id="${p.id}" title="عرض"><i class="fas fa-eye"></i></button>
              ${p.status !== 'مستلم' && p.status !== 'ملغي' ?
                `<button class="btn btn-ghost btn-icon sm" data-action="receive" data-id="${p.id}" title="استلام البضاعة" style="color:var(--ok)"><i class="fas fa-box-open"></i></button>
                 <button class="btn btn-ghost btn-icon sm" data-action="cancel"  data-id="${p.id}" data-num="${p.po_num}" title="إلغاء" style="color:var(--err)"><i class="fas fa-ban"></i></button>`
                : ''}
            </div>
          </td>
        </tr>`).join('');

      tbody.querySelectorAll('[data-action]').forEach(btn => {
        const p = _all.find(x => x.id === btn.dataset.id);
        btn.addEventListener('click', () => {
          if (btn.dataset.action === 'view')    _viewPO(p);
          if (btn.dataset.action === 'receive') _receiveModal(p);
          if (btn.dataset.action === 'cancel')  _cancelPO(btn.dataset.id, btn.dataset.num);
        });
      });
      pg.render(pager);
    };
    draw();
    pager?.addEventListener('click', draw);
  }

  /* ── عرض تفاصيل الأمر ─────────────────────────────── */
  function _viewPO(p) {
    const statusColor = { 'مفتوح': '#b45309', 'مستلم جزئياً': '#d97706', 'مستلم': '#16a34a', 'ملغي': '#dc2626' };
    const body = `
      <div style="margin-bottom:1rem">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
          <span style="font-size:1rem;font-weight:800">${p.po_num}</span>
          <span style="color:${statusColor[p.status] || '#64748b'};font-weight:700">${p.status}</span>
        </div>
        <div style="font-size:.82rem;color:var(--tx-3)">
          المورد: <strong>${p.supplier_name || '—'}</strong> |
          تاريخ الإنشاء: <strong>${p.created_at ? p.created_at.split('T')[0] : '—'}</strong>
          ${p.received_at ? ` | تاريخ الاستلام: <strong>${p.received_at.split('T')[0]}</strong>` : ''}
        </div>
        ${p.notes ? `<div style="font-size:.8rem;color:var(--tx-3);margin-top:.4rem">ملاحظات: ${p.notes}</div>` : ''}
      </div>
      <table class="dtable">
        <thead><tr><th>الصنف</th><th>الكمية المطلوبة</th><th>الكمية المستلمة</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>
        <tbody>
          ${(p.items || []).map(i => `<tr>
            <td>${i.product_name}<small style="display:block">${i.purchase_unit||"وحدة شراء"} = ${i.conversion_factor||1} ${i.sale_unit||"وحدة بيع"}</small></td>
            <td>${i.qty_ordered}</td>
            <td style="color:${i.qty_received >= i.qty_ordered ? 'var(--ok)' : 'var(--warn)'}">${i.qty_received}</td>
            <td>${Fmt.money(i.unit_cost)}</td>
            <td>${Fmt.money(i.total_cost)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="4" style="font-weight:700;text-align:left">الإجمالي</td>
          <td style="font-weight:800;color:var(--teal-600)">${Fmt.money(p.total_cost)}</td>
        </tr></tfoot>
      </table>`;

    Modal.open({
      title: `<i class="fas fa-cart-flatbed"></i> ${p.po_num}`,
      size: 'lg',
      body,
      foot: `${p.status !== 'مستلم' && p.status !== 'ملغي' ?
        `<button class="btn btn-primary" id="receiveFromViewBtn"><i class="fas fa-box-open"></i> استلام البضاعة</button>` : ''}
        <button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>`,
    });
    document.getElementById('receiveFromViewBtn')?.addEventListener('click', () => {
      Modal.close(); _receiveModal(p);
    });
  }

  /* ── استلام البضاعة ─────────────────────────────────── */
  function _receiveModal(p) {
    const open = (p.items || []).filter(i => i.qty_received < i.qty_ordered);
    const body = `
      <button type="button" class="btn btn-ghost" id="receiveCameraBtn"><i class="fas fa-camera"></i> مراجعة الكميات بالكاميرا</button>
      <p style="font-size:.82rem;color:var(--tx-3);margin:.6rem 0 1rem">
        كل الكميات والتكاليف أدناه لوحدة الشراء المسجلة بالأمر. الأجهزة المتتبعة بـ IMEI تُستلم بأرقامها (رقم في كل سطر) وعددها يجب أن يساوي الكمية الجديدة.
      </p>
      <table class="dtable">
        <thead><tr><th>الصنف</th><th>مطلوب</th><th>مستلم سابقاً</th><th>كمية جديدة</th><th>تكلفة وحدة الشراء</th></tr></thead>
        <tbody>
          ${open.map(i => `<tr>
            <td>${_esc(i.product_name)}<small style="display:block">${_esc(i.purchase_unit || 'وحدة شراء')} = ${i.conversion_factor || 1} ${_esc(i.sale_unit || 'وحدة بيع')}</small></td>
            <td>${i.qty_ordered}</td>
            <td>${i.qty_received}</td>
            <td><input type="number" min="0" max="${i.qty_ordered - i.qty_received}" value="${i.qty_ordered - i.qty_received}"
                class="form-control" style="width:80px" id="rcv_qty_${i.id}" data-item-id="${i.id}"></td>
            <td><input type="number" min="0" step="0.01" value="${i.unit_cost}" class="form-control" style="width:100px" id="rcv_cost_${i.id}"></td>
          </tr>${i.track_serial ? `<tr><td colspan="5">
            <label class="form-label" style="font-size:.78rem">أرقام IMEI / Serial لـ «${_esc(i.product_name)}» (رقم في كل سطر) <b>*</b></label>
            <textarea class="form-control" dir="ltr" rows="3" id="rcv_serials_${i.id}" placeholder="353510001000059&#10;353510001000067"></textarea>
            <small id="rcv_serial_count_${i.id}" style="color:var(--tx-3)">0 رقم</small></td></tr>` : ''}`).join('')}
        </tbody>
      </table>`;

    Modal.open({
      title: `<i class="fas fa-box-open"></i> استلام — ${_esc(p.po_num)}`,
      size: 'lg', body,
      foot: `<button class="btn btn-primary" id="confirmReceiveBtn"><i class="fas fa-check"></i> تأكيد الاستلام</button>
             <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>`,
    });

    const parseSerials = id => (document.getElementById(`rcv_serials_${id}`)?.value || '').split(/[\n,،]+/).map(s => s.trim()).filter(Boolean);
    open.filter(i => i.track_serial).forEach(i => {
      document.getElementById(`rcv_serials_${i.id}`)?.addEventListener('input', () => {
        document.getElementById(`rcv_serial_count_${i.id}`).textContent = `${parseSerials(i.id).length} رقم`;
      });
    });

    document.getElementById('receiveCameraBtn')?.addEventListener('click', () => CameraWorkflows.count({ scope: `receive-${p.id}`, purchase: p, onApply: async quantities => {
      document.querySelectorAll('[id^="rcv_qty_"]').forEach(input => input.value = quantities[input.dataset.itemId] || 0);
      Toast.info('تم نقل الكميات', 'راجع الكميات ثم اضغط تأكيد الاستلام. لم يتم تعديل المخزون بعد.');
    } }));
    document.getElementById('confirmReceiveBtn')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      const items = open.map(i => {
        const item = {
          item_id: i.id,
          qty_received: Number(document.getElementById(`rcv_qty_${i.id}`)?.value || 0),
          unit_cost: Number(document.getElementById(`rcv_cost_${i.id}`)?.value),
        };
        if (i.track_serial) item.serials = parseSerials(i.id);
        return item;
      });
      try {
        const result = await DB.receivePurchase(p.id, { items });
        Toast.ok('تم الاستلام', `تم تحديث المخزون — حالة الأمر: ${result.status}`);
        Modal.close();
        await _load();
      } catch (e) { Toast.err('خطأ', e.message); }
      finally { button.disabled = false; }
    });
  }

  /* ── إلغاء أمر شراء ────────────────────────────────── */
  function _cancelPO(id, num) {
    Modal.confirm(
      `إلغاء الأمر ${num}`,
      'هل أنت متأكد من إلغاء أمر الشراء هذا؟',
      async () => {
        try {
          await DB.cancelPurchase(id);
          Toast.ok('تم الإلغاء', `تم إلغاء أمر الشراء ${num}`);
          await _load();
        } catch(e) { Toast.err('خطأ', e.message); }
      },
      'تأكيد الإلغاء', 'btn-danger'
    );
  }

  /* ── إنشاء أمر شراء جديد ───────────────────────────── */
  async function openAddModal() {
    const [suppliers, products] = await Promise.all([DB.getSuppliers(), DB.getProducts()]);

    const body = `
      <div class="mf-grid cols-2" style="margin-bottom:1rem">
        <label class="mf-field">
          <span>المورد <b>*</b></span>
          <select id="poSupplier" class="form-control">
            <option value="">اختر المورد</option>
            ${(suppliers || []).map(s => `<option value="${s.id}" data-name="${s.name}">${s.name}</option>`).join('')}
          </select>
        </label>
        <label class="mf-field">
          <span>ملاحظات</span>
          <input id="poNotes" class="form-control" placeholder="ملاحظات الطلبية">
        </label>
      </div>

      <div style="margin-bottom:.75rem;display:flex;justify-content:space-between;align-items:center">
        <strong style="font-size:.82rem">أصناف الطلبية</strong>
        <button type="button" class="btn btn-ghost btn-sm" id="poAddItemBtn"><i class="fas fa-plus"></i> إضافة صنف</button>
      </div>
      <div id="poItemsContainer">
        <!-- يُبنى ديناميكياً -->
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:.75rem;font-size:.85rem">
        <span>الإجمالي: <strong id="poTotal" style="color:var(--teal-600)">0.00 ج.م</strong></span>
      </div>`;

    Modal.open({
      title: '<i class="fas fa-cart-flatbed"></i> أمر شراء جديد',
      size: 'lg',
      body,
      foot: `<div class="mf-foot-note"><i class="fas fa-circle-info"></i> سيتم تحديث المخزون عند الاستلام</div>
             <div class="mf-foot-actions">
               <button class="btn btn-ghost" onclick="Modal.close()">إلغاء</button>
               <button class="btn btn-primary" id="savePoBtn"><i class="fas fa-check"></i> إنشاء الأمر</button>
             </div>`,
    });

    let itemCount = 0;
    const productOptions = (products || []).map(m =>
      `<option value="${m.id}" data-name="${m.name}" data-cost="${m.cost*(m.conversionFactor||1)}">${m.name} — ${m.purchaseUnit||m.unit} (${m.conversionFactor||1} ${m.saleUnit||m.unit})</option>`
    ).join('');

    const addItem = (productId = '', productName = '', qty = 1, cost = 0) => {
      const id = ++itemCount;
      const row = document.createElement('div');
      row.id = `poItem_${id}`;
      row.className = 'po-item-row';
      row.style.cssText = 'display:grid;grid-template-columns:1fr 80px 100px 30px;gap:.5rem;margin-bottom:.5rem;align-items:center';
      row.innerHTML = `
        <select class="form-control po-product-sel" data-row="${id}">
          <option value="">اختر الصنف</option>${productOptions}
        </select>
        <input type="number" min="1" value="${qty}" class="form-control po-qty" data-row="${id}" title="عدد وحدات الشراء" placeholder="كمية الشراء">
        <input type="number" min="0" step="0.01" value="${cost}" class="form-control po-cost" data-row="${id}" title="تكلفة وحدة الشراء كاملة" placeholder="تكلفة وحدة الشراء">
        <button type="button" class="btn btn-ghost btn-icon sm" onclick="document.getElementById('poItem_${id}').remove(); _calcPoTotal()" style="color:var(--err)"><i class="fas fa-trash"></i></button>`;
      document.getElementById('poItemsContainer').appendChild(row);

      if (productId) row.querySelector('.po-product-sel').value = productId;
      row.querySelector('.po-product-sel').addEventListener('change', e => {
        const opt = e.target.selectedOptions[0];
        const costInp = row.querySelector('.po-cost');
        if (opt?.dataset.cost) costInp.value = opt.dataset.cost;
        window._calcPoTotal();
      });
      row.querySelectorAll('.po-qty, .po-cost').forEach(inp =>
        inp.addEventListener('input', () => window._calcPoTotal())
      );
    };

    window._calcPoTotal = () => {
      let total = 0;
      document.querySelectorAll('[id^="poItem_"]').forEach(row => {
        const qty  = parseFloat(row.querySelector('.po-qty')?.value) || 0;
        const cost = parseFloat(row.querySelector('.po-cost')?.value) || 0;
        total += qty * cost;
      });
      const el = document.getElementById('poTotal');
      if (el) el.textContent = Fmt.money(total);
    };

    document.getElementById('poAddItemBtn').addEventListener('click', () => addItem());
    addItem(); // صف افتراضي

    document.getElementById('savePoBtn')?.addEventListener('click', async () => {
      const suppId = document.getElementById('poSupplier').value;
      if (!suppId) { Toast.warn('تنبيه', 'اختر المورد أولاً'); return; }

      const items = [];
      document.querySelectorAll('[id^="poItem_"]').forEach(row => {
        const sel  = row.querySelector('.po-product-sel');
        const qty  = Number(row.querySelector('.po-qty')?.value) || 0;
        const cost = parseFloat(row.querySelector('.po-cost')?.value) || 0;
        if (sel?.value && qty > 0) {
          items.push({
            product_id:      sel.value,
            product_name:    sel.selectedOptions[0]?.dataset.name || '',
            qty_ordered: qty,
            unit_cost:   cost,
          });
        }
      });

      if (!items.length) { Toast.warn('تنبيه', 'أضف صنفاً واحداً على الأقل'); return; }

      const btn = document.getElementById('savePoBtn');
      btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
      try {
        const result = await DB.addPurchase({
          supplier_id: suppId,
          notes:       document.getElementById('poNotes').value.trim(),
          items,
        });
        Toast.ok('تم الإنشاء', `أمر الشراء ${result.po_num} جاهز`);
        Modal.close();
        await _load();
      } catch(e) {
        Toast.err('خطأ', e.message);
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check"></i> إنشاء الأمر';
      }
    });
  }

  function exportData() {
    exportCSV('أوامر_الشراء',
      ['رقم الأمر', 'المورد', 'التاريخ', 'الإجمالي', 'الحالة'],
      _all.map(p => [p.po_num, p.supplier_name, p.created_at?.split('T')[0], p.total_cost, p.status])
    );
  }

  return { render, afterRender, openAddModal };
})();
