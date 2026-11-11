# -*- coding: utf-8 -*-
"""
数据传输 —— 局域网 / 外网文件与文字互传工具
同一 WiFi 下，任意设备的浏览器之间互传文件 / 文本，无需安装 App。
运行后用其他设备的浏览器打开终端里显示的地址即可。

可选环境变量（前缀 DATATRANSMISSION_ 是现行名字，LANSHARE_ 为兼容旧版保留）：
    DATATRANSMISSION_ADMIN_PASSWORD  管理员密码（未设置时为默认值 admin）
    DATATRANSMISSION_MAX_FILE_SIZE   单文件上传上限字节数（默认 4 GiB）
"""
import os
import re
import sys
import html
import json
import hmac
import time
import uuid
import socket
import shutil
import secrets
import hashlib
import threading
import subprocess
import mimetypes
import urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

PORT = 8000
# 兼容打包成exe后的路径
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DATA_ROOT = os.path.join(BASE_DIR, "数据")
# 数据/ 下只放一个「房间」，再往下每个房间一个文件夹：
#   数据/房间/房间码.txt               当前用哪个房间（程序状态）
#   数据/房间/<房间码>/接收文件/        这个房间收到的文件
#   数据/房间/<房间码>/聊天记录.json     这个房间的全部消息（文本 + 文件条目）
ROOM_ROOT = os.path.join(DATA_ROOT, "房间")
# 上一版把这三样平铺在 数据/ 下，仅用于一次性搬迁
LEGACY_CHAT = os.path.join(DATA_ROOT, "聊天记录")
LEGACY_UPLOAD = os.path.join(DATA_ROOT, "接收文件")
os.makedirs(ROOM_ROOT, exist_ok=True)

# ── 前端页面 ──────────────────────────────────────────────────────────────
# 页面拆成六个源文件放在 web/ 下，返回给浏览器时内联成一份完整 HTML：
#   page.html  外壳与结构      app.css   样式       vendor.js 第三方库（勿手改）
#   app.js     公共核心        room.js   房间内逻辑  gate.js  首页 / 入口页逻辑
# 三个 JS 按 app → room → gate 拼进同一个 <script>，共用一个作用域；gate.js
# 里的启动分发放最后执行。好处是改样式 / 改脚本不用动 Python，源码按职责好找；
# 对外仍是单页，静态托管与 file:// 打开都不散架。
# 打包 exe 时加 --add-data "web;web"，PyInstaller 会把它塞进 exe，运行时解到 _MEIPASS。
if getattr(sys, 'frozen', False):
    WEB_DIR = os.path.join(getattr(sys, '_MEIPASS', BASE_DIR), 'web')
else:
    WEB_DIR = os.path.join(BASE_DIR, 'web')

_WEB_CACHE = {}


def web_asset(name):
    """读 web/ 下的页面源文件并缓存；缺失时给出可执行的修复提示"""
    if name in _WEB_CACHE:
        return _WEB_CACHE[name]
    path = os.path.join(WEB_DIR, name)
    try:
        with open(path, 'r', encoding='utf-8', newline='') as f:
            data = f.read()
    except OSError:
        raise SystemExit(
            "缺少页面源文件：%s\n"
            "  源码运行：确认 web/ 与 数据传输.py 在同一层目录\n"
            '  打包 exe：命令要带 --add-data "web;web"' % path
        )
    _WEB_CACHE[name] = data
    return data

# 其他设备用的在线页面地址：环境变量 > 同目录 client_url.txt > 内置默认值
# 部署到 GitHub Pages 后把网址写进 client_url.txt，exe 无需重新打包。
# 按文件 mtime 缓存：改完 client_url.txt 刷新页面就生效，不用重启程序
DEFAULT_CLIENT_URL = ""
_CLIENT_URL_CACHE = {'key': None, 'value': DEFAULT_CLIENT_URL}


def _read_client_url():
    env = (os.environ.get('DATATRANSMISSION_CLIENT_URL')
           or os.environ.get('LANSHARE_CLIENT_URL') or '').strip()
    if env:
        return env
    path = os.path.join(BASE_DIR, 'client_url.txt')
    try:
        st = os.stat(path)
        key = (st.st_mtime_ns, st.st_size)
        if _CLIENT_URL_CACHE['key'] == key:
            return _CLIENT_URL_CACHE['value']
        with open(path, 'r', encoding='utf-8') as f:
            first = f.readline().strip()
    except OSError:
        _CLIENT_URL_CACHE['key'] = None
        _CLIENT_URL_CACHE['value'] = DEFAULT_CLIENT_URL
        return DEFAULT_CLIENT_URL
    value = first or DEFAULT_CLIENT_URL
    _CLIENT_URL_CACHE['key'] = key
    _CLIENT_URL_CACHE['value'] = value
    return value


CLIENT_URL = _read_client_url()      # 启动时的值，仅用于启动横幅

# ── 房间码：点「创建房间」时才生成 ────────────────────────────────────────
# 程序启动时没有房间，也没有房间码：码只活在这一次运行的内存里。
# 关掉程序房间就没了；聊天记录和收到的文件由看门狗在程序退出时清掉，
# 不再留到下次启动时处理。
# 本地 8000 页面与在线页（github.io）都要用同一个码，才可能连进同一个房间，
# 所以码仍然只在这里生成一份，两个页面都通过 /api/host 读取。
ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
# 旧版本把房间码落盘在这个文件里，现在不再写也不再读，启动时顺手清掉
ROOM_FILE = os.path.join(ROOM_ROOT, "房间码.txt")
# 两个旧位置，只用于清理：数据/房间码.txt、数据/聊天记录/房间码.txt
LEGACY_ROOM_FILE = os.path.join(DATA_ROOT, "房间码.txt")
LEGACY_ROOM_FILE_OLD = os.path.join(LEGACY_CHAT, "房间码.txt")


def _room_code(room=None):
    """取合法房间码，非法值一律归到 UNKNOWN，防止拼出路径穿越的目录

    这里放宽到 [A-Z0-9]：只用于拼目录名，安全性和严格度无关，
    但旧版本的码或手工改过的目录名不该被静默并进 UNKNOWN。
    """
    r = (room or ROOM or 'UNKNOWN').upper()
    if re.fullmatch(r'[A-Z0-9]{1,16}', r):
        return r
    return 'UNKNOWN'


def room_dir(room=None):
    """某个房间的文件夹：数据/房间/<房间码>"""
    return os.path.join(ROOM_ROOT, _room_code(room))


def upload_dir(room=None):
    """某房间的接收文件夹：数据/房间/<房间码>/接收文件"""
    return os.path.join(room_dir(room), "接收文件")


def msg_file(room=None):
    """某房间的聊天记录文件：数据/房间/<房间码>/聊天记录.json

    不再套一层「聊天记录/」文件夹：一个房间的聊天记录就是房间文件夹里的一个 json，
    和 接收文件/ 平级，打开房间文件夹一眼看全。
    """
    return os.path.join(room_dir(room), "聊天记录.json")


def _drop_empty_chat_dir(room_path):
    """上一版的 聊天记录/ 文件夹搬空后删掉；里面还有别的文件就原样留着"""
    d = os.path.join(room_path, "聊天记录")
    if not os.path.isdir(d):
        return
    try:
        if not os.listdir(d):
            os.rmdir(d)
    except OSError:
        pass


def _drop_kick_file(room_path):
    """踢出功能已经删掉：旧版本留下的 踢出名单.json 没有用了，清掉"""
    for name in ("踢出名单.json", "踢出名单.json.tmp"):
        p = os.path.join(room_path, name)
        try:
            if os.path.isfile(p):
                os.remove(p)
        except OSError:
            pass


def ensure_room(room=None):
    """房间一建立就把结构写全：接收文件夹 + 聊天记录

    聊天记录不等第一条消息落盘才生成，刚建好的房间看着像"什么都没有"；
    先放一份空的，房间文件夹里有什么一目了然。
    """
    try:
        os.makedirs(upload_dir(room), exist_ok=True)
    except OSError:
        pass
    f = msg_file(room)
    # 0 字节的空壳（写到一半被打断、或被别的进程先建了个空文件）也算"没有"
    if not os.path.exists(f) or os.path.getsize(f) == 0:
        try:
            with open(f, 'w', encoding='utf-8') as fp:
                json.dump([], fp)
        except OSError:
            pass


def _new_room():
    return ''.join(secrets.choice(ROOM_ALPHABET) for _ in range(10))


def _load_room():
    """读旧版本落盘的房间码（只读，不新建）

    现在启动不再自动建房，这个码只用来把旧版散落的数据并进它自己的房间目录，
    读完就把指针文件删掉。
    """
    for path in (ROOM_FILE, LEGACY_ROOM_FILE, LEGACY_ROOM_FILE_OLD):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                r = f.read().strip().upper()
        except OSError:
            continue
        if re.fullmatch(r'[A-Z2-9]{10}', r):
            return r
    return None


def _drop_room_files():
    """清掉旧版本留下的房间码文件：房间码现在只活在这一次运行里"""
    for p in (ROOM_FILE, LEGACY_ROOM_FILE, LEGACY_ROOM_FILE_OLD):
        try:
            if os.path.isfile(p):
                os.remove(p)
        except OSError:
            pass


# 当前房间：None 表示还没点「创建房间」
ROOM = None

# 设备名 -> 房间内编号（头像上的数字）：房主按加入顺序算好后上报，
# 这里只管存和随 /messages 下发（局域网设备不连 P2P，只能从这里拿）。
# 房间一换就清空，编号永远从 1 重新开始。
ROOM_NUMS = {}

def has_room():
    """已经点过「创建房间」就有房间，否则一切都是空的"""
    return bool(ROOM)


def renew_room():
    """开一个新房间：换一个房间码，新目录新记录

    只在「新建房间」（原来的「换一个」）时调用；旧房间是临时的，
    换码即销毁——旧文件夹当场删掉，不再留任何数据。
    """
    global ROOM
    old = ROOM
    ROOM = _new_room()
    if old:
        purge_room_dir(old)      # 旧房间数据不带走，删干净
    with DATA_LOCK:
        ROOM_NUMS.clear()        # 新房间新编号：1 号重新开始
    ensure_room()     # 新房间也要有一份空聊天记录，而不是等第一条消息才生成
    load_messages()   # 切到新房间（此时是空的）
    touch_activity()
    return ROOM


def create_room():
    """点「创建房间」：已经有房间就接着用，没有才新开一个"""
    if ROOM:
        ensure_room()
        load_messages()
        touch_activity()
        return ROOM
    return renew_room()


