// ===== room.js — 房间内逻辑 =====
// 人数与权限、消息与渲染、轮询与中继、P2P 数据通道、桌面共享、按需下载、
// 邀请与房间码、网络/帮助弹窗、房间生命周期、房主 Peer、成员管理、发送与管理面板。
// 本文件不会被浏览器单独加载：build_page() 按 app.js → room.js → gate.js 顺序
// 拼成同一个 <script> 内联进页面，交付始终是一份 index.html。

// ===== 房间里现在有几台设备：只用来提示，房主没等人也能先发消息 =====
let lanPeers = 0;        // 局域网里其他在线设备数（后端 /messages 带回）
let hostP2PCount = 0;    // 房主页面报上来的外网直连设备数（局域网设备看不到 P2P，靠这个）
let isLanClient = false; // 本页是不是「局域网里其他设备打开的」
let lastReportedP2P = -1;// 房主端：上次报给后端的外网设备数
let lastDevicesSig = ''; // 上次收到的房间成员清单，没变就不重绘
let peerBye = false;  // 收到 BYE：主动断开的一方不自动重连
// 「有设备正在握手中」的临时提示文案：连上后要能对号清除，不能干等 10 秒过期
const HOST_CONNECT_HINT = '有设备正在建立直连…';

// 「谁连进来了 + 对方 IP」只属于房主：外网访客（MODE=guest）和局域网里
// 其他设备（isLanClient）一概不看，也不把设备清单留在自己的内存 / DOM 里。
function isRoomOwner() { return MODE === 'host' && !isLanClient && !roomClosed; }
function clearDeviceLists() {
  ['memberList', 'lanMembers'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = ''; el.classList.remove('show'); }
  });
}
function applyDevicePrivacy() {
  const owner = isRoomOwner();
  document.body.classList.toggle('is-room-owner', owner);
  if (owner) return;
  roomDevices = [];
  clearDeviceLists();
  showRoomCard('');   // 别的设备连房间号和「新建 / 销毁」都不该看到
  const notice = document.getElementById('hostNotice');
  if (notice) { notice.textContent = ''; notice.style.display = 'none'; }
}
function activePeerCount() {
  if (MODE === 'guest') return canP2P() ? 1 : 0;
  if (isLanClient) return lanPeers + hostP2PCount;   // lanPeers 里含自己，至少 1
  return hostList().length + lanPeers;   // 房主：外网直连（可多台）+ 局域网里开着的设备
}
function peerReady() { return activePeerCount() > 0; }
// 能不能输入/发送：房主不受「房间里有没有人」限制——房间一建好就能写，
// 消息先存进这个房间的记录里，别人加入时由 HISTORY 自动补齐，人来了往上翻就能看到。
// 访客没有本机后端，只有真的连上房主才发得出去。
function canCompose() {
  if (MODE === 'host') return !roomClosed;
  return peerReady();
}
function refreshReady() {
  const ok = canCompose();
  const ready = peerReady();
  document.body.classList.toggle('no-peer', !ok);
  // 等待条只给房主端：访客 / 局域网其他设备已经有自己的连接状态，
  // 再挂一条「正在连接房间…」既重复，也不该由它们看到房间里的等待提示
  const wb = document.getElementById('waitBar');
  if (wb) wb.style.display = (ready || !isRoomOwner()) ? 'none' : 'flex';
  const wt = document.getElementById('waitText');
  if (wt) wt.textContent = '还没有其他设备加入';
  const sub = document.getElementById('waitSub');
  if (sub) sub.textContent = '你现在发的消息会存在房间里，别人加入后会自动补上';
  textInput.disabled = !ok;
  textInput.placeholder = ok ? '输入消息…' : '正在连接房间…';
  const sb = document.querySelector('.send-btn');
  if (sb) sb.disabled = !ok;
  const fb = document.querySelector('.folder-btn');
  if (fb) fb.disabled = !ok;
  const screenBtn = document.getElementById('screenBtn');
  // 桌面共享要有接收方才有意义：房主一个人时也先不点亮（不影响发文字/文件）
  if (screenBtn) screenBtn.disabled = !ready;
  fi.disabled = !ok;
  if (MODE === 'host') {
    const n = hostList().length;
    if (!isLanClient) {
      reportP2P(n);             // 房主把「外网有几台」报给后端，局域网设备才知道
    }
    updateHostRoomHint();
  }
}
// 房主端：外网直连设备数变了就报一次，别每次刷新都发请求
function reportP2P(n) {
  if (MODE !== 'host' || isLanClient) return;
  if (n === lastReportedP2P) return;
  lastReportedP2P = n;
  fetch(API + '/api/stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'p2p=' + n
  }).catch(() => {});
}
// 房主端：两条通道各自显示自己的连接数，互不混在一起
function updateHostRoomHint() {
  if (!isRoomOwner()) { clearDeviceLists(); return; }
  const wanEl = document.getElementById('hostHint');
  const lanEl = document.getElementById('lanCount');
  const wan = isLanClient ? 0 : hostList().length;   // 外网：本地 P2P 连接数
  const lan = lanPeers;                              // 局域网：后端统计的在线设备数
  if (wanEl) wanEl.textContent = '外网已连接 ' + wan + ' 台设备';
  if (lanEl) lanEl.textContent = '局域网已连接 ' + lan + ' 台设备';
  renderMembers();
}

// ===== 消息列表：房主端 = 服务端消息 + 本地 P2P 消息；访客端 = 纯本地 =====
const EMPTY_HTML = '<div class="empty"><span class="e-icon">'
  + '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#98A0AC" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M20.5 11.6c0 4-3.8 7.2-8.5 7.2-1 0-2-.15-2.9-.42L4 20l1.3-3.6A6.9 6.9 0 0 1 3.5 11.6c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2Z"/></svg>'
  + '</span>暂无消息<span class="e-sub">发的文字与文件会显示在这里，后加入的设备也能看到</span></div>';
