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
// 提示和底部那一栏叠在同一格里：只切 visibility，不切 display。
// 隐藏的那块照样撑格子，所以出提示、清提示，卡片高度一分都不动。
function gateMsg(text, kind) {
  const el = document.getElementById('gateMsg');
  const foot = document.querySelector('.gate-foot');
  el.className = kind || 'err';
  el.textContent = text;
  // 同格叠着：提示上来，说明就藏起来，免得浅红底色压不干净两层字
  if (foot) foot.classList.add('hide');
}
function gateClearMsg() {
  const el = document.getElementById('gateMsg');
  const foot = document.querySelector('.gate-foot');
  el.className = '';
  el.textContent = '';
  if (foot) foot.classList.remove('hide');
}
// 只换底部两行的字，不动结构 —— 仓库链接挂在第二行末尾，整块 innerHTML 重写会把它冲掉
function setFoot(a, b) {
  const fa = document.querySelector('.gate-foot .gf-a');
  const fb = document.querySelector('.gate-foot .gf-b');
  if (fa && a != null) fa.textContent = a;
  if (fb && b != null) fb.textContent = b;
}
// ===== 卡片内视图切换 =====
// 三块视图用 grid 叠在同一格里，只改 .on（= visibility），不改 display：
// 隐藏的那块照样撑高度，所以换来换去卡片的长宽都不变。
const GATE_VIEWS = ['gateChoices', 'gateJoin', 'gateDl'];
function gateView(id) {
  for (let i = 0; i < GATE_VIEWS.length; i++) {
    const el = document.getElementById(GATE_VIEWS[i]);
    if (el) el.classList.toggle('on', GATE_VIEWS[i] === id);
  }
}
// ===== 创建房间失败：卡片内切到「下载程序」视图 =====
// 和「加入房间」一样的方式：换标题、换卡片中间那块内容、底栏给「返回」。
// 不弹窗、不遮挡页面。下载按钮自己就是进度条：fetch 流式缓存到 Blob，
// 进度实时写在按钮上，缓存满 100% 再落盘（浏览器直接存进「下载」文件夹）。
// 三行提示都压在 2 行内（每行 ≤20 字）：行数一变，卡片高度就会变
// 缓存进度、完成、降级都写在按钮本身上，按钮下面不再挂说明行
let DL_SIZE = 0;                // HEAD 探到的真实字节数；0 = 还不知道（绝不写死大小）