def dissolve_room():
    """销毁房间：房间码当场作废，所有设备退回入口页

    房间是临时的：内存里的房间清掉，磁盘上的 数据/房间/<房间码>/
    （聊天记录 + 接收文件）也一起删掉，不做任何保留。
    """
    global ROOM
    room = ROOM
    ROOM = None
    with DATA_LOCK:
        MESSAGES.clear()
        ROOM_NUMS.clear()        # 编号跟着房间走：销毁即清空，新房间从 1 重新开始
    if room:
        purge_room_dir(room)
    return room or ''


def purge_room_dir(room):
    """把某个房间的整个文件夹从磁盘上删掉（聊天记录 + 接收文件一起）"""
    if not room or not re.fullmatch(r'[A-Z2-9]{10}', room):
        return
    target = room_dir(room)
    # 防御：只允许删 数据/房间/<10位码> 这一层，别的路径一律不碰
    if os.path.dirname(target) != ROOM_ROOT:
        return
    shutil.rmtree(target, ignore_errors=True)


# ── 房间生命周期：临时房间，不再永久保存 ─────────────────────────────────
# 房间在三件事发生后销毁（销毁 = 房间码作废 + 房间文件夹整个删掉）：
#   1. 房主页面关闭 / 刷新中断超过 ROOM_HOST_GONE_MAX 秒
#   2. 连续 ROOM_IDLE_MAX 秒没有任何通信（发消息、传文件、新设备加入都算）
#   3. 房主点「销毁房间」
ROOM_IDLE_MAX = 12 * 3600        # 秒：12 小时无通信自动销毁
ROOM_HOST_GONE_MAX = 60          # 秒：房主页面说再见后，等这么久还没回来就销毁
# 现在不再从磁盘恢复房间，这些值只在一次运行里有效
_ACTIVITY = {'ts': time.time()}              # 房间最后一次「通信」的时间
_HOST_PAGE = {'seen': False, 'ts': 0.0}      # 房主页面最后一次心跳
_HOST_GONE = {'ts': 0.0}                     # 房主页面说再见的时间（0 = 没说）


def touch_activity():
    """记一笔「房间刚才还有人来过」：发消息、传文件、新设备加入都算通信"""
    _ACTIVITY['ts'] = time.time()


def touch_host_page():
    """房主页面心跳：说明创建房间的那个页面还开着"""
    _HOST_PAGE['seen'] = True
    _HOST_PAGE['ts'] = time.time()
    _HOST_GONE['ts'] = 0.0      # 回来了就撤销「再见」


def mark_host_gone():
    """房主页面关闭/跳走时打的一声招呼（sendBeacon，等不回执）"""
    if _HOST_PAGE['seen']:
        _HOST_GONE['ts'] = time.time()


def destroy_if_expired():
    """检查房间该不该销毁，该销毁就销毁。返回销毁掉的房间码（没销毁返回空）"""
    if not ROOM:
        return ''
    now = time.time()
    reason = ''
    if _HOST_PAGE['seen'] and _HOST_GONE['ts'] and \
            now - _HOST_GONE['ts'] > ROOM_HOST_GONE_MAX:
        reason = '房主页面已关闭'
    elif now - _ACTIVITY['ts'] > ROOM_IDLE_MAX:
        reason = '超过 12 小时没有通信'
    if not reason:
        return ''
    room = ROOM
    dissolve_room()
    return room


def room_watchdog():
    """后台线程：每 10 秒检查一次房间是否到了该销毁的时候"""
    while True:
        try:
            destroy_if_expired()
        except Exception:
            pass
        time.sleep(10)


def purge_stale_rooms():
    """清掉磁盘上残留的所有房间文件夹（由看门狗在程序退出时调用）

    房间只在内存里活着：程序一退，房间就没了；磁盘上遗留的文件夹
    属于已经不存在的房间，按「不再永久保存」的规矩直接清掉。
    启动时不再做这件事——强杀、崩溃留下的残骸统一由提权的看门狗收尾。
    """
    if not os.path.isdir(ROOM_ROOT):
        return 0
    try:
        names = os.listdir(ROOM_ROOT)
    except OSError:
        return 0
    n = 0
    for name in names:
        if re.fullmatch(r'[A-Z2-9]{10}', name) and \
                os.path.isdir(os.path.join(ROOM_ROOT, name)):
            shutil.rmtree(os.path.join(ROOM_ROOT, name), ignore_errors=True)
            n += 1
    return n

# 局域网设备输入过正确房间码后拿到的凭证（存房间码本身，
# 换码/解散后自动失效，不需要额外的过期机制）
JOIN_COOKIE = 'lsroom'
# 房主页面上报的「外网直连设备数」：局域网设备看不到 P2P，只能靠这个知道房间里还有谁
P2P_REPORT = {'n': 0, 'ts': 0.0}
P2P_REPORT_TTL = 30      # 秒：房主页面关掉后，这个数字不再算数
# 房主页面上报的「外网直连设备清单」：{昵称: {'ip': 对方 IP, 'ts': 上报时间}}
# 外网设备走 PeerJS 直连本机页面，不会访问 8000 端口，后端原本完全看不到它们；
# 由房主页面把昵称 + 从 WebRTC 拿到的对端 IP 报上来，设备列表才能同时列出两条通道。
P2P_DEVICES = {}
P2P_DEVICE_TTL = 60      # 秒：超过这么久没被再次上报，说明这台设备已经离开


# ── 跨域白名单 ────────────────────────────────────────────────────────────
# 在线页（自定义域名 / GitHub Pages 地址）要读本机 http://127.0.0.1:8000 的接口，
# 属于跨源请求，必须明确放行。只放行自己的在线地址与本机回环，不用 *。
LEGACY_ORIGINS = {
    # 两个入口都常驻放行：client_url.txt 只能填一个，另一个靠这里兜住，
    # 否则换地址后从旧入口打开的页面会读不到本机服务（跨域被拒）。
    'https://zvzqvqdvd.top',         # 自定义域名
    'https://zvzqvqdvd.github.io',   # GitHub Pages 域名（含 /data-transmission 子路径）
}


def _allowed_origins():
    origins = set(LEGACY_ORIGINS)
    current = _read_client_url()      # 跟着 client_url.txt 走，改了地址不用重启
    if current:
        p = urllib.parse.urlparse(current)
        if p.scheme and p.netloc:
            origins.add("%s://%s" % (p.scheme, p.netloc))
    for host in ('127.0.0.1', 'localhost'):
        origins.add("http://%s:%d" % (host, PORT))
    return origins


def _origin_allowed(origin):
    """来源是否放行（白名单按当前 client_url.txt 实时算）"""
    return bool(origin) and origin in _allowed_origins()

# 预览用的类型白名单：不依赖 Windows 注册表，避免 mp4 被识别成 octet-stream
MIME_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
    '.ogv': 'video/ogg', '.ogg': 'video/ogg', '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/opus',
    '.pdf': 'application/pdf',
}

# 消息列表: [{id, type: 'text'/'file', content, name, size, time}]
MESSAGES = []
DATA_LOCK = threading.RLock()      # 保护 MESSAGES / CLIENTS / 消息文件

# 管理员会话令牌只保存在服务端，cookie 无法伪造
def _env_first(*names, default=''):
    """按顺序取第一个有值的环境变量：新名字优先，旧名字兜底

    改名（局域网互传 → 数据传输）时环境变量前缀也跟着换了，
    老用户机器上可能还留着 LANSHARE_*，这里兼容一下，不用他去改。
    """
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return default


DEFAULT_ADMIN_PASSWORD = "admin"
ADMIN_PASSWORD = (_env_first('DATATRANSMISSION_ADMIN_PASSWORD', 'LANSHARE_ADMIN_PASSWORD')
                  or DEFAULT_ADMIN_PASSWORD)
ADMIN_SESSIONS = set()
MAX_FILE_SIZE = int(_env_first('DATATRANSMISSION_MAX_FILE_SIZE', 'LANSHARE_MAX_FILE_SIZE',
                               default=str(4 * 1024 ** 3)))

# 客户端管理: {设备ID: {ip, ua, last_seen, name, joined, ts}}
# 设备 ID 存在浏览器的 lsdev cookie 里，同一 WiFi 下多台设备不会混成一台
CLIENTS = {}
DEVICE_COOKIE = 'lsdev'



def _prune_empty_dirs(root):
    """自底向上删掉空目录，旧布局搬完不留半截空壳"""
    if not os.path.isdir(root):
        return
    for dirpath, _dirnames, _filenames in os.walk(root, topdown=False):
        try:
            if not os.listdir(dirpath):
                os.rmdir(dirpath)
        except OSError:
            pass


def _move_file(src, dst):
    """搬一个文件：目标已存在就跳过（不覆盖），返回搬动计数"""
    if not os.path.isfile(src) or os.path.exists(dst):
        return 0
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
        return 1
    except OSError:
        return 0


def _json_is_blank(path):
    """目标 json 是空壳（0 字节）或内容坏了？这种"有文件没记录"的状态不该挡住搬迁"""
    try:
        if os.path.getsize(path) == 0:
            return True
        with open(path, 'r', encoding='utf-8') as f:
            json.load(f)
        return False
    except (OSError, ValueError):
        return True


def _move_chat_file(src, dst):
    """搬聊天记录：目标已有真实记录才跳过；目标不存在或只是空壳就直接覆盖过去"""
    if not os.path.isfile(src):
        return 0
    if os.path.exists(dst) and not _json_is_blank(dst):
        return 0
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst):
            os.remove(dst)
        shutil.move(src, dst)
        return 1
    except OSError:
        return 0


