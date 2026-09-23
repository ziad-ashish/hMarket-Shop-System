/* ════════════════════════════════════════════════════════════
   PAGE: STOCKTAKE — الجرد الدوري (مطابقة المخزون)
   يعرض كل الأصناف مع مخزونها المسجَّل، ويسمح بإدخال الكمية المعدودة
   فعليًا لكل صنف. عند الحفظ، يُسوّى الفرق تلقائيًا: تشغيلة جديدة
   للزيادة، خصم FEFO من التشغيلات للنقص، مع تسجيل كل فرق في سجل الحركة.
════════════════════════════════════════════════════════════ */
'use strict';

const StocktakePage = (() => {
  let _items = [], _categories = [];
  let _catFilter = '';
  let _search = '';

  function render() {
    return `
<div class="page active" id="page-stocktake">
  <div class="pg-header">
    <div class="pg-title-group">
      <h1 class="pg-title">
        <div class="pg-title-icon" style="background:#ede9fe;color:#6d28d9"><i class="fas fa-clipboard-check"></i></div>
        الجرد الدوري
      </h1>
      <p class="pg-subtitle">عدّ المخزون الفعلي وقارنه بالمسجّل في النظام — الفروقات تُسوّى تلقائيًا عند الحفظ</p>
    </div>
    <div class="pg-actions">
      <button class="btn btn-primary" id="submitStocktakeBtn"><i class="fas fa-check-double"></i> حفظ الجرد</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:1rem">
    <div class="card-body" style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center">
      <input type="text" class="form-control" id="stkSearch" placeholder="ابحث باسم الصنف..." style="max-width:280px">
      <select class="form-control" id="stkCategory" style="max-width:200px"><option value="">كل الفئات</option></select>
      <span id="stkDiffCount" style="margin-inline-start:auto;font-size:.85rem;color:var(--tx-3)"></span>
    </div>
  </div>

  <div id="stkContent">
    <div class="empty-state"><div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div><h3 class="es-title">جارٍ التحميل...</h3></div>
  </div>
</div>`;
  }

  async function afterRender() {
    document.getElementById('submitStocktakeBtn')?.addEventListener('click', _submit);
    document.getElementById('stkSearch')?.addEventListener('input', e => { _search = e.target.value.trim(); _renderTable(); });
    document.getElementById('stkCategory')?.addEventListener('change', e => { _catFilter = e.target.value; _renderTable(); });
    await _load();
  }

  async function _load() {
    try {
      const [items, cats] = await Promise.all([DB.getStocktakeWorksheet(), DB.getCategories()]);
      _items = (items || []).map(m => ({ ...m, counted: null }));
      _categories = cats || [];
      const sel = document.getElementById('stkCategory');
      if (sel) sel.innerHTML = '<option value="">كل الفئات</option>' + _categories.map(c => `<option value="${_esc(c)}">${_esc(c)}</option>`).join('');
      _renderTable();
    } catch (e) { Toast.err('خطأ', e.message); }
  }

  function _filtered() {
    const q = _search.toLowerCase();
    return _items.filter(m => (!_catFilter || m.category === _catFilter) && (!q || m.name.toLowerCase().includes(q)));
  }

  function _renderTable() {
    const el = document.getElementById('stkContent'); if (!el) return;
    const rows = _filtered();
    el.innerHTML = `<div class="card"><div class="card-body p0"><div class="tbl-wrap">
      <table class="dtable">
        <thead><tr><th>الصنف</th><th>الفئة</th><th>المخزون المسجَّل</th><th>الكمية المعدودة فعليًا</th><th>الفرق</th></tr></thead>
        <tbody>${rows.length ? rows.map(m => `<tr data-row="${_esc(m.id)}">
          <td class="font-bold">${_esc(m.name)}</td>
          <td>${_esc(m.category)}</td>
          <td>${Fmt.num(m.stock)} ${_esc(m.unit||'')}</td>
          <td>${m.track_serial
            ? '<span class="badge bdg-slate" title="رصيد الأجهزة = عدد أرقام IMEI المتاحة"><i class="fas fa-barcode"></i> بأرقام IMEI</span>'
            : `<input type="number" min="0" class="form-control stk-input" data-id="${_esc(m.id)}" style="max-width:120px" placeholder="—" value="${m.counted!==null?m.counted:''}">`}</td>
          <td class="stk-diff" data-diff-for="${_esc(m.id)}" style="font-weight:700"></td>
        </tr>`).join('') : '<tr><td colspan="5"><div class="empty-state"><h3 class="es-title">لا توجد أصناف مطابقة</h3></div></td></tr>'}</tbody>
      </table>
    </div></div></div>`;

    el.querySelectorAll('.stk-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const item = _items.find(m => m.id === inp.dataset.id);
        const val = inp.value === '' ? null : parseInt(inp.value);
        item.counted = (val === null || isNaN(val)) ? null : val;
        _updateDiffCell(item);
        _updateSummary();
      });
    });
    _items.forEach(_updateDiffCell);
    _updateSummary();
  }

  function _updateDiffCell(item) {
    const cell = document.querySelector(`[data-diff-for="${item.id}"]`);
    if (!cell) return;
    if (item.counted === null) { cell.textContent = '—'; cell.style.color = 'var(--tx-3)'; return; }
    const diff = item.counted - item.stock;
    cell.textContent = diff === 0 ? 'مطابق' : (diff > 0 ? `+${diff}` : `${diff}`);
    cell.style.color = diff === 0 ? 'var(--tx-3)' : diff > 0 ? 'var(--ok)' : 'var(--err)';
  }

  function _updateSummary() {
    const el = document.getElementById('stkDiffCount'); if (!el) return;
    const withDiff = _items.filter(m => m.counted !== null && m.counted !== m.stock);
    el.textContent = withDiff.length ? `${withDiff.length} صنف به فرق عن المسجّل` : 'لم يُسجَّل أي فرق بعد';
  }

  async function _submit() {
    const withDiff = _items.filter(m => m.counted !== null && m.counted !== m.stock);
    if (!withDiff.length) { Toast.info('لا يوجد جديد', 'لم تدخل أي كمية مختلفة عن المخزون المسجَّل'); return; }

    Modal.confirm(
      'تأكيد حفظ الجرد',
      `سيتم تسوية ${withDiff.length} صنف تلقائيًا في المخزون والتشغيلات بناءً على الكميات المعدودة. هل تريد المتابعة؟`,
      async () => {
        try {
          const items = withDiff.map(m => ({ product_id: m.id, counted_qty: m.counted }));
          const res = await DB.submitStocktake(items, '');
          Toast.ok('تم حفظ الجرد', `تم تعديل ${res.adjusted_count} صنف`);
          await _load();
        } catch (e) { Toast.err('خطأ', e.message); }
      }
    );
  }

  return { render, afterRender };
})();