function dlmEl(id) { return document.getElementById(id); }
function fmtMB(n) {
  if (!n) return '0 MB';
  return (n / 1048576).toFixed(1) + ' MB';
}
// 徽标只换字、不动宽度（min-width 写死）：探测中「…」→ 真实大小，
// 按钮里的文字位置一点都不会挪。拿不到大小时整块藏起来，白占的宽度照样留着。
function dlmSizeText(t) {
  const em = dlmEl('dlmSize');
  if (!em) return;
  em.textContent = t || '';
  em.style.visibility = t ? '' : 'hidden';
}
// 程序体积跟着文件走：打开这一屏先 HEAD 一次拿 Content-Length，换成真值。
// 拿不到（跨域被拦 / 断网）就把徽标藏起来，宁可空着也不显示一个会过期的数字。
//
// 这是异步的，可能比下载本身还慢（跨域 HEAD 要绕一圈）。它回来时用户可能已经
// 下完、按钮正写着「完成」——那时候绝不能拿旧大小把结果盖掉，否则看起来像
// 又变回了未下载。所以只在真正闲着的状态下才写徽标。
function dlmIdle() { return !DLM.busy && !DLM.done && !DLM.paused; }
async function dlmProbeSize() {
  const em = dlmEl('dlmSize');
  if (!em) return;
  if (DL_SIZE) { if (dlmIdle()) dlmSizeText(fmtMB(DL_SIZE)); return; }
  if (dlmIdle()) dlmSizeText('…');
  try {
    const r = await apiFetch(downloadUrl(), { method: 'HEAD', cache: 'no-store' });
    const n = parseInt(r.headers.get('content-length') || '0', 10) || 0;
    if (n > 0) { DL_SIZE = n; if (dlmIdle()) dlmSizeText(fmtMB(n)); return; }
  } catch (e) {}
  if (dlmIdle()) dlmSizeText('');
}
// 进入下载视图前先记住卡片头部，返回时原样还回去（下载视图会换标题与页脚）
let GATE_HDR = null;
function gateSaveHdr() {
  if (GATE_HDR) return;
  const t = document.querySelector('.gate-title');
  const s = document.querySelector('.gate-sub');
  const f = document.querySelector('.gate-foot');
  GATE_HDR = {
    t: t ? t.textContent : '',
    s: s ? s.textContent : '',
    f: f ? f.innerHTML : '',
    c: f ? f.className : ''
  };
}
function gateRestoreHdr() {
  if (!GATE_HDR) return;
  const t = document.querySelector('.gate-title');
  const s = document.querySelector('.gate-sub');
  const f = document.querySelector('.gate-foot');
  if (t) t.textContent = GATE_HDR.t;
  if (s) s.textContent = GATE_HDR.s;
  if (f) { f.innerHTML = GATE_HDR.f; f.className = GATE_HDR.c; }
  GATE_HDR = null;
}
// 切到「本机程序不在」这一屏：和 gateShowJoin() 同一个套路
function gateShowDl() {
  if (JOIN_REQUIRED) { gateMsg('这个页面只能加入房间，创建房间请在本机双击运行「数据传输.exe」。', 'info'); return; }
  gateSaveHdr();
  const t = document.querySelector('.gate-title');
  const s = document.querySelector('.gate-sub');
  if (t) t.textContent = '创建房间需要本机程序';
  if (s) s.textContent = '在这台电脑上运行「数据传输.exe」';
  // 底部第一行换成「装好回来点重新创建」：只换字、不删行
  setFoot('程序装好后回来点「重新创建」', null);
  gateView('gateDl');
  gateClearMsg();
  dlmReset();
  dlmProbeSize();
}
// ===== 这一屏的下载状态 =====
// 大按钮本身就是进度条：下载中可点 → 暂停，暂停后可点 → 继续。
// 已收到的分片留在 DLM.chunks 里，继续时带 `Range: bytes=N-` 从断点接着要，
// 9 MB 在慢网上从头再下一遍差别很大。服务器不认 Range（回 200 全量）时自动从零重下。
const DLM = { chunks: [], got: 0, total: 0, busy: false, paused: false, done: false,
              ctl: null, blob: null, savedAt: 0 };