let serverMsgs = [], localMsgs = [];
let seenIds = new Set();     // 同一条消息可能既走本机也走广播，按 id 去重
// 已渲染的每一条消息的签名：新列表若是「原封不动 + 尾部多几条」，就只追加，
// 不重建 DOM。屏幕共享的 <video> 一旦被重建就会断流，得靠补推重来一次。
let _renderedSigs = [];
let _firstRenderDone = false;
// 头像编号：设备名 -> 房间内编号。房主按加入顺序分配（房主=1，同一台设备
// 断开后重连沿用原号，计数器只增不减），P2P 访客走 NUMS 广播同步，
// 局域网设备从 /messages 的 nums 字段拿。
let nameNums = {};
let _numsSig = '';
let _numByDev = new Map();   // dev/局域网cid -> 编号，房间换码时清空重来
let _numCounter = 1;
let _numRoom = '';
function nowHMS() { return new Date().toTimeString().slice(0, 8); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function pushMsg(m) {
  m.time = m.time || nowHMS();
  if (m.id) {
    if (seenIds.has(m.id)) return;
    seenIds.add(m.id);
  }
  localMsgs.push(m);
  renderAll();
}
// 单条消息的渲染签名：id 之外连内容一起算。
// 屏幕共享卡从「进行中」变「已结束」是同一条 id、内容变了，必须当改动处理。
function msgSig(m) { return (m.id || '') + '|' + JSON.stringify(m); }
function isNearBottom() {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 120;
}
function renderAll() {
  // 两个来源按 id 跨数组去重：本机先落了一条卡、轮询里又回来同一条时，
  // 只渲染后端那份（字段更全），杜绝「同一张卡出现两次」
  const seen = new Set();
  const all = [];
  for (const m of serverMsgs) {
    if (m.id) { if (seen.has(m.id)) continue; seen.add(m.id); }
    all.push(m);
  }
  for (const m of localMsgs) {
    if (m.id) { if (seen.has(m.id)) continue; seen.add(m.id); }
    all.push(m);
  }

  const sigs = new Array(all.length);
  let canAppend = _renderedSigs.length > 0 && all.length >= _renderedSigs.length;
  for (let i = 0; i < all.length; i++) {
    sigs[i] = msgSig(all[i]);
    if (canAppend && i < _renderedSigs.length && sigs[i] !== _renderedSigs[i]) canAppend = false;
  }
  const lastMsg = all[all.length - 1];
  const lastSig = sigs.length ? sigs[sigs.length - 1] : '';
  const prevLastSig = _renderedSigs.length ? _renderedSigs[_renderedSigs.length - 1] : '';
  const newOwn = !!lastMsg && lastSig !== prevLastSig && isSelfMsg(lastMsg);

  // 滚动：贴着底部或刚轮到自己发话才跟到底，用户往上翻历史时别把他拽回来
  const stick = !_firstRenderDone || isNearBottom();
  const prevTop = chatScroll.scrollTop;
  let rebuilt = false;

  if (canAppend && all.length === _renderedSigs.length) {
    // 一模一样：DOM 一个字都不动，收尾函数照跑（直播计时之类的要走）
  } else if (canAppend) {
    // 只在尾部追加：正在播放的 <video> / <audio> 不会被打断，
    // 也省掉每次轮询把整屏几百个节点重建一遍
    msgList.insertAdjacentHTML('beforeend',
      all.slice(_renderedSigs.length).map(renderMsg).join(''));
  } else {
    msgList.innerHTML = all.length ? all.map(renderMsg).join('') : EMPTY_HTML;
    rebuilt = true;
  }
  _renderedSigs = sigs;

  mountScreenVideo(all);      // 共享画面挂到聊天卡上
  autoWatchLiveCards(all);    // 共享进行中：没流的一端自动请求补推
  ensureScDurTimer(all);      // 直播时长走秒（没有直播卡时会顺带收掉全屏层）

  if (stick || newOwn) {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  } else if (rebuilt) {
    chatScroll.scrollTop = prevTop;   // 全量重建会把滚动条甩到顶，还原回去
  }
  _firstRenderDone = true;
}

function extOf(name) {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(i + 1).toLowerCase() : '';
}
// 访客端 P2P 收到的分片要拼成带正确 MIME 的 Blob，否则 video/audio 标签拒绝播放
const MIME_MAP = {
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
  webp:'image/webp', bmp:'image/bmp', svg:'image/svg+xml', avif:'image/avif',
  mp4:'video/mp4', m4v:'video/mp4', webm:'video/webm', ogv:'video/ogg', ogg:'video/ogg',
  mov:'video/quicktime', mkv:'video/x-matroska',
  mp3:'audio/mpeg', wav:'audio/wav', m4a:'audio/mp4', aac:'audio/aac',
  flac:'audio/flac', opus:'audio/opus', oga:'audio/ogg',
  pdf:'application/pdf', txt:'text/plain'
};
function mimeOf(name) { return MIME_MAP[extOf(name)] || 'application/octet-stream'; }
// 文件下载地址：房主/局域网走本机接口，访客没有后端（本体点卡片按需拉取）
function fileUrl(msg) {
  if (msg.url) return msg.url;
  if (MODE === 'guest') return '';
  return API + '/download?name=' + encodeURIComponent(msg.name);
}

// ===== 消息渲染：微信式左右分栏 =====
// 自己发的靠右、绿色气泡；别人的靠左。判定依据：消息的发送者名字 == 本机在房间里的名字
function isSelfMsg(msg) { return !!myName && !!msg.ip && msg.ip === myName; }

// 统一匿名头像：所有设备同一个中性剪影，不带昵称首字、不泄露身份
const ANON_AVATAR =
  '<div class="msg-avatar anon" title="匿名设备" aria-label="匿名设备">' +
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
      '<circle cx="12" cy="8" r="3.7"/>' +
      '<path d="M4.6 20.3c0-3.9 3.3-6.6 7.4-6.6s7.4 2.7 7.4 6.6a.8.8 0 0 1-.8.8H5.4a.8.8 0 0 1-.8-.8z"/>' +
    '</svg>' +
  '</div>';

function renderMsg(msg) {
  const self = isSelfMsg(msg);
  let bubble='';
  if (msg.type==='text') {
    bubble = '<div class="bubble'+(self?' me':'')+'">'+esc(msg.content)+'</div>';
  } else if (msg.type==='screen') {
    // 屏幕共享直播卡：卡片本身就是共享画面（自动播放、点击全屏），
    // 停止后同一条卡原地变灰只留起止时间——一次共享全房间只有一张卡。
    const live = msg.status !== 'ended';
    const num = nameNums[msg.ip];
    const who = self ? '你' : (num ? '设备 ' + num : '对方设备');
    const st = String(msg.time || '');
    if (live) {
      const noP2P = isLanClient || !canP2P();
      const avNum = num ? '<i class="sc-av">' + num + '</i>' : '';
      bubble = '<div class="screen-card live" data-sid="'+esc(msg.id)+'">'+
        '<div class="sc-video-wrap" onclick="openScreenFs()">'+
          '<video class="sc-video" autoplay playsinline webkit-playsinline x5-playsinline muted></video>'+
          '<div class="sc-badge"><i></i>共享中</div>'+
          '<div class="sc-dur">00:00</div>'+
          (noP2P?'<div class="sc-lanhint">局域网访问不支持观看共享</div>':'')+
          '<button class="sc-play" style="display:none;">▶ 点击播放共享画面</button>'+
          '<div class="sc-bar">'+avNum+
            '<span class="sc-who">'+esc(who)+' · '+esc(st.slice(0,5))+' 开始</span>'+
            (self?'<button class="sc-stop" onclick="event.stopPropagation();stopScreenShare()">停止共享</button>':'')+
            '<span class="sc-fs" title="全屏观看">'+
              '<svg viewBox="0 0 14 14" width="13" height="13"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>'+
            '</span>'+
          '</div>'+
        '</div>'+
      '</div>';
    } else {
      const range = st ? esc(st.slice(0,5)) + (msg.end ? ' – ' + esc(String(msg.end).slice(0,5)) : '')
                       + (msg.dur ? ' · 共 ' + esc(msg.dur) : '') : '已结束';
      bubble = '<div class="screen-card ended">'+
        '<div class="sc-end-body">'+
          '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#888780" stroke-width="1.6" stroke-linecap="round">'+
          '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>'+
          '<span class="sc-end-title">屏幕共享已关闭</span>'+
          '<span class="sc-end-tip">画面不保存回放</span>'+
        '</div>'+
        '<div class="sc-end-bar"><span>'+esc(who)+'</span><span>'+range+'</span></div>'+
      '</div>';
    }
  } else {
    // 文件消息：一律一张文件卡片，不区分图片（11-11 定稿：图片预览整体下线）。
    // 下载只认右侧那个按钮——卡片本体点了不下载（误触太容易，手机上尤其）。
    // 按钮用内联 SVG 而不是 ⬇ emoji：emoji 在手机 / 电脑 / iOS 上是三种形状。
    const nm = esc(msg.name), sz = esc(msg.size || '');
    const ext = String(msg.name || '').split('.').pop().toUpperCase().slice(0, 4);
    const inner = '<div class="file-icon">' + esc(ext) + '</div>' +
      '<div class="file-info"><div class="file-name">' + nm + '</div>' +
      '<div class="file-size">' + sz + '</div></div>';
    const dlSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"' +
      ' stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3.6v10.2"/><path d="M7.7 10 12 14.3 16.3 10"/><path d="M4.6 18.6h14.8"/></svg>';
    if (MODE === 'guest' && msg.id) {
      bubble = '<div class="file-card">' + inner +
        '<button type="button" class="file-dl" title="下载" aria-label="下载"' +
        ' onclick="pullFile(\'' + esc(msg.id) + '\')">' + dlSvg + '</button></div>';
    } else {
      bubble = '<div class="file-card" data-name="' + esc(msg.name) + '">' + inner +
        '<button type="button" class="file-dl" title="下载" aria-label="下载"' +
        ' onclick="downloadLocal(this.parentNode)">' + dlSvg + '</button></div>';
    }
  }
  // 访客文件卡片正下方的下载进度条（平时隐藏，下载中由 txRender 填充）
  const bar = (msg.type === 'file' && MODE === 'guest' && msg.id)
    ? '<div class="pull-wrap" id="pullwrap-' + esc(msg.id) + '">'+
      '<div class="pull-bar"><i></i></div><div class="pull-text"></div></div>'
    : '';
  // 不显示昵称，只保留发送时间；头像按加入顺序显示编号（拿不到编号先给剪影）
  const num = nameNums[msg.ip];
  const avatar = num
    ? '<div class="msg-avatar anon av-num" title="设备 '+num+'">'+num+'</div>'
    : ANON_AVATAR;
  const side = '<div class="msg-side">'+bubble+bar+
    '<div class="msg-time">'+esc(msg.time)+'</div></div>';
  // 统一 DOM 顺序「头像 + 内容」：自己的行由 CSS row-reverse 镜像，
  // 头像自然贴在气泡右侧，不会再跑到屏幕另一头
  return '<div class="msg-row'+(self?' self':'')+'">'+ avatar + side +'</div>';
}

// 房主 / 局域网端：文件在本机后端，点卡片触发浏览器下载
function downloadLocal(btn) {
  const name = btn.getAttribute('data-name') || '';
  if (!name) return;
  const a = document.createElement('a');
  a.href = fileUrl({ name: name });
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 开始下载不弹提示：浏览器自己就有下载条，再弹一次是多余的
}

// 换了（重）连接：上一条通道上的拉取全都作废，队列跟着清空，
// 没下完的文件在新通道上重新点一次就能继续——旧通道上的失败不该算数
function resetPullsForReconnect() {
  pullInFlight.clear();
  pullQueue.length = 0;
  pullStartAt.clear();
  recvBuf.clear();          // 旧通道上的半截分片一律丢掉，别污染新的传输
  chunkChain = Promise.resolve();
}


// ===== 长轮询 =====
// 请求挂在后端，有变化才返回；收到就立刻再发一个，中间不留空档。
// 以前固定 2 秒问一次，别人发的消息平均要等 1 秒才上屏 ——
// 局域网本来 1ms 就能到，全被那个等待吞掉了。
const LONGPOLL_WAIT = 20000;                    // 与后端 LONGPOLL_MAX_MS 对齐
const POLL_TIMEOUT_PAD = 6000;                  // 客户端多等一会儿，别和服务端同时到点打架
const POLL_BACKOFF = [400, 900, 1800, 3000];    // 连续失败时的退避间隔
let LONGPOLL_OK = true;                         // 后端是否真的会挂起（老程序不认识 wait）
let _fastUnchanged = 0;                         // 连续「秒回且没变化」的次数

function stopPolling() {
  pollGen++;                    // 在途请求的结果一律作废
  if (pollAbort) { try { pollAbort.abort(); } catch (e) {} pollAbort = null; }
}
function startPolling() {
  stopPolling();
  pollBackoff = 0;
  // 每次重新起 polling 都重新探一次后端是否支持长轮询：降级是「新网页配旧
  // 程序」的临时兜底，不能在换房/重连后还一直沿用。
  LONGPOLL_OK = true;
  _fastUnchanged = 0;
  pollLoop(pollGen);
}
async function pollLoop(gen) {
  while (gen === pollGen && MODE === 'host' && !roomClosed) {
    let ok = false;
    try { ok = await loadMessages(LONGPOLL_WAIT, gen); } catch (e) { ok = false; }
    if (gen !== pollGen) return;
    if (ok) {
      pollBackoff = 0;
      // 旧程序不认识 wait，会立刻返回「没变化」：这时候再立刻重发就是忙轮询，
      // 退回原来的 2 秒一次。网页比程序新的时候靠这一条保命。
      if (!LONGPOLL_OK) await sleep(2000);
      continue;
    }
    // 连不上就别死循环猛敲：退避后再来，连续失败由 loadMessages 判定该退场
    await sleep(POLL_BACKOFF[Math.min(pollBackoff, POLL_BACKOFF.length - 1)]);
    pollBackoff++;
  }
}
async function loadMessages(wait, gen) {
  if (MODE !== 'host' || roomClosed) return false;
  const t0 = Date.now();
  const myGen = (typeof gen === 'number') ? gen : pollGen;
  let url = API + '/messages';
  const q = [];
  if (lastRev) q.push('rev=' + encodeURIComponent(lastRev));
  if (wait) q.push('wait=' + wait);
  if (q.length) url += '?' + q.join('&');
  // 长轮询要能被「换房间 / 关页面 / 重新开始」立刻打断，否则旧请求的结果
  // 会在新房间的状态上乱写。超时兜底比服务端多给 POLL_TIMEOUT_PAD 秒。
  let ctl = null, timer = null;
  if (wait && typeof AbortController !== 'undefined') {
    ctl = new AbortController();
    pollAbort = ctl;
    timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, wait + POLL_TIMEOUT_PAD);
  }
  try {
    // no-store：房间状态必须每次都问后端，绝不能让浏览器缓存一份「房间还在」。
    // 带上上次的内容指纹：没变化时后端只回状态字段，不重复发整包聊天记录
    const r = await fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    // 响应到达时可能已经换过房间：这一代的结果一律作废，别写进新房间状态
    if (myGen !== pollGen) return false;
    // 房主换了房间码或解散了房间：这台设备的凭证失效，回入口页重新输码
    if (r.status === 403) {
      let d0 = {};
      try { d0 = await r.json(); } catch (e) {}
      if (d0.code === 'NEED_JOIN') { msgFailStreak = 0; onNeedJoin(); return true; }
      throw new Error('forbidden');   // 其他 403 也算一次异常，攒够次数就回起始页
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    msgFailStreak = 0;               // 拿到后端的明确回应，失败计数清零
    if (!d.ok) return true;
    // 本机 client_url.txt 改了：这份页面（尤其是线上那份）跟着换成新地址
    if (d.client_url) applyClientUrl(d.client_url);
    // 房间已被解散：本机页面和局域网设备都退回入口页
    if (d.closed) {
      if (!dissolving) {
        onRoomClosed('房间已销毁，房间码已作废。点「创建房间」可以重新开一个。');
      }
      return true;
    }
    // 后端换了房间码（别处新建/销毁过房间），本机这份页面持有的码已过期
    if (d.room && ROOM && d.room !== ROOM) {
      onRoomClosed('房间码已经变更，请重新创建或加入房间。');
      return true;
    }
    // 有人进来 / 离开都要立刻反映到输入区能不能用
    let peerChanged = false;
    if (typeof d.peers === 'number' && d.peers !== lanPeers) {
      lanPeers = d.peers;
      peerChanged = true;
    }
    // 局域网设备看不到 P2P，外网人数只能问后端（数字由房主页面报上来）
    if (isLanClient && typeof d.p2p === 'number' && d.p2p !== hostP2PCount) {
      hostP2PCount = d.p2p;
      peerChanged = true;
    }
    // 房间里都有谁（外网 + 局域网）：只有房主端画成员清单，
    // 其他设备连数组都不留，避免 IP 落到自己的页面里
    if (Array.isArray(d.devices)) {
      const devices = isRoomOwner() ? d.devices : [];
      const sig = JSON.stringify(devices);
      if (sig !== lastDevicesSig) {
        lastDevicesSig = sig;
        roomDevices = devices;
        peerChanged = true;
      }
    }
    if (peerChanged) {
      refreshReady();
      renderAll();
    }
    // 本机 IP：后端对每个请求者回它自己的来源地址，连接卡里显示出来方便定位
    if (d.self_ip) setSelfIp(d.self_ip);
    // 头像编号表：房主自己算（updateNums），局域网设备用后端下发的这份
    if (d.nums && typeof d.nums === 'object') {
      const sig = JSON.stringify(d.nums);
      if (sig !== _numsSig) {
        _numsSig = sig;
        const changed = JSON.stringify(nameNums) !== sig;
        nameNums = d.nums;
        if (changed) renderAll();
      }
    }
    updateNums();
    // 连续五次「秒回且没变化」= 后端根本没挂起（老版本程序不认 wait）。
    // 阈值给宽一点：状态变化也会让长轮询提前返回 unchanged=true，那是正常的，
    // 不该把新程序误判成旧程序。真降级了，下次 startPolling 会重新探测。
    if (wait && d.unchanged && Date.now() - t0 < 500) {
      if (++_fastUnchanged >= 5) LONGPOLL_OK = false;
    } else {
      _fastUnchanged = 0;
    }
    if (d.rev === lastRev) return true;
    lastRev = d.rev;
    serverMsgs = d.messages || [];
    renderAll();
    relayNew(serverMsgs);
    return true;
  } catch (e) {
    // 主动停止（换房间 / 关页面 / 重新开始）不算失败：那一代的请求已经作废
    if (myGen !== pollGen) return false;
    // 以前这里是空 catch：程序被关掉 / 网络断开时页面会永远停在聊天主界面。
    // 连续 3 次问不到后端就认定房间已不可达，退回起始页。
    msgFailStreak++;
    if (msgFailStreak >= 3) {
      msgFailStreak = 0;
      onRoomClosed('连接不到本机程序，房间可能已经关闭，已返回起始页。请确认程序仍在运行后重新创建或加入房间。');
    }
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    if (ctl && pollAbort === ctl) pollAbort = null;
  }
}

// 房主是这个房间的中继：后端里出现的新消息，要转给所有外网设备
// （访客没有后端，只能靠这条路看到局域网设备和其他访客发的内容）
function relayNew(msgs) {
  if (MODE !== 'host') return;
  const list = hostList();
  if (!relaySeeded) {          // 首次拉取只登记，历史由 HISTORY 单独推
    for (const m of msgs) if (m.id) pushedIds.add(m.id);
    relaySeeded = true;
    return;
  }
  for (const m of msgs) {
    if (!m.id || pushedIds.has(m.id)) continue;
    pushedIds.add(m.id);
    if (!list.length) continue;        // 当前没外网设备，加入时会收到 HISTORY
    if (m.type === 'text') {
      broadcast('TEXT:' + JSON.stringify({
        t: m.content, f: m.ip || '', id: m.id, time: m.time || ''
      }), m.ip);                        // 不回给发送者本人
    } else if (m.type === 'file') {
      // 只广播一张「文件卡片」：设备看到卡片后谁需要谁点下载，不再自动推文件本体
      broadcast('FILE_CARD:' + JSON.stringify({
        id: m.id, name: m.name, size: m.size || '', f: m.ip || ''
      }), m.ip);                        // 不回给发送者本人
    } else if (m.type === 'screen') {
      // 屏幕共享卡实时同步给外网设备（停止走 SCREEN_STOP 单独改灰）
      broadcast('SCREEN_CARD:' + JSON.stringify({
        id: m.id, f: m.ip || '', time: m.time || '', status: m.status || 'live'
      }), m.ip);                        // 不回给发送者本人
    }
  }
}

// ===== WebRTC P2P via PeerJS：分片 + 背压 + 完整性校验 =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function buffered(c) {
  if (typeof c.bufferedAmount === 'number') return c.bufferedAmount;
  if (typeof c.bufferSize === 'number') return c.bufferSize;
  if (c.dataChannel && typeof c.dataChannel.bufferedAmount === 'number') return c.dataChannel.bufferedAmount;
  return 0;
}
function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return null;
}
// 发给指定的一条连接。mid 是房间里的消息 id，接收端据此去重；
// from 是发送者名字，转发时告诉下游是谁发的
async function sendFileTo(c, file, name, onProgress, mid, from) {
  if (!c || !c.open) throw new Error('连接已断开');
  const id = 'f' + Date.now() + Math.random().toString(36).slice(2, 8);
  const meta = { id: id, v: PROTOCOL, name: name, size: file.size };
  if (mid) meta.mid = mid;
  if (from) meta.f = from;
  c.send('FILE_META:' + JSON.stringify(meta));
  let offset = 0, guard = 0;
  while (offset < file.size) {
    while (buffered(c) > MAX_BUFFERED) {
      if (!c.open) throw new Error('连接已断开');
      await sleep(12);
      if (++guard > 3000) throw new Error('发送超时');
    }
    const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
    c.send(await slice.arrayBuffer());
    offset += slice.size;
    if (onProgress) onProgress(offset / file.size);
  }
  c.send('FILE_END:' + id);
}
// 同一条连接上，文件必须一个一个发：对端一个连接只有一个接收缓冲（分片不带文件 id），
// 两次 sendFileTo 并行会让分片互相穿插，对端拼出来两边都不完整——
// 手机弱网下一连请求好几张图片时必踩，表现就是「一张能看，多张全废」。
const sendChains = new Map();   // 连接 -> 该连接上最后一条发送 Promise
function queueConnSend(c, task) {
  const k = (c && (c.peer || c.id)) || 'conn';
  const prev = sendChains.get(k) || Promise.resolve();
  const next = prev.then(() => task()).catch(() => {});
  sendChains.set(k, next);
  next.then(() => { if (sendChains.get(k) === next) sendChains.delete(k); });
  return next;
}

