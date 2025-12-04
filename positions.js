/* ========== 纯前端实时版（居中+排序+导入导出+整行看盘 + 栏目管理 + 拖拽排序 + 日期筛选 + 迷你热图） ========== */
const STORAGE_KEY = 'stockPosReal_v2';
let data = { categories: [{ id: 'default', name: '投顾' }], positions: [] };
let currentCategoryId = 'default';
let editingIdx = -1;
let timer = null;
let searchKey = '';
let sortKey = '', sortDir = '';

/* ★★★ 日期筛选边界 ★★★ */
let dateStart = '', dateEnd = '';

/* ✅ 记录日历当前年月，防止翻月后被 render() 重置 */
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth() + 1;

/* 星期表头 */
const WEEK_HEAD = ['日','一','二','三','四','五','六'];

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function fmtDate() { return new Date().toISOString().split('T')[0]; }

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { console.warn('新版数据解析失败'); }
  }

  /* ===== 处理旧版数据 ===== */
  const oldList = JSON.parse(localStorage.getItem('stockPosReal') || '[]');
  if (oldList.length > 0) {
    /* 1. 收集旧数据中出现的所有栏目名 */
    const catNameSet = new Set(oldList.map(i => i.category || '投顾').filter(Boolean));
    /* 2. 生成新栏目表 */
    const newCats = Array.from(catNameSet).map(name => ({ id: uid(), name }));
    /* 3. 建立 名称->id 映射 */
    const name2id = Object.fromEntries(newCats.map(c => [c.name, c.id]));
    /* 4. 给旧记录补 categoryId */
    const newPos = oldList.map(pos => ({
      ...pos,
      id: uid(),
      categoryId: name2id[pos.category || '投顾'] || name2id['投顾']
    }));
    const migrated = { categories: newCats, positions: newPos };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  }

  return { categories: [{ id: 'default', name: '投顾' }], positions: [] };
}

/* ---------- CSV ---------- */
function objToCSV(list) {
  const head = 'clientName,code,name,quantity,cost,current,dayRate,marketValue,profit,profitPct,pinned,joinDate,categoryId';
  const rows = list.map(r => [
    r.clientName, r.code, r.name, r.quantity, r.cost, r.current, r.dayRate,
    r.marketValue, r.profit, r.profitPct, r.pinned ? 1 : 0, r.joinDate, r.categoryId
  ].map(v => (v + '').includes(',') ? `"${v}"` : v).join(','));
  return [head, ...rows].join('\n');
}

function csvToObj(str) {
  const lines = str.trim().split('\n');
  const keys = lines[0].split(',');
  return lines.slice(1).map(l => {
    const val = l.split(',').map((v, i) => v.replace(/^"|"$/g, ''));
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
      categoryId: val[12] || 'default',
      id: uid()
    };
  });
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
      if (sortKey !== key) {
        sortKey = key; sortDir = 'asc';
      } else {
        sortDir = sortDir === 'asc' ? 'desc' : (sortDir === 'desc' ? '' : 'asc');
        if (!sortDir) sortKey = '';
      }
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
    const d = new Date(p.joinDate);
    d.setHours(0, 0, 0, 0);
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
  nav.style.display = 'flex';
  nav.style.justifyContent = 'space-between';
  nav.style.marginBottom = '4px';
  nav.style.gridColumn = '1 / -1';

  const prev = document.createElement('button');
  prev.textContent = '‹';
  prev.onclick = () => {
    if (m === 1) { calYear = y - 1; calMonth = 12; }
    else { calYear = y; calMonth = m - 1; }
    buildMiniCal(calYear, calMonth);
  };

  const title = document.createElement('div');
  title.className = 'cal-title';
  title.textContent = `${y}年${m.toString().padStart(2,'0')}月`;
  title.style.textAlign = 'center';
  title.style.flex = '1';

  const next = document.createElement('button');
  next.textContent = '›';
  next.onclick = () => {
    if (m === 12) { calYear = y + 1; calMonth = 1; }
    else { calYear = y; calMonth = m + 1; }
    buildMiniCal(calYear, calMonth);
  };

  nav.appendChild(prev);
  nav.appendChild(title);
  nav.appendChild(next);
  wrap.appendChild(nav);

  WEEK_HEAD.forEach(w => {
    const span = document.createElement('div');
    span.className = 'cal-weekday';
    span.textContent = w;
    wrap.appendChild(span);
  });

  const firstDay = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();

  for (let i = 0; i < firstDay; i++) wrap.appendChild(document.createElement('div'));

  for (let d = 1; d <= daysInMonth; d++) {
    const dt = `${y}-${MONTHS[m-1]}-${String(d).padStart(2,'0')}`;
    const has = data.positions.some(p => p.joinDate === dt && p.categoryId === currentCategoryId);
    const btn = document.createElement('button');
    btn.textContent = d;
    btn.className = has ? 'has' : 'none';
    btn.onclick = () => {
      const input = document.getElementById('startDate');
      input.value = dt;
      dateStart = dt;
      dateEnd = dt;
      input.dispatchEvent(new Event('change'));
    };
    wrap.appendChild(btn);
  }
}

