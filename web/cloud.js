// ===== cloud.js — 纯网页房主（CHANNEL = 'cloud'）=====
// 不依赖本机程序：房间状态在内存，聊天记录与文件在 IndexedDB。
// 与局域网房主共用同一套 P2P 协议与消息结构，访客端拿到的仍是
// TEXT / FILE_CARD / HISTORY 这些老消息——协议一个字节都没改。
//
// 生命周期：刷新不算离线（IndexedDB 恢复）；关页 / 离线 / 30 分钟无通信即销毁。
// 浏览器没有后端进程，销毁只能在本页还活着时立即做，或下次打开时按时间戳清库。

const CLOUD_DB_NAME = 'datatransmission_cloud';
const CLOUD_DB_STORE = 'kv';
const CLOUD_IDLE_MS = 30 * 60 * 1000;          // 与后端 ROOM_IDLE_MAX 对齐
const CLOUD_MAX_GUESTS = 5;                    // 房主 + 5 = 6 人
const CLOUD_FILE_MAX = 100 * 1024 * 1024;      // 单文件 100 MB
const CLOUD_TOTAL_MAX = 500 * 1024 * 1024;     // 房间总量 500 MB
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
  return Promise.race([
    Promise.resolve(p).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), ms || 1500))
  ]);
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
  waiters: [],
  _timer: null,

  totalBytes() {
    let n = 0;
    for (const b of Cloud.files.values()) n += (b && b.size) || 0;
    return n;
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
    await cloudGuard(cloudSet('meta', Cloud.meta()));
    await cloudGuard(cloudSet('msgs', []));
    Cloud.startIdleWatch();
    return Cloud.room;
  },

  meta() {
    return {
      room: Cloud.room,
      createdAt: Cloud.createdAt,
      lastActive: Cloud.lastActive,
      nums: Cloud.nums,
      devices: Cloud.devices
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
    Cloud.stopIdleWatch();
    const room = Cloud.room;
    Cloud.room = '';
    Cloud.msgs = [];
    Cloud.files.clear();
    Cloud.nums = {};
    Cloud.devices = [];
    cloudForget();
    try { await cloudClearAll(); } catch (e) {}
    return room;
  },

  persistMeta() {
    return cloudGuard(cloudSet('meta', Cloud.meta()));
  },

  persist() {
    Cloud.persistMeta();
    return cloudGuard(cloudSet('msgs', Cloud.msgs));
  },

  payload() {
    const msgs = Cloud.msgs.filter(m => m.type !== 'file' || Cloud.files.has(m.name));
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
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        Cloud.waiters = Cloud.waiters.filter(w => w !== finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
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
        try { broadcast('ROOM_CLOSED'); } catch (e) {}
        try { onRoomClosed('房间超过 30 分钟没有通信，已自动销毁。'); } catch (e) {}
        Cloud.dissolve();
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
    const fd = opts.body;
    if (!fd || typeof fd.getAll !== 'function') {
      return cloudJSON({ ok: false, msg: '格式错误' }, 400);
    }
    const files = fd.getAll('files');
    const from = String(fd.get('from') || '房主').slice(0, 40);
    let wantId = String(fd.get('id') || '').slice(0, 32);
    const ids = [];
    const names = [];
    for (const f of files) {
      if (!f || typeof f.size !== 'number') continue;
      if (f.size > CLOUD_FILE_MAX) {
        return cloudJSON({ ok: false, msg: '单个文件不能超过 100 MB' }, 413);
      }
      if (Cloud.totalBytes() + f.size > CLOUD_TOTAL_MAX) {
        return cloudJSON({ ok: false, msg: '房间文件总量已达 500 MB 上限' }, 413);
      }
      const name = cloudUniqueName(f.name);
      Cloud.files.set(name, f);
      await cloudGuard(cloudSet('file:' + name, f));
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
    return cloudJSON({ ok: true, count: files.length, ids: ids, names: names });
  },

  async handleDownload(query) {
    const name = String(query.get('name') || '');
    const blob = Cloud.files.get(name);
    if (!blob) return cloudJSON({ ok: false, msg: '文件不存在' }, 404);
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': mimeOf(name) || 'application/octet-stream' }
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
    }

    switch (path) {
      case '/messages':
        return Cloud.handleMessages(query);
      case '/text':
        return Cloud.handleText(opts);
      case '/upload':
        return Cloud.handleUpload(opts);
      case '/download':
        return Cloud.handleDownload(query);
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
