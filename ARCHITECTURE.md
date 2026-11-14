# 数据传输 · 架构与实现说明

> 面向**后续接手的开发者 / AI**。普通用户的使用说明看 [README.md](README.md)。
>
> 本文描述的是 **2.0.37** 的真实行为，不是设计稿。改代码前请至少读完第 3、7、11、12 节。

---

## 1. 文档定位与阅读顺序

| 想知道什么 | 看哪节 |
|---|---|
| 这东西由什么组成、跑在哪 | 2、4、6 |
| 改代码前不能碰的红线 | 3 |
| 页面是怎么拼出来的、为什么不能手改 `index.html` | 5 |
| 房间 / 通道 / 开关这些状态怎么互相影响 | 7 |
| 后端有哪些接口、鉴权怎么做的 | 8 |
| 两台设备之间发了哪些帧 | 10 |
| 文件到底怎么过去的、为什么这么写 | 11、13 |
| 为什么大文件不会中途掉线 | 12 |
| 怎么测、怎么打包、怎么发 | 15、16 |
| 每个版本修了什么、踩过什么坑 | 18 |

---

## 2. 一句话定位与技术栈

一个**单文件静态网页**加一个**可选的 Windows 本机服务**组成的临时互传工具。多台设备凭同一个 10 位房间码进入同一房间，互传文字、文件与桌面。没有账号、没有业务服务器、没有数据库。

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | 原生 JS，无框架、无构建工具 | 5 个业务 JS 拼进一个 `<script>`，共享作用域 |
| 音频视频 | WebRTC（`getDisplayMedia` + `RTCPeerConnection`） | 投屏走媒体轨，不占文件通道 |
| 信令 | PeerJS + 公共 STUN、公共 TURN 兜底 | PeerJS 打包在 `web/vendor.js`，无外部请求 |
| 后端 | Python 3.7+ 标准库，`ThreadingHTTPServer` | 单文件 `数据传输.py`，零第三方依赖 |
| 存储 | 磁盘（局域网房间）/ IndexedDB（纯网页房间） | 聊天记录只在内存 |
| 分发 | PyInstaller `--onefile` | 单 exe，内嵌同一份 `web/` |

**代码规模**：`数据传输.py` 约 2300 行；`web/` 下业务 JS 约 6300 行（`room.js` 占 4000 行），CSS 1460 行，HTML 骨架 410 行；`vendor.js` 是压缩过的 PeerJS。

---

## 3. 先读这七条（最容易踩）

1. **绝不直接改根目录 `index.html`。** 它是产物，下一次 `python 数据传输.py --export-page` 会整体覆盖。只改 `web/` 下的八个源文件。
2. **改完 `web/` 必须重新导出，再重新打包 exe。** exe 内嵌的是同一份 `web/`，两者必须成对更新，否则线上页和本机页的行为会分叉。
3. **PyInstaller 打包前一定 `rm -rf build dist`。** 增量构建会复用上次的 `EXE-00.toc`，`--add-data` 里的改动不会被收进去——表现是「3 秒打完、导出还说已是最新」，exe 里其实是旧界面。
4. **改了页面逻辑要跑四套测试**，并校验 exe 内嵌页面与磁盘 `index.html` 逐字一致（见第 16 节）。
5. **不要重新引入管理面板。** 2.0.11 起整套 admin（密码、会话、`/admin-login`、`/admin-logout`、`/delete`）已删净；`GET /api/devices` 也已下线（`POST` 那个仍在用）。注意 `数据传输.py` 里的 `is_admin()` 是 **Windows 提权检查**（加防火墙规则用），跟管理面板无关，别误删。
6. **协议字前缀长度是硬编码的。** 例如 `FILE_PULL_ERR:` 是 14 个字符，`FILE_ACK:` 是 9 个，改协议字必须同步改 `slice()` 里的数字，否则切坏 JSON、队列永久堵死。
7. **DataChannel 一旦 open，信令层的任何错误都不许影响它。** 这是「连接闪断」的唯一根源，细节见第 12 节。

---

## 4. 目录结构

仓库根目录同时是站点根目录和源码根目录：站点托管在 **GitHub Pages**，`git push`（或在网页上拖拽上传）即自动部署根目录的 `index.html`。

| 路径 | 职责 | 进仓库 |
|---|---|---|
| `index.html` | **产物**：站点入口、单文件静态页、零外链 | ✅ |
| `数据传输.exe` | **产物**：Windows 本机程序 | ✅ |
| `数据传输.py` | 后端：HTTP 服务、房间状态、上传下载、CORS、页面构建与导出、防火墙与看门狗 | ✅ |
| `web/page.html` | HTML 骨架 + 占位符 + 内联 SVG 图标 | ✅ |
| `web/app.css` | 全部样式；响应式按宽度 / 高度 / `hover:none` 三轴分离 | ✅ |
| `web/vendor.js` | 打包好的 PeerJS（单独注入，不参与拼接） | ✅ |
| `web/app.js` | 公共核心：常量、ICE 配置、DOM 小工具、通用状态 | ✅ |
| `web/cloud.js` | 纯网页房间的 IndexedDB 仓库 `Cloud` + `CloudStore` 路由 | ✅ |
| `web/store.js` | `API` 接缝：`apiFetch()` 把 HTTP 请求改写成对 `Cloud` 的本地调用 | ✅ |
| `web/room.js` | 房间内的一切：长轮询、P2P 收发、分片、成员、侧栏、倒计时、销毁、投屏 | ✅ |
| `web/gate.js` | 入口页：探活、创建、加入、刷新恢复、下载 exe、启动分发（文件末尾立即执行） | ✅ |
| `client_url.txt` | **在线地址单一来源**：CORS 白名单、邀请链接、二维码、exe 下载地址都由它推算 | ✅ |
| `version_info.txt` | exe 版本资源（`filevers` / `prodvers` / `FileVersion` / `ProductVersion` **四处一起改**） | ✅ |
| `tests/smoke.py` | 后端冒烟 66 项 | ✅ |
| `tests/cloud_store.test.mjs` | 云仓库 44 项 | ✅ |
| `tests/transfer.test.mjs` | 传输层 31 项 | ✅ |
| `tests/render.test.mjs` | 消息渲染 16 项 | ✅ |
| `tests/no-undef.mjs` | 未声明变量 0 个（必须为 0） | ✅ |
| `tests/risk-scan.mjs` | 同类隐患清单（信息性，不判失败） | ✅ |
| `tests/lib/acorn.mjs` | acorn 8 的单文件构建，给上面两个静态检查解析语法；MIT 原样保留，不要改 | ✅ |
| `build/` `dist/` | PyInstaller 中间产物 | ❌ |
| `数据/` | 运行时目录，启动时由 `os.makedirs(ROOM_ROOT)` 自动重建 | ❌ |

> 若以后重新启用 git 托管，**必须补回 `.gitignore`**（排除 `build/` `dist/` `数据/` `__pycache__/`）和 `.gitattributes`（`* -text`）——否则 `index.html` 的换行被转换会导致指纹比对失效。

---

## 5. 页面构建流水线

```
web/page.html ─┐
web/app.css   ─┤
web/vendor.js ─┤
web/app.js    ─┼─→ build_page(mode, p2p, join_required) ─→ 一份完整 HTML
web/cloud.js  ─┤       _fill() 替换占位符
web/store.js  ─┤       5 个业务 JS 按 app→cloud→store→room→gate 拼进同一个 <script>
web/room.js   ─┤       （函数声明提升，顶层 let/const 在启动分发前执行完）
web/gate.js   ─┘
                    ├─ host 模式：本机服务直接在响应里返回
                    └─ guest 模式：export_static_page() 写根目录 index.html
```

`--export-page` **只写根目录一处**。启动服务时不会导出——否则一个正在运行的旧 exe 重启时，会把内嵌的旧页面覆盖回磁盘。

### 页面指纹

`_page_build_fingerprint()` 把八个源文件按 `page.html → app.css → vendor.js → app.js → cloud.js → store.js → room.js → gate.js` 的顺序做 md5，取前 10 位注入 `__PAGE_BUILD__`。

邀请链接与二维码都带 `?v=<指纹>`：页面一改，所有外发 URL 自动变化，用来穿透微信 X5 / iOS Safari 的顽固缓存。顶栏「房间说明」底部显示的「页面版本」就是这个值，也是线上是否更新成功的唯一凭据。

### 模板占位符

| 占位符 | 含义 |
|---|---|
| `__SERVER_MODE__` | `host` / `guest`，决定 `SEED_MODE` |
| `__PORT__` | 服务端口，固定 8000 |
| `__ROOM__` | 房间码（仅 host 模式有值） |
| `__HAS_ROOM__` | 本机是否已有房间 |
| `__CLIENT_URL__` | `client_url.txt` 的内容（按 JS 字面量转义） |
| `__P2P_ENABLED__` | **只有**「别人从局域网 IP 打开本机服务」时为 `false`，其余一律 `true`（含在线页） |
| `__ROOM_P2P__` | 当前房间的外网开关状态，刷新时恢复 |
| `__JOIN_REQUIRED__` | 局域网设备还没输房间码 |
| `__LAN_URL__` | `http://<局域网IP>:8000` |
| `__PAGE_BUILD__` | 10 位指纹 |
| `__HOST_DISPLAY__` / `__GUEST_DISPLAY__` | 按模式隐藏房主 / 访客专属卡片 |
| `__APP_CSS__` / `__VENDOR_JS__` / `__APP_JS__` | 直接整段替换，不走 `_fill()` |

---

## 6. 运行形态：三个地址、三种房间

### 三个地址

| | 在线页 | 本地地址 | 局域网地址 |
|---|---|---|---|
| 网址 | `https://zvzqvqdvd.github.io/data-transmission/`（以 `client_url.txt` 为准） | `http://127.0.0.1:8000` | `http://192.168.x.x:8000` |
| 谁提供 | GitHub Pages 静态托管 | 房主 exe 起的 `ThreadingHTTPServer` | **同一个服务**的另一个入口 |