function render() {
  const list = getCurrentPositions();
  sortList(list);
  const tb = document.querySelector('#stockTable tbody');
  const empty = document.getElementById('emptyTip');
  tb.innerHTML = '';

  if (!list.length) {
    empty.style.display = 'block';
    document.getElementById('stockTable').style.display = 'table';
    document.querySelector('#stockTable tbody').innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  document.getElementById('stockTable').style.display = 'table';

  list.forEach(it => {
    const globalIdx = data.positions.findIndex(p => p.id === it.id);
    const hay = `${it.clientName}|${it.code}|${it.name}`.toLowerCase();
    if (searchKey && !hay.includes(searchKey)) return;

    const current = it.current ?? it.cost ?? 0;
    const dayRate = (it.dayRate ?? 0).toFixed(2);
    const profit = it.profit ?? 0;
    const profitPct = it.profitPct ?? 0;
    const marketValue = it.marketValue ?? 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${it.clientName}<br><small style="color:#999;">${it.code}</small></td>
      <td>${it.joinDate}</td>
      <td><b>${it.name}</b><br>${marketValue.toFixed(2)}</td>
      <td>${current.toFixed(3)}<br>${it.cost.toFixed(3)}</td>
      <td class="${dayRate >= 0 ? 'profit-positive' : 'profit-negative'}">${dayRate >= 0 ? '+' : ''}${dayRate}%</td>
      <td>${it.quantity}</td>
      <td class="${profit >= 0 ? 'profit-positive' : 'profit-negative'}">${profit >= 0 ? '+' : ''}${profit.toFixed(2)}<br>${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(2)}%</td>
      <td>
        <button class="op-btn" onclick="editItem(${globalIdx})">编辑</button>
        <button class="op-btn" onclick="togglePin(${globalIdx})">${it.pinned ? '取消置顶' : '置顶'}</button>
        <button class="op-btn del" onclick="delItem(${globalIdx})">删除</button>
      </td>
    `;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', (e) => {
      if (e.target.classList.contains('op-btn')) return;
      window.open(`https://www.iwencai.com/unifiedwap/result?w=${it.code}&querytype=stock`, '_blank');
    });
    tb.appendChild(tr);
  });

  renderCategoryTabs();
  buildMiniCal(calYear, calMonth);
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
  fillCategorySelect();
  document.getElementById('editModal').style.display = 'block';
}

function closeModal() {
  document.getElementById('editModal').style.display = 'none';
}

function resetModal() {
  ['code', 'name', 'cost', 'qty', 'clientName'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = id === 'qty' ? '100' : '';
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
    if (!name || name === '-') {
      alert('股票代码有误，请检查！');
      document.getElementById('name').value = '';
      return;
    }
    document.getElementById('name').value = name;
    document.getElementById('editModal').dataset.current = parseFloat(arr[3]) || 0;
    document.getElementById('editModal').dataset.dayRate = ((parseFloat(arr[3]) - parseFloat(arr[4])) / parseFloat(arr[4]) * 100) || 0;
  } catch (e) {
    console.error(e);
    alert('网络异常，未能识别股票代码！');
  }
}

function editItem(globalIdx) {
  editingIdx = globalIdx;
  const it = data.positions[globalIdx];
  document.getElementById('code').value = it.code;
  document.getElementById('name').value = it.name;
  document.getElementById('cost').value = it.cost;
  document.getElementById('qty').value = it.quantity;
  document.getElementById('joinDate').value = it.joinDate;

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

function delItem(globalIdx) {
  if (confirm('确定删除？')) {
    data.positions.splice(globalIdx, 1);
    save(); render();
  }
}

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
    clientName, code, name, quantity: qty, cost,
    current, dayRate,
    marketValue: current * qty,
    profit: (current - cost) * qty,
    profitPct: cost ? ((current - cost) / cost * 100) : 0,
    pinned: false,
    joinDate,
    categoryId
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

  if (data.categories.length === 0) {
    data.categories.push({ id: 'default', name: '投顾' });
    currentCategoryId = 'default';
    save();
  }

  if (!data.categories.some(cat => cat.id === currentCategoryId))
    currentCategoryId = data.categories[0].id;

  data.categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'btn category-tab';
    btn.draggable = true;
    btn.dataset.catId = cat.id;

    if (cat.id === currentCategoryId) {
      btn.style.backgroundColor = '#667eea';
      btn.style.color = '#fff';
      btn.style.borderColor = '#667eea';
    } else {
      btn.style.backgroundColor = '#ffffff';
      btn.style.color = '#333';
      btn.style.borderColor = '#ddd';
    }

    btn.textContent = cat.name;
    btn.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', cat.id);
      btn.style.opacity = '0.5';
    });
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
      const temp = data.categories[fromIndex];
      data.categories[fromIndex] = data.categories[toIndex];
      data.categories[toIndex] = temp;
      save(); renderCategoryTabs();
    });
    btn.onclick = () => {
      currentCategoryId = cat.id;
      render();
    };
    container.appendChild(btn);
  });
}

