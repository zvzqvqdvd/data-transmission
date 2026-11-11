// ===== gate.js — 首页 / 入口页逻辑 =====
// 加入前的 P2P 探活、创建房间、加入房间、刷新恢复、房间码验证、
// 入口页视图切换与页面启动分发（最后一段会立即执行）。
// build_page() 把它拼在 app.js / room.js 之后，共用同一个作用域。

// ===== 加入房间前的探活：房主真的把名字分配下来才放行进入主页面 =====
// 光「数据通道打开」不算：房主那边可能还没登记、或者页面正在关闭。
// 探活自己发 HELLO，等到 WELCOME 才算进得去。
function probeRoom(room, timeoutMs) {
  return new Promise(resolve => {
    let done = false, peer = null, conn = null, timer = null, guestName = '';
    let fallbackTimer = null, freshTried = false;
    const pending = [];      // 探活期间收到的消息（主要是房间历史），进房后补处理
    const finish = (okFlag, msg, tip) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (!okFlag) {
        try { if (conn) conn.close(); } catch (e) {}
        try { if (peer) peer.destroy(); } catch (e) {}
      }
      resolve({ ok: okFlag, msg: msg || '', tip: tip || '',
                peer: peer, conn: conn, name: guestName, pending: pending });
    };
    // 呼叫房主：这一步才是真正的 P2P 握手
    const call = () => {
      if (done || !peer || peer.destroyed) return;
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      conn = peer.connect('pc-' + room, { reliable: true, metadata: identityMeta() });
      conn.on('open', () => {
        try { conn.send('HELLO:' + PROTOCOL + ':' + myNick() + ':' + devId()); } catch (e) {}
      });
      conn.on('data', d => {
        if (done) return;                        // 进了房间之后由 wireGuestConn 接管
        if (typeof d !== 'string') return;      // 探活期间不会有文件过来
        if (d.startsWith('WELCOME:')) {
          try { guestName = (JSON.parse(d.slice(8)) || {}).name || ''; } catch (e) {}
          finish(true);
          return;
        }
        if (pending.length < 300) pending.push(d);
      });
      conn.on('close', () => finish(false, '房间那边没有回应',
        '房主的页面可能已经关闭，请确认对方还在房间里再试一次。'));
      conn.on('error', e => finish(false, '数据通道错误', String(e && e.message ? e.message : e)));
    };
    const attach = pp => {
      peer = pp;
      pp.on('error', err => {
        if (done) return;
        const t = (err && err.type) || 'unknown';
        if (t === 'peer-unavailable') {
          finish(false, '房间不存在', '这个房间码没有对应的房间，请确认对方已经点「创建房间」并且页面保持打开。');
        } else if (t === 'network' || t === 'server-error' || t === 'socket-error') {
          finish(false, '网络不通', '连不上信令服务器，换个网络或改用系统浏览器再试。');
        } else if (t === 'unavailable-id') {
          finish(false, '连接被占用', '请稍后重试。');
        } else if (!freshTried && !pp.open) {
          // 预热的那条长连接已经废了（放太久、切了网络）：换一条新的，别直接判失败
          freshTried = true;
          try { pp.destroy(); } catch (e) {}
          fresh();
        } else {
          finish(false, '连接失败', '错误类型：' + t + '，请确认房间码正确。');
        }
      });
      if (pp.open) call();
      else pp.on('open', () => { if (!done) call(); });
    };
    const fresh = () => {
      freshTried = true;
      try { attach(new Peer(guestPeerId(), peerOpts())); }
      catch (e) { finish(false, '无法发起连接：' + (e && e.message ? e.message : e)); }
    };
    timer = setTimeout(() => finish(false, '连接超时',
      '没有收到对方响应，可能是房间码不正确，或对方设备网络受限。'), timeoutMs || 12000);
    // 入口页预热好的信令连接能直接用：跳过 WebSocket 握手，少等 0.3～1.5 秒
    const warm = takeWarmPeer();
    if (warm) {
      attach(warm);
      if (!warm.open) {
        // 预热的那条还在握手（公共信令服务器在部分网络下要好几秒，属于正常）：
        // 就等它，别重开——重开等于把已经走了大半的握手推倒重来。
        // 只有明显卡死（超过正常握手时间一倍）才换新的，4.5 秒足够分辨。
        fallbackTimer = setTimeout(() => {
          if (done || warm.open) return;
          try { warm.destroy(); } catch (e) {}
          if (peer === warm) fresh();
        }, 4500);
      }
    } else {
      fresh();
    }
  });
}