后两个是同一个后台进程的两个入口，在线页只是门面。只有创建时选了「局域网」，在线页才会跨域访问 `127.0.0.1:8000` 来驱动本机服务。关掉 exe 后，在线页仍能创建纯网页房间。

外网设备**只能走在线页**：房主的 8000 端口没有公网映射，靠 WebRTC 点对点直连房主页面。

### 三种房间

创建时二选一（2.0.14 起原来的「两者同时」并入了房间开关）：

| | 纯网页房间 | 局域网房间 |
|---|---|---|
| 后端 | 无，`Cloud` 用 IndexedDB 模拟一套 HTTP 接口 | 本机 exe |
| 文件存哪 | 房主浏览器 IndexedDB | 房主磁盘 `数据/房间/<码>/接收文件/` |
| 谁能进 | 外网访客（P2P） | 同一 WiFi 的 HTTP 设备；外网默认关，房间内可拨开 |
| 容量 | 动态：可用空间 × 80%，单文件 ≤ 总量 × 10%；可用空间低于 32 MB 视为探测失败、全房禁传 | 磁盘，单文件上限默认 4 GiB |
| 聊天记录 | IndexedDB（`meta` + `msgs` 两个 key） | 进程内存 `MESSAGES` |

### 正交状态量

| 变量 | 取值 | 含义 |
|---|---|---|
| `MODE` | `host` / `guest` | 我是房主页面还是访客页面 |
| `CHANNEL` | `lan` / `cloud` | 有后端 / 纯网页 |
| `P2P_ON` | bool | 本房间外网这扇门开不开（局域网房间默认 `false`） |
| `isLanClient` | bool | 本页是「别人从局域网 IP 打开本机服务」，只能加入 |
| `JOIN_REQUIRED` | bool | 还没输房间码，停在入口页 |
| `SEED_MODE` | `host` / `guest` | 页面模板出生时的身份，运行中不改 |
| `PROTOCOL` | `4` | DataChannel 协议版本 |
| `ROOM` / `API` | 字符串 | 当前房间码 / 后端基址（云房间 `API` 为空，由 `store.js` 接管） |
| `ROOM_MAX` | `6` | 从 `/api/host` 的 `max_members` 覆盖 |

**`__P2P_ENABLED__` 与 `P2P_ON` 不是一回事**：前者是「这份页面有没有能力当外网房主」（编译期），后者是「这个房间此刻开不开门」（运行期）。2.0.15 曾把两者混为一谈，导致在线页建的局域网房间既没有外网也没有开关。

---

## 7. 后端架构

单文件 `数据传输.py`，`ThreadingHTTPServer` + 一个 `BaseHTTPRequestHandler`。**聊天记录只在进程内存里**，不落盘。

### 7.1 全局状态

| 变量 | 作用 |
|---|---|
| `ROOM` / `ROOM_P2P` | 当前房间码（只在内存，进程退出即失效）/ 外网开关 |
| `MESSAGES` / `_MSG_VER` | 消息列表 / 内容版本号 |
| `CLIENTS` / `DATA_LOCK` | 设备表（cookie `lsdev`、是否 `joined`、最后活跃）/ 全局 `RLock` |
| `P2P_REPORT` / `P2P_DEVICES` / `ROOM_NUMS` | 房主上报的外网设备数、清单、头像编号 |
| `_ACTIVITY` / `_HOST_PAGE` / `_HOST_GONE` | 最后通信时间 / 房主心跳 / 房主告别时间 |
| `ROOM_IDLE_MAX=3600` | 60 分钟无通信销毁 |
| `ROOM_HOST_GONE_MAX=60` | 房主页面告别后 60 秒不回来销毁 |
| `ROOM_MAX_MEMBERS=6` | 房主 + 5 |
| `MAX_FILE_SIZE=4 GiB` | 单文件上限，可用环境变量 `DATATRANSMISSION_MAX_FILE_SIZE` 覆盖 |
| `PEER_TIMEOUT=25` | 设备超过 25 秒没发过任何请求就算离开 |
| `LONGPOLL_MAX_MS=20000` / `LONGPOLL_TICK=0.15` / `LONGPOLL_TOUCH=5` | 长轮询上限 / 检查间隔 / 续活跃间隔 |
| `LOCAL_IPS_TTL=2.0` | 本机地址集合最多缓存 2 秒（换 WiFi / 插网线后能立刻跟上） |

**人数口径**：`room_member_count() = 1（房主）+ lan_peer_count() + p2p_report_count()`。外网设备不访问 8000，只能靠房主页面每 5 秒上报的数字合并计数；`P2P_REPORT` 有 TTL，房主页面不在线就不算数。两侧各自 ≤6，中间存在极小的并发竞态（没有跨通道原子锁）。

### 7.2 路由表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/`、`/index.html` | 返回 `build_page('host', p2p=是否回环, join_required=…)` |
| GET | `/api/host` | 在线页探活本机程序：`has_room` / `room` / `ip` / `port` / `p2p` / `peers` / `members` / `max_members` / `max_file` / `client_url` / `idle_left` / `data_dir` |
| GET | `/messages` | 长轮询；`rev` 相同则只回状态字段（含 `max_file`）；`wait` 最长 20 秒 |
| GET | `/download?name=` | 从当前房间 `接收文件/` 读文件，支持 `Range` |
| DELETE | `/file?name=` | **房主清理文件**：删磁盘那份 + 对应消息，房间码不动（仅回环） |
| POST | `/api/join` | **唯一不需要凭证的写接口**：验房间码、发 `lsroom` cookie；满员 409 |
| POST | `/api/stats` | 房主上报外网设备数（仅回环） |
| POST | `/api/devices` | 房主上报外网设备清单 + 编号表（仅回环） |
| POST | `/api/room/heartbeat` | 房主心跳（10 秒），回包带 `idle_left` |
| POST | `/api/room/bye` | 房主页面关闭时 `sendBeacon` 告别 |
| POST | `/api/room/create?p2p=0\|1` | 建房；已有房间则沿用同一个码、只更新开关 |
| POST | `/api/room/p2p?on=0\|1` | **只拨外网这扇门**，不换码、不动磁盘数据 |
| POST | `/api/room/renew` / `/dissolve` | 换码 / 销毁 |
| POST | `/api/room/open` | 旧页面兼容，等价于 create |
| POST | `/upload` | multipart 流式落盘，同名加序号，防路径穿越 |
| POST | `/text` / `/screen` | 追加文本 / 更新投屏卡状态 |
| OPTIONS | `*` | CORS 预检（方法含 `DELETE`，放行 `Range`，暴露 `Content-Range`） |

**已删除**：`/admin-login`、`/admin-logout`、`/delete`、`GET /api/devices`。冒烟测试里有断言保证它们返回 404。

### 7.3 鉴权与来源

| 函数 | 作用 |
|---|---|
| `is_loopback()` | 决定打开的页面是房主模板还是「只能加入」的局域网模板 |
| `is_self_client()` | 只有回环地址能操作 `/api/room/*`、`/api/stats`、`/api/devices` |
| `_join_cookie_ok()` / `_lan_needs_join()` | 局域网设备必须先 `POST /api/join` 拿到 `lsroom` cookie |
| `_allowed_origins()` / `_origin_ok()` | CORS 白名单 = `client_url.txt` 的主页（同主机同时放行 http/https）+ 回环地址；**不带 `Origin` 的写请求只放行回环与持有效 join cookie 的设备** |
| `is_admin()` | **Windows 提权检查**，用于 `netsh` 加 8000 端口防火墙规则，与 Web 无关 |

### 7.4 房间生命周期

```
点「创建房间」→ create_room() 生成 10 位码（32 字母表，去掉 I/O/0/1）、
                 建 接收文件/、重置消息与编号
      ↓
  活着：/text、/upload、/api/join、/download、心跳都会 touch_activity()
      ↓
销毁 dissolve_room()：码作废 + purge_room_dir() 删整个文件夹 + 清内存
  触发：① 房主点销毁（立即）
        ② 60 分钟无通信（room_watchdog 每 10 秒检查）
        ③ 房主页面告别后 60 秒没回来
  刷新不算销毁：页面重开会重新上报心跳
```

倒计时：云房间用 `Cloud.lastActive` 本地算；局域网房间用 `/api/room/heartbeat` 回包的 `idle_left` 每 10 秒对表（`idleBase{left,at}` + 每秒 tick），没对上表显示 `--:--`，剩不到 5 分钟转告警色。

### 7.5 长轮询

`/messages` 是唯一的房间状态通道，扛着聊天记录、设备清单、人数、开关、关闭信号。

- 客户端带 `rev`（内容指纹，md5 前 12 位）。相同就只回状态字段 + `unchanged:true`，不重发整包
- 挂起期间每 150 ms 检查一次：先比文件指纹（`messages_fp()`），没变就只重算状态，省掉整包序列化
- 每 5 秒 `touch_client()` 续活跃，避免被 `PEER_TIMEOUT` 误判离开
- 房间被解散时立刻放行，不让客户端干等到 20 秒超时
- `_messages_snapshot()` 会过滤掉磁盘上已不存在的文件消息；`room_state_key()` 单独感知「人数 / 设备 / 开关」这类非消息变化

### 7.6 上传落盘

`/upload` 用自写的流式 multipart 解析（`_MultipartStream`），不把整个请求读进内存：

- 请求体上限 `MAX_FILE_SIZE + 1 MiB`，超了直接 413
- **房间码在请求开始时快照**，整段读取都用它——期间房间被销毁也不会写进 `UNKNOWN/` 孤儿目录
- `unique_path(name, room)` 用 `'xb'` 独占创建，并发同名不会互相覆盖
- 解析失败或读完后发现房间已解散 → `_rollback_saved()` 把本次已写文件整单删除
- 每个文件追加一条 `MESSAGES` 记录；`from` / `id` 由房主代外网设备转存时带上

### 7.7 下载与 Range

`/download` 只接受 `basename`，拒绝控制字符（含 NUL，否则 Python 3.8+ 会抛 `ValueError` 把线程挂死）。