function renderCategoryModal() {
  const container = document.getElementById('categoryList');
  container.innerHTML = '';
  data.categories.forEach(cat => {
    const div = document.createElement('div');
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.margin = '8px 0';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = cat.name;
    input.style.cssText = 'width:140px;padding:4px;margin-right:8px;border:1px solid #ccc;border-radius:4px;';
    input.onchange = () => {
      const newName = input.value.trim();
      if (newName) {
        cat.name = newName;
        save(); renderCategoryTabs();
      } else input.value = cat.name;
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'op-btn del';
    delBtn.textContent = '删除';
    delBtn.onclick = () => deleteCategory(cat.id);

    div.appendChild(input);
    div.appendChild(delBtn);
    container.appendChild(div);
  });
}

function addCategory() {
  const name = document.getElementById('newCatName').value.trim();
  if (!name) return alert('请输入栏目名称');
  data.categories.push({ id: uid(), name });
  save(); renderCategoryModal();
  document.getElementById('newCatName').value = '';
}

function deleteCategory(id) {
  if (id === 'default' && data.categories.length === 1)
    return alert('至少保留一个栏目！');
  if (data.positions.some(p => p.categoryId === id))
    if (!confirm('该栏目下有持仓，删除会同时清除所有持仓！确定吗？')) return;
  data.categories = data.categories.filter(c => c.id !== id);
  data.positions = data.positions.filter(p => p.categoryId !== id);
  if (currentCategoryId === id) currentCategoryId = data.categories[0]?.id || 'default';
  save(); renderCategoryModal(); render();
}

/* ---------- 通用导出弹窗 ---------- */
function closeExportChoiceModal() {
  document.getElementById('exportChoiceModal').style.display = 'none';
}

function doExportAll() {
  const start = document.getElementById('exportStart').value;
  const end   = document.getElementById('exportEnd').value;
  const catId = document.getElementById('exportCategory').value;

  let list = data.positions;

  // 栏目筛选
  if (catId) list = list.filter(p => p.categoryId === catId);

  // 日期筛选
  if (start || end) {
    list = list.filter(p => {
      const d = new Date(p.joinDate);
      d.setHours(0,0,0,0);
      const s = start ? new Date(start) : null;
      if(s) s.setHours(0,0,0,0);
      const e = end ? new Date(end) : null;
      if(e) e.setHours(23,59,59,999);
      if (s && d < s) return false;
      if (e && d > e) return false;
      return true;
    });
  }

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
  if(startInp) startInp.onchange = e => { dateStart = e.target.value; render(); };
  if(endInp) endInp.onchange = e => { dateEnd = e.target.value; render(); };

  document.getElementById('addBtn').onclick = showAddModal;
  document.getElementById('searchInput').oninput = e => { searchKey = e.target.value.trim().toLowerCase(); render(); };
  document.getElementById('manageCatBtn').onclick = () => {
    renderCategoryModal();
    document.getElementById('categoryModal').style.display = 'block';
  };

  bindSortEvent();
  render();
  startAutoRefresh();

  /* 导出：一个按钮弹窗 */
  document.getElementById('exportBtn').onclick = () => {
    document.getElementById('exportStart').value = '';
    document.getElementById('exportEnd').value = '';

    // 填充栏目下拉
    const catSel = document.getElementById('exportCategory');
    catSel.innerHTML = '<option value="">全部栏目</option>';
    data.categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      catSel.appendChild(opt);
    });

    document.getElementById('exportChoiceModal').style.display = 'block';
  };

  document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
  document.getElementById('importFile').onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        const imported = csvToObj(evt.target.result);
        const exists = new Set(data.positions.map(i => `${i.code}-${i.clientName}`));
        let added = 0;
        imported.forEach(r => {
          if (!exists.has(`${r.code}-${r.clientName}`)) {
            data.positions.push(r);
            added++;
          }
        });
        save(); render();
        alert(`导入完成！新增 ${added} 条，跳过 ${imported.length - added} 条重复记录。`);
      } catch (err) {
        alert('解析失败，请检查 CSV 格式！\n' + err);
      }
      e.target.value = '';
    };
    reader.readAsText(file, 'UTF-8');
  };
};