// ctx：房主端传 { id, conn, name }，访客端为 null
function handleData(data, ctx) {
  const key = ctx ? ctx.id : 'guest';
  if (typeof data === 'string') {
    if (data.startsWith('HELLO:')) {
      const rest = data.slice(6);
      const i = rest.indexOf(':');
      const v = parseInt(i < 0 ? rest : rest.slice(0, i), 10);
      if (v !== PROTOCOL) { protoMismatch(v, ctx); return; }
      // 尾巴是「昵称」或「昵称:设备ID」：昵称里不带冒号，末段是 16 位 hex 才算设备 ID
      // （旧客户端只有昵称，这时 dev 为空）
      let tail = i < 0 ? '' : rest.slice(i + 1);
      let dev = '';
      const j = tail.lastIndexOf(':');
      if (j > 0 && /^[0-9a-f]{16}$/.test(tail.slice(j + 1))) {
        dev = tail.slice(j + 1);
        tail = tail.slice(0, j);
      }
      // 同一条连接重复报 HELLO 会在 registerGuest 里被忽略
      if (MODE === 'host' && ctx) registerGuest(ctx, tail, dev);
      return;
    }
    if (data.startsWith('WELCOME:')) {
      try {
        const w = JSON.parse(data.slice(8));
        if (w && w.name) {
          myName = w.name;
          // 连接状态行保持「已连接」，不再写「已进入房间」这类重复提示
          renderAll();
        }
      } catch (e) {}
      return;
    }
    // 房主把房间里的历史记录推给刚进来的设备，刷新/晚到也能看到之前聊了什么
    if (data.startsWith('HISTORY:')) {
      try {
        const h = JSON.parse(data.slice(8));
        // 历史里不带本体地址：已经下载/自己发过的文件（m.url）要原样继承下来，
        // 否则重连后房主重推一次 HISTORY，刚拿到手的文件会变成又要重新下载
        const haveUrl = new Map();
        for (const m of localMsgs) { if (m && m.id && m.url) haveUrl.set(m.id, m.url); }
        const hist = (h.messages || []).map(m => {
          const o = Object.assign({}, m, { remote: true });
          if (o.id && haveUrl.has(o.id)) o.url = haveUrl.get(o.id);
          return o;
        });
        const ids = new Set(hist.filter(m => m.id).map(m => m.id));
        // 历史可能比实时消息晚到一步：先到的几条留在后面，按时间重新归位，
        // 免得「刚进来看到的第一条」跑到最上面去
        const extra = localMsgs.filter(m => !m.id || !ids.has(m.id));
        const all = hist.concat(extra);
        all.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
        localMsgs = all;
        seenIds = new Set(all.filter(m => m.id).map(m => m.id));
        renderAll();
      } catch (e) {}
      return;
    }
    if (data.startsWith('PEERS:')) {
      try {
        const p = JSON.parse(data.slice(6));
        // 人数由右侧外网卡片 / 局域网卡片各自显示，这里不报合并总数
        renderAll();
      } catch (e) {}
      return;
    }
    if (data.startsWith('NOTE:')) {
      try { toast(JSON.parse(data.slice(5)).t || ''); } catch (e) {}
      return;
    }
    // 房主广播的「文件卡片」：只有名字和大小，谁需要谁点下载，不自动传本体
    if (data.startsWith('FILE_CARD:')) {
      if (MODE !== 'guest') return;
      try {
        const c = JSON.parse(data.slice(10));
        if (c && c.name) {
          pushMsg({ type: 'file', name: c.name, size: c.size || '',
                    ip: c.f || '外网设备', id: c.id || '' });
        }
      } catch (e) {}
      return;
    }
    // 访客点了「下载」：房主从磁盘把文件读出来流式发过去
    if (data.startsWith('FILE_PULL:')) {
      if (MODE !== 'host' || !ctx) return;
      let req = null;
      try { req = JSON.parse(data.slice(10)); } catch (e) {}
      const want = String((req && req.name) || '').replace(/\\/g, '/');
      const safe = want.split('/').pop().slice(0, 200);   // 只取文件名，防路径穿越
      const mid = String((req && req.mid) || '').slice(0, 32);
      if (!safe || !ctx.conn || !ctx.conn.open) return;
      // 串行：这台设备上的每次请求按到达顺序排队发送，绝不会和另一路分片交织
      queueConnSend(ctx.conn, () => {
        if (!ctx.conn || !ctx.conn.open) return Promise.resolve();
        return fetch(API + '/download?name=' + encodeURIComponent(safe))
          .then(r => { if (!r.ok) throw new Error('gone'); return r.blob(); })
          .then(blob => sendFileTo(ctx.conn, blob, safe, null, mid || undefined, '历史文件'))
          .catch(() => {
            try { ctx.conn.send('FILE_PULL_ERR:' + JSON.stringify({ mid: mid, name: safe })); } catch (e) {}
          });
      });
      return;
    }
    // 房主说文件没了：把这条下载从队列里清掉
    if (data.startsWith('FILE_PULL_ERR:')) {
      if (MODE !== 'guest') return;
      // 前缀 "FILE_PULL_ERR:" 正好 14 个字符——多切会把 JSON 切坏，
      // 解析失败就清不掉 pullInFlight，下载队列从此永久堵死（历史/实时全堵）
      let e0 = null;
      try { e0 = JSON.parse(data.slice(14)); } catch (e) {}
      const mid = e0 && e0.mid;
      if (mid) {
        pullInFlight.delete(mid); pullStartAt.delete(mid); pumpPullQueue();
        const w = document.getElementById('pullwrap-' + mid);
        if (w) { w.style.display = 'none'; w.querySelector('.pull-bar i').style.width = '0%'; }
      }
      notify('「' + ((e0 && e0.name) || '文件') + '」已不存在，无法下载');
      return;
    }
    if (data === 'SCREEN_END') {
      // 房主是中继：发共享的那台停了，把「停止」继续转给其他外网设备并收掉转发
      if (MODE === 'host') {
        stopScreenRelay();
        try { broadcast('SCREEN_END'); } catch (e) {}
      }
      // 收掉手上的接收流：直播卡随后由 SCREEN_STOP 改灰，画面先停
      if (recvCall) { try { recvCall.close(); } catch (e) {} }
      screenRecvStream = null;
      renderAll();
      return;
    }
    // 探活：房主每 5 秒敲一次，收到就回 PONG。手机切后台、进程被系统冻结时
    // 数据通道看着还是开的，但对面已经不响应了，只有主动敲才知道人还在不在。
    if (data === 'PING') {
      try { if (ctx && ctx.conn) ctx.conn.send('PONG'); } catch (e) {}
      return;
    }
    if (data === 'PONG') {
      const e = ctx && hostConns.get(ctx.id);
      if (e) { e.lastPong = Date.now(); e.missed = 0; }
      return;
    }
    // 房主把我们自己的地址回告过来。外网访客自己从 ICE 里只能读到候选地址，
    // 手机浏览器上 host 候选会被 mDNS 混淆成 xxx.local，读不出真 IP；
    // 房主那边看到的才是准的（和侧栏设备清单同一份，两边能对号）。
    if (data.startsWith('SELFIP:')) {
      if (MODE === 'guest') setSelfIp(data.slice(7));
      return;
    }
    // 头像编号表：房主按加入顺序分配，随广播同步给每台外网设备
    if (data.startsWith('NUMS:')) {
      try {
        const n = JSON.parse(data.slice(5));
        const sig = JSON.stringify(n);
        if (sig !== _numsSig) {
          _numsSig = sig;
          nameNums = n || {};
          renderAll();
        }
      } catch (e) {}
      return;
    }
    // 房主转发的「屏幕共享中」卡片：共享方的历史卡实时同步给其他外网设备
    if (data.startsWith('SCREEN_CARD:')) {
      if (MODE !== 'guest') return;
      try {
        const c = JSON.parse(data.slice(12));
        if (c && c.id) {
          pushMsg({ type: 'screen', status: c.status || 'live', ip: c.f || '外网设备',
                    id: c.id, time: c.time || '' });
        }
      } catch (e) {}
      return;
    }
    // 访客发起共享：房主落盘一条共享卡，再转给其余外网设备
    if (data.startsWith('SCREEN_START:')) {
      if (MODE !== 'host' || !ctx) return;
      let o = null;
      try { o = JSON.parse(data.slice(13)); } catch (e) {}
      const sid = o && o.id;
      if (!sid) return;
      fetch(API + '/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'status=start&from=' + encodeURIComponent(ctx.name)
            + '&id=' + encodeURIComponent(String(sid).slice(0, 32))
      }).then(() => loadMessages()).catch(() => {});
      // 卡片不在这里手动广播：房主轮询到后端这条消息后由 relayNew 统一转给外网设备
      return;
    }
    // 共享停止：房主把历史卡改成「已停止」，再转给其余外网设备各自改灰
    if (data.startsWith('SCREEN_STOP:')) {
      let o = null;
      try { o = JSON.parse(data.slice(12)); } catch (e) {}
      const sid = o && o.id;
      if (!sid) return;
      if (MODE === 'host') {
        fetch(API + '/screen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'status=stop&id=' + encodeURIComponent(String(sid).slice(0, 32))
        }).then(() => loadMessages()).catch(() => {});
        broadcast('SCREEN_STOP:' + JSON.stringify({ id: sid, end: o.end || '', dur: o.dur || '' }),
                  ctx && ctx.name);   // 发起方自己已经改过，不用回给它
      }
      updateScreenMsg(sid, { status: 'ended', end: o.end || '', dur: o.dur || '' });
      return;
    }
    // 访客点「观看共享」：房主把手上的流（自己的共享，或替访客转发的那路）补推过去
    if (data.startsWith('SCREEN_WATCH')) {
      if (MODE !== 'host' || !ctx || !ctx.conn || !ctx.conn.open) return;
      const watcher = ctx.conn.peer;
      const stream = screenStream || screenRecvStream;
      if (!stream || !watcher) {
        try { ctx.conn.send('NOTE:' + JSON.stringify({ t: '当前没有进行中的屏幕共享' })); } catch (e) {}
        return;
      }
      try { const c = pcPeer.call(watcher, stream); if (c) tuneScreenSender(c); } catch (e) {}
      return;
    }
    // 房主想回看某台访客的共享（自己面板已关）：请共享方重新呼叫一次
    if (data === 'SCREEN_RECALL') {
      if (MODE !== 'guest' || !screenStream || !guestPeer) return;
      try { const c = guestPeer.call('pc-' + currentRoom, screenStream);
            if (c) tuneScreenSender(c); } catch (e) {}
      return;
    }
    // 房主解散了房间：房间码已作废，访客直接回入口页，不要自动重连
    if (data === 'ROOM_CLOSED') {
      guestRoomGone('房主已销毁房间，房间码已作废。请联系房主获取新的房间码或邀请链接。');
      return;
    }
    // 对端主动点了「断开」：房主端只收掉这一条连接（房间还在）；
    // 访客端收到就说明房间那边把它摘掉了，直接退回入口页重新输码。
    if (data === 'BYE') {
      if (MODE === 'host' && ctx) {
        dropHostConnById(ctx.id, true);
      } else if (MODE === 'guest') {
        guestReturnToGate('房间那边已断开这台设备。如需再次加入，请重新输入房间码。');
      }
      return;
    }
    if (data.startsWith('TEXT:')) {
      const raw = data.slice(5);
      let txt = raw, from = '外网设备', mid = '', tstr = '';
      if (raw.charAt(0) === '{') {
        try {
          const o = JSON.parse(raw);
          txt = o.t || ''; from = o.f || from; mid = o.id || ''; tstr = o.time || '';
        } catch (e) {}
      }
      if (!txt) return;
      if (MODE === 'guest') {
        pushMsg({ type: 'text', content: txt, ip: from, id: mid, time: tstr });
      } else {
        // 房主是房间里唯一有后端的一方：落盘 + 转给其他外网设备
        const who = (ctx && ctx.name) || from;
        const id = mid || uid();
        pushedIds.add(id);
        fetch(API + '/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'content=' + encodeURIComponent(txt)
              + '&from=' + encodeURIComponent(who)
              + '&id=' + encodeURIComponent(id)
        }).then(() => loadMessages()).catch(() => {});
        broadcast('TEXT:' + JSON.stringify({ t: txt, f: who, id: id, time: tstr }), who);
      }
      return;
    }
    if (data.startsWith('FILE_META:')) {
      try {
        const meta = JSON.parse(data.slice(10));
        if (meta.v !== PROTOCOL) { protoMismatch(meta.v, ctx); recvBuf.delete(key); return; }
        recvBuf.set(key, {
          id: meta.id, name: meta.name, size: meta.size,
          chunks: [], received: 0,
          mid: meta.mid || '',
          from: meta.f || (ctx && ctx.name) || '外网设备'
        });
        // 收文件只留进度（访客是卡片下方的进度条），不再往状态行/提示行推文字
        if (MODE === 'guest') txStart(meta.name, meta.size, meta.mid || '');
      } catch (e) { recvBuf.delete(key); }
    } else if (data.startsWith('FILE_END:')) {
      const buf = recvBuf.get(key);
      if (!buf || data.slice(9) !== buf.id) return;
      if (buf.received >= buf.size) { finishRecv(key, buf); return; }
      // 还没收全：PeerJS 对大一点的消息是「异步重组」的，最后一片有可能比
      // FILE_END 晚一步才交上来。这里给它 2.5 秒的宽限，别一看到不齐就整包丢掉
      // （以前这里是立刻丢弃，手机端图片全废、电脑端时好时坏就是这个原因）
      waitRecvComplete(key, buf, Date.now());
    }
    return;
  }
  // 分片：绝大多数浏览器按 binaryType='arraybuffer' 给 ArrayBuffer，
  // 但个别手机浏览器（微信 X5 / 部分安卓 WebView）会把二进制当 Blob 递过来。
  // 以前 toArrayBuffer 对 Blob 返回 null 就直接丢包，对端永远是「文件不完整」——
  // 手机端所有图片（实时和历史）一张都出不来，正是这个原因。
  // Blob 只能异步读，统一排进一条 promise 链，保证分片顺序不乱。
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    chunkChain = chunkChain
      .then(() => (data.arrayBuffer ? data.arrayBuffer() : null))
      .then(ab => { if (ab) appendChunk(key, ab); })
      .catch(() => {});
    return;
  }
  const ab = toArrayBuffer(data);
  if (ab) appendChunk(key, ab);
}
// 把一片数据放进这条连接当前的接收缓冲
function appendChunk(key, ab) {
  const buf = recvBuf.get(key);
  if (!buf) return;                  // 没有对应的 FILE_META：过期的残片，直接丢
  buf.chunks.push(ab);
  buf.received += ab.byteLength;
  // 有数据在动就说明链路还活着：看门狗据此判断「卡住」而不是「慢」
  if (buf.mid && pullInFlight.has(buf.mid)) pullStartAt.set(buf.mid, Date.now());
  if (MODE === 'guest') {
    txTick(buf.received, buf.size);
  }
  // 房主端不报「正在接收 x%」：收文件是后台动作，进度看聊天里的卡片就行
}
// 收全了：拼成 Blob 交给上层（房主落盘 / 访客存下载）
function finishRecv(key, buf) {
  recvBuf.delete(key);
  const blob = new Blob(buf.chunks, { type: mimeOf(buf.name) });
  onFileReceived(blob, buf.name, buf.mid, buf.from);
}
// 收到 FILE_END 但字节数还差一点：再等 2.5 秒（PeerJS 的异步重组可能慢半拍）
function waitRecvComplete(key, buf, t0) {
  if (recvBuf.get(key) !== buf) return;          // 已经收完 / 已被新传输顶掉
  if (buf.received >= buf.size) { finishRecv(key, buf); return; }
  if (Date.now() - t0 > 2500) { dropRecv(key, buf); return; }
  setTimeout(() => waitRecvComplete(key, buf, t0), 150);
}
// 真的缺片了：丢弃这条传输，并且把下载队列的状态清干净，
// 否则 pullInFlight 占着位，后面排队等着的下载全被堵死
function dropRecv(key, buf) {
  if (recvBuf.get(key) === buf) recvBuf.delete(key);
  if (MODE === 'guest' && buf.mid) {
    pullInFlight.delete(buf.mid);
    pullStartAt.delete(buf.mid);
    const w = document.getElementById('pullwrap-' + buf.mid);
    if (w) { w.style.display = 'none'; const bar = w.querySelector('.pull-bar i'); if (bar) bar.style.width = '0%'; }
    pumpPullQueue();
  }
  notify('文件不完整，已丢弃');
}
// ===== 桌面共享：走 WebRTC 媒体流，与传文件的数据通道互不干扰 =====
let screenStream = null, screenCalls = [], recvCall = null;
let screenRelayCalls = [];   // 房主把收到的一路共享转给其他外网设备的那些 call
let screenMsgId = '';        // 这次共享在聊天历史里的卡片 id（停止时把卡片改成「已停止」）
let screenRecvStream = null; // 收到的一路共享流：房主转给后来加入的设备用
// 在本地消息里找屏幕共享卡并原地更新状态（发起方停止时自己先把卡片改灰）
function findScreenMsg(id) {
  return localMsgs.find(x => x.id === id && x.type === 'screen') ||
         serverMsgs.find(x => x.id === id && x.type === 'screen') || null;
}
function updateScreenMsg(id, patch) {
  const m = findScreenMsg(id);
  if (!m) return false;
  Object.assign(m, patch);
  renderAll();
  return true;
}
// 两次 HH:MM:SS 的间隔文案，和后端 screen_duration 保持一致
function fmtScreenDur(t1, t2) {
  const sec = t => {
    const p = String(t || '').split(':').map(x => parseInt(x, 10) || 0);
    while (p.length < 3) p.unshift(0);
    return p[0] * 3600 + p[1] * 60 + p[2];
  };
  let d = sec(t2) - sec(t1);
  if (d < 0) d += 86400;
  if (d >= 3600) return Math.floor(d / 3600) + ' 小时 ' + Math.floor(d % 3600 / 60) + ' 分';
  if (d >= 60) return Math.floor(d / 60) + ' 分钟';
  return d + ' 秒';
}
// 手机上 play() 可能被自动播放策略拦（iOS Safari / 微信内置浏览器只肯播
// 「已可见且静音」的 video）：失败时在卡片上显示手势兜底按钮
function playScreenVideo(v, btn) {
  const hide = () => { if (btn) btn.style.display = 'none'; };
  v.addEventListener('playing', hide, { once: true });
  let p;
  try { p = v.play(); } catch (e) { p = null; }
  if (p && p.catch) p.catch(() => {
    if (!btn) return;
    btn.style.display = 'block';
    btn.onclick = ev => {
      ev.stopPropagation();          // 别触发卡片自己的「全屏」点击
      v.muted = true;                // 用户手势触发也要保持静音，iOS 才肯播
      try {
        const q = v.play();
        if (q && q.catch) q.catch(() => {});
      } catch (e) {}
      hide();
    };
  });
}
// 把共享画面挂到聊天流里的直播卡上：
// 自己在共享 → 挂 screenStream；看别人（房主收到访客共享 / 被补推）→ 挂 screenRecvStream。
// renderAll 每次重建 DOM，video 是新元素，所以每次渲染都要重新挂一遍。
function mountScreenVideo(list) {
  const m = (list || []).find(x => x.type === 'screen' && x.status !== 'ended');
  if (!m) return;
  const wrap = document.querySelector('#msgList .screen-card.live .sc-video-wrap');
  const v = wrap && wrap.querySelector('.sc-video');
  if (!v) return;
  const stream = screenStream || screenRecvStream;
  if (!stream) return;
  if (v._src !== stream) {
    v._src = stream;
    try { v.srcObject = stream; }
    catch (e) { try { v.src = URL.createObjectURL(stream); } catch (e2) {} }   // 老浏览器只认 src
  }
  playScreenVideo(v, wrap.querySelector('.sc-play'));
}
// ===== 直播时长走秒 + 全屏观看层 =====
// 起始时间（HH:MM）换算成今天的时间戳（跨零点按昨天算），每秒原地更新
// 卡片右上角与全屏层的时长文字；renderAll 只在内容变化时重建 DOM，互不干扰。
let scDurTimer = null;
let scDurStart = 0;
function scParseStart(hm) {
  const m = String(hm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  const d = new Date();
  d.setHours(+m[1], +m[2], 0, 0);
  if (d.getTime() > Date.now() + 60000) d.setDate(d.getDate() - 1);   // 跨零点
  return d.getTime();
}
function scFmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const two = n => (n < 10 ? '0' : '') + n;
  return h ? h + ':' + two(m) + ':' + two(ss) : two(m) + ':' + two(ss);
}
function scDurText() { return scDurStart ? scFmtDur(Date.now() - scDurStart) : '00:00'; }
function ensureScDurTimer(list) {
  const live = (list || []).find(x => x.type === 'screen' && x.status !== 'ended');
  if (!live) {
    if (scDurTimer) { clearInterval(scDurTimer); scDurTimer = null; }
    closeScreenFs();                // 共享停了：全屏层还开着就一并收掉
    return;
  }
  scDurStart = scParseStart(live.time);
  if (scDurTimer) return;
  const tick = () => {
    const t = scDurText();
    document.querySelectorAll('.sc-dur').forEach(el => { el.textContent = t; });
    const f = document.getElementById('scfDur');
    if (f) f.textContent = t;
  };
  scDurTimer = setInterval(tick, 1000);
  tick();
}
// 点直播卡 / 全屏按钮：打开页面内全屏观看层。
// 不用系统 Fullscreen API：微信内置浏览器 / iOS Safari 上只有 video 级全屏可用，
// 页面内遮罩层两端表现一致，视频按原始比例完整显示（contain，不裁切）。
function openScreenFs() {
  const fs = document.getElementById('screenFs');
  if (!fs) return;
  const m = [...serverMsgs, ...localMsgs].find(x => x.type === 'screen' && x.status !== 'ended');
  const stream = screenStream || screenRecvStream;
  if (!m || !stream) return;
  const v = document.getElementById('scfVideo');
  if (v && v._src !== stream) {
    v._src = stream;
    try { v.srcObject = stream; }
    catch (e) { try { v.src = URL.createObjectURL(stream); } catch (e2) {} }
  }
  const num = nameNums[m.ip];
  const who = m.ip === myName ? '你' : (num ? '设备 ' + num : '对方设备');
  const w = document.getElementById('scfWho');
  if (w) w.textContent = who + ' · 屏幕共享中';
  const stop = document.getElementById('scfStop');
  if (stop) stop.style.display = (m.ip === myName) ? '' : 'none';
  fs.classList.add('show');
  document.body.classList.add('fs-locked');
  if (v) playScreenVideo(v, document.getElementById('scfPlay'));
  const f = document.getElementById('scfDur');
  if (f) f.textContent = scDurText();
}
function closeScreenFs() {
  const fs = document.getElementById('screenFs');
  if (!fs || !fs.classList.contains('show')) return;
  fs.classList.remove('show');
  document.body.classList.remove('fs-locked');
  const v = document.getElementById('scfVideo');
  if (v) { try { v.pause(); } catch (e) {} }
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeScreenFs(); }
});
// 直播卡在、画面还没到手上：自动请求补推（不用再点「观看共享」按钮）。
// 每张卡只请求一次，防止反复骚扰；共享方自己 / 局域网端不需要。
const watchAsked = new Set();
function autoWatchLiveCards(list) {
  const m = (list || []).find(x => x.type === 'screen' && x.status !== 'ended');
  if (!m || m.ip === myName) return;
  if (screenStream || screenRecvStream) return;   // 画面已经在播
  if (isLanClient || !canP2P()) return;
  if (watchAsked.has(m.id)) return;
  watchAsked.add(m.id);
  if (MODE === 'host') {
    // 房主刷新过页面、手里没有访客的流：请共享方重新呼叫一次
    const sharer = hostList().find(x => x.name === m.ip);
    if (sharer) { try { sharer.conn.send('SCREEN_RECALL'); } catch (e) {} }
  } else {
    try { guestConn.send('SCREEN_WATCH'); } catch (e) {}
  }
}
// ===== 共享画质调优 =====
// 浏览器给视频发送端默认的码率上限只有约 2.5 Mbps，桌面文字很容易糊；
// 这里把每条共享链路的视频码率上限放开到 6 Mbps，并按「优先保帧率」降级，
// 画面运动时优先流畅而不是掉帧。PeerJS 的 peerConnection 是懒建的，
// 拿不到就每 250ms 重试一次，最多 5 秒。
function tuneScreenSender(call) {
  const apply = () => {
    const pc = call && call.peerConnection;
    if (!pc) return false;
    for (const s of pc.getSenders()) {
      if (!s.track || s.track.kind !== 'video') continue;
      let p;
      try { p = s.getParameters(); } catch (e) { continue; }
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = 6000000;
      try { p.degradationPreference = 'maintain-framerate'; } catch (e) {}
      try { s.setParameters(p); } catch (e) {}
    }
    return true;
  };
  if (apply()) return;
  let n = 0;
  const timer = setInterval(() => { if (apply() || ++n >= 20) clearInterval(timer); }, 250);
}
async function toggleScreenShare() {
  if (screenStream) { stopScreenShare(); return; }
  if (!canP2P()) {
    notify(MODE === 'host'
      ? '当前走的是局域网访问，共享桌面请在本机操作（需要本机页面或 https 链接）'
      : '还没有建立直连，无法共享桌面');
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    notify('当前访问方式不支持共享桌面：需要 https 链接，或在本机打开。移动端浏览器通常只能观看，不能发起共享。');
    return;
  }
  let stream;
  try {
    // 帧率 30 + 1080p 采集：清晰度和流畅度都比老的 15fps 强一档；
    // 带上系统/标签页声音：对方可以自己决定开不开扬声器
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: true
    });
  } catch (e) {
    if (e && e.name === 'NotAllowedError') { notify('已取消共享'); return; }
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
    } catch (e2) {
      notify('无法共享桌面：' + ((e2 && e2.message) || e2));
      return;
    }
  }
  screenStream = stream;
  const track = stream.getVideoTracks()[0];
  if (track) track.addEventListener('ended', () => stopScreenShare());
  // 画面直接进聊天流：本机先落一张直播卡（后端那份回来后按 id 去重合并）
  // 房主共享：房间里每台外网设备都送一路；访客共享：只有房主这一路
  const targets = MODE === 'host'
    ? hostList().map(x => x.conn.peer).filter(Boolean)
    : (currentRoom ? ['pc-' + currentRoom] : []);
  const peer = (MODE === 'host') ? pcPeer : guestPeer;
  if (!peer || !targets.length) {
    notify('房间里还没有可以共享的对象');
    stopScreenShare();
    return;
  }
  for (const t of targets) {
    try { const c = peer.call(t, stream); if (c) { screenCalls.push(c); tuneScreenSender(c); } } catch (e) {}
  }
  if (!screenCalls.length) {
    notify('发起共享失败');
    stopScreenShare();
    return;
  }
  // 共享真正送出去了：往聊天历史里写一张「共享中」直播卡。
  // 卡片只由后端落盘一个真源，外网设备由房主转发（relayNew）拿到；
  // 本机先 pushMsg 一份让画面立刻出现，轮询回来后按 id 去重不会重影。
  const sid = uid();
  screenMsgId = sid;
  const tstr = nowHMS();
  if (MODE === 'host') {
    fetch(API + '/screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'status=start&from=' + encodeURIComponent(myName || '房主')
          + '&id=' + encodeURIComponent(sid)
    }).then(() => loadMessages()).catch(() => {});
  } else {
    try { guestConn.send('SCREEN_START:' + JSON.stringify({ id: sid, f: myName, time: tstr })); } catch (e) {}
  }
  pushMsg({ type: 'screen', status: 'live', ip: myName, id: sid, time: tstr });
  renderAll();
}
function stopScreenShare() {
  const wasSending = !!screenStream;
  closeScreenFs();              // 自己停止共享：全屏层跟着收起
  if (screenStream) {
    screenStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    screenStream = null;
  }
  for (const c of screenCalls) { try { c.close(); } catch (e) {} }
  screenCalls = [];
  stopScreenRelay();
  if (recvCall) { try { recvCall.close(); } catch (e) {} recvCall = null; }
  // 通知对端收起画面，否则对方那边会停在最后一帧
  if (wasSending) {
    try { broadcast('SCREEN_END'); } catch (e) {}
    try { if (guestConn && guestConn.open) guestConn.send('SCREEN_END'); } catch (e) {}
    // 历史里的共享卡同步改成「已停止」：一条卡片状态切换，不追加第二条
    const sid = screenMsgId;
    if (sid) {
      const start = (findScreenMsg(sid) || {}).time || '';
      const endT = nowHMS();
      const dur = fmtScreenDur(start, endT);
      updateScreenMsg(sid, { status: 'ended', end: endT, dur: dur });
      if (MODE === 'host') {
        fetch(API + '/screen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'status=stop&id=' + encodeURIComponent(sid)
        }).then(() => loadMessages()).catch(() => {});
        broadcast('SCREEN_STOP:' + JSON.stringify({ id: sid, end: endT, dur: dur }));
      } else {
        try { if (guestConn && guestConn.open)
          guestConn.send('SCREEN_STOP:' + JSON.stringify({ id: sid, end: endT, dur: dur })); } catch (e) {}
      }
    }
  }
  screenMsgId = '';
  renderAll();      // 直播卡收掉（此时卡应已由 updateScreenMsg 改灰，这里兜底重画）
}
// 房主把收到的一路共享转给其余外网设备：访客发起的共享原来只有房主能看到，
// 走这里之后所有外网设备都能看到（转发占用的是房主上行，和房主自己共享一样）
function stopScreenRelay() {
  for (const c of screenRelayCalls) { try { c.close(); } catch (e) {} }
  screenRelayCalls = [];
}
function relayScreenToOthers(stream, fromPeer) {
  if (MODE !== 'host' || !pcPeer) return;
  stopScreenRelay();
  for (const x of hostList()) {
    if (x.conn.peer && x.conn.peer !== fromPeer) {
      try { const c = pcPeer.call(x.conn.peer, stream); if (c) { screenRelayCalls.push(c); tuneScreenSender(c); } } catch (e) {}
    }
  }
}
function acceptScreenCall(call) {
  try { call.answer(); } catch (e) { return; }
  // 同一时间只显示一路；有人换了共享源就切到新的那路
  if (recvCall) { try { recvCall.close(); } catch (e) {} }
  recvCall = call;
  call.on('stream', stream => {
    screenRecvStream = stream;   // 房主留一份：后来加入的设备从这里补推
    renderAll();                 // 画面挂到聊天流里的直播卡上
    relayScreenToOthers(stream, call.peer);
  });
  call.on('close', () => {
    if (recvCall === call) recvCall = null;
    screenRecvStream = null;     // 流跟着这条呼叫走：断了之后要走「重新呼叫」
    stopScreenRelay();
    renderAll();
  });
}

