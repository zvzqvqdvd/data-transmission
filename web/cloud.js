// ===== cloud.js — 纯网页房主（CHANNEL = 'cloud'）=====
// 不依赖本机程序：房间状态在内存，聊天记录与文件在 IndexedDB。
// 与局域网房主共用同一套 P2P 协议与消息结构，访客端拿到的仍是
// TEXT / FILE_CARD / HISTORY 这些老消息——协议一个字节都没改。
//
// 生命周期：刷新不算离线（IndexedDB 恢复）；关页 / 离线 / 60 分钟无通信即销毁。
// 浏览器没有后端进程，销毁只能在本页还活着时立即做，或下次打开时按时间戳清库。

const CLOUD_DB_NAME = 'datatransmission_cloud';
const CLOUD_DB_STORE = 'kv';
const CLOUD_IDLE_MS = 60 * 60 * 1000;          // 与后端 ROOM_IDLE_MAX 对齐
const CLOUD_MAX_GUESTS = 5;                    // 房主 + 5 = 6 人
// 容量不写死：建房时问浏览器「这个站点还能用多少」，取 80% 当房间总量，
// 单文件再取总量的 10%。固定 500 MB 在 Safari（约 1 GB）上浪费一半、
// 在 Chrome（10 GiB）上只用了 5%，两头都不合适。
const CLOUD_QUOTA_RATIO = 0.8;                 // 房间总量 = 可用配额 × 80%
const CLOUD_FILE_RATIO = 0.1;                  // 单文件上限 = 房间总量 × 10%
// 探测不到配额（隐私模式 / 老浏览器 / 存储被禁用）时不猜数字：直接禁用上传。
// 猜一个 500 MB 出去，真存不下时会写到一半才报 QuotaExceededError，
// 文件进不去、消息也是假的，比一开始就说「不能传」糟糕得多。
const CLOUD_MIN_QUOTA = 32 * 1024 * 1024;      // 可用空间低于 32 MB 视为探测失败
const CLOUD_ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let _cloudDB = null;

function cloudOpenDB() {
  if (_cloudDB) return _cloudDB;
  _cloudDB = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(CLOUD_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CLOUD_DB_STORE)) db.createObjectStore(CLOUD_DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexeddb'));
    } catch (e) { reject(e); }
  });
  return _cloudDB;
}

async function cloudGet(key) {
  const db = await cloudOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLOUD_DB_STORE, 'readonly');
    const rq = tx.objectStore(CLOUD_DB_STORE).get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function cloudSet(key, value) {
  const db = await cloudOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLOUD_DB_STORE, 'readwrite');
    tx.objectStore(CLOUD_DB_STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function cloudSetMany(entries) {
  // 多个 key 写进同一个事务：要么全成功，要么全不写。
  // 分开两个事务时，两次写之间刷新页面会读到「新 meta + 旧 msgs」的半截状态。
  const db = await cloudOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLOUD_DB_STORE, 'readwrite');
    const store = tx.objectStore(CLOUD_DB_STORE);
    for (const [k, v] of entries) store.put(v, k);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function cloudDel(key) {
  const db = await cloudOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLOUD_DB_STORE, 'readwrite');
    tx.objectStore(CLOUD_DB_STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function cloudKeys() {
  const db = await cloudOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLOUD_DB_STORE, 'readonly');
    const rq = tx.objectStore(CLOUD_DB_STORE).getAllKeys();
    rq.onsuccess = () => resolve(rq.result || []);
    rq.onerror = () => reject(rq.error);
  });
}

async function cloudClearAll() {
  const db = await cloudOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLOUD_DB_STORE, 'readwrite');
    tx.objectStore(CLOUD_DB_STORE).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// 房间码只记在 sessionStorage：刷新保留、关标签页即清。
