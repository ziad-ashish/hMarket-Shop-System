/* ════════════════════════════════════════════════════════════
   PAGE: POINT OF SALE  (async)
════════════════════════════════════════════════════════════ */
'use strict';

const SalesPage = (() => {
  let _cart      = [];
  let _discount  = 0;
  let _payMethod = 'نقدي';
  let _catFilter = '';
  let _search    = '';
  let _allProducts   = [];
  let _draftCustomer = null, _restoring = true, _checkoutBusy = false;
  let _credit = {name:'', phone:'', paid:0};
  let _customerType = 'فرد';   // نوع العميل المختار حاليًا في نقطة البيع (فرد/جملة)
  let _activePromos = [];      // العروض النشطة حاليًا (تُحمّل عند فتح الصفحة)

  /* أفضل عرض نشط لصنف معيّن عند كمية محددة (أكبر خصم منطبق) — يُحسب دائمًا
     على السعر الحالي للصنف (product.price) وليس على قيمة مخزّنة وقت تحميل العروض. */
  function _bestPromoFor(product, qty) {
    if (!product) return null;
    const candidates = _activePromos.filter(p => p.product_id === product.id && qty >= (p.min_qty || 1));
    if (!candidates.length) return null;
    let best = null, bestPrice = Infinity;
    for (const p of candidates) {
      const price = p.discount_type === 'percent' ? product.price * (1 - p.discount_value / 100) : Math.max(0, product.price - p.discount_value);
      if (price < bestPrice) { bestPrice = price; best = p; }
    }
    return best ? { promo: best, price: bestPrice } : null;
  }

  /* السعر الفعلي لصنف عند كمية معيّنة: أقل قيمة بين سعر التجزئة، سعر الجملة
     (لو العميل جملة والكمية كافية)، وسعر أي عرض خصم نشط على نفس الصنف. */
  function _priceFor(product, qty, customerType = _customerType) {
    let price = product?.price ?? 0;
    if (customerType === 'جملة' && product?.wholesalePrice != null && qty >= (product.wholesaleMinQty || 1) && product.wholesalePrice < price) {
      price = product.wholesalePrice;
    }
    const promo = _bestPromoFor(product, qty);
    if (promo && promo.price < price) { price = promo.price; }
    return price;
  }

  /* نفس منطق _priceFor لكن يرجع أيضًا مصدر السعر (تجزئة/جملة/عرض) لعرضه كبادچ */
  function _priceInfoFor(product, qty, customerType = _customerType) {
    let price = product?.price ?? 0;
    let source = 'retail';
    if (customerType === 'جملة' && product?.wholesalePrice != null && qty >= (product.wholesaleMinQty || 1) && product.wholesalePrice < price) {
      price = product.wholesalePrice; source = 'wholesale';
    }
    const promo = _bestPromoFor(product, qty);
    if (promo && promo.price < price) { price = promo.price; source = 'promo'; }
    return { price, source };
  }

  /* إعادة حساب أسعار كل أصناف السلة الحالية (تُستدعى عند تغيير العميل) */
  function _recalcCartPrices() {
    let changed = false;
    _cart.forEach(item => {
      const product = _allProducts.find(m => m.id === item.productId);
      if (!product) return;
      const newPrice = _priceFor(product, item.qty);
      if (newPrice !== item.price) {
        item.price = newPrice;
        item.total = item.qty * newPrice;
        changed = true;
      }
    });
    if (changed) updateCartUI();
  }
  let _useLoyalty = false;
  let _shopName = 'تك ماركت';
  let _shopLogo = '';
  let _invoiceNote  = 'شكراً لزيارتكم • الاستبدال والاسترجاع خلال 14 يوم بحالة الجهاز الأصلية';
  let TAX_RATE = 0;
  let _showTax     = false;
  let _showCashier = true;
  let _maxDiscountPct = 100;
  let _barcodeBuf  = '';
  let _barcodeTimer = null;
  let _barcodeListenerAttached = false;
  let _shortcutListenerAttached = false;
  let _keyboardIndex = -1;

  function render() {
    return `
<div class="page active" id="page-sales">
  <div class="pg-header">
    <div class="pg-title-group">
      <h1 class="pg-title">
        <div class="pg-title-icon" style="background:var(--teal-50);color:var(--teal-500)"><i class="fas fa-cash-register"></i></div>
        نقطة البيع
      </h1>
      <p class="pg-subtitle">إنشاء فاتورة مبيعات جديدة</p><small id="posDraftStatus" role="status">جارٍ استرجاع المسودة…</small>
    </div>
    <div class="pg-actions">
      <button class="btn btn-ghost btn-sm" onclick="App.navigate('invoices')">
        <i class="fas fa-file-invoice-dollar"></i> سجل الفواتير
      </button>
    </div>
  </div>

  <div class="pos-layout">
    <!-- Products -->
    <div class="pos-prods">
      <div class="pos-prods-head">
        <button type="button" class="btn btn-ghost" id="posCameraBtn"><i class="fas fa-camera"></i> مسح بالكاميرا</button>
        <div class="tb-srch" style="flex:1">
          <i class="fas fa-magnifying-glass"></i>
          <input type="search" id="posSearch" placeholder="بحث بالاسم أو الماركة أو IMEI..." />
        </div>
      </div>
      <div class="cat-filters" id="posCatFilters">
        <button class="cat-chip active" data-cat="">الكل</button>
      </div>
      <div class="pos-prods-body">
        <div class="product-grid" id="posGrid">
          <div class="empty-state" style="grid-column:1/-1">
            <div class="es-icon an-spin"><i class="fas fa-circle-notch"></i></div>
            <h3 class="es-title">جارٍ التحميل...</h3>
          </div>
        </div>
      </div>
    </div>

    <!-- Cart -->
    <div class="pos-cart">
      <div class="cart-head">
        <h3><i class="fas fa-shopping-cart"></i> سلة المشتريات</h3>
        <span class="cart-count" id="cartCount">0</span>
      </div>
      <div style="padding:.6rem .8rem;border-bottom:1px solid var(--border-2)">
        <select class="form-control" id="posCustomer" style="font-size:.8rem">
          <option value="">— عميل عادي —</option>
        </select>
        <label id="loyaltyOption" style="display:none;margin-top:.5rem;font-size:.75rem"><input type="checkbox" id="useLoyalty"> استخدام نقاط الولاء المتاحة</label>
      </div>
      <div class="cart-body" id="cartBody">
        <div class="cart-empty">
          <i class="fas fa-cart-plus"></i>
          <p>اختر الأصناف من القائمة<br>لإضافتها للسلة</p>
        </div>
      </div>
      <div class="cart-foot">
        <div class="cart-row"><span class="cr-label">المجموع الفرعي</span><span class="cr-val" id="crSub">0.00 ج.م</span></div>
        <div class="cart-row">
          <span class="cr-label">الخصم (ج.م)</span>
          <input type="number" class="discount-input" id="discountInput" min="0" value="0" />
        </div>
        <div class="cart-row" id="crTaxRow" style="display:none"><span class="cr-label" id="crTaxLabel">الضريبة 0%</span><span class="cr-val" id="crTax">0.00 ج.م</span></div>
        <div class="cart-row grand">
          <span>الإجمالي</span><span class="cr-val" id="crTotal">0.00 ج.م</span>
        </div>
        <div style="margin-top:.5rem">
          <div style="font-size:.76rem;font-weight:600;color:var(--tx-3);margin-bottom:.4rem">طريقة الدفع</div>
          <div class="pay-btns">
            <button type="button" class="pay-btn sel" data-pm="نقدي" aria-pressed="true"><i class="fas fa-money-bill"></i> نقدي</button>
            <button type="button" class="pay-btn" data-pm="بطاقة" aria-pressed="false"><i class="fas fa-credit-card"></i> بطاقة</button>
            <button type="button" class="pay-btn" data-pm="تحويل" aria-pressed="false"><i class="fas fa-mobile-screen"></i> تحويل</button>
            <button type="button" class="pay-btn" data-pm="آجل" aria-pressed="false"><i class="fas fa-clock"></i> آجل</button>
          </div>
          <div class="credit-payment-panel" id="creditPaymentPanel" hidden>
            <div class="credit-panel-title"><i class="fas fa-address-card"></i><div><strong>بيانات البيع الآجل</strong><small>سيُنشأ سجل مديونية مرتبط بالعميل</small></div></div>
            <label class="credit-field"><span>اسم العميل <b>*</b></span><input id="creditCustomerName" class="form-control" maxlength="100" autocomplete="name" placeholder="اكتب اسم العميل" required></label>
            <label class="credit-field"><span>رقم التليفون <small>(اختياري)</small></span><input id="creditPhone" class="form-control" type="tel" maxlength="30" autocomplete="tel" inputmode="tel" placeholder="01xxxxxxxxx"></label>
            <div class="credit-money-grid">
              <label class="credit-field"><span>دفع الآن</span><input id="creditPaidAmount" class="form-control" type="number" min="0" step="0.01" value="0" inputmode="decimal"></label>
              <div class="credit-remaining"><span>المتبقي عليه</span><strong id="creditRemaining">0.00 ج.م</strong></div>
            </div>
          </div>
        </div>
        <button class="checkout-btn" id="checkoutBtn" disabled>
          <i class="fas fa-receipt"></i> إصدار الفاتورة
        </button>
      </div>
    </div>
  </div>
</div>`;
  }

  async function afterRender() {
    _restoring=true; _cart = []; _discount = 0; _payMethod = 'نقدي'; _draftCustomer=null; _credit={name:'',phone:'',paid:0}; _useLoyalty=false; _checkoutBusy=false;
    // الصفر هو الوضع الآمن. لا توجد ضريبة إلا إذا قرأنا قيمة موجبة محفوظة فعلياً.
    TAX_RATE = 0;
    _showTax = false;

    try {
      const safe = promise => promise.catch(() => null);
      const [products, cats, customers, taxSetting, nameSetting, noteSetting, logoSetting, showTaxSetting, showCashierSetting, defaultPaymentSetting, maxDiscountSetting, activePromos] = await Promise.all([
        safe(DB.getTopSellingProducts(50)), safe(DB.getCategories()), safe(DB.getCustomers()),
        safe(DB.getSetting('tax_rate')), safe(DB.getSetting('shop_name')), safe(DB.getSetting('invoice_footer_note')),
        safe(DB.getSetting('shop_logo')), safe(DB.getSetting('invoice_show_tax')), safe(DB.getSetting('invoice_show_cashier')),
        safe(DB.getSetting('sales_default_payment')), safe(DB.getSetting('sales_max_discount_percent')),
        safe(DB.getPromotions(true)),
      ]);
      _allProducts = products || [];
      _activePromos = activePromos || [];

      if (nameSetting) _shopName = nameSetting;
      if (noteSetting) _invoiceNote = noteSetting;
      if (logoSetting) _shopLogo = logoSetting;
      _showTax     = showTaxSetting !== '0';
      _showCashier = showCashierSetting !== '0';
      _payMethod = defaultPaymentSetting === 'بطاقة' ? 'بطاقة' : 'نقدي';
      const parsedMaxDiscount = parseFloat(maxDiscountSetting);
      _maxDiscountPct = Number.isFinite(parsedMaxDiscount) ? Math.max(0, Math.min(100, parsedMaxDiscount)) : 100;
      _setPayment(_payMethod, false);
      const parsedTax = Number.parseFloat(taxSetting);
      const effectiveTax = Number.isFinite(parsedTax) && parsedTax > 0 ? parsedTax : 0;
      TAX_RATE = effectiveTax / 100;
      const taxLabel = document.getElementById('crTaxLabel');
      if (taxLabel) taxLabel.textContent = `الضريبة ${effectiveTax}%`;
      // FIX: don't show a tax row at all when there's no tax rate configured,
      // or when the "show tax" option is switched off in settings
      const taxRow = document.getElementById('crTaxRow');
      if (taxRow) taxRow.style.display = (_showTax && TAX_RATE > 0) ? '' : 'none';

      // category chips
      const cf = document.getElementById('posCatFilters');
      if (cf) cf.innerHTML = `<button class="cat-chip active" data-cat="">الكل</button>` +
        (cats || []).map(c=>`<button class="cat-chip" data-cat="${_esc(c)}">${_esc(c)}</button>`).join('');

      // customers list
      const ps = document.getElementById('posCustomer');
      if (ps) ps.innerHTML = `<option value="">— عميل عادي —</option>` +
        (customers || []).map(p=>`<option value="${_esc(p.id)}">${_esc(p.name)}</option>`).join('');

      renderGrid();
    } catch(e) { Toast.err('خطأ', e.message); }

    // events
    document.getElementById('posSearch')?.addEventListener('input', debounce(async e=>{
      _search = e.target.value.trim();
      if (_search.length >= 2) {
        try { _allProducts = await DB.searchProducts(_search); } catch (_) {}
      } else if (!_search) {
        try { _allProducts = await DB.getTopSellingProducts(50); } catch (_) {}
      }
      renderGrid();
    }, 250));

    document.getElementById('posCatFilters')?.addEventListener('click', e=>{
      const chip = e.target.closest('.cat-chip');
      if (!chip) return;
      _catFilter = chip.dataset.cat;
      document.querySelectorAll('#posCatFilters .cat-chip').forEach(c=>c.classList.remove('active'));
      chip.classList.add('active');
      renderGrid();
    });

    document.getElementById('discountInput')?.addEventListener('input', e => {
      // FIX [11]: cap discount to subtotal and give visual feedback
      const raw  = parseFloat(e.target.value) || 0;
      const sub  = _cart.reduce((a, i) => a + i.total, 0);
      const allowed = sub * (_maxDiscountPct / 100);
      if (raw > allowed && sub > 0) {
        e.target.value = allowed.toFixed(2);
        _discount      = allowed;
        Toast.warn('تنبيه', `الخصم الأقصى المسموح ${_maxDiscountPct}% (${Fmt.money(allowed)})`);
      } else {
        _discount = raw;
      }
      updateTotals();
    });

    document.querySelectorAll('.pay-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        _setPayment(btn.dataset.pm);
      });
    });
    document.getElementById('creditCustomerName')?.addEventListener('input',e=>{_credit.name=e.target.value;_persistDraft();});
    document.getElementById('creditPhone')?.addEventListener('input',e=>{_credit.phone=e.target.value;_persistDraft();});
    document.getElementById('creditPaidAmount')?.addEventListener('input',e=>{_credit.paid=Math.max(0,Number(e.target.value)||0);_syncCreditPanel();_persistDraft();});

    document.getElementById('checkoutBtn')?.addEventListener('click', checkout);
    document.getElementById('posCameraBtn')?.addEventListener('click',()=>CameraWorkflows.scan({title:'مسح صنف للبيع',context:'sale',allowAuto:true,acceptLabel:'إضافة للسلة',onAccept:async product=>{
      const current=await DB.getProduct(product.id);const index=_allProducts.findIndex(m=>m.id===product.id);
      if(index<0)_allProducts.push(current);else _allProducts[index]=current;
      if(!addToCart(product.id,product.scanQuantity,product.scanSerial?[product.scanSerial]:null))throw new Error('لم تتم الإضافة. راجع المخزون والكمية المطلوبة.');
    }}));
    document.getElementById('posCustomer')?.addEventListener('change', async e=>{
      _draftCustomer=e.target.value||null; _useLoyalty=false; document.getElementById('useLoyalty').checked=false; _persistDraft();
      if(!e.target.value){document.getElementById('loyaltyOption').style.display='none';_syncCreditPanel();_customerType='فرد';_recalcCartPrices();return;}
      try {
        const [debt,loyalty,customer]=await Promise.all([DB.getCustomerDebt(e.target.value),DB.getLoyalty(e.target.value),DB.getCustomer(e.target.value)]);
        if(debt.balance>0) Toast.warn('تنبيه مديونية',`على العميل دين سابق بقيمة ${Fmt.money(debt.balance)}`);
        const option=document.getElementById('loyaltyOption'); if(option){option.style.display=loyalty.points>0?'block':'none';option.title=`الرصيد ${Number(loyalty.points).toFixed(2)} نقطة`;}
        if(_payMethod==='آجل'&&customer){_credit.name=customer.name||'';_credit.phone=customer.phone||'';_syncCreditPanel();_persistDraft();}
        _customerType = customer?.customerType==='جملة' ? 'جملة' : 'فرد';
        if(_customerType==='جملة') Toast.info('عميل جملة', 'سيتم تطبيق أسعار الجملة تلقائيًا عند توفر الحد الأدنى للكمية', 2000);
        _recalcCartPrices();
      } catch(_){}
    });
    document.getElementById('useLoyalty')?.addEventListener('change',e=>{_useLoyalty=e.target.checked;_persistDraft();});

    _setupBarcodeScanner();
    _setupKeyboardShortcuts();
    try {
      const saved=await PosDraft.load();
      if(saved) {
        _cart=saved.cart||[];_discount=Number(saved.discount)||0;_payMethod=saved.paymentMethod||_payMethod;
        _draftCustomer=saved.customerId||null;_credit={name:saved.credit?.name||'',phone:saved.credit?.phone||'',paid:Number(saved.credit?.paid)||0};_useLoyalty=!!saved.useLoyalty;
        const needed=await Promise.all(_cart.map(item=>DB.getProduct(item.productId)));
        for(const product of needed.filter(Boolean)){const index=_allProducts.findIndex(m=>m.id===product.id);if(index<0)_allProducts.push(product);else _allProducts[index]=product;}
        document.getElementById('discountInput').value=_discount;
        document.getElementById('posCustomer').value=_draftCustomer||'';
        if(_draftCustomer){ try{ const p=await DB.getCustomer(_draftCustomer); _customerType=p?.customerType==='جملة'?'جملة':'فرد'; }catch(_){} }
        _setPayment(_payMethod, false);
        document.getElementById('loyaltyOption').style.display=_draftCustomer?'':'none';
        document.getElementById('useLoyalty').checked=_useLoyalty;
        if(_cart.length)Toast.info('تم استرجاع المسودة','راجع الكميات والأسعار الحالية قبل إصدار الفاتورة');
      }
      updateCartUI();renderGrid();_restoring=false;
    }catch(error){document.getElementById('posDraftStatus').textContent='تعذر استرجاع المسودة: '+error.message;Toast.err('تعذر فتح المسودة',error.message);}
  }

  function _persistDraft() {
    if(_restoring)return;
    PosDraft.save({cart:_cart,discount:_discount,paymentMethod:_payMethod,customerId:_draftCustomer,
      useLoyalty:_useLoyalty,credit:_credit});
  }

  function _setPayment(method, persist=true) {
    _payMethod=method;
    document.querySelectorAll('.pay-btn').forEach(button=>{
      const selected=button.dataset.pm===method;
      button.classList.toggle('sel',selected);
      button.setAttribute('aria-pressed',selected?'true':'false');
    });
    _syncCreditPanel();
    if(method==='آجل'&&!_credit.name){
      const customerId=document.getElementById('posCustomer')?.value;
      if(customerId)DB.getCustomer(customerId).then(customer=>{
        if(_payMethod!=='آجل'||!customer)return;
        _credit.name=customer.name||'';_credit.phone=customer.phone||'';_syncCreditPanel();_persistDraft();
      }).catch(()=>{});
    }
    if(persist)_persistDraft();
  }

  function _syncCreditPanel(total=null) {
    const panel=document.getElementById('creditPaymentPanel');if(!panel)return;
    panel.hidden=_payMethod!=='آجل';
    if(panel.hidden)return;
    const name=document.getElementById('creditCustomerName'),phone=document.getElementById('creditPhone'),paid=document.getElementById('creditPaidAmount');
    if(name&&name.value!==_credit.name)name.value=_credit.name;
    if(phone&&phone.value!==_credit.phone)phone.value=_credit.phone;
    if(paid&&Number(paid.value)!==Number(_credit.paid))paid.value=Number(_credit.paid)||0;
    const due=total===null?_cart.reduce((sum,item)=>sum+item.total,0)-Math.min(_discount,_cart.reduce((sum,item)=>sum+item.total,0)):total;
    if(paid)paid.max=Math.max(0,due).toFixed(2);
    const remaining=document.getElementById('creditRemaining');
    if(remaining)remaining.textContent=Fmt.money(Math.max(0,due-(Number(_credit.paid)||0)));
  }

  function _setupKeyboardShortcuts(){
    if(_shortcutListenerAttached)return; _shortcutListenerAttached=true;
    document.addEventListener('keydown',e=>{
      if(!document.getElementById('page-sales'))return;
      if(e.key==='F1'){e.preventDefault();document.getElementById('posSearch')?.focus();}
      else if(e.key==='F2'){e.preventDefault();document.getElementById('checkoutBtn')?.click();}
      else if(e.key==='F3'){e.preventDefault();if(_cart.length)Modal.confirm('مسح السلة','هل تريد حذف كل الأصناف من السلة؟',()=>{_cart=[];updateCartUI();},'مسح السلة');}
      else if(e.key==='Escape'&&!Modal.isLocked()){Modal.close();}
      else if((e.key==='ArrowDown'||e.key==='ArrowUp')&&document.activeElement?.id==='posSearch'){
        e.preventDefault();const cards=[...document.querySelectorAll('#posGrid .product-card:not(.oos)')];if(!cards.length)return;
        _keyboardIndex=e.key==='ArrowDown'?Math.min(cards.length-1,_keyboardIndex+1):Math.max(0,_keyboardIndex-1);
        cards.forEach((c,i)=>c.style.outline=i===_keyboardIndex?'2px solid var(--teal-500)':'');cards[_keyboardIndex]?.scrollIntoView({block:'nearest'});
      } else if(e.key==='Enter'&&document.activeElement?.id==='posSearch'&&_keyboardIndex>=0){
        const card=document.querySelectorAll('#posGrid .product-card:not(.oos)')[_keyboardIndex];if(card){e.preventDefault();addToCart(card.dataset.mid);}
      }
    });
  }

  function _findByBarcode(code) {
    const c = String(code || '').trim();
    return _allProducts.find(m=>m.shopBarcode===c) ||
      _allProducts.find(m=>m.companyBarcode===c) ||
      _allProducts.find(m=>m.barcode===c) ||
      _allProducts.find(m=>String(m.id).toLowerCase()===c.toLowerCase());
  }
  async function _resolveBarcode(code){
    try{
      const remote=await CameraWorkflows.resolve(String(code||'').trim());
      if(remote?.scanRequiresConfiguration){Toast.warn('وحدة الباركود غير محددة','افتح الأصناف ← ضبط وحدات الباركود وحدد عدد وحدات البيع في العبوة');return null;}
      if(remote){const index=_allProducts.findIndex(m=>m.id===remote.id);if(index<0)_allProducts.push(remote);else _allProducts[index]=remote;}
      return remote;
    }catch(_){return null;}
  }

  /* ── BARCODE SCANNER (USB scanners act as a fast keyboard) ──
     Detects fast scanner keystrokes globally and handles barcode input
     inside search box seamlessly. */
  function _setupBarcodeScanner() {
    // 1. Handle Enter key inside posSearch (if scanner was focused in search)
    const searchInput = document.getElementById('posSearch');
    if (searchInput) {
      searchInput.addEventListener('keydown', async e => {
        if (e.key === 'Enter') {
          e.stopPropagation();
          const val = searchInput.value.trim();
          if (val) {
            const product = await _resolveBarcode(val);
            if (product) {
              e.preventDefault();
              _addScanned(product);
              searchInput.value = '';
              _search = '';
              renderGrid();
              Toast.ok('تمت الإضافة بالباركود', `${product.name} — ${Fmt.money(product.price)}`);
              return;
            }
          }
        }
      });
    }

    // 2. Global fast scanner listener
    if (_barcodeListenerAttached) return;
    _barcodeListenerAttached = true;

    let _lastKeystrokeTime = 0;
    document.addEventListener('keydown', async e => {
      if (!DeviceSettings.get().barcodeScan) return;
      if (!document.getElementById('page-sales')) return; // only while POS is open

      const now = Date.now();
      const diff = now - _lastKeystrokeTime;
      _lastKeystrokeTime = now;

      const activeTag = document.activeElement?.tagName;
      const isSearchBox = document.activeElement?.id === 'posSearch';

      if (e.key === 'Enter') {
        const code = _barcodeBuf.trim();
        _barcodeBuf = '';
        if (code.length >= 3) {
          const product = await _resolveBarcode(code);
          if (product) {
            e.preventDefault();
            _addScanned(product);
            if (isSearchBox && searchInput) {
              searchInput.value = '';
              _search = '';
              renderGrid();
            }
            Toast.ok('تم المسح بنجاح', `${product.name} — ${Fmt.money(product.price)}`);
            return;
          } else if (!isSearchBox) {
            Toast.warn('غير موجود', `لا يوجد صنف بالباركود: ${code}`);
          }
        }
        return;
      }

      // If typed inside other inputs (e.g. discount or customer notes), ignore unless it's fast scanner burst
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') {
        if (!isSearchBox && diff > 60) return; // normal human typing in an input
      }

      if (e.key.length === 1) {
        _barcodeBuf += e.key;
        clearTimeout(_barcodeTimer);
        // Reset buffer if delay between keystrokes > 350ms (human typing)
        _barcodeTimer = setTimeout(() => { _barcodeBuf = ''; }, 350);
      }
    });
  }

  function renderGrid() {
    const grid = document.getElementById('posGrid');
    if (!grid) return;
    let products = _allProducts.filter(m => m.id !== 'SRV-LABOR');   // أجرة الصيانة تُفوتر من شاشة الصيانة
    // FEAT [1]: Arabic-aware POS search
    if (_search) {
      const q = normalizeArabicText(_search);
      products = products.filter(m =>
        normalizeArabicText(m.name).includes(q) ||
        normalizeArabicText(m.category).includes(q) ||
        normalizeArabicText(m.brand||'').includes(q) ||
        normalizeArabicText(m.model||'').includes(q) ||
        [m.barcode,m.companyBarcode,m.shopBarcode].some(b=>b&&b.includes(_search))
      );
    }
    if (_catFilter) products = products.filter(m=>m.category===_catFilter);

    if (!products.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <div class="es-icon"><i class="fas fa-box-open"></i></div>
        <h3 class="es-title">لا توجد نتائج</h3>
      </div>`;
      return;
    }

    _keyboardIndex=-1;
    grid.innerHTML = products.map(m=>{
      const oos = !m.isService && (m.sellableStock??m.stock)===0;
      const low = !m.isService && m.stock>0 && m.stock<=m.minStock;
      return `
      <div class="product-card ${oos?'oos':''}" data-mid="${_esc(m.id)}">
        ${oos?'<span class="oos-badge">نفد</span>':''}
        ${low?'<span class="low-badge">منخفض</span>':''}
        <div class="product-card-ico">${m.imageUrl?`<img loading="lazy" src="${_esc(m.imageUrl)}" alt="" style="width:42px;height:42px;object-fit:contain">`:`<i class="fas ${m.trackSerial?'fa-mobile-screen':m.isService?'fa-screwdriver-wrench':'fa-plug'}"></i>`}</div>
        <div class="product-card-nm">${_esc(m.name)}</div>
        <div class="product-card-cat">${_esc(m.category)}</div>
        <div class="product-card-ft">
          <span class="product-card-price">${Fmt.money(m.price)}</span>
          <span class="product-card-stock">${m.isService?'خدمة':`${Fmt.num(m.stock)} ${_esc(m.unit)}`}</span>
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.product-card:not(.oos)').forEach(card=>{
      card.addEventListener('click', ()=>addToCart(card.dataset.mid));
    });
  }

  const _stockOf = product => product?.isService ? Infinity : (product?.sellableStock ?? product?.stock ?? 0);

  /* اختيار أرقام IMEI/Serial لجهاز من الأجهزة المتاحة بالمخزون. يرجع مصفوفة الأرقام أو null عند الإلغاء. */
  async function _pickSerials(product, current = []) {
    let units;
    try { units = await DB.getSerialUnits(product.id, 'متاح'); }
    catch (e) { Toast.err('تعذر تحميل الأرقام', e.message); return null; }
    if (!units.length && !current.length) { Toast.warn('لا توجد أجهزة متاحة', 'سجّل أرقام IMEI للصنف من صفحة الأصناف أولاً'); return null; }
    return new Promise(resolve => {
      Modal.open({
        title: `<i class="fas fa-barcode"></i> اختيار الجهاز — ${_esc(product.name)}`, size: 'sm',
        body: `<div class="form-group"><label class="form-label">امسح أو اكتب IMEI ثم Enter</label>
            <input id="pickImei" class="form-control" dir="ltr" placeholder="IMEI / Serial" autocomplete="off"></div>
          <div id="pickList" style="max-height:280px;overflow:auto">${units.map(u => `
            <label style="display:flex;gap:.5rem;align-items:center;padding:.4rem 0;border-bottom:1px solid var(--bd);cursor:pointer">
              <input type="checkbox" data-sn="${_esc(u.serial)}" data-sn2="${_esc(u.serial2 || '')}" ${current.includes(u.serial) ? 'checked' : ''}>
              <span dir="ltr"><strong>${_esc(u.serial)}</strong></span>
              <small style="color:var(--tx-3)">${_esc(u.variant || '')}</small>
            </label>`).join('')}</div>
          <p class="form-hint" id="pickCount" style="margin-top:.5rem"></p>`,
        foot: `<button class="btn btn-ghost" id="pickCancel">إلغاء</button>
               <button class="btn btn-primary" id="pickOk"><i class="fas fa-check"></i> تأكيد</button>`,
      });
      const boxes = () => [...document.querySelectorAll('#pickList input[type=checkbox]')];
      const upd = () => { const n = boxes().filter(b => b.checked).length; const el = document.getElementById('pickCount'); if (el) el.textContent = `المحدد: ${n} جهاز`; };
      document.getElementById('pickList')?.addEventListener('change', upd); upd();
      const imei = document.getElementById('pickImei');
      imei?.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault(); e.stopPropagation();
        const code = imei.value.trim().toUpperCase(); if (!code) return;
        const box = boxes().find(b => b.dataset.sn.toUpperCase() === code || (b.dataset.sn2 && b.dataset.sn2.toUpperCase() === code));
        if (!box) { Toast.warn('غير متاح', `الرقم ${code} غير موجود ضمن الأجهزة المتاحة لهذا الصنف`); }
        else { box.checked = true; box.scrollIntoView({ block: 'nearest' }); upd(); }
        imei.value = '';
      });
      setTimeout(() => imei?.focus(), 80);
      document.getElementById('pickCancel')?.addEventListener('click', () => { Modal.close(); resolve(null); });
      document.getElementById('pickOk')?.addEventListener('click', () => {
        const chosen = boxes().filter(b => b.checked).map(b => b.dataset.sn);
        if (!chosen.length) { Toast.warn('اختر جهازًا واحدًا على الأقل'); return; }
        Modal.close(); resolve(chosen);
      });
    });
  }

  async function _pickAndAdd(product) {
    const existing = _cart.find(i => i.productId === product.id);
    const serials = await _pickSerials(product, existing?.serials || []);
    if (!serials) return;
    _setSerials(product, serials);
  }

  function _setSerials(product, serials) {
    const existing = _cart.find(i => i.productId === product.id);
    const price = _priceFor(product, serials.length);
    if (existing) { existing.serials = serials; existing.qty = serials.length; existing.price = price; existing.total = price * serials.length; }
    else _cart.push({ productId: product.id, name: product.name, qty: serials.length, price, total: price * serials.length,
      unit: product.saleUnit || product.unit, serials, trackSerial: true, warrantyMonths: product.warrantyMonths || 0 });
    updateCartUI();
    Toast.info('', `تمت إضافة ${product.name}`, 1200);
  }

  /* إضافة صنف ممسوح بالباركود أو IMEI */
  function _addScanned(product) {
    if (product.scanSerial && product.scanSerialStatus && product.scanSerialStatus !== 'متاح') {
      Toast.warn('الجهاز غير متاح', `الرقم ${product.scanSerial} حالته: ${product.scanSerialStatus}`); return;
    }
    addToCart(product.id, product.scanQuantity || 1, product.scanSerial ? [product.scanSerial] : null);
  }

  function addToCart(productId, quantity=1, serials=null) {
    if(_checkoutBusy||_restoring)return false;
    const product = _allProducts.find(m=>m.id===productId);
    if (!product || !Number.isFinite(quantity) || quantity<=0) return false;
    if (['متر','كيلو','لتر'].includes(product.saleUnit || product.unit) && _stockOf(product)>0) quantity=Math.min(quantity,_stockOf(product));
    if (product.trackSerial) {
      if (!serials) { _pickAndAdd(product); return true; }
      const existing = _cart.find(i=>i.productId===productId);
      const merged = [...new Set([...(existing?.serials || []), ...serials])];
      if (existing && merged.length === existing.serials.length) { Toast.warn('مضاف بالفعل', 'هذا الجهاز موجود في السلة'); return false; }
      if (merged.length > _stockOf(product)) { Toast.warn('تنبيه', `لا يوجد مخزون كافٍ (${product.stock} فقط)`); return false; }
      _setSerials(product, merged); return true;
    }
    if (_stockOf(product) < quantity) return false;
    const existing = _cart.find(i=>i.productId===productId);
    if (existing) {
      if (existing.qty+quantity > _stockOf(product)) { Toast.warn('تنبيه',`لا يوجد مخزون كافٍ (${product.stock} فقط)`); return false; }
      existing.qty+=quantity; existing.price=_priceFor(product,existing.qty); existing.total = existing.qty * existing.price;
    } else {
      const price=_priceFor(product,quantity);
      _cart.push({ productId, name:product.name, qty:quantity, price, total:price*quantity, unit:product.saleUnit||product.unit, warrantyMonths:product.warrantyMonths||0 });
    }
    updateCartUI();
    Toast.info('', `تمت إضافة ${product.name}`, 1200);
    return true;
  }

  function removeFromCart(productId) { _cart=_cart.filter(i=>i.productId!==productId); updateCartUI(); }

  function changeQty(productId, delta) {
    const item = _cart.find(i=>i.productId===productId);
    if (!item || item.trackSerial) return;
    const product = _allProducts.find(m=>m.id===productId);
    item.qty  = Math.max(['متر','كيلو','لتر'].includes(product.saleUnit || product.unit) ? .001 : 1, Math.min(item.qty+delta, _stockOf(product)));
    item.price= _priceFor(product,item.qty);
    item.total= item.qty * item.price;
    updateCartUI();
  }

  function updateCartUI() {
    const body  = document.getElementById('cartBody');
    const count = document.getElementById('cartCount');
    if (!body) return;

    if (!_cart.length) {
      body.innerHTML = `<div class="cart-empty"><i class="fas fa-cart-plus"></i><p>اختر الأصناف من القائمة<br>لإضافتها للسلة</p></div>`;
      document.getElementById('checkoutBtn')?.setAttribute('disabled','');
    } else {
      body.innerHTML = _cart.map(item=>{
        const product=_allProducts.find(m=>m.id===item.productId);
        const info = _priceInfoFor(product, item.qty);
        const badge = info.source==='promo' ? '<span class="badge bdg-err" style="font-size:.6rem"><i class="fas fa-tag"></i> عرض خصم</span>'
                    : info.source==='wholesale' ? '<span class="badge bdg-amb" style="font-size:.6rem">سعر جملة</span>' : '';
        return `
        <div class="cart-item">
          <div>
            <div class="ci-name">${_esc(item.name)} ${badge}</div>
            <div class="ci-price">${Fmt.money(item.price)} / ${_esc(item.unit)}${item.warrantyMonths ? ` • ضمان ${item.warrantyMonths} شهر` : ''}</div>
            ${item.trackSerial ? `<div class="ci-price" dir="ltr" style="text-align:right;font-size:.68rem">${item.serials.map(_esc).join(' · ')}</div>` : ''}
          </div>
          ${item.trackSerial
            ? `<div class="qty-ctrl"><button class="qty-btn" data-edit-serials="${_esc(item.productId)}" title="تعديل الأرقام"><i class="fas fa-pen"></i></button><span class="qty-num">${item.qty}</span></div>`
            : `<div class="qty-ctrl">
            <button class="qty-btn" data-mid="${_esc(item.productId)}" data-d="-1">−</button>
            <input class="qty-num" style="width:72px" type="number" min="0.001" step="any" data-quantity="${_esc(item.productId)}" value="${item.qty}" aria-label="الكمية">
            <button class="qty-btn" data-mid="${_esc(item.productId)}" data-d="1">+</button>
          </div>`}
          <div style="min-width:68px;text-align:left;font-weight:700;font-size:.84rem;color:var(--teal-600)">${Fmt.money(item.total)}</div>
          <button class="ci-del" data-mid="${_esc(item.productId)}"><i class="fas fa-trash"></i></button>
        </div>`;
      }).join('');

      body.querySelectorAll('.qty-btn[data-d]').forEach(b=>b.addEventListener('click',()=>changeQty(b.dataset.mid, parseInt(b.dataset.d))));
      body.querySelectorAll('[data-quantity]').forEach(input=>input.onchange=()=>{
        const item=_cart.find(i=>i.productId===input.dataset.quantity),product=_allProducts.find(p=>p.id===input.dataset.quantity),qty=Number(input.value);
        if(!Number.isFinite(qty)||qty<=0||qty>_stockOf(product)||(!['متر','كيلو','لتر'].includes(product.saleUnit||product.unit)&&!Number.isInteger(qty))){Toast.err('كمية غير صحيحة','راجع الكمية ووحدة البيع والرصيد');updateCartUI();return;}
        item.qty=qty;item.price=_priceFor(product,qty);item.total=qty*item.price;updateCartUI();
      });
      body.querySelectorAll('[data-edit-serials]').forEach(b=>b.addEventListener('click',()=>{ const pr=_allProducts.find(m=>m.id===b.dataset.editSerials); if(pr)_pickAndAdd(pr); }));
      body.querySelectorAll('.ci-del').forEach(b=>b.addEventListener('click',()=>removeFromCart(b.dataset.mid)));
      document.getElementById('checkoutBtn')?.removeAttribute('disabled');
    }

    if (count) count.textContent = _cart.reduce((a,i)=>a+i.qty,0);
    updateTotals();
  }

  function updateTotals() {
    const sub  = _cart.reduce((a,i)=>a+i.total,0);
    const disc = Math.min(_discount, sub);
    const tax  = (sub-disc)*TAX_RATE;
    const tot  = (sub-disc)+tax;
    _persistDraft();
    const el = id => document.getElementById(id);
    if (el('crSub'))   el('crSub').textContent   = Fmt.money(sub);
    if (el('crTax'))   el('crTax').textContent   = Fmt.money(tax);
    if (el('crTotal')) el('crTotal').textContent = Fmt.money(tot);
    _syncCreditPanel(tot);
  }

  async function checkout() {
    if (!_cart.length) { Toast.err('السلة فارغة','أضف أصنافًا للسلة أولاً'); return; }
    const sub   = _cart.reduce((a,i)=>a+i.total,0);
    const disc  = Math.min(_discount,sub);
    const tax   = (sub-disc)*TAX_RATE;
    const total = (sub-disc)+tax;
    const patId = document.getElementById('posCustomer')?.value||null;
    if(_payMethod==='آجل'){
      _credit.name=document.getElementById('creditCustomerName')?.value.trim()||'';
      _credit.phone=document.getElementById('creditPhone')?.value.trim()||'';
      _credit.paid=Number(document.getElementById('creditPaidAmount')?.value||0);
      if(_credit.name.length<2){Toast.warn('اسم العميل مطلوب','اكتب اسم العميل لإصدار فاتورة آجلة');document.getElementById('creditCustomerName')?.focus();return;}
      if(!Number.isFinite(_credit.paid)||_credit.paid<0){Toast.warn('المبلغ غير صحيح','اكتب المبلغ الذي دفعه العميل أو اتركه صفرًا');document.getElementById('creditPaidAmount')?.focus();return;}
      if(_credit.paid>total){Toast.warn('المبلغ أكبر من الإجمالي','لا يمكن أن يكون المدفوع أكبر من قيمة الفاتورة');document.getElementById('creditPaidAmount')?.focus();return;}
    }
    if(_checkoutBusy)return;
    _checkoutBusy=true;
    const page=document.getElementById('page-sales');page.inert=true;
    // FIX: use the actually logged-in user's name instead of a hardcoded doctor name
    const cashierName = Auth?.getCurrent?.()?.fullName || '';

    try {
      _persistDraft();
      const draftMeta=await PosDraft.flush();
      const customer=patId ? await DB.getCustomer(patId) : null;
      const current=await Promise.all(_cart.map(item=>DB.getProduct(item.productId)));
      for(let i=0;i<_cart.length;i++){
        if(!current[i]||_stockOf(current[i])<_cart[i].qty)throw new Error('المخزون تغيّر؛ راجع كميات السلة');
        const custType = customer?.customerType==='جملة' ? 'جملة' : 'فرد';
        const expectedPrice=_priceFor(current[i],_cart[i].qty,custType);
        if(expectedPrice!==_cart[i].price)throw new Error('سعر '+_cart[i].name+' تغيّر؛ احذف الصنف وأضفه بالسعر الحالي');
      }
      const result = await DB.addSale({
        ...draftMeta,
        customerId:   patId,
        customerName: customer?.name||'عميل عادي',
        items:       _cart.map(i=>({productId:i.productId,name:i.name,qty:i.qty,price:i.price,total:i.total,...(i.trackSerial?{serials:i.serials}:{})})),
        subtotal:sub, discount:disc, tax, total,
        paymentMethod: _payMethod,
        creditCustomerName:_credit.name,
        creditPhone:_credit.phone,
        creditPaidAmount:_credit.paid,
        cashier: cashierName,
        useLoyalty: _useLoyalty,
      });

      const saleData = {
        invoiceNum: result.invoiceNum, date:result.date, time:result.time,
        customerName: result.customerName||customer?.name||(_payMethod==='آجل'?_credit.name:'عميل عادي'),
        items: _cart.slice(),
        subtotal:sub, discount:disc, tax, total:result.total??total,
        customerAmount:result.customerAmount??result.total??total,
        loyaltyDiscount:result.loyaltyDiscount??0,
        paymentMethod: _payMethod,
        creditPaid:result.creditPaid??0,
        creditRemaining:result.creditRemaining??0,
        cashier: cashierName,
      };

      Modal.open({
        title: `<i class="fas fa-receipt"></i> الفاتورة ${result.invoiceNum}`,
        size: 'sm',
        body: `<div id="receiptPrint">${_buildReceipt(saleData)}</div>`,
        foot: `<button class="btn btn-primary" onclick="printElement('receiptPrint')"><i class="fas fa-print"></i> طباعة</button>
               <button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>`,
      });
      if (DeviceSettings.get().autoPrint) {
        setTimeout(() => printElement('receiptPrint'), 300);
      }

      Toast.ok('تمت العملية', `تم إصدار ${result.invoiceNum} بقيمة ${Fmt.money(result.total??total)}`);
      PosDraft.completed();_restoring=true;
      _cart=[]; _discount=0; _draftCustomer=null;_credit={name:'',phone:'',paid:0};_useLoyalty=false;
      document.getElementById('useLoyalty').checked=false;document.getElementById('loyaltyOption').style.display='none';
      const di=document.getElementById('discountInput'); if(di) di.value='0';
      const pp=document.getElementById('posCustomer');    if(pp) pp.value='';
      _syncCreditPanel(0);

      // refresh products stock
      const products = await DB.getTopSellingProducts(50); _allProducts = products;
      updateCartUI(); renderGrid();
    } catch(e) { Toast.err('خطأ في الحفظ', e.message); }
    finally {_checkoutBusy=false;_restoring=false;page.inert=false;}
  }

  function _buildReceipt(s) {
    return `
    <div class="receipt">
      <div class="rcp-head">
        ${_shopLogo ? `<img src="${_shopLogo}" style="width:44px;height:44px;object-fit:cover;border-radius:8px;margin-bottom:.4rem" />` : ''}
        <div class="rcp-title">${_shopName}</div>
        <div class="rcp-sub">موبايلات • أدوات كهربائية • صيانة</div>
        <div class="rcp-sub" style="margin-top:.3rem">${s.date} — ${s.time}</div>
      </div>
      <div class="rcp-div"></div>
      <div class="rcp-row"><span>رقم الفاتورة</span><span>${s.invoiceNum}</span></div>
      <div class="rcp-row"><span>العميل</span><span>${_esc(s.customerName)}</span></div>
        ${(_showCashier && s.cashier) ? `<div class="rcp-row"><span>البائع</span><span>${_esc(s.cashier)}</span></div>` : ''}
      <div class="rcp-row"><span>طريقة الدفع</span><span>${_esc(s.paymentMethod)}</span></div>
      <div class="rcp-div"></div>
      ${s.items.map(i=>`
        <div class="rcp-row"><span>${_esc(i.name)}</span><span>${Fmt.money(i.total)}</span></div>
        <div class="rcp-row" style="font-size:.72rem;color:var(--tx-3)"><span>${i.qty} × ${Fmt.money(i.price)}${i.warrantyMonths ? ` • ضمان ${i.warrantyMonths} شهر` : ''}</span></div>
        ${i.trackSerial ? `<div class="rcp-row" style="font-size:.68rem;color:var(--tx-3)"><span dir="ltr">IMEI/SN: ${i.serials.map(_esc).join(' , ')}</span></div>` : ''}
      `).join('')}
      <div class="rcp-div"></div>
      <div class="rcp-row"><span>المجموع الفرعي</span><span>${Fmt.money(s.subtotal)}</span></div>
      ${s.discount>0?`<div class="rcp-row"><span>الخصم</span><span>− ${Fmt.money(s.discount)}</span></div>`:''}
      ${s.loyaltyDiscount>0?`<div class="rcp-row"><span>خصم نقاط الولاء</span><span>− ${Fmt.money(s.loyaltyDiscount)}</span></div>`:''}
      ${(_showTax && s.tax>0)?`<div class="rcp-row"><span>الضريبة ${Math.round(TAX_RATE*10000)/100}%</span><span>${Fmt.money(s.tax)}</span></div>`:''}
      ${s.paymentMethod==='آجل'?`<div class="rcp-row"><span>المدفوع الآن</span><span>${Fmt.money(s.creditPaid)}</span></div><div class="rcp-row bold"><span>المتبقي على العميل</span><span>${Fmt.money(s.creditRemaining)}</span></div>`:''}
      <div class="rcp-div"></div>
      <div class="rcp-row total"><span>الإجمالي</span><span>${Fmt.money(s.total)}</span></div>
      <div class="rcp-barcode">
        ${BarcodeGenerator.generateSVG(s.invoiceNum, { height: 28, includeText: true })}
      </div>
      <div class="rcp-foot-note">${_invoiceNote}</div>
    </div>`;
  }

  return { render, afterRender };
})();