def migrate_legacy_data():
    """把旧布局搬进新布局，幂等：目标已存在就跳过，不覆盖任何东西

    新：数据/房间/<码>/{聊天记录.json, 接收文件/}
    旧1：数据/房间/<码>/聊天记录/messages.json  —— 提上来改名 聊天记录.json，空文件夹删掉
    旧2：数据/房间/<码>/messages.json           —— 改名为 聊天记录.json
    旧3：数据/聊天记录/<码>.json + 数据/接收文件/<码>/ —— 按房间码并进各自文件夹
    旧4：数据/接收文件/<散文件>、数据/聊天记录/messages.json —— 并进上次的房间
    另外：踢出功能已经整块删掉，房间里遗留的 踢出名单.json 顺手清掉。
    """
    moved = 0
    # 启动时没有房间，散文件只能按旧版落盘的房间码归位
    last_room = _load_room()
    try:
        # 注意：不能先 ensure_room()，否则会先把当前房间的空 聊天记录.json 写出来，
        # 后面真正的旧记录就成了"目标已存在"被跳过，聊天记录直接丢
        for code in sorted(os.listdir(ROOM_ROOT)):
            d = os.path.join(ROOM_ROOT, code)
            if not os.path.isdir(d) or code in ("聊天记录", "接收文件"):
                continue
            target = msg_file(code)
            # 旧1 优先：套在 聊天记录/ 里的那份比更早的散文件新
            moved += _move_chat_file(os.path.join(d, "聊天记录", "messages.json"), target)
            moved += _move_chat_file(os.path.join(d, "messages.json"), target)
            _drop_empty_chat_dir(d)
            _drop_kick_file(d)
            os.makedirs(upload_dir(code), exist_ok=True)
            # 搬完只剩空壳（0 字节 / 坏 json）就补一份空记录，别让页面读到坏文件
            if _json_is_blank(target):
                try:
                    with open(target, 'w', encoding='utf-8') as fp:
                        json.dump([], fp)
                except OSError:
                    pass
        # 旧2 / 旧3：上一版平铺在 数据/ 下的聊天记录与接收文件
        for name in (sorted(os.listdir(LEGACY_UPLOAD)) if os.path.isdir(LEGACY_UPLOAD) else []):
            s = os.path.join(LEGACY_UPLOAD, name)
            if os.path.isdir(s):                      # <码>/ 整个目录
                for f in os.listdir(s):
                    moved += _move_file(os.path.join(s, f),
                                        os.path.join(upload_dir(name), f))
            elif os.path.isfile(s) and last_room:     # 更早的散文件 → 上次的房间
                moved += _move_file(s, os.path.join(upload_dir(last_room), name))
        for name in (sorted(os.listdir(LEGACY_CHAT)) if os.path.isdir(LEGACY_CHAT) else []):
            s = os.path.join(LEGACY_CHAT, name)
            if name == "房间码.txt":
                continue
            if name == "messages.json":               # 最早：上次的房间
                if last_room:
                    moved += _move_chat_file(s, msg_file(last_room))
            elif name.endswith(".json"):              # <码>.json
                moved += _move_chat_file(s, msg_file(name[:-5]))
                os.makedirs(upload_dir(name[:-5]), exist_ok=True)
    except OSError:
        pass
    # 先删过期的房间码指针，再把搬空的旧目录收掉（否则空目录会因为它留着）
    _drop_room_files()
    for d in (LEGACY_UPLOAD, LEGACY_CHAT):
        _prune_empty_dirs(d)
    # 房间根目录常驻存在（里面是空的，建房时才多出一个房间码文件夹）
    try:
        os.makedirs(ROOM_ROOT, exist_ok=True)
    except OSError:
        pass
    if has_room():
        ensure_room()      # 当前房间补齐 接收文件/ + 聊天记录.json
    return moved


_MSG_CACHE = None   # (文件路径, mtime)：每台设备每 2 秒轮询一次 /messages，
                    # 十台设备高峰就是每秒好几次磁盘读 + JSON 解析；mtime 没变就不重读

def load_messages():
    global MESSAGES, _MSG_CACHE
    if not has_room():
        MESSAGES = []
        _MSG_CACHE = None
        return
    f = msg_file()
    try:
        mt = os.path.getmtime(f)
    except OSError:
        mt = None
    if mt is not None and _MSG_CACHE == (f, mt) and MESSAGES:
        return
    with DATA_LOCK:
        # 双重检查：拿锁的间隙里可能刚被别的线程写过，别用旧指纹盖掉新内容
        try:
            mt2 = os.path.getmtime(f)
        except OSError:
            mt2 = None
        if mt2 is not None and _MSG_CACHE == (f, mt2) and MESSAGES:
            return
        try:
            with open(f, 'r', encoding='utf-8') as fp:
                data = json.load(fp)
            MESSAGES = data if isinstance(data, list) else []
            _MSG_CACHE = (f, mt2)
        except Exception:
            MESSAGES = []
            _MSG_CACHE = None