// ===== 入口页：创建房间 / 加入房间 =====
function gateMsg(text, kind) {
  const el = document.getElementById('gateMsg');
  el.className = kind || 'err';
  el.textContent = text;
}
function gateClearMsg() {
  const el = document.getElementById('gateMsg');
  el.className = '';
  el.textContent = '';
  gateFixShow(false);
}
// 本机程序没在跑时的补救引导：下载程序 / 启动好了再试一次。
// 只在「程序不在」这类错误上出现——房间已满、网络问题给下载链接也是误导。
// 引导出来时把页脚那行常驻下载入口收掉，屏幕上只留一个下载按钮。
function gateFixShow(on) {
  const box = document.getElementById('gateFix');
  if (box) box.style.display = on ? 'block' : 'none';
  const line = document.querySelector('.gate-dl-line');
  if (line) line.style.display = on ? 'none' : '';
}
// ===== 程序下载地址 =====
// 页面和 exe 都躺在同一个仓库（GitHub Pages）里，所以下载地址直接跟着
// 在线页基地址走：换自定义域名时页面里的链接自动跟着换，不用改 HTML。
const EXE_FILE = '数据传输.exe';
const DL_FALLBACK_BASE = 'https://zvzqvqdvd.github.io/data-transmission/';
function downloadUrl() {
  let base = '';
  try { base = inviteBase() || ''; } catch (e) {}
  if (!base) base = DL_FALLBACK_BASE;
  return base.replace(/\/*$/, '/') + encodeURIComponent(EXE_FILE);
}
function syncDownloadLinks() {
  const url = downloadUrl();
  document.querySelectorAll('a.js-dl').forEach(a => { a.href = url; });
}
function showGate() {
  document.getElementById('gateView').classList.add('show');
  document.getElementById('hostView').style.display = 'none';
  syncDownloadLinks();           // 下载地址跟着当前基地址走（换域名后自动生效）
}
function hideGate() {
  document.getElementById('gateView').classList.remove('show');
  document.getElementById('hostView').style.display = 'flex';
}
// ===== 刷新回连：本标签页成功加入过的房间记在 sessionStorage（随标签页，关页即清） =====
// 只解决「刷新要重输房间码」：关掉页面重开、换浏览器仍然要手动输码；
// 正常退出房间（断开 / 被请出 / 房间销毁 / 房间码作废）时会清掉，不会偷偷连回旧房间。
function savedJoinRoom() {
  try {
    return String(sessionStorage.getItem('lanshare_session_room') || '')
      .toUpperCase().replace(/[^A-Z2-9]/g, '');
  } catch (e) { return ''; }
}
function rememberJoinRoom(room) {
  try { sessionStorage.setItem('lanshare_session_room', room); } catch (e) {}
}
function forgetJoinRoom() {
  try { sessionStorage.removeItem('lanshare_session_room'); } catch (e) {}
}
// ===== 免责声明：内嵌在入口页下方，文本展示 + 复选框（默认勾选），不弹窗 =====
// 复选框勾着 → 点创建/加入直接继续；没勾 → 展开声明区并提示先勾选。
// 房间内的新建 / 销毁房间不涉及声明。
let agreeAccepted = false;       // 本次页面内同意过至少一次（与复选框状态保持一致）
// 复选框当前是否勾着（页面刷新后恢复默认勾选）
function agreeChecked() {
  const chk = document.getElementById('agreeCheck');
  return !!(chk && chk.checked);
}
// 没勾选就想继续：滚动到复选框，toast 提示
function agreeHintFlash() {
  const sec = document.getElementById('gateDisc');
  if (sec) {
    try { sec.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch (e) { try { sec.scrollIntoView(); } catch (e2) {} }
  }
  toast('请先勾选「我已阅读并同意《免责声明》并同意继续使用」');
}
// 点「《免责声明》」整页打开独立声明页
function openDiscPage(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }   // 别触发复选框
  document.getElementById('discPage').classList.add('show');
}
function closeDiscPage(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  document.getElementById('discPage').classList.remove('show');
}
// 统一入口：勾选了直接继续，没勾选就提示
function agreeThen(fn) {
  if (agreeChecked()) { agreeAccepted = true; fn(); return; }
  agreeHintFlash();
}
function gateShowJoin() {
  document.getElementById('gateChoices').style.display = 'none';
  document.getElementById('gateJoin').style.display = 'block';
  gateClearMsg();
  // 若上一条预热连接失败过，趁用户输码再补一条，别让「加入」时从零握手
  prewarmSignal();
  const box = document.getElementById('gateRoom');
  setTimeout(() => box.focus(), 60);
}
function gateShowChoices() {
  if (JOIN_REQUIRED) return;      // 局域网设备只能加入，没有「创建房间」可选
  const joinBtn = document.getElementById('gateJoinChoiceBtn');
  if (joinBtn) joinBtn.style.display = '';
  document.getElementById('gateChoices').style.display = 'flex';
  document.getElementById('gateJoin').style.display = 'none';
  gateClearMsg();
}
// 本机打开页面、程序里还没有房间：只留「创建房间」这一步
function showHostGate() {
  showGate();
  document.getElementById('gateChoices').style.display = 'flex';
  document.getElementById('gateJoin').style.display = 'none';
  // 本机就是房主，「加入房间」没有意义，藏起来免得点进去连自己
  const joinBtn = document.getElementById('gateJoinChoiceBtn');
  if (joinBtn) joinBtn.style.display = 'none';
  const title = document.querySelector('.gate-title');
  if (title) title.textContent = '数据传输';
  const sub = document.querySelector('.gate-sub');
  if (sub) sub.textContent = '点「创建房间」开一个房间，别人用房间码加入';
  const foot = document.querySelector('.gate-foot');
  if (foot) foot.innerHTML = '房间是临时的：关掉房主页面或 12 小时无通信就会自动销毁<br>销毁时聊天记录与接收文件一并删除';
  gateClearMsg();
}
// 局域网设备打开页面：只留「输入房间码」这一步
function showLanGate() {
  showGate();
  document.getElementById('gateChoices').style.display = 'none';
  document.getElementById('gateJoin').style.display = 'block';
  const title = document.querySelector('.gate-title');
  if (title) title.textContent = '加入房间';
  const sub = document.querySelector('.gate-sub');
  if (sub) sub.textContent = '输入房主给你的房间码，就能加入这个房间';
  const foot = document.querySelector('.gate-foot');
  if (foot) foot.innerHTML = '房间码显示在房主那台设备的房间栏里<br>同一个网络下输入房间码即可加入';
  const back = document.querySelector('.gate-back');
  if (back) back.style.display = 'none';
  gateClearMsg();
  const box = document.getElementById('gateRoom');
  // 扫的是局域网二维码：链接里已经带着房间码，填好并自动加入，不用手输
  let scanned = '';
  try {
    scanned = (new URLSearchParams(location.search).get('room') || '')
      .toUpperCase().replace(/[^A-Z2-9]/g, '');
  } catch (e) {}
  if (scanned.length >= 4) {
    box.value = scanned;
    gateMsg('正在加入房间 ' + scanned + '…', 'info');
    // 扫码进入：复选框默认勾选 = 已同意，直接静默连；没勾选会在 gateJoin 里提示
    setTimeout(() => { try { gateJoin(); } catch (e) {} }, 60);
  } else {
    // 刷新回连：这个标签页之前加入过房间（sessionStorage 还记着），自动重连，
    // 不用重输房间码；连不上会停在输码页且码已填好，按「连接」即可重试
    const saved = savedJoinRoom();
    if (saved.length >= 4) {
      box.value = saved;
      gateMsg('正在重新加入房间 ' + saved + '…', 'info');
      setTimeout(() => { try { gateJoin(); } catch (e) {} }, 60);
    } else {
      setTimeout(() => { try { box.focus(); box.select(); } catch (e) {} }, 80);
    }
  }
}
// 在线页当房主后刷新：先问本机程序房间还在不在。
// 以前这里直接 gateCreate()，房间已经销毁时会偷偷开一个新房间又回到主页面，
// 用户根本看不到「房间已结束」的起始页；房间还在时也会白白换一次房间码。
async function resumeHostFromWeb() {
  let info;
  try {
    info = await fetchHostInfo();
  } catch (e) {
    try { history.replaceState(null, '', location.pathname); } catch (e2) {}
    gateShowChoices();
    gateMsg('没有检测到本机程序，点下面的「下载 Windows 程序」装好后再创建；已经装了就双击运行它。', 'err');
    gateFixShow(true);          // 顺手把「下载程序 / 已启动重试」摆出来
    return;
  }
  if (info.client_url) applyClientUrl(info.client_url);
  if (!info.has_room || !info.room) {
    try { history.replaceState(null, '', location.pathname); } catch (e2) {}
    gateShowChoices();
    gateMsg('房间已经结束，点「创建房间」开一个新房间。', 'info');
    return;
  }
  // 房间还在：用现有房间码直接回主界面，不重新 create（否则会换码）。
  // 刷新同样先在入口页把房主 Peer 等就绪，避免恢复后卡片上又挂「正在连接信令服务器…」。
  ROOM = info.room;
  API = HOST_API;
  gateMsg('正在恢复房间…', 'info');
  await prepareHostPeer(ROOM, 9000);
  hideGate();
  startHostUI(true, info.ip ? ('http://' + info.ip + ':' + info.port) : '');
}
// ===== 创建房间进度：只画在「正在创建房间…」按钮里 =====
// 阶段：检查本机程序 → 创建房间 → 注册外网直连（本机没开外网通道时只两步）。
// 百分比是阶段进度而不是耗时估算：等 PeerJS open 期间慢慢爬到 92%，
// open 一到立刻补到 100% 再进房；不再用 gateMsg 那条黄色横条写「等待连接就绪」。
let gateSteps = [];
let gateProgPct = 0;
let gateProgTimer = null;
function gateProgReset(steps) {
  if (gateProgTimer) { clearInterval(gateProgTimer); gateProgTimer = null; }
  gateSteps = steps || [];
  gateProgPct = 0;
  gateProgress(-1, 0);
}
function gateProgress(active, pct, allDone) {
  const text = document.getElementById('gateProgText');
  const pctEl = document.getElementById('gateProgPct');
  const fill = document.getElementById('gateProgFill');
  if (!text || !pctEl || !fill) return;
  gateProgPct = Math.max(gateProgPct, Math.min(100, pct || 0));
  text.innerHTML = gateSteps.map((s, i) => {
    const state = allDone || i < active ? 'done' : (i === active ? 'now' : 'wait');
    const mark = state === 'done' ? '✓' : (state === 'now' ? '›' : '·');
    return '<span class="gp-' + state + '">' + mark + ' ' + esc(s) + '</span>';
  }).join('<span class="gp-sep">·</span>');
  pctEl.textContent = gateProgPct + '%';
  fill.style.width = gateProgPct + '%';
  const bar = document.getElementById('gateProgBar');
  if (bar) bar.setAttribute('aria-valuenow', String(gateProgPct));
}
// 等信令 open 的这一两秒别让进度条看着像卡死：缓慢爬到上限，open 后由 gateProgress 补满
function gateProgCreep(to) {
  if (gateProgTimer) clearInterval(gateProgTimer);
  gateProgTimer = setInterval(() => {
    if (gateProgPct >= to) { clearInterval(gateProgTimer); gateProgTimer = null; return; }
    gateProgPct++;
    const pctEl = document.getElementById('gateProgPct');
    const fill = document.getElementById('gateProgFill');
    if (pctEl) pctEl.textContent = gateProgPct + '%';
    if (fill) fill.style.width = gateProgPct + '%';
  }, 130);
}

// 创建房间：确认本机程序在跑，再由它当场开一个房间（房间码在这一刻才生成）。
// 不再人为拖时间：后端开好 + 外网直连房主 Peer 注册成功就立刻进主界面。
async function gateCreate() {
  if (!agreeChecked()) { agreeHintFlash(); return; }
  const btn = document.getElementById('gateCreateBtn');
  if (!btn || btn.disabled) return;
  const label = btn.querySelector('.gate-txt b');
  const sub = btn.querySelector('.gate-txt > i');
  btn.disabled = true;
  btn.classList.add('busy');
  if (label) label.textContent = '正在创建房间…';
  gateClearMsg();
  // 本机页面开了外网直连、或在线页要当房主，都要等房主 Peer 在信令注册成功
  const needP2P = P2P_ENABLED || SEED_MODE !== 'host';
  gateProgReset(needP2P
    ? ['检查本机程序', '创建房间', '连接外网通道']
    : ['检查本机程序', '创建房间']);
  gateProgress(0, 8);
  try {
    // 检查本机程序 + 开房间并行发出：两次都是本机请求，串行纯属白等；
    // 程序没开时两个请求一起失败，直接给出同一条提示
    let info, r;
    try {
      [info, r] = await Promise.all([
        fetchHostInfo(),
        fetch(HOST_API + '/api/room/create', { method: 'POST' }),
      ]);
    } catch (e) {
      throw new Error('没有检测到本机程序。还没装就点下面「下载 Windows 程序」；装好了直接双击运行，看到「服务已启动」再回来点「创建房间」。');
    }
    // 邀请链接以本机程序当前的 client_url.txt 为准（在线页那份是导出时的旧值）
    applyClientUrl(info.client_url);
    const j = await r.json();
    if (!j || !j.ok || !j.room) throw new Error((j && j.msg) || '创建房间失败');
    ROOM = j.room;
    API = HOST_API;
    // 房间完全就绪 = 后端开好房间 + 外网直连的房主 Peer 已经在信令服务器上注册成功。
    // 只等这个真实条件，不再人为拖时间：信令快就快进，慢就老实等在入口页。
    // 信令实在连不上（超时 9 秒）也不能把人卡在入口页，届时仍进房，局域网可正常使用。
    gateProgress(needP2P ? 2 : 1, needP2P ? 68 : 80);
    if (needP2P) {
      gateProgCreep(92);
      await prepareHostPeer(ROOM, 9000);
    }
    if (gateProgTimer) { clearInterval(gateProgTimer); gateProgTimer = null; }
    gateProgress(gateSteps.length, 100, true);
    hideGate();
    if (SEED_MODE !== 'host') {
      try { history.replaceState(null, '', '?host=1'); } catch (e) {}
    }
    // 顺手把局域网地址一起带进主界面：同 WiFi 的设备和本机同网段时更快
    // 本机页面（8000）不算「在线页」，否则会把齿轮和管理入口一起藏掉
    startHostUI(SEED_MODE !== 'host', info.ip ? ('http://' + info.ip + ':' + info.port) : '');
    if (typeof info.peers === 'number') { lanPeers = info.peers; refreshReady(); renderAll(); }
    startHostHeartbeat();
  } catch (e) {
    const m = (e && e.message) || '创建房间失败，请稍后再试。';
    gateMsg(m, 'err');
    // 程序没开（或本机服务没起来）：直接把「下载 / 已启动重试」摆出来，
    // 用户不用自己去猜去哪里装
    gateFixShow(m.indexOf('没有检测到本机程序') >= 0);
    gateProgReset([]);          // 清掉进度，下次创建重新从 0 开始
  } finally {
    // 失败要退回来能再点；成功时页面已经切走了，恢复也不影响
    btn.disabled = false;
    btn.classList.remove('busy');
    if (label) label.textContent = '创建房间';
    if (sub) sub.textContent = '在本机开一个房间';
  }
}
// 加入房间：先真连一次，房间不存在或连不上就停在入口页。
// 复选框没勾（非默认状态）时点连接：展开声明区并提示，不往下走。
async function gateJoin() {
  if (!agreeChecked()) { agreeHintFlash(); return; }
  const box = document.getElementById('gateRoom');
  const btn = document.getElementById('gateJoinBtn');
  const label = btn.querySelector('b');
  const room = box.value.trim().toUpperCase().replace(/[^A-Z2-9]/g, '');
  if (room.length < 4) { gateMsg('房间码不正确，请检查后重输。'); box.focus(); return; }
  if (btn.disabled) return;
  btn.disabled = true;

  // 局域网设备：不建 P2P，只向这台电脑确认房间码，对了就进房间（走 HTTP）
  if (JOIN_REQUIRED || isLanClient) {
    if (label) label.textContent = '验证中…';
    gateMsg('正在验证房间码…', 'info');
    const res = await verifyRoomCode(room);
    btn.disabled = false;
    if (label) label.textContent = '连接';
    if (!res.ok) {
      gateMsg(res.msg, 'err');
      box.focus();
      try { box.select(); } catch (e) {}
      return;
    }
    gateClearMsg();
    rememberJoinRoom(room);   // 记住本标签页的房间：刷新后自动回连，不用重输码
    hideGate();
    // 二维码带的 ?room= 已经用掉了，清掉地址避免刷新又自动提交一次；
    // 回连靠 sessionStorage，不再依赖地址栏参数
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    startHostUI(false, '', true);
    return;
  }

  if (label) label.textContent = '连接中…';
  gateMsg('正在连接房间 ' + room + '，请稍候…', 'info');
  const res = await probeRoom(room, 12000);
  btn.disabled = false;
  if (label) label.textContent = '连接';
  if (!res.ok) {
    // 不跳转：留在入口页，明确告诉用户失败原因
    gateMsg(res.msg + (res.tip ? '：' + res.tip : ''), 'err');
    box.focus();
    try { box.select(); } catch (e) {}
    prewarmSignal();      // 这次的信令连接已经销毁了，先建好下一条，重试时不用再等
    return;
  }
  gateClearMsg();
  hideGate();
  initGuest(room, { peer: res.peer, conn: res.conn, name: res.name, pending: res.pending });
}
// 局域网设备验证房间码：由本机程序判定，浏览器只负责提交
async function verifyRoomCode(room) {
  try {
    const r = await fetch(API + '/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'room=' + encodeURIComponent(room)
    });
    const d = await r.json();
    if (d && d.ok) return { ok: true };
    return { ok: false, msg: (d && d.msg) || '房间码不正确，请向房主确认' };
  } catch (e) {
    return { ok: false, msg: '连不上这台电脑上的程序，请确认它还开着，并确认你们在同一个网络。' };
  }
}
document.getElementById('gateRoom').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); gateJoin(); }
});

if (MODE === 'host') {
  // 局域网里其他设备打开：先输房间码，不能打开网页就直接看到聊天内容
  if (JOIN_REQUIRED) showLanGate();
  // 本机：程序刚开，还没有房间——停在入口页，点了「创建房间」才开房
  else if (!HAS_ROOM) showHostGate();
  // startHostUI 里已经 loadMessages + 起轮询，这里不再重复（否则每 2 秒发两次请求）
  else initHost();
} else {
  showGate();
  // 房间号不再缓存（16:43 定稿）：旧版本遗留的键一并清掉，省得老用户浏览器里留死数据
  try { localStorage.removeItem('lanshare_last_room'); localStorage.removeItem('lanshare_room_code'); } catch (e) {}
  // 在线页所有入口都先预热信令：邀请链接、恢复上次房间、手动输码都用得上。
  // 以前只有「停在入口页」那一个分支预热，邀请链接进来反而要等完整一轮握手。
  prewarmSignal();
  const q = new URLSearchParams(location.search);
  const clean = s => String(s || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
  const invited = clean(q.get('room'));
  if (invited) {
    // 邀请链接：按访客身份连过去。复选框默认勾选 = 已同意，直接进；
    // 被手动取消勾选过就停在入口页提示
    const goInvite = () => { hideGate(); initGuest(invited); };
    if (agreeChecked()) { agreeAccepted = true; goInvite(); }
    else agreeHintFlash();
  } else if (q.get('host') === '1') {
    // 在线页房主刷新：先确认房间还在，别一刷新就偷偷开个新房间
    resumeHostFromWeb();
  } else {
    // 刷新回连：这个标签页之前加入过房间（sessionStorage 记着），自动重连，
    // 不用重输房间码——和扫码进来一样无感。房间没了会停在输码页且码已填好。
    const saved = savedJoinRoom();
    if (saved.length >= 4) {
      gateShowJoin();
      document.getElementById('gateRoom').value = saved;
      gateMsg('正在重新加入房间 ' + saved + '…', 'info');
      setTimeout(() => { try { gateJoin(); } catch (e) {} }, 60);
    }
    // 没有记录就停在入口页等手动输码（用户 16:43 定稿：不在浏览器里留死数据，
    // sessionStorage 随标签页关闭自动清空）；预热已经在上面建好了，
    // 用户输码的这几秒正好用来握手（省 0.3～1.5 秒）。
  }
}
// 网络恢复 / 手机解锁回到前台：退避定时器还没走完也立刻再试一次，
// 不用干等好几秒才恢复聊天。flushGuestRetry 自带房主/访客与连接状态守卫。
window.addEventListener('online', () => { try { flushGuestRetry(); } catch (e) {} });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { try { flushGuestRetry(); } catch (e) {} }
});

// 房间生命周期：临时房间（页面关闭 / 12 小时无通信 / 手动销毁），没有可设的选项了
