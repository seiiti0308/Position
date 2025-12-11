/* ========== 纯前端实时版（居中+排序+导入导出+整行看盘 + 栏目管理 + 拖拽排序 + 日期筛选 + 迷你热图 + 批量操作） ========== */
const STORAGE_KEY = 'stockPosReal_v2';
let data = { categories: [{ id: 'default', name: '投顾' }], positions: [] };
let currentCategoryId = 'default';
let editingIdx = -1;
let timer = null;
let searchKey = '';
let sortKey = '', sortDir = '';
let dateStart = '', dateEnd = '';
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth() + 1;
const WEEK_HEAD = ['日','一','二','三','四','五','六'];
const selectedSet = new Set();

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function fmtDate() { return new Date().toISOString().split('T')[0]; }

/* ---------- 存取 ---------- */
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { console.warn('解析失败'); }
  }
  const oldList = JSON.parse(localStorage.getItem('stockPosReal') || '[]');
  if (oldList.length) {
    const nameSet = new Set(oldList.map(i => i.category || '投顾'));
    const newCats = Array.from(nameSet).map(name => ({ id: uid(), name }));
    const name2id = Object.fromEntries(newCats.map(c => [c.name, c.id]));
    const newPos = oldList.map(pos => ({ ...pos, id: uid(), categoryId: name2id[pos.category || '投顾'] || name2id['投顾'] }));
    const migrated = { categories: newCats, positions: newPos };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  }
  return { categories: [{ id: 'default', name: '投顾' }], positions: [] };
}

/* ---------- CSV ---------- */
function objToCSV(list) {
  const head = 'clientName,code,name,quantity,cost,current,dayRate,marketValue,profit,profitPct,pinned,joinDate,categoryName';
  const rows = list.map(r => {
    const catName = data.categories.find(c => c.id === r.categoryId)?.name || '投顾';
    return [
      r.clientName, r.code, r.name, r.quantity, r.cost, r.current, r.dayRate,
      r.marketValue, r.profit, r.profitPct, r.pinned ? 1 : 0, r.joinDate, catName
    ].map(v => (v + '').includes(',') ? `"${v}"` : v).join(',');
  });
  return [head, ...rows].join('\n');
}

function csvToObj(str) {
  const lines = str.trim().split('\n');
  const rows = lines.slice(1).map(l => {
    const val = l.split(',').map(v => v.replace(/^"|"$/g, ''));
    return {
      clientName: val[0],
      code: val[1],
      name: val[2],
      quantity: Number(val[3]) || 0,
      cost: Number(val[4]) || 0,
      current: Number(val[5]) || 0,
      dayRate: Number(val[6]) || 0,
      marketValue: Number(val[7]) || 0,
      profit: Number(val[8]) || 0,
      profitPct: Number(val[9]) || 0,
      pinned: (val[10] || '0') === '1',
      joinDate: val[11] || fmtDate(),
      categoryName: val[12] || '投顾',
      id: uid()
    };
  });
  return rows;
}

/* ---------- 排序 ---------- */
function sortList(list) {
  if (!sortKey) {
    list.sort((a, b) => (b.pinned || 0) - (a.pinned || 0));
    return;
  }
  const asc = sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (['current', 'dayRate', 'quantity', 'profit', 'profitPct', 'marketValue', 'cost'].includes(sortKey)) {
      va = parseFloat(va) || 0; vb = parseFloat(vb) || 0;
    }
    if (va > vb) return asc;
    if (va < vb) return -asc;
    return 0;
  });
}

function bindSortEvent() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey !== key) { sortKey = key; sortDir = 'asc'; }
      else { sortDir = sortDir === 'asc' ? 'desc' : (sortDir === 'desc' ? '' : 'asc'); if (!sortDir) sortKey = ''; }
      document.querySelectorAll('th.sortable').forEach(el => el.classList.remove('asc', 'desc'));
      if (sortDir) th.classList.add(sortDir);
      render();
    });
  });
}

