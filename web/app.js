
const chatInner = document.getElementById('chatInner');
const chatScroll = document.getElementById('chatScroll');
const msgList = document.getElementById('msgList');
const fi = document.getElementById('fileInput');
const textInput = document.getElementById('textInput');
const pendingArea = document.getElementById('pendingArea');
// 两种进入方式共用一套界面：
//   host  —— 本机页面（8000），或在线页点「创建房间」探活成功
//   guest —— 在线页点「加入房间」，只走 P2P，不碰任何后端
const SEED_MODE = '__SERVER_MODE__';
const HOST_PORT = __PORT__;
const HOME_API = 'http://127.0.0.1:' + HOST_PORT;
// 本机页面（8000）直接走同源，免得用局域网 IP 打开时被当成跨域；
// 在线页只能访问 127.0.0.1 上的本机程序
const HOST_API = (SEED_MODE === 'host') ? '' : HOME_API;
// 是否能当 P2P 房主：本机（回环）页和在线页都是 true —— 在线页照样能开
// 云房间、也能通过本机程序开局域网房间，外网开关得给它。
// 只有「别人从局域网 IP 打开本机服务」那份页面是 false：它跟房主抢同一个
// Peer ID（pc-<房间码>），双方都报 unavailable-id，还会把房间码换掉。
const P2P_ENABLED = __P2P_ENABLED__;
// 本机程序里那个房间开不开外网直连（创建时选的）；刷新后靠它恢复同样的形态
const ROOM_P2P = __ROOM_P2P__;
// 局域网设备还没输入房间码：先停在入口页，输对了才进房间
const JOIN_REQUIRED = __JOIN_REQUIRED__;
// 本机程序里是否已经有房间：没有就先停在入口页，点「创建房间」才开房
const HAS_ROOM = __HAS_ROOM__;
// 本机的局域网访问地址（http://192.168.x.x:8000），guest 页为空
const LAN_URL = '__LAN_URL__';
let MODE = SEED_MODE;
// 通道：lan = 有本机程序（文件存本机硬盘）；cloud = 网页房间（文件存浏览器）。
// 与 MODE（房主 / 访客）正交，进房后只读，只有创建房间时的二选一能改。
let CHANNEL = 'lan';
// 局域网房间的「外网加入」开关：默认开，房主可以在房间里随时拨。
// 关掉 = 不注册 P2P 房主、外网链接与二维码失效，房间退化成纯局域网（没网也能用）。
// 网页直连房间恒为 true——它本身就是外网通道，没有关掉这回事。
let P2P_ON = true;
let API = (SEED_MODE === 'host') ? '' : HOME_API;
let ROOM = '__ROOM__';
// 人数上限：与后端 ROOM_MAX_MEMBERS 对齐；有本机程序时用 /api/host 回传的真值覆盖，
// 云房间没有后端，就用这个默认值。
let ROOM_MAX = 6;
// 房间的存储 / 上传限制。房主这边是本地真值，加入者这边靠房主推来的 QUOTA 帧。
//   kind: cloud = 文件存房主浏览器（有总量、已用、单文件上限）
//         lan   = 文件存房主磁盘（只有单文件上限）
//   ok:   false 表示房主拿不到浏览器配额，全房禁传
let hostLimits = null;       // 访客侧：房主广播的同一份数字（null = 还没收到）
let lanFileMax = 0;          // 局域网房间单文件上限，由后端 max_file 下发
const PROTOCOL = 4;          // v4：连接元数据带上昵称与设备 ID，房主分配名字时不用等 HELLO
// 邀请链接用的域名：本机页面由程序每次请求时按 client_url.txt 现填；
// 在线页（GitHub 上那份）写的是导出那一刻的值，只能靠运行时从本机接口拿最新值覆盖，
// 见 applyClientUrl()。所以改 client_url.txt 不用重新导出、也不用重新上传静态页。
let CLIENT_URL = '__CLIENT_URL__';
// 页面源文件指纹（由程序按 web/ 源文件现算，在线页 = 导出那一刻的值）。
// 邀请链接 / 二维码 / 复制的访问地址都带 ?v=<指纹>：手机浏览器对页面缓存
// 非常顽固，URL 不变就拿旧缓存页连新程序，轻则变慢、重则连不上。
const PAGE_BUILD = '__PAGE_BUILD__';
let lastRev = null;
let pollGen = 0;             // 轮询代际：换代 / 停止时让在途请求的结果作废
let pollAbort = null;        // 在途长轮询的 AbortController
let pollBackoff = 0;         // 连续失败次数，决定退避多久
let roomClosed = false;      // 房主已解散房间，页面停在入口页
let dissolving = false;      // 正在请求解散，避免轮询抢先提示
let msgFailStreak = 0;       // /messages 连续失败次数（程序被关掉 / 网络断了）
let guestGoneHits = 0;       // 访客端连续几次收到「房间不存在」，两次才判定真没了
let guestGoneHandled = false;// 避免 ROOM_CLOSED 重复消息把起始页刷两遍
let pendingFiles = [];
let pcPeer = null;
// 房主端：一个房间可以同时连多台外网设备，所以连接是一组而不是一条
//   id    —— 内部编号
//   conn  —— PeerJS DataConnection
//   name  —— 房间里的显示名（房主分配，保证唯一）
let hostConns = new Map();
let hostSeq = 0;
// 文件接收缓冲按连接隔离，否则两台设备同时发文件会串包
let recvBuf = new Map();
// 二进制分片若是 Blob 形式到达（部分手机浏览器），要异步读成 ArrayBuffer。
// 按连接各排一条 Promise 链：同一条连接的异步读取严格按到达顺序拼进 recvBuf，
// 不同连接互不拖累（全局单链时，慢设备会把快设备的尾片拖到 9s 宽限超时）。
const chunkChains = new Map();
let guestPeer = null, guestConn = null;
let myName = '';             // 本机在房间里的名字（房主为「房主」，访客由房主分配）
let pushedIds = new Set();   // 房主端：已经转发给外网设备的消息 id
let relaySeeded = false;     // 首次拉 /messages 只记 id 不转发（历史由 HISTORY 单独推）
// ── 文件分片与序列化 ────────────────────────────────────────────────
// 所有 DataConnection 统一用 serialization:'raw'（gate.js / room.js 的
// peer.connect）。默认的 BinaryPack 会按 chunkedMTU=16300 拆包：一片 64 KB
// 要变成 5 条 {__peerData,n,data,total} 消息，各自编码、send、走一次事件回调，
// 接收端还要缓存并按序号重组。raw 模式下 _send() 直接 _bufferedSend(buf)，
// 一帧到底，编码与重组开销归零；字符串控制消息原样派发，协议一个字节没改。
// PeerJS 按 offer 里的 serialization 自动挑实现，新旧客户端互联各自兼容。
const CHUNK_SIZE = 65536;   // 拿不到 sctp 协商值时的全平台安全档
// 在途窗口：吞吐上限约等于「窗口 ÷ RTT」。2 MB 在 100ms RTT 下约 20 MB/s。
const MAX_BUFFERED = 2 * 1024 * 1024;
const ICE_SERVERS = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  // 兜底中继：双 NAT / 公司网 / 校园网下直连永远打不通，这时才走 TURN。
  // ICE 会优先直连，正常情况不会增加延迟；免费公共 TURN 带宽有限，
  // 用户可以在 localStorage 的 lanshare_ice 里用自定义列表整组覆盖。
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
];
// 自定义 STUN/TURN：只存在这台设备的浏览器里，不写进房间、不上传。
// 存的是「完整列表」（含用户删改后的默认项），没存过就用上面的默认值。
function customIce() {
  try {
    const list = JSON.parse(localStorage.getItem('lanshare_ice') || 'null');
    if (Array.isArray(list) && list.length) return list;
  } catch (e) {}
  // 兼容更早的版本：单独存过一条 TURN
  try {
    const t = JSON.parse(localStorage.getItem('lanshare_turn') || 'null');
    if (t && t.urls) return [{ urls: t.urls, username: t.username || '', credential: t.credential || '' }];
  } catch (e) {}
  return null;
}
function iceServers() {
  const custom = customIce();
  return custom ? custom.slice() : ICE_SERVERS.slice();
}
function peerOpts() {
  const o = {
    config: {
      iceServers: iceServers(),
      // 注意：不要加 iceCandidatePoolSize！2026-11 实测新版 Chrome 上它会制造
      // 重复候选、两条 nominated pair，DTLS 握手随机卡死（外网加入失败的主因）。
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    }
  };
  return o;
}
// 每次都是一个全新的 Peer ID：不能用固定值，否则两台设备撞号
function guestPeerId() {
  return 'g-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
}
// ===== 信令预热 =====
// 外网连接慢，慢的多半不是「连对方」，而是「先连上 PeerJS 信令服务器」那一步
// （DNS + WebSocket + 服务器回 OPEN，通常 0.3～1.5 秒）。
// 入口页一打开就把这条长连接建好，用户输房间码的这几秒正好用来握手，
// 点「加入房间」时只剩「呼叫对方设备」一步。
let warmPeer = null;
let warmPeerAt = 0;
const WARM_MAX_AGE = 90000;   // 入口页停留太久，预热连接也会被信令服务器单方面断开
function prewarmSignal() {
  if (MODE !== 'guest' || JOIN_REQUIRED) return null;   // 局域网设备走 HTTP，用不上
  if (warmPeer && !warmPeer.destroyed && Date.now() - warmPeerAt < WARM_MAX_AGE) return warmPeer;
  // 太旧的先收掉重建，否则点「加入」时会拿到一条已经废掉的长连接
  if (warmPeer) { try { warmPeer.destroy(); } catch (e) {} }
  warmPeer = null;
  warmPeerAt = 0;
  try {
    warmPeer = new Peer(guestPeerId(), peerOpts());
    warmPeerAt = Date.now();
  } catch (e) {
    warmPeer = null;
    return null;                 // 预热失败不影响正常流程，真正连接时会再建
  }
  const p = warmPeer;
  // 预热阶段的错误一律吞掉：置空即可，点「加入」时会现建一条
  p.on('error', () => {
    if (warmPeer === p) {
      warmPeer = null;
      warmPeerAt = 0;
      try { p.destroy(); } catch (e) {}
    }
  });
  p.on('disconnected', () => {
    if (warmPeer === p) { try { p.reconnect(); } catch (e) {} }
  });
  return p;
}
// 取走预热好的连接（只取一次）；已经废掉的返回 null
function takeWarmPeer() {
  const p = warmPeer, age = Date.now() - warmPeerAt;
  warmPeer = null;
  warmPeerAt = 0;
  if (!p || p.destroyed) return null;
  // 放了很久却还没注册上信令：这条多半已经卡死，别拿去用
  if (age > WARM_MAX_AGE && !p.open) {
    try { p.destroy(); } catch (e) {}
    return null;
  }
  return p;
}
// 房主端临时提示（连接中、正在接收文件、信令错误等）单独一行，
// 不占用「已连接 N 台设备」这条通道状态；10 秒后自动收起，避免旧提示常驻
let hostNoticeTimer = null;
function showHostHint(m) {
  // 连接/收文件提示也只在房主端出现，别的设备连这块都不该有内容
  if (!isRoomOwner()) return;
  const el = document.getElementById('hostNotice');
  if (!el) return;
  el.textContent = m || '';
  el.style.display = m ? 'block' : 'none';
  clearTimeout(hostNoticeTimer);
  if (m) hostNoticeTimer = setTimeout(() => { el.style.display = 'none'; }, 10000);
}
function showGuestTip(m) {
  const el = document.getElementById('guestTip');
  if (!el) return;
  el.style.display = m ? 'block' : 'none';
  el.textContent = m || '';
}
// 连接卡的状态行：只在「还没连上」时显示，连上就整行收起。
// 存一份文本是为了让按钮状态和文字状态互相独立：先写文字再改状态、或反过来都不会漏。
let guestConnState = 'connecting';
let guestStatusText = '';
let guestStatusOk = false;
function renderGuestStatus() {
  const el = document.getElementById('guestStatus');
  if (!el) return;
  // 连上之后一律不留字；连接中若还没写具体阶段，至少给一句「正在连接…」
  const text = guestConnState === 'connected' ? ''
             : (guestStatusText || (guestConnState === 'connecting' ? '正在连接…' : ''));
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
  el.style.color = guestStatusOk ? '#0a8f4a' : '#3c7a57';
  el.style.fontWeight = guestStatusOk ? '600' : 'normal';
}
// 连接卡上的按钮跟着状态走，「断开连接」只在真正连上之后才出现：
//   connecting —— 还没连上，按钮没意义，整排藏起来，只留连接进度文字
//   connected  —— 只留一颗「断开连接」胶囊
//   failed     —— 彻底停下来不再自动重试了，才给一个手动「重连」
let dropBusy = false;   // 点过一次就开始收尾，避免连点重复执行
function setGuestActions(state) {
  const box = document.getElementById('guestActions');
  const retry = document.getElementById('guestConnBtn');
  const drop = document.getElementById('guestDropBtn');
  if (!box || !retry || !drop) return;
  box.style.display = state === 'connecting' ? 'none' : 'flex';
  retry.style.display = state === 'failed' ? '' : 'none';
  drop.style.display = state === 'connected' ? '' : 'none';
  guestConnState = state;
  renderGuestStatus();
}
// 房间卡片只属于房主：传房间码就显示并刷新，传空值就收起。
// 房间号的写入统一走这里，不在各处重复 getElementById。
function showRoomCard(room) {
  const box = document.getElementById('roomCard');
  if (!box) return;
  box.style.display = room ? 'block' : 'none';
  if (room) document.getElementById('roomCode').textContent = room;
}
// 其他设备（外网访客 / 局域网设备）共用同一张连接卡：只有通道名不同，
// 房间号、按钮、显示的信息完全一样，不再各写一套横幅和说明。
function showOtherDeviceCard(label, room) {
  showRoomCard('');
  document.getElementById('lanBanner').style.display = 'none';
  document.getElementById('p2pBanner').style.display = 'none';
  document.getElementById('guestGate').style.display = 'block';
  document.getElementById('connChannel').textContent = label;
  document.getElementById('linkRoom').textContent = room || '';
}
// 连接卡里的「本机 IP」：加入方能看到自己在房间里的地址，方便和房主端
// 设备清单对号定位。拿到之前整行隐藏，不占地方。
function setSelfIp(ip) {
  const row = document.getElementById('selfIpRow');
  if (!row || !ip) return;
  row.style.display = '';
  const v = document.getElementById('selfIpVal');
  if (v) v.textContent = ip;
}
// 局域网设备没有 P2P 连接可断：点「断开连接」就是退出房间、回输码页
function leaveLanRoom() {
  dropBusy = false;
  forgetJoinRoom();           // 主动断开：清掉回连记录，刷新不会再自动加入旧房间
  setGuestActions('connecting');
  stopPolling();
  document.getElementById('guestGate').style.display = 'none';
  document.getElementById('lanBanner').style.display = 'none';
  showLanGate();
  gateMsg('已断开连接，可重新加入。', 'warn');
}