// 关闭后 IndexedDB 里的残料由下次打开时按「没有标记 / 已超时」清掉。
function cloudRoomCode() {
  try {
    return String(sessionStorage.getItem('cloud_room') || '')
      .toUpperCase().replace(/[^A-Z2-9]/g, '');
  } catch (e) { return ''; }
}
function cloudRemember(room) {
  try {
    sessionStorage.setItem('cloud_room', room);
    sessionStorage.setItem('cloud_room_ts', String(Date.now()));
  } catch (e) {}
}
function cloudForget() {
  try {
    sessionStorage.removeItem('cloud_room');
    sessionStorage.removeItem('cloud_room_ts');
  } catch (e) {}
}

function cloudNewCode() {
  const buf = new Uint8Array(10);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < 10; i++) buf[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (let i = 0; i < 10; i++) s += CLOUD_ROOM_ALPHABET[buf[i] % CLOUD_ROOM_ALPHABET.length];
  return s;
}

function cloudUniqueName(raw) {
  const base = String(raw || 'file').replace(/[\\/]/g, '_').slice(0, 180) || 'file';
  if (!Cloud.files.has(base)) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let i = 2;
  while (Cloud.files.has(stem + '(' + i + ')' + ext)) i++;
  return stem + '(' + i + ')' + ext;
}