`_serve_file()` 解析单区间 `Range`：`bytes=a-b`、`bytes=a-`、`bytes=-n` 都支持，正常返回 206 + `Content-Range`，越界返回 416 + `Content-Range: bytes */size`。正文按 64 KB 分块写，`BrokenPipe` 直接收手。

`DELETE /file?name=` 是「清理空间」的后端一半：只认回环（房主页面），文件名同样只取 basename 并拒绝控制字符；删磁盘那份 + `MESSAGES` 里同名的 file 记录，再 `bump_messages()` —— 长轮询立刻把「文件没了」推给所有设备，谁也不用刷新。文件正被下载线程打开时 Windows 会拒绝删除，此时回 500 并带上真实原因，不假装成功。云房间没有这条路径，走 `Cloud.deleteFiles()` 删 IndexedDB 里的 Blob 与消息。

### 7.8 启动、单实例与清理

```
main()
 ├─ --setup-firewall [--watch PID] → 提权看门狗：补规则、守进程、退出时删规则 + 清残留房间
 ├─ --export-page                   → 只导出静态页，不启服务、不碰防火墙
 ├─ already_running()               → 命名互斥体，已有实例就提示并退出（不白弹 UAC）
 ├─ 绑定 0.0.0.0:8000               → 先绑定再后台线程 serve_forever（UAC 期间设备已能连）
 ├─ 提权加防火墙规则 / 启动看门狗   → 两步都「先亮标签、做完补结果」
 └─ 后台线程 _purge_old_rooms_bg()  → 清上次运行残留（当前房间不动）
```

退出走 `os._exit(0)`：收尾都在独立的提权看门狗里完成，主进程不做解释器收尾，关窗口立刻结束。

---

## 8. 前端模块与关键全局

| 文件 | 关键内容 |
|---|---|
| `app.js` | `CHUNK_SIZE=65536`、`MAX_BUFFERED=2MB`、`ICE_SERVERS`（4 STUN + 2 TURN）、`customIce()`（localStorage `lanshare_ice`）、`prewarmSignal()`/`takeWarmPeer()`、`pendingFiles`、`toast()`/`notify()`、`esc()` |
| `cloud.js` | `Cloud`：`probeQuota()` / `createRoom()` / `resume()` / `dissolve()` / `cleanupOrphans()` / `startIdleWatch()` / `handleUpload()` / `handleDownload(query, opts)`；`CloudStore.handle()` 把 `/messages`、`/text`、`/upload`、`/download` 接成 IndexedDB 调用 |
| `store.js` | `apiFetch()`：云房间把 `API+path` 改写成本地 `Cloud` 调用，其余照常 `fetch` |
| `room.js` | 长轮询、P2P 连接管理、文件收发、成员清单、侧栏渲染、倒计时、销毁、投屏 |
| `gate.js` | 入口页全部逻辑、`probeRoom()` 加入前探活、exe 下载器（`DLM`，支持暂停/续传）、启动分发 |

`room.js` 里的重要全局：

| 名称 | 用途 |
|---|---|
| `hostConns: Map` | 房主侧每条外网连接（昵称 / IP / `lastPong` / `missed` / `bufAt` / `__sending` / `__finishing`） |
| `recvBuf: Map` | **每条连接一个接收槽** |
| `chunkChains: Map<key,Promise>` | 每连接一条二进制分片异步链（2.0.28 前是全局单链） |
| `sendChains: Map` | 每连接的串行发送链 |
| `pcPeer` / `guestPeer` / `guestConn` | 房主 Peer / 访客 Peer / 访客数据连接 |
| `pushedIds` / `relaySeeded` | 防重复转发 |
| `pullQueue` / `pullInFlight` / `pullStartAt` / `partialPulls` | 下载队列、在途标记、看门狗基准、续传残片 |
| `DL_JOBS: Map` | 房主侧 HTTP 下载任务（分片、进度、暂停、取消） |
| `fileAckWaiters` / `peerAck` | 文件回执等待表 / 对方是否支持回执 |
| `roomClosed` / `dissolving` / `guestGoneHandled` / `peerBye` | 收尾状态守卫 |
| `idleBase` / `pollGen` / `msgFailStreak` | 倒计时基准 / 轮询代际 / 失败计数 |

---

## 9. 启动分发（`gate.js` 末尾）

```
MODE === 'host'
  ├─ JOIN_REQUIRED        → showLanGate()      只能加入
  ├─ !HAS_ROOM            → showHostGate()     等点「创建房间」
  └─ 有房间               → initHost()         直接恢复
MODE === 'guest'（在线页）
  prewarmSignal()  先预热信令连接
  resuming = invited || ?host=1 || sessionStorage 里有房间码
  bootMask(resuming)   恢复类入口先不摆起始页（body.booting 遮住房间壳）
  ├─ ?room=<码>        → hideGate(); initGuest(码)
  ├─ ?host=1           → resumeHostFromWeb() / resumeCloudHost()
  ├─ 有 savedJoinRoom  → hideGate(); initGuest(saved)
  └─ 都没有             → showGate() 等手动输码
```

`showGate()` / `hideGate()` 统一解除 `body.booting`，失败路径不必各自记得清。恢复路径**不等 `prepareHostPeer`**（2.0.17）：Peer 交给 `startHostUI → startHostPeer` 后台挂上，外网卡本来就有「正在接入信令服务器…」这一态。

加入前一定先 `probeRoom()`：在真实数据通道上发 `HELLO`、等 `WELCOME`。码不对 / 房间已结束 / 外网已关都在入口页说清，不会进一个收不到东西的空房间。

---

## 10. DataChannel 协议

`PROTOCOL = 4`。字符串帧是 `前缀:JSON` 或裸指令，二进制帧是文件分片（通常是 ArrayBuffer，个别 WebView 给 Blob）。

**前缀长度硬编码**：`FILE_ACK:`=9、`FILE_END:`=9、`FILE_META:`=10、`FILE_PULL:`=10、`FILE_PULL_ERR:`=14。改协议字必须同步改 `slice()`。

| 帧 | 方向 | 作用 |
|---|---|---|
| `HELLO:<版本>:<昵称>:<设备ID>` | 访客→房主 | 握手；版本不符触发 `protoMismatch` |
| `WELCOME:{"name","proto","ack":1}` | 房主→访客 | 分配名字；`ack:1` 协商「房主会回文件回执」 |
| `HISTORY:{"messages":[…]}` | 房主→访客 | 最近 200 条历史 |
| `PEERS:{"nf":0\|1}` | 房主→访客 | `nf=1` 表示探测不到配额，全房禁传 |
| `NUMS:{名字:编号}` / `SELFIP:<IP>` | 房主→访客 | 头像编号表 / 回告对方 IP |
| `TEXT:{t,f,id,time}` / `NOTE:{t}` | 双向 | 文本 / 一次性提示 |
| `FILE_CARD:{id,name,size,f}` | 房主→访客 | 文件卡片（不含本体），谁要谁拉 |
| `FILE_META:{id,v,name,size,mid,f,off?}` | 发→收 | 开始一次传输；`off` 存在表示从该偏移续传，旧客户端忽略 |
| `<ArrayBuffer / Blob>` | 发→收 | 分片，每片 ≤ `chunkSizeFor(c)` |
| `FILE_END:<id>` | 发→收 | 声明发完；字节不足时给 9 秒宽限重组 |
| `FILE_ACK:<id>` / `FILE_NAK:<id>` | 房主→访客 | 收全并落盘成功 / 缺片或保存失败 |
| `FILE_PULL:{mid,name,off}` / `FILE_PULL_ERR:{mid,name}` | 双向 | 请求下载（`off` 为已收字节数）/ 文件已不存在 |
| `PING` / `PONG` | 房主↔访客 | 每 5 秒探活；连续两次超时才摘设备 |
| `P2P_OFF` | 房主→访客 | 「外网加入」被关，访客退回起始页 |
| `QUOTA:{kind,ok,total,used,max}` | 房主→访客 | 存储与单文件上限同步；`kind=cloud` 有总量/已用，`lan` 只有 `max` |
| `FILE_GONE:{names:[…],ids:[…]}` | 房主→访客 | 房主清理了这些文件，接收端按名字或 id 把卡片标成「已清理」（**不删记录**） |
| `FILE_ABORT:{id}` | 发送方→接收方 | 发送被取消，接收端立刻丢掉这条的半截缓冲，不必等超时 |
| `ROOM_CLOSED` | 房主→访客 | 房间销毁（补发两次防弱网丢首包） |
| `FULL:{"max":6,"total":5}` | 房主→访客 | 人数已满，明确拒绝；后面紧跟 `BYE` 给旧版访客兜底 |
| `BYE` | 双向 | 主动断开 / 换码时把设备请出去 |
| `SCREEN_START:` / `SCREEN_STOP:` / `SCREEN_CARD:` | 双向 | 投屏卡状态 |
| `SCREEN_WATCH` / `SCREEN_RECALL` / `SCREEN_END` | 双向 | 补看 / 召回 / 结束 |

---

## 11. 文件传输的三条链路

### ① 房主 / 局域网设备发文件（HTTP，最快）

`POST /upload` 流式落盘 → 后端追加消息 → 房主长轮询拿到新消息 → `relayNew()` 只广播 `FILE_CARD`，**不推本体**。谁需要谁点下载。

### ② 外网访客发文件（WebRTC 分片）

`sendAll()` 串行 `await` 每个 `sendFileTo()`（互斥包装，连按发送不会串包）→ `FILE_META` + 分片 + `FILE_END` → 等 `FILE_ACK` 才标完成。

房主侧 `handleData` 用 `recvBuf` 按连接累积分片，`finishRecv()` 拼 Blob → `await onFileReceived()` → `POST /upload` 落盘 → 成功回 `FILE_ACK`，失败回 `FILE_NAK`；缺片 9 秒后 `dropRecv()` 回 NAK。

### ③ 下载（房主 → 访客，P2P 分片）

访客点下载 → `pullFile()` 入 `pullQueue` → `pumpPullQueue()` 一次只放一个 `FILE_PULL` → 房主 `queueConnSend` 串行 `GET /download` + `sendFileTo` → 访客收全后交给浏览器保存。