// ===== 连接集合：房主端可能同时连着多台外网设备 =====
// 只算「真的进了房间」的连接（房主已经分配给它名字）：
// 通道刚开、还在报身份的那几百毫秒，以及被请出的设备来敲门，都不算人，
// 否则房主会看到人数闪一下、或者把消息发给一个马上要被拒掉的连接。
function hostList() {
  const out = [];
  for (const [id, x] of hostConns) {
    if (x && x.conn && x.conn.open && x.registered) {
      out.push({ id: id, conn: x.conn, name: x.name, ip: x.ip || '', dev: x.dev || '', num: x.num || 0 });
    }
  }
  return out;
}
// 兼容老代码：房主端没有「唯一连接」这个概念了，这里只给访客端用
function activeConn() {
  if (MODE !== 'guest') return null;
  return (guestConn && guestConn.open) ? guestConn : null;
}
function canP2P() {
  if (MODE === 'guest') return !!(guestConn && guestConn.open);
  return hostList().length > 0;
}
// 发给房间里的外网设备；excludeName 用于把消息回给发送者本人
function broadcast(msg, excludeName) {
  let n = 0;
  for (const x of hostList()) {
    if (excludeName && x.name === excludeName) continue;
    try { x.conn.send(msg); n++; } catch (e) {}
  }
  return n;
}
function notify(msg, ok) { if (MODE === 'guest') setStatus(msg, ok); else toast(msg); }
function setStatus(m, ok) {
  // 已连接时的「接收中 / 已下载 / 走中继」等文字直接丢掉，不留底：
  // 否则下一次掉线切回 connecting 时，会把上一条旧文字翻出来当作连接进度。
  if (guestConnState === 'connected') {
    guestStatusText = '';
    guestStatusOk = false;
  } else {
    guestStatusText = m || '';
    guestStatusOk = !!ok;
  }
  renderGuestStatus();
}
// ===== 传输进度：百分比 + 实时速度 + 剩余时间 =====
// 速度用「每 0.35 秒采样一次、指数平滑」：瞬时值抖得厉害，直接显示会跳来跳去
let txState = null;
function fmtSpeed(bps) {
  if (!(bps > 0)) return '';
  if (bps < 1024) return bps.toFixed(0) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(1) + ' MB/s';
}
function fmtEta(sec) {
  if (!(sec > 0)) return '';
  if (sec < 60) return Math.max(1, Math.round(sec)) + ' 秒';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟';
  return (sec / 3600).toFixed(1) + ' 小时';
}
function txStart(name, total, mid) {
  txState = { name: name || '', total: total || 0, done: 0, mid: mid || '',
              lastT: Date.now(), lastD: 0, speed: 0 };
  txRender();
}
function txTick(done, total) {
  if (!txState) txStart('', total || done);
  if (total) txState.total = total;
  const now = Date.now();
  const dt = (now - txState.lastT) / 1000;
  if (dt >= 0.35) {
    const inst = (done - txState.lastD) / dt;
    if (inst >= 0) txState.speed = txState.speed ? (txState.speed * 0.6 + inst * 0.4) : inst;
    txState.lastT = now;
    txState.lastD = done;
  }
  txState.done = done;
  // 一片 64 KB，1 GB 就是 1.6 万次回调。每次都改 DOM 会强制重排，
  // 而重排和「发下一片」抢的是同一个主线程——吞吐就是这样被自己拖下来的。
  // 进度条 10 Hz 刷新，肉眼完全看不出差别，主线程却能空出来跑分片。
  if (now - (txState.uiT || 0) >= 90 || (txState.total && done >= txState.total)) {
    txState.uiT = now;
    txRender();
  }
}
function txText() {
  if (!txState) return '';
  const pct = txState.total ? Math.min(100, txState.done / txState.total * 100) : 0;
  const parts = [pct.toFixed(0) + '%'];
  if (txState.total) parts.push(fmtSize(txState.done) + ' / ' + fmtSize(txState.total));
  const sp = fmtSpeed(txState.speed);
  if (sp) parts.push(sp);
  if (txState.speed > 0 && txState.total > txState.done) {
    parts.push('剩余 ' + fmtEta((txState.total - txState.done) / txState.speed));
  }
  return parts.join(' · ');
}
function txRender() {
  const box = document.getElementById('guestProg');
  const b = document.getElementById('guestBar');
  const t = document.getElementById('guestProgText');
  if (!box || !b) return;
  if (!txState) {
    box.style.display = 'none';
    b.style.width = '0%';
    if (t) t.textContent = '';
    return;
  }
  const pct = txState.total ? Math.min(100, txState.done / txState.total * 100) : 0;
  // 拉取/接收进度优先画到对应文件卡片正下方；卡片不在页面上才退回顶部横条
  if (txState.mid) {
    const w = document.getElementById('pullwrap-' + txState.mid);
    if (w) {
      w.style.display = 'block';
      const bar = w.querySelector('.pull-bar i');
      const txt = w.querySelector('.pull-text');
      if (bar) bar.style.width = pct.toFixed(1) + '%';
      if (txt) txt.textContent = txText();
      box.style.display = 'none';
      return;
    }
  }
  box.style.display = 'block';
  b.style.width = pct.toFixed(1) + '%';
  if (t) t.textContent = txText();
}
function txEnd() { txState = null; txRender(); }
// 兼容旧调用点：负数表示收工，其余当百分比用
function setGuestProgress(pct, total) {
  if (pct < 0) { txEnd(); return; }
  if (!txState) txStart('', total || 0);
  txTick(total ? total * pct / 100 : 0, total || 0);
}
function protoMismatch(v, ctx) {
  const msg = '协议版本不一致（本机 v' + PROTOCOL + '，对方 v' + v + '），请刷新对方页面或更新本机程序';
  notify(msg);
  const c = (ctx && ctx.conn) || activeConn();
  // 只清这一条连接：一台旧版设备 HELLO 不该把房主其他连接正在收的文件全丢了，
  // 更不能让那些发送端干等 20~90 秒的回执超时。
  const key = ctx ? ctx.id : 'guest';
  const half = recvBuf.get(key);
  if (half && !half.__superseded && half.received < half.size && half.conn && half.conn.open) {
    try { half.conn.send('FILE_NAK:' + half.id); } catch (e) {}
  }
  recvBuf.delete(key);
  if (c) { try { c.close(); } catch (e) {} }
  if (ctx && MODE === 'host') dropHostConnById(ctx.id);
}

