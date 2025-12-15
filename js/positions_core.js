/* ========== 纯前端 + LeanCloud 用户系统 + 用户数据隔离
│ 注册/登录/会话保持 │ 本地+云端双存储 │ 实时行情(5s) │ CSV导入/导出 │ 批量删/置顶/改栏目
│ 栏目拖拽排序 │ 反选+全选 │ 置顶永远最前 │ 9字段排序 │ 关键词+日期区间筛选
│ 小眼睛密码可见 │ 错误中文映射 │ 二次确认 │ 移动端适配 │ 零依赖纯原生
========== */
const STORAGE_KEY = 'stockPosReal_v2';
const BACKUP_KEY  = 'stockBackup_lastTime';
const BACKUP_INTERVAL = 60 * 60 * 1000;

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

/* ---------- LeanCloud 配置 ---------- */
const LC_APP_ID = 'ymXJMQuwOQZ5A8ouAD9cO6Vc-gzGzoHsz';
const LC_APP_KEY = '5mV06bEtrGtkN8PVaf0i4kDK';
const LC_HOST   = 'https://ymxjmquw.lc-cn-n1-shared.com';
const USER_CLASS = 'UserData';
const BACKUP_CLASS = 'StockBackup';

/* ---------- 用户系统 ---------- */
function currentUser() {
  return { id: localStorage.getItem('lc_userid'), session: localStorage.getItem('lc_session') };
}