/* ---------- 行情 ---------- */
async function refreshPrice() {
  if (!data.positions.length) return;
  for (const it of data.positions) {
    const tcode = (it.code.startsWith('6') ? 'sh' : 'sz') + it.code;
    try {
      const buf = await (await fetch(`https://qt.gtimg.cn/q=${tcode}`, { referrer: 'https://stock.gtimg.cn/' })).arrayBuffer();
      const txt = new TextDecoder('gbk').decode(buf);
      const arr = txt.split('~');
      it.current = parseFloat(arr[3]) || it.current || it.cost || 0;
      it.dayRate = ((parseFloat(arr[3]) - parseFloat(arr[4])) / parseFloat(arr[4]) * 100) || 0;
    } catch (e) { console.error(e); }
    it.marketValue = it.current * it.quantity;
    it.profit = (it.current - it.cost) * it.quantity;
    it.profitPct = it.cost ? ((it.current - it.cost) / it.cost * 100) : 0;
  }
  save(); render();
}

function startAutoRefresh() {
  if (timer) clearInterval(timer);
  refreshPrice();
  timer = setInterval(refreshPrice, 1000);
}

/* ---------- 渲染 ---------- */
function getCurrentPositions() {
  return data.positions.filter(p => {
    if (p.categoryId !== currentCategoryId) return false;
    if (!dateStart && !dateEnd) return true;
    const d = new Date(p.joinDate); d.setHours(0, 0, 0, 0);
    const start = dateStart ? new Date(dateStart) : null;
    const end = dateEnd ? new Date(dateEnd) : null;
    if (start) start.setHours(0, 0, 0, 0);
    if (end) end.setHours(23, 59, 59, 999);
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });
}

/* ========== 迷你日历 ========== */
const MONTHS = ['01','02','03','04','05','06','07','08','09','10','11','12'];
function buildMiniCal(y, m) {
  const wrap = document.getElementById('miniCal');
  if (!wrap) return;
  wrap.innerHTML = '';
  const nav = document.createElement('div');
  nav.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:4px;grid-column:1/-1';
  const prev = document.createElement('button'); prev.textContent = '‹';
  prev.onclick = () => { if (m === 1) { calYear = y - 1; calMonth = 12; } else { calYear = y; calMonth = m - 1; } buildMiniCal(calYear, calMonth); };
  const title = document.createElement('div'); title.className = 'cal-title'; title.style.textAlign = 'center'; title.style.flex = '1'; title.textContent = `${y}年${m.toString().padStart(2,'0')}月`;
  const next = document.createElement('button'); next.textContent = '›';
  next.onclick = () => { if (m === 12) { calYear = y + 1; calMonth = 1; } else { calYear = y; calMonth = m + 1; } buildMiniCal(calYear, calMonth); };
  nav.appendChild(prev); nav.appendChild(title); nav.appendChild(next); wrap.appendChild(nav);
  WEEK_HEAD.forEach(w => { const span = document.createElement('div'); span.className = 'cal-weekday'; span.textContent = w; wrap.appendChild(span); });
  const firstDay = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  for (let i = 0; i < firstDay; i++) wrap.appendChild(document.createElement('div'));
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = `${y}-${MONTHS[m-1]}-${String(d).padStart(2,'0')}`;
    const has = data.positions.some(p => p.joinDate === dt && p.categoryId === currentCategoryId);
    const btn = document.createElement('button'); btn.textContent = d; btn.className = has ? 'has' : 'none';
    btn.onclick = () => {
      const input = document.getElementById('startDate');
      if (input) { input.value = dt; dateStart = dt; dateEnd = dt; input.dispatchEvent(new Event('change')); }
    };
    wrap.appendChild(btn);
  }
}