// ===== 按需下载（访客端）：点文件卡片 → 向房主要文件本体 → 存到下载目录 =====
// 同一时间只拉一个文件：访客只有一条数据通道，混着收会串包
const pullInFlight = new Set();  // 正在拉取的 mid
const pullQueue = [];            // 排队中的 {mid, name}
const pullStartAt = new Map();   // mid -> 发起时间（看门狗用）
// 拉取看门狗：判断「卡死」只看**有没有数据在动**，不看发了多久。
// 以前按「发起时间」算 20 秒，手机弱网下一张稍大的图还没传完就被判超时，
// 判超时后又立刻发下一个请求——两路分片挤进同一个接收缓冲，结果两边全废，
// 表现就是「一张能看，多张全不显示」。
let pullWatchdogOn = false;
function ensurePullWatchdog() {
  if (pullWatchdogOn) return;
  pullWatchdogOn = true;
  setInterval(pullWatchdogTick, 4000);
}
function pullWatchdogTick() {
  const now = Date.now();
  let freed = false;
  // 连续多久没收到任何一个字节，才算真的卡住（有字节进来会不断刷新 t0）
  for (const [mid, t0] of Array.from(pullStartAt)) {
    if (now - t0 < 60000) continue;
    pullStartAt.delete(mid);
    pullInFlight.delete(mid);
    // 这条请求的残片还留在接收缓冲里：不丢掉的话，后面那一路会被它污染
    for (const [k, buf] of Array.from(recvBuf)) {
      if (buf && buf.mid === mid) recvBuf.delete(k);
    }
    const w = document.getElementById('pullwrap-' + mid);
    if (w) { w.style.display = 'none'; const bar = w.querySelector('.pull-bar i'); if (bar) bar.style.width = '0%'; }
    notify('「' + mid + '」下载超时，点卡片可重试');
    freed = true;
  }
  if (freed) pumpPullQueue();
}
// 拉取入口：把文件从房主拉过来并存到下载目录（访客端串行，一次一个）
function pullFile(mid) {
  const m = localMsgs.find(x => x.id === mid);
  if (!m || m.type !== 'file') return;
  if (m.url) { saveBlob(m.url, m.name); return; }   // 本体已在手上：直接再存一份
  if (!canP2P() || !guestConn || !guestConn.open) { notify('未连接房间，无法下载'); return; }
  if (pullInFlight.has(mid) || pullQueue.some(x => x.mid === mid)) { notify('这个文件已在下载队列里'); return; }
  pullQueue.push({ mid: mid, name: m.name });
  pumpPullQueue();
}
function saveBlob(url, name) {
  try {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => a.remove(), 1000);
  } catch (e) {}
}
function pumpPullQueue() {
  if (!pullQueue.length || pullInFlight.size) return;
  const job = pullQueue.shift();
  if (!guestConn || !guestConn.open) {
    notify('连接已断开，下载中断');
    return;
  }
  pullInFlight.add(job.mid);
  pullStartAt.set(job.mid, Date.now());
  ensurePullWatchdog();
  try {
    guestConn.send('FILE_PULL:' + JSON.stringify({ mid: job.mid, name: job.name }));
    setStatus('正在请求下载: ' + job.name);
    // 卡片正下方的进度条先亮起来
    const w = document.getElementById('pullwrap-' + job.mid);
    if (w) {
      w.style.display = 'block';
      const bar = w.querySelector('.pull-bar i');
      const txt = w.querySelector('.pull-text');
      if (bar) bar.style.width = '0%';
      if (txt) txt.textContent = '正在请求…';
    }
  } catch (e) {
    pullInFlight.delete(job.mid);
    pullStartAt.delete(job.mid);
    notify('下载请求发送失败');
  }
}

async function onFileReceived(blob, name, mid, from) {
  if (MODE === 'guest') {
    const url = URL.createObjectURL(blob);
    const m = mid ? localMsgs.find(x => x.id === mid) : null;
    if (m) { m.url = url; m.size = fmtSize(blob.size); renderAll(); }
    else pushMsg({ type: 'file', name: name, size: fmtSize(blob.size), url: url,
                   ip: from || '外网设备', id: mid || uid() });
    txEnd();
    saveBlob(url, name);
    if (mid) { pullInFlight.delete(mid); pullStartAt.delete(mid); }
    pumpPullQueue();
    return;
  }
  // 房主：把收到的文件落盘（记录进聊天后由 relayNew 给其他设备发卡片，谁需要谁拉）
  const fd = new FormData();
  fd.append('files', blob, name);
  fd.append('from', from || '外网设备');   // 标注是谁传的
  if (mid) fd.append('id', mid);            // 沿用同一条消息 id，前端才好去重
  try {
    const r = await fetch(API + '/upload', { method: 'POST', body: fd });
    const d = await r.json();
    if (!d.ok) throw new Error(d.msg || '保存失败');
    // 收到文件不弹提示：消息列表里会出现这张卡，落盘位置固定是「接收文件」
    loadMessages();
  } catch (e) { toast('保存失败: ' + e.message); }
  updateHostRoomHint();
}

// ===== 房主模式：生成房间码、等待外网设备、生成邀请链接 =====
// 把「本机此刻的在线页地址」同步到这份页面里。
// 在线页是导出的静态文件，自己不可能知道本机改了什么，只能运行时喂：
//   /api/host  —— 点「创建房间」时拿一次
//   /messages  —— 房主端每 2 秒轮询，顺带带回来，改完 client_url.txt 两秒内自动生效
// 拿到后存进 localStorage，下次刷新页（哪怕本机程序还没开）也还是新地址。
function applyClientUrl(url) {
  const v = String(url || '').trim();
  if (!v) return false;
  let saved = '';
  try { saved = localStorage.getItem('lanshare_client_url') || ''; } catch (e) {}
  if (v === CLIENT_URL && v === saved) return false;   // 没变就别折腾
  CLIENT_URL = v;
  try { localStorage.setItem('lanshare_client_url', v); } catch (e) {}
  // 已经在房间里：不重画的话链接换了域名，二维码还是上一个地址的
  if (ROOM && !roomClosed) {
    try { setupInvite(ROOM); } catch (e) {}
  }
  return true;
}

// 在线页基础地址（不带房间码）：复制 / 展示用它，邀请链接和二维码才追加房间码
function inviteBase() {
  let base = CLIENT_URL || localStorage.getItem('lanshare_client_url') || '';
  return base.trim().replace(/[?#].*$/, '');
}
function inviteUrl(room) {
  const base = inviteBase();
  if (!base) return '';
  // v=页面指纹：手机浏览器（微信 X5 / iOS Safari）缓存很顽固，程序更新后
  // URL 不变就会拿旧缓存页连新程序——旧页轻则没有连接提速、重则直接连不上。
  // 指纹随页面内容变化，URL 一变缓存即失效；页面本身不读这个参数。
  return base + '?room=' + encodeURIComponent(room) + '&v=' + PAGE_BUILD;
}
function makeQR(text, boxId) {
  try {
    const qr = qrcode(0, 'L');   // 屏显干净，L 级冗余最低、码点最大，小尺寸下最好扫
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount(), cell = 4, pad = 8;
    const cv = document.createElement('canvas');
    cv.width = cv.height = n * cell + pad * 2;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(pad + c * cell, pad + r * cell, cell, cell);
      }
    }
    const box = document.getElementById(boxId || 'qrImg');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(cv);
  } catch (e) { console.log('二维码生成失败', e); }
}

// ===== 局域网入口 =====
// 本机打开时给别人一个能直接用的地址；别人从局域网打开时告知走的是局域网通道
let lanShareUrl = '';

function copyText(text, cb) {
  const done = ok => { if (cb) cb(ok); };
  // http://192.168.x.x 不算安全上下文，clipboard API 用不了，退回 execCommand
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  done(ok);
}