def save_messages():
    if not has_room():
        return
    with DATA_LOCK:
        try:
            with open(msg_file(), 'w', encoding='utf-8') as f:
                json.dump(MESSAGES, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

# 迁移与首次加载放到 main() 里做：import 这个模块（自动化测试、外部脚本）不该
# 顺手改动 数据/ 目录——之前这两行写在模块级，一 import 就真的搬了一遍文件。

def short_ua(ua):
    """简化UA显示"""
    if not ua:
        return "未知设备"
    if "iPhone" in ua: return "iPhone"
    if "iPad" in ua: return "iPad"
    if "Android" in ua: return "安卓设备"
    if "Windows" in ua: return "Windows 设备"
    if "Macintosh" in ua or "Mac OS" in ua: return "macOS 设备"
    if "Mobile" in ua: return "移动设备"
    # 取浏览器名
    if "Chrome" in ua: return "Chrome浏览器"
    if "Firefox" in ua: return "Firefox浏览器"
    if "Safari" in ua: return "Safari浏览器"
    if "Edge" in ua: return "Edge浏览器"
    return ua[:30] + "..."

def screen_duration(t1, t2):
    """两次 HH:MM:SS 的间隔文案：「12 分钟」「1 小时 3 分」「45 秒」"""
    def sec(t):
        try:
            p = [int(x) for x in str(t).split(':')]
            while len(p) < 3:
                p.insert(0, 0)
            return p[0] * 3600 + p[1] * 60 + p[2]
        except Exception:
            return 0
    d = sec(t2) - sec(t1)
    if d < 0:
        d += 86400
    if d >= 3600:
        return f"{d // 3600} 小时 {d % 3600 // 60} 分"
    if d >= 60:
        return f"{d // 60} 分钟"
    return f"{d} 秒"


def track_client(handler, joined=None):
    """记录或更新客户端信息，返回设备ID

    设备ID 来自浏览器 cookie（lsdev），同一 WiFi 下多台设备互不干扰；
    第一次访问时生成，由 end_headers() 补进响应头。
    joined=True 表示这台设备已经用房间码进过房间；
    只有进过房间的设备才算「房间里有人」，路过打开网页不算。
    """
    ip = handler.client_address[0]
    ua = handler.headers.get('User-Agent', '')
    cid = (handler._get_cookie(DEVICE_COOKIE) or '').strip()
    if not re.fullmatch(r'[0-9a-f]{16}', cid or ''):
        cid = uuid.uuid4().hex[:16]
        handler._new_devid = cid
    now = time.strftime("%H:%M:%S")
    with DATA_LOCK:
        if cid not in CLIENTS:
            CLIENTS[cid] = {
                "ip": ip,
                "ua": ua,
                "name": short_ua(ua),
                "first_seen": now,
                "joined": bool(joined),
            }
        CLIENTS[cid]["ip"] = ip
        CLIENTS[cid]["last_seen"] = now
        CLIENTS[cid]["ts"] = time.time()   # 判断「还在不在」用时间戳，避免跨天比字符串
        if joined:
            CLIENTS[cid]["joined"] = True
    return cid


PEER_TIMEOUT = 25     # 秒：超过这么久没发过任何请求，算这台设备已经离开
_LOCAL_IPS = None


def local_ips():
    """本机自己的所有地址。本机开多个标签页时不该被算成「别人进来了」"""
    global _LOCAL_IPS
    if _LOCAL_IPS is not None:
        return _LOCAL_IPS
    ips = {'127.0.0.1', '::1', '0.0.0.0', get_lan_ip()}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ips.add(info[4][0])
    except Exception:
        pass
    _LOCAL_IPS = ips
    return ips


def lan_peer_count():
    """房间里有几台别的设备（局域网访问这台电脑的）。

    本机自己不算；房主端用这个判断「要不要等对方加入」。
    没输入过房间码的设备（只是打开页面）不算进房间。
    """
    now = time.time()
    mine = local_ips()
    seen = set()
    with DATA_LOCK:
        for info in CLIENTS.values():
            ip = info.get("ip", "")
            if not ip or ip in mine or is_loopback(ip):
                continue
            if now - info.get("ts", 0) >= PEER_TIMEOUT:
                continue
            if not info.get("joined"):
                continue      # 还没输房间码的设备不算房间成员
            seen.add(ip)      # 同一台设备开多个标签页只算一台
    return len(seen)


def p2p_report_count():
    """房主页面报上来的外网直连设备数；房主页面不在线就不算数"""
    with DATA_LOCK:
        if time.time() - P2P_REPORT.get('ts', 0) > P2P_REPORT_TTL:
            return 0
        return max(0, int(P2P_REPORT.get('n', 0) or 0))


def set_p2p_devices(items):
    """整表替换外网直连设备清单（房主每次都报全量，离开的自然消失）

    dev 是外网设备自己生成、存在 localStorage 里的设备 ID（HELLO 时带过来）：
    外网设备不经过 8000 端口，没有 lsdev cookie，只能靠它区分是哪一台。
    """
    now = time.time()
    fresh = {}
    for it in items or []:
        name = str(it.get('name') or '').strip()[:24]
        if not name:
            continue
        ip = str(it.get('ip') or '').strip()[:64]
        dev = str(it.get('dev') or '').strip()[:32]
        fresh[name] = {'ip': ip, 'dev': dev, 'ts': now}
    with DATA_LOCK:
        P2P_DEVICES.clear()
        P2P_DEVICES.update(fresh)
    return len(fresh)


def p2p_devices():
    """外网直连设备清单（房主页面报上来的），过期自动丢弃"""
    now = time.time()
    out = []
    with DATA_LOCK:
        for name, info in list(P2P_DEVICES.items()):
            if now - info.get('ts', 0) > P2P_DEVICE_TTL:
                P2P_DEVICES.pop(name, None)
                continue
            out.append({'name': name, 'ip': info.get('ip', ''),
                        'dev': info.get('dev', ''), 'channel': 'p2p'})
    out.sort(key=lambda x: x['name'])
    return out


def lan_devices():
    """已经用房间码进来的局域网设备（自己这台、以及只开了网页没输码的不算）"""
    now = time.time()
    mine = local_ips()
    out = []
    with DATA_LOCK:
        for cid, info in CLIENTS.items():
            ip = info.get('ip', '')
            if not ip or is_loopback(ip) or ip in mine:
                continue
            if not info.get('joined'):
                continue
            if now - info.get('ts', 0) >= PEER_TIMEOUT:
                continue
            out.append({'cid': cid,
                        'name': info.get('name') or ip,
                        'ip': ip,
                        'channel': 'lan',
                        'last': info.get('last_seen', '')})
    out.sort(key=lambda x: x['name'])
    return out


def _js_literal(v):
    """把值安全地嵌入单引号 JS 字符串字面量"""
    return (str(v).replace('\\', '').replace("'", '').replace('"', '')
            .replace('<', '').replace('>', '').replace('\n', '').replace('\r', ''))


def _fill(template, values):
    """替换 __NAME__ 形式的占位符，遇到没填的直接报错，避免半成品页面溜出去"""
    for key, value in values.items():
        template = template.replace(key, value)
    left = [k for k in values if k in template]
    if left:
        raise ValueError('页面占位符未填充: %s' % ', '.join(left))
    return template


def _page_build_fingerprint():
    """web/ 源文件指纹（10 位 md5 前缀），填进 __PAGE_BUILD__ 占位符

    邀请链接 / 二维码 / 复制的访问地址都带 ?v=<指纹>：手机浏览器
    （微信 X5、iOS Safari）对页面缓存非常顽固，程序更新后如果 URL 不变，
    对方扫到的还是旧缓存页，旧页连新程序轻则变慢、重则直接连不上。
    指纹跟着源文件走：任何一改，所有外发的 URL 自动变化，缓存即告失效。
    """
    import hashlib
    h = hashlib.md5()
    for name in ('page.html', 'app.css', 'vendor.js', 'app.js', 'room.js', 'gate.js'):
        h.update(web_asset(name).encode('utf-8'))
    return h.hexdigest()[:10]


def build_page(mode='host', client_list='', is_admin=False, p2p=True,
               join_required=False):
    """把 web/ 下的源文件内联成一份完整页面

    三个 JS 源文件按「公共核心 → 房间逻辑 → 入口页逻辑」拼成同一个 <script>，
    一次性填充占位符；交付出去仍然只有一个 HTML，不引入任何外部请求。
    host 模式由本地服务返回（带真实房间码与设备列表），guest 模式导出成静态页。
    p2p=False 用于「别人从局域网 IP 打开本机服务」的情况：照样能收发文字与文件
    （走 HTTP），但不注册 P2P 房主、不显示房间码，避免和本机抢同一个 Peer ID。
    join_required=True：局域网设备还没输入房间码，先停入口页。
    """
    values = {
        '__CLIENT_LIST__': client_list,
        '__IS_ADMIN__': 'true' if is_admin else 'false',
        '__SERVER_MODE__': mode,
        '__PORT__': str(PORT),
        '__ROOM__': (ROOM or '') if mode == 'host' else '',
        '__HAS_ROOM__': 'true' if (mode == 'host' and has_room()) else 'false',
        '__CLIENT_URL__': _js_literal(_read_client_url()),
        '__P2P_ENABLED__': 'true' if (mode == 'host' and p2p) else 'false',
        '__JOIN_REQUIRED__': 'true' if join_required else 'false',
        '__LAN_URL__': ('http://%s:%d' % (get_lan_ip(), PORT)) if mode == 'host' else '',
        '__PAGE_BUILD__': _page_build_fingerprint(),
        '__HOST_DISPLAY__': '' if mode == 'host' else 'display:none;',
        '__GUEST_DISPLAY__': 'display:block;' if mode == 'guest' else 'display:none;',
    }
    shell = _fill(web_asset('page.html'), values)
    # 三个文件只是源码层面的拆分，拼回一个 script 后与原来完全等价：
    # 函数声明整体提升，顶层 let/const 也都在启动分发之前执行完，没有跨文件作用域问题。
    script = _fill('\n'.join((
        web_asset('app.js'),
        web_asset('room.js'),
        web_asset('gate.js'),
    )), values)
    shell = shell.replace('__APP_CSS__', web_asset('app.css'))
    shell = shell.replace('__VENDOR_JS__', web_asset('vendor.js'))
    shell = shell.replace('__APP_JS__', script)
    return shell


def build_static_page():
    """导出访客版：零后端请求、零外部依赖"""
    return build_page(mode='guest', client_list='', is_admin=False)


# 静态页文件名与需要同步的位置（相对 BASE_DIR）
# 两处都要写：
#   data-transmission/  程序自己用的发布目录，GitHub 上传就是这一份
#   ''（根目录）        仓库根目录同时是 GitHub Pages 站点根，必须有一份 index.html
# 两处内容完全一致，谁都不会落后——只写一处会让仓库里的两份逐渐对不上。
STATIC_PAGE_NAME = 'index.html'
STATIC_PAGE_DIRS = ('data-transmission', '')


def export_static_page(silent=True):
    """把访客版页面写入 index.html，返回实际更新过的路径列表

    页面只有 PAGE 一份模板，静态页一律由 build_static_page() 生成，
    所以只要经过这里，index.html 就不会和源码里的页面逻辑脱节。
    内容一致时跳过写入，不做无谓改动。
    """
    page = build_static_page()
    written = []
    for sub in STATIC_PAGE_DIRS:
        target_dir = os.path.join(BASE_DIR, sub) if sub else BASE_DIR
        target = os.path.join(target_dir, STATIC_PAGE_NAME)
        try:
            # 目录被删掉（或首次运行还没有）就自己建回来，而不是安静跳过
            os.makedirs(target_dir, exist_ok=True)
            old = None
            if os.path.isfile(target):
                with open(target, 'r', encoding='utf-8', newline='') as f:
                    old = f.read()
            if old == page:
                continue
            with open(target, 'w', encoding='utf-8', newline='') as f:
                f.write(page)
            written.append(target)
        except Exception as e:
            if not silent:
                print(f"  ⚠️ 导出 {target} 失败: {e}")
    return written


def human_size(n):
    if n < 1024:
        return f"{int(n)} B"
    for u in ['KB', 'MB', 'GB', 'TB']:
        n /= 1024
        if n < 1024:
            return f"{n:.1f} {u}"
    return f"{n:.1f} PB"


_WIN_RESERVED = ({'CON', 'PRN', 'AUX', 'NUL'}
                 | {f'COM{i}' for i in range(1, 10)}
                 | {f'LPT{i}' for i in range(1, 10)})

def unique_path(raw_name):
    """过滤危险文件名，返回 (绝对路径, 实际保存名)；同名文件自动加序号"""
    name = os.path.basename(str(raw_name).replace('\\', '/')).strip()
    name = ''.join(c for c in name if ord(c) >= 32 and c not in '<>:"|?*')
    name = name.strip('. ') or 'unnamed'
    stem, ext = os.path.splitext(name)
    if stem.upper() in _WIN_RESERVED:
        name = stem + '_1' + ext
        stem = stem + '_1'
    target = os.path.join(upload_dir(), name)
    if not os.path.exists(target):
        return target, name
    i = 1
    while True:
        candidate = f"{stem}_{i}{ext}"
        path = os.path.join(upload_dir(), candidate)
        if not os.path.exists(path):
            return path, candidate
        i += 1


class _MultipartStream:
    """支持回放的流式读取器：上传内容不再整包读进内存"""
    def __init__(self, rfile, length):
        self.rfile = rfile
        self.remaining = length
        self.buf = b''

    def read(self, n):
        head = b''
        if self.buf:
            head = self.buf[:n]
            self.buf = self.buf[n:]
            if len(head) == n:
                return head
        need = n - len(head)
        if self.remaining <= 0:
            return head
        chunk = self.rfile.read(min(need, self.remaining))
        self.remaining -= len(chunk)
        return head + chunk

    def readline(self):
        while b'\n' not in self.buf and self.remaining > 0:
            chunk = self.rfile.read(min(4096, self.remaining))
            if not chunk:
                break
            self.remaining -= len(chunk)
            self.buf += chunk
        idx = self.buf.find(b'\n')
        if idx < 0:
            out, self.buf = self.buf, b''
            return out
        out, self.buf = self.buf[:idx + 1], self.buf[idx + 1:]
        return out

    def unread(self, data):
        if data:
            self.buf = data + self.buf


def parse_multipart_stream(rfile, boundary, length):
    """流式解析 multipart/form-data，逐块写盘

    返回 (saved, fields)：
      saved  —— [(保存名, 字节数)]
      fields —— 普通文本字段（from / id 等），用来标注是谁发的、对应哪条消息
    """
    saved, fields = [], {}
    if length <= 0:
        return saved, fields
    stream = _MultipartStream(rfile, length)
    marker = b'--' + boundary
    sep = b'\r\n' + marker
    keep = len(sep) - 1
    if marker not in stream.readline():
        return saved, fields
    while True:
        headers = []
        while True:
            line = stream.readline()
            if not line or line in (b'\r\n', b'\n'):
                break
            if sum(len(h) for h in headers) > 8192:
                break
            headers.append(line.decode('utf-8', 'replace').strip())
        filename = None
        field_name = None
        for h in headers:
            if h.lower().startswith('content-disposition'):
                m = re.search(r'filename="([^"]*)"', h, re.I)
                if m:
                    filename = m.group(1)
                else:
                    m2 = re.search(r"filename\*=UTF-8''([^;]+)", h, re.I)
                    if m2:
                        filename = urllib.parse.unquote(m2.group(1))
                mn = re.search(r'\bname="([^"]*)"', h, re.I)
                if mn:
                    field_name = mn.group(1)
                break
        fout, target, save_name, written = None, None, None, 0
        if filename:
            target, save_name = unique_path(filename)
            fout = open(target, 'wb')
        found = False
        field_buf = [] if (not fout and field_name) else None
        try:
            pending = b''
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    break
                data = pending + chunk
                idx = data.find(sep)
                if idx >= 0:
                    if fout:
                        fout.write(data[:idx])
                        written += idx
                    elif field_buf is not None:
                        field_buf.append(data[:idx])
                    stream.unread(data[idx + len(sep):])
                    found = True
                    break
                cut = max(0, len(data) - keep)
                if fout:
                    fout.write(data[:cut])
                    written += cut
                elif field_buf is not None and keep < len(data):
                    field_buf.append(data[:cut])
                    if sum(len(x) for x in field_buf) > 8192:
                        field_buf = []
                pending = data[cut:]
                if written > MAX_FILE_SIZE:
                    raise ValueError('文件超过大小上限')
            if fout and not found and pending:
                fout.write(pending)
                written += len(pending)
        except Exception:
            if fout:
                fout.close()
            if target and os.path.isfile(target):
                try:
                    os.remove(target)
                except OSError:
                    pass
            raise
        finally:
            if fout and not fout.closed:
                fout.close()
        if save_name:
            saved.append((save_name, written))
        if field_buf is not None and field_name:
            try:
                fields[field_name] = b''.join(field_buf).decode('utf-8', 'replace')
            except Exception:
                fields[field_name] = ''
        if not found:
            break
        tail = stream.readline()
        if not tail or tail.startswith(b'--'):
            break
    return saved, fields


def build_client_list(current_cid):
    """生成设备列表HTML：外网直连 + 局域网两条通道分开标注，各带真实 IP

    外网设备走 PeerJS 直连本机页面，不经过 8000 端口，后端看不见它们，
    名单由房主页面报上来（P2P_DEVICES）；局域网设备由后端自己记录。
    """
    with DATA_LOCK:
        snapshot = [(cid, dict(info)) for cid, info in CLIENTS.items()]
    p2p_list = p2p_devices()

    items = []
    # ---- 外网直连：昵称来自对方自己起的设备名，IP 由房主从 WebRTC 对端候选里读出来 ----
    for dev in p2p_list:
        ip = dev.get('ip') or ''
        ip_text = ip if ip else 'IP 未知（NAT 后拿不到）'
        name = dev['name']
        items.append(
            f'<li>'
            f'<div class="dev-info">'
            f'<div class="dev-name">设备 '
            f'<span class="badge wan">外网</span>'
            f'<span class="badge online">在线</span></div>'
            f'<div class="dev-ip">IP: {html.escape(ip_text)} · 点对点直连</div>'
            f'</div>'
            f'</li>'
        )

    # ---- 局域网：后端自己记录 ----
    for cid, info in snapshot:
        ip = info["ip"]
        badge = '<span class="badge lan">局域网</span>'
        badge += '<span class="badge online">在线</span>'
        if cid == current_cid:
            badge += '<span class="badge self">本机</span>'
        elif not info.get('joined'):
            badge += '<span class="badge idle">未进房间</span>'
        last = info.get('last_seen', info.get('first_seen', ''))
        items.append(
            f'<li>'
            f'<div class="dev-info">'
            f'<div class="dev-name">设备 {badge}</div>'
            f'<div class="dev-ip">IP: {html.escape(ip)} · 最后活动: {html.escape(str(last))}</div>'
            f'</div>'
            f'</li>'
        )

    if not items:
        return '<li><span style="color:#999;font-size:14px;">暂无设备连接</span></li>'
    return '\n'.join(items)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # 静默日志

    def _get_cookie(self, name):
        """读取cookie"""
        cookie_header = self.headers.get('Cookie', '')
        for item in cookie_header.split(';'):
            if '=' in item:
                k, v = item.strip().split('=', 1)
                if k == name:
                    return v
        return None

    def _join_cookie_ok(self):
        """局域网设备是否已经用房间码进过房间

        凭证里存的就是房间码本身：换码 / 解散之后旧凭证自动失效，
        不需要额外的过期机制。
        """
        if not ROOM:
            return False
        got = self._get_cookie(JOIN_COOKIE) or ''
        return got.strip().upper() == ROOM

    def _lan_needs_join(self):
        """这台设备是否需要先输房间码

        本机（回环）永远是房主，不用输；局域网设备要验证过一次。
        """
        if is_self_client(self.client_address[0]):
            return False
        return not self._join_cookie_ok()

    def _is_guest_client(self):
        """是不是「别的设备」在访问（不是本机房主页面）"""
        return not is_self_client(self.client_address[0])

    def _join_cookie_header(self):
        """Set-Cookie 的值：凭证就是房间码本身，换码即失效"""
        return '%s=%s; Path=/; SameSite=Lax; Max-Age=604800' % (JOIN_COOKIE, ROOM)

    def _is_admin(self):
        """本机（双击运行程序的那台电脑）天然就是管理员，不用输密码

        其他设备必须先 POST /admin-login 用密码换一个服务端会话令牌（cookie sid），
        只有令牌能伪造不了——局域网设备本来就不给管理入口（前端隐藏齿轮）。
        """
        if is_loopback(self.client_address[0]):
            return True
        sid = self._get_cookie('sid')
        with DATA_LOCK:
            return bool(sid and sid in ADMIN_SESSIONS)

    def end_headers(self):
        """统一补跨域头：只对白名单来源放行，其他源拿不到响应内容"""
        origin = self.headers.get('Origin', '')
        if _origin_allowed(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            # Chrome 的私有网络访问预检需要这个头，否则 https 页面取不到本机数据
            self.send_header('Access-Control-Allow-Private-Network', 'true')
        # 第一次来的设备分配一个 ID，之后靠它把「谁是谁」区分开
        devid = getattr(self, '_new_devid', '')
        if devid:
            self._new_devid = ''
            self.send_header('Set-Cookie',
                             '%s=%s; Path=/; SameSite=Lax; Max-Age=31536000'
                             % (DEVICE_COOKIE, devid))
        super().end_headers()

    def _origin_ok(self):
        """写操作校验来源，防止其他网站盲发指令

        - 没带 Origin：非浏览器请求，放行
        - 同源（Origin 的 host:port 与本服务一致）：放行 —— 局域网设备就是这样访问的
        - 其余必须在白名单里（在线页 https → 本机 8000 属于跨源，要显式放行）
        """
        origin = self.headers.get('Origin', '')
        if not origin:
            return True
        if _origin_allowed(origin):
            return True
        try:
            p = urllib.parse.urlparse(origin)
            host = self.headers.get('Host', '')
            if p.netloc and host and p.netloc == host:
                return True
        except ValueError:
            pass
        return False

    def _send_html(self, html_str, cookie=None):
        body = html_str.encode('utf-8')
        self.send_response(200)
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        # 页面模板在代码里，改完重启就该立刻生效，禁止浏览器缓存旧页面
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200, cookie=None):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.end_headers()
        self.wfile.write(body)

    def _remember_name(self, nick):
        """局域网设备自报设备名（手机AB / 电脑ZZ）时更新设备列表

        只认「这台设备用自己的 IP 亲口说的」：房主替外网设备转存消息时，
        from 是外网设备的昵称，不能拿来改名房主那一行。
        """
        nick = (nick or '').strip()[:24]
        if not nick or not getattr(self, '_cid', ''):
            return
        if is_self_client(self.client_address[0]):
            return
        with DATA_LOCK:
            info = CLIENTS.get(self._cid)
            if info and info.get('ip') == self.client_address[0]:
                info['name'] = nick

    def _serve_file(self, fpath, inline=False):
        """发送本地文件：支持 Range（视频拖进度条必须）与 inline 在线预览"""
        size = os.path.getsize(fpath)
        base = os.path.basename(fpath)
        ext = os.path.splitext(base)[1].lower()
        ctype = MIME_TYPES.get(ext) or mimetypes.guess_type(base)[0] or 'application/octet-stream'

        start, end, status = 0, size - 1, 200
        range_hdr = self.headers.get('Range', '')
        if range_hdr.startswith('bytes=') and size > 0:
            part = range_hdr[6:].split(',')[0].strip()
            first, _, last = part.partition('-')
            try:
                if first == '':
                    start = max(0, size - int(last))
                else:
                    start = int(first)
                    if last:
                        end = min(int(last), size - 1)
                if start > end or start >= size:
                    raise ValueError
                status = 206
            except ValueError:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return

        length = end - start + 1 if size > 0 else 0
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Disposition',
                         f"{'inline' if inline else 'attachment'}; "
                         f"filename*=UTF-8''{urllib.parse.quote(base)}")
        self.send_header('Accept-Ranges', 'bytes')
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'private, max-age=120')
        self.end_headers()
        if length <= 0:
            return
        with open(fpath, 'rb') as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                block = f.read(min(65536, remaining))
                if not block:
                    break
                try:
                    self.wfile.write(block)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(block)

    def do_OPTIONS(self):
        """跨源预检：在线页（https）访问本机接口时会先发这个"""
        origin = self.headers.get('Origin', '')
        if origin and not _origin_allowed(origin):
            self.send_response(403)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        # 统一记录设备；局域网设备要先输房间码，通过后才算房间成员
        joined = is_self_client(self.client_address[0]) or self._join_cookie_ok()
        cid = track_client(self, joined=joined)

        # 没输房间码的局域网设备只能拿页面本身，不能读写房间内容
        if path not in ('/', '/index.html', '/api/join') and self._lan_needs_join():
            self._json({'ok': False, 'code': 'NEED_JOIN',
                        'msg': '请先输入房间码加入房间'}, 403)
            return

        if path == '/' or path == '/index.html':
            # 只有本机（回环）访问才当 P2P 房主；别人从局域网 IP 打开只做 HTTP 客户端，
            # 而且要先用房间码进门，不能打开网页就直接看到聊天内容
            loop = is_loopback(self.client_address[0])
            self._send_html(build_page('host', build_client_list(cid), self._is_admin(),
                                       p2p=loop, join_required=(not loop and not joined)))

        elif path == '/api/host':
            # 在线页（github.io）靠这个接口判断「本机程序是否在跑」，并取同一个房间码
            # has_room=False：程序在跑，但房主还没点「创建房间」
            self._json({
                'ok': True,
                'online': True,
                'room': ROOM or '',
                'has_room': has_room(),
                'port': PORT,
                'ip': get_lan_ip(),
                'client_url': _read_client_url(),
                'peers': lan_peer_count() if has_room() else 0,
                'data_dir': room_dir() if has_room() else ROOM_ROOT,
                'closed': not has_room(),
            })

        elif path == '/api/devices':
            # 设备清单：外网直连（房主报上来的）+ 局域网（后端自己记的），
            # 管理面板打开时用它刷新，两条通道分开标注、各带 IP。
            # 清单里有别的设备地址，只给房主这台电脑 / 登录过的管理员，
            # 局域网里其他设备即使进了房间也不能顺手拿走一份。
            if self._is_guest_client() and not self._is_admin():
                self._json({'ok': False, 'msg': '无权查看设备清单'}, 403)
                return
            with DATA_LOCK:
                snapshot = [(cid_, dict(info)) for cid_, info in CLIENTS.items()]
            lan = []
            for cid_, info in snapshot:
                ip = info.get('ip', '')
                lan.append({
                    'cid': cid_,
                    'name': info.get('name') or ip,
                    'ip': ip,
                    'channel': 'lan',
                    'self': cid_ == cid,
                    'joined': bool(info.get('joined')),
                    'last': info.get('last_seen', info.get('first_seen', '')),
                })
            self._json({'ok': True, 'p2p': p2p_devices(), 'lan': lan})

        elif path == '/messages':
            # 房主还没点「创建房间」：没有房间可读，让页面退回入口页
            if not has_room():
                self._json({'ok': True, 'messages': [], 'rev': '', 'room': '',
                            'peers': 0, 'p2p': 0, 'devices': [],
                            'client_url': _read_client_url(), 'closed': True})
                return
            # 每次从磁盘重载，保证手动删除磁盘文件后能同步
            load_messages()
            with DATA_LOCK:
                snapshot = [dict(m) for m in MESSAGES]
            result = []
            updir = upload_dir()
            for m in snapshot:
                if m.get('type') == 'file':
                    fpath = os.path.join(updir, m.get('name', ''))
                    if not os.path.isfile(fpath):
                        continue
                result.append(m)
            # 内容指纹：删一条加一条导致数量不变时，前端也能感知变化
            payload = json.dumps(result, ensure_ascii=False, sort_keys=True)
            rev = hashlib.md5(payload.encode('utf-8')).hexdigest()[:12]
            # devices 里带每个成员的 IP：其他设备只拿「几台设备」这类数字，
            # 不给清单（前端也只给房主端显示人数与 IP）。
            owner_view = (not self._is_guest_client()) or self._is_admin()
            devices = (p2p_devices() + lan_devices()) if owner_view else []
            status = {'room': ROOM, 'peers': lan_peer_count(),
                      'p2p': p2p_report_count(), 'devices': devices,
                      # 每台设备自己的来源 IP：加入方页面上显示「本机 IP」用，
                      # 谁请求就是谁的，不泄露别人地址
                      'self_ip': self.client_address[0],
                      # 头像编号表（设备名 -> 编号）：房主上报，所有设备渲染消息头像用
                      'nums': dict(ROOM_NUMS),
                      # 顺带把当前在线地址给页面：在线页（静态文件）靠它跟上 client_url.txt 的改动
                      'client_url': _read_client_url(), 'closed': False}
            # 轮询短路：客户端带上旧指纹且消息没变 → 只回状态字段，不回整包消息。
            # 人数 / 设备 / 关闭状态仍随每次轮询下发，设备进出照样即时可见。
            if qs.get('rev', [''])[0] == rev and rev:
                self._json(dict(status, ok=True, unchanged=True, rev=rev))
                return
            self._json(dict(status, ok=True, messages=result, rev=rev))

        elif path == '/p2p-client':
            # 兼容旧的「下载页面」入口，内容与在线版逐字一致
            self._send_html(build_static_page())

        elif path == '/download':
            if not has_room():
                self._json({'ok': False, 'msg': '房间还没创建'}, 404)
                return
            name = qs.get('name', [''])[0]
            safe = os.path.basename(name.replace('\\', '/'))
            fpath = os.path.join(upload_dir(), safe)
            # inline=1 用于聊天里的图片 / 视频 / 音频 / PDF 在线预览
            inline = qs.get('inline', [''])[0] in ('1', 'true', 'yes')
            if os.path.isfile(fpath):
                touch_activity()      # 下载也算一次通信
                self._serve_file(fpath, inline=inline)
            else:
                self._json({'ok': False, 'msg': '文件不存在'}, 404)

        else:
            self._json({'ok': False, 'msg': '未知接口'}, 404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path

        # 登录单独处理：不需要先输入房间码
        if path == '/admin-login':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(min(length, 4096)).decode('utf-8', 'replace')
            pwd = urllib.parse.parse_qs(body).get('password', [''])[0]
            if hmac.compare_digest(pwd, ADMIN_PASSWORD):
                token = secrets.token_urlsafe(24)
                with DATA_LOCK:
                    ADMIN_SESSIONS.add(token)
                payload = b'{"ok":true}'
                self.send_response(200)
                self.send_header('Set-Cookie',
                                 f'sid={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400')
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            else:
                self._json({'ok': False, 'msg': '密码错误'}, 401)
            return

        joined = is_self_client(self.client_address[0]) or self._join_cookie_ok()
        cid = track_client(self, joined=joined)
        self._cid = cid

        # 来自其他网站的指令一律拒绝（在线页和本机页面不受影响）
        if not self._origin_ok():
            self._json({'ok': False, 'msg': '来源不被允许'}, 403)
            return

        # 用房间码进门：唯一一个不需要事先验证的写接口
        if path == '/api/join':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(min(length, 4096)).decode('utf-8', 'replace')
            want = (urllib.parse.parse_qs(body).get('room', [''])[0] or '').strip().upper()
            if not has_room():
                self._json({'ok': False, 'code': 'NO_ROOM',
                            'msg': '房间还没创建，请让房主先点「创建房间」'}, 409)
            elif want and want == ROOM:
                cid = track_client(self)
                # 只在本进程里把同一条设备记录标成「进过房间」，
                # 不再调一次 track_client（那会再生成一个设备 ID，多出一条空记录）
                with DATA_LOCK:
                    info = CLIENTS.get(cid)
                    if info:
                        info['joined'] = True
                        info['ts'] = time.time()
                touch_activity()      # 有新设备加入：房间还活着
                self._json({'ok': True, 'room': ROOM},
                           cookie=self._join_cookie_header())
            else:
                self._json({'ok': False, 'msg': '房间码不正确，请向房主确认'})
            return

        # 没输房间码就来的写请求一律拒绝
        if self._lan_needs_join():
            self._json({'ok': False, 'code': 'NEED_JOIN',
                        'msg': '请先输入房间码加入房间'}, 403)
            return

        # 房主页面报「外网直连几台」，局域网设备靠它知道房间里还有谁
        if path == '/api/stats':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(min(length, 4096)).decode('utf-8', 'replace')
            raw = (urllib.parse.parse_qs(body).get('p2p', [''])[0] or '').strip()
            try:
                n = max(0, min(int(raw or '0'), 999))
            except ValueError:
                n = 0
            with DATA_LOCK:
                P2P_REPORT['n'] = n
                P2P_REPORT['ts'] = time.time()
            self._json({'ok': True})
            return

        # 房主页面报「外网直连设备清单」：昵称 + 对方 IP
        # 外网设备点了对点直连，根本不访问这个服务，后端只能靠房主转告
        if path == '/api/devices':
            if not is_self_client(self.client_address[0]):
                self._json({'ok': False, 'msg': '只有房主能上报设备清单'}, 403)
                return
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(min(length, 64 * 1024)).decode('utf-8', 'replace')
            try:
                data = json.loads(raw or '{}')
            except ValueError:
                data = {}
            items = data.get('devices') if isinstance(data, dict) else None
            if not isinstance(items, list):
                items = []
            n = set_p2p_devices(items)
            # 头像编号表：房主按加入顺序算好随设备清单一起报上来
            nums = data.get('nums') if isinstance(data, dict) else None
            if isinstance(nums, dict):
                clean = {}
                for k, v in nums.items():
                    try:
                        nk = str(k)[:40]
                        nv = int(v)
                    except (TypeError, ValueError):
                        continue
                    if nk and 1 <= nv <= 999:
                        clean[nk] = nv
                with DATA_LOCK:
                    ROOM_NUMS.clear()
                    ROOM_NUMS.update(clean)
            self._json({'ok': True, 'count': n})
            return

        # 房间的开关只能由本机（房主）操作，局域网里的设备不行
        if path in ('/api/room/create', '/api/room/renew',
                    '/api/room/dissolve', '/api/room/open',
                    '/api/room/heartbeat', '/api/room/bye'):
            if not is_self_client(self.client_address[0]):
                self._json({'ok': False, 'msg': '只有房主能管理房间'}, 403)
                return
            if path == '/api/room/heartbeat':
                # 房主页面每 10 秒报一次平安；页面关掉后心跳停了，看门狗就会收房
                touch_host_page()
                self._json({'ok': True})
            elif path == '/api/room/bye':
                # 房主页面关闭/跳走时用 sendBeacon 发的告别（无 body，等不回执）
                mark_host_gone()
                self._json({'ok': True})
            elif path == '/api/room/create':
                # 「创建房间」：没有房间才新开，已经有了就接着用同一个码
                self._json({'ok': True, 'room': create_room()})
            elif path == '/api/room/renew':
                self._json({'ok': True, 'room': renew_room()})
            elif path == '/api/room/dissolve':
                self._json({'ok': True, 'room': dissolve_room()})
            else:
                # 旧页面用的 /api/room/open，等价于「创建房间」
                self._json({'ok': True, 'room': create_room()})
            return

        # 没有房间：晚一步刷新的设备不许再把内容塞进来
        if not has_room() and path in ('/text', '/upload'):
            self._json({'ok': False, 'code': 'NO_ROOM', 'msg': '房间还没创建'}, 409)
            return

        if path == '/admin-logout':
            sid = self._get_cookie('sid')
            with DATA_LOCK:
                ADMIN_SESSIONS.discard(sid)
            payload = b'{"ok":true}'
            self.send_response(200)
            self.send_header('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # 删除聊天记录里的文件：要求管理员会话，且一律走 POST
        if path == '/delete':
            if not self._is_admin():
                self._json({'ok': False, 'msg': '需要管理员权限'}, 403)
                return
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(min(length, 4096)).decode('utf-8', 'replace')
            params = urllib.parse.parse_qs(body)

            name = params.get('name', [''])[0]
            safe = os.path.basename(name.replace('\\', '/'))
            fpath = os.path.join(upload_dir(), safe)
            if not safe or not os.path.isfile(fpath):
                self._json({'ok': False, 'msg': '文件不存在'}, 404)
                return
            try:
                os.remove(fpath)
                with DATA_LOCK:
                    MESSAGES[:] = [m for m in MESSAGES
                                   if not (m.get('type') == 'file' and m.get('name') == safe)]
                save_messages()
                self._json({'ok': True})
            except OSError as e:
                self._json({'ok': False, 'msg': str(e)}, 500)
            return

        if path == '/upload':
            ctype = self.headers.get('Content-Type', '')
            if 'multipart/form-data' not in ctype:
                self._json({'ok': False, 'msg': '格式错误'}, 400)
                return
            boundary = None
            for part in ctype.split(';'):
                part = part.strip()
                if part.startswith('boundary='):
                    boundary = part[len('boundary='):].strip('"').encode()
                    break
            if not boundary:
                self._json({'ok': False, 'msg': '无 boundary'}, 400)
                return
            length = int(self.headers.get('Content-Length', 0))
            if length > MAX_FILE_SIZE + 1024 * 1024:
                self._json({'ok': False, 'msg': '请求体超过大小上限'}, 413)
                return
            try:
                saved, fields = parse_multipart_stream(self.rfile, boundary, length)
            except Exception as e:
                self._json({'ok': False, 'msg': f'解析失败: {e}'}, 400)
                return
            touch_activity()      # 收到文件：房间还活着
            # from / id：房主替外网设备转存时带上，用来标注来源和对应同一条消息
            sender = (fields.get('from', '') or '').strip()[:40] or self.client_address[0]
            self._remember_name(fields.get('from', ''))
            want_id = (fields.get('id', '') or '').strip()[:32]
            ids = []
            names = []
            with DATA_LOCK:
                for save_name, size in saved:
                    mid = want_id or uuid.uuid4().hex[:12]
                    want_id = ''      # 一次传多个文件时，id 只给第一个
                    names.append(save_name)
                    MESSAGES.append({
                        "id": mid,
                        "type": "file",
                        "name": save_name,
                        "size": human_size(size),
                        "time": time.strftime("%H:%M:%S"),
                        "ip": sender,
                    })
                    ids.append(mid)
            save_messages()
            # names：实际落盘的文件名（重名会自动加序号），前端据此告诉用户存到哪了
            self._json({'ok': True, 'count': len(saved), 'ids': ids, 'names': names})
            return

        if path == '/text':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(min(length, 1024 * 1024)).decode('utf-8', 'replace')
            qs = urllib.parse.parse_qs(body)
            content = qs.get('content', [''])[0]
            # from：外网直连的文字由房主端代转，用来标注真实来源，缺省用请求方 IP
            sender_from = (qs.get('from', [''])[0] or '').strip()[:40]
            sender = sender_from or self.client_address[0]
            self._remember_name(sender_from)
            # id：发送方生成的消息 id，一路带到接收端，用来做去重（同一条只显示一次）
            want_id = (qs.get('id', [''])[0] or '').strip()[:32]
            mid = ''
            if content.strip():
                mid = want_id or uuid.uuid4().hex[:12]
                with DATA_LOCK:
                    MESSAGES.append({
                        "id": mid,
                        "type": "text",
                        "content": content[:20000],
                        "time": time.strftime("%H:%M:%S"),
                        "ip": sender,
                    })
                save_messages()
            touch_activity()          # 有消息往来：房间还活着
            self._json({'ok': True, 'id': mid})
            return

        if path == '/screen':
            # 屏幕共享历史卡：start 写一条 type=screen 的记录，stop 把同一条
            # 记录改成「已停止」——一条卡片状态切换，不产生第二条消息。
            # 只有房主会调（共享方是访客时由房主代转），和 /text 一样在本机白名单里。
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(min(length, 4096)).decode('utf-8', 'replace')
            qs = urllib.parse.parse_qs(body)
            st = qs.get('status', [''])[0]
            mid = (qs.get('id', [''])[0] or '').strip()[:32]
            sender = (qs.get('from', [''])[0] or '').strip()[:40] or self.client_address[0]
            if not mid or st not in ('start', 'stop'):
                self._json({'ok': False, 'msg': '参数错误'}, 400)
                return
            now = time.strftime("%H:%M:%S")
            with DATA_LOCK:
                if st == 'start':
                    # 同 id 重复上报（重试）不追加第二条
                    if not any(m.get('id') == mid and m.get('type') == 'screen'
                               for m in MESSAGES):
                        # 正常情况同一时间只允许一路共享：开始新的共享时，
                        # 把残留的其它 live 共享卡清掉（旧版本重复写卡的脏数据）
                        MESSAGES[:] = [m for m in MESSAGES
                                       if not (m.get('type') == 'screen'
                                               and m.get('status') == 'live'
                                               and m.get('id') != mid)]
                        MESSAGES.append({
                            "id": mid,
                            "type": "screen",
                            "status": "live",
                            "ip": sender,
                            "time": now,
                        })
                else:
                    for m in reversed(MESSAGES):
                        if (m.get('id') == mid and m.get('type') == 'screen'
                                and m.get('status') == 'live'):
                            m['status'] = 'ended'
                            m['end'] = now
                            m['dur'] = screen_duration(m.get('time', ''), now)
                            break
            save_messages()
            touch_activity()
            self._json({'ok': True})
            return

        self._json({'ok': False, 'msg': '未知接口'}, 404)


def _ip_rank(ip):
    """候选地址排序：越像「真实局域网」越靠前

    WSL / Docker 的虚拟网卡也常常落在 172.x，排到最后；
    192.168 最常见，10.x 次之，其余次之。
    """
    if ip.startswith('192.168.'):
        return 0
    if ip.startswith('10.'):
        return 1
    if ip.startswith('172.'):
        return 3
    return 2


def get_lan_ip():
    """取本机在局域网里的 IPv4 地址

    只靠 UDP connect 取「出口地址」不够稳：机器上装了 WSL、Docker 或虚拟机时，
    路由表可能把这个出口选到 172.19.x 这类虚拟网卡，于是启动了却给出一个
    别的设备根本连不上的局域网入口。这里收集所有候选再按可靠性排序。
    """
    cands = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        cands.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            cands.append(info[4][0])
    except Exception:
        pass
    cands = [c for c in cands
             if c and c != '0.0.0.0'
             and not c.startswith('127.') and not c.startswith('169.254.')]
    if not cands:
        return "127.0.0.1"
    uniq = []
    for c in cands:
        if c not in uniq:
            uniq.append(c)
    return sorted(uniq, key=_ip_rank)[0]


def is_loopback(addr):
    """判断是不是本机自己访问（回环地址）

    只有本机才当 P2P 房主：房间码对应的 Peer ID（pc-<码>）全局唯一，
    局域网里第二台设备也用同一个码上线就会撞号、把房间码顶掉。
    """
    if not addr:
        return False
    if addr in ('::1', 'localhost'):
        return True
    return addr.startswith('127.') or addr == '0.0.0.0'


def is_self_client(addr):
    """是不是房主这台电脑自己在访问（回环地址或本机的局域网地址）

    房主可能从 http://192.168.x.x:8000 打开自己的服务，这也算自己人：
    不能让他像客人一样再输一遍房间码。
    """
    if is_loopback(addr):
        return True
    return bool(addr) and addr in local_ips()


def is_admin():
    """检查当前是否有管理员权限"""
    try:
        import ctypes
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False


FIREWALL_RULE = "数据传输8000"
# 改名前的老规则名：启动时由提权进程顺手删掉，别让防火墙里留一条没人管的放行项
LEGACY_FIREWALL_RULES = ("局域网互传8000",)
_CREATE_NO_WINDOW = 0x08000000


def _netsh_encodings():
    """netsh 输出可能用到的编码，按可能性从高到低排

    netsh 走 Unicode 控制台接口写管道时给的是 UTF-8，跟系统代码页（936）无关；
    早先直接用 text=True 按 locale 编码解码，在中文系统上必然
    UnicodeDecodeError: 'gbk' codec can't decode byte 0x80，把启动日志刷满报错。
    """
    cands = ["utf-8"]
    try:
        import ctypes
        for cp in (ctypes.windll.kernel32.GetConsoleOutputCP(),
                   ctypes.windll.kernel32.GetOEMCP(),
                   ctypes.windll.kernel32.GetACP()):
            if cp:
                cands.append("cp%d" % cp)
    except Exception:
        pass
    cands += ["gbk", "latin-1"]
    seen, ordered = set(), []
    for enc in cands:
        key = enc.lower()
        if key not in seen:
            seen.add(key)
            ordered.append(enc)
    return ordered


def _decode_netsh(data):
    """先按 UTF-8 试，失败再按系统代码页，最后兜底替换，绝不抛异常"""
    if not data:
        return ""
    for enc in _netsh_encodings():
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


def run_netsh(args, timeout=10):
    """执行 netsh，返回 (返回码, 输出文本)

    用字节读出来自己解码，不用 text=True：解码失败只影响这行文本，
    不会在 subprocess 的读线程里抛异常。
    """
    import subprocess
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = _CREATE_NO_WINDOW
    try:
        r = subprocess.run(["netsh"] + args, capture_output=True,
                           timeout=timeout, **kwargs)
    except Exception:
        return 1, ""
    return r.returncode, _decode_netsh(r.stdout) + _decode_netsh(r.stderr)


def firewall_rule_exists(name=None):
    """检查防火墙规则是否已存在

    返回码 0 = 有这条规则，1 = 「没有与指定标准相匹配的规则」。
    用返回码判断而不是匹配中文文本，既不受编码影响也不受系统语言影响。
    name 不给就查当前规则名；传名字用于检查改名前留下的旧规则。
    """
    rule = name or FIREWALL_RULE
    code, text = run_netsh(
        ["advfirewall", "firewall", "show", "rule", "name=" + rule]
    )
    if code == 0:
        return True
    return rule in text


def add_firewall_rule():
    """添加防火墙规则（需要管理员权限）"""
    code, _ = run_netsh(
        ["advfirewall", "firewall", "add", "rule",
         "name=" + FIREWALL_RULE, "dir=in", "action=allow",
         "protocol=TCP", "localport=" + str(PORT)]
    )
    return code == 0


def delete_firewall_rule(name=None):
    """删除防火墙规则（需要管理员权限）

    name 不给就删当前规则；清理旧版规则时传旧名字。
    """
    code, _ = run_netsh(
        ["advfirewall", "firewall", "delete", "rule", "name=" + (name or FIREWALL_RULE)]
    )
    return code == 0


def purge_legacy_firewall_rules():
    """清掉改名前留下的放行规则

    规则名从「局域网互传8000」改成了「数据传输8000」，旧规则不会自己消失：
    留着会让防火墙里多一条没人回收的放行项，而看门狗只管当前规则。
    只在提权进程（看门狗）里调用，普通权限调了也删不动。
    """
    removed = []
    for name in LEGACY_FIREWALL_RULES:
        if name == FIREWALL_RULE:
            continue
        try:
            if firewall_rule_exists(name) and delete_firewall_rule(name):
                removed.append(name)
        except Exception:
            pass
    return removed


_cleanup_done = False


def wait_process_exit(pid):
    """阻塞到指定进程退出（给看门狗用）

    用进程句柄等，而不是轮询 pid 是否还在：句柄会一直锁着那个进程对象，
    就算 pid 被系统回收复用也不会误判成「还在跑」。
    """
    if not pid or os.name != 'nt':
        return False
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.WaitForSingleObject.restype = wintypes.DWORD
        k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        SYNCHRONIZE = 0x00100000
        INFINITE = 0xFFFFFFFF
        handle = k32.OpenProcess(SYNCHRONIZE, False, int(pid))
        if not handle:
            return False
        try:
            k32.WaitForSingleObject(handle, INFINITE)
            return True
        finally:
            k32.CloseHandle(handle)
    except Exception:
        return False


def run_watchdog(pid):
    """看门狗本体（跑在 --setup-firewall 的提权进程里）

    顺序：补齐规则 → 守着主进程 → 主进程一消失就删规则 + 清残留房间 → 自己退出。
    用任务管理器强杀、程序崩溃时主进程走不到任何退出钩子，就靠这一步收尾；
    断电/重启则两边一起没，规则只能等下次启动时被发现并接管。
    """
    purge_legacy_firewall_rules()   # 改名前的老规则，顺手回收
    if not firewall_rule_exists():
        add_firewall_rule()
    if not pid:
        return
    exited = wait_process_exit(pid)
    delete_firewall_rule()
    # 主进程确实退场了，才清这次运行留下的房间（聊天记录 + 接收文件）。
    # 不在软件启动时清：看门狗是独立提权进程，强杀 / 崩溃也照样能走到这一步。
    # 拿不到主进程句柄时别动磁盘——那时主进程可能还活着，房间正在用。
    if exited:
        try:
            purge_stale_rooms()
            _drop_room_files()
        except Exception:
            pass


def spawn_watchdog(need_elevation=True):
    """拉起看门狗：主进程退场后由它删除防火墙规则、清理残留房间

    删规则和加规则一样要管理员权限，所以非管理员启动时必须靠 UAC 提权；
    本身就是管理员时直接起子进程，令牌继承，不会再弹窗。
    """
    pid = os.getpid()
    frozen = getattr(sys, 'frozen', False)
    # onefile 打包时，子进程默认继承 _MEIPASS2 复用主进程的临时解压目录；
    # 主进程一退这个目录就被清掉，正在跑的看门狗会连 ctypes/_ctypes.pyd 都加载不到。
    # 置这个变量让看门狗当全新顶层进程、自己解压一份独立的。
    reset_env = {"PYINSTALLER_RESET_ENVIRONMENT": "1"}
    try:
        if need_elevation:
            import ctypes
            if frozen:
                exe, params = sys.executable, "--setup-firewall --watch %d" % pid
            else:
                exe = sys.executable
                params = '"%s" --setup-firewall --watch %d' % (
                    os.path.abspath(__file__), pid)
            # ShellExecuteW 用的是当前进程的环境块，临时塞进去再复原
            os.environ.update(reset_env)
            try:
                ret = ctypes.windll.shell32.ShellExecuteW(
                    None, "runas", exe, params, None, 0  # SW_HIDE
                )
            finally:
                os.environ.pop("PYINSTALLER_RESET_ENVIRONMENT", None)
            return ret > 32

        import subprocess
        args = [sys.executable] if frozen else [sys.executable, os.path.abspath(__file__)]
        args += ["--setup-firewall", "--watch", str(pid)]
        child_env = dict(os.environ)
        child_env.update(reset_env)
        subprocess.Popen(
            args, creationflags=_CREATE_NO_WINDOW, close_fds=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, env=child_env,
        )
        return True
    except Exception:
        return False


def cleanup():
    """退出清理

    防火墙规则和残留房间都不在这里删：由提权起的看门狗在主进程消失后统一回收，
    这样任务管理器强杀、程序崩溃也可能收干净（看门狗是独立进程，不受牵连）。
    """
    global _cleanup_done
    if _cleanup_done:
        return
    _cleanup_done = True


def _win_ctrl_handler(event):
    """Windows 控制台关闭事件捕获 - 必须同步执行完再返回"""
    # CTRL_C_EVENT=0, CTRL_BREAK_EVENT=1, CTRL_CLOSE_EVENT=2
    # CTRL_LOGOFF_EVENT=5, CTRL_SHUTDOWN_EVENT=6
    if event in (0, 2, 5, 6):
        # cleanup 目前是空操作（真正的收尾都在独立提权看门狗进程里），
        # 不做任何等待：关窗口立刻走人，别让系统再等我们半秒
        cleanup()
    return True


def setup_exit_hooks():
    """注册退出钩子"""
    import atexit
    import signal
    atexit.register(cleanup)
    try:
        signal.signal(signal.SIGINT, lambda *_: (cleanup(), exit(0)))
        signal.signal(signal.SIGTERM, lambda *_: (cleanup(), exit(0)))
    except Exception:
        pass
    # Windows 控制台窗口关闭
    try:
        import ctypes
        HANDLER = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_uint)
        ctypes.windll.kernel32.SetConsoleCtrlHandler(HANDLER(_win_ctrl_handler), True)
    except Exception:
        pass


_SINGLE_INSTANCE_MUTEX = None


def already_running():
    """同一登录会话里是否已经有实例在跑

    用命名互斥体判断，而不是探端口：Windows 下 ThreadingHTTPServer 带
    SO_REUSEADDR，第二个进程照样能绑上 8000，光看「端口是否被占用」拦不住，
    结果是两个实例同时服务、抢同一份房间目录。
    互斥体句柄一直留到进程结束（系统会自动释放），不要主动 CloseHandle。
    """
    global _SINGLE_INSTANCE_MUTEX
    if os.name != 'nt':
        return False
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.CreateMutexW.restype = wintypes.HANDLE
        k32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        handle = k32.CreateMutexW(None, False, 'Local\\DataTransmission8000SingleInstance')
        if not handle:
            return False
        ERROR_ALREADY_EXISTS = 183
        if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
            k32.CloseHandle(handle)   # 拿到的是已有互斥体的句柄，可以直接关掉
            return True
        _SINGLE_INSTANCE_MUTEX = handle
        return False
    except Exception:
        return False


_STEP_WIDTH = 28


def _step_begin(label):
    """步骤开始：先把「标签 + 点线」半句打出来并立即刷进控制台

    用户要的是一步一步出来：标签先亮着，结果等真做完再补在行尾，
    而不是等所有步骤都完成了一起蹦出来。
    """
    import unicodedata
    w = sum(2 if unicodedata.east_asian_width(c) in ('W', 'F') else 1
            for c in label)
    print(f"  {label} {'.' * max(2, _STEP_WIDTH - w)} ", end='', flush=True)


def _step_end(result):
    """步骤结束：把结果补在这一行行尾"""
    print(result, flush=True)


def firewall_phase():
    """步骤一：放行端口，返回是否通过

    规则只在不存在时创建（存在就复用，避免先删后加导致的那段连不上窗口）；
    删除需要管理员权限，所以回收规则这件事交给提权起来的看门狗，
    本进程只管启动服务。所有提示统一交给 main() 打印，这里不输出任何日志。
    """
    if is_admin():
        if not firewall_rule_exists():
            add_firewall_rule()
        return firewall_rule_exists()

    ok = spawn_watchdog(need_elevation=True)
    if not ok:
        return False
    # 提权子进程是异步的，轮询确认规则真的生效，而不是只看 UAC 请求是否发出
    for _ in range(40):
        time.sleep(0.25)
        if firewall_rule_exists():
            return True
    return False


def watchdog_phase():
    """步骤二：确认看门狗在岗，返回是否成功

    非管理员路径：看门狗在防火墙阶段已经提权拉起（补规则 + 程序退场时
    删规则清残留都靠它），这里确认规则已生效即视为在岗；管理员路径直接拉起。
    """
    if is_admin():
        return spawn_watchdog(need_elevation=False)
    return firewall_rule_exists()


def _safe_console():
    """控制台或管道编码表达不了的字符降级成 ?，避免打印 emoji 时直接崩掉

    双击运行时 stdout 走 Windows 控制台接口，emoji 正常；
    但重定向到文件、被其他程序当子进程调用时用的是本地编码（GBK），
    遇到 ✅ 📡 这类字符会抛 UnicodeEncodeError，把整个程序带崩。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except Exception:
            pass


def _notify_already_running():
    """第二个实例弹窗告知（双击运行的人未必盯着控制台看）"""
    print("")
    print("  ℹ️ 程序已经在运行了，不用再开一个")
    print("     回到之前的窗口继续操作即可，页面地址：")
    print(f"     http://127.0.0.1:{PORT}/")
    print("")
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(
            0, f"数据传输已经在运行了。\n\n页面地址：http://127.0.0.1:{PORT}/",
            "数据传输", 0x40)   # MB_ICONINFORMATION
        return
    except Exception:
        pass
    try:
        input("  按回车键退出...")
    except Exception:
        pass


def main():
    _safe_console()

    # 提权后的看门狗：补齐规则，守着主进程，主进程退场即删规则 + 清残留房间再自己退出
    if len(sys.argv) > 1 and sys.argv[1] == "--setup-firewall":
        watch_pid = 0
        if "--watch" in sys.argv:
            i = sys.argv.index("--watch")
            if i + 1 < len(sys.argv):
                try:
                    watch_pid = int(sys.argv[i + 1])
                except ValueError:
                    watch_pid = 0
        run_watchdog(watch_pid)
        return

    # 只导出静态页，不启动服务、不碰防火墙
    if len(sys.argv) > 1 and sys.argv[1] == "--export-page":
        paths = export_static_page(silent=False)
        if paths:
            for p in paths:
                print(f"  ✅ 已更新 {p}")
        else:
            print("  ✅ index.html 已是最新，无需更新")
        return

    # 启动时不再自动导出 index.html（2026-11-11 定稿）：
    # 发布页由 `python 数据传输.py --export-page` 手动导出，启动只负责跑服务。
    # 这样正在跑的旧 exe 重启时不会把 data-transmission/index.html 覆盖回它内嵌的旧页。

    # 已有实例在跑就不再开第二个：既免得两个进程抢 8000，也免得白弹一次 UAC
    if already_running():
        _notify_already_running()
        return

    # 整理旧布局 + 载入当前房间的记录（只在真正要跑服务时做）
    # 放在单实例判断之后：已经有实例在跑时，别去挪它正在用的文件
    print("")
    migrate_legacy_data()
    # 残留房间不在启动时清：由看门狗等程序退出后收尾（强杀也能清干净）
    load_messages()

    # 房间生命周期看门狗：房主页面关了、或 12 小时没通信，自动销毁房间
    threading.Thread(target=room_watchdog, daemon=True).start()

    # 注册退出清理钩子（关窗 / Ctrl+C / 强杀都走 cleanup）
    setup_exit_hooks()

    # 直接绑定监听，避免「先探测再绑定」之间的竞争窗口
    try:
        server = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    except OSError:
        print(f"\n  端口 {PORT} 已被占用，请先关闭其他占用该端口的程序后重试。")
        input("  按回车键退出...")
        return
    server.daemon_threads = True

    # 服务先在后台线程开转：UAC 等待期间端口已绑定、局域网设备此刻就能连上
    def _serve():
        try:
            server.serve_forever()
        except Exception:
            pass
    threading.Thread(target=_serve, daemon=True).start()

    # 日志一步一步出：前置步骤（防火墙/看门狗）的结果必须打在「服务启动成功」
    # 前面（顺序反了像逻辑颠倒——前置失败服务等于白起），且每一步都是
    # 「先亮标签 → 做完补结果」：双击后立刻能看到第一步在跑，而不是干等一片空白。
    print("")
    _step_begin('申请管理员权限放行防火墙')
    fw_ok = firewall_phase()
    _step_end('通过' if fw_ok else '失败')

    _step_begin('启动看门狗')
    dog_ok = watchdog_phase()
    _step_end('成功' if dog_ok else '失败')

    time.sleep(0.3)
    print("  服务启动成功", flush=True)
    time.sleep(0.3)
    print("")
    print(f"  外网访问链接：{CLIENT_URL or '未配置（在程序目录新建 client_url.txt 写入在线页网址）'}", flush=True)
    time.sleep(0.3)
    print("  按 Ctrl+C 或关闭窗口停止服务", flush=True)
    print("", flush=True)
    # 服务已在后台线程开转，主线程只负责等退出信号（Ctrl+C / 关窗口）
    try:
        while True:
            time.sleep(3600)
    except (KeyboardInterrupt, SystemExit):
        pass
    # 秒退：唯一要做的收尾都在独立提权看门狗进程里（删规则 + 清残留房间），
    # 直接退出跳过解释器收尾（atexit / 线程清理），关窗口立刻结束进程
    try:
        sys.stdout.flush()
    except Exception:
        pass
    os._exit(0)


if __name__ == '__main__':
    main()