// 顶栏地址由 startHostUI 里按「本机 / 局域网设备」分别填充

// 房间的存储 / 上传限制：房主这边取本地真值，加入者取房主推来的 QUOTA 帧。
// 文件最终都存在房主侧（云房间是浏览器，局域网房间是磁盘），所以「能传多大、
// 还剩多少」必须由房主说了算——加入者不该在传完几十 MB 之后才收到一句「存不下」。
// 访客的 CHANNEL 恒为 'lan'（它没有后端可问），因此判断不了房间类型，
// 只能看 hostLimits.kind：这就是 QUOTA 帧必须带 kind 的原因。
function roomLimits() {
  if (MODE === 'host') {
    // 局域网设备：没有配额、也没有房主权限，只知道后端给的单文件上限
    if (isLanClient) return { kind: 'lan', ok: true, total: 0, used: 0, max: lanFileMax || 0 };
    if (CHANNEL === 'cloud') {
      const total = (Cloud && Cloud.totalMax) || 0;
      return { kind: 'cloud', ok: !!(Cloud && Cloud.quotaOk !== false && total > 0),
               total: total, used: Cloud ? Cloud.totalBytes() : 0,
               max: (Cloud && Cloud.fileMax) || 0 };
    }
    return { kind: 'lan', ok: true, total: 0, used: 0, max: lanFileMax || 0 };
  }
  return hostLimits;          // 访客：还没收到 QUOTA 就是 null（不拦，保持旧行为）
}
// 云房间：文件最终存在房主的浏览器里，房主拿不到配额就整个房间都不收文件。
// 房主看 Cloud.quotaOk，访客看房主同步来的 ok 标记——两边都拦。
const CLOUD_FILE_HINT = '传输文件请使用任意最新版浏览器，并且不要开启无痕（隐私）访问。';
function cloudFileBlockReason() {
  const lim = roomLimits();
  if (!lim || lim.ok) return '';
  if (MODE === 'host') {
    return '浏览器没给出可用存储空间（无痕模式或版本过旧），本房间已禁止上传。' + CLOUD_FILE_HINT;
  }
  return '房主的浏览器无法确认可用存储空间，本房间已禁止上传。' + CLOUD_FILE_HINT;
}
// 点「发送文件」：先判一次，不能传就当场把原因说清楚，别把选择框弹出来让人白挑一通
function pickFiles() {
  const why = cloudFileBlockReason();
  if (why) { toast(why); return; }
  const fi = document.getElementById('fileInput');
  if (fi) fi.click();
}
// 发送队列：每个文件一条记录，带状态与进度（不再是一堆裸 File）
//   status: wait / sending / done / fail
let pendingSeq = 0;
function addFiles(list) {
  // 选择框、拖拽、Ctrl+V 三条路都汇到这里，拦一处就全拦住了
  const why = cloudFileBlockReason();
  if (why) { notify(why); return 0; }
  // 单文件上限 + 房间剩余空间：两者都由房主侧给出（局域网房间只有前者）
  const lim = roomLimits();
  const max = (lim && lim.max > 0) ? lim.max : 0;
  let budget = null, avail0 = 0;
  if (lim && lim.kind === 'cloud' && lim.total > 0) {
    const queued = pendingFiles.reduce((s, x) => s + ((x.file && x.file.size) || 0), 0);
    avail0 = Math.max(0, lim.total - lim.used - queued);
    budget = avail0;
  }
  let n = 0, noRoom = 0;
  const over = [];
  for (const f of Array.from(list || [])) {
    if (!f || typeof f.size !== 'number') continue;
    if (max && f.size > max) { over.push(f); continue; }
    if (budget !== null && f.size > budget) { noRoom++; continue; }
    if (budget !== null) budget -= f.size;
    pendingFiles.push({ uid: 'q' + (++pendingSeq), file: f, status: 'wait',
                        pct: 0, speed: 0, err: '',
                        pausable: false, paused: false, canceled: false });
    n++;
  }
  if (over.length) {
    notify(over[0].name + ' 超过单文件上限 ' + fmtSize(max) +
           (over.length > 1 ? '（另有 ' + (over.length - 1) + ' 个同样超限）' : ''));
  }
  if (noRoom) {
    notify('房间剩余空间不足：还可上传 ' + fmtSize(avail0) + '。');
  }
  if (n) {
    // 不弹「已加入队列」：底部列表立刻出现在眼前，再顶一个黑条是打扰
    renderPending();
  }
  return n;
}
fi.onchange = () => { addFiles(fi.files); fi.value = ''; };