房主侧也支持 `DL_JOBS` 队列里的 HTTP 直下（局域网设备），按 2 MB 一批合 Blob，避免一次性 `response.blob()` 把大文件读进内存。

### 硬约束（血泪史，别改错）

- **序列化必须是 `raw`。** 两处 `peer.connect(..., {serialization:'raw'})`。默认 BinaryPack 会把 64 KB 分片按 `chunkedMTU=16300` 拆成 5 条带序号消息，逐条编码、send、走回调，接收端再缓存重组；`raw` 下 `_send()` 直接 `_bufferedSend(ArrayBuffer)`，一帧到底，每 1 MB 的 send／回调从 80 次降到 16 次。**枚举值是 `'raw'` 不是 `'none'`**，写错会拿到 `undefined` 构造器。
- **分片大小随链路放大。** `chunkSizeFor(c)` 读 `pc.sctp.maxMessageSize`，≥256 KB 时 64 KB→128 KB（每 1 MB 再降到 8 次）。协商值拿不到或偏小就退回 64 KB 全平台安全档；一次传输内固定，不忽大忽小。超过 `maxMessageSize` 的 `send()` 会抛错丢片，别猜大数。
- **背压读字节，不读条数。** `buffered(c)` 必须读 `c.dataChannel.bufferedAmount`；PeerJS 的 `c.bufferSize` 是排队消息**条数**（2.0.18 前读错字段，背压恒不成立，10 个文件一次灌爆 SCTP）。低水位阈值必须等于续发条件（都取 `MAX_BUFFERED`）。
- **`FILE_END` 的 9 秒宽限不能删。** 旧版发起方建的 BinaryPack 连接仍可能晚到尾片，SCTP 重组本身也有延迟；2.0.18 前一看到不齐就丢包，手机端图片全废。
- **`recvBuf` 每条连接只有一个槽。** 同一连接上的发送必须串行（访客靠 `sendAll` 的 `await`，房主下载靠 `queueConnSend`）；等回执期间不发下一个 `FILE_META`。
- **分片可能是 Blob。** 微信 X5 / 部分安卓 WebView 会给 Blob，必须走 `chunkChains` 异步读成 ArrayBuffer，不能当 null 丢掉。
- **ACK 超时按文件大小给**（20–90 秒，`fileAckTimeout()`）。固定 20 秒时慢网大文件房主其实已落盘，访客却先判失败并重试，会存出两份。
- **`failAllFileAcks()` 必须在所有收尾路径调用**：`resetToGate`、`guestRoomGone`、`guestReturnToGate`、`onRoomClosed`、`applyRoomP2P(false)`。否则 `sendAll` 挂几十秒，迟到回执还会把文件卡片塞回已清空的聊天列表（幽灵消息）。
- **身份是 `(房间码, 设备ID)`，不是随机 Peer ID。** 刷新 / 重连时新连接按 `dev` 顶掉旧的（`registerGuest`），不会出现两条「设备 2」；`pagehide` 发 `BYE`，房主不用等超时。
- **`WELCOME.ack` 是向后兼容开关。** 旧房主不回执，新访客不等；`gate.js` 探活与 `room.js` 的 `handleData` 两处都要读。
- **吞吐上限 ≈ `MAX_BUFFERED ÷ RTT`**。2 MB 在 100 ms RTT 下约 20 MB/s，这是直连的天花板。若 ICE 落到公共 TURN，速率由中继方限定，调窗口和分片都没用——先确认是不是 relay，别去改 STUN。

---

## 12. 稳定性设计

对手项目 `MatrixSeven/file-transfer-go` 的「稳」不来自重传算法，而来自三条纪律：房间常驻、服务端主动推断开、任何信令异常都不碰已建立的 PeerConnection。本项目没有自建信令，只能把同样的纪律落在客户端。

### 12.1 加入：不闪、不僵尸

- **分阶段超时**：信令没通给 24 秒，通了但通道没谈成给 18 秒（旧版 15/12 秒在 4G 弱信号下反复误判，每误判一次就重发一轮呼叫，用户看到的就是「闪一下又连上」）。
- **软重试只重发呼叫**：`softRetry()` 最多 4 次，每次间隔 15 秒，绝不销毁信令重来。
- **所有重试定时器统一收编**：`guestRetryTimer`、`guestAutoTimer`、`p2pOffTimer` 都存 id，收尾路径统一清；回调里还要复核 `peerBye`、`MODE`、`currentRoom` 是否没变——否则退出房间后仍会重建僵尸 Peer、改写入口页状态。
- **`unavailable-id` 是正常现象**（重连时服务器还没释放旧 ID）：换新 ID 静默重建，不当作连接失败；`peer-unavailable` 表示房主还没注册上，退避重试即可。
- **`callInFlight` 防重复呼叫**：`peer.on('open')` 只挂一次监听，通过可替换钩子调用最新一次 `call`；旧写法每次重试都新挂一个，`open` 一来会同时呼叫多次，房主那边多出一堆幽灵连接。
- **还没收到 `WELCOME` 就断开**不直接踢回入口页，先走 `scheduleGuestRetry()`。
- **回前台体检**：`connDead()` 检查 `PeerConnection` 是否已 `failed/closed`，假连接立刻重连。

### 12.2 心跳：传输中必须让路

`PING` 和文件分片共用同一条「可靠 + 有序」通道。传 1 GB 时 `PING` 排在几千条分片后面，`PONG` 迟迟不回，60 秒后连接会被判「人已离开」并摘掉——**这是大文件中途掉线的真因**（2.0.27 修复）。

现在 `scanHostConns()` 的判据是：

```
隐藏标签页 / __finishing 落盘中        → 不判死、不发 PING
有接收缓冲 / bufferedAmount>0 / __sending → 有字节在动就不判，连 PING 都不发
                                            两分钟一个字节没动（bufAt）→ 才判死
空闲连接：lastPong 超 30 秒记一次 missed，连续两次 → 摘
pcState === 'failed'：先给 8 秒观察期（ICE 可能自愈）
握手未完成（20 秒内且未 registered）：放过
```

被摘的连接如果还有半截文件，`dropStaleConn()` 先回 `FILE_NAK`，发送端不用干等 20–90 秒回执超时。

**反方向也要有**（2.0.35）：上面这套只解决「房主看加入者」。加入者看房主靠 `startGuestPing()`——15 秒静默主动敲一次，连续两次没回音判链路已死，因为房主直接关页面时 `ROOM_CLOSED` 发不出来，而 SCTP 要 30 秒以上才自己发现。另外加入者原先**从不回 PONG**（`handleData(d, null)` 里拿不到 `ctx.conn`），安静的设备会被这套 PONG 超时误摘，2.0.35 一并修好。细节见 12.7。

### 12.3 信令与通道解耦

- `wireGuestPeer` 的 `disconnected`/`error`、`connectOnce` 的 `fail()` 都有 `guestConnState==='connected' && guestConn.open` 的短路；
- 信令 `reconnect()` 带退避（访客 1.5 秒防抖、房主 1.5/3/6 秒），失败不换房间码、不踢人；
- 房主 `unavailable-id` 在房间有人时直接放弃抢码，不为一个 ID 把全房间踢出去。

### 12.4 收尾：一次、干净

```
房主点销毁 → POST /api/room/dissolve → onRoomClosed(tip)
  ├─ 给每台外网设备发 ROOM_CLOSED（0ms + 180ms 补发），600ms 后 close
  ├─ Cloud.dissolve()、stopPolling / stopRoomStat / failAllFileAcks
  └─ showGate() + gateMsg(tip,'warn')
访客收到 ROOM_CLOSED → guestRoomGone(tip)
  └─ guestGoneHandled 防重复 → resetToGate() → gateMsg(tip,'warn')
局域网设备轮询看到 d.closed → onRoomClosed(tip) → 同一套收尾
```

`guestGoneHandled` 让 `P2P_OFF` 与 `ROOM_CLOSED` 前后脚到达时只收尾一次、只弹一条提示；`initGuest()` 负责复位。`dissolve()` 带幂等锁，`startIdleWatch` 触发前先停表——2.0.29 前同一轮里两处并发清库，可能抹掉刚建好的房间。

### 12.5 云房间的写一致性

- `persist()` 分两个事务写 `meta` / `msgs` 时，中间刷新会读到半截状态 → 改单事务 `cloudSetMany()`；
- 所有持久写串成 `_persistChain`，房间切换后丢弃迟到写入；
- `handleUpload` 先整体校验配额再写，写失败回滚并回 507；
- 房间结束后拒绝在途写接口；
- `Cloud.touch()` 持久化 `lastActive`，刷新后倒计时不重置。

### 12.6 加入前的探活：分四段、能取消、不误判（2.0.34）

入口页点「连接」到真正进房之间，`probeRoom()` 要依次完成四件事，每件都可能卡住，所以四件事都单独回报：

```
① signal   信令服务器握手完成（公共 PeerJS 在国外，弱网下 2~6 秒都算正常）
② call     已向 pc-<房间码> 发出呼叫
③ wait     数据通道打开，已发 HELLO，等房主 registerGuest 回 WELCOME
④ welcome  收到 WELCOME，拿到房主分配的名字
```