// 离开下载视图 / 关闭页面时，把还在跑的缓存请求停掉
function dlmAbort() {
  if (DLM.ctl) { try { DLM.ctl.abort(); } catch (e) {} DLM.ctl = null; }
  DLM.busy = false;
}
function dlmHide() {
  dlmAbort();
  gateRestoreHdr();
  // 下到一半先留着：回到这一屏点按钮能接着下，不白扔已收到的几 MB
  DLM.paused = DLM.got > 0 && !DLM.done;
  dlmPaint(DLM.got, DLM.total);
  dlmApplyState(DLM.done ? 'done' : (DLM.paused ? 'paused' : 'idle'));
}
// 按钮四态：idle / busy / paused / done。任何时候都可点，
// 由 dlmStart 按当前状态决定这一下是「开始」「暂停」还是「继续」。
function dlmApplyState(state) {
  const btn = dlmEl('dlmBtn'), txt = dlmEl('dlmBtnText');
  if (!btn) return;
  btn.className = 'gdl-main' + (state === 'idle' ? '' : ' ' + state);
  btn.disabled = false;
  btn.setAttribute('data-dl', state);
  if (!txt) return;
  const shown = DLM.total ? (fmtMB(DLM.got) + ' / ' + fmtMB(DLM.total)) : fmtMB(DLM.got);
  if (state === 'busy') {
    txt.textContent = '暂停 · ' + shown;
    btn.title = '点击暂停';
  } else if (state === 'paused') {
    txt.textContent = '继续 · ' + shown;
    btn.title = '点击继续下载';
  } else if (state === 'done') {
    txt.textContent = '已保存 ' + fmtMB(DLM.got);
    btn.title = '已下载完成';
  } else {
    txt.textContent = DLM.got > 0 ? '继续下载' : '下载 Windows 程序';
    btn.title = '下载 Windows 程序';
  }
}
// 进度：只画填充条和百分比，文字归 dlmApplyState 管
function dlmPaint(got, total) {
  const fill = dlmEl('dlmFill');
  const pct = total ? Math.min(100, Math.round(got / total * 100)) : 0;
  if (fill) fill.style.width = (total ? pct : 0) + '%';
  dlmSizeText(total ? (pct + '%') : '…');
}
// 回到「还没开始下载」的样子（进度、文案、按钮配色一起复位）
function dlmReset() {
  DLM.busy = false;
  DLM.paused = DLM.got > 0 && !DLM.done;
  dlmPaint(DLM.got, DLM.total);
  dlmApplyState(DLM.done ? 'done' : (DLM.paused ? 'paused' : 'idle'));
  if (DLM.done) dlmSizeText('完成');
  else if (!DLM.got) dlmSizeText(DL_SIZE ? fmtMB(DL_SIZE) : '…');
}
// 按钮被点：下完了就再存一份（不用再走网络）；正在下就暂停；其余情况开始 / 继续
function dlmStart() {
  if (DLM.done) {
    // 已经缓存好了：再点一次是把手里这份 Blob 重新交给浏览器，
    // 而不是重新下载 —— 重下 9 MB 只为再存一次毫无意义。
    if (!DLM.blob) return;
    const now = Date.now();
    if (now - DLM.savedAt < 1200) return;    // 手抖连点只算一次，别存出一堆副本
    DLM.savedAt = now;
    dlmSave(DLM.blob, EXE_FILE);
    return;
  }
  if (DLM.busy) {
    DLM.busy = false;
    DLM.paused = true;
    if (DLM.ctl) { try { DLM.ctl.abort(); } catch (e) {} DLM.ctl = null; }
    dlmApplyState('paused');
    return;
  }
  DLM.busy = true;
  DLM.paused = false;
  dlmApplyState('busy');
  dlmPump();
}
async function dlmPump() {
  const url = downloadUrl();
  const ctl = new AbortController();
  DLM.ctl = ctl;
  const headers = {};
  // 断点续传：已经收过的不再要，后端与 Pages 都认 Range，会回 206
  if (DLM.got > 0) headers['Range'] = 'bytes=' + DLM.got + '-';
  try {
    const resp = await apiFetch(url, { signal: ctl.signal, headers: headers, cache: 'no-store' });
    if (resp.status === 416) { dlmFinish(); return; }        // 断点已在末尾：其实收全了
    if (!resp.ok && resp.status !== 206) throw new Error('HTTP ' + resp.status);
    if (!resp.body || !resp.body.getReader) throw new Error('no-stream');
    // 服务器忽略了 Range（回 200 全量）：已收的分片作废，从头算
    if (DLM.got > 0 && resp.status !== 206) { DLM.chunks = []; DLM.got = 0; }
    const len = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
    if (len > 0) { DLM.total = DLM.got + len; DL_SIZE = DLM.total; }
    const reader = resp.body.getReader();
    let lastT = Date.now(), lastGot = DLM.got, speed = 0, lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      DLM.chunks.push(value);
      DLM.got += value.length;
      const now = Date.now();
      if (now - lastT >= 300) {
        speed = (DLM.got - lastGot) / ((now - lastT) / 1000);
        lastT = now; lastGot = DLM.got;
      }
      // 1% 一档刷新：每 64 KB 就改一次 DOM 是白费力气
      const pct = DLM.total ? Math.round(DLM.got / DLM.total * 100) : 0;
      if (pct !== lastPct) { lastPct = pct; dlmPaint(DLM.got, DLM.total); dlmApplyState('busy'); }
    }
    if (DLM.paused) return;
    dlmFinish();
  } catch (e) {
    if (e && e.name === 'AbortError') return;              // 按了暂停 / 离开这一屏
    if (DLM.paused) return;
    // CORS / 老浏览器 / 中途断网：退回普通直链，没有进度但一定能下
    DLM.busy = false;
    dlmReset();
    try { window.location.href = url; } catch (e2) {}
  } finally {
    if (DLM.ctl === ctl) DLM.ctl = null;
  }
}
// Blob 落盘：临时 <a download> 点一下就交给浏览器的下载管理器
function dlmSave(blob, name) {
  const a = document.createElement('a');
  const u = URL.createObjectURL(blob);
  a.href = u; a.download = name; a.style.display = 'none';
  document.body.appendChild(a);
  try { a.click(); } catch (e) {}
  setTimeout(() => { try { a.remove(); } catch (e) {} URL.revokeObjectURL(u); }, 4000);
}
function dlmFinish() {
  DLM.busy = false;
  DLM.paused = false;
  DLM.done = true;
  try {
    const blob = new Blob(DLM.chunks, { type: 'application/octet-stream' });
    DLM.got = blob.size;
    DLM.blob = blob;                       // 留着：下完再点按钮就是再存一次，不必重下
    DLM.savedAt = Date.now();
    dlmSave(blob, EXE_FILE);
  } catch (e) {
    DLM.done = false;
    dlmReset();
    return;
  }
  DLM.chunks = [];                       // 分片已交给 Blob，数组本身可以松手
  const fill = dlmEl('dlmFill');
  if (fill) fill.style.width = '100%';
  dlmApplyState('done');
  dlmSizeText('完成');
}
// 装好后直接在卡片里重新创建：不用回上一屏、不用重新输任何东西
function dlmRetry() {
  gateShowChoices();
  // 立刻回一句「在检查」，否则第二次仍然失败时这一屏长得一模一样，像点了没反应
  gateMsg('正在检查本机程序…', 'info');
  setTimeout(() => { try { gateCreate(); } catch (e) {} }, 180);
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
function showGate() {
  document.getElementById('gateView').classList.add('show');
  document.getElementById('hostView').style.display = 'none';
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
// 房间内的销毁房间不涉及声明。
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
  if (agreeChecked()) { fn(); return; }
  agreeHintFlash();
}
function gateShowJoin() {
  gateView('gateJoin');
  gateClearMsg();
  // 若上一条预热连接失败过，趁用户输码再补一条，别让「加入」时从零握手
  prewarmSignal();
  const box = document.getElementById('gateRoom');
  setTimeout(() => box.focus(), 60);
}
function gateShowChoices() {
  if (JOIN_REQUIRED) return;      // 局域网设备只能加入，没有「创建房间」可选
  dlmHide();                      // 从「下载程序」视图返回：停掉缓存、还原标题与页脚
  const joinBtn = document.getElementById('gateJoinChoiceBtn');
  if (joinBtn) joinBtn.style.display = '';
  gateView('gateChoices');
  gateClearMsg();
}
// 本机打开页面、程序里还没有房间：只留「创建房间」这一步
function showHostGate() {
  showGate();
  GATE_HDR = null;
  gateView('gateChoices');
  // 本机就是房主，「加入房间」没有意义，藏起来免得点进去连自己
  const joinBtn = document.getElementById('gateJoinChoiceBtn');
  if (joinBtn) joinBtn.style.display = 'none';
  const title = document.querySelector('.gate-title');
  if (title) title.textContent = '数据传输';
  const sub = document.querySelector('.gate-sub');
  if (sub) sub.textContent = '点「创建房间」开一个房间，别人用房间码加入';
  setFoot('房间是临时的：关掉房主页面或 30 分钟无通信就会自动销毁', '聊天记录不落盘，接收文件随房间一起删除');
  gateClearMsg();
}
// 局域网设备打开页面：只留「输入房间码」这一步
function showLanGate() {
  showGate();
  GATE_HDR = null;
  gateView('gateJoin');
  const title = document.querySelector('.gate-title');
  if (title) title.textContent = '加入房间';
  const sub = document.querySelector('.gate-sub');
  if (sub) sub.textContent = '输入房主给你的房间码，就能加入这个房间';
  setFoot('房间码显示在房主那台设备的房间栏里', '同一个网络下输入房间码即可加入');
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
  // 之前是纯网页房主：本机没程序也能恢复，刷新不算离线
  if (cloudRoomCode()) { return resumeCloudHost(); }
  let info;
  try {
    info = await fetchHostInfo();
  } catch (e) {
    try { history.replaceState(null, '', location.pathname); } catch (e2) {}
    gateShowChoices();
    // 本机程序不在：卡片内切到下载视图（不弹窗）
    gateShowDl();
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

// ===== 纯网页房主（CHANNEL = 'cloud'）=====
// 开关关闭时点「创建房间」走这里：不探活、不下载，房间直接建在浏览器里。
// 开关只影响「点创建房间」这一步：切换本身不发请求、不提示（D-14）。
function onLanSwitchChange() {
  const cb = document.getElementById('lanSwitch');
  LAN_SWITCH = cb && cb.checked ? 'on' : 'off';
  const sub = document.getElementById('lanSwitchSub');
  if (LAN_SWITCH === 'on') {
    if (sub) sub.textContent = '同一 WiFi 的设备也能加入';
    setFoot('创建房间需要本机已运行程序', '加入房间仍然不需要');
  } else {
    if (sub) sub.textContent = '纯网页房间，无需下载软件';
    setFoot('创建房间不需要下载软件', '加入房间任何设备都能用');
  }
  try { sessionStorage.setItem('lan_switch', LAN_SWITCH); } catch (e) {}
}
function restoreLanSwitch() {
  try {
    LAN_SWITCH = sessionStorage.getItem('lan_switch') === 'on' ? 'on' : 'off';
  } catch (e) { LAN_SWITCH = 'off'; }
  const cb = document.getElementById('lanSwitch');
  if (cb) cb.checked = LAN_SWITCH === 'on';
  onLanSwitchChange();
}
// 下载视图没有第二条出口：屏幕上的「返回」已经能回到选择页，
// 多一条「不装软件直接创建」只是把同一个动作说了两遍（已按反馈删除）。
async function cloudGateCreate() {
  if (!agreeChecked()) { agreeHintFlash(); return; }
  const btn = document.getElementById('gateCreateBtn');
  if (!btn || btn.disabled) return;
  const label = btn.querySelector('.gate-txt b');
  const sub = btn.querySelector('.gate-txt > i');
  btn.disabled = true;
  btn.classList.add('busy');
  if (label) label.textContent = '正在创建房间…';
  gateClearMsg();
  gateProgReset(['准备房间', '外网通道']);
  gateProgress(0, 10);
  try {
    CHANNEL = 'cloud';
    API = '';
    const room = await Cloud.createRoom();
    ROOM = room;
    gateProgress(1, 60);
    gateProgCreep(92);
    await prepareHostPeer(ROOM, 9000);
    if (gateProgTimer) { clearInterval(gateProgTimer); gateProgTimer = null; }
    gateProgress(gateSteps.length, 100, true);
    hideGate();
    try { history.replaceState(null, '', '?host=1'); } catch (e) {}
    startHostUI(true, '');
    Cloud.startIdleWatch();
  } catch (e) {
    CHANNEL = 'lan';
    gateMsg((e && e.message) || '创建房间失败，请稍后再试。', 'err');
    gateProgReset([]);
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    if (label) label.textContent = '创建房间';
    if (sub) sub.textContent = '在本机开一个房间';
  }
}
// 云房主刷新：房间码与历史都在 IndexedDB 里，刷新不算离线（D-06）
async function resumeCloudHost() {
  const saved = cloudRoomCode();
  if (!saved) {
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    gateShowChoices();
    return;
  }
  let ok = false;
  try { ok = await Cloud.resume(saved); } catch (e) { ok = false; }
  if (!ok) {
    cloudForget();
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    gateShowChoices();
    gateMsg('房间已经结束（超过 30 分钟没有通信或已被销毁），点「创建房间」开一个新房间。', 'info');
    return;
  }
  CHANNEL = 'cloud';
  ROOM = saved;
  API = '';
  gateMsg('正在恢复房间…', 'info');
  try { await prepareHostPeer(ROOM, 9000); } catch (e) {}
  hideGate();
  startHostUI(true, '');
  Cloud.startIdleWatch();
}

// 创建房间：确认本机程序在跑，再由它当场开一个房间（房间码在这一刻才生成）。
// 不再人为拖时间：后端开好 + 外网直连房主 Peer 注册成功就立刻进主界面。
async function gateCreate() {
  if (!agreeChecked()) { agreeHintFlash(); return; }
  // 入口页开关决定通道：off = 纯网页房间（零下载），on = 探活本机程序。
  // 本机页面（SEED_MODE=host）没有开关，永远走原来的局域网路径。
  if (SEED_MODE !== 'host' && LAN_SWITCH !== 'on') { return cloudGateCreate(); }
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
    ? ['检查程序', '创建房间', '外网通道']
    : ['检查程序', '创建房间']);
  gateProgress(0, 8);
  try {
    // 检查本机程序 + 开房间并行发出：两次都是本机请求，串行纯属白等；
    // 程序没开时两个请求一起失败，直接给出同一条提示
    let info, r;
    try {
      [info, r] = await Promise.all([
        fetchHostInfo(),
        apiFetch(HOST_API + '/api/room/create', { method: 'POST' }),
      ]);
    } catch (e) {
      throw new Error('没有检测到本机程序');
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
    if (m.indexOf('没有检测到本机程序') >= 0) {
      // 程序没开（或本机服务没起来）：卡片直接切到下载视图，不再叠红字
      gateClearMsg();
      gateShowDl();
    } else {
      gateMsg(m, 'err');
    }
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
    const r = await apiFetch(API + '/api/join', {
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
  // 本机页面没有通道可选：开关只属于在线页的入口
  const sw = document.querySelector('.lan-switch');
  if (sw) sw.style.display = 'none';
  // 局域网里其他设备打开：先输房间码，不能打开网页就直接看到聊天内容
  if (JOIN_REQUIRED) showLanGate();
  // 本机：程序刚开，还没有房间——停在入口页，点了「创建房间」才开房
  else if (!HAS_ROOM) showHostGate();
  // startHostUI 里已经 loadMessages + 起轮询，这里不再重复（否则每 2 秒发两次请求）
  else initHost();
} else {
  showGate();
  restoreLanSwitch();
  // 上一次会话关页留下的云房间：超过空闲上限就清掉，别把旧消息留在浏览器里
  try { Cloud.cleanupOrphans(); } catch (e) {}
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
    if (agreeChecked()) { goInvite(); }
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
// 房主 / 局域网设备这边：长轮询可能正挂在一条已经死掉的 TCP 上（切了 WiFi、
// 合盖再打开），主动重开一轮比干等超时快得多。
window.addEventListener('online', () => {
  try { flushGuestRetry(); } catch (e) {}
  try { if (MODE === 'host' && !roomClosed) startPolling(); } catch (e) {}
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  try { flushGuestRetry(); } catch (e) {}
  // 回到前台补拉一次：后台时浏览器可能把页面冻住，挂着的请求不一定还活着
  try { if (MODE === 'host' && !roomClosed) loadMessages(); } catch (e) {}
});

// 卡片尺寸不用再算：三块视图在 CSS 里用 grid 叠在同一格，
// 格子高度天然等于最高那块，切屏时不会变。

// 房间生命周期：临时房间（页面关闭 / 12 小时无通信 / 手动销毁），没有可设的选项了