// 拖拽：把文件拖进窗口任何位置都能加入队列
const dropMask = document.getElementById('dropMask');
let dragDepth = 0;
function inRoomView() {
  const g = document.getElementById('gateView');
  return !!g && !g.classList.contains('show');
}
function hasFiles(e) {
  const t = e.dataTransfer && e.dataTransfer.types;
  return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
}
window.addEventListener('dragenter', e => {
  if (!inRoomView() || !hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropMask.classList.add('show');
});
window.addEventListener('dragover', e => {
  if (!inRoomView() || !hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', e => {
  // 部分浏览器在拖出窗口边界时 dataTransfer.types 里不含 'Files'。
  // 以前这里提前 return，dragDepth 就永远减不回去，遮罩会一直盖住整个房间，
  // 用户只能刷新页面。dragleave 必须无条件递减。
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropMask.classList.remove('show');
});
window.addEventListener('drop', e => {
  if (!inRoomView()) return;
  e.preventDefault();
  dragDepth = 0;
  dropMask.classList.remove('show');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    addFiles(e.dataTransfer.files);
  }
});
// 粘贴截图：聊天里发图最顺手的入口就是 Ctrl+V
document.addEventListener('paste', e => {
  if (!inRoomView()) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  const imgs = [];
  for (const it of items) {
    if (it.kind === 'file' && /^image\//.test(it.type || '')) {
      const f = it.getAsFile();
      if (f) imgs.push(f);
    }
  }
  if (!imgs.length) return;      // 纯文本粘贴不动它，交给输入框
  e.preventDefault();
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  addFiles(imgs.map((f, i) => new File([f], '粘贴图片-' + stamp + (i ? '-' + i : '') + '.png',
                                        { type: f.type || 'image/png' })));
});
function autoGrow() {
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
}
textInput.addEventListener('input', autoGrow);
textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAll(); }
});