function render() {
  const list = getCurrentPositions();
  sortList(list);
  const tb = document.querySelector('#stockTable tbody');
  const empty = document.getElementById('emptyTip');
  if (!tb) return;
  tb.innerHTML = '';
  if (!list.length) {
    if (empty) empty.style.display = 'block';
    document.getElementById('stockTable').style.display = 'table';
    return;
  }
  if (empty) empty.style.display = 'none';
  document.getElementById('stockTable').style.display = 'table';
  list.forEach((it, idx) => {
    const globalIdx = data.positions.findIndex(p => p.id === it.id);
    const hay = `${it.clientName}|${it.code}|${it.name}`.toLowerCase();
    if (searchKey && !hay.includes(searchKey)) return;
    const current = it.current ?? it.cost ?? 0;
    const dayRate = (it.dayRate ?? 0).toFixed(2);
    const profit = it.profit ?? 0;
    const profitPct = it.profitPct ?? 0;
    const marketValue = it.marketValue ?? 0;
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    if (selectedSet.has(it.id)) tr.classList.add('selected');
    const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    tr.innerHTML = `
      <td><input type="checkbox" class="row-check" data-id="${escape(it.id)}" ${selectedSet.has(it.id)?'checked':''}></td>
      <td data-label="客户姓名">${escape(it.clientName)}<br><small style="color:#999;">${escape(it.code)}</small></td>
      <td data-label="加入时间">${escape(it.joinDate)}</td>
      <td data-label="股票名称/市值"><b>${escape(it.name)}</b><br>${marketValue.toFixed(2)}</td>
      <td data-label="现价/成本">${current.toFixed(3)}<br>${it.cost.toFixed(3)}</td>
      <td data-label="当日涨幅" class="${dayRate >= 0 ? 'profit-positive' : 'profit-negative'}">${dayRate >= 0 ? '+' : ''}${dayRate}%</td>
      <td data-label="持股数">${it.quantity}</td>
      <td data-label="盈亏" class="${profit >= 0 ? 'profit-positive' : 'profit-negative'}">${profit >= 0 ? '+' : ''}${profit.toFixed(2)}<br>${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(2)}%</td>
      <td>
        <button class="op-btn" onclick="handleEdit(${globalIdx})">编辑</button>
        <button class="op-btn" onclick="handlePin(${globalIdx})">${it.pinned ? '取消置顶' : '置顶'}</button>
        <button class="op-btn del" onclick="handleDelete(${globalIdx})">删除</button>
      </td>
    `;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', (e) => {
      if (e.target.classList.contains('op-btn')||e.target.classList.contains('row-check')) return;
      window.open(`https://www.iwencai.com/unifiedwap/result?w=${encodeURIComponent(it.code)}&querytype=stock`, '_blank');
    });
    tb.appendChild(tr);
  });
  bindBatchSelect();
  syncSelectAllState();
  renderCategoryTabs();
  buildMiniCal(calYear, calMonth);
}

/* ---------- 批量选中 ---------- */
function bindBatchSelect() {
  const allCheck = document.getElementById('selectAll');
  if (allCheck) {
    allCheck.onchange = () => {
      const rowChecks = document.querySelectorAll('.row-check');
      rowChecks.forEach(ch => { ch.checked = allCheck.checked; toggleSelectRow(ch.dataset.id, allCheck.checked); });
      render();
    };
  }
  const rowChecks = document.querySelectorAll('.row-check');
  rowChecks.forEach(ch => {
    ch.onchange = (e) => { e.stopPropagation(); toggleSelectRow(ch.dataset.id, ch.checked); render(); };
  });
}
function syncSelectAllState(){
  const allBox=document.getElementById('selectAll');
  if(!allBox)return;
  const rc=[...document.querySelectorAll('.row-check')];
  allBox.checked=rc.length&&rc.every(c=>c.checked);
}
function toggleSelectRow(id, checked) { if (checked) selectedSet.add(id); else selectedSet.delete(id); }
function invertSelection() {
  const list = getCurrentPositions();
  list.forEach(p => {
    if (selectedSet.has(p.id)) selectedSet.delete(p.id); else selectedSet.add(p.id);
  });
  render();
}