- **实时反馈**：`onStage` 回调 + 入口页 200ms 的计时器，把「现在第几段 + 已经等了几秒」直接写在提示行上。**速度没变，但「像卡死」变成了「在动」**——这是这一版唯一能免费拿到的东西。
- **取消**：探活期间同一颗按钮变成「取消」（`.gate-btn.primary.cancel` 白底绿字），`ctl.cancel()` 立刻 `finish`。以前按钮是 `disabled` 的，房间码输错只能干等满 12 秒。
- **`peer-unavailable` 不再一刀切**：房主刷新页面时 Peer 会先注销再注册，那 1~3 秒里访客连过去必然报这个错。第一次**不结论**，900ms 后用同一条信令重呼一次（`reProbe()`），两次都查不到才判 `not-found`。重呼前若 `peer.open` 已掉，等 `open` 再呼，不傻等到超时。
- **ICE `failed` 立刻收手**：`conn.peerConnection` 可能还没建好（PeerJS 内部要等 `createOffer`），所以 50ms 轮询最多 40 次再挂监听。一旦 `failed` 就返回 `ice-failed`，并直接建议「同一 WiFi 改用局域网房间」——这段以前要等满 12 秒。
- **拒绝也要说清楚**：房主满员时发 `FULL:{max,total}`（旧版访客不认，仍靠后面的 `BYE` 兜底），探活收到就显示「房间已满（最多 6 人）」，而不是把 `BYE` 翻译成含糊的「房间没有回应」。
- **失败后的第二行**：`probeDiag()` 把 `cost` 里的分段时刻算成「信令 0.8s · 呼叫 0.4s · 共 2.0s」，配上 `tip` 的可操作建议一起显示。公益项目没有日志服务，用户一句「连不上」你只能靠猜；有这行，截图过来就能定位是信令慢、还是信令通了没人接。
- **房间码本地校验**：固定 10 位（`A-Z` 去掉 `I/O`，`2-9` 去掉 `0/1`），位数不对当场提示，不发请求。

**注意 `cost` 只记首次到达时刻**：`reProbe()` 会再走一遍 `call`，如果覆盖了原值，「呼叫」这一段就会被算成 0。

### 12.7 房间没了怎么判、房主失联怎么发现（2.0.35）

进房之后的判死逻辑（`connectOnce()` 里的 `fail()`）有两个坑，2.0.35 一起补了。

**坑一：判死只数「连续次数」，能无限循环。** 原来的规则是「连续 4 次 `peer-unavailable` 才判房间结束，只要中间有一次别的失败（比如超时）就把计数清零」。看起来更保守，实际是个死循环：

```
peer-unavailable → 计数 1 → 等 1.2s 重呼 → 18 秒超时（不是 gone，计数清零）
→ 重呼 → peer-unavailable → 计数 1 → ...（永远到不了 4）
```

用户看到的就是「房间早就没了，界面永远停在 ② 已连到信令，正在呼叫对方设备…」。现在改成**双条件**，任一满足即离场：

- `guestGoneHits >= 4`（连续 4 次查不到，约 8 秒）——用于房主真的关房间的常见情况；
- `Date.now() - guestGoneAt >= GUEST_GONE_MS`（20 秒硬上限，从**第一次**查不到开始计时）——兜住上面那种被超时切开的情况。

`guestGoneAt` 只在「真的连上了」（`markGuestConnected`）、「新一轮连接」（`guestConnect`）、「回起始页」（`resetToGate`）时清零，中间的失败不再动它。

**坑二：文案在撒谎。** 已经知道信令里没有这个房主了，`call()` 还在写「② 已连到信令，正在呼叫对方设备…」，因为 ② 是 `call()` 无条件写的。现在 `call()`、`connectOnce()` 都先看 `guestGoneAt`：

```js
setStatus(guestGoneAt ? '正在确认房间是否还在…' : '② 已连到信令，正在呼叫对方设备…');
```

确认阶段的提示行还会写「最多再等 N 秒」，`guestRetryTimer` 每 3 秒再确认一次；同时「已查不到房主」时那条 18 秒的呼叫超时缩到 **6 秒**——信令是好的、对端根本没注册，18 秒纯属白等，不缩的话 20 秒窗口根本走不完。

**房主悄悄消失：加入者的心跳。** 以前只有房主 PING 加入者，加入者被动回 PONG。房主直接关掉页面 / 断网时，`ROOM_CLOSED` 发不出来，而 DataChannel 在加入者这一侧还能「open」很久（SCTP 自己要 30 秒以上才发现对端没了）——表现就是「房间都没了，人还留在房间里」。

```js
GUEST_PING_MS = 15000      // 15 秒静默敲一次
guestPingMiss >= 2         // 连敲两次没回音（约 30 秒）→ 判链路已死
```

- 「静默」以 `guestLastRecv`（`conn.on('data')` 里更新）为准，正在传文件时还有 `conn.__sending` 豁免；
- `document.hidden` 时不敲也不判死——后台标签页的定时器会被浏览器冻结，那不是对端走了；
- 判死后走 `scheduleGuestRetry()`：重连查不到房主 → 20 秒窗口走完 → `guestRoomGone()` 回起始页。

顺带修掉一处对称的 bug：加入者的 `handleData()` 没有 `ctx`，`PING` 那一支原本写的是 `ctx.conn.send('PONG')`，**从来没回过 PONG**。房主每轮 PONG 超时（30 秒 + 两次）就会把安静的设备当死连接摘掉，表现是「待一会儿突然被踢」。现在回 PONG 走 `(ctx && ctx.conn) || (MODE === 'guest' ? guestConn : null)`。

**发送成功不等于界面成功。** `sendAllInner()` 里只要抛异常就记 `it.status = 'fail'`，但 `sendFileTo()` 的 `await` 返回时字节和回执都已经到位（房主手上确实有文件）。所以排在它后面的本地动作——`pushMsg()` 画卡片、`renderPending()` 重绘列表、`renderRoomStat()` / `sendQuota()` 同步配额——全部单独 `try/catch`，出错只写 `console.warn`：

```js
await sendFileTo(...);
try { pushMsg({...}); } catch (e) { console.warn('[send] 已送达，但本地回声失败', e); }
```

进度回调同理：`p => { try { itemProgress(it, p); } catch (e) {} }`。以前任何一个渲染异常都会让用户看到红色「失败」，而对方其实已经收到，用户只能再发一遍，白占一遍空间。

**硬错误带出版本。** `ReferenceError` / `TypeError` 这类程序错误（不是网络问题）在失败行后面追加「（页面版本 `PAGE_BUILD`，刷新页面后重试）」。用户手里若是浏览器缓存下来的旧页面，只会报一句「X is not defined」，没有版本号就完全没法判断是哪一版脚本。

---

## 13. 断点续传与内存控制

### 13.1 断点续传（下载方向，2.0.31）

不升 `PROTOCOL`，靠两个**可选字段**表达，旧客户端当 0 处理，新旧互联照常：

```
访客 pumpPullQueue()  →  FILE_PULL:{mid,name,off:<已收字节>}
房主 handleData       →  GET /download 带 Range: bytes=<off>-
                        → sendFileTo(c, file, name, cb, mid, from, base=off, total=size)
                        → FILE_META:{…, size:<整份长度>, off:<起点>} + 剩余分片 + FILE_END
访客 handleData       →  resumePoint(partial, off, size) 三重校验
                        ✓ 才能接着收；✗ 丢弃残片，从 0 重来
```

`resumePoint(partial, off, size)` 的三个条件：`off > 0`、残片长度与 `size` 一致、`partial.received === off`。任一不满足就重下——**宁可多传，也不拼出偏移错位的坏文件**。

- 残片表 `partialPulls: Map<mid,{name,size,chunks,received,at}>`，`PARTIAL_MAX=256 MB`、`PARTIAL_TTL=30 min`，`trimPartials()` 按最旧淘汰
- 掉线时 `keepPartial()` 收进残片表；重连后 `resetPullsForReconnect()` 自动重新入队
- 房主回 416 说明对方其实已到末尾：发「空尾巴」（`base===total`、零字节 + `FILE_END`）收尾，接收端按零字节完成
- 云房间 `handleDownload(query, opts)` 同样补了 206 / `Content-Range` / 416
- 后端 CORS 放行 `Range` 并暴露 `Content-Range`，否则跨源预检失败、续传只能整份重下

### 13.2 内存

| 位置 | 做法 | 效果 |
|---|---|---|
| P2P 接收 | 每 2 MB 合成一个 Blob 入 `chunks`，`finishRecv` 前 `flushPend` | 1 GB 文件峰值从「两倍文件大小」降到「Blob 句柄 + 2 MB 尾巴」 |
| P2P 发送 | 双缓冲预读（`reads` 队列 + `readOff`），始终有 1–2 片在切片/读盘 | 高 RTT 链路上不留空档 |
| HTTP 直下 | `dlPump` 用 `ReadableStream` 逐块读、每 2 MB 合 Blob（与接收侧对称） | 局域网下载大文件不会一次性读进内存 |
| 分片异步 | `chunkChains: Map<key,Promise>` 每连接一条链 | 慢设备不再拖垮快设备，ArrayBuffer/Blob 混收不乱序 |
| UI | 进度更新 90 ms 节流 | 1 GB 少 1.6 万次强制重排 |

---

### 13.3 存储配额同步与清理（2.0.32 / 2.0.33）

文件都存在房主侧，加入者既没有后端可问，也读不到房主的浏览器配额。以前只有云房主看得到存储卡，加入者什么都不知道，只能把几十 MB 传完、在房主落盘失败时收到一个 NAK。

现在的数据流：

```
房主 roomLimits()  →  QUOTA:{kind,ok,total,used,max}  →  所有 hostConns
   ↑ 触发：设备入房（registerGuest）、房主/访客文件落盘成功、
          清理完成、后端 max_file 首次到达
加入者 hostLimits  →  renderRoomStat()（只读卡）+ syncFileEntry()
                  →  addFiles() 先按单文件上限与剩余空间拦截
```

- 访客的 `CHANNEL` 恒为 `lan`（它没有后端），所以判断房间类型只能靠 `QUOTA.kind`，不能看 `CHANNEL`
- 旧房主只发 `PEERS.nf=1`：加入者据此合成一份 `ok:false` 的限制，行为与旧版一致
- 云房间「已用」= `Cloud.totalBytes()`（各 Blob 之和），「还可上传」= `total - used`；局域网房间没有配额，只显示 `max_file`
- 拦截点只有 `addFiles()`（选择框 / 拖拽 / 粘贴三条路都汇到那里）；排队中的文件也算进已用，避免连选两批刚好超限

清理（2.0.33 起：**只删字节，不删记录**）：