function cloudRev(list) {
  const s = JSON.stringify(list);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function cloudJSON(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// IndexedDB 在隐私模式 / 存储被禁 / 某些 WebView 里可能既不成功也不报错，
// 一直挂着会把「创建房间」卡在 10%。所有持久化操作都套一层超时：
// 超时就当没存上，房间退回纯内存运行（刷新会丢），但绝不阻塞建房与收发。
function cloudGuard(p, ms) {
  // 以前那个 1500ms 的 setTimeout 从不 clear：每次持久化都留一个悬挂定时器。
  let t = null;
  const timeout = new Promise(resolve => {
    t = setTimeout(() => resolve(null), ms || 1500);
  });
  return Promise.race([
    Promise.resolve(p).catch(() => null),
    timeout
  ]).finally(() => { if (t) clearTimeout(t); });
}

function cloudPathOf(url) {
  const s = String(url || '');
  const i = s.indexOf('?');
  return {
    path: i < 0 ? s : s.slice(0, i),
    query: new URLSearchParams(i < 0 ? '' : s.slice(i + 1))
  };
}

const Cloud = {
  room: '',
  msgs: [],
  files: new Map(),
  nums: {},
  devices: [],
  createdAt: 0,
  lastActive: 0,
  quotaOk: true,                    // 浏览器是否给出了可信的可用空间；false = 禁用上传
  totalMax: 0,                      // 本房间的文件总量上限（建房时探测得出，0 = 不可用）
  fileMax: 0,                       // 单文件上限 = 总量 × 10%
  waiters: [],
  _timer: null,
  _persistChain: null,              // 持久写串行链，保证「后一次调用后落盘」
  _dissolving: null,                // dissolve 并发锁：同一轮只清一次库

  totalBytes() {
    let n = 0;
    for (const b of Cloud.files.values()) n += (b && b.size) || 0;
    return n;
  },

  // 问浏览器要「这个站点现在还能写多少」：quota 是硬上限，usage 是已经占掉的
  // （上一个房间的残留、页面缓存都算在内）。可用配额 × 80% 就是房间总量，
  // 留 20% 给消息记录、元数据与浏览器的自身开销。
  // 拿不到可信数字时把 quotaOk 置 false、容量归零——上层据此禁用上传。
  async probeQuota() {
    let avail = 0;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        const q = Number(est && est.quota) || 0;
        const u = Number(est && est.usage) || 0;
        if (q > 0) avail = Math.max(0, q - u);
      }
    } catch (e) {}
    // 隐私模式 / 老浏览器拿不到数字：不猜上限，直接判定「本房间不能收文件」
    Cloud.quotaOk = avail >= CLOUD_MIN_QUOTA;
    Cloud.totalMax = Cloud.quotaOk ? Math.floor(avail * CLOUD_QUOTA_RATIO) : 0;
    Cloud.fileMax = Cloud.quotaOk ? Math.floor(Cloud.totalMax * CLOUD_FILE_RATIO) : 0;
    return Cloud.quotaOk;
  },

  async createRoom() {
    await cloudGuard(cloudClearAll());
    Cloud.room = cloudNewCode();
    Cloud.msgs = [];
    Cloud.files = new Map();
    Cloud.nums = {};
    Cloud.devices = [];
    Cloud.createdAt = Date.now();
    Cloud.lastActive = Cloud.createdAt;
    cloudRemember(Cloud.room);
    // 清完库再探测：usage 此刻最干净，算出来的可用空间才是真的可用
    await cloudGuard(Cloud.probeQuota(), 3000);
    await cloudGuard(cloudSetMany([['meta', Cloud.meta()], ['msgs', []]]));
    Cloud.startIdleWatch();
    return Cloud.room;
  },

  meta() {
    return {
      room: Cloud.room,
      createdAt: Cloud.createdAt,
      lastActive: Cloud.lastActive,
      nums: Cloud.nums,
      devices: Cloud.devices,
      totalMax: Cloud.totalMax,
      fileMax: Cloud.fileMax,
      quotaOk: Cloud.quotaOk
    };
  },

  async resume(room) {
    const meta = await cloudGuard(cloudGet('meta'));
    if (!meta || meta.room !== room) return false;
    if (Date.now() - (meta.lastActive || meta.createdAt || 0) > CLOUD_IDLE_MS) {
      await cloudGuard(cloudClearAll());
      cloudForget();
      return false;
    }
    Cloud.room = meta.room;
    Cloud.createdAt = meta.createdAt || 0;
    Cloud.lastActive = meta.lastActive || Date.now();
    // 配额在建房那一刻就定了：刷新回来沿用同一份数字，
    // 否则同一房间前后两次刷新看到的上限会跳来跳去
    Cloud.quotaOk = meta.quotaOk !== false;
    Cloud.totalMax = meta.totalMax || 0;
    Cloud.fileMax = meta.fileMax || 0;
    // 老版本写下的 meta 没有这两个字段：补探一次，别让老房间变成「永远不能传」
    if (!meta.totalMax && Cloud.quotaOk) await cloudGuard(Cloud.probeQuota(), 3000);
    Cloud.msgs = (await cloudGuard(cloudGet('msgs'))) || [];
    Cloud.nums = meta.nums || {};
    Cloud.devices = meta.devices || [];
    Cloud.files = new Map();
    const keys = (await cloudGuard(cloudKeys())) || [];
    for (const k of keys) {
      if (typeof k === 'string' && k.indexOf('file:') === 0) {
        const blob = await cloudGuard(cloudGet(k));
        if (blob) Cloud.files.set(k.slice(5), blob);
      }
    }
    cloudRemember(Cloud.room);
    Cloud.startIdleWatch();
    return true;
  },

  async dissolve() {
    // onRoomClosed() 和空闲看门狗会在同一轮里各调一次。以前清两次库，
    // 中间若正好 createRoom()，第二次 clearAll 会把刚建好的房间抹掉。
    if (Cloud._dissolving) return Cloud._dissolving;
    Cloud.stopIdleWatch();
    const room = Cloud.room;
    Cloud.room = '';
    Cloud.msgs = [];
    Cloud.files.clear();
    Cloud.nums = {};
    Cloud.devices = [];
    cloudForget();
    Cloud._dissolving = (async () => {
      // 先等排队中的持久写落地（房间码已变，它们会自行丢弃），再清库，
      // 否则迟到的写入会把刚清空的库又填回旧房间的 meta / msgs。
      try { await (Cloud._persistChain || Promise.resolve()); } catch (e) {}
      try { await cloudClearAll(); } catch (e) {}
      Cloud._persistChain = null;
      return room;
    })();
    try { return await Cloud._dissolving; }
    finally { Cloud._dissolving = null; }
  },

  // 所有持久写排成一条链：并发调用时快照顺序与落盘顺序必须一致，
  // 否则慢的那次最后完成，会把新消息覆盖回旧列表。
  persistWrite(fn) {
    const next = (Cloud._persistChain || Promise.resolve())
      .catch(() => {}).then(fn);
    Cloud._persistChain = next;
    return next;
  },

  persistMeta() {
    const room = Cloud.room;
    const meta = Cloud.meta();
    return Cloud.persistWrite(() => {
      // 房间已换 / 已销毁：这次写属于上一个房间，直接丢弃
      if (!room || Cloud.room !== room) return false;
      return cloudGuard(cloudSet('meta', meta));
    });
  },

  persist() {
    const room = Cloud.room;
    const meta = Cloud.meta();
    const msgs = Cloud.msgs.slice();
    return Cloud.persistWrite(() => {
      if (!room || Cloud.room !== room) return false;
      // meta 与 msgs 同一事务：分两次写时，中间刷新会读到半截状态
      return cloudGuard(cloudSetMany([['meta', meta], ['msgs', msgs]]));
    });
  },

  payload() {
    // 文件字节没了就标 gone，不删消息：删了以后对方连“曾经有过这个文件”
    // 都看不到，只能来问——记录留着才是诚实的做法。
    const msgs = Cloud.msgs.map(m =>
      (m && m.type === 'file' && !Cloud.files.has(m.name))
        ? Object.assign({}, m, { gone: 1 }) : m);
    return {
      ok: true,
      room: Cloud.room,
      peers: 0,
      p2p: 0,
      devices: Cloud.devices || [],
      nums: Cloud.nums || {},
      self_ip: '',
      client_url: CLIENT_URL,
      closed: !Cloud.room,
      rev: cloudRev(msgs),
      messages: msgs
    };
  },

  waitChange(ms) {
    return new Promise(resolve => {
      let done = false;
      // timer 必须先声明再使用：finish 里要 clearTimeout 它，而 finish 有可能
      // 在 setTimeout 赋值之前就被 waiters 里的别人调用（同步触发），
      // 那时 const timer 还在暂时性死区里，会抛 ReferenceError。
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        Cloud.waiters = Cloud.waiters.filter(w => w !== finish);
        resolve();
      };
      timer = setTimeout(finish, ms);
      Cloud.waiters.push(finish);
    });
  },

  emit() {
    const list = Cloud.waiters.slice();
    Cloud.waiters = [];
    for (const fn of list) { try { fn(); } catch (e) {} }
  },

  startIdleWatch() {
    Cloud.stopIdleWatch();
    Cloud._timer = setInterval(() => {
      if (!Cloud.room) return;
      if (CHANNEL !== 'cloud') return;
      if (Date.now() - Cloud.lastActive > CLOUD_IDLE_MS) {
        Cloud.stopIdleWatch();      // 先停表：这一轮只收尾一次
        try { broadcast('ROOM_CLOSED'); } catch (e) {}
        try { onRoomClosed('房间 60 分钟无通信，已自动结束。'); } catch (e) {}
        // onRoomClosed 内部已经 dissolve 过；再调一次只会拿到同一个 promise，
        // 但 roomClosed 早被置位时它会直接 return，这里必须兜底清库。
        try { Cloud.dissolve(); } catch (e) {}
      }
    }, 15000);
  },

  stopIdleWatch() {
    if (Cloud._timer) { clearInterval(Cloud._timer); Cloud._timer = null; }
  },

  async handleMessages(query) {
    const wait = Math.min(parseInt(query.get('wait') || '0', 10) || 0, 20000);
    const want = query.get('rev') || '';
    let p = Cloud.payload();
    if (wait && want && want === p.rev) {
      await Cloud.waitChange(wait);
      if (!Cloud.room) {
        return cloudJSON({ ok: true, messages: [], rev: '', room: '', peers: 0,
                           p2p: 0, devices: [], nums: {}, closed: true });
      }
      p = Cloud.payload();
    }
    return cloudJSON(p);
  },

  async handleText(opts) {
    const q = new URLSearchParams(String(opts.body || ''));
    const content = (q.get('content') || '').slice(0, 20000);
    if (!content.trim()) return cloudJSON({ ok: true, id: '' });
    const id = (q.get('id') || '').slice(0, 32) || uid();
    const from = (q.get('from') || '').slice(0, 40) || '房主';
    Cloud.msgs.push({ id: id, type: 'text', content: content, time: nowHMS(), ip: from });
    Cloud.lastActive = Date.now();
    Cloud.persist();
    Cloud.emit();
    return cloudJSON({ ok: true, id: id });
  },

  async handleUpload(opts) {
    if (!Cloud.quotaOk) {
      // 探测失败时一个字都不收：写入再失败会留下半截记录，比直接拒绝更糟
      return cloudJSON({ ok: false,
        msg: '无法确认可用空间，已禁止上传文件' }, 507);
    }
    const fd = opts.body;
    if (!fd || typeof fd.getAll !== 'function') {
      return cloudJSON({ ok: false, msg: '格式错误' }, 400);
    }
    const files = fd.getAll('files');
    const from = String(fd.get('from') || '房主').slice(0, 40);
    let wantId = String(fd.get('id') || '').slice(0, 32);
    const ids = [];
    const names = [];
    // 先整体校验再落库：以前边校验边写，第 N 个触发 413 时前 N-1 个已经
    // 写进 IndexedDB 却没有消息卡片，成为「占着配额、看不见」的孤儿，
    // 之后每次都会误报空间不足。
    let need = 0, count = 0;
    for (const f of files) {
      if (!f || typeof f.size !== 'number') continue;
      count++;
      if (f.size > Cloud.fileMax) {
        return cloudJSON({ ok: false,
          msg: '单个文件不能超过 ' + fmtSize(Cloud.fileMax) }, 413);
      }
      need += f.size;
    }
    if (Cloud.totalBytes() + need > Cloud.totalMax) {
      return cloudJSON({ ok: false,
        msg: '房间存储空间不够了（上限 ' + fmtSize(Cloud.totalMax) + '）' }, 413);
    }
    const written = [];
    for (const f of files) {
      if (!f || typeof f.size !== 'number') continue;
      const name = cloudUniqueName(f.name);
      Cloud.files.set(name, f);   // 先占名：cloudUniqueName 靠这个 Map 给同名文件加序号
      written.push(name);
      // cloudGuard 把「写库抛错」和「超时」都变成 null。以前这个返回值被丢掉，
      // 于是用户看到「发送成功」，刷新后 resume() 恢复不到 Blob、文件凭空消失。
      const r = await cloudGuard(cloudSet('file:' + name, f));
      if (r !== true) {
        for (const w of written) {
          Cloud.files.delete(w);
          try { await cloudGuard(cloudDel('file:' + w)); } catch (e) {}
        }
        return cloudJSON({ ok: false,
          msg: '浏览器存储写入失败，文件未保存（可能是空间不足或隐私模式）' }, 507);
      }
      const id = wantId || uid();
      wantId = '';
      names.push(name);
      ids.push(id);
      Cloud.msgs.push({ id: id, type: 'file', name: name,
                        size: fmtSize(f.size), time: nowHMS(), ip: from });
    }
    Cloud.lastActive = Date.now();
    Cloud.persist();
    Cloud.emit();
    return cloudJSON({ ok: true, count: count, ids: ids, names: names });
  },

  // 房主清理文件：删掉 Blob，立刻把配额还回来；消息记录保留并标 gone。
  // 只删 Blob 不删消息，会留下“点了没反应”的卡片——所以卡片必须知道自己是
  // 已清理态（前端按 gone 渲染成灰卡），而不是靠“删掉记录”来避免死卡片。
  async deleteFiles(names) {
    const set = new Set((names || []).filter(n => typeof n === 'string' && n));
    if (!set.size) return { freed: 0, gone: 0 };
    let freed = 0, gone = 0;
    for (const n of set) {
      const b = Cloud.files.get(n);
      if (b) freed += (b.size || 0);
      Cloud.files.delete(n);
      try { await cloudGuard(cloudDel('file:' + n)); } catch (e) {}
    }
    for (const m of Cloud.msgs) {
      if (m && m.type === 'file' && set.has(m.name) && !m.gone) { m.gone = 1; gone++; }
    }
    Cloud.lastActive = Date.now();
    try { await Cloud.persist(); } catch (e) {}
    Cloud.emit();
    return { freed: freed, gone: gone };
  },

  async handleDownload(query, opts) {
    const name = String(query.get('name') || '');
    const blob = Cloud.files.get(name);
    // 410 而不是 404：文件曾经在、是房主主动清理掉的。前端据此说“已清理”，
    // 404 更像是“名字打错了”，两种情况的引导完全不同。
    if (!blob) return cloudJSON({ ok: false, msg: '文件已被房主清理' }, 410);
    const type = mimeOf(name) || 'application/octet-stream';
    // 断点续传：访客会带 Range 只取后半段。以前这里一律整份返回，纯网页房间
    // （外网的主场景）里续传等于没做——房主照样从 0 发一遍。按 HTTP 语义补齐。
    const hdrs = (opts && opts.headers) || {};
    const range = String(
      (hdrs.get && hdrs.get('Range')) || hdrs['Range'] || hdrs['range'] || '');
    const m = /bytes=(\d+)-(\d*)/i.exec(range);
    if (m) {
      const start = Number(m[1]);
      if (start >= blob.size) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': 'bytes */' + blob.size }
        });
      }
      const end = m[2] ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1;
      return new Response(blob.slice(start, end + 1), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + blob.size,
          'Content-Length': String(end - start + 1)
        }
      });
    }
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(blob.size) }
    });
  },

  async handleScreen(opts) {
    const q = new URLSearchParams(String(opts.body || ''));
    const st = q.get('status') || '';
    const id = (q.get('id') || '').slice(0, 32);
    const from = (q.get('from') || '房主').slice(0, 40);
    if (!id || (st !== 'start' && st !== 'stop')) {
      return cloudJSON({ ok: false, msg: '参数错误' }, 400);
    }
    const now = nowHMS();
    if (st === 'start') {
      if (!Cloud.msgs.some(m => m.id === id && m.type === 'screen')) {
        Cloud.msgs = Cloud.msgs.filter(
          m => !(m.type === 'screen' && m.status === 'live' && m.id !== id));
        Cloud.msgs.push({ id: id, type: 'screen', status: 'live', ip: from, time: now });
      }
    } else {
      for (let i = Cloud.msgs.length - 1; i >= 0; i--) {
        const m = Cloud.msgs[i];
        if (m.id === id && m.type === 'screen' && m.status === 'live') {
          m.status = 'ended';
          m.end = now;
          try { m.dur = fmtScreenDur(m.time || '', now); } catch (e) { m.dur = ''; }
          break;
        }
      }
    }
    Cloud.lastActive = Date.now();
    Cloud.persist();
    Cloud.emit();
    return cloudJSON({ ok: true });
  },

  async handleDevices(opts) {
    try {
      const d = JSON.parse(String(opts.body || '{}'));
      // 云房间只有外网设备：补上 channel，房主端的编号与成员清单才不会
      // 把它们当成局域网设备重复编号
      if (Array.isArray(d.devices)) {
        Cloud.devices = d.devices.slice(0, 50).map(x => Object.assign({}, x, { channel: 'p2p' }));
      }
      if (d.nums && typeof d.nums === 'object') Cloud.nums = d.nums;
    } catch (e) {}
    Cloud.persistMeta();
    return cloudJSON({ ok: true, count: (Cloud.devices || []).length });
  },

  // 清掉上一次会话残留的房间：只有「本标签页没有房间」且已经超过空闲上限才动，
  // 避免另一个标签页正在用的房间被误删
  async cleanupOrphans() {
    if (cloudRoomCode()) return;
    try {
      const meta = await cloudGuard(cloudGet('meta'));
      if (meta && meta.room &&
          Date.now() - (meta.lastActive || meta.createdAt || 0) > CLOUD_IDLE_MS) {
        await cloudClearAll();
      }
    } catch (e) {}
  },

  // 云房主登记新成员：更新活跃时间并广播，人数上限与局域网房间共用一套判断
  touch() {
    Cloud.lastActive = Date.now();
    // 只改内存的话，房主刷新后 resume() 读到旧 lastActive，倒计时会偏，
    // 极端情况下房间被误判成「60 分钟空闲」提前销毁。
    try { Cloud.persistMeta(); } catch (e) {}
  }
};