/* ---------- 置顶 ---------- */
function togglePin(globalIdx) {
  const item = data.positions[globalIdx];
  if (item.pinned) {
    item.pinned = false;
    const idx = data.positions.indexOf(item);
    data.positions.push(...data.positions.splice(idx, 1));
  } else {
    item.pinned = true;
    const idx = data.positions.indexOf(item);
    data.positions.unshift(...data.positions.splice(idx, 1));
  }
  save(); render();
}

/* ---------- 统一入口：有勾行就批量，没勾行就单行 ---------- */
function handleDelete(globalIdx) { if (selectedSet.size) { batchDelete(); } else { delItem(globalIdx); } }
function handlePin(globalIdx) { if (selectedSet.size) { batchPin(); } else { togglePin(globalIdx); } }
function handleEdit(globalIdx) { if (selectedSet.size) { batchEdit(); } else { editItem(globalIdx); } }

/* ---------- 批量实现 ---------- */
function selectedIdxArr() { return [...selectedSet].map(id => data.positions.findIndex(p => p.id === id)).filter(i => i !== -1); }
function batchDelete() {
  const arr = selectedIdxArr();
  if (!arr.length) return;
  if (!confirm(`确定删除选中的 ${arr.length} 条？`)) return;
  arr.sort((a, b) => b - a).forEach(i => data.positions.splice(i, 1));
  selectedSet.clear(); save(); render();
}
function batchPin() {
  const arr = selectedIdxArr();
  if (!arr.length) return;
  const toPin = [];
  arr.sort((a, b) => b - a).forEach(i => toPin.unshift(...data.positions.splice(i, 1)));
  toPin.forEach(p => p.pinned = true);
  data.positions.unshift(...toPin);
  selectedSet.clear(); save(); render();
}
function batchEdit() {
  const arr = selectedIdxArr();
  if (!arr.length) return;
  const newCatId = prompt('请输入新栏目 ID（可先在外部栏目管理里复制）', currentCategoryId);
  if (!newCatId || !data.categories.find(c => c.id === newCatId)) return;
  arr.forEach(i => data.positions[i].categoryId = newCatId);
  selectedSet.clear(); save(); render();
}