- 云房间 `Cloud.deleteFiles(names)`：删 Blob（`file:<name>`）+ 把对应消息标 `m.gone = 1` + 单链持久化，返回 `{freed, gone}`
- 局域网房间逐个 `DELETE /file?name=`，后端删盘 + `m['gone'] = 1`，返回 `{freed, gone}`
- `payload()` / `_messages_snapshot()` 会把「字节已不在」的文件消息补上 `gone:1` 再下发，所以手动删盘、清理、刷新恢复三条路看到的是同一个状态
- 前端按 `gone` 渲染：灰卡 +「已清理」小标，下载按钮保留但点了只解释原因（`msg.url` 存在时仍可再存一份本地副本）
- 清完云房间广播 `FILE_GONE`，局域网靠长轮询刷新；两边都是**标记**而不是删除
- 只有房主能打开清理弹窗（`isRoomOwner()`），加入者连入口都看不到

为什么不再删消息：删掉以后对方连「这里曾经有过一个文件」都不知道，只会觉得没收到东西，最后还得来问一遍。卡片自己说明「已清理」，比让记录消失诚实。代价是清理弹窗里要过滤 `gone`（没有字节可删），以及 `/download` 要用 **410** 而不是 404 区分「曾经在、被清理」和「名字打错」。

### 13.4 上传的暂停与取消（2.0.33）

只有「访客 → 房主」这条 P2P 分片循环能真正停下来，因为字节是应用层按片发的：

```
sendFileTo(c, file, name, onProgress, mid, from, baseOff, totalSize, ctl)
                                                     ctl = { paused, canceled }
每片之前：
  canceled → send('FILE_ABORT:' + id) → throw { canceled: true }
  paused   → 每 120ms 轮询一次，直到 ctl.paused 变 false
```

- **暂停**只是不再取下一片。已经交给 SCTP 缓冲的字节照常发完，所以对端不会收到半条消息；继续时从下一片接着走，**不重传**
- **取消**先给对端发 `FILE_ABORT`，对方立刻 `recvBuf.delete(key)`，不必干等到 `FILE_END` 超时，也不会把残片当成完整文件
- 队列项上的 `pausable` 决定按钮给不给：房主那条是一次 `POST /upload`，浏览器没有「停一半再续」的语义，所以房主侧只提示「不能中断」，不摆一个按了没反应的键
- 取消的项状态记为 `canceled`：不算失败、不弹红条、不留 ↻，循环结束时直接从队列过滤掉
- 一个容易踩的边界：暂停期间 `c.__sending` 仍为 true，房主的心跳判死逻辑据此让路，不会因为「半天没字节」把连接摘掉
- 后端配套：`parse_multipart_stream()` 在解析结束后检查 `stream.remaining > 1024`，发现请求体没读完就整单回滚——否则客户端 abort 会留下一个截断文件，用户还能正常下载、打开才发现坏了

---

## 14. 提示文案与状态流

入口页只有一条提示栏 `#gateMsg`（`gate-foot-wrap` 用 grid 同格叠放，固定 34px）。**文案必须一句话、≤24 字**，否则会换行撑高卡片，破坏「卡片尺寸不变」的设计。

| kind | 用途 | 样式 |
|---|---|---|
| `err` | 加入失败、连接错误 | 浅红底 + 红字 |
| `warn` | 房间结束 / 销毁 / 被请出 / 需重新输入 | 浅橙底 + 深橙字 |
| `info` | 过程提示（正在连接 / 正在验证） | 透明底 + 淡灰字 |

**统一术语**：房间码、房主、外网加入、同一 WiFi、已结束 / 已销毁。角色区分：房主自己点销毁说「已销毁」，访客被通知说「已结束」。

| 场景 | 文案 |
|---|---|
| 房间码位数不足 | `房间码不对，请重输。` |
| 信令找不到房主 | `找不到房间：核对房间码，或让房主开启外网。` |
| 通道打通后被回绝 | `外网已关闭，请让房主打开「外网加入」。` |
| 建连超时 | `连接超时：请核对房间码和双方网络。` |
| 数据通道被关 | `房间没有回应，请确认房主页面还开着。` |
| 信令网络错误 | `连不上信令服务器，换个网络再试。` |
| 局域网：没建房 / 码错 / 满员 / 程序没开 | `房间还没创建，请房主先创建。` / `房间码不对，请向房主确认。` / `房间已满（最多 6 人）。` / `连不上本机程序，请确认它开着且在同一网络。` |
| 房主销毁，外网访客 | `房间已结束，请让房主重新创建。` |
| 房主销毁，本机 / 局域网设备 | `房间已结束，可以重新创建。` |
| 房主自己点完销毁 | `房间已销毁，聊天记录与接收文件已清除。` |
| 云房间 60 分钟自动结束 | `房间 60 分钟无通信，已自动结束。` |
| 刷新时房间没了 | `房间已结束，请重新创建或加入。` |
| 换码 / 凭证失效 | `房间码已变，请重新加入。` / `房间码已变，请重新输入。` |
| 多次重连失败 | `多次重连未找到房主，房间可能已结束。` |

**改文案的位置**：`web/gate.js`（`probeRoom` 的 `finish(false,…)`、`gateJoin`、`verifyRoomCode`、两条 resume、`backToGate`）、`web/room.js`（`handleData` 的 `P2P_OFF`/`ROOM_CLOSED`/`BYE`、`loadMessages` 的 `closed` 分支、`guestRoomGone`/`guestReturnToGate`、`onNeedJoin`、`connectOnce` 的 `fail`、`wireGuestConn` 的 close）、`web/cloud.js`（空闲监视）、`web/app.js`（主动断开）、`数据传输.py`（`/api/join` 与 `NEED_JOIN` 的 `msg`）、`web/page.html`（确认框）、`web/app.css`（三种 kind 的配色）。

---

## 15. 测试

```bash
python 数据传输.py --export-page        # 重新生成 index.html
python tests/smoke.py                   # 后端冒烟 66 项
node tests/cloud_store.test.mjs         # 云仓库 44 项
node tests/transfer.test.mjs            # 传输层 31 项
node tests/join.test.mjs                # 加入探活 38 项
node tests/render.test.mjs              # 消息渲染 16 项
node tests/no-undef.mjs                 # 未声明变量（必须 0）
node tests/risk-scan.mjs                # 同类隐患清单（信息性）
```

| 套件 | 覆盖 |
|---|---|
| `smoke.py` | 导出页与磁盘 `index.html` **逐字一致**、`__P2P_ENABLED__` 在导出页为 `true` / `p2p=False` 的 host 页为 `false`、`/api/devices` 与 `/admin-login` 已 404、`idle_left`、`max_file`、p2p 开关、房间生命周期、`DELETE /file` 的释放字节/删盘/保留记录并标 `gone`/重复删 404，以及 24 条**源码契约断言**（`raw` 枚举值、`_serializers` 映射、两处 `connect` 参数、分片协商、QUOTA、FILE_GONE、FILE_ABORT、暂停与取消、房间判死 20 秒硬上限、加入者心跳与回 PONG、送达后界面异常不算失败） |
| `cloud_store.test.mjs` | 用内存对象替代 IndexedDB：配额、消息仓库、原子写、并发 persist 顺序、dissolve 幂等、迟到写丢弃、`/download` 的 206 / `Content-Range` / 末端截断 / 416、`deleteFiles` 的释放字节 / 消息与 Blob 同删 / 其他文件不受影响 |
| `transfer.test.mjs` | 用正则从 `room.js` 抠出函数体再 `new Function` 求值（不依赖 DOM）：真跑 `sendFileTo` 的整份 / 续传 / 空尾巴三种情形，验字节数与 `meta` 字段；另测 `resumePoint` 8 种判定与 `chunkSizeFor` |
| `render.test.mjs` | 从 `room.js` / `app.js` 抠出 `renderMsg` / `isSelfMsg` / `esc` / `ANON_AVATAR` 真跑：文本、文件卡片、**已清理卡片**、已清理但有本地副本、缺字段消息、屏幕共享直播/结束、未知类型，访客与房主两个视角共 16 项。这一层专防「渲染在文件已送达之后崩掉」|
| `no-undef.mjs` | acorn 解析五个脚本，手写作用域链（var 提升、函数/块/catch/循环、解构、默认参数），把内联后的五个文件当同一个 `<script>`，只报「出现在取值位置、却从未声明」的名字。`quota is not defined` 这类问题在提交前就能发现 |
| `risk-scan.mjs` | 三类：`JSON.parse` 不在 try 的 block 内、`getElementById(...)` 直接接 `.style/.classList/...`、`addEventListener` 落在可能反复执行的函数里。当前基线：JSON.parse 0 处未保护、DOM 解引用 41 处（全是模板固定元素，id 已全量校验存在）|
| `join.test.mjs` | 用假的 `Peer` / `DataConnection` / `RTCPeerConnection` 真跑 `probeRoom()`：四段回报顺序、房主刷新时先重探再结论、连续两次找不到才 `not-found`、`P2P_OFF` / `FULL` / `BYE`、ICE `failed` 当场返回、`ctl.cancel()` 立刻返回、超时，以及 `probeDiag()` 的分段耗时格式 |

注意事项：

- `cloud_store.test.mjs` 里 60 分钟定时器要 `process.exit(0)`，否则挂住不退出；
- `transfer.test.mjs` 依赖函数签名的写法，**改签名或换行风格时要同步看正则**；
- `join.test.mjs` 用 `indexOf` 从 `function probeRoom(` 截到「入口页」那节的分隔注释，**改动这两处附近的注释会切断截取**；它还会真的等 900ms 的重探间隔，所以整套要跑 2 秒左右；
- 真实双浏览器联调（房主 + 外网访客走公共 PeerJS）可以验证开关两态、失败文案、刷新不闪起始页，但外部信令握手可能很慢甚至超时，不要把交付押在它上面；静态断言 + 单页 CDP 测 UI 更稳。

---

## 16. 构建、打包、发布 SOP

