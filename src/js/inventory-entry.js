'use strict';
const InventoryEntry = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function categories(done) {
    try {
      const cats=await DB.getCategories();
      Modal.open({title:'إدارة التصنيفات',size:'lg',body:`<label>تصنيف جديد<input class="form-control" id="newInventoryCategory" maxlength="80"></label><button class="btn btn-primary" id="saveInventoryCategory">إضافة التصنيف</button><hr><p>عند حذف تصنيف مستخدم، انقل أصنافه لتصنيف آخر.</p><label>التصنيف<select id="deleteInventoryCategory" class="form-control">${cats.map(c=>`<option>${esc(c)}</option>`).join('')}</select></label><label>نقل الأصناف إلى<select class="form-control" id="replacementInventoryCategory"><option value="">بدون نقل (تصنيف فارغ فقط)</option>${cats.map(c=>`<option>${esc(c)}</option>`).join('')}</select></label>`,foot:'<button class="btn btn-danger" id="removeInventoryCategory">حذف التصنيف</button><button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>'});
      const save=async action=>{try{await _api('manage_inventory_category',{body:{action,name:document.getElementById(action==='delete'?'deleteInventoryCategory':'newInventoryCategory').value,replacement:document.getElementById('replacementInventoryCategory').value}});Modal.close();await done?.();}catch(e){Toast.err('تعذر الحفظ',e.message);}};
      document.getElementById('saveInventoryCategory').onclick=()=>save('add');
      document.getElementById('removeInventoryCategory').onclick=()=>save('delete');
    } catch(e){Toast.err('تعذر فتح التصنيفات',e.message);}
  }
  async function open() {
    const [suppliers,all,cats]=await Promise.all([DB.getSuppliers(),DB.getProducts(),DB.getCategories()]);
    let products=all.filter(p=>!p.isService), invoiceId=null,image=null,busy=false,token=crypto.randomUUID();
    const today=new Date();const date=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');
    Modal.open({title:'إضافة فاتورة مشتريات',size:'lg',body:`
      <p>أرفق الصورة، ثم أدخل كل بند واحفظه لإضافته للمخزون. كل بند محفوظ يظهر أسفل الشاشة ويمكن إعادة طباعة ملصقاته.</p>
      <fieldset id="entryHeader"><div class="form-row"><label>المورد<select id="entrySupplier" class="form-control"><option value="">اختر المورد</option>${suppliers.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><label>رقم الفاتورة<input class="form-control" id="entryNumber"></label><label>التاريخ<input type="date" class="form-control" id="entryDate" value="${date}"></label></div><label>صورة الفاتورة<input type="file" id="entryImage" accept="image/jpeg,image/png,image/webp" class="form-control"></label></fieldset>
      <img id="entryPreview" alt="صورة الفاتورة" hidden style="max-width:100%;max-height:350px;object-fit:contain;margin:10px auto">
      <fieldset id="entryFields"><label>المنتج<select id="entryProduct" class="form-control"><option value="">منتج جديد</option>${products.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <div id="entryNewFields" class="form-row"><label>اسم المنتج<input class="form-control" id="entryName"></label><label>التصنيف<select class="form-control" id="entryCategory"><option value="">اختر التصنيف</option>${cats.map(c=>`<option>${esc(c)}</option>`).join('')}</select></label></div>
      <label><input type="checkbox" id="entryDivisible"> شراء عبوة وبيع بالتجزئة (مثال: بكرة ← متر)</label>
      <div class="form-row"><label>وحدة الشراء<select class="form-control" id="entryPurchaseUnit">${['قطعة','بكرة','لفة','كرتونة','علبة','متر','كيلو','لتر'].map(u=>`<option>${u}</option>`).join('')}</select></label><label>وحدة البيع<select class="form-control" id="entrySaleUnit">${['قطعة','متر','كيلو','لتر'].map(u=>`<option>${u}</option>`).join('')}</select></label><label>عدد وحدات البيع في العبوة<input id="entryFactor" class="form-control" type="number" min="0.001" step="any" value="1"></label></div>
      <div class="form-row"><label>كمية الشراء<input id="entryQty" class="form-control" type="number" min="0.001" step="any" value="1"></label><label>تكلفة وحدة الشراء<input id="entryCost" class="form-control" type="number" min="0" step="0.01" value="0"></label><label>سعر بيع الوحدة / المتر<input id="entryPrice" class="form-control" type="number" min="0" step="0.01" value="0"></label><label>عدد ملصقات الباركود<input id="entryCopies" class="form-control" type="number" min="0" max="200" step="1" value="1"></label></div>
      <label id="entrySerialLabel" hidden>أرقام IMEI (رقم لكل جهاز)<textarea class="form-control" id="entrySerials"></textarea></label><p id="entrySummary"></p>
      <button type="button" class="btn btn-primary" id="entrySave">حفظ البند وإضافته للمخزون وطباعة الملصقات</button></fieldset><hr><div id="entrySaved"></div>`,foot:'<button class="btn btn-ghost" onclick="Modal.close()">إنهاء / إغلاق</button>'});
    const el=id=>document.getElementById('entry'+id);
    const summary=()=>{el('Summary').textContent=`سيضاف ${Number(el('Qty').value)*Number(el('Factor').value)} ${el('SaleUnit').value}؛ تكلفة وحدة البيع ${(Number(el('Cost').value)/Number(el('Factor').value)||0).toFixed(2)} ج.م؛ إجمالي البند ${(Number(el('Qty').value)*Number(el('Cost').value)).toFixed(2)} ج.م`;};
    el('Image').onchange=async e=>{const file=e.target.files[0];image=null;el('Preview').hidden=true;if(!file)return;try{image=await ProductsPage.prepareInvoiceImage(file);el('Preview').src=image;el('Preview').hidden=false;}catch(err){Toast.err('صورة غير صالحة',err.message);}};
    const configure=()=>{const p=products.find(p=>p.id===el('Product').value);el('NewFields').hidden=!!p;['PurchaseUnit','SaleUnit','Factor','Divisible'].forEach(k=>el(k).disabled=!!p);if(p){el('PurchaseUnit').add(new Option(p.purchaseUnit,p.purchaseUnit));el('SaleUnit').add(new Option(p.saleUnit,p.saleUnit));el('PurchaseUnit').value=p.purchaseUnit;el('SaleUnit').value=p.saleUnit;el('Factor').value=p.conversionFactor||1;el('Cost').value=p.cost*(p.conversionFactor||1);el('Price').value=p.price;}el('SerialLabel').hidden=!p?.trackSerial;summary();};
    el('Product').onchange=configure;
    el('Divisible').onchange=()=>{el('PurchaseUnit').value=el('Divisible').checked?'بكرة':'قطعة';el('SaleUnit').value=el('Divisible').checked?'متر':'قطعة';el('Factor').value=el('Divisible').checked?100:1;summary();};
    ['Qty','Cost','Factor','SaleUnit','PurchaseUnit'].forEach(k=>el(k).addEventListener('input',summary));summary();
    el('Save').onclick=async()=>{
      if(busy)return;busy=true;el('Fields').disabled=true;
      try {
        const result=await _api('inventory_invoice_line',{body:{token,invoice_id:invoiceId,image:invoiceId?undefined:image,supplier_id:el('Supplier').value,invoice_num:el('Number').value,invoice_date:el('Date').value,item:{product_id:el('Product').value,name:el('Name').value,category:el('Category').value,purchase_unit:el('PurchaseUnit').value,sale_unit:el('SaleUnit').value,factor:Number(el('Factor').value),quantity:Number(el('Qty').value),cost:Number(el('Cost').value),price:Number(el('Price').value),copies:Number(el('Copies').value),serials:el('Serials').value}}});
        invoiceId=result.invoice_id;token=crypto.randomUUID();el('Header').disabled=true;
        const row=document.createElement('p');row.textContent=`✓ ${result.name}: تمت إضافة ${result.stock_added} — الإجمالي ${result.total} ج.م `;
        const print=()=>window.open(`/api/print_labels?product_ids=${encodeURIComponent(result.product_id)}&copies=${result.copies}`,'_blank');
        if(result.copies){const button=document.createElement('button');button.className='btn btn-ghost';button.textContent='طباعة الملصقات';button.onclick=print;row.append(button);print();}
        el('Saved').append(row);Toast.ok('تم الحفظ','أضيف البند للمخزون؛ يمكنك إدخال البند التالي');
        el('Name').value='';el('Qty').value=1;el('Serials').value='';
      }catch(e){Toast.err('لم يتم حفظ البند',e.message);}finally{busy=false;if(el('Fields')){el('Fields').disabled=false;configure();}}
    };
  }
  async function services(){
    try{const products=(await DB.getProducts()).filter(p=>p.isService);Modal.open({title:'خدمات الصيانة',body:`${products.map(p=>`<p>${esc(p.name)} — ${Fmt.money(p.price)} <button class="btn btn-ghost" data-service="${esc(p.id)}">تعديل</button></p>`).join('')}`,foot:'<button class="btn btn-primary" id="newRepairService">إضافة خدمة</button><button class="btn btn-ghost" onclick="Modal.close()">إغلاق</button>'});document.querySelectorAll('[data-service]').forEach(b=>b.onclick=()=>ProductsPage.openEditModal(products.find(p=>p.id===b.dataset.service)));document.getElementById('newRepairService').onclick=async()=>{await ProductsPage.openAddModal();const kind=document.getElementById('fProductKind');kind.value='service';kind.dispatchEvent(new Event('change'));const cat=document.getElementById('fProductCategory');cat.add(new Option('خدمات','خدمات'));cat.value='خدمات';};}catch(e){Toast.err('تعذر فتح الخدمات',e.message);}
  }
  return {open,categories,services};
})();