async function signUp(username, password) {
  const res = await fetch(`${LC_HOST}/1.1/users`, {
    method: 'POST',
    headers: { 'X-LC-Id': LC_APP_ID, 'X-LC-Key': LC_APP_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw new Error(await res.text());
  const u = await res.json();
  localStorage.setItem('lc_session', u.sessionToken);
  localStorage.setItem('lc_userid', u.objectId);
  await backgroundSyncCloud();   // ✅ 注册完同步
  return u;
}

async function logIn(username, password) {
  const res = await fetch(`${LC_HOST}/1.1/login`, {
    method: 'POST',
    headers: { 'X-LC-Id': LC_APP_ID, 'X-LC-Key': LC_APP_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw new Error(await res.text());
  const u = await res.json();
  localStorage.setItem('lc_session', u.sessionToken);
  localStorage.setItem('lc_userid', u.objectId);
  await backgroundSyncCloud();   // ✅ 登录完同步
  return u;
}

async function logOut() {
  const user = currentUser();
  if (user.id) await saveUserData(data); // 退出时强制上传
  localStorage.removeItem('lc_session');
  localStorage.removeItem('lc_userid');
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(BACKUP_KEY);
  location.reload();
}

/* ---------- 数据读写 ---------- */
async function loadUserData() {
  const user = currentUser();
  if (!user.id) return null;
  const url = `${LC_HOST}/1.1/classes/${USER_CLASS}?where={"owner":"${user.id}"}&limit=1`;
  const res = await fetch(url, { headers: { 'X-LC-Id': LC_APP_ID, 'X-LC-Key': LC_APP_KEY } });
  const json = await res.json();
  if (json.results && json.results.length) return JSON.parse(json.results[0].data);
  return null;
}

async function saveUserData(payload) {
  const user = currentUser();
  if (!user.id) return;
  const row = await loadUserRaw();
  const method = row ? 'PUT' : 'POST';
  const url = row ? `${LC_HOST}/1.1/classes/${USER_CLASS}/${row.objectId}` : `${LC_HOST}/1.1/classes/${USER_CLASS}`;
  await fetch(url, {
    method,
    headers: { 'X-LC-Id': LC_APP_ID, 'X-LC-Key': LC_APP_KEY, 'Content-Type': 'application/json', 'X-LC-Session': user.session },
    body: JSON.stringify({ data: JSON.stringify(payload), owner: user.id })
  });
}

async function loadUserRaw() {
  const user = currentUser();
  const url = `${LC_HOST}/1.1/classes/${USER_CLASS}?where={"owner":"${user.id}"}&limit=1`;
  const res = await fetch(url, { headers: { 'X-LC-Id': LC_APP_ID, 'X-LC-Key': LC_APP_KEY } });
  const json = await res.json();
  return json.results && json.results.length ? json.results[0] : null;
}

async function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) try { return JSON.parse(raw); } catch {}
  return { categories: [{ id: 'default', name: '投顾' }], positions: [] };
}

/* ✅ 关键修复：云端有数据就强制覆盖本地 */
async function backgroundSyncCloud() {
  const user = currentUser();
  if (!user.id) return;
  const cloud = await loadUserData();
  if (cloud) {                                    // 云端有 → 覆盖
    data = cloud;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    render();
  } else {                                        // 云端无 → 看本地要不要上传
    if (data.positions.length) saveUserData(data).catch(console.warn);
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  checkBackup();
}

function checkBackup() {
  const now = Date.now();
  const last = parseInt(localStorage.getItem(BACKUP_KEY) || '0', 10);
  if (now - last >= BACKUP_INTERVAL) {
    hourlyCloudSave();
    localStorage.setItem(BACKUP_KEY, String(now));
  }
}

async function hourlyCloudSave() {
  const user = currentUser();
  if (!user.id) return;
  try { await saveUserData(data); } catch (e) { console.warn(e); }
}

async function backupToCloud() {
  try {
    const row = await cloudGetOne(BACKUP_CLASS);
    const method = row ? 'PUT' : 'POST';
    const url = row ? `${LC_HOST}/1.1/classes/${BACKUP_CLASS}/${row.objectId}` : `${LC_HOST}/1.1/classes/${BACKUP_CLASS}`;
    await fetch(url, {
      method,
      headers: { 'X-LC-Id': LC_APP_ID, 'X-LC-Key': LC_APP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: JSON.stringify(data), updatedAt: new Date().toISOString() })
    });
  } catch (e) { console.warn(e); }
}

async function cloudGetOne(className) {
  const url = `${LC_HOST}/1.1/classes/${className}?limit=1`;
  const res = await fetch(url, { headers: { 'X-LC-Id': LC_APP_ID, 'X-LC-Key': LC_APP_KEY } });
  const json = await res.json();
  return json.results && json.results.length ? json.results[0] : null;
}

/* ---------- 工具 ---------- */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function fmtDate() { return new Date().toISOString().split('T')[0]; }
function uploadNow() {
  const user = currentUser();
  if (!user.id) { alert('请先登录'); return; }
  saveUserData(data).then(() => alert('已备份云端')).catch(() => alert('备份失败'));
}

function objToCSV(list) {
  const head = 'clientName,code,name,quantity,cost,current,dayRate,marketValue,profit,profitPct,pinned,joinDate,categoryName';
  const rows = list.map(r => {
    const catName = data.categories.find(c => c.id === r.categoryId)?.name || '投顾';
    return [r.clientName, r.code, r.name, r.quantity, r.cost, r.current, r.dayRate,
            r.marketValue, r.profit, r.profitPct, r.pinned ? 1 : 0, r.joinDate, catName]
           .map(v => (v + '').includes(',') ? `"${v}"` : v).join(',');
  });
  return [head, ...rows].join('\n');
}

function csvToObj(str) {
  return str.trim().split('\n').slice(1).map(l => {
    const val = l.split(',').map(v => v.replace(/^"|"$/g, ''));
    return {
      clientName: val[0], code: val[1], name: val[2], quantity: Number(val[3]) || 0,
      cost: Number(val[4]) || 0, current: Number(val[5]) || 0, dayRate: Number(val[6]) || 0,
      marketValue: Number(val[7]) || 0, profit: Number(val[8]) || 0, profitPct: Number(val[9]) || 0,
      pinned: (val[10] || '0') === '1', joinDate: val[11] || fmtDate(), categoryName: val[12] || '投顾', id: uid()
    };
  });
}

function sortList(list) {
  if (!sortKey) { list.sort((a, b) => (b.pinned || 0) - (a.pinned || 0)); return; }
  const asc = sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (['current','dayRate','quantity','profit','profitPct','marketValue','cost'].includes(sortKey)) {
      va = parseFloat(va) || 0; vb = parseFloat(vb) || 0;
    }
    if (va > vb) return asc; if (va < vb) return -asc; return 0;
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

async function refreshPrice() {
  if (!data.positions.length) return;
  for (const it of data.positions) {
    const tcode = (it.code.startsWith('6') ? 'sh' : 'sz') + it.code;
    try {
      const buf = await (await fetch(`https://qt.gtimg.cn/q=${tcode}`, { referrer: 'https://stock.gtimg.cn/' })).arrayBuffer();
      const arr = new TextDecoder('gbk').decode(buf).split('~');
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
  if (timer) clearInterval(timer); refreshPrice(); timer = setInterval(refreshPrice, 5000);
}