// 把 URL 路由到内存仓库。返回值统一是 Response，调用方（room.js / gate.js）
// 完全不需要知道自己在跟 HTTP 还是内存打交道。
const CloudStore = {
  canHandle(url) {
    const p = cloudPathOf(url).path;
    return [
      '/messages', '/text', '/upload', '/download', '/screen',
      '/api/devices', '/api/stats', '/api/join',
      '/api/room/heartbeat', '/api/room/dissolve', '/api/room/create',
      '/api/room/renew', '/api/room/bye'
    ].indexOf(p) >= 0;
  },

  async handle(url, opts) {
    opts = opts || {};
    const parts = cloudPathOf(url);
    const path = parts.path;
    const query = parts.query;

    if (!Cloud.room && path !== '/api/room/create') {
      if (path === '/messages') {
        return cloudJSON({ ok: true, messages: [], rev: '', room: '', peers: 0,
                           p2p: 0, devices: [], nums: {}, closed: true });
      }
      // 房间已结束时，在途的写请求不能再落库：否则会往已销毁房间的
      // IndexedDB 里写数据、刷新 lastActive，让 cleanupOrphans() 误判「刚活跃」
      // 而不清理，残留一直滞留到下次建房。读接口照常放行，避免收尾页面报错。
      const WRITES = ['/text', '/upload', '/screen', '/api/devices', '/api/stats',
                      '/api/room/p2p', '/api/room/renew', '/api/room/dissolve', '/delete'];
      if (WRITES.indexOf(path) >= 0) {
        return cloudJSON({ ok: false, code: 'NO_ROOM', msg: '房间已结束' }, 409);
      }
    }

    switch (path) {
      case '/messages':
        return Cloud.handleMessages(query);
      case '/text':
        return Cloud.handleText(opts);
      case '/upload':
        return Cloud.handleUpload(opts);
      case '/download':
        return Cloud.handleDownload(query, opts);
      case '/screen':
        return Cloud.handleScreen(opts);
      case '/api/devices':
        return Cloud.handleDevices(opts);
      case '/api/stats':
        return cloudJSON({ ok: true });
      case '/api/join':
        return cloudJSON({ ok: false, code: 'NO_ROOM',
                           msg: '纯网页房间不支持局域网加入' }, 409);
      case '/api/room/heartbeat':
        Cloud.lastActive = Date.now();
        Cloud.persistMeta();
        return cloudJSON({ ok: true });
      case '/api/room/bye':
        return cloudJSON({ ok: true });
      case '/api/room/create': {
        const room = Cloud.room || await Cloud.createRoom();
        return cloudJSON({ ok: true, room: room });
      }
      case '/api/room/renew': {
        const old = await Cloud.dissolve();
        if (old) { try { broadcast('ROOM_CLOSED'); } catch (e) {} }
        const room = await Cloud.createRoom();
        return cloudJSON({ ok: true, room: room });
      }
      case '/api/room/dissolve': {
        const room = await Cloud.dissolve();
        return cloudJSON({ ok: true, room: room });
      }
    }
    return cloudJSON({ ok: false, msg: '未知接口' }, 404);
  }
};