```bash
# 0) 关掉正在跑的旧程序（否则 exe 被占用写不进去）
# 1) 改 web/ 或 数据传输.py 后
python 数据传输.py --export-page
node --check web/app.js && node --check web/cloud.js && node --check web/store.js \
  && node --check web/room.js && node --check web/gate.js
python -m py_compile 数据传输.py
python tests/smoke.py && node tests/cloud_store.test.mjs \
  && node tests/transfer.test.mjs && node tests/join.test.mjs

# 2) 改版本：version_info.txt 里 filevers / prodvers / FileVersion / ProductVersion 四处一起改
# 3) 打包（--add-data 与 --version-file 都必须用绝对路径；--specpath build 会改相对基准）
rm -rf build dist
python -m PyInstaller --onefile --noupx --noconfirm \
  --version-file "<项目绝对路径>/version_info.txt" \
  --add-data "<项目绝对路径>/web;web" \
  --distpath dist --workpath build --specpath build 数据传输.py
cp dist/数据传输.exe 数据传输.exe

# 4) 校验 exe 内嵌页面：把 exe 拷进空目录跑 --export-page，
#    生成的 index.html 与根目录那份除 CLIENT_URL 外逐字一致
# 5) 同步 README「版本与校验」表（大小 / md5 / sha256 / 页面指纹）
# 6) 清理 build/ dist/ 数据/
```

- `--noupx` 关掉 UPX：压过的 exe 是杀软误报高发区。
- `--version-file` 别省：没有版本信息时 Windows 更容易把它当「来历不明的打包程序」。
- **发布**：仓库根目录就是 Pages 站点根。改界面 → 传 `index.html` + 改过的 `web/`；改后端 → 传 `数据传输.py` + 新 exe，并重新导出一次（指纹会变）。exe 是二进制，**只能网页拖拽上传**，在线编辑器会损坏。
- **线上对版**：点顶栏「房间说明」看底部「页面版本」，应等于 README 里的页面指纹。对不上就是没覆盖上传，或被 600 秒 CDN 缓存挡住了（`Ctrl+Shift+R` 强刷）。

---

## 17. 改代码的标准流程

1. **先定位**：`grep` 协议字 / 函数名，读对应 `web/*.js` 段落，不要凭摘要猜。
2. **判断影响面**：改 `web/` → 页面与 exe 都要重做；只改文档 → 不用重打包。
3. **改 + 语法检查**：五个 JS 逐个 `node --check`，Python 侧 `py_compile`。
4. **导出**：`python 数据传输.py --export-page`。
5. **验证**：四套测试；涉及 UI 时用单页 CDP 截图看实际渲染，别只读代码。
6. **升版本、打包、校验**：见第 16 节。
7. **同步文档**：README 的产物表与当前版本摘要、本文的版本历史与受影响章节。
8. **清理**：`build/` `dist/` `数据/` 不留。`数据/` 是运行时目录不是缓存，但只剩测试残留时可以直接删。
9. **交付**：`index.html`、`数据传输.exe`、两份文档；提醒用户提交到 GitHub，并按 `Ctrl+Shift+R` 强刷。
10. **写工作日志**：`.workbuddy/memory/YYYY-MM-DD.md` 追加改动、真因、验证方式、产物校验值。

---

## 18. 版本历史

