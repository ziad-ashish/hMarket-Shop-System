/* ════════════════════════════════════════════════════════════
   DATA.JS  —  Flask REST API bridge
   بدل PyWebView، كل طلب بيروح لـ Flask على /api/<method>
   التطبيق يعمل عبر الخادم المحلي فقط (run.bat)
════════════════════════════════════════════════════════════ */
'use strict';

/* ── هل السيرفر شغال؟ (Flask) ──────────────────────────── */
const _IS_FLASK = (() => {
  // لو الصفحة اتفتحت من سيرفر (http/https) مش من ملف محلي
  return location.protocol === 'http:' || location.protocol === 'https:';
})();

/* ── Flask fetch helper ─────────────────────────────────── */
async function _api(method, options = {}) {
  const { params = null, body = null } = options;

  let url = `/api/${method}`;
  if (params) {
    const q = new URLSearchParams(params);
    url += '?' + q.toString();
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  const fetchOpts = {
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
  };

  if (body !== null) {
    fetchOpts.method = 'POST';
    fetchOpts.body   = JSON.stringify(body);
  } else {
    fetchOpts.method = 'GET';
  }

  let res, parsed;
  try {
    res = await fetch(url, fetchOpts);
    parsed = await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('انتهت مهلة الاتصال بالخادم. حاول مرة أخرى.');
    throw new Error('تعذر الاتصال بخادم المحل. تأكد أن البرنامج يعمل ثم حاول مرة أخرى.');
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) throw new Error(parsed?.error || `خطأ في الخادم (${res.status})`);
  if (!parsed.ok) throw new Error(parsed.error || 'تعذر إتمام العملية');
  return parsed.data;
}


/* ════════════════════════════════════════════════════════
   لا يوجد وضع عمل بدون خادم: الفتح المباشر للملف غير مدعوم
════════════════════════════════════════════════════════ */
const _LS = new Proxy({}, {
  get: () => () => Promise.reject(new Error('شغّل البرنامج من run.bat — فتح الملف مباشرة غير مدعوم')),
});



/* ════════════════════════════════════════════════════════
   DB — الواجهة الموحدة (Flask أو localStorage)
════════════════════════════════════════════════════════ */
const DB = {

  /* ── normalisers (نفس المنطق للـ two modes) ─────────── */
  _normProduct(m) {
    if(!m)return null;
    return { id:m.id, name:m.name, brand:m.brand??'', model:m.model??'', category:m.category, price:+m.price, cost:+m.cost,
      stock:+m.stock, minStock:+(m.min_stock??m.minStock??5), unit:m.unit??'قطعة',
      supplierId:m.supplier_id??m.supplierId??'',
      barcode:m.barcode??'', companyBarcode:m.company_barcode??m.companyBarcode??'',
      shopBarcode:m.shop_barcode??m.shopBarcode??'',
      trackSerial:!!(m.track_serial??m.trackSerial), warrantyMonths:Number(m.warranty_months??m.warrantyMonths)||0,
      isService:!!(m.is_service??m.isService),
      purchaseUnit:m.purchase_unit||m.purchaseUnit||m.unit,
      saleUnit:m.sale_unit||m.saleUnit||m.unit,conversionFactor:Number(m.conversion_factor??m.conversionFactor)||1,
      scanQuantity:Number(m.scan_quantity??m.scanQuantity)||1,scanUnit:m.scan_unit??m.scanUnit??m.unit,
      scanRequiresConfiguration:!!m.scan_requires_configuration,
      scanSerial:m.scan_serial??null, scanSerialStatus:m.scan_serial_status??null,
      sellableStock:Number(m.sellable_stock??m.stock),
      wholesalePrice:(m.wholesale_price??m.wholesalePrice)!=null?+(m.wholesale_price??m.wholesalePrice):null,
      wholesaleMinQty:Number(m.wholesale_min_qty??m.wholesaleMinQty)||1,
      imageUrl:m.has_image ? `/api/product_image/${encodeURIComponent(m.id)}` : '',
      location:m.location??'', description:m.description??'', imageData:m.image_data??m.imageData };
  },
  _normPat(p) {
    return { id:p.id, name:p.name, phone:p.phone,
      address:p.address??'', notes:p.notes??'', createdAt:p.created_at??p.createdAt??'',
      customerType:p.customer_type??p.customerType??'فرد',
      companyName:p.company_name??p.companyName??'',
      taxNum:p.tax_num??p.taxNum??'',
      creditLimit:+(p.credit_limit??p.creditLimit??0) };
  },
  _normSup(s) {
    return { id:s.id, name:s.name, contact:s.contact??'', phone:s.phone??'',
      email:s.email??'', address:s.address??'', taxNum:s.tax_num??s.taxNum??'',
      paymentTerms:s.payment_terms??s.paymentTerms??'30 يوم', status:s.status??'نشط',
      rating:+(s.rating??3), totalOrders:+(s.total_orders??s.totalOrders??0),
      lastOrder:s.last_order??s.lastOrder??'—' };
  },
  _normSale(s) {
    return { id:s.id, invoiceNum:s.invoice_num??s.invoiceNum??'',
      customerId:s.customer_id??s.customerId??null,
      customerName:s.customer_name??s.customerName??'',
      items:(s.items??[]).map(i=>({productId:i.product_id??i.productId,name:i.name,qty:+i.qty,price:+i.price,total:+i.total,
        cost:+(i.cost??0), serials:(()=>{ try { return Array.isArray(i.serials)?i.serials:(i.serials?JSON.parse(i.serials):[]); } catch { return []; } })(),
        warrantyMonths:+(i.warranty_months??i.warrantyMonths??0), warrantyEnd:i.warranty_end??i.warrantyEnd??''})),
      subtotal:+(s.subtotal??0), discount:+(s.discount??0), tax:+(s.tax??0), total:+(s.total??0),
      paymentMethod:s.payment_method??s.paymentMethod??'نقدي', cashier:s.cashier??'',
      date:s.sale_date??s.date??'', time:s.sale_time??s.time??'', status:s.status??'مكتمل', source:s.source??'pos', customerAmount:+(s.customer_amount??s.total??0) };
  },
  _normUser(u) {
    return { id:u.id, username:u.username, fullName:u.full_name??u.fullName??'',
      role:u.role??'بائع', phone:u.phone??'', email:u.email??'',
      createdAt:u.created_at??u.createdAt??'', lastLogin:u.last_login??u.lastLogin??'',
      isDefaultPassword:u.is_default_password??false };
  },
  _toSnakeProduct(d) {
    return { name:d.name, brand:d.brand??'', model:d.model??'', category:d.category, price:d.price, cost:d.cost,
      stock:d.stock, min_stock:d.minStock, unit:d.unit, supplier_id:d.supplierId,
      barcode:d.barcode??'', company_barcode:d.companyBarcode??'',
      shop_barcode:d.shopBarcode??'', location:d.location,
      description:d.description, ...(d.imageData!==undefined?{image_data:d.imageData}:{}),
      track_serial:d.trackSerial?1:0, warranty_months:Math.max(0, Number(d.warrantyMonths)||0), is_service:d.isService?1:0,
      purchase_unit:d.purchaseUnit||d.unit||'قطعة', sale_unit:d.saleUnit||d.unit||'قطعة',
      conversion_factor:Math.max(1, Number(d.conversionFactor)||1),
      wholesale_price:(d.wholesalePrice===''||d.wholesalePrice==null)?null:Number(d.wholesalePrice),
      wholesale_min_qty:Math.max(1, Number(d.wholesaleMinQty)||1) };
  },
  _toSnakePat(d) {
    return { name:d.name, phone:d.phone, address:d.address, notes:d.notes,
      customer_type:d.customerType||'فرد', company_name:d.companyName??'',
      tax_num:d.taxNum??'', credit_limit:Number(d.creditLimit)||0 };
  },
  _toSnakeSup(d) {
    return { name:d.name, contact:d.contact, phone:d.phone, email:d.email,
      address:d.address, tax_num:d.taxNum, payment_terms:d.paymentTerms,
      status:d.status, rating:d.rating };
  },

  /* helper: يضيف user_id للـ body لو موجود */
  _withUser(obj) {
    const user = Auth?.getCurrent?.();
    if (user?.id) obj.__user_id = user.id;
    return obj;
  },

  /* ── PRODUCTS ──────────────────────────────────────── */
  async getProducts(limit=100, offset=0, q='') { 
    if (!_IS_FLASK) return _LS.getProducts();
    const result = await _api('get_products', {params:{limit, offset, q}});
    return result.products ? result.products.map(m=>this._normProduct(m)) : (result.map ? result.map(m=>this._normProduct(m)) : []);
  },
  async getProduct(id)     { return _IS_FLASK ? this._normProduct(await _api(`get_product/${id}`)) : _LS.getProduct(id); },
  async getProductByBarcode(barcode) {
    if (_IS_FLASK) {
      const raw = await _api(`get_product_by_barcode/${encodeURIComponent(barcode)}`);
      return raw ? this._normProduct(raw) : null;
    }
    const all = await _LS.getProducts();
    return all.find(m => m.shopBarcode===barcode) || all.find(m => m.companyBarcode===barcode) || all.find(m => m.barcode===barcode) || null;
  },
  async addProduct(data)   {
    if (_IS_FLASK) return _api('add_product', {body: this._withUser(this._toSnakeProduct(data))});
    return _LS.addProduct(data);
  },
  async updateProduct(id,d) {
    if (_IS_FLASK) return _api(`update_product/${id}`, {body: this._withUser(this._toSnakeProduct(d))});
    return _LS.updateProduct(id, d);
  },
  async deleteProduct(id)  {
    if (_IS_FLASK) return _api(`delete_product/${id}`, {body: this._withUser({})});
    return _LS.deleteProduct(id);
  },
  async getLowStock()       { return _IS_FLASK ? (await _api('get_low_stock')).map(m=>this._normProduct(m)) : _LS.getLowStock(); },
  async getStockAgingReport() { return _api('get_stock_aging_report'); },

  /* ── SERIAL / IMEI + WARRANTY ─────────────────────────── */
  async getSerialUnits(productId=null, status=null, q=null, limit=100, offset=0) {
    const params={limit, offset}; 
    if(productId)params.product_id=productId; 
    if(status)params.status=status; 
    if(q)params.q=q;
    const result = await _api('get_serial_units', {params});
    return result.units || (result.map ? result : []);
  },
  async addSerialUnits(data) { return _api('add_serial_units', {body:this._withUser(data)}); },
  async updateSerialUnit(id, data) { return _api(`update_serial_unit/${id}`, {body:this._withUser(data)}); },
  async lookupSerial(code) { return _api(`lookup_serial/${encodeURIComponent(code)}`); },
  async searchWarranty(q) { return _api('search_warranty', {params:{q}}); },

  /* ── REPAIRS / الصيانة ─────────────────────────────────── */
  async getRepairs(status=null, q=null) { const params={}; if(status)params.status=status; if(q)params.q=q; return _api('get_repairs', {params}); },
  async getRepair(id) { return _api(`get_repair/${id}`); },
  async getRepairStats() { return _api('get_repair_stats'); },
  async getTechnicians() { return _api('get_technicians'); },
  async addRepair(data) { return _api('add_repair', {body:this._withUser(data)}); },
  async updateRepair(id, data) { return _api(`update_repair/${id}`, {body:this._withUser(data)}); },
  async deliverRepair(id, data={}) { return _api(`deliver_repair/${id}`, {body:this._withUser(data)}); },
  async cancelRepair(id, reason='') { return _api(`cancel_repair/${id}`, {body:this._withUser({reason})}); },
  async getCategories()     { return _IS_FLASK ? _api('get_categories') : _LS.getCategories(); },

  /* ── STOCKTAKE / STOCK LEDGER ──────────────────────────── */
  async getStocktakeWorksheet(category=null) { return _IS_FLASK ? _api('get_stocktake_worksheet', category?{params:{category}}:{}) : []; },
  async submitStocktake(items, notes) { return _IS_FLASK ? _api('submit_stocktake', {body:this._withUser({items, notes})}) : null; },
  async getStockLedger(productId, dateFrom=null, dateTo=null) {
    const params={}; if(dateFrom)params.date_from=dateFrom; if(dateTo)params.date_to=dateTo;
    return _IS_FLASK ? _api(`get_stock_ledger/${productId}`, {params}) : {product:{},movements:[]};
  },
  async getHealthCheck() { return _IS_FLASK ? _api('get_health_check') : {overall:'ok',checks:[]}; },
  async getTopSellingProducts(limit=50) { return _IS_FLASK ? (await _api(`get_top_selling_products/${limit}`)).map(m=>this._normProduct(m)) : (await _LS.getProducts()).slice(0,limit); },
  async searchProducts(q)  { return _IS_FLASK ? (await _api('search_products',{params:{q}})).map(m=>this._normProduct(m)) : (await _LS.getProducts()).filter(m=>m.name.includes(q)); },

  /* ── CUSTOMERS ──────────────────────────────────────── */
  async getCustomers(limit=100, offset=0, q='')       { 
    if (!_IS_FLASK) return _LS.getCustomers();
    const result = await _api('get_customers', {params:{limit, offset, q}});
    return result.customers ? result.customers.map(p=>this._normPat(p)) : (result.map ? result.map(p=>this._normPat(p)) : []);
  },
  async getCustomer(id)      { return _IS_FLASK ? this._normPat(await _api(`get_customer/${id}`)) : _LS.getCustomer(id); },
  async addCustomer(data)    {
    if (_IS_FLASK) return _api('add_customer', {body: this._withUser(this._toSnakePat(data))});
    return _LS.addCustomer(data);
  },
  async updateCustomer(id,d) {
    if (_IS_FLASK) return _api(`update_customer/${id}`, {body: this._withUser(this._toSnakePat(d))});
    return _LS.updateCustomer(id, d);
  },
  async deleteCustomer(id)   {
    if (_IS_FLASK) return _api(`delete_customer/${id}`, {body: this._withUser({})});
    return _LS.deleteCustomer(id);
  },

  /* ── SUPPLIERS ──────────────────────────────────────── */
  async getSuppliers()       { return _IS_FLASK ? (await _api('get_suppliers')).map(s=>this._normSup(s)) : _LS.getSuppliers(); },
  async getSupplier(id)      { return _IS_FLASK ? this._normSup(await _api(`get_supplier/${id}`)) : _LS.getSupplier(id); },
  async addSupplier(data)    {
    if (_IS_FLASK) return _api('add_supplier', {body: this._withUser(this._toSnakeSup(data))});
    return _LS.addSupplier(data);
  },
  async updateSupplier(id,d) {
    if (_IS_FLASK) return _api(`update_supplier/${id}`, {body: this._withUser(this._toSnakeSup(d))});
    return _LS.updateSupplier(id, d);
  },
  async deleteSupplier(id)   {
    if (_IS_FLASK) return _api(`delete_supplier/${id}`, {body: this._withUser({})});
    return _LS.deleteSupplier(id);
  },

  /* ── SALES ──────────────────────────────────────────── */
  async getSales(limit=100, offset=0) { 
    if (!_IS_FLASK) return _LS.getSales();
    const result = await _api('get_sales', {params:{limit, offset}});
    return result.sales ? result.sales.map(s=>this._normSale(s)) : (result.map ? result.map(s=>this._normSale(s)) : []);
  },
  async getSale(id)         { return _IS_FLASK ? this._normSale(await _api(`get_sale/${id}`)) : _LS.getSale(id); },
  async addSale(data)       {
    if (_IS_FLASK) return _api('add_sale', {body: this._withUser({...data,
      customer_id:data.customerId??data.customer_id??null, customer_name:data.customerName??data.customer_name??'',
      payment_method:data.paymentMethod??data.payment_method??'نقدي', use_loyalty:Boolean(data.useLoyalty??data.use_loyalty),
      credit_customer_name:data.creditCustomerName??data.credit_customer_name??'',
      credit_phone:data.creditPhone??data.credit_phone??'',
      credit_paid_amount:data.creditPaidAmount??data.credit_paid_amount??0
    })});
    return _LS.addSale(data);
  },
  async voidSale(id)        {
    if (_IS_FLASK) return _api(`void_sale/${id}`, {body: this._withUser({})});
    return _LS.voidSale(id);
  },

  /* ── STATS ──────────────────────────────────────────── */
  async getStats()          { return _IS_FLASK ? _api('get_stats')           : _LS.getStats(); },
  async getDashboardReport(fromDate, toDate) {
    if (_IS_FLASK) {
      return _api('get_dashboard_report', {params:{from_date:fromDate,to_date:toDate}});
    }

    const [sales, products] = await Promise.all([_LS.getSales(), _LS.getProducts()]);
    const completed = sales.filter(s => s.status === 'مكتمل' && s.date >= fromDate && s.date <= toDate);
    const productCosts = Object.fromEntries(products.map(m => [m.id, Number(m.cost) || 0]));
    const revenue = completed.reduce((sum, s) => sum + Number(s.total || 0), 0);
    const estimatedCost = completed.reduce((sum, s) => sum + (s.items || []).reduce(
      (itemSum, item) => itemSum + Number(item.qty || 0) * (productCosts[item.productId] || 0), 0), 0);
    const spanDays = Math.floor((new Date(toDate) - new Date(fromDate)) / 86400000) + 1;
    const bucketOf = value => spanDays <= 62 ? value : value.slice(0, 7);
    const seriesMap = {};
    const topMap = {};
    const paymentMap = {};
    completed.forEach(s => {
      const bucket = bucketOf(s.date);
      seriesMap[bucket] = (seriesMap[bucket] || 0) + Number(s.total || 0);
      const method = s.paymentMethod || 'غير محدد';
      paymentMap[method] ||= {method,count:0,total:0};
      paymentMap[method].count += 1;
      paymentMap[method].total += Number(s.total || 0);
      (s.items || []).forEach(item => {
        topMap[item.name] ||= {name:item.name,qty:0,revenue:0};
        topMap[item.name].qty += Number(item.qty || 0);
        topMap[item.name].revenue += Number(item.total || 0);
      });
    });
    return {
      from:fromDate,
      to:toDate,
      summary:{
        count:completed.length,
        revenue,
        average:completed.length ? revenue / completed.length : 0,
        discount:completed.reduce((sum,s)=>sum+Number(s.discount||0),0),
        tax:completed.reduce((sum,s)=>sum+Number(s.tax||0),0),
        estimatedCost,
        estimatedProfit:revenue-estimatedCost,
        growthPct:null,
      },
      series:{labels:Object.keys(seriesMap).sort(),values:Object.keys(seriesMap).sort().map(k=>seriesMap[k]),granularity:spanDays<=62?'day':'month'},
      topProducts:Object.values(topMap).sort((a,b)=>b.qty-a.qty).slice(0,5),
      recentSales:completed.slice().sort((a,b)=>`${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`)).slice(0,6).map(s=>({invoice_num:s.invoiceNum,customer_name:s.customerName,total:s.total,sale_date:s.date,sale_time:s.time,payment_method:s.paymentMethod})),
      payments:Object.values(paymentMap).sort((a,b)=>b.total-a.total),
    };
  },
  async getMonthlySales()   { return _IS_FLASK ? _api('get_monthly_sales')   : _LS.getMonthlySales(); },
  async getTopProducts()        { return _IS_FLASK ? _api('get_top_products')   : _LS.getTopProducts(); },
  async getCatDist()        { return _IS_FLASK ? _api('get_category_dist')   : _LS.getCategoryDist(); },
  async getRecentActivity() { return _IS_FLASK ? _api('get_recent_activity') : _LS.getRecentActivity(); },
  async getProfitReport(period='all') {
    return _IS_FLASK ? _api(`get_profit_report/${period}`) : _LS.getProfitReport();
  },
  async getTurnoverReport(days=30) { return _IS_FLASK ? _api('get_turnover_report',{params:{days}}) : []; },
  async getSupplierPriceComparison(productId=null) { return _IS_FLASK ? _api('get_supplier_price_comparison', productId?{params:{product_id:productId}}:{}) : []; },
  async getDebts(overdue=false) { return _IS_FLASK ? _api('get_debts',{params:{overdue:overdue?'1':'0'}}) : []; },
  async getCustomerDebt(customerId) { return _IS_FLASK ? _api(`get_customer_debt/${customerId}`) : {balance:0}; },
  async payDebt(id,amount) { return _IS_FLASK ? _api(`pay_debt/${id}`,{body:this._withUser({amount})}) : {}; },
  async getLoyalty(customerId) { return _IS_FLASK ? _api(`get_loyalty/${customerId}`) : {points:0}; },
  async importProductsCSV(file) {
    if (!_IS_FLASK) throw new Error('الاستيراد متاح عند تشغيل الخادم فقط');
    const form=new FormData(); form.append('file',file); form.append('__user_id',Auth?.getCurrent?.()?.id||'');
    const res=await fetch('/api/import_products',{method:'POST',body:form}); const parsed=await res.json();
    if(!res.ok||!parsed.ok) throw new Error(parsed.error||'فشل الاستيراد'); return parsed.data;
  },

  /* ── SETTINGS ───────────────────────────────────────── */
  async getSetting(key)         { return _IS_FLASK ? _api(`get_setting/${key}`) : _LS.getSetting(key); },
  async setSetting(key, value)  {
    if (_IS_FLASK) return _api('set_setting', {body:{key, value}});
    return _LS.setSetting(key, value);
  },
  async listBackups()           { return _IS_FLASK ? _api('list_backups') : _LS.listBackups(); },
  async backupDatabase()        { return _IS_FLASK ? _api('backup_database', {body:{}}) : {message:'غير متاح'}; },
  async getBackupStatus()       { return _IS_FLASK ? _api('get_backup_status') : {stale:false}; },
  async restoreDatabase(path)   { return _IS_FLASK ? _api('restore_database', {body:{backup_path:path}}) : {}; },
  async getAuditLog(limit=100, offset=0) {
    return _IS_FLASK ? _api('get_audit_log', {params:{limit,offset}}) : _LS.getAuditLog();
  },

  /* ── AUTH ───────────────────────────────────────────── */
  async login(username, password) {
    if (_IS_FLASK) return this._normUser(await _api('login', {body:{username,password}}));
    return this._normUser(await _LS.login(username, password));
  },
  async getSession(uid) {
    if (_IS_FLASK) {
      const user = await _api('current_session');
      return user ? this._normUser(user) : null;
    }
    return uid ? this.getCurrentUser(uid) : null;
  },
  async checkPermission(perm) {
    if (_IS_FLASK) return _api('check_permission', {body:{perm}});
    return Auth.getCurrent()?.role==='مدير النظام';
  },
  async logout() {
    if (_IS_FLASK) return _api('logout', {body:{}});
  },
  async getUsers() {
    if (_IS_FLASK) return (await _api('get_users')).map(u=>this._normUser(u));
    return (await _LS.getUsers()).map(u=>this._normUser(u));
  },
  async getCurrentUser(uid) {
    if (_IS_FLASK) { const u=await _api(`get_current_user/${uid}`); return u?this._normUser(u):null; }
    const u=await _LS.getCurrentUser(uid); return u?this._normUser(u):null;
  },
  async changePassword(uid, oldPwd, newPwd) {
    if (_IS_FLASK) return _api('change_password', {body:{uid,old_pwd:oldPwd,new_pwd:newPwd}});
    return _LS.changePassword(uid, oldPwd, newPwd);
  },

  /* ── USER MANAGEMENT (admin only) ──────────────────── */
  async addUser(data) {
    if (_IS_FLASK) return _api('add_user', {body: this._withUser({...data})});
    return _LS.addUser(data);
  },
  async updateUser(uid, data) {
    if (_IS_FLASK) return _api(`update_user/${uid}`, {body: this._withUser({...data})});
    return _LS.updateUser(uid, data);
  },
  async deleteUser(uid) {
    if (_IS_FLASK) return _api(`delete_user/${uid}`, {body: this._withUser({})});
    return _LS.deleteUser(uid);
  },
  async resetUserPassword(uid, newPwd) {
    if (_IS_FLASK) return _api(`reset_user_password/${uid}`, {body: this._withUser({new_pwd: newPwd})});
    return _LS.resetUserPassword(uid, newPwd);
  },

  /* ── no-op seed (Python handles it) ────────────────── */
  seed() {},

  /* ── PURCHASES ──────────────────────────────────────── */
  async getPurchases()          { return _IS_FLASK ? _api('get_purchases') : []; },
  async getPurchase(id)         { return _IS_FLASK ? _api(`get_purchase/${id}`) : null; },
  async addPurchase(data)       { return _IS_FLASK ? _api('add_purchase', {body: this._withUser({...data})}) : {}; },
  async addCapturedPurchase(data) { return _IS_FLASK ? _api('add_captured_purchase', {body: this._withUser({...data})}) : {}; },
  async getPurchaseInvoiceImage(id) { return _IS_FLASK ? _api(`purchase_invoice_image/${id}`) : null; },
  async receivePurchase(id, d)  { return _IS_FLASK ? _api(`receive_purchase/${id}`, {body: this._withUser({...d})}) : {}; },
  async cancelPurchase(id)      { return _IS_FLASK ? _api(`cancel_purchase/${id}`, {body: this._withUser({})}) : {}; },

  /* ── ACCOUNTS ───────────────────────────────────────── */
  async getAccounts()           { return _IS_FLASK ? _api('get_accounts') : []; },
  async addAccount(data)        { return _IS_FLASK ? _api('add_account', {body: this._withUser({...data})}) : {}; },
  async updateAccount(id, data) { return _IS_FLASK ? _api(`update_account/${id}`, {body: this._withUser({...data})}) : {}; },
  async deleteAccount(id)       { return _IS_FLASK ? _api(`delete_account/${id}`, {body: this._withUser({})}) : {}; },
  async getTransactions(accountId, limit=100, offset=0) {
    const params = { limit, offset };
    if (accountId) params.account_id = accountId;
    return _IS_FLASK ? _api('get_transactions', {params}) : {items:[],total:0};
  },
  async addTransaction(data)    { return _IS_FLASK ? _api('add_transaction', {body: this._withUser({...data})}) : {}; },
  async getFinancialSummary()   { return _IS_FLASK ? _api('get_financial_summary') : {accounts:[],total_income:0,total_expense:0,net:0,month_income:0,month_expense:0,month_net:0,today_income:0,today_expense:0}; },

  /* ── CASH SESSIONS ──────────────────────────────────── */
  async getActiveSession()      { return _IS_FLASK ? _api('get_active_session') : null; },
  async openSession(data)       { return _IS_FLASK ? _api('open_session', {body: this._withUser({...data})}) : {}; },
  async closeSession(id, data)  { return _IS_FLASK ? _api(`close_session/${id}`, {body: this._withUser({...data})}) : {}; },
  async getSessions()           { return _IS_FLASK ? _api('get_sessions') : []; },

  /* ── HR & PAYROLL ───────────────────────────────────── */
  async getEmployees()          { return _IS_FLASK ? _api('get_employees') : []; },
  async addEmployee(data)       { return _IS_FLASK ? _api('add_employee', {body: this._withUser({...data})}) : {}; },
  async updateEmployee(id, d)   { return _IS_FLASK ? _api(`update_employee/${id}`, {body: this._withUser({...d})}) : {}; },
  async deleteEmployee(id)      { return _IS_FLASK ? _api(`delete_employee/${id}`, {body: this._withUser({})}) : {}; },
  async getPayroll(empId)       {
    const params = empId ? {employee_id: empId} : {};
    return _IS_FLASK ? _api('get_payroll', {params}) : [];
  },
  async addPayroll(data)        { return _IS_FLASK ? _api('add_payroll', {body: this._withUser({...data})}) : {}; },
  async getEmployeePerformance(empId) {
    const params = empId ? {employee_id: empId} : {};
    return _IS_FLASK ? _api('get_employee_performance', {params}) : [];
  },

  /* ── SHIPPING & DISTRIBUTION ───────────────────────────── */
  async getDrivers() { return _IS_FLASK ? _api('get_drivers') : []; },
  async addDriver(d) { return _IS_FLASK ? _api('add_driver', {body:this._withUser({name:d.name,phone:d.phone,national_id:d.nationalId,license_num:d.licenseNum,notes:d.notes})}) : null; },
  async updateDriver(id,d) { return _IS_FLASK ? _api(`update_driver/${id}`, {body:this._withUser({name:d.name,phone:d.phone,national_id:d.nationalId,license_num:d.licenseNum,notes:d.notes})}) : null; },
  async deleteDriver(id) { return _IS_FLASK ? _api(`delete_driver/${id}`, {body:this._withUser({})}) : null; },

  async getVehicles() { return _IS_FLASK ? _api('get_vehicles') : []; },
  async addVehicle(d) { return _IS_FLASK ? _api('add_vehicle', {body:this._withUser({plate_number:d.plateNumber,vehicle_type:d.vehicleType,capacity_note:d.capacityNote,notes:d.notes})}) : null; },
  async updateVehicle(id,d) { return _IS_FLASK ? _api(`update_vehicle/${id}`, {body:this._withUser({plate_number:d.plateNumber,vehicle_type:d.vehicleType,capacity_note:d.capacityNote,notes:d.notes})}) : null; },
  async deleteVehicle(id) { return _IS_FLASK ? _api(`delete_vehicle/${id}`, {body:this._withUser({})}) : null; },

  async getDeliveryTrips(status=null) { return _IS_FLASK ? _api('get_delivery_trips', status?{params:{status}}:{}) : []; },
  async getDeliveryTrip(id) { return _IS_FLASK ? _api(`get_delivery_trip/${id}`) : null; },
  async addDeliveryTrip(d) { return _IS_FLASK ? _api('add_delivery_trip', {body:this._withUser({driver_id:d.driverId,vehicle_id:d.vehicleId,notes:d.notes})}) : null; },
  async addDeliveryStop(tripId,d) { return _IS_FLASK ? _api(`add_delivery_stop/${tripId}`, {body:this._withUser({customer_id:d.customerId,sale_ids:d.saleIds,payment_mode:d.paymentMode,address:d.address,phone:d.phone,notes:d.notes})}) : null; },
  async getUnassignedSalesForCustomer(customerId) { return _IS_FLASK ? _api(`get_unassigned_sales_for_customer/${customerId}`) : []; },
  async dispatchTrip(id) { return _IS_FLASK ? _api(`dispatch_trip/${id}`, {body:this._withUser({})}) : null; },
  async cancelTrip(id) { return _IS_FLASK ? _api(`cancel_trip/${id}`, {body:this._withUser({})}) : null; },
  async getStopByBarcode(code) { return _IS_FLASK ? _api(`get_stop_by_barcode/${encodeURIComponent(code)}`) : null; },
  async updateStopStatus(id,d) { return _IS_FLASK ? _api(`update_stop_status/${id}`, {body:this._withUser({status:d.status,collected_amount:d.collectedAmount,notes:d.notes})}) : null; },
  async getDeliveryStats() { return _IS_FLASK ? _api('get_delivery_stats') : {preparing:0,on_road:0,pending_stops:0,problem_stops:0,amount_in_transit:0}; },
  async getDebtAgingReport(customerType=null) { return _IS_FLASK ? _api('get_debt_aging_report', customerType?{params:{customer_type:customerType}}:{}) : {customers:[],totals:{}}; },
  async getPurchaseSuggestions() { return _IS_FLASK ? _api('get_purchase_suggestions') : []; },
  async getDriverPerformanceReport(dateFrom=null,dateTo=null) {
    const params={}; if(dateFrom)params.date_from=dateFrom; if(dateTo)params.date_to=dateTo;
    return _IS_FLASK ? _api('get_driver_performance_report', {params}) : [];
  },
  async getCustomerProfitabilityReport(customerType=null) { return _IS_FLASK ? _api('get_customer_profitability_report', customerType?{params:{customer_type:customerType}}:{}) : []; },

  /* ── PROMOTIONS ────────────────────────────────────────── */
  async getPromotions(activeOnly=false) { return _IS_FLASK ? _api('get_promotions', activeOnly?{params:{active_only:'1'}}:{}) : []; },
  async addPromotion(d) { return _IS_FLASK ? _api('add_promotion', {body:this._withUser({name:d.name,product_id:d.productId,discount_type:d.discountType,discount_value:d.discountValue,min_qty:d.minQty,start_date:d.startDate,end_date:d.endDate})}) : null; },
  async updatePromotion(id,d) { return _IS_FLASK ? _api(`update_promotion/${id}`, {body:this._withUser({name:d.name,product_id:d.productId,discount_type:d.discountType,discount_value:d.discountValue,min_qty:d.minQty,start_date:d.startDate,end_date:d.endDate,is_active:d.isActive})}) : null; },
  async deletePromotion(id) { return _IS_FLASK ? _api(`delete_promotion/${id}`, {body:this._withUser({})}) : null; },

  /* ── RECURRING ROUTES ──────────────────────────────────── */
  async getRecurringRoutes() { return _IS_FLASK ? _api('get_recurring_routes') : []; },
  async addRecurringRoute(d) { return _IS_FLASK ? _api('add_recurring_route', {body:this._withUser({customer_id:d.customerId,weekday:d.weekday,driver_id:d.driverId,vehicle_id:d.vehicleId,payment_mode:d.paymentMode,notes:d.notes})}) : null; },
  async updateRecurringRoute(id,d) { return _IS_FLASK ? _api(`update_recurring_route/${id}`, {body:this._withUser({customer_id:d.customerId,weekday:d.weekday,driver_id:d.driverId,vehicle_id:d.vehicleId,payment_mode:d.paymentMode,notes:d.notes,is_active:d.isActive})}) : null; },
  async deleteRecurringRoute(id) { return _IS_FLASK ? _api(`delete_recurring_route/${id}`, {body:this._withUser({})}) : null; },
  async generateTodaysRecurringTrips() { return _IS_FLASK ? _api('generate_todays_recurring_trips', {body:this._withUser({})}) : null; },
};