/* ---------- 弹层 ---------- */
function fillCategorySelect(selectedId = currentCategoryId) {
  const sel = document.getElementById('categorySelect');
  if (!sel) return;
  sel.innerHTML = '';
  data.categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.name;
    if (cat.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  });
}
function showAddModal() {
  editingIdx = -1;
  closeModal();
  resetModal();
  document.getElementById('qty').value = '100';
  fillCategorySelect();
  document.getElementById('editModal').style.display = 'block';
}
function closeModal() { document.getElementById('editModal').style.display = 'none'; }
function resetModal() {
  ['code', 'name', 'cost', 'clientName'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('joinDate').value = fmtDate();
  delete document.getElementById('editModal').dataset.current;
  delete document.getElementById('editModal').dataset.dayRate;
  fillCategorySelect(currentCategoryId);
}
async function autoName() {
  const code = document.getElementById('code').value.trim();
  if (!code) return;
  const tcode = (code.startsWith('6') ? 'sh' : 'sz') + code;
  try {
    const buf = await (await fetch(`https://qt.gtimg.cn/q=${tcode}`, { referrer: 'https://stock.gtimg.cn/' })).arrayBuffer();
    const txt = new TextDecoder('gbk').decode(buf);
    const arr = txt.split('~');
    const name = arr[1] || '';
    if (!name || name === '-') { alert('股票代码有误，请检查！'); document.getElementById('name').value = ''; return; }
    document.getElementById('name').value = name;
    document.getElementById('editModal').dataset.current = parseFloat(arr[3]) || 0;
    document.getElementById('editModal').dataset.dayRate = ((parseFloat(arr[3]) - parseFloat(arr[4])) / parseFloat(arr[4]) * 100) || 0;
  } catch (e) { console.error(e); alert('网络异常，未能识别股票代码！'); }
}
function editItem(globalIdx) {
  editingIdx = globalIdx;
  const it = data.positions[globalIdx];
  ['code','name','cost','quantity','joinDate'].forEach(k=>{
    const el=document.getElementById(k==='quantity'?'qty':k);
    if(el) el.value=it[k];
  });
  let clientInput = document.getElementById('clientName');
  if (!clientInput) {
    const group = document.createElement('div');
    group.className = 'form-group';
    group.innerHTML = '<label>客户姓名</label><input id="clientName" type="text">';
    document.querySelector('.form-grid').prepend(group);
    clientInput = document.getElementById('clientName');
  }
  clientInput.value = it.clientName;
  fillCategorySelect(it.categoryId);
  document.getElementById('editModal').style.display = 'block';
}
function delItem(globalIdx) { if (confirm('确定删除？')) { data.positions.splice(globalIdx, 1); save(); render(); } }
function savePosition() {
  const clientName = document.getElementById('clientName')?.value.trim() || '';
  const code = document.getElementById('code').value.trim();
  const name = document.getElementById('name').value.trim();
  const qty = Number(document.getElementById('qty').value);
  const cost = Number(document.getElementById('cost').value);
  const joinDate = document.getElementById('joinDate').value;
  const categoryId = document.getElementById('categorySelect')?.value || currentCategoryId;
  if (!clientName) { alert('客户姓名不能为空'); return; }
  if (!code) { alert('股票代码不能为空'); return; }
  if (!name) { alert('股票名称未识别，请检查代码'); return; }
  if (!qty || qty <= 0) { alert('仓位必须大于0'); return; }
  if (qty % 100 !== 0) { alert('仓位须为100的倍数'); return; }
  if (cost < 0 || !cost) { alert('成本价必须大于0'); return; }
  if (!joinDate) { alert('请选择加入时间'); return; }
  const current = Number(document.getElementById('editModal').dataset.current) || cost;
  const dayRate = Number(document.getElementById('editModal').dataset.dayRate) || 0;
  const item = {
    id: editingIdx >= 0 ? data.positions[editingIdx].id : uid(),
    clientName, code, name, quantity: qty, cost, current, dayRate,
    marketValue: current * qty,
    profit: (current - cost) * qty,
    profitPct: cost ? ((current - cost) / cost * 100) : 0,
    pinned: false, joinDate, categoryId
  };
  if (editingIdx >= 0) data.positions[editingIdx] = item;
  else data.positions.push(item);
  save(); closeModal(); render();
}

/* ---------- 栏目 ---------- */
function renderCategoryTabs() {
  const container = document.querySelector('.category-tabs');
  if (!container) return;
  container.innerHTML = '';
  if (data.categories.length === 0) { data.categories.push({ id: 'default', name: '投顾' }); currentCategoryId = 'default'; save(); }
  if (!data.categories.some(cat => cat.id === currentCategoryId)) currentCategoryId = data.categories[0].id;
  data.categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'btn category-tab';
    btn.draggable = true;
    btn.dataset.catId = cat.id;
    if (cat.id === currentCategoryId) { btn.style.cssText = 'background:#667eea;color:#fff;border-color:#667eea'; }
    else { btn.style.cssText = 'background:#fff;color:#333;border-color:#ddd'; }
    btn.textContent = cat.name;
    btn.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', cat.id); btn.style.opacity = '0.5'; });
    btn.addEventListener('dragend', () => btn.style.opacity = '1');
    btn.addEventListener('dragover', e => e.preventDefault());
    btn.addEventListener('drop', e => {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData('text/plain');
      const targetId = cat.id;
      if (draggedId === targetId) return;
      const fromIndex = data.categories.findIndex(c => c.id === draggedId);
      const toIndex = data.categories.findIndex(c => c.id === targetId);
      if (fromIndex === -1 || toIndex === -1) return;
      [data.categories[fromIndex], data.categories[toIndex]] = [data.categories[toIndex], data.categories[fromIndex]];
      save(); renderCategoryTabs();
    });
    btn.onclick = () => { currentCategoryId = cat.id; render(); };
    container.appendChild(btn);
  });
}
function renderCategoryModal() {
  const container = document.getElementById('categoryList');
  if (!container) return;
  container.innerHTML = '';
  data.categories.forEach(cat => {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;align-items:center;margin:8px 0';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = cat.name;
    input.style.cssText = 'width:140px;padding:4px;margin-right:8px;border:1px solid #ccc;border-radius:4px';
    input.onchange = () => {
      const newName = input.value.trim();
      if (newName) { cat.name = newName; save(); renderCategoryTabs(); } else input.value = cat.name;
    };
    const delBtn = document.createElement('button');
    delBtn.className = 'op-btn del';
    delBtn.textContent = '删除';
    delBtn.onclick = () => deleteCategory(cat.id);
    div.appendChild(input); div.appendChild(delBtn);
    container.appendChild(div);
  });
}
function addCategory() {
  const name = document.getElementById('newCatName')?.value.trim();
  if (!name) return alert('请输入栏目名称');
  data.categories.push({ id: uid(), name });
  save(); renderCategoryModal();
  document.getElementById('newCatName').value = '';
}
function deleteCategory(id) {
  if (id === 'default' && data.categories.length === 1) return alert('至少保留一个栏目！');
  if (data.positions.some(p => p.categoryId === id))
    if (!confirm('该栏目下有持仓，删除会同时清除所有持仓！确定吗？')) return;
  data.categories = data.categories.filter(c => c.id !== id);
  data.positions = data.positions.filter(p => p.categoryId !== id);
  if (currentCategoryId === id) currentCategoryId = data.categories[0]?.id || 'default';
  save(); renderCategoryModal(); render();
}