| 版本 | 要点 |
|---|---|
| **2.0.37** | **全量排查「平时不报错、出事就崩在关键路径上」的写法**。修掉一个真实崩溃：`renderMsg()` 里 `const gone` 声明在 `else` 块内（文件分支），却在块外被「下载进度条」那行引用 —— 访客每渲染一条文件消息就抛 `ReferenceError`，而崩的位置正好在「文件已送达、正在画卡片」之后，现象就是**发送方显示失败、房主却已经收到**。判断提到分支外（`msg.type === 'file' && !!msg.gone && !msg.url`）。另修：`sendFileTo()` 的暂停等待循环加 `if (!c || !c.open) throw`，否则暂停中房主关房间会永久卡住分片循环、`sendAllBusy` 不释放，下一间房发不出任何文件；`resetToGate()` 放开队列项的 `paused` 并置 `canceled`；`sendAll()` 补 `catch`，队列异常不再变成无人处理的 Promise 拒绝；`waitChange` 的 `timer`、`waitDrain` 的 `wake`、`probeRoom` 的 `fresh` 三处「先用后声明」改为先声明（异步路径下暂时安全，同步触发即 ReferenceError）。新增 `tests/no-undef.mjs`（acorn 语法树 + 手写作用域链，把五个脚本当同一 `<script>`，报「只读却从未声明」）、`tests/risk-scan.mjs`（JSON.parse 未保护 / DOM 空引用 / 重复绑监听）、`tests/render.test.mjs`（renderMsg 喂 11 种消息形态，含缺失字段与已清理卡片），smoke 加 3 条契约断言 |
| **2.0.36** | **送达标记优先于任何异常**。`sendAllInner()` 的每条队列项新增 `delivered`：房主端在 `/upload` 返回 `ok` 之后、访客端在 `sendFileTo()` 正常返回（字节 + `FILE_ACK` 都到位）之后置位；`catch` 里第一件事就是判它，为真则一律按已发送处理（`status='done'`、`done++`），只 `console.warn` 记一行。此前靠给 `pushMsg` / `renderPending` / `renderRoomStat` / `sendQuota` / 进度回调逐个包 `try/catch` 来防误判，新加一处界面代码漏包就会复发——现在这类误判在结构上不可能发生。同时把 `ReferenceError` / `TypeError` 的失败文案从「X is not defined」改成「页面脚本出错，请按 Ctrl+Shift+R 强制刷新后重试（页面版本 xxx）」。新增 1 条源码契约断言 |
| **2.0.35** | **房间没了就走、送达就是送达**。判死从「连续 4 次 `peer-unavailable`」改成双条件：`guestGoneHits >= 4` **或** 第一次查不到起满 20 秒（`GUEST_GONE_MS`）。旧规则里一次超时就会把计数清零，「查不到 → 超时 → 查不到」能无限循环，界面永远停在 ② 已连到信令正在呼叫（真实投诉）。`guestGoneAt` 只在真连上 / 新一轮 / 回起始页时清零。状态行不再撒谎：`call()` 与 `connectOnce()` 在 `guestGoneAt` 非空时写「正在确认房间是否还在…」，`guestRetryTimer` 每 3 秒再确认一次并写剩余秒数，呼叫超时从 18 秒缩到 6 秒让 20 秒窗口真能走完。新增加入者侧心跳 `startGuestPing()` / `stopGuestPing()`：15 秒静默敲一次 PING，连续两次（约 30 秒）没回音判链路已死 → `scheduleGuestRetry()`，`__sending` 与 `document.hidden` 豁免；顺带修掉加入者从不回 PONG（`ctx` 为 null）导致安静设备被房主按超时摘掉的 bug。`sendAllInner()` 把送达后的本地动作（`pushMsg` / `renderPending` / `renderRoomStat` / `sendQuota`）和进度回调全部单独 `try/catch`，界面异常不再把已送达的文件标成红字失败；`ReferenceError` / `TypeError` 的失败行追加「（页面版本 xxx，刷新页面后重试）」。测试：smoke 55→61 |
| **2.0.34** | **加入前的房间状态检测**。`probeRoom()` 拆成四段（`signal` / `call` / `wait` / `welcome`），通过 `onStage` 回报给入口页，提示行 200ms 刷新「第几段 + 已等几秒」。探活期间「连接」按钮变成「取消」（`ctl.cancel()` 立刻 `finish`），不再 `disabled` 干等。`peer-unavailable` 首次不结论：900ms 后用同一条信令重呼一次（`reProbe()`），两次都查不到才 `not-found`——房主刷新页面不再被误判成房间没了。新增 ICE 监听（50ms × 40 次轮询等 `peerConnection` 就绪），`failed` 立刻返回 `ice-failed` 并建议改局域网，省掉最长 12 秒的干等。房主满员改发 `FULL:{max,total}`，探活收到当场说「房间已满」，不再把 `BYE` 翻译成「没有回应」。房间码本地校验改为固定 10 位。失败时第二行显示 `probeDiag()` 算出的分段耗时 + 可操作建议。新增 `tests/join.test.mjs` 38 项 |
| **2.0.33** | **清理保留记录 + 上传可打断**。清理的语义从「删字节 + 删消息」改成「只删字节」：云房间 `deleteFiles()` 把消息标 `gone` 而不删，`payload()` 给缺 Blob 的文件消息补 `gone:1`，`/download` 对已清理文件返回 **410**（不是 404）；后端 `_messages_snapshot()` 同样只标不删，`DELETE /file` 返回 `gone` 计数。前端卡片按 `gone` 渲染成灰卡 +「已清理」小标，下载按钮保留但点了只解释原因；访客已有本地副本（`msg.url`）时仍可再存一份。通知帧 `FILE_DEL` 改名 `FILE_GONE` 并改为「标记」语义。上传打断：`sendFileTo()` 新增第 9 个参数 `ctl`（`paused` / `canceled`），分片循环每片前检查，取消时发 `FILE_ABORT` 让对端丢缓冲；队列项新增 `pausable`，只有 P2P 发送可暂停（房主的 HTTP 上传如实告知不能中断）；`cancelSend()` / `togglePause()` 管理状态，取消的项不算失败、不弹红条。`parse_multipart_stream()` 增加 `remaining > 1024` 守卫，避免中断留下截断文件。测试：smoke 52→55、cloud_store 43→44、transfer 24→31 |
| **2.0.32** | **存储信息对所有人可见 + 房主清理文件**。新增 `QUOTA` 帧，把房主的存储与单文件上限同步给加入者（`kind=cloud` 有总量/已用，`lan` 只有上限）；访客侧新增 `roomLimits()`，`addFiles()` 在选择时就按单文件上限与剩余空间拦截。顺带修掉一处死代码：`cloudFileBlockReason()` 开头 `CHANNEL !== 'cloud'` 直接返回，而访客的 `CHANNEL` 恒为 `lan`，导致旧版靠 `PEERS.nf=1` 的拦截从未生效。后端 `/api/host` 与 `/messages` 补 `max_file`，局域网加入者也能看到 4 GiB 上限。新增 `DELETE /file`（仅回环）：删磁盘文件 + 对应消息 + `bump_messages`；云房间 `Cloud.deleteFiles()` 删 Blob + 消息并走持久化链。房主存储卡新增「清理文件」多选弹窗（`cleanModal`），云房间广播 `FILE_DEL` 让所有设备同步删卡片。测试：smoke 41→52、cloud_store 36→43 |
| **2.0.31** | **断点续传（下载方向）**。`FILE_PULL` 增可选 `off`，房主用 `Range: bytes=<off>-` 从断点取；`sendFileTo(..., baseOff, totalSize)` 把 `off/size` 写进 `FILE_META`；接收端 `resumePoint()` 三重校验后才接，否则丢弃重来。新增 `partialPulls`（256 MB / 30 min）、`keepPartial`、`trimPartials`、`resetPullsForReconnect`，三条失败路径不再丢弃已收字节。云房间 `handleDownload` 补 206/416，CORS 放行 `Range`。房主收到 416 时以「空尾巴」收尾。访客侧新增中继提示（`detectRelay`）。删除 `customSignal()` / `lanshare_signal` 死代码。新增 `transfer.test.mjs` 24 项，`cloud_store` 30→36 项 |
| **2.0.30** | **提速**。纠正误判：之前「~85 KB/s 是 P2P 上限」实为境外静态托管下载的抖动值，重测 GitHub Pages 下 9.4 MB exe 为 **2.61 MB/s / 3.63 s**。两处 `peer.connect` 改 `serialization:'raw'`，绕过 `chunkedMTU=16300` 与 BinaryPack，64 KB 分片从 5 帧变 1 帧，每 1 MB 的 send／回调 80→16。`chunkSizeFor()` 按 `pc.sctp.maxMessageSize` 把分片放大到 128 KB。`smoke.py` 30→41 项，新增 11 条源码契约断言防退化 |
| **2.0.29** | 收掉 2.0.28 审查列出的全部 6 项轻微缺陷 + 1 处漏检。`_origin_ok()` 不再对无 `Origin` 的写请求无条件放行；`local_ips()` 永久缓存改 2 秒 TTL；新增 `_rollback_saved()` 上传整单回滚，并补「文件尾与分隔符同批到达」时的超限检查；云房间 `cloudSetMany()` 单事务 + `_persistChain` + `dissolve` 幂等；新增 `finishingRecv` 代次表，被顶掉的传输不再补发回执。`cloud_store` 25→30 项 |
| **2.0.28** | 对照 `file-transfer-go` 源码做全量静态审查，修掉 20 余处隐患。加入：重试定时器统一收编、退出后不再重建僵尸 Peer；`renewRoom` 前复核访客、`applyRoomP2P` 定时器可取消、`onRoomClosed` 真停定时器。传输：`sendAll` 互斥、落盘期不判死、`FILE_PULL_ERR` 解析失败兜底放行、`protoMismatch` 只清当前连接。吞吐：HTTP 下载补 2 MB 分批；`chunkChain` 全局单链改按连接。后端：`unique_path` 用 `'xb'`、上传房间码快照、`/download` 拒绝控制字符、`/api/stats` 加房主校验。**未采纳**对方的分级看门狗与「失败即切 WS 中继」——需要自建信令/中继服务器，且 8 秒自动重连会放大用户最反感的「闪动」 |
| **2.0.27** | 大文件三处硬伤。① 心跳让路：`PING` 排在数千条分片后会超时误杀，改为「有字节在动就不判死，120 秒无变化兜底」；② 接收缓冲 Blob 化（每 2 MB 一个），1 GB 峰值内存降一个量级；③ `FILE_META` 顶掉旧缓冲、连接被摘时都先回 `FILE_NAK`。另：发送端双缓冲预读，加入重试 3→5 次、软重试 3→4 次、断线重连 4→6 轮 |
| **2.0.26** | 在线入口回到 **GitHub Pages**（阿里云 ESA 落到香港节点，整页 3.57 s vs 1.65 s；且发布要「传 OSS + 刷缓存」两步）。改动只有 `client_url.txt` 一行 + 重新导出，代码零改动 |
| **2.0.25** | 在线入口换自有域名（阿里云 ESA，全球节点不需备案）。`_allowed_origins()` 改为同一主机同时放行 http/https，证书没配好时不会表现成「页面能开但连不上」 |
| **2.0.24** | 站点迁到阿里云「函数和 Pages」；`gate.js` 删除写死的下载兜底地址，改 `pageBase()` 按当前页面目录推导，换域名不再留死链 |
| **2.0.23** | 背压改 `bufferedAmountLowThreshold` 事件驱动；进度 UI 降到 10 Hz；房主刷新时访客不再被踢回起始页（`guestGoneHits` 判定放宽到 4 次约 8 秒）；新增 `connDead()` 回前台体检。加入超时 15/12→24/18 秒 |
| **2.0.21** | 学 `file-transfer-go` 的「不折腾」：通道建立后信令断开/报错不碰 PeerConnection；`pagehide` 主动 `BYE`；PONG 判死 20→30 秒；房主 `unavailable-id` 在房间有人时不换码；ICE 增加公共 TURN 兜底 |
| **2.0.20** | 外网提速：`CHUNK_SIZE` 15→64 KB、`MAX_BUFFERED` 512 KB→2 MB、轮询 12→6 ms、发送预读、`FILE_END` 宽限 9 秒。加入稳定性第一批：分阶段超时、`softRetry` 不销毁信令、`unavailable-id` 静默换 ID、`callInFlight` 防重复呼叫 |
| **2.0.19** | 提示文案统一压成一句并新增 `warn` 样式；修 4 类隐藏问题：房间结束时回执挂住发送队列、ACK 固定 20 秒导致重复落盘、`FILE_PULL_ERR` 分支 `querySelector` 未判空、`onNeedJoin` 漏停定时器 |
| **2.0.18** | 修访客连发文件「假成功 / 慢 / 丢失」：`buffered()` 改读 `dataChannel.bufferedAmount`、新增 `FILE_ACK`/`FILE_NAK` 与 `WELCOME.ack` 协商、`FILE_END` 宽限 2.5→6 秒 |
| **2.0.17** | 刷新不再闪起始页：`body.booting` 遮蔽、恢复类入口不 `showGate()`、两条 resume 不再 `await prepareHostPeer` |
| **2.0.16** | 局域网房间外网默认关；关开关先发 `P2P_OFF` 再 220 ms 后断连；拒客改在 DataChannel `open` 后回话 |
| **2.0.15** | 修「在线页开的局域网房间没有外网开关」：`__P2P_ENABLED__` 一值两义 |
| **2.0.14** | 三选一收成二选一，「两者同时」变成房间里的开关；新增 `POST /api/room/p2p` |
| **2.0.11** | 倒计时统一 60 分钟（局域网靠心跳回包 `idle_left` 校准）；管理面板整套删除 |
| **2.0.7** | 创建前先选通道；配额改动态（可用 ×80%，单文件 ×10%）；空闲销毁 30→60 分钟 |
| **2.0.5** | 下完不再自动写盘，停在「下载完成 · 点击保存」 |
| **2.0.3** | 下载 exe 支持暂停 / 继续与 `Range` 断点续传 |
| **2.0.0.0** | v2 首发：纯网页房主、30 分钟自毁、聊天记录不落盘、6 人上限 |

---

## 19. 已知限制与待办

- **2.0.18 的「10 文件真实双浏览器对照」始终没跑完**（卡在外部 PeerJS 信令握手），需要在真机上复验访客→房主连发 10 个文件是否 10/10 到达、无重复落盘。
- 6 人满员、200 条历史上限、「下载期间不刷新 `lastActive`」均未做端到端实测。
- 断点续传只做了**下载方向**。上传方向（访客→房主）中断仍需整份重发——要做就得让房主按 `mid` 记住已收字节并回一个带偏移的 ACK，改动面比下载大。
- 房主侧转发 `FILE_PULL` 时仍是 `apiFetch → r.blob() → sendFileTo`：先把剩余段整个拿到 Blob 再分片，超大文件续传时房主端会有一次 Blob 峰值。改成 `response.body` 流式边读边发可以再降一档内存，但要重写 `sendFileTo` 的读取源，本版未动。
- 关闭「外网加入」后房主侧仍挂着信令连接（只是不开门），这是不换房间码的取舍。要彻底断开，必须先解决 `unavailable-id` 重试导致 `renewRoom()` 换码把全房间踢出去的问题。
- `/upload` 的请求体上限是 `MAX_FILE_SIZE + 1 MiB`，一次多选多个大文件可能整体 413；单文件场景不受影响。
- 清理文件没有回收站：删了不可撤销，也不支持按大小/类型筛选或自动清理；加入者没有清理权限，入口都不显示。
- **「房间是否存在」只能靠连过去试**：公共 PeerJS 只知道 `pc-<房间码>` 这个 peer 在不在线，而云房间的元数据（房主昵称、创建时间、空置倒计时）只存在房主浏览器的 IndexedDB 里，信令服务器没有。所以探活能做到「0.9 秒内两次确认对方不在」，但做不到「不打扰房主就查到房间详情」——那需要一个常驻的服务端，本项目的零成本前提不允许。
- 探活在「房主开着页面但电脑睡了 / 浏览器被冻结」时仍会走满 12 秒超时：数据通道打不开，ICE 也停在 `checking` 而不是 `failed`，前端无法区分「慢」和「死」。
- 暂停只停“读下一片”，不会主动把已进 SCTP 缓冲的字节撤回来，所以按暂停后对端可能还会收到几百 KB 才真正停住。
- 房主上传（`POST /upload`）不能暂停 / 取消，只支持排队时移除：浏览器没有「停一半再续传」的语义，本版也没做分片上传接口。
- 局域网房间没有「磁盘剩余空间」卡（曾提议，未采纳）；现在只有一张「上传限制」卡显示单文件上限。
- `index.html` 与 `数据传输.exe` 需人工上传到 GitHub 并 commit；Pages 会在 1–2 分钟内自动部署，本地产物更新不会自动上线。