// 局域网卡片现在只属于房主：给其他设备能用的地址 + 复制/二维码。
// 其他设备改用统一的「通道 + 房间号 + 断开连接」卡片，不再走这里。
function setupLanBanner(url) {
  const box = document.getElementById('lanBanner');
  if (!box) return;
  const short = u => String(u).replace(/^https?:\/\//, '');
  const here = LAN_URL || (location.protocol + '//' + location.host);
  lanShareUrl = url || LAN_URL || here;
  document.getElementById('lanLabel').textContent = '局域网';
  document.getElementById('lanUrl').textContent = short(lanShareUrl);
  document.getElementById('lanActions').style.display = 'flex';
  box.style.display = 'block';
}

function copyLanUrl() {
  // 复制的就是干净地址（用户 11-10 定稿：不带任何参数）；
  // 缓存参数只放在二维码/邀请链接里，复制地址给电脑或浏览器打开足够新鲜
  const text = (lanShareUrl || LAN_URL || (location.protocol + '//' + location.host))
    .replace(/[?#].*$/, '');
  copyText(text, ok => {
    const short = text.replace(/^https?:\/\//, '');
    if (ok) toast('已复制局域网地址：' + short);
    else toast('复制失败，请手动记下：' + short);
  });
}

// 房间卡片上的房间码可以点：一键复制，省得手动框选
function copyRoomCode() {
  const code = ROOM || document.getElementById('roomCode').textContent.trim();
  if (!code) return;
  copyText(code, ok => toast(ok ? '房间码已复制：' + code : '复制失败，请手动复制：' + code));
}

// Esc 关掉所有开着的小弹窗（设置/帮助/说明/登录/确认），不用非去点关闭按钮
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  let closed = false;
  document.querySelectorAll('.modal-mask.show').forEach(m => {
    m.classList.remove('show'); closed = true;
  });
  if (closed) e.preventDefault();
});

// 局域网二维码：地址后面带上房间码，扫码进来房间码已经填好，不用手输
function lanQrUrl() {
  let base = (lanShareUrl || LAN_URL || (location.protocol + '//' + location.host))
    .replace(/[?#].*$/, '');
  if (!/\/$/.test(base)) base += '/';      // http://ip:8000 → http://ip:8000/
  return ROOM ? (base + '?room=' + encodeURIComponent(ROOM) + '&v=' + PAGE_BUILD) : base;
}
function toggleLanQR() {
  const box = document.getElementById('lanQrBox');
  // 判断依据只用显式的 'none'：打开时内联写 'flex'，关闭写 'none'。
  // 不能写 ''（空字符串读回来会被当成隐藏态，点「返回」会变成重新打开，永远关不上）
  const show = box.style.display === 'none';
  const url = lanQrUrl();
  // 换过房间码就要重画，否则扫出来还是旧码
  if (show && box.dataset.url !== url) {
    makeQR(url, 'lanQrImg');
    box.dataset.url = url;
  }
  box.style.display = show ? 'flex' : 'none';
}
function setupInvite(room) {
  const base = inviteBase();
  if (!base) {
    document.getElementById('inviteHint').textContent = '外网：未配置在线地址，在程序目录的 client_url.txt 第一行写入在线页网址，保存后刷新页面即生效';
    return;
  }
  document.getElementById('p2pUrl').textContent = base.replace(/^https?:\/\//, '');
  document.getElementById('p2pUrl').style.display = 'block';
  document.getElementById('inviteActions').style.display = 'flex';
  document.getElementById('inviteHint').textContent = '';
  makeQR(inviteUrl(room));   // 二维码带房间码：扫码免输直接进房
}
// 复制的是不带房间码、不带参数的干净基础地址：外网设备打开后自己输房间码加入
// （用户 11-10 定稿：复制 = 纯地址；缓存参数只放二维码/邀请链接里）
function copyInviteUrl() {
  const base = inviteBase();
  if (!base) return;
  const short = base.replace(/^https?:\/\//, '');
  copyText(base,
           ok => toast(ok ? '已复制访问地址：' + short : '复制失败，请手动记下：' + short));
}
function toggleQR() {
  const b = document.getElementById('qrBox');
  const show = b.style.display === 'none';
  b.style.display = show ? 'flex' : 'none';
}
// ===== 房间码由本机程序持有，页面只负责显示 =====
async function fetchHostInfo() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);   // 本机请求毫秒级返回；2.5s 还不通就是程序没开，早点失败别让人干等
  try {
    const r = await fetch(HOST_API + '/api/host', { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!d.ok) throw new Error(d.msg || '本机程序未响应');
    return d;
  } finally {
    clearTimeout(timer);
  }
}
// ===== 网络与中继设置（只存这台设备的浏览器）=====
function showNet() { renderIce(); document.getElementById('netModal').classList.add('show'); }
function hideNet() { document.getElementById('netModal').classList.remove('show'); }
function renderIce() {
  const box = document.getElementById('iceList');
  if (!box) return;
  const custom = customIce();
  const list = custom || ICE_SERVERS;
  box.innerHTML = list.map((s, i) => {
    const url = String((s && s.urls) || '');
    const isTurn = /^turns?:/.test(url);
    return '<div class="ice-row">' +
        '<span class="why' + (custom ? '' : ' def') + '">' + (custom ? (isTurn ? 'TURN' : 'STUN') : '默认') + '</span>' +
        '<span class="ice-url" title="' + esc(url) + '">' + esc(url) +
          (isTurn && s.username ? ' · ' + esc(String(s.username)) : '') + '</span>' +
        '<button onclick="delIce(' + i + ')" title="删除">✕</button>' +
      '</div>';
  }).join('');
  const tip = document.getElementById('iceTip');
  if (tip) {
    tip.textContent = custom
      ? '以上是自定义列表，连接时按顺序尝试；改完重新连接（或刷新）生效。'
      : '当前使用默认的 4 个公共 STUN，能连上就别改。';
  }
}
function persistIce(list) {
  try { localStorage.setItem('lanshare_ice', JSON.stringify(list)); } catch (e) {}
  try { localStorage.removeItem('lanshare_turn'); } catch (e) {}   // 迁移到新 key
}
function addIce() {
  const type = (document.getElementById('iceType') || {}).value || 'stun';
  let url = ((document.getElementById('iceUrl') || {}).value || '').trim();
  const user = ((document.getElementById('iceUser') || {}).value || '').trim();
  const pass = (document.getElementById('icePass') || {}).value || '';
  if (!url) { toast('先填服务器地址'); return; }
  if (!/^(stun|stuns|turn|turns):/i.test(url)) url = type + ':' + url.replace(/^\/+/, '');
  if (!/^(stun|stuns|turn|turns):\S+$/i.test(url)) { toast('地址格式应为 stun:主机:端口'); return; }
  const list = (customIce() || ICE_SERVERS).slice();
  const item = { urls: url };
  if (/^turns?:/i.test(url)) { item.username = user; item.credential = pass; }
  list.push(item);
  persistIce(list);
  ['iceUrl', 'iceUser', 'icePass'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  renderIce();
  toast('已保存，重新连接后生效');
}
function delIce(i) {
  const list = (customIce() || ICE_SERVERS).slice();
  if (i < 0 || i >= list.length) return;
  if (list.length <= 1) { toast('至少留一个服务器'); return; }
  list.splice(i, 1);
  persistIce(list);
  renderIce();
  toast('已删除，重新连接后生效');
}
function resetIce() {
  try { localStorage.removeItem('lanshare_ice'); } catch (e) {}
  try { localStorage.removeItem('lanshare_turn'); } catch (e) {}
  renderIce();
  toast('已恢复默认 STUN');
}
// ===== 使用帮助 =====
function showHelp() { document.getElementById('helpModal').classList.add('show'); }
function hideHelp() { document.getElementById('helpModal').classList.remove('show'); }
// ===== 房间生命周期（临时房间：页面关闭 / 12 小时无通信 / 手动销毁）=====
function showTtl() { document.getElementById('ttlModal').classList.add('show'); }
function hideTtl() { document.getElementById('ttlModal').classList.remove('show'); }
let hostBeatTimer = null;
// 房主页面每 10 秒向本机程序报一次平安；页面关掉后心跳停止，
// 本机程序的看门狗等 60 秒（刷新页面足够回来了）就把房间销毁
function startHostHeartbeat() {
  if (MODE !== 'host' || isLanClient || hostBeatTimer) return;
  const beat = () => {
    if (roomClosed || !ROOM) return;
    try { fetch(API + '/api/room/heartbeat', { method: 'POST', body: '' }); } catch (e) {}
  };
  beat();
  hostBeatTimer = setInterval(beat, 10000);
  // 关页面 / 跳走时打一声招呼。刷新也会触发，但页面回来后第一次心跳就把「再见」撤销
  window.addEventListener('pagehide', () => {
    try { navigator.sendBeacon(API + '/api/room/bye'); } catch (e) {}
  });
}

async function renewRoom() {
  if (!confirm('新建房间会作废当前房间码，旧房间的聊天记录和接收文件也将一并删除。\n确定继续吗？')) return;
  try {
    const r = await fetch(API + '/api/room/renew', { method: 'POST' });
    const d = await r.json();
    if (!d.ok) throw new Error();
    ROOM = d.room;
  } catch (e) {
    toast('新建房间失败，请确认本机程序仍在运行');
    return;
  }
  // 换码 = 换房间：通知并断开所有外网设备，清空界面，服务端已切到新房间目录
  stopScreenShare();
  for (const [, e] of [...hostConns.entries()]) {
    try { e.conn.send('BYE'); } catch (err) {}
    try { e.conn.close(); } catch (err) {}
  }
  hostConns.clear();
  recvBuf.clear();
  clearConnectHint();   // 换房后所有连接都没了，「正在建立直连」的旧提示一起收掉
  lastRev = null;
  serverMsgs = [];
  localMsgs = [];
  seenIds = new Set();
  pushedIds = new Set();
  relaySeeded = false;
  roomDevices = [];
  lastDevicesSig = '';
  reportedDevices = '';
  renderMembers();
  showRoomCard(ROOM);
  setupInvite(ROOM);
  if (pcPeer) { try { pcPeer.destroy(); } catch (e) {} pcPeer = null; }
  startHostPeer(ROOM);
  loadMessages();
  refreshReady();
  renderAll();
  toast('已新建房间，旧房间的数据已删除');
}
// ===== 销毁房间：房主点头 → 断开所有设备 → 删除本机数据 → 回入口页 =====
function askDissolve() {
  document.getElementById('dissolveModal').classList.add('show');
}
function hideDissolve() {
  document.getElementById('dissolveModal').classList.remove('show');
}
async function dissolveRoom() {
  hideDissolve();
  const btn = document.getElementById('dissolveBtn');
  if (btn) btn.disabled = true;
  dissolving = true;
  try {
    const r = await fetch(API + '/api/room/dissolve', { method: 'POST' });
    const d = await r.json();
    if (!d.ok) throw new Error('fail');
    ROOM = '';   // 服务端已经销毁这个房间（含磁盘数据），码不再有效
  } catch (e) {
    dissolving = false;
    if (btn) btn.disabled = false;
    toast('销毁失败，请确认本机程序仍在运行');
    return;
  }
  onRoomClosed('房间已销毁，房间码已作废，本机聊天记录与接收文件已删除。要重新使用，点「创建房间」开一个新房间。');
  dissolving = false;
  if (btn) btn.disabled = false;
}
// 房间被解散（房主自己点的，或本机页面刷到了 closed 标记）：统一退回入口页
function onRoomClosed(tip) {
  if (roomClosed) return;
  roomClosed = true;
  applyDevicePrivacy();
  stopPolling();
  peerBye = true;
  stopScreenShare();                 // 必须先做：里面要用 hostConns 广播 SCREEN_END
  // 先通知每一台外网设备再断开，否则对方会当成掉线而自动重连。
  // 补发一次 + 把断开从 120ms 放宽到 600ms：DataConnection 在弱网下
  // 首包可能丢失，以前偶有访客收不到通知、一直停在聊天主页面。
  for (const [, e] of [...hostConns.entries()]) {
    const c = e.conn;
    try { c.send('ROOM_CLOSED'); } catch (err) {}
    setTimeout(() => { try { c.send('ROOM_CLOSED'); } catch (err) {} }, 180);
    setTimeout(() => { try { c.close(); } catch (err) {} }, 600);
  }
  hostConns.clear();
  recvBuf.clear();
  if (pcPeer) {
    const p = pcPeer;
    pcPeer = null;
    setTimeout(() => { try { p.destroy(); } catch (e) {} }, 200);
  }
  lanPeers = 0;
  lastRev = null;
  serverMsgs = [];
  localMsgs = [];
  seenIds = new Set();
  pushedIds = new Set();
  relaySeeded = false;
  showRoomCard('');
  document.getElementById('p2pBanner').style.display = 'none';
  document.getElementById('guestGate').style.display = 'none';
  const lb = document.getElementById('lanBanner');
  if (lb) lb.style.display = 'none';
  refreshReady();
  renderAll();
  ROOM = '';
  forgetJoinRoom();           // 房间已结束：清掉回连记录，别让刷新又自动连回旧码
  // 回到起始页就把「自动回房」的痕迹清掉：?host=1 / ?room=，
  // 否则刷新又会偷偷开一个新房间或连回已经作废的旧码
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  showGate();
  // 局域网设备只有「输入房间码」这一步，不能回到「创建房间」
  if (isLanClient || JOIN_REQUIRED) showLanGate();
  else if (SEED_MODE === 'host') showHostGate();   // 本机：房间没了，重新点「创建房间」
  else gateShowChoices();
  if (tip) gateMsg(tip, 'info');
}
// 局域网设备：房间码变了 / 房间没了，凭证失效，退回入口页重新输
function onNeedJoin() {
  if (roomClosed) return;
  roomClosed = true;
  applyDevicePrivacy();
  stopPolling();
  lanPeers = 0;
  hostP2PCount = 0;
  lastRev = null;
  serverMsgs = [];
  localMsgs = [];
  seenIds = new Set();
  pushedIds = new Set();
  relaySeeded = false;
  const lb2 = document.getElementById('lanBanner');
  if (lb2) lb2.style.display = 'none';
  document.getElementById('guestGate').style.display = 'none';
  refreshReady();
  renderAll();
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  forgetJoinRoom();           // 凭证已失效：先清回连记录，别让 showLanGate 又自动连回旧码
  showLanGate();
  gateMsg('房间码已经变了（房主新建或销毁了房间），请重新输入。', 'info');
}
let hostRetry = 0;
// 创建房间时先在入口页把房主 Peer 注册好，PeerJS 报 open 才算「房间真的可用」，
// 之后才切进主界面：不能让人已经进了房间，卡片上还挂着「正在连接信令服务器…」。
let readyHostPeer = null;
function prepareHostPeer(roomCode, timeoutMs) {
  return new Promise(resolve => {
    const ms = timeoutMs || 9000;
    const deadline = Date.now() + ms;
    let tries = 0, done = false, timer = null, current = null;
    const kill = () => { if (current) { try { current.destroy(); } catch (e) {} current = null; } };
    const finish = peer => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (peer && peer.open && !peer.destroyed) {
        readyHostPeer = peer;
        resolve(true);
      } else {
        kill();                 // 超时/报错的半成品 Peer 不能留着占房间码
        readyHostPeer = null;
        resolve(false);
      }
    };
    const build = () => {
      if (done) return;
      let p;
      try { p = new Peer('pc-' + roomCode, peerOpts()); }
      catch (e) { finish(null); return; }
      current = p;
      p.on('open', () => finish(p));
      p.on('error', err => {
        if (done) return;
        const t = (err && err.type) || 'unknown';
        // 刷新页面时旧 Peer 还没被信令释放：等一下用同一个码重试，别急着换码
        if (t === 'unavailable-id' && tries < 3 && Date.now() < deadline) {
          tries++;
          kill();
          // 信令释放旧 ID 一般几百毫秒就够，别让用户创建房间时干等
          setTimeout(build, 350 * tries);
          return;
        }
        finish(null);
      });
    };
    timer = setTimeout(() => finish(null), ms);
    build();
  });
}
function startHostPeer(roomCode) {
  // 入口页已经等到 open 的连接直接复用，不再建第二条，也不再显示任何开场状态文字
  const reuse = readyHostPeer && !readyHostPeer.destroyed && readyHostPeer.open ? readyHostPeer : null;
  readyHostPeer = null;
  pcPeer = reuse || new Peer('pc-' + roomCode, peerOpts());
  const onReady = () => {
    hostRetry = 0;
    refreshReady();
  };
  if (reuse) onReady();
  else pcPeer.on('open', onReady);
  pcPeer.on('connection', c => {
    peerBye = false;
    // 连接元数据里带着对面是谁（昵称 + 设备 ID）：
    // 昵称用来先分配名字，设备 ID 只是记下是哪一台（外网设备没有 lsdev cookie）
    const md = (c && c.metadata) || {};
    const mdDev = DEV_ID_RE.test(String(md.dev || '')) ? String(md.dev) : '';
    const mdNick = String(md.nick || '').trim().slice(0, 12);
    hostSeq++;
    const id = 'c' + hostSeq;
    const entry = { conn: c, name: '', seq: hostSeq, peerId: c.peer || '', ip: '', dev: mdDev, metaNick: mdNick,
                    registered: false, regTimer: null, lastPong: Date.now(), missed: 0, createdAt: Date.now() };
    hostConns.set(id, entry);
    showHostHint(HOST_CONNECT_HINT);
    c.on('open', () => {
      try { if (c.dataChannel) c.dataChannel.binaryType = 'arraybuffer'; } catch (e) {}
      try { c.send('HELLO:' + PROTOCOL); } catch (e) {}
      if (!entry.name) entry.name = '访客' + entry.seq;
      refreshReady();
      renderAll();
      // 连接建立后 ICE 还要一小会儿才收敛，晚一点再去读对端地址
      setTimeout(() => resolvePeerIp(entry), 1200);
      // 通道开了却一直不报身份（半路夭折、页面被关）：8 秒后悄悄收掉，
      // 免得房主那边留一个既没名字也没内容的「幽灵设备」
      entry.regTimer = setTimeout(() => {
        if (!entry.registered) dropHostConnQuiet(id);
      }, 8000);
    });
    // 每台设备一个 ctx，handleData 靠它区分是谁发来的
    c.on('data', d => handleData(d, { id: id, conn: c, name: entry.name }));
    c.on('close', () => {
      const n = entry.name || ('访客' + entry.seq);
      if (entry.regTimer) { clearTimeout(entry.regTimer); entry.regTimer = null; }
      hostConns.delete(id);
      recvBuf.delete(id);
      clearConnectHint();   // 握手中的连接断了也收提示，别让「正在建立直连」挂满 10 秒
      // 进出房间不再广播提示：设备来去本来就该安静，人数在侧栏随时能看到
      sendPeers();
      updateNums();   // 编号不回收：人走了号留着，重连回来还是原来的数字
      refreshReady();
      renderAll();
    });
    c.on('error', e => { showHostHint('数据通道错误：' + (e && e.message ? e.message : e)); });
  });
  // 对方发起桌面共享时在这里接住
  pcPeer.on('call', acceptScreenCall);
  pcPeer.on('disconnected', () => {
    showHostHint('信令连接断开，正在自动重连…');
    try { pcPeer.reconnect(); } catch (e) {}
  });
  pcPeer.on('error', err => {
    const t = (err && err.type) || 'unknown';
    if (t === 'unavailable-id') {
      // 刷新页面时旧连接可能还没被信令服务器释放，先重试拿回同一个码，
      // 直接换码会让已经发出去的邀请链接全部失效
      if (hostRetry < 3) {
        hostRetry++;
        showHostHint('正在重新接入房间…（第 ' + hostRetry + ' 次）');
        setTimeout(() => {
          try { pcPeer.destroy(); } catch (e) {}
          startHostPeer(roomCode);
        }, 1000 * hostRetry);
      } else {
        hostRetry = 0;
        showHostHint('这个房间码被别的页面占着，正在换一个新码…');
        setTimeout(renewRoom, 1200);
      }
    } else if (t === 'network' || t === 'server-error' || t === 'socket-error') {
      showHostHint('信令服务器连不上（' + t + '）：检查网络，或让设备改走局域网地址。局域网功能不受影响');
    } else if (t === 'peer-unavailable') {
      // 某台设备的临时 Peer ID 过期了（对方关掉页面、网络断了）。
      // 这不是房主这边的错误，提示行保持原样。
      return;
    } else {
      showHostHint('P2P 错误：' + t + '（点右上角的网络图标可以配一台中继服务器兜底）');
    }
  });
}

// 设备真正进了房间（或握手的连接断掉 / 被静默收掉）后，「正在建立直连」就没意义了：
// 只要当前挂的正是这条提示、也没有别的设备还在握手中，就立刻收起，
// 不让它顶着「正在连接」的样子干等 10 秒过期；别的提示（收文件等）不动。
function clearConnectHint() {
  const notice = document.getElementById('hostNotice');
  if (!notice || notice.textContent !== HOST_CONNECT_HINT) return;
  for (const [, e] of hostConns) { if (!e.registered) return; }
  showHostHint('');
}
// ===== 房间成员管理（房主端）=====
// 悄悄收掉一条连接：不动聊天、不广播、不弹提示，只把连接表与界面数据刷新一下。
// 通道开了却一直不报身份的连接走这里，房主那边应该无感。
function dropHostConnQuiet(id) {
  const e = hostConns.get(id);
  if (!e) return;
  if (e.regTimer) { clearTimeout(e.regTimer); e.regTimer = null; }
  const c = e.conn;
  hostConns.delete(id);
  recvBuf.delete(id);
  setTimeout(() => { try { c.close(); } catch (err) {} }, 150);
  clearConnectHint();
  updateNums();   // 编号不回收：人走了号留着，重连回来还是原来的数字
  refreshReady();
  renderAll();
}
function registerGuest(ctx, nick, dev) {
  const e = hostConns.get(ctx.id);
  if (!e || e.registered) return;
  const did = dev || e.dev || '';
  e.dev = did;
  // 同一台设备重连时，旧连接往往还挂着：手机切后台、上划杀掉浏览器，
  // 对端连关闭帧都发不出来，close 事件永远不会到。设备 ID 一样就是同一台机器，
  // 新连接进房的同时把旧的摘掉，清单里就不会出现两条「设备 2」。
  if (did) {
    for (const [oid, ox] of hostConns) {
      if (oid === ctx.id || !ox || !ox.registered || ox.dev !== did) continue;
      dropHostConnQuiet(oid);
    }
  }
  e.registered = true;
  if (e.regTimer) { clearTimeout(e.regTimer); e.regTimer = null; }
  clearConnectHint();   // 这台设备已进房，握手指示该收了（还有别的在握手中则先留着）
  let base = String(nick || e.metaNick || '').trim().slice(0, 12) || ('访客' + e.seq);
  const used = new Set();
  for (const x of hostConns.values()) if (x.name) used.add(x.name);
  let name = base, i = 2;
  while (used.has(name)) { name = base + '·' + i; i++; }
  e.name = name;
  ctx.name = name;
  try { e.conn.send('WELCOME:' + JSON.stringify({ name: name, proto: PROTOCOL })); } catch (err) {}
  pushHistoryTo(e.conn);
  updateNums();   // 新设备入房：编号表跟着变（重连设备沿用原号）
  sendPeers();
  refreshReady();
  renderAll();
}
// 给刚进来的设备补一份房间历史：刷新页面、晚到的人也能看到前面聊了什么。
// 现场再问一次后端，而不是用 2 秒轮询缓存的那份——房主刚发完、对端紧接着加入时，
// 缓存里可能还没有最后一条，人一进来就会少一段。
async function pushHistoryTo(conn) {
  let list = serverMsgs;
  try {
    const r = await fetch(API + '/messages', { cache: 'no-store' });
    const d = await r.json();
    if (d && d.ok && Array.isArray(d.messages)) list = d.messages;
  } catch (e) {}
  const payload = (list || []).slice(-200).map(m => ({
    type: m.type, content: m.content || '', name: m.name || '',
    size: m.size || '', time: m.time || '', ip: m.ip || '', id: m.id || '',
    status: m.status || '', end: m.end || '', dur: m.dur || ''
  }));
  try { conn.send('HISTORY:' + JSON.stringify({ messages: payload })); } catch (e) {}
}
// 把房间成员名单广播给所有外网设备
function sendPeers() {
  const names = ['房主'].concat(hostList().map(x => x.name).filter(Boolean));
  broadcast('PEERS:' + JSON.stringify({ names: names }));
  reportDevices();
  renderAll();
}

// ===== 设备通道与 IP：外网走 PeerJS 直连，局域网走本机 HTTP =====
let roomDevices = [];        // 后端给出的房间成员（外网由房主上报、局域网由后端记录）
let reportedDevices = '';    // 上次上报的内容，没变就不重复发

// 判断一个候选地址是不是真地址（浏览器会把本地地址伪装成 xxxx.local）
function looksLikeAddr(v) {
  if (!v) return false;
  if (/\.local$/i.test(v)) return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(v) || v.indexOf(':') >= 0;
}

// 从 WebRTC 连接里读对方 IP：同 WiFi 是内网地址，跨网是 STUN 反射出的公网地址。
// 读不到（NAT 太严、只有 mDNS 名）就返回空，界面显示「IP 未知」，不影响收发。
async function readPeerIp(entry) {
  const pc = entry && entry.conn && entry.conn.peerConnection;
  if (!pc || !pc.getStats) return '';
  const stats = await pc.getStats();
  const cands = {};
  let pairId = '';
  stats.forEach(s => {
    if (s.type === 'remote-candidate' || s.type === 'local-candidate') cands[s.id] = s;
    if (s.type === 'candidate-pair' && s.remoteCandidateId &&
        (s.state === 'succeeded' || s.nominated) && !pairId) pairId = s.remoteCandidateId;
  });
  const addr = c => (c && (c.address || c.ip)) || '';
  const direct = cands[pairId];
  if (direct && looksLikeAddr(addr(direct))) return addr(direct);
  // 配对信息缺失或只有 mDNS 名：在「对端候选」里挑一个真地址。
  // local-candidate 是本机自己的地址，不能用；srflx 是公网，host 是内网，优先公网。
  const order = { srflx: 0, prflx: 1, relay: 2, host: 3 };
  const remote = Object.values(cands)
    .filter(c => c.type === 'remote-candidate' && looksLikeAddr(addr(c)))
    .sort((a, b) => (order[a.candidateType] === undefined ? 9 : order[a.candidateType]) -
                    (order[b.candidateType] === undefined ? 9 : order[b.candidateType]));
  return addr(remote[0]) || '';
}

function resolvePeerIp(entry, left) {
  const tries = left === undefined ? 4 : left;
  if (!entry || !hostConns.size) return;
  readPeerIp(entry).then(ip => {
    if (ip) {
      if (entry.ip !== ip) { entry.ip = ip; updateHostRoomHint(); reportDevices(); }
      // 把自己看到的地址回告对方：外网访客在自己的页面上读不出真 IP
      // （手机浏览器把 host 候选混淆成 mDNS 名），但房主这边是准的。
      // 推过去之后访客卡片上就能显示「本机 IP」，和房主侧栏的设备清单对得上。
      sendSelfIp(entry, ip);
    } else if (tries > 0) {
      setTimeout(() => resolvePeerIp(entry, tries - 1), 1500);
    }
  }).catch(() => {
    if (tries > 0) setTimeout(() => resolvePeerIp(entry, tries - 1), 1500);
  });
  detectRelay(entry).then(r => {
    if (entry.relay !== r) { entry.relay = r; renderMembers(); updateHostRoomHint(); }
  });
}

// 地址只推一次：重复推会让访客卡片闪，reconnect 后 entry 是新的会重推
function sendSelfIp(entry, ip) {
  if (!entry || !ip || !entry.conn || !entry.conn.open) return;
  if (entry.selfIpSent === ip) return;
  entry.selfIpSent = ip;
  try { entry.conn.send('SELFIP:' + ip); } catch (e) {}
}

// 这条连接走的是直连还是 TURN 中继：看被选中的候选对里本端候选的类型
async function detectRelay(entry) {
  const pc = entry && entry.conn && entry.conn.peerConnection;
  if (!pc || !pc.getStats) return false;
  try {
    const stats = await pc.getStats();
    let pair = null;
    const cands = {};
    stats.forEach(s => {
      if (s.type === 'local-candidate' || s.type === 'remote-candidate') cands[s.id] = s;
      if (s.type === 'candidate-pair' && (s.state === 'succeeded' || s.nominated) && !pair) pair = s;
    });
    const lc = pair && pair.localCandidateId ? cands[pair.localCandidateId] : null;
    const rc = pair && pair.remoteCandidateId ? cands[pair.remoteCandidateId] : null;
    return !!((lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay'));
  } catch (e) { return false; }
}

// 房主把「外网直连的都有谁」报给后端：名字来自对方自报，IP 来自上面的 WebRTC 读取。
// 头像编号表一起报：后端存下来随 /messages 下发，局域网设备（不走 P2P）才能拿到。
function reportDevices() {
  if (MODE !== 'host' || isLanClient) return;
  const list = hostList().map(x => ({ name: x.name || '', ip: x.ip || '', dev: x.dev || '' }));
  const sig = JSON.stringify(list) + '#' + JSON.stringify(nameNums);
  if (sig === reportedDevices) return;
  reportedDevices = sig;
  try {
    fetch(API + '/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices: list, nums: nameNums })
    }).catch(() => {});
  } catch (e) {}
}

// 房主按加入顺序给每台设备编 stable 号：房主=1，同一台设备（按 dev /
// 局域网 cid 认人）断开重连沿用原号，新设备从最大号往后排。
// 算完把「设备名 -> 编号」广播给外网访客（NUMS）并报给后端。
function updateNums() {
  if (MODE !== 'host' || isLanClient) return;
  if (_numRoom !== ROOM) {          // 房间换了：编号从 1 重新开始
    _numRoom = ROOM;
    _numByDev.clear();
    _numCounter = 1;
  }
  const map = { '房主': 1 };
  for (const x of hostConns.values()) {
    if (!x || !x.registered || !x.conn || !x.conn.open) continue;
    const key = x.dev || ('id' + x.id);   // 没有 dev 的老客户端按连接认
    let n = _numByDev.get(key);
    if (!n) { n = ++_numCounter; _numByDev.set(key, n); }
    x.num = n;
    if (x.name) map[x.name] = n;
  }
  for (const d of (roomDevices || [])) {
    if (!d || d.channel === 'p2p') continue;   // 外网设备上面已经编过
    const key = 'L' + (d.cid || d.ip || d.name);
    let n = _numByDev.get(key);
    if (!n) { n = ++_numCounter; _numByDev.set(key, n); }
    if (d.name) map[d.name] = n;
  }
  const sig = JSON.stringify(map);
  if (sig !== _numsSig) {
    _numsSig = sig;
    nameNums = map;
    broadcast('NUMS:' + sig);
    reportDevices();
    renderAll();
  }
}

// 设备清单按通道拆两份：外网卡片只列 P2P 设备，局域网卡片只列局域网设备。
// 不显示昵称，统一「设备 N + IP」；通道由所属卡片说明，芯片里不再重复标注。
// 这份清单只给房主看，其他设备调用到这里直接清空返回。
function renderMembers() {
  if (!isRoomOwner()) { clearDeviceLists(); return; }
  const wan = isLanClient ? [] : hostList().map(x => ({ ip: x.ip || '', relay: !!x.relay, num: x.num || nameNums[x.name] || '' }));
  const lan = (roomDevices || [])
    .filter(d => d && d.channel !== 'p2p')   // 外网以本地连接为准，后端那份上报会慢一拍
    .map(d => ({ ip: d.ip || '', relay: false, num: nameNums[d.name] || '' }));
  const fill = (id, rows) => {
    const box = document.getElementById(id);
    if (!box) return;
    if (!rows.length) { box.innerHTML = ''; box.classList.remove('show'); return; }
    box.classList.add('show');
    box.innerHTML = rows.map((r, i) =>
      '<span class="member-row">' +
        (r.relay ? '<span class="member-tag relay">中继</span>' : '') +
        '<span class="member-name">设备 ' + (r.num || (i + 1)) + '</span>' +
        '<span class="member-ip">' + esc(r.ip || 'IP 未知') + '</span>' +
      '</span>').join('');
  };
  fill('memberList', wan);
  fill('lanMembers', lan);
}
// 只断开某一条连接；byPeer=true 表示是对方主动发 BYE 过来的
function dropHostConnById(id, byPeer) {
  const e = hostConns.get(id);
  if (!e) return;
  hostConns.delete(id);
  recvBuf.delete(id);
  if (!byPeer) { try { e.conn.send('BYE'); } catch (err) {} }
  setTimeout(() => { try { e.conn.close(); } catch (err) {} }, 80);
  stopScreenShare();
  sendPeers();
  refreshReady();
  renderAll();
}

// ===== 连接体检：把「人已经走了、清单还挂着」的鬼影清掉 =====
// close 事件不能全指望：手机切后台、上划杀掉浏览器、系统冻结进程，
// 这些情况对端连关闭帧都发不出来，房主这边永远等不到 close，
// 只能刷新页面才干净——这就是「显示已连接但其实早走了」的根因。
// 所以房主每 5 秒主动扫一遍：
//   1) 数据通道已关 / 底层 PeerConnection 已经 failed 或 closed → 立刻摘掉
//   2) 通道还开着但 12 秒没回 PONG（每轮敲一次 PING）→ 记一次，连续两次摘掉
// 阈值有意放宽：弱网下短暂卡顿不该把人踢掉，约 15 秒无响应才判定离开。
const SCAN_MS = 5000;
const PONG_TIMEOUT_MS = 12000;
let connScanTimer = null;

function startConnScan() {
  if (MODE !== 'host' || isLanClient || connScanTimer) return;
  connScanTimer = setInterval(scanHostConns, SCAN_MS);
}
function scanHostConns() {
  if (MODE !== 'host' || isLanClient || !hostConns.size) return;
  const now = Date.now();
  for (const [id, e] of hostConns) {
    if (!e || !e.conn) { hostConns.delete(id); continue; }
    // 刚建连、握手还没走完（open 还没触发）的先放过，否则慢网下会被误杀
    if (now - (e.createdAt || 0) < 20000 && !e.registered) {
      try { e.conn.send('PING'); } catch (err) {}
      continue;
    }
    const pc = e.conn.peerConnection;
    const pcState = pc ? (pc.connectionState || pc.iceConnectionState || '') : '';
    if (!e.conn.open || pcState === 'closed' || pcState === 'failed') {
      dropStaleConn(id);
      continue;
    }
    if (now - (e.lastPong || 0) > PONG_TIMEOUT_MS) {
      e.missed = (e.missed || 0) + 1;
      if (e.missed >= 2) { dropStaleConn(id); continue; }
    }
    try { e.conn.send('PING'); } catch (err) {}
  }
}
// 静默摘掉一条已失效的连接：不广播、不弹提示，只是让清单回到真实状态
function dropStaleConn(id) {
  const e = hostConns.get(id);
  if (!e) return;
  if (e.regTimer) { clearTimeout(e.regTimer); e.regTimer = null; }
  const c = e.conn;
  hostConns.delete(id);
  recvBuf.delete(id);
  setTimeout(() => { try { c.close(); } catch (err) {} }, 60);
  sendPeers();
  updateNums();
  refreshReady();
  renderAll();
}

function startHostUI(fromWeb, lanUrl, lanClient) {
  MODE = 'host';
  // 局域网里其他设备打开的页面：同样是 host 模式（共用一套收发逻辑），
  // 但它不是房主，名字要算自己的一台设备，不能也叫「房主」
  isLanClient = !!lanClient;
  startHostHeartbeat();   // 只有真房主页面会生效（局域网设备页面自动跳过）
  startConnScan();        // 同上：只有房主需要盯着「谁还在」
  // 重新开房：把上一次「已解散」的状态清干净，否则界面会立刻又退回入口页
  roomClosed = false;
  applyDevicePrivacy();   // 局域网设备不是房主：设备数 / IP 清单不显示
  showHostHint('');       // 重新进房不留上一轮的「正在…」临时提示
  dissolving = false;
  peerBye = false;
  msgFailStreak = 0;
  guestGoneHits = 0;
  guestGoneHandled = false;
  lastRev = null;
  serverMsgs = [];
  localMsgs = [];
  myName = isLanClient ? myNick() : '房主';
  seenIds = new Set();
  hostConns.clear();
  recvBuf.clear();
  pushedIds = new Set();
  relaySeeded = false;
  hostSeq = 0;
  roomDevices = [];
  lastDevicesSig = '';
  reportedDevices = '';
  renderMembers();
  // 在线页主动「创建房间」也算合法房主；局域网设备打开本机服务则不算
  const canHostP2P = P2P_ENABLED || !!fromWeb;
  document.getElementById('guestGate').style.display = 'none';
  // 在线页跨域拿不到管理员 cookie；局域网设备更不该有管理入口——
  // 管理入口只属于「跑这个程序的那台电脑」，齿轮对它们都藏起来
  if (fromWeb || isLanClient) document.getElementById('adminBtn').style.display = 'none';

  if (canHostP2P) {
    showRoomCard(ROOM);
    document.getElementById('p2pBanner').style.display = 'block';
    setupInvite(ROOM);
    startHostPeer(ROOM);
  } else {
    // 别人从局域网 IP 打开本机服务：只走 HTTP，不当房主。
    // 它自己就是房间成员，可以直接发（后端会把它算进 peers）
    lanPeers = Math.max(lanPeers, 1);
    // 与外网访客用同一张连接卡：只有通道名不同，别的文字一概不多写
    showOtherDeviceCard('局域网', ROOM);
    setGuestActions('connected');   // 走 HTTP，进来就是已连接
  }

  // 顶栏地址：只有房主端才需要给局域网地址；其他设备统一用上面的连接卡
  if (fromWeb) {
    if (lanUrl) {
      setupLanBanner(lanUrl);
    } else {
    }
  } else if (!isLanClient) {
    setupLanBanner();
  }

  loadMessages();
  refreshReady();
  renderAll();
  startPolling();
}
function initHost() {
  try {
    // P2P_ENABLED=false 只会出现在「局域网设备」拿到的页面上：
    // 这台设备不是房主，名字要用自己的，不能也叫「房主」
    startHostUI(false, '', !P2P_ENABLED);
    window.addEventListener('beforeunload', () => { if (pcPeer) pcPeer.destroy(); });
  } catch (e) {
    showHostHint('P2P 初始化失败：' + e.message);
  }
}

// ===== 访客模式：只走 P2P，不碰本机任何接口 =====
// existing: 入口页已经探通连接时传入 {peer, conn}，直接复用，避免重复握手
function initGuest(room, existing) {
  MODE = 'guest';
  rememberJoinRoom(room);     // 记住本标签页的房间：刷新后自动回连，不用重输码
  applyDevicePrivacy();       // 访客只看得到自己的连接状态，看不到设备数 / IP
  guestGoneHandled = false;   // 重新进房，允许下一次「房间已不存在」再触发收尾
  document.getElementById('adminBtn').style.display = 'none';
  showOtherDeviceCard('外网直连', room || '');
  setGuestActions('connecting');   // 连接中先不给按钮

  if (/MicroMessenger|QQ\/|Weibo/.test(navigator.userAgent)) {
    document.getElementById('wxTip').style.display = 'block';
  }
  peerBye = false;
  guestAutoTry = 0;
  myName = '';                 // 房间里的名字等房主分配回来
  seenIds = new Set();
  localMsgs = [];
  setStatus('正在连接房间…');
  refreshReady();
  renderAll();
  window.addEventListener('beforeunload', () => { if (guestPeer) guestPeer.destroy(); });
  if (existing && existing.conn && existing.conn.open) {
    currentRoom = room;
    guestPeer = existing.peer;
    guestConn = existing.conn;
    wireGuestPeer(guestPeer, room, (m, t, r, g) => {
      if (g) guestRoomGone('房间已不存在或房主页面已关闭，已返回起始页。');
      else failGuest(m, t);
    });
    wireGuestConn(guestConn, (m, t) => failGuest(m, t));
    // 入口页那一轮已经把 HELLO 发完了，房主也回过了 WELCOME：
    // 名字直接用探活时拿到的，别再发一遍 HELLO（房主那边会当成重复消息）
    myName = existing.name || '';
    if (!myName) {
      try { guestConn.send('HELLO:' + PROTOCOL + ':' + myNick() + ':' + devId()); } catch (e) {}
    }
    // 探活期间先到的消息（房间历史、成员名单）补处理，别让历史记录丢掉
    for (const d of (existing.pending || [])) {
      try { handleData(d, null); } catch (e) {}
    }
    markGuestConnected();
    renderAll();
    return;
  }
  guestConnect(room);
}
let guestRetry = 0;
let guestTimer = null;
let guestAutoTimer = null;   // 断线后的自动重连定时器
let guestAutoTry = 0;        // 自动重连已尝试次数
let currentRoom = '';
function guestConnect(roomArg) {
  const room = (roomArg || currentRoom || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
  if (!room) { setStatus('房间码无效'); return; }
  currentRoom = room;
  document.getElementById('linkRoom').textContent = room;
  guestRetry = 0;
  peerBye = false;
  guestAutoTry = 0;
  guestGoneHits = 0;
  setGuestActions('connecting');
  if (guestAutoTimer) { clearTimeout(guestAutoTimer); guestAutoTimer = null; }
  showGuestTip('');
  connectOnce(room);
}
// 断线重连：信令长连接还活着时，重开一条数据通道通常只要几百毫秒，
// 所以第一次不等，直接连；信令也断了才按 0.6s / 1.5s / 3s 退避，最多 4 次。
// 主动断开（peerBye）一律不重连。
const RETRY_WAITS = [0, 600, 1500, 3000];
function signalAlive() {
  return !!(guestPeer && !guestPeer.destroyed && guestPeer.open);
}
// 判定这条信令已经没救了：连同还没被取走的预热连接一起收掉，
// 下一轮 connectOnce 会老老实实新建一条，不再复用半死的 socket。
function dropGuestSignal() {
  try { if (guestPeer) guestPeer.destroy(); } catch (e) {}
  guestPeer = null;
  const w = takeWarmPeer();
  if (w) { try { w.destroy(); } catch (e) {} }
}
function scheduleGuestRetry() {
  if (guestAutoTimer) return true;       // 已经有重连在排队，别重复
  if (guestAutoTry >= RETRY_WAITS.length) {
    // 多次重连都找不到房主：房间多半已经关了，别留在聊天主页面
    guestRoomGone('与房间的连接中断后多次重连都没有找到房主，房间可能已关闭，已返回起始页。');
    return true;
  }
  // 信令还在就立刻重连；否则按退避表等，且给一次「刚断线马上恢复」的机会
  const wait = signalAlive() ? 0 : RETRY_WAITS[guestAutoTry];
  guestAutoTry++;
  setGuestActions('connecting');  // 自动重连期间仍算「连接中」
  if (guestTimer) { clearTimeout(guestTimer); guestTimer = null; }
  guestAutoTimer = setTimeout(() => {
    guestAutoTimer = null;
    if (peerBye || MODE !== 'guest' || !currentRoom) return;
    connectOnce(currentRoom);
  }, wait);
  return true;
}
// 网络恢复 / 页面切回前台：退避定时器还没走完也立刻插队重试一次，
// 不然手机解锁后还要干等好几秒才恢复聊天。
function flushGuestRetry() {
  if (MODE !== 'guest' || peerBye || !currentRoom) return false;
  if (guestConnState === 'connected' && guestConn && guestConn.open) return false;
  if (guestAutoTimer) { clearTimeout(guestAutoTimer); guestAutoTimer = null; }
  if (guestTimer) { clearTimeout(guestTimer); guestTimer = null; }
  try {
    if (guestConn) { guestConn.__ignoreClose = true; guestConn.close(); }
  } catch (e) {}
  guestConn = null;
  guestAutoTry = 0;             // 网络刚恢复，重新给满重试机会
  connectOnce(currentRoom);
  return true;
}
// 访客主动断开：通知对方、关连接、回到入口页
function dropGuestConn() {
  if (MODE === 'host' && isLanClient) { leaveLanRoom(); return; }
  if (dropBusy) return;            // 防连点：只收尾一次
  dropBusy = true;
  peerBye = true;
  setStatus('正在断开连接…');
  // 连接中点「断开连接」也要把探活/重连/超时定时器全停掉，
  // 否则退回起始页后 16 秒的超时回调还会回来改状态。
  if (guestTimer) { clearTimeout(guestTimer); guestTimer = null; }
  if (guestAutoTimer) { clearTimeout(guestAutoTimer); guestAutoTimer = null; }
  const c = guestConn;
  try { if (c && c.open) c.send('BYE'); } catch (e) {}
  setTimeout(() => {
    try { if (c) c.close(); } catch (e) {}
    try { if (guestPeer) guestPeer.destroy(); } catch (e) {}
    guestConn = null; guestPeer = null;
    stopScreenShare();
    resetToGate();
  }, 100);
}
function resetToGate() {
  applyDevicePrivacy();       // 退出房间后一律按「其他设备」处理
  dropBusy = false;           // 允许下一次进房重新点「断开连接」
  setGuestActions('connecting');  // 回起始页，按钮整排复位为隐藏
  setStatus('');              // 入口页不残留上一次的连接进度文字
  currentRoom = '';
  forgetJoinRoom();           // 已退出房间：清掉回连记录，刷新不再自动连回旧房间
  guestAutoTry = 0;
  guestGoneHits = 0;
  pullInFlight.clear(); pullQueue.length = 0; pullStartAt.clear();   // 清掉没完成的下载任务
  serverMsgs = []; localMsgs = [];
  seenIds = new Set();
  myName = '';
  showRoomCard('');
  document.getElementById('guestGate').style.display = 'none';
  document.getElementById('wxTip').style.display = 'none';
  showGuestTip('');
  setGuestProgress(-1);
  // 回入口页：收掉手上的共享画面和连接
  if (recvCall) { try { recvCall.close(); } catch (e) {} recvCall = null; }
  screenRecvStream = null;
  // 邀请链接带来的 ?room= 也要清掉，否则刷新又会自动连回去
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  renderAll();
  showGate();
  gateShowChoices();
  // 回到入口页就顺手把信令长连接重新预热好，再次加入时不用从零握手
  setTimeout(prewarmSignal, 300);
}
// 房间确认已不存在（房主销毁、房主页面关掉、房间码作废、多次重连失败）：
// 统一清干净连接并回到起始页，绝不让页面停在聊天主界面。
// guestGoneHandled 用来吃掉房主补发的重复 ROOM_CLOSED。
function guestRoomGone(tip) {
  if (MODE !== 'guest' || guestGoneHandled) return;
  guestGoneHandled = true;
  peerBye = true;                    // 关连接时别再触发自动重连
  if (guestTimer) { clearTimeout(guestTimer); guestTimer = null; }
  if (guestAutoTimer) { clearTimeout(guestAutoTimer); guestAutoTimer = null; }
  try { if (guestConn) guestConn.close(); } catch (e) {}
  try { if (guestPeer) guestPeer.destroy(); } catch (e) {}
  guestConn = null; guestPeer = null;
  stopScreenShare();
  resetToGate();                    // 里面把 guestGoneHandled 放开
  if (tip) gateMsg(tip, 'info');
}
// 访客被房主断开 / 拒绝：清掉连接、退回入口页，并说明原因。
// peerBye 必须置上，否则 conn 的 close 事件会把它当成掉线、自动重连回来。
function guestReturnToGate(msg) {
  peerBye = true;
  if (guestAutoTimer) { clearTimeout(guestAutoTimer); guestAutoTimer = null; }
  try { if (guestConn) guestConn.close(); } catch (e) {}
  try { if (guestPeer) guestPeer.destroy(); } catch (e) {}
  guestConn = null; guestPeer = null;
  stopScreenShare();
  resetToGate();
  if (msg) gateMsg(msg, 'err');
}
function connectOnce(room) {
  if (guestTimer) { clearTimeout(guestTimer); guestTimer = null; }
  // 这条旧通道是自己关的，别让它的 close 事件又触发一轮重连
  try {
    if (guestConn) { guestConn.__ignoreClose = true; guestConn.close(); }
  } catch (e) {}
  guestConn = null;
  setGuestActions('connecting');   // 自动重试期间同样算「连接中」
  setGuestProgress(-1);
  const fail = (msg, tip, retry, gone) => {
    // 已经主动断开 / 退回起始页了，迟到的超时或信令错误一律不再处理
    if (peerBye || MODE !== 'guest' || !currentRoom) return;
    if (guestTimer) { clearTimeout(guestTimer); guestTimer = null; }
    // 失败时把还没打通的通道自己收掉：它的 close 事件不能再触发另一轮重连，
    // 更不能因为「还没收到 WELCOME」把人直接踢回起始页，短重试才有机会生效。
    // 已经打通的通道不在这里动，交给 close 事件走正常重连。
    if (guestConn && !guestConn.open) {
      guestConn.__ignoreClose = true;
      try { guestConn.close(); } catch (e) {}
      guestConn = null;
    }
    // 信令说「这个房主 Peer 不存在」= 房间没了。但房主刷新页面时
    // Peer ID 也会短暂注销，所以连着两次确认不到才判定真的关闭。
    guestGoneHits = gone ? guestGoneHits + 1 : 0;
    if (guestGoneHits >= 2) {
      guestRoomGone('房间已不存在或房主页面已关闭，已返回起始页。可重新输入房间码加入。');
      return;
    }
    if (retry && guestRetry < 2) {
      guestRetry++;
      setStatus(msg + '，正在自动重试…');
      showGuestTip(tip);
      // 连不上时别反复复用同一条半死的信令 socket（网络切换后它常常看着还 open，
      // 其实已经收不到任何东西），换一条新的再试，成功率明显更高。
      dropGuestSignal();
      setTimeout(() => connectOnce(room), 400);
    } else if (gone) {
      // 第一次没找到房间：几秒后再确认一次，不留在主页面干等
      setStatus('正在确认房间是否还在…');
      showGuestTip('房主页面可能正在刷新，稍等几秒再确认一次。');
      setTimeout(() => {
        if (MODE === 'guest' && !peerBye && currentRoom) connectOnce(room);
      }, 2500);
    } else {
      failGuest(msg, tip);
    }
  };
  // 信令连接还活着就接着用：重连时省掉一整轮 WebSocket 握手 / Peer ID 注册，
  // 断线重连通常从 2～3 秒降到几百毫秒
  let p = guestPeer;
  if (!(p && !p.destroyed && p.open)) {
    try { if (p) p.destroy(); } catch (e) {}
    p = takeWarmPeer();                       // 入口页预热过就直接拿来用
  }
  if (!p || p.destroyed) p = new Peer(guestPeerId(), peerOpts());
  guestPeer = p;
  // 同一条信令连接可能被重试复用：事件只挂一次，回调走可替换的钩子，
  // 免得重试几次就挂上几份监听、报一个错弹好几次提示
  p.__failHook = { fn: (m, t, r, g) => fail(m, t, r, g) };
  if (!p.__wired) {
    p.__wired = true;
    wireGuestPeer(p, room, (m, t, r, g) => {
      const h = p.__failHook;
      if (h && h.fn) h.fn(m, t, r, g);
    });
  }
  const peer = p;
  const call = () => {
    if (peerBye || MODE !== 'guest' || !currentRoom) return;
    // 信令断线重连成功后也会再报一次 open：这时已经连着了就别再呼叫一遍，
    // 否则房主那边会多出一条重复连接
    if (guestConnState === 'connected' && guestConn && guestConn.open) return;
    setStatus('② 已连到信令，正在呼叫对方设备…');
    // 复用已有信令时，入口页那条没用上的预热连接顺手收掉，别白占一条 WebSocket
    const spare = takeWarmPeer();
    if (spare && spare !== peer) { try { spare.destroy(); } catch (e) {} }
    guestConn = peer.connect('pc-' + room, { reliable: true, metadata: identityMeta() });
    wireGuestConn(guestConn, (msg, tip) => fail(msg, tip, true), () => {
      if (guestTimer) { clearTimeout(guestTimer); guestTimer = null; }
      markGuestConnected();
    });
  };
  setStatus(peer.open ? '② 已连到信令，正在呼叫对方设备…' : '① 正在连接信令服务器…');
  // 10 秒还没连上就判超时：以前 16 秒干等太久，早一点换条信令重试更省时间
  guestTimer = setTimeout(() => fail('连接超时', '未能与对方设备建立直连，多为 NAT 限制或信令不通。建议两台设备连同一 WiFi 用局域网模式，或点右上角的网络图标配一台 TURN 中继服务器。', true), 10000);
  // 同一条信令连接只挂一次 open 监听，靠可替换钩子调用「最新一次」的 call：
  // 以前每次重试都新挂一个，open 一来会同时呼叫好几次，房主那边多出一堆幽灵连接
  peer.__callHook = call;
  if (!peer.__callWired) {
    peer.__callWired = true;
    peer.on('open', () => { const h = peer.__callHook; if (h) h(); });
  }
  if (peer.open) call();
}
// 连接期内的失败处理：留在当前页面，给出可操作的提示
function failGuest(msg, tip) {
  setGuestActions('failed');       // 先切状态，失败原因才不会被「已连接」规则丢掉
  setStatus(msg);
  showGuestTip((tip || '') + ' 可点上方「重连」再试一次。');
  refreshReady();
  renderAll();
}
// 对端 Peer 上的通用事件（信令断开、来电、错误）
function wireGuestPeer(peer, room, onFail) {
  peer.on('call', acceptScreenCall);
  peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
  peer.on('error', err => {
    const t = (err && err.type) || 'unknown';
    if (t === 'peer-unavailable') {
      // 信令明确找不到 pc-<房间码>：房间可能已销毁/换码，交给上层确认后回起始页
      onFail('未找到对方设备', '正在确认房间是否还在…', true, true);
    } else if (t === 'network' || t === 'server-error' || t === 'socket-error') {
      onFail('信令服务器连不上', '当前网络访问 PeerJS 公共信令服务器失败，可切换 WiFi / 蜂窝网络，或用系统浏览器打开。', true);
    } else {
      onFail('连接失败：' + t, '请确认对方页面开着、房间码正确。', true);
    }
  });
}
// 本机昵称：第一次进来生成一个，存在本地，刷新后还是这个名字
function myNick() {
  let n = '';
  try { n = localStorage.getItem('lanshare_nick') || ''; } catch (e) {}
  if (n) return n;
  const ua = navigator.userAgent || '';
  const kind = /iPhone|Android.*Mobile|Mobile Safari/i.test(ua) ? '手机'
             : /iPad|Tablet/i.test(ua) ? '平板' : '电脑';
  n = kind + Math.random().toString(36).slice(2, 4).toUpperCase();
  try { localStorage.setItem('lanshare_nick', n); } catch (e) {}
  return n;
}
// 这台设备自己的 ID：存在 localStorage 里，换房间也不变（清缓存才会变）。
// 局域网设备后端用 lsdev cookie 认人；外网设备不经过 8000 端口，只能靠这个值——
// HELLO 与连接元数据都带上它，房主报设备清单时用它标注是哪一台。
const DEV_ID_RE = /^[0-9a-f]{16}$/;
let _devId = '';
function readCookie(name) {
  const all = String(document.cookie || '').split(';');
  for (const s of all) {
    const i = s.indexOf('=');
    if (i < 0) continue;
    if (s.slice(0, i).trim() === name) {
      try { return decodeURIComponent(s.slice(i + 1).trim()); } catch (e) { return ''; }
    }
  }
  return '';
}
function writeCookie(name, val) {
  try {
    document.cookie = name + '=' + encodeURIComponent(val) +
      '; Max-Age=31536000; Path=/; SameSite=Lax';
  } catch (e) {}
}
function devId() {
  if (DEV_ID_RE.test(_devId)) return _devId;
  let v = '';
  try { v = localStorage.getItem('lanshare_dev_id') || ''; } catch (e) {}
  // 微信内置浏览器 / 隐私模式下 localStorage 可能不给写：退回 cookie 再存一份，
  // 否则每次都生成新 ID，同一台设备在设备清单里会变成好几个
  if (!DEV_ID_RE.test(v)) v = readCookie('lsdevp');
  if (!DEV_ID_RE.test(v)) {
    v = '';
    for (let i = 0; i < 16; i++) v += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  }
  try { localStorage.setItem('lanshare_dev_id', v); } catch (e) {}
  writeCookie('lsdevp', v);
  _devId = v;
  return v;
}
// 连接元数据：PeerJS 在「发起连接」这一步就能把它交给房主，
// 房主不用等数据通道打开、等 HELLO 才知道对面是谁
function identityMeta() {
  return { v: PROTOCOL, dev: devId(), nick: myNick() };
}
// 数据通道上的事件
function wireGuestConn(conn, onFail, onOpen) {
  conn.on('open', () => {
    // 显式声明二进制类型：个别手机浏览器默认按 Blob 给，拼分片就会全部失败
    try { if (conn.dataChannel) conn.dataChannel.binaryType = 'arraybuffer'; } catch (e) {}
    conn.send('HELLO:' + PROTOCOL + ':' + myNick() + ':' + devId());
    if (onOpen) onOpen();
  });
  conn.on('data', d => handleData(d, null));
  conn.on('close', () => {
    if (conn.__ignoreClose || peerBye) return;  // 自己换掉 / 主动断开的，不自动恢复
    // 还没拿到 WELCOME 就被关掉：房主那句 WELCOME 没发过来（页面关了、网络断了），
    // 这种情况不自动重连，退回入口页让用户自己决定
    if (!myName) {
      guestReturnToGate('没进得去：房间那边没有回应（房主的页面可能已经关闭）。请稍后重新加入。');
      return;
    }
    setGuestActions('connecting');
    refreshReady();
    renderAll();
    if (scheduleGuestRetry()) {
      setStatus('连接断开，正在自动重连…');
    } else {
      setGuestActions('failed');
      setStatus('连接已断开，可点「重连」再试');
    }
  });
  conn.on('error', e => {
    if (conn.__ignoreClose) return;
    onFail('数据通道错误', String(e && e.message ? e.message : e));
  });
}
// 访客从自己的 P2P 连接里读本机地址：取「选中候选对」的本地候选——
// 同 WiFi 是 192.168.x.x 内网地址，跨网是 STUN 反射出的公网地址，
// 和房主端设备清单里看到的是同一个，方便两边对号定位。
async function refreshSelfIp() {
  if (MODE !== 'guest') return;
  let ip = '';
  try {
    const pc = guestConn && guestConn.peerConnection;
    if (pc && pc.getStats) {
      const stats = await pc.getStats();
      let localId = '';
      stats.forEach(s => {
        if (s.type === 'candidate-pair' && s.localCandidateId &&
            (s.nominated || s.state === 'succeeded') && !localId) localId = s.localCandidateId;
      });
      if (localId) {
        stats.forEach(s => {
          if (s.type === 'local-candidate' && s.id === localId) {
            const a = s.address || s.ip || '';
            if (a && looksLikeAddr(a)) ip = a;
          }
        });
      }
    }
  } catch (e) {}
  if (ip) setSelfIp(ip);
}
function markGuestConnected() {
  if (guestTimer) { clearTimeout(guestTimer); guestTimer = null; }
  if (guestAutoTimer) { clearTimeout(guestAutoTimer); guestAutoTimer = null; }
  guestAutoTry = 0;
  guestGoneHits = 0;
  peerBye = false;
  // 连上后状态行整行收起，卡片只留「通道名 / 房间号 / 断开连接」
  setGuestActions('connected');    // 连上后只留「断开连接」
  setStatus('');                   // 顺手清掉连接阶段文字，掉线重连时不会翻旧账
  showGuestTip('');
  document.getElementById('wxTip').style.display = 'none';
  // 上一条通道上的下载请求一律作废：没下完的文件在新通道上重新点一次就行。
  // 不清的话 pullInFlight 会一直占着位，后面的下载全被堵死
  resetPullsForReconnect();
  ensurePullWatchdog();      // 连着的时候看门狗常开着：卡住的下载会被自动放行
  refreshReady();
  renderAll();
  setTimeout(() => { refreshSelfIp(); }, 1200);   // ICE 收敛后再读本机地址
}

// ===== 发送 =====
// 房主：文本/文件先落盘（局域网设备也能收到），再逐个推给房间里的外网设备
// 访客：只有一条通往房主的连接，发过去由房主代转
// 单个队列项的进度：百分比 + 平滑速度
function itemProgress(it, frac) {
  it.pct = Math.max(0, Math.min(100, frac * 100));
  const now = Date.now();
  if (!it._t) { it._t = now; it._lastPct = 0; }
  const dt = (now - it._t) / 1000;
  if (dt >= 0.35) {
    const inst = (it.pct - (it._lastPct || 0)) / 100 * it.file.size / dt;
    if (inst >= 0) it.speed = it.speed ? (it.speed * 0.6 + inst * 0.4) : inst;
    it._t = now;
    it._lastPct = it.pct;
  }
  updateItemUI(it);
}

async function sendAll() {
  const v = textInput.value.trim();
  const items = pendingFiles.filter(x => x.status === 'wait' || x.status === 'fail');
  if (!v && !items.length) return;
  // 房主一个人也能发：先落盘进房间记录，等有人加入时随 HISTORY 一起同步过去
  if (!canCompose()) {
    notify('还没有连上房间，请稍后再试');
    refreshReady();
    return;
  }

  if (v) {
    const mid = uid();
    if (MODE === 'host') {
      try {
        await fetch(API + '/text', {
          method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:'content=' + encodeURIComponent(v)
              + '&from=' + encodeURIComponent(myName || '房主')
              + '&id=' + encodeURIComponent(mid)
        });
      } catch(e) { toast('文本发送失败'); return; }
      pushedIds.add(mid);          // 已经直接推过了，别让轮询再转发一遍
      broadcast('TEXT:' + JSON.stringify({ t: v, f: myName || '房主', id: mid, time: nowHMS() }));
    } else {
      if (!canP2P()) { notify('还没有连上房间，请稍后再试'); return; }
      try { guestConn.send('TEXT:' + JSON.stringify({ t: v, f: myName || '访客', id: mid, time: nowHMS() })); }
      catch(e) { notify('发送失败: ' + e.message); return; }
      pushMsg({ type:'text', content:v, ip: myName || '我', id: mid });
    }
  }

  // 文件：房主先落盘再逐台直传；访客传给房主，由房主转给其他人
  if (items.length) {
    let failed = 0, done = 0;
    for (const it of items) {
      it.status = 'sending'; it.pct = 0; it.speed = 0; it.err = ''; it._t = 0;
      updateItemUI(it);
      try {
        if (MODE === 'host') {
          const fd = new FormData();
          fd.append('files', it.file, it.file.name);
          fd.append('from', myName || '房主');
          const r = await fetch(API + '/upload', {method:'POST', body: fd});
          const d = await r.json();
          if (!d.ok) throw new Error(d.msg || '上传失败');
          const mid = (d.ids && d.ids[0]) || uid();
          it.savedName = (d.names && d.names[0]) || it.file.name;
          pushedIds.add(mid);
          // 不向其他设备推送文件本体：广播一张卡片，谁需要谁点下载
          broadcast('FILE_CARD:' + JSON.stringify({
            id: mid, name: it.savedName, size: fmtSize(it.file.size), f: myName || '房主'
          }));
        } else {
          if (!canP2P()) throw new Error('还没有连上房间');
          const mid = uid();
          await sendFileTo(guestConn, it.file, it.file.name,
            p => itemProgress(it, p), mid, myName || '访客');
          pushMsg({ type:'file', name:it.file.name, size:fmtSize(it.file.size),
                    url:URL.createObjectURL(it.file), ip: myName || '我', id: mid });
        }
        it.status = 'done'; it.pct = 100; it.speed = 0;
        updateItemUI(it);
        done++;
      } catch(e) {
        failed++;
        it.status = 'fail'; it.err = (e && e.message) || '发送失败';
        updateItemUI(it);
        notify(it.file.name + ' 发送失败: ' + it.err);
      }
    }
    txEnd();
    // 发送完成的项立刻从列表清掉，不再留一栏「已完成」等手动清空；
    // 失败的项保留，方便点右侧 ↻ 重试
    pendingFiles = pendingFiles.filter(x => x.status !== 'done');
    renderPending();
    // 发送完成不弹提示：成没成看聊天里那张卡就知道，成功的项直接从列表消失。
    // 只有失败才弹——那是要用户处理的，不是「通知」。
    if (failed && done) {
      toast('部分文件发送失败，点失败项右侧的 ↻ 重试');
    }
  }

  textInput.value = '';
  autoGrow();
  if (MODE === 'host') setTimeout(loadMessages, 300);
}

function onAdminClick() {
  if (MODE !== 'host') return;
  // 局域网里的设备只是房间成员，不是房主：不给管理面板（也不该在界面上看到齿轮）
  if (isLanClient) { toast('管理入口只在房主那台电脑上'); return; }
  if (__IS_ADMIN__) {
    document.getElementById('adminModal').classList.add('show');
    loadDevices();
    startDevicePoll();
  } else { document.getElementById('loginModal').classList.add('show'); document.getElementById('adminPwd').focus(); }
}
function hideAdmin() {
  document.getElementById('adminModal').classList.remove('show');
  stopDevicePoll();
}

// 管理面板的设备清单：外网直连（房主上报的昵称 + WebRTC 读到的 IP）+ 局域网（后端记录）
let deviceTimer = null;
function startDevicePoll() {
  stopDevicePoll();
  deviceTimer = setInterval(loadDevices, 4000);
}
function stopDevicePoll() {
  if (deviceTimer) { clearInterval(deviceTimer); deviceTimer = null; }
}
async function loadDevices() {
  const ul = document.querySelector('#adminModal .dev-list');
  if (!ul) return;
  try {
    const r = await fetch(API + '/api/devices');
    const d = await r.json();
    if (!d.ok) return;
    const items = [];
    for (const x of (d.p2p || [])) {
      items.push(
        '<li><div class="dev-info">' +
        '<div class="dev-name">设备' +
        ' <span class="badge wan">外网</span><span class="badge online">在线</span></div>' +
        '<div class="dev-ip">IP: ' + esc(x.ip || 'IP 未知（NAT 后拿不到）') + ' · 点对点直连</div>' +
        '</div></li>'
      );
    }
    for (const x of (d.lan || [])) {
      let badge = '<span class="badge lan">局域网</span><span class="badge online">在线</span>';
      if (x.self) badge += '<span class="badge self">本机</span>';
      else if (!x.joined) badge += '<span class="badge idle">未进房间</span>';
      items.push(
        '<li><div class="dev-info">' +
        '<div class="dev-name">设备 ' + badge + '</div>' +
        '<div class="dev-ip">IP: ' + esc(x.ip) + ' · 最后活动: ' + esc(x.last || '') + '</div>' +
        '</div></li>'
      );
    }
    ul.innerHTML = items.length ? items.join('') :
      '<li><span style="color:#999;font-size:14px;">暂无设备连接</span></li>';
  } catch (e) {}
}
function hideLogin() { document.getElementById('loginModal').classList.remove('show'); }
async function adminLogout() { await fetch(API + '/admin-logout', {method:'POST'}); location.reload(); }
async function doLogin() {
  const pwd = document.getElementById('adminPwd').value;
  const r = await fetch(API + '/admin-login', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'password='+encodeURIComponent(pwd)});
  const d = await r.json();
  if (d.ok) { toast('登录成功'); setTimeout(()=>location.reload(),600); } else toast('密码错误');
}