function itemState(it) {
  if (it.status === 'sending') {
    if (it.canceled) return '正在取消…';
    if (it.paused) return '已暂停 · ' + (it.pct || 0).toFixed(0) + '%';
    const parts = [(it.pct || 0).toFixed(0) + '%'];
    if (it.speed > 1024) parts.push(fmtSpeed(it.speed));
    return parts.join(' · ');
  }
  if (it.status === 'canceled') return '已取消';
  if (it.status === 'done') return '已发送';
  if (it.status === 'fail') return '失败' + (it.err ? '：' + it.err : '');
  return fmtSize(it.file.size);
}
const PQ_X = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.6 6.6l10.8 10.8M17.4 6.6 6.6 17.4"/></svg>';
const PQ_RETRY = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.2 12a7.2 7.2 0 1 1-2.1-5.1"/><path d="M19.6 4.4v4.3h-4.3"/></svg>';
const PQ_PAUSE = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="7" y="5.6" width="3.4" height="12.8" rx="1.1"/><rect x="13.6" y="5.6" width="3.4" height="12.8" rx="1.1"/></svg>';
const PQ_PLAY = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8.4 5.6c0-.8.9-1.3 1.6-.9l8.7 6.4c.6.4.6 1.4 0 1.8l-8.7 6.4c-.7.4-1.6-.1-1.6-.9z"/></svg>';
function itemHTML(it) {
  const sending = it.status === 'sending';
  const cls = sending ? (it.paused ? ' paused' : ' sending')
            : it.status === 'fail' ? ' err'
            : it.status === 'done' ? ' done' : '';
  const sCls = it.status === 'done' ? ' ok' : it.status === 'fail' ? ' err' : '';
  const ext = String(it.file.name || '').split('.').pop().toUpperCase().slice(0, 4) || 'FILE';
  const retry = it.status === 'fail'
    ? '<button class="pq-btn" title="重试" aria-label="重试" onclick="retryOne(\'' + it.uid + '\')">' + PQ_RETRY + '</button>' : '';
  // 暂停只有 P2P 发送才做得到：浏览器上传是一个 fetch，HTTP 没有“暂停一半”。
  // 那种情况只给取消，不摆一个按了没反应的暂停键。
  const pauseBtn = (sending && it.pausable)
    ? '<button class="pq-btn" data-pause title="' + (it.paused ? '继续发送' : '暂停发送') +
      '" aria-label="' + (it.paused ? '继续发送' : '暂停发送') +
      '" onclick="togglePause(\'' + it.uid + '\')">' + (it.paused ? PQ_PLAY : PQ_PAUSE) + '</button>'
    : '';
  const xTitle = sending ? (it.pausable ? '取消发送' : '上传中，无法中断') : '移除';
  return '<div class="pq-item' + cls + '" data-uid="' + it.uid + '">' +
      '<span class="pq-ico">' + esc(ext) + '</span>' +
      '<span class="pq-meta">' +
        '<span class="pq-name" title="' + esc(it.file.name) + '">' + esc(it.file.name) + '</span>' +
        '<span class="pq-state' + sCls + '">' + esc(itemState(it)) + '</span>' +
      '</span>' +
      retry + pauseBtn +
      '<button class="pq-btn" title="' + xTitle + '" aria-label="' + xTitle +
      '" onclick="cancelSend(\'' + it.uid + '\')">' + PQ_X + '</button>' +
      '<div class="pq-bar"><div class="pq-fill" style="width:' + (it.pct || 0) + '%"></div></div>' +
    '</div>';
}
function renderPending() {
  if (!pendingFiles.length) {
    pendingArea.classList.remove('show');
    pendingArea.innerHTML = '';
    return;
  }
  pendingArea.classList.add('show');
  const done = pendingFiles.filter(x => x.status === 'done').length;
  const left = pendingFiles.length - done;
  pendingArea.innerHTML =
    '<div class="pq-head"><span>待发送 <b>' + left + '</b> 个文件' +
      (done ? ' · 已完成 ' + done : '') + '</span>' +
      (done ? '<button onclick="clearDone()">清空已完成</button>' : '') + '</div>' +
    pendingFiles.map(itemHTML).join('');
}
function updateItemUI(it) {
  const el = pendingArea.querySelector('[data-uid="' + it.uid + '"]');
  if (!el) return;
  el.className = 'pq-item' + (it.status === 'sending'
    ? (it.paused ? ' paused' : ' sending')
    : it.status === 'fail' ? ' err' : '');
  const fill = el.querySelector('.pq-fill');
  if (fill) fill.style.width = (it.pct || 0) + '%';
  const st = el.querySelector('.pq-state');
  if (st) {
    st.textContent = itemState(it);
    st.className = 'pq-state' + (it.status === 'done' ? ' ok' : it.status === 'fail' ? ' err' : '');
  }
  // 暂停 / 继续图标按状态换，别为了换个图标整行重绘：每 90ms 一次的
  // 进度刷新里重建 DOM，会让正在看的进度条闪一下
  const pb = el.querySelector('[data-pause]');
  if (pb) {
    pb.innerHTML = it.paused ? PQ_PLAY : PQ_PAUSE;
    pb.title = it.paused ? '继续发送' : '暂停发送';
    pb.setAttribute('aria-label', pb.title);
  }
}
// 暂停 / 继续：只对 P2P 发送有效（分片循环每一片之间检查一次标志位）
function togglePause(uid) {
  const it = pendingFiles.find(x => x.uid === uid);
  if (!it || it.status !== 'sending' || !it.pausable) return;
  it.paused = !it.paused;
  updateItemUI(it);
}
// 取消 / 移除：发送中的先置标志位，真正的移除由发送循环做，
// 否则队列还在跑、行已经从界面上消失，后面会冒出一条“发送失败”的怪提示。
// 房主那条路是一次 HTTP 上传，浏览器不给“停下来再从中间续”的能力，
// 所以这里如实说明，不假装配一个按了没反应的按钮。
function cancelSend(uid) {
  const it = pendingFiles.find(x => x.uid === uid);
  if (!it) return;
  if (it.status === 'sending') {
    if (!it.pausable) { toast('本机上传不能中途打断，几秒后会自动完成'); return; }
    it.canceled = true;
    it.paused = false;              // 暂停中按取消：先解开等待，循环才看得到 canceled
    updateItemUI(it);
    return;
  }
  const i = pendingFiles.indexOf(it);
  if (i >= 0) pendingFiles.splice(i, 1);
  renderPending();
}
function removePending(uid) { cancelSend(uid); }
function clearDone() {
  pendingFiles = pendingFiles.filter(x => x.status !== 'done');
  renderPending();
}
function retryOne(uid) {
  const it = pendingFiles.find(x => x.uid === uid);
  if (!it || it.status === 'sending') return;
  it.status = 'wait'; it.err = ''; it.pct = 0; it.speed = 0;
  it.canceled = false; it.paused = false;   // 重试就是重新来一遍
  updateItemUI(it);
  sendAll();
}
function fmtSize(n) {
  if (n<1024) return n+' B';
  if (n<1048576) return (n/1024).toFixed(1)+' KB';
  if (n<1073741824) return (n/1048576).toFixed(1)+' MB';
  return (n/1073741824).toFixed(1)+' GB';
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function toast(m) {
  const s = String(m == null ? '' : m);
  const t=document.getElementById('toast'); t.textContent=s; t.classList.add('show');
  // 长句（比如「为什么不能传文件」）1.8 秒读不完，按字数给时间，上限 6.5 秒
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.remove('show'),
                        Math.max(1800, Math.min(6500, s.length * 110)));
}

// 窄屏：通道卡片默认收起，点标题行展开
// 手机上一屏就那么大，房间号永远要看得见（别人靠它加入），
// 地址 / 复制按钮 / 二维码这些「偶尔用一次」的点一下再出来。
document.querySelectorAll('#lanBanner .p2p-line, #p2pBanner .p2p-line').forEach(el => {
  el.addEventListener('click', () => {
    if (window.innerWidth > 640) return;
    const box = el.parentNode;
    if (box) box.classList.toggle('open');
  });
});