/* ---------- 通用导出弹窗 ---------- */
function closeExportChoiceModal() { document.getElementById('exportChoiceModal').style.display = 'none'; }
function doExportAll() {
  const start = document.getElementById('exportStart')?.value;
  const end = document.getElementById('exportEnd')?.value;
  const catId = document.getElementById('exportCategory')?.value;
  let list = data.positions;
  if (catId) list = list.filter(p => p.categoryId === catId);
  if (start || end) list = list.filter(p => {
    const d = new Date(p.joinDate); d.setHours(0,0,0,0);
    const s = start ? new Date(start) : null; if (s) s.setHours(0,0,0,0);
    const e = end ? new Date(end) : null; if (e) e.setHours(23,59,59,999);
    if (s && d < s) return false;
    if (e && d > e) return false;
    return true;
  });
  const csv = objToCSV(list);
  downloadCSV(csv, `positions_${fmtDate()}.csv`);
  closeExportChoiceModal();
}
function downloadCSV(csv, filename) {
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

/* ---------- 初始化 ---------- */
window.onload = () => {
  data = load();
  currentCategoryId = data.categories[0]?.id || 'default';

  const startInp = document.getElementById('startDate');
  const endInp = document.getElementById('endDate');
  if (startInp) startInp.onchange = e => { dateStart = e.target.value; render(); };
  if (endInp) endInp.onchange = e => { dateEnd = e.target.value; render(); };

  document.getElementById('addBtn').onclick = showAddModal;
  document.getElementById('searchInput').oninput = e => { searchKey = e.target.value.trim().toLowerCase(); render(); };
  document.getElementById('manageCatBtn').onclick = () => {
    renderCategoryModal();
    document.getElementById('categoryModal').style.display = 'block';
  };

  bindSortEvent();
  render();
  startAutoRefresh();

  /* 导入/导出合并按钮 */
  const oldImport = document.getElementById('importBtn');
  if (oldImport) oldImport.remove();
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.textContent = '导入/导出';
  exportBtn.onclick = () => {
    document.getElementById('exportStart').value = dateStart;
    document.getElementById('exportEnd').value = dateEnd;
    const catSel = document.getElementById('exportCategory');
    catSel.innerHTML = '<option value="">全部栏目</option>';
    data.categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (c.id === currentCategoryId) opt.selected = true;
      catSel.appendChild(opt);
    });
    document.getElementById('exportChoiceModal').style.display = 'block';
  };

  const exportModal = document.querySelector('#exportChoiceModal .modal-content');
  const importArea = document.createElement('div');
  importArea.style.marginBottom = '15px';
  importArea.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <input type="file" id="importInModal" accept=".csv" style="flex:1;font-size:13px;">
      <button class="btn btn-primary" onclick="handleImportInModal()">开始导入</button>
    </div>
    <div style="font-size:12px;color:#666;margin-top:4px;">提示：导入时会按上方选择的“日期区间”+“栏目”做过滤，无筛选则全部导入。</div>`;
  exportModal.insertBefore(importArea, exportModal.querySelector('.modal-buttons'));

  window.handleImportInModal = function () {
  const file = document.getElementById('importInModal').files[0];
  if (!file) return alert('请先选择 CSV 文件');
  const reader = new FileReader();
  reader.onload = evt => {
    try {
      /* ----------  解析  ---------- */
      const rawList = csvToObj(evt.target.result);
      if (!rawList.length) return alert('未解析到任何记录');

      /* ----------  过滤条件  ---------- */
      const startStr = document.getElementById('exportStart').value;
      const endStr   = document.getElementById('exportEnd').value;
      const catSel   = document.getElementById('exportCategory');
      const filterId = catSel.value;
      const filterName = filterId
            ? (data.categories.find(c => c.id === filterId)?.name ?? '')
            : '';

      const startDate = startStr ? new Date(startStr) : null;
      const endDate   = endStr   ? new Date(endStr)   : null;
      if (startDate) startDate.setHours(0,0,0,0);
      if (endDate)   endDate.setHours(23,59,59,999);

      /* ----------  补栏目  ---------- */
      if (filterId && !data.categories.some(c => c.id === filterId)) {
        data.categories.push({ id: filterId, name: filterName });
      }
      const csvCatNames = [...new Set(rawList.map(r => (r.categoryName || '投顾').trim()))];
      csvCatNames.forEach(name => {
        if (!data.categories.some(c => c.name === name)) {
          data.categories.push({ id: uid(), name });
        }
      });
      const name2id = Object.fromEntries(data.categories.map(c => [c.name, c.id]));

      /* ----------  去重键：代码+客户（忽略大小写/空格） ---------- */
      const exists = new Set(data.positions.map(p =>
        `${String(p.code).trim().toLowerCase()}-${String(p.clientName).trim().toLowerCase()}`
      ));

      let added = 0;
      rawList.forEach(r => {
        const rowCatName = (r.categoryName || '投顾').trim();
        const rowCatId   = name2id[rowCatName];

        /* 栏目过滤 */
        if (filterId && rowCatId !== filterId) return;

        /* 日期过滤 */
        const rowDate = new Date(r.joinDate);
        if (startDate && rowDate < startDate) return;
        if (endDate   && rowDate > endDate)   return;

        /* 去重 */
        const key = `${String(r.code).trim().toLowerCase()}-${String(r.clientName).trim().toLowerCase()}`;
        if (exists.has(key)) return;

        exists.add(key);          // 防止本次导入内重复
        r.categoryId = rowCatId;
        delete r.categoryName;
        data.positions.push(r);
        added++;
      });

      save(); render();
      alert(`导入完成！新增 ${added} 条，跳过 ${rawList.length - added} 条重复记录。`);
      closeExportChoiceModal();
    } catch (err) {
      alert('解析失败，请检查 CSV 格式！\n' + err);
    }
  };
  reader.readAsText(file, 'UTF-8');
};
  const invertBtn = document.createElement('button');
  invertBtn.textContent = '反选';
  invertBtn.className = 'btn';
  invertBtn.style.marginLeft = '8px';
  invertBtn.onclick = invertSelection;
  document.querySelector('.toolbar').appendChild(invertBtn);

  const codeInput = document.getElementById('code');
  if (codeInput) codeInput.addEventListener('blur', autoName);
};
