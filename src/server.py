"""Jiang's Java IDE - local backend (stdlib only)."""
from __future__ import annotations

import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid as uuidlib
import webbrowser
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlsplit, urljoin

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CONFIG_PATH = ROOT / "config.json"

MC_DIR = Path(os.environ.get("APPDATA", "")) / ".minecraft"
if not MC_DIR.exists():
    MC_DIR = Path.home() / "AppData" / "Roaming" / ".minecraft"

STATE = {
    "task": None,
    "done": 0,
    "total": 0,
    "message": "",
    "running": False,
    "error": None,
    "log": [],
    "last_seen": time.time(),
    "autotest": "",
    "diagnosis": None,
    "launch": None,
}
PROGRESS_LOCK = threading.Lock()
LOG_LOCK = threading.Lock()
MANIFEST_CACHE = ROOT / "cache" / "version_manifest_v2.json"
HTTP_TIMEOUT = 30


# --------------------------------------------------------------------------- utils
def cfg() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text("utf-8"))
        except Exception:
            pass
    return {}


def save_cfg(data: dict) -> None:
    base = cfg()
    base.update(data)
    CONFIG_PATH.write_text(json.dumps(base, ensure_ascii=False, indent=2), "utf-8")


def mc_dir() -> Path:
    return Path(cfg().get("minecraft_dir") or MC_DIR)


def log_line(text: str) -> None:
    with LOG_LOCK:
        STATE["log"].append(f"[{time.strftime('%H:%M:%S')}] {text}")
        if len(STATE["log"]) > 400:
            STATE["log"] = STATE["log"][-400:]


def set_progress(task=None, done=None, total=None, message=None, running=None, error=None):
    with PROGRESS_LOCK:
        if task is not None:
            STATE["task"] = task
        if done is not None:
            STATE["done"] = done
        if total is not None:
            STATE["total"] = total
        if message is not None:
            STATE["message"] = message
        if running is not None:
            STATE["running"] = running
        if error is not None:
            STATE["error"] = error


def http_json(url: str, timeout: int = HTTP_TIMEOUT) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "JiangJavaIDE/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_json_any(urls: list, timeout: int = 12):
    """依次尝试多个镜像地址，返回第一个成功的结果。"""
    last = None
    for url in urls:
        try:
            return http_json(url, timeout=timeout)
        except Exception as exc:
            last = exc
            continue
    raise last if last else RuntimeError("no url")


def http_bytes_any(urls: list, timeout: int = 12) -> bytes:
    last = None
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "JiangJavaIDE/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as exc:
            last = exc
            continue
    raise last if last else RuntimeError("no url")


def http_bytes(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "JiangJavaIDE/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()



def parallel_download(items: list, label: str, workers: int = 16) -> list:
    """items = [(url 或 url 列表, 目标 Path)]，多线程下，单个失败不影响其它。"""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    todo = []
    for urls, dest in items:
        if dest.exists() and dest.stat().st_size > 0:
            continue
        if isinstance(urls, str):
            urls = [urls]
        todo.append((urls, dest))
    total = len(todo)
    if not total:
        return []
    errors = []
    done = 0
    lock = threading.Lock()

    def one(pair):
        urls, dest = pair
        try:
            download(urls[0], dest, dest.name, fallbacks=urls[1:])
            return None
        except Exception as exc:
            return (dest.name, str(exc)[:120])

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(one, it) for it in todo]
        for fut in as_completed(futures):
            res = fut.result()
            with lock:
                done += 1
                if res:
                    errors.append(res)
                if done % 10 == 0 or done == total:
                    set_progress(done=done, total=total, message=f"{label} {done}/{total}")
    return errors


def download(url: str, dest: Path, label: str = "", size_hint: int = 0, fallbacks: list | None = None) -> None:
    urls = [url] + list(fallbacks or [])
    last = None
    for candidate in urls:
        try:
            _download_one(candidate, dest, label, size_hint)
            return
        except Exception as exc:
            last = exc
            log_line(f"下载失败({candidate[:60]}): {exc}")
    raise last if last else RuntimeError("download failed")


def _download_one(url: str, dest: Path, label: str = "", size_hint: int = 0) -> None:
    last = None
    for attempt in range(3):
        try:
            _download_once(url, dest, label, size_hint)
            return
        except Exception as exc:
            last = exc
            time.sleep(0.6 * (attempt + 1))
    raise last


_TLS = threading.local()


def _conn(parts, timeout):
    store = getattr(_TLS, "conns", None)
    if store is None:
        store = {}
        _TLS.conns = store
    key = (parts.scheme, parts.netloc)
    conn = store.get(key)
    if conn is None:
        cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
        conn = cls(parts.netloc, timeout=timeout)
        store[key] = conn
    return conn


def _drop(parts):
    store = getattr(_TLS, "conns", {})
    conn = store.pop((parts.scheme, parts.netloc), None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass


def _download_once(url: str, dest: Path, label: str = "", size_hint: int = 0) -> None:
    """复用长连接下载（每个线程一条 keep-alive 连接），比每次重新握手快一个数量级。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for hop in range(5):
        parts = urlsplit(url)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        try:
            conn = _conn(parts, timeout=12)
            conn.request("GET", path, headers={
                "User-Agent": "Mozilla/5.0 City-IDE",
                "Accept": "*/*",
                "Connection": "keep-alive",
            })
            resp = conn.getresponse()
            if resp.status in (301, 302, 303, 307, 308):
                location = resp.getheader("Location") or ""
                resp.read()
                if not location:
                    raise RuntimeError("重定向没有 Location")
                url = urljoin(url, location)
                continue
            if resp.status != 200:
                resp.read()
                raise RuntimeError(f"HTTP {resp.status}")
            total = int(resp.getheader("Content-Length") or size_hint or 0)
            got = 0
            with open(tmp, "wb") as fh:
                while True:
                    chunk = resp.read(262144)
                    if not chunk:
                        break
                    fh.write(chunk)
                    got += len(chunk)
                    if total > 0:
                        set_progress(done=got, total=total, message=label or dest.name)
            tmp.replace(dest)
            return
        except Exception:
            _drop(parts)
            raise
    raise RuntimeError("重定向次数过多")


def parallel_download(items: list, label: str, workers: int = 16) -> list:
    """items = [(url 或 url 列表, 目标 Path)]，多线程下，单个失败不影响其它。"""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    todo = []
    for urls, dest in items:
        if dest.exists() and dest.stat().st_size > 0:
            continue
        if isinstance(urls, str):
            urls = [urls]
        todo.append((urls, dest))
    total = len(todo)
    if not total:
        return []
    errors = []
    done = 0
    lock = threading.Lock()

    def one(pair):
        urls, dest = pair
        try:
            download(urls[0], dest, dest.name, fallbacks=urls[1:])
            return None
        except Exception as exc:
            return (dest.name, str(exc)[:120])

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(one, it) for it in todo]
        for fut in as_completed(futures):
            res = fut.result()
            with lock:
                done += 1
                if res:
                    errors.append(res)
                if done % 10 == 0 or done == total:
                    set_progress(done=done, total=total, message=f"{label} {done}/{total}")
    return errors


def download(url: str, dest: Path, label: str = "", size_hint: int = 0, fallbacks: list | None = None) -> None:
    urls = [url] + list(fallbacks or [])
    last = None
    for candidate in urls:
        try:
            _download_one(candidate, dest, label, size_hint)
            return
        except Exception as exc:
            last = exc
            log_line(f"下载失败({candidate[:60]}): {exc}")
    raise last if last else RuntimeError("download failed")


def _download_one(url: str, dest: Path, label: str = "", size_hint: int = 0) -> None:
    last = None
    for attempt in range(3):
        try:
            _download_once(url, dest, label, size_hint)
            return
        except Exception as exc:
            last = exc
            time.sleep(0.6 * (attempt + 1))
    raise last


def _download_once(url: str, dest: Path, label: str = "", size_hint: int = 0) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "JiangJavaIDE/1.0"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        total = int(resp.headers.get("Content-Length") or size_hint or 0)
        got = 0
        with open(tmp, "wb") as fh:
            while True:
                chunk = resp.read(262144)
                if not chunk:
                    break
                fh.write(chunk)
                got += len(chunk)
                set_progress(done=got, total=total, message=label or dest.name)
    tmp.replace(dest)


# --------------------------------------------------------------------------- versions

BMCL = "https://bmclapi2.bangbang93.com"


def mirror_first() -> bool:
    return bool(cfg().get("mirror_first", True))


def ordered(primary: str, mirror: str) -> list:
    """返回 [首选, 备选]；开了国内镜像优先就把镜像放前面。"""
    return [mirror, primary] if mirror_first() else [primary, mirror]


def version_manifest(force: bool = False) -> dict:
    if not force and MANIFEST_CACHE.exists() and (time.time() - MANIFEST_CACHE.stat().st_mtime) < 3600:
        try:
            return json.loads(MANIFEST_CACHE.read_text("utf-8"))
        except Exception:
            pass
    data = http_json_any(ordered("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
                                 BMCL + "/mc/game/version_manifest_v2.json"), timeout=20)
    MANIFEST_CACHE.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_CACHE.write_text(json.dumps(data), "utf-8")
    return data


def installed_info(vid: str) -> dict:
    vdir = mc_dir() / "versions" / vid
    jar = vdir / f"{vid}.jar"
    return {
        "json": (vdir / f"{vid}.json").exists(),
        "jar": jar.exists(),
        "jar_size": jar.stat().st_size if jar.exists() else 0,
        "mods_count": len(list((mc_dir() / "mods").glob("*.jar"))) if (mc_dir() / "mods").exists() else 0,
    }


def list_versions(force: bool = False) -> dict:
    m = version_manifest(force)
    out = []
    for v in m["versions"]:
        vid = v["id"]
        info = installed_info(vid)
        out.append({
            "id": vid,
            "type": v["type"],
            "release": v["releaseTime"][:10],
            "installed": info["json"] and info["jar"],
            "json_only": info["json"] and not info["jar"],
            "jar_size": info["jar_size"],
        })
    return {"latest": m.get("latest", {}), "versions": out}


def download_version(vid: str, with_assets: bool = False) -> None:
    try:
        set_progress(task=f"下载 {vid}", done=0, total=0, message="获取版本信息", running=True, error=None)
        m = version_manifest()
        entry = next((v for v in m["versions"] if v["id"] == vid), None)
        if not entry:
            raise RuntimeError(f"版本不存在: {vid}")
        vjson = None
        for url in ordered(entry["url"], f"{BMCL}/version/{vid}/json"):
            try:
                vjson = http_json(url, timeout=25)
                break
            except Exception as exc:
                log_line(f"版本信息下载失败 {url[:60]}: {exc}")
        if vjson is None:
            raise RuntimeError("版本信息下载失败，官方和镜像都没连上")
        vdir = mc_dir() / "versions" / vid
        vdir.mkdir(parents=True, exist_ok=True)
        (vdir / f"{vid}.json").write_text(json.dumps(vjson, indent=2), "utf-8")
        log_line(f"已写入 {vid}.json")

        # client jar
        jar_path = vdir / f"{vid}.jar"
        if not jar_path.exists():
            dl = vjson.get("downloads", {}).get("client")
            if dl:
                urls = ordered(dl["url"], f"{BMCL}/version/{vid}/client")
                download(urls[0], jar_path, f"{vid}.jar", fallbacks=urls[1:])
                log_line(f"客户端已下载 {jar_path.stat().st_size // 1048576} MB")
            else:
                raise RuntimeError("该版本没有客户端下载地址")

        # libraries
        libs = vjson.get("libraries", [])
        need = []
        for lib in libs:
            art = lib.get("downloads", {}).get("artifact")
            name = lib.get("name", "")
            if art:
                need.append((art["url"], mc_dir() / "libraries" / art["path"], name))
        items = []
        for url, path, name in need:
            rel = url.split("/maven2/", 1)[-1] if "/maven2/" in url else url.split("/", 3)[-1]
            items.append((ordered(url, f"{BMCL}/maven/{rel}"), path))
        lib_errors = parallel_download(items, "依赖库", workers=8)
        log_line(f"依赖库完成 {len(need)} 个，失败 {len(lib_errors)} 个")
        for name, err in lib_errors[:10]:
            log_line(f"  ! {name}: {err}")

        # natives
        ndir = vdir / "natives"
        ndir.mkdir(exist_ok=True)
        native_jars = []
        for lib in libs:
            name = lib.get("name", "")
            art = lib.get("downloads", {}).get("artifact")
            if art and "natives-windows" in name and "arm64" not in name:
                native_jars.append(mc_dir() / "libraries" / art["path"])
            # 老格式（1.16 及以前）用 classifiers
            natives = lib.get("downloads", {}).get("classifiers")
            if natives:
                cls = natives.get("natives-windows") or natives.get("natives-windows-64")
                if cls:
                    native_jars.append(mc_dir() / "libraries" / cls["path"])
        extracted = 0
        for npath in native_jars:
            if not npath.exists():
                continue
            try:
                with zipfile.ZipFile(npath) as z:
                    for item in z.namelist():
                        if item.endswith("/") or item.startswith("META-INF"):
                            continue
                        target = ndir / Path(item).name
                        if not target.exists():
                            with z.open(item) as src, open(target, "wb") as dst:
                                shutil.copyfileobj(src, dst)
                                extracted += 1
            except Exception as exc:
                log_line(f"解压本地库失败 {npath.name}: {exc}")
        log_line(f"natives 已解压 {extracted} 个文件（{len(native_jars)} 个本地库）")

        # assets
        if with_assets:
            ai = vjson.get("assetIndex")
            if ai:
                idx_path = mc_dir() / "assets" / "indexes" / f"{ai['id']}.json"
                if not idx_path.exists():
                    download(ai["url"], idx_path, f"assets/{ai['id']}.json")
                index = json.loads(idx_path.read_text("utf-8"))
                objects = index.get("objects", {})
                total = len(objects)
                set_progress(done=0, total=total, message="资源文件")
                items = []
                for key, obj in objects.items():
                    h = obj["hash"]
                    # 资源文件走官方 CDN：BMCLAPI 每小时有请求数上限，几千个文件会被限速
                    items.append(([f"https://resources.download.minecraft.net/{h[:2]}/{h}",
                                   f"{BMCL}/assets/{h[:2]}/{h}"],
                                  mc_dir() / "assets" / "objects" / h[:2] / h))
                asset_errors = parallel_download(items, "资源", workers=24)
                log_line(f"资源完成 {total} 个，失败 {len(asset_errors)} 个")

        set_progress(running=False, message="完成", done=1, total=1)
        log_line(f"{vid} 下载完成")
    except Exception as exc:
        log_line(f"下载失败: {exc}")
        set_progress(running=False, error=str(exc), message="失败")


# --------------------------------------------------------------------------- loaders
FABRIC_META = [
    "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/{mc}",
    "https://meta.fabricmc.net/v2/versions/loader/{mc}",
]
FORGE_META = [
    "https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/maven-metadata.xml",
    "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
]


def fabric_loaders(mc: str) -> list:
    try:
        data = http_json_any([u.format(mc=mc) for u in FABRIC_META], timeout=15)
    except Exception:
        return []
    out = []
    for item in data[:20]:
        loader = item.get("loader", {})
        out.append({
            "version": loader.get("version"),
            "stable": loader.get("stable", False),
        })
    return out


def forge_versions(mc: str) -> list:
    try:
        xml = http_bytes_any(FORGE_META, timeout=20).decode("utf-8", "ignore")
    except Exception:
        return []
    versions = re.findall(r"<version>([^<]+)</version>", xml)
    picked = [v for v in versions if v.startswith(mc + "-")]
    def key(v):
        tail = v[len(mc) + 1:]
        parts = re.split(r"[.\-]", tail)
        return [int(p) if p.isdigit() else 0 for p in parts]
    picked.sort(key=key, reverse=True)
    return picked[:30]


def install_fabric(mc: str, loader: str) -> dict:
    set_progress(task=f"安装 Fabric {loader}", running=True, message="获取配置", error=None, done=0, total=1)
    prof = http_json(f"https://meta.fabricmc.net/v2/versions/loader/{mc}/{loader}/profile/json", timeout=25)
    vid = prof["id"]
    vdir = mc_dir() / "versions" / vid
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / f"{vid}.json").write_text(json.dumps(prof, indent=2), "utf-8")

    libs = prof.get("libraries", [])
    for i, lib in enumerate(libs, 1):
        name = lib.get("name", "")
        parts = name.split(":")
        if len(parts) < 3:
            continue
        group, artifact, version = parts[0], parts[1], parts[2]
        classifier = parts[3] if len(parts) > 3 else ""
        rel = Path(*group.split(".")) / artifact / version / f"{artifact}-{version}{'-' + classifier if classifier else ''}.jar"
        url = lib.get("url", "https://maven.fabricmc.net/")
        if not url.endswith("/"):
            url += "/"
        target = mc_dir() / "libraries" / rel
        if not target.exists():
            try:
                download(url + rel.as_posix(), target, name)
            except Exception as exc:
                log_line(f"Fabric 依赖失败 {name}: {exc}")
        set_progress(done=i, total=len(libs), message=f"Fabric 依赖 {i}/{len(libs)}")
    log_line(f"Fabric {loader} 安装完成 -> {vid}")
    set_progress(running=False, message="完成", done=1, total=1)
    return {"ok": True, "versionId": vid}


def install_forge(mc: str, full: str) -> dict:
    set_progress(task=f"下载 Forge {full}", running=True, message="下载安装器", error=None, done=0, total=1)
    vdir = mc_dir() / "versions" / f"forge-{full}"
    vdir.mkdir(parents=True, exist_ok=True)
    jar = vdir / f"forge-{full}-installer.jar"
    url = f"https://maven.minecraftforge.net/net/minecraftforge/forge/{full}/forge-{full}-installer.jar"
    download(url, jar, "forge-installer.jar")
    log_line(f"Forge 安装器已下载: {jar}")
    set_progress(running=False, message="安装器已就绪", done=1, total=1)
    return {"ok": True, "installer": str(jar)}


def run_forge_installer(full: str) -> dict:
    jar = mc_dir() / "versions" / f"forge-{full}" / f"forge-{full}-installer.jar"
    if not jar.exists():
        return {"ok": False, "error": "安装器不存在，请先下载"}
    java = pick_java(21)
    if not java:
        return {"ok": False, "error": "找不到可用的 Java"}
    proc = subprocess.Popen(
        [java, "-jar", str(jar), "--installClient", str(mc_dir())],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="ignore",
        cwd=str(ROOT),
    )
    def pump():
        for line in proc.stdout:
            log_line("[forge] " + line.rstrip())
        log_line(f"[forge] 安装器退出码 {proc.wait()}")
    threading.Thread(target=pump, daemon=True).start()
    return {"ok": True}


# --------------------------------------------------------------------------- java
def java_build(path: str) -> dict | None:
    exe = Path(path)
    if not exe.exists():
        return None
    try:
        out = subprocess.run([str(exe), "-version"], capture_output=True, text=True, timeout=15,
                             encoding="utf-8", errors="ignore")
        text = (out.stderr or "") + (out.stdout or "")
        m = re.search(r'version "([^"]+)"', text)
        ver = m.group(1) if m else "?"
        major = re.match(r"1\.(\d+)", ver) or re.match(r"(\d+)", ver)
        return {"path": str(exe), "version": ver, "major": int(major.group(1)) if major else 0}
    except Exception:
        return None


def find_javas() -> list:
    found = []
    candidates = []
    for base in [Path("C:/Program Files/Java"), Path("C:/Program Files/Eclipse Adoptium"),
                 Path("C:/Program Files/Microsoft"), Path("C:/Program Files/BellSoft"),
                 Path("C:/Program Files/Zulu"), Path(os.environ.get("JAVA_HOME", "") or ".")]:
        if base.exists():
            candidates.append(base)
    rt = mc_dir() / "runtime"
    if rt.exists():
        candidates.append(rt)
    libs = ROOT / "runtimes"
    if libs.exists():
        candidates.append(libs)
    home = Path(os.environ.get("USERPROFILE", "")) / ".jdks"
    if home.exists():
        candidates.append(home)

    for base in candidates:
        try:
            kids = [base] + [p for p in base.iterdir() if p.is_dir()]
        except Exception:
            continue
        for kid in kids:
            for rel in ("bin/java.exe", "bin/javaw.exe", "java.exe"):
                exe = kid / rel
                if exe.exists():
                    info = java_build(str(exe))
                    if info and all(x["path"] != info["path"] for x in found):
                        found.append(info)
                    break
    found.sort(key=lambda x: x["major"], reverse=True)
    return found


def pick_java(major: int) -> str | None:
    javas = find_javas()
    exact = [j for j in javas if j["major"] == major]
    if exact:
        return exact[0]["path"]
    higher = [j for j in javas if j["major"] >= major]
    if higher:
        return sorted(higher, key=lambda x: x["major"])[0]["path"]
    return javas[0]["path"] if javas else None


def java_remote() -> list:
    try:
        data = http_json("https://api.adoptium.net/v3/info/available_releases", timeout=20)
        majors = data.get("available_releases", [])[-8:]
    except Exception:
        majors = [8, 11, 17, 21, 25]
    out = []
    for m in reversed(majors):
        out.append({"major": m})
    return out


def java_download(major: int) -> None:
    try:
        set_progress(task=f"下载 JDK {major}", running=True, message="查询下载地址", error=None, done=0, total=1)
        url = (f"https://api.adoptium.net/v3/binary/latest/{major}/ga/windows/x64/jdk/hotspot/normal/eclipse")
        dest_dir = ROOT / "runtimes"
        dest_dir.mkdir(parents=True, exist_ok=True)
        zip_path = dest_dir / f"jdk{major}.zip"
        download(url, zip_path, f"JDK {major}")
        import zipfile as zf
        with zf.ZipFile(zip_path) as z:
            names = z.namelist()
            top = {n.split("/")[0] for n in names if "/" in n}
            z.extractall(dest_dir)
            zip_path.unlink()
            for t in top:
                src = dest_dir / t
                if src.is_dir() and (src / "bin" / "java.exe").exists():
                    log_line(f"JDK {major} 已解压到 {src}")
        set_progress(running=False, message="完成", done=1, total=1)
    except Exception as exc:
        set_progress(running=False, error=str(exc), message="失败")
        log_line(f"JDK 下载失败: {exc}")


# --------------------------------------------------------------------------- mods
def parse_mods_toml(text: str) -> dict:
    mod_id = re.search(r'modId\s*=\s*"([^"]+)"', text)
    version = re.search(r'^\s*version\s*=\s*"([^"]+)"', text, re.M)
    name = re.search(r'displayName\s*=\s*"([^"]+)"', text)
    mc_dep = re.search(r'modId\s*=\s*"minecraft"\s*[\s\S]{0,200}?versionRange\s*=\s*"([^"]+)"', text)
    return {
        "modId": mod_id.group(1) if mod_id else "",
        "version": version.group(1) if version else "",
        "name": name.group(1) if name else "",
        "mcRange": mc_dep.group(1) if mc_dep else "",
    }


def jar_info(path: Path) -> dict:
    info = {"path": str(path), "name": path.name, "size": path.stat().st_size, "loader": "", "modId": "",
            "version": "", "displayName": "", "mcRange": "", "entries": 0, "broken": False, "error": ""}
    try:
        with zipfile.ZipFile(path) as z:
            bad = z.testzip()
            if bad:
                info["broken"] = True
                info["error"] = f"损坏条目: {bad}"
            names = z.namelist()
            info["entries"] = len(names)
            if "fabric.mod.json" in names:
                data = json.loads(z.read("fabric.mod.json").decode("utf-8", "ignore"))
                info["loader"] = "fabric"
                info["modId"] = data.get("id", "")
                info["version"] = data.get("version", "")
                info["displayName"] = data.get("name", "")
                dep = data.get("depends", {})
                if isinstance(dep, dict):
                    info["mcRange"] = str(dep.get("minecraft", ""))
            elif "META-INF/mods.toml" in names:
                text = z.read("META-INF/mods.toml").decode("utf-8", "ignore")
                info["loader"] = "forge"
                info.update(parse_mods_toml(text))
            elif "META-INF/neoforge.mods.toml" in names:
                text = z.read("META-INF/neoforge.mods.toml").decode("utf-8", "ignore")
                info["loader"] = "neoforge"
                info.update(parse_mods_toml(text))
    except Exception as exc:
        info["broken"] = True
        info["error"] = str(exc)
    return info


def delete_mod(name: str, vid: str = "") -> dict:
    mdir = mods_dir_for(vid)
    target = mdir / Path(name).name
    if not target.exists():
        return {"ok": False, "error": "文件不存在"}
    try:
        target.unlink()
        log_line(f"已删除 mod {target.name}")
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def save_mod(name: str, data: bytes, vid: str = "") -> dict:
    mdir = mods_dir_for(vid)
    mdir.mkdir(parents=True, exist_ok=True)
    target = mdir / Path(name).name
    try:
        target.write_bytes(data)
        log_line(f"已添加 mod {target.name}（{len(data) // 1024} KB）")
        return {"ok": True, "path": str(target)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def import_global_mods(vid: str) -> dict:
    """把全局 mods 里的 jar 复制到这个隔离版本自己的 mods 里。"""
    src = mc_dir() / "mods"
    dest = mods_dir_for(vid)
    dest.mkdir(parents=True, exist_ok=True)
    count = 0
    skipped = 0
    if src.exists():
        for f in src.glob("*.jar"):
            target = dest / f.name
            if target.exists():
                skipped += 1
                continue
            shutil.copy2(f, target)
            count += 1
    log_line(f"从全局导入 {count} 个 Mod 到 {vid}")
    return {"ok": True, "count": count, "skipped": skipped}


def list_mods() -> list:
    mdir = mc_dir() / "mods"
    if not mdir.exists():
        return []
    return [jar_info(p) for p in sorted(mdir.glob("*.jar"))]


def check_mods(loader: str = "") -> dict:
    mods = list_mods()
    findings = []
    ids = {}
    for m in mods:
        if m["broken"]:
            findings.append({"level": "error", "mod": m["name"], "text": f"jar 已损坏：{m['error']}"})
            continue
        if not m["modId"]:
            findings.append({"level": "warn", "mod": m["name"], "text": "没有找到 mods.toml / fabric.mod.json，可能不是模组本体（比如是前置库或资源包）"})
        key = (m["loader"], m["modId"])
        if m["modId"]:
            ids.setdefault(key, []).append(m["name"])
        if loader and m["loader"] and m["loader"] != loader:
            findings.append({"level": "error", "mod": m["name"], "text": f"加载器不匹配：这是 {m['loader']} 模组，当前是 {loader}"})
        if m["mcRange"]:
            findings.append({"level": "info", "mod": m["name"], "text": f"声明支持的游戏版本：{m['mcRange']}"})
    for (ld, mid), names in ids.items():
        if len(names) > 1:
            findings.append({"level": "error", "mod": names[0], "text": "重复的 modId：" + ", ".join(names)})
    if not mods:
        findings.append({"level": "info", "mod": "mods", "text": "mods 目录里还没有模组"})
    ok = not any(f["level"] == "error" for f in findings)
    return {"ok": ok, "count": len(mods), "findings": findings, "mods": mods}


# --------------------------------------------------------------------------- logs
ERROR_RULES = [
    (r"java\.lang\.OutOfMemoryError", "内存不足", "把 -Xmx 调大（设置里改内存，建议 4G 以上），并关闭其他吃内存的程序。"),
    (r"UnsupportedClassVersionError|class file version (\d+)", "Java 版本不匹配", "这个版本需要的 Java 比当前高/低。到「Java」页安装对应的 JDK，再在启动配置里选它。"),
    (r"Missing or unsupported mandatory dependencies|ModResolutionException", "模组缺少前置", "缺少必需的前置模组，或前置版本不对。看崩溃信息里 missing/unsupported 的那一行，补上前置。"),
    (r"Duplicate mods|duplicate modid|found duplicate", "模组重复", "mods 文件夹里有两个相同 modId 的 jar，删掉旧的那个。"),
    (r"java\.lang\.NoSuchMethodError|java\.lang\.NoClassDefFoundError", "版本对不上", "通常是模组和游戏版本/前置版本不匹配，或者混用了 Forge 与 Fabric 的模组。"),
    (r"Failed to locate library: lwjgl\.dll|UnsatisfiedLinkError.*lwjgl", "缺少 natives 本地库", "这个版本的 lwjgl.dll 等本地库没解压出来。点「重装 / 加加载器」重新补一下，或者再启动一次（启动器会自动补下载）。"),
    (r"java\.lang\.UnsatisfiedLinkError", "本地库加载失败", "natives 目录不全或架构不对（32 位 Java 跑 64 位游戏）。用 64 位 JDK，并让启动器重新解压 natives。"),
    (r"GLFW error|Failed to create window|Pixel format not accelerated", "显卡/驱动问题", "更新显卡驱动；笔记本双显卡的话，强制用独显启动游戏。"),
    (r"java\.io\.FileNotFoundException|AccessDeniedException", "文件权限/路径问题", "游戏目录被占用（另一个启动器开着？）或没有写权限，换个目录或关掉占用的程序。"),
    (r"Exception loading model|Unable to load model|Missing model", "模型/资源错误", "资源包或模组里的模型 json 写错了。检查 models/block 下的 json 和贴图路径大小写。"),
    (r"Could not find or load main class|ClassNotFoundException", "启动参数/依赖缺失", "启动配置里的主类或依赖路径有问题，重新下载该版本，或检查 libraries 是否完整。"),
    (r"Failed to download|Connection reset|UnknownHostException|SSLHandshake", "网络问题", "下载被中断或域名解析失败，挂代理/换网络后重试。"),
    (r"Ticking block entity|Ticking entity|Exception ticking", "运行中崩溃", "某个方块实体/实体在 tick 时抛异常，通常是模组 bug。看崩溃堆栈里第一个 mod 包名，定位是哪个模组。"),
]


def analyze_text(text: str) -> list:
    hits = []
    for pattern, title, advice in ERROR_RULES:
        m = re.search(pattern, text, re.I)
        if m:
            hits.append({"title": title, "match": m.group(0)[:120], "advice": advice})
    return hits


def latest_logs(vid: str = "", since: float = 0) -> list:
    files = []
    candidates = []
    if vid:
        candidates.append(mc_dir() / "versions" / vid / "logs" / "latest.log")
    candidates.append(mc_dir() / "logs" / "latest.log")
    for c in candidates:
        if c.exists():
            files.append(c)
            break
    cr = mc_dir() / "crash-reports"
    if cr.exists():
        for f in sorted(cr.glob("crash-*.txt"), key=lambda p: p.stat().st_mtime, reverse=True)[:5]:
            if since and f.stat().st_mtime < since - 5:
                continue  # 只认这次启动之后的崩溃报告
            files.append(f)
    out = []
    for f in files:
        try:
            text = f.read_text("utf-8", "ignore")
        except Exception:
            continue
        out.append({"file": f.name, "path": str(f), "size": f.stat().st_size, "text": text[-60000:]})
    return out


# --------------------------------------------------------------------------- launch
def merge_version(vid: str, seen=None) -> dict:
    seen = seen or set()
    if vid in seen:
        raise RuntimeError("版本继承出现循环: " + vid)
    seen.add(vid)
    path = mc_dir() / "versions" / vid / f"{vid}.json"
    if not path.exists():
        raise RuntimeError(f"缺少版本 json: {path}")
    data = json.loads(path.read_text("utf-8"))
    parent_id = data.get("inheritsFrom")
    if parent_id:
        parent = merge_version(parent_id, seen)
        merged = dict(parent)
        merged["id"] = data.get("id", vid)
        merged["mainClass"] = data.get("mainClass", parent.get("mainClass"))
        merged["libraries"] = parent.get("libraries", []) + data.get("libraries", [])
        merged["arguments"] = data.get("arguments", parent.get("arguments"))
        if "minecraftArguments" in data:
            merged["minecraftArguments"] = data["minecraftArguments"]
        merged["assetIndex"] = data.get("assetIndex", parent.get("assetIndex"))
        merged["assets"] = data.get("assets", parent.get("assets"))
        merged["downloads"] = parent.get("downloads", {})
        merged["javaVersion"] = data.get("javaVersion", parent.get("javaVersion"))
        return merged
    return data


def offline_uuid(name: str) -> str:
    return str(uuidlib.uuid3(uuidlib.NAMESPACE_DNS, "OfflinePlayer:" + name))



def native_jars_for(libs: list) -> list:
    """找出这个版本所有 Windows natives 库（新版是 name 里带 natives-windows，老版是 classifiers）。"""
    out = []
    for lib in libs:
        name = lib.get("name", "")
        art = lib.get("downloads", {}).get("artifact")
        if art and "natives-windows" in name and "arm64" not in name:
            out.append((art["url"], mc_dir() / "libraries" / art["path"]))
        cls = (lib.get("downloads", {}).get("classifiers") or {})
        pick = cls.get("natives-windows") or cls.get("natives-windows-64")
        if pick:
            out.append((pick["url"], mc_dir() / "libraries" / pick["path"]))
    return out


def ensure_natives(vid: str, data: dict) -> int:
    """启动前确保 natives 解压好了，缺的库顺手补下载。返回解压出来的文件数。"""
    vdir = mc_dir() / "versions" / vid
    ndir = vdir / "natives"
    ndir.mkdir(parents=True, exist_ok=True)
    jars = native_jars_for(data.get("libraries", []))
    if not jars:
        return 0

    missing = [(u, p) for u, p in jars if not p.exists()]
    if missing:
        items = []
        for url, path in missing:
            rel = url.split("/maven2/", 1)[-1] if "/maven2/" in url else url.split("/", 3)[-1]
            items.append((ordered(url, f"{BMCL}/maven/{rel}"), path))
        parallel_download(items, "本地库", workers=6)

    count = 0
    for _, npath in jars:
        if not npath.exists():
            continue
        try:
            with zipfile.ZipFile(npath) as z:
                for item in z.namelist():
                    if item.endswith("/") or item.startswith("META-INF"):
                        continue
                    target = ndir / Path(item).name
                    with z.open(item) as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst)
                        count += 1
        except Exception as exc:
            log_line(f"解压本地库失败 {npath.name}: {exc}")
    log_line(f"natives 就绪：{count} 个文件（{len(jars)} 个本地库）")
    return count



def read_text_auto(path: Path) -> str:
    """自动认编码：UTF-8(带/不带 BOM) → GBK → 最后兜底 utf-8 replace。"""
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")



def ensure_assets(vid: str, data: dict) -> int:
    """启动前补齐这个版本资源索引里缺的文件（语言包、声音、字体都在里面）。"""
    ai = data.get("assetIndex") or {}
    idx_id = ai.get("id")
    if not idx_id:
        return 0
    idx_path = mc_dir() / "assets" / "indexes" / f"{idx_id}.json"
    idx_path.parent.mkdir(parents=True, exist_ok=True)
    if not idx_path.exists():
        try:
            raw = http_bytes_any(ordered(f"https://piston-meta.mojang.com/v1/packages/{idx_id}.json",
                                         f"{BMCL}/assets/indexes/{idx_id}.json"), timeout=30)
            idx_path.write_bytes(raw)
        except Exception as exc:
            log_line(f"取资源索引失败：{exc}")
            return 0
    try:
        index = json.loads(idx_path.read_text("utf-8"))
    except Exception:
        return 0

    root = mc_dir() / "assets" / "objects"
    items = []
    for _, obj in (index.get("objects") or {}).items():
        h = obj["hash"]
        dest = root / h[:2] / h
        if not dest.exists():
            items.append(([f"https://resources.download.minecraft.net/{h[:2]}/{h}",
                           f"{BMCL}/assets/{h[:2]}/{h}"], dest))
    if items:
        set_progress(running=True, task="启动准备", done=0, total=len(items), message="检查资源完整性")
        try:
            errs = parallel_download(items, "资源", workers=24)
            log_line(f"补下资源 {len(items) - len(errs)} 个，失败 {len(errs)} 个")
        finally:
            # 补完一定要复位，否则灵动岛会一直挂着"补资源"
            set_progress(running=False, task="", done=0, total=0, message="")
    return len(items)


def ensure_chinese_lang(game_dir: Path) -> None:
    """启动前把游戏语言设成简体中文（options.txt 里没有就补，是英文就改）。"""
    opt = game_dir / "options.txt"
    try:
        lines = []
        if opt.exists():
            lines = read_text_auto(opt).splitlines()
        found = False
        for i, line in enumerate(lines):
            if line.startswith("lang:"):
                found = True
                if line.strip() != "lang:zh_cn":
                    lines[i] = "lang:zh_cn"
        if not found:
            lines.append("lang:zh_cn")
        opt.parent.mkdir(parents=True, exist_ok=True)
        opt.write_text("\n".join(lines) + "\n", "utf-8")
    except Exception as exc:
        log_line(f"设置中文语言失败：{exc}")


def launch(vid: str, username: str = "Steve", memory: int = 4096, jvm_extra: str = "") -> dict:
    java = pick_java((merge_version(vid).get("javaVersion", {}) or {}).get("majorVersion", 21))
    if not java:
        return {"ok": False, "error": "找不到 Java，请先在 Java 页安装一个"}
    data = merge_version(vid)
    vdir = mc_dir() / "versions" / vid
    jar = vdir / f"{vid}.jar"
    if not jar.exists():
        parent = data.get("inheritsFrom")
        jar = mc_dir() / "versions" / (parent or vid) / f"{parent or vid}.jar"

    classpath = []
    for lib in data.get("libraries", []):
        art = lib.get("downloads", {}).get("artifact")
        if not art:
            continue
        if "natives-" in lib.get("name", ""):
            continue  # 本地库只解压、不进 classpath
        p = mc_dir() / "libraries" / art["path"]
        if p.exists():
            classpath.append(str(p))
    classpath.append(str(jar))

    assets = mc_dir() / "assets"
    asset_index = (data.get("assetIndex") or {}).get("id", "legacy")
    natives = vdir / "natives"
    if not natives.exists() or not any(natives.glob("*.dll")):
        try:
            ensure_natives(vid, data)
        except Exception as exc:
            log_line(f"补 natives 失败：{exc}")
    if not natives.exists():
        natives = mc_dir() / "versions" / (data.get("inheritsFrom") or vid) / "natives"

    cp = ";".join(classpath)
    # 用 javaw.exe 启动，避免多弹一个黑色控制台窗口
    java_win = Path(java)
    javaw = java_win.with_name("javaw.exe")
    if javaw.exists():
        java_win = javaw

    cmd = [str(java_win), f"-Xmx{memory}M", f"-Xms{max(1024, memory // 4)}M",
           f"-Djava.library.path={natives}", "-Dfile.encoding=UTF-8"]
    if jvm_extra.strip():
        cmd.extend(jvm_extra.split())
    cmd += ["-cp", cp, data["mainClass"]]
    game_dir = version_dir(vid) if is_isolated(vid) else mc_dir()
    game_dir.mkdir(parents=True, exist_ok=True)
    ensure_chinese_lang(game_dir)
    try:
        ensure_assets(vid, data)
    except Exception as exc:
        log_line(f"补资源失败：{exc}")
    # 有正版账户就用正版身份启动（带皮肤、能进正版服务器）
    acc = cfg().get("account") or {}
    if acc.get("type") == "msa" and acc.get("token") and acc.get("uuid"):
        play_name = acc.get("name") or username
        play_uuid = acc["uuid"]
        play_token = acc["token"]
        user_type = "msa"
    else:
        play_name = username
        play_uuid = offline_uuid(username)
        play_token = "0"
        user_type = "legacy"

    cmd += ["--username", play_name, "--version", vid, "--gameDir", str(game_dir),
            "--assetsDir", str(assets), "--assetIndex", asset_index,
            "--uuid", play_uuid, "--accessToken", play_token, "--userType", user_type,
            "--versionType", "release"]
    log_line("启动命令: " + " ".join(cmd)[:800])
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        proc = subprocess.Popen(cmd, cwd=str(game_dir), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="ignore",
                                creationflags=flags)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    def pump():
        for line in proc.stdout:
            log_line(line.rstrip())
        log_line(f"游戏进程退出，代码 {proc.wait()}")
    threading.Thread(target=pump, daemon=True).start()

    # 15 秒后自动读日志做诊断（灵动岛右侧就是这份结果）
    STATE["launch"] = {"pid": proc.pid, "version": vid, "at": time.time()}
    STATE["diagnosis"] = None
    threading.Thread(target=watch_launch, args=(vid, proc), daemon=True).start()
    return {"ok": True, "pid": proc.pid}


# --------------------------------------------------------------------------- build
JAVAC_HINTS = [
    ("cannot find symbol", "找不到符号",
     "名字拼错了，或者忘了 import，或者依赖的 jar 没放进工程根目录的 libs/ 文件夹。看下面一行 symbol: 提示具体是哪个名字。"),
    ("package .* does not exist", "包不存在",
     "缺依赖：把对应的 jar 放进 libs/，或者检查 import 的包名对不对。"),
    ("is public, should be declared in a file named", "文件名和类名不一致",
     "public class Foo 必须放在 Foo.java 里，大小写也要完全一样。"),
    ("';' expected", "少了分号", "上一行结尾忘了写 ;"),
    ("reached end of file while parsing", "括号没闭合", "检查 { } 是不是成对，通常是方法或类少了一个 }。"),
    ("incompatible types", "类型不匹配", "把 A 类型的值赋给了 B 类型的变量，看提示里的 required / found。"),
    ("method does not override", "@Override 对不上",
     "父类里没有这个方法，或者参数列表写错了。没有把握时先删掉 @Override。"),
    ("unreported exception", "没处理异常",
     "这个方法会抛异常，用 try { } catch { } 包起来，或者在方法签名上 throws。"),
    ("class file has wrong version", "JDK 版本不对",
     "依赖是用更高版本 JDK 编译的，换一个更高的 JDK 再编译。"),
    ("non-static method .* cannot be referenced", "静态/实例混用",
     "在没有对象的情况下调用了实例方法；要么加 static，要么先 new 一个对象。"),
    ("duplicate class", "类重复", "同一个类被定义了两次，检查是不是复制粘贴留了副本。"),
]


def tool_path(java_path: str, tool: str) -> Path | None:
    exe = Path(java_path)
    candidate = exe.with_name(tool + ".exe")
    if candidate.exists():
        return candidate
    return None


def collect_sources(pd: Path) -> list:
    dirs = [pd / "src" / "main" / "java", pd / "src"]
    found = {}
    for d in dirs:
        if d.exists():
            for p in d.rglob("*.java"):
                found[str(p).lower()] = p
    return sorted(found.values())


def parse_javac(text: str) -> list:
    diags = []
    pattern = re.compile(r"^(?P<file>[A-Za-z]:[^:]+|\S+\.java):(?P<line>\d+):\s*(?P<kind>error|warning|错误|警告):\s*(?P<msg>.*)$")
    lines = text.splitlines()
    for i, raw in enumerate(lines):
        m = pattern.match(raw.strip())
        if not m:
            continue
        msg = m.group("msg").strip()
        extra = ""
        for follow in lines[i + 1:i + 4]:
            follow = follow.strip()
            if follow.startswith("symbol:") or follow.startswith("location:") or follow.startswith("required:") or follow.startswith("found:") or follow.startswith("符号:") or follow.startswith("位置:"):
                extra += (" " if extra else "") + follow
            else:
                break
        hint = ""
        haystack = (msg + " " + extra).lower()
        for needle, title, advice in JAVAC_HINTS:
            if re.search(needle.lower(), haystack):
                hint = f"{title} —— {advice}"
                break
        diags.append({
            "file": m.group("file"),
            "line": int(m.group("line")),
            "kind": "error" if m.group("kind") in ("error", "错误") else "warning",
            "message": msg,
            "detail": extra,
            "hint": hint,
        })
    return diags


def compile_project(pd: Path, java_path: str, release: int | None = None) -> dict:
    sources = collect_sources(pd)
    if not sources:
        return {"ok": False, "error": "没有找到 .java 文件，应该在 src/main/java 下面", "diagnostics": []}
    javac = tool_path(java_path, "javac")
    if not javac:
        return {"ok": False, "error": "这个 JDK 只有 java 没有 javac，换一个完整 JDK（不是 JRE）", "diagnostics": []}
    out_dir = pd / "build" / "classes"
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    libs = sorted((pd / "libs").glob("*.jar")) if (pd / "libs").exists() else []
    cp = ";".join(str(x) for x in libs)
    cmd = [str(javac), "-encoding", "UTF-8", "-d", str(out_dir), "-Xlint:-options",
           "-J-Duser.language=en", "-J-Duser.country=US"]
    if release:
        cmd += ["--release", str(release)]
    if cp:
        cmd += ["-cp", cp]
    # javac 的 @argfile 会把反斜杠吃掉，所以直接把源文件作为参数传；太长再退回 argfile
    direct = cmd + [str(s) for s in sources]
    if sum(len(x) + 1 for x in direct) < 28000:
        cmd = direct
    else:
        argfile = pd / "build" / "sources.txt"
        argfile.parent.mkdir(parents=True, exist_ok=True)
        argfile.write_text("\n".join(str(s).replace("\\", "/") for s in sources), "utf-8")
        cmd.append("@" + str(argfile))
    log_line("编译: " + " ".join(cmd[:8]) + f" ... ({len(sources)} 个源文件)")
    started = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore",
                              timeout=180, cwd=str(pd))
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "编译超时（180 秒）", "diagnostics": []}
    output = (proc.stdout or "") + (proc.stderr or "")
    diags = parse_javac(output)
    classes = list(out_dir.rglob("*.class"))
    elapsed = int((time.time() - started) * 1000)
    ok = proc.returncode == 0
    err = ""
    if not ok and not diags:
        err = (output or "javac 返回了非零退出码，但没有输出").strip()[-1500:]
    for d in diags:
        log_line(f"{'错误' if d['kind'] == 'error' else '警告'} {Path(d['file']).name}:{d['line']} {d['message']}")
    log_line(f"编译{'成功' if ok else '失败'}：{len(classes)} 个 class，{elapsed} ms")
    return {
        "ok": ok,
        "diagnostics": diags,
        "classCount": len(classes),
        "ms": elapsed,
        "sources": len(sources),
        "error": err,
        "output": output[-4000:] if not ok else "",
        "classesDir": str(out_dir),
    }


def package_project(pd: Path, name: str, main_class: str = "") -> dict:
    classes = pd / "build" / "classes"
    if not classes.exists() or not list(classes.rglob("*.class")):
        return {"ok": False, "error": "还没有编译产物，先点「编译」"}
    libs_dir = pd / "build" / "libs"
    libs_dir.mkdir(parents=True, exist_ok=True)
    jar_path = libs_dir / (name or (pd.name + ".jar"))
    if not jar_path.name.endswith(".jar"):
        jar_path = jar_path.with_suffix(".jar")
    manifest = "Manifest-Version: 1.0\r\n"
    if main_class:
        manifest += f"Main-Class: {main_class}\r\n"
    manifest += "\r\n"
    count = 0
    with zipfile.ZipFile(jar_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("META-INF/MANIFEST.MF", manifest)
        for f in classes.rglob("*"):
            if f.is_file():
                z.write(f, f.relative_to(classes).as_posix())
                count += 1
        res = pd / "src" / "main" / "resources"
        if res.exists():
            for f in res.rglob("*"):
                if f.is_file():
                    z.write(f, f.relative_to(res).as_posix())
                    count += 1
    size = jar_path.stat().st_size
    log_line(f"已打包 {jar_path.name}（{count} 个文件，{size // 1024} KB）")
    return {"ok": True, "path": str(jar_path), "size": size, "files": count}


def run_project(pd: Path, java_path: str, main_class: str, args: str = "") -> dict:
    classes = pd / "build" / "classes"
    if not classes.exists():
        return {"ok": False, "error": "先编译再运行"}
    if not main_class:
        return {"ok": False, "error": "没指定主类（例如 com.example.Main）"}
    libs = sorted((pd / "libs").glob("*.jar")) if (pd / "libs").exists() else []
    cp = ";".join([str(classes)] + [str(x) for x in libs])
    res = pd / "src" / "main" / "resources"
    if res.exists():
        cp += ";" + str(res)
    cmd = [java_path, "-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-cp", cp, main_class] + (args.split() if args else [])
    log_line("运行: " + main_class)
    try:
        proc = subprocess.Popen(cmd, cwd=str(pd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    def pump():
        for raw in iter(proc.stdout.readline, b""):
            try:
                line = raw.decode("utf-8")
            except UnicodeDecodeError:
                line = raw.decode("gbk", "replace")
            log_line("  " + line.rstrip())
        log_line(f"程序结束，退出码 {proc.wait()}")
    threading.Thread(target=pump, daemon=True).start()
    STATE["launch"] = {"pid": proc.pid, "version": vid, "at": time.time()}
    STATE["diagnosis"] = None
    threading.Thread(target=watch_launch, args=(vid, proc), daemon=True).start()
    return {"ok": True, "pid": proc.pid}


def project_tree(pd: Path) -> list:
    if not pd.exists():
        return []
    skip = {"build", ".gradle", ".idea", "out", "run"}
    items = []

    def walk(d: Path, depth: int):
        if depth > 8:
            return
        try:
            entries = sorted(d.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except Exception:
            return
        for p in entries:
            if p.name in skip or p.name.startswith("."):
                continue
            rel = p.relative_to(pd).as_posix()
            if p.is_dir():
                items.append({"path": rel, "name": p.name, "dir": True, "depth": depth})
                walk(p, depth + 1)
            else:
                items.append({"path": rel, "name": p.name, "dir": False, "depth": depth,
                              "size": p.stat().st_size})

    walk(pd, 0)
    return items


def safe_project_path(pd: Path, rel: str) -> Path | None:
    target = (pd / rel).resolve()
    try:
        target.relative_to(pd.resolve())
    except Exception:
        return None
    return target


HELLO_MAIN = """package com.example;

/**
 * 第一个 Java 程序。
 *
 * 运行方式：点「构建」页的「编译」→「运行」，或者打包成 jar 双击。
 *
 * 这三行是 Java 的骨架：
 *   package   —— 这个类在哪个包里（对应文件夹路径）
 *   public class Main —— 定义一个叫 Main 的类，public 表示别的包也能用
 *   public static void main(String[] args) —— 程序入口，JVM 从这里开始执行
 */
public class Main {

    // 程序入口。签名必须一字不差：public static void main(String[] args)
    public static void main(String[] args) {
        // System.out.println 往控制台打一行字；println 自带换行
        System.out.println("Hello, Jiang Java IDE!");

        // 变量：类型 名字 = 值;
        int blocks = 4;
        String modName = "jiangjie";
        double version = 1.0;

        // 字符串拼接用 +
        System.out.println("模组 " + modName + " v" + version + " 一共 " + blocks + " 个方块");

        // 方法调用：先定义，再调用（见下面的 printCard）
        for (int i = 1; i <= blocks; i++) {
            printCard(i, "方块" + i);
        }

        // 数组 + 循环
        String[] names = {"讲解石", "路牌底杆", "路牌衔接杆", "路牌"};
        for (String n : names) {
            System.out.println("  - " + n);
        }
    }

    /**
     * 自定义方法：static 表示不用 new 对象就能调用。
     * 参数：(int index, String name)，返回值 void 表示不返回东西。
     */
    private static void printCard(int index, String name) {
        if (index % 2 == 0) {
            System.out.println("偶数号：" + name);
        } else {
            System.out.println("奇数号：" + name);
        }
    }
}
"""

MOD_BLOCK = """package com.example;

import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockBehaviour;

/**
 * 一个最小的方块类。
 *
 * 注意：这个文件需要 Minecraft / Forge 的 jar 才能编译。
 * 把对应的 jar 放进工程根目录的 libs/ 文件夹，再点「编译」。
 */
public class ExampleBlock extends Block {

    public ExampleBlock() {
        super(BlockBehaviour.Properties.of());
    }
}
"""

MODS_TOML = """modLoader="javafml"
loaderVersion="[66,)"
license="All Rights Reserved"

[[mods]]
modId="examplemod"
version="1.0.0"
displayName="Example Mod"
description='''用 Java IDE 创建的模组'''

[[dependencies.examplemod]]
    modId="forge"
    mandatory=true
    versionRange="[66,)"
    ordering="NONE"
    side="BOTH"
"""


def new_project(pd: Path, name: str, template: str = "hello") -> dict:
    modid = re.sub(r"[^a-z0-9_]", "", (name or "mymod").lower()) or "mymod"
    (pd / "src" / "main" / "java" / "com" / "example").mkdir(parents=True, exist_ok=True)
    (pd / "src" / "main" / "resources").mkdir(parents=True, exist_ok=True)
    (pd / "libs").mkdir(parents=True, exist_ok=True)
    main = pd / "src" / "main" / "java" / "com" / "example" / "Main.java"
    if not main.exists():
        main.write_text(HELLO_MAIN, "utf-8")
    if template == "mod":
        (pd / "src" / "main" / "java" / "com" / "example" / "ExampleBlock.java").write_text(MOD_BLOCK, "utf-8")
        meta = pd / "src" / "main" / "resources" / "META-INF"
        meta.mkdir(parents=True, exist_ok=True)
        (meta / "mods.toml").write_text(MODS_TOML.replace("examplemod", modid), "utf-8")
    readme = pd / "README.md"
    if not readme.exists():
        readme.write_text(f"# {modid}\n\n用 Jiang Java IDE 创建的工程。\n\n- 源码：src/main/java\n"
                          "- 资源：src/main/resources\n- 依赖 jar：libs/\n", "utf-8")
    save_cfg({"project_dir": str(pd)})
    log_line(f"工程已创建：{pd}")
    return {"ok": True, "projectDir": str(pd)}


# --------------------------------------------------------------------------- tutorial
TUTORIAL_STEPS = [
    {
        "key": "jdk",
        "title": "装一个 JDK",
        "hint": "到「Java」页下载 JDK 25（或 21）。没有 JDK 就没有 javac，什么都编译不了。",
        "purpose": "JDK = JRE + 编译器。IDE 里的「编译」按钮其实就是调用 JDK 里的 javac。",
        "actions": [
            "左侧点「Java」→「在线安装」→ 选 JDK 25 点「下载」",
            "等进度条走完，回到「Java」页点「重新扫描」，能看到 Java 25",
            "这一步不需要敲任何代码",
        ],
        "code": "",
        "file": "",
    },
    {
        "key": "project",
        "title": "建一个工程",
        "hint": "点「新建工程」，选 Java 入门模板，会生成可以直接编译运行的工程结构。",
        "purpose": "Java 工程有固定目录约定：源码放 src/main/java，资源放 src/main/resources。",
        "actions": [
            "点右上角「新建工程」，输入 mymod",
            "模板选「Java 入门（可直接编译运行）」",
            "生成后到「代码」页能看到 Main.java",
        ],
        "code": "",
        "file": "",
    },
    {
        "key": "code",
        "title": "写第一个类",
        "hint": "在「代码」页打开 Main.java，照着下面的注释看懂每一行，然后保存。",
        "purpose": "Java 程序的最小结构：package → class → main 方法。先把这三层记住，剩下的都是往里加东西。",
        "actions": [
            "点下面的「写入示例代码」，Main.java 会被自动填好",
            "到「代码」页打开它，改一改字符串，点「保存」",
            "看懂 public static void main(String[] args) 这一行：程序从这里开始跑",
        ],
        "code": HELLO_MAIN,
        "file": "src/main/java/com/example/Main.java",
    },
    {
        "key": "compile",
        "title": "编译",
        "hint": "到「构建」页点「编译」。报错会列出来，每条都带中文解释。",
        "purpose": "编译 = 把 .java 翻译成 JVM 能执行的 .class。com 文件夹结构会变成包名。",
        "actions": [
            "「构建」页 → 编译器选 Java 25 → 点「编译」",
            "看到 0 个错误、N 个 class 就成功了",
            "如果报错，点诊断条目看中文提示，改完再编译",
        ],
        "code": "",
        "file": "",
    },
    {
        "key": "jar",
        "title": "打包成 jar",
        "hint": "点「打包 jar」，产物在 build/libs 下，双击或者命令行 java -jar 就能跑。",
        "purpose": "jar 就是 zip：class 文件 + resources + MANIFEST.MF（里面写主类）。",
        "actions": [
            "「构建」页 → 主类填 com.example.Main → 点「打包 jar」",
            "产物路径会显示出来，点「打开所在文件夹」即可看到",
            "做模组时，这个 jar 就是丢进 mods 的那个文件",
        ],
        "code": "",
        "file": "",
    },
    {
        "key": "mods",
        "title": "放进 mods",
        "hint": "把 jar 复制到 .minecraft/mods，再到「模组」页检查是否能被识别。",
        "purpose": "游戏只认 jar 里的 META-INF/mods.toml（Forge）或 fabric.mod.json（Fabric）。",
        "actions": [
            "复制 build/libs 里的 jar 到 .minecraft/mods",
            "「模组」页点「检查模组」，能看到你的 modId 就说明格式对了",
        ],
        "code": "",
        "file": "",
    },
    {
        "key": "run",
        "title": "启动游戏",
        "hint": "到「版本」页点「启动」，控制台会显示日志。",
        "purpose": "验证模组是否真的被加载：启动后看日志里的 modId 或直接进游戏找方块。",
        "actions": [
            "「版本」页选一个已安装版本点「启动」",
            "「工具」页看控制台输出",
            "进游戏确认方块/物品出现",
        ],
        "code": "",
        "file": "",
    },
]


def project_dir() -> Path:
    return Path(cfg().get("project_dir") or (ROOT / "workspace" / "MyMod"))


def detect_step(key: str) -> bool:
    pd = project_dir()
    if key == "jdk":
        return any(j["major"] >= 17 for j in find_javas())
    if key == "project":
        return (pd / "src" / "main" / "java").exists()
    if key == "code":
        if not pd.exists():
            return False
        for p in pd.rglob("*.java"):
            try:
                if len(p.read_text("utf-8", "ignore")) > 400:
                    return True
            except Exception:
                pass
        return False
    if key == "compile":
        return (pd / "build" / "classes").exists() and any((pd / "build" / "classes").rglob("*.class"))
    if key == "jar":
        return (pd / "build" / "libs").exists() and any((pd / "build" / "libs").glob("*.jar"))
    if key == "mods":
        return len(list((mc_dir() / "mods").glob("*.jar"))) > 0
    if key == "run":
        return bool(cfg().get("ever_launched"))
    return False


def tutorial_state() -> dict:
    t = cfg().get("tutorial", {"step": 0, "active": True, "done": False})
    step = min(t.get("step", 0), len(TUTORIAL_STEPS) - 1)
    cur = TUTORIAL_STEPS[step]
    detected = detect_step(cur["key"])
    steps = []
    for i, s in enumerate(TUTORIAL_STEPS):
        # 已经走过的步骤打勾；当前这一步要靠检测；后面的都是未完成（这样"从头开始"才看得出效果）
        done = i < step or (i == step and detect_step(s["key"]))
        steps.append({"key": s["key"], "title": s["title"], "hint": s.get("hint", ""), "done": done})
    return {
        "active": t.get("active", True),
        "step": step,
        "total": len(TUTORIAL_STEPS),
        "title": cur["title"],
        "hint": cur["hint"],
        "purpose": cur.get("purpose", ""),
        "actions": cur.get("actions", []),
        "code": cur.get("code", ""),
        "file": cur.get("file", ""),
        "detected": detected,
        "finished": t.get("done", False),
        "steps": steps,
    }





# --------------------------------------------------------------------------- launch diagnosis
def watch_launch(vid: str, proc) -> None:
    """启动后等一会，读日志判断有没有崩，并把结论存起来给前端轮询。"""
    time.sleep(15)
    launched_at = (STATE.get("launch") or {}).get("at", 0) or 0
    text = ""
    for lg in latest_logs(vid, launched_at):
        text += lg["text"] + "\n"
    hits = analyze_text(text)
    crashed = ("Minecraft Crash Report" in text
               or "A fatal error has been detected" in text
               or "Exception in thread" in text)
    if proc.poll() is None and "Crash report saved" not in text[-4000:]:
        crashed = False  # 进程还活着，旧崩溃不算这次的
    exited = proc.poll()
    if exited not in (None, 0):
        crashed = True
        hits.append({"title": "游戏异常退出",
                     "match": f"进程退出码 {exited}",
                     "advice": "进程是异常退出的，先看下面日志最后 20 行；如果没有任何堆栈，多半是内存不够或显卡驱动。"})
    if "ModResolutionException" in text or "Missing or unsupported mandatory dependencies" in text:
        hits.insert(0, {"title": "模组依赖没满足",
                        "match": "ModResolutionException",
                        "advice": "缺前置或版本对不上。到「Mod → 已安装」点「检查模组」，把缺的那个补上。"})
    STATE["diagnosis"] = {
        "when": time.time(),
        "version": vid,
        "crashed": crashed,
        "exited": exited,
        "hits": hits,
        "tail": text[-5000:],
    }
    log_line(f"[诊断] {vid} 启动检查完成：{'崩溃' if crashed else '正常'}，命中 {len(hits)} 条")


# --------------------------------------------------------------------------- neoforge / quilt
NEOFORGE_META = [
    "https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml",
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
]

MODRINTH = "https://api.modrinth.com/v2"


def neoforge_versions(mc: str) -> list:
    try:
        xml = http_bytes_any(NEOFORGE_META, timeout=20).decode("utf-8", "ignore")
    except Exception:
        return []
    versions = re.findall(r"<version>([^<]+)</version>", xml)
    picked = [v for v in versions if v.startswith(mc + ".")]
    def key(v):
        return [int(x) if x.isdigit() else 0 for x in re.split(r"[.\-]", v)]
    picked.sort(key=key, reverse=True)
    return picked[:30]


def install_neoforge(mc: str, version: str) -> dict:
    set_progress(task=f"下载 NeoForge {version}", running=True, message="下载安装器", error=None, done=0, total=1)
    vdir = mc_dir() / "versions" / f"neoforge-{version}"
    vdir.mkdir(parents=True, exist_ok=True)
    jar = vdir / f"neoforge-{version}-installer.jar"
    url = f"https://maven.neoforged.net/releases/net/neoforged/neoforge/{version}/neoforge-{version}-installer.jar"
    download(url, jar, "neoforge-installer.jar",
             fallbacks=[f"https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/{version}/neoforge-{version}-installer.jar"])
    log_line(f"NeoForge 安装器已下载: {jar}")
    set_progress(running=False, message="安装器已就绪", done=1, total=1)
    return {"ok": True, "installer": str(jar), "version": f"neoforge-{version}"}


def run_neoforge_installer(version: str) -> dict:
    jar = mc_dir() / "versions" / f"neoforge-{version}" / f"neoforge-{version}-installer.jar"
    if not jar.exists():
        return {"ok": False, "error": "安装器不存在，请先下载"}
    java = pick_java(21)
    if not java:
        return {"ok": False, "error": "找不到可用的 Java"}
    proc = subprocess.Popen([java, "-jar", str(jar), "--installClient", str(mc_dir())],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="ignore", cwd=str(ROOT))
    def pump():
        for line in proc.stdout:
            log_line("[neoforge] " + line.rstrip())
        log_line(f"[neoforge] 安装器退出码 {proc.wait()}")
    threading.Thread(target=pump, daemon=True).start()
    return {"ok": True}


# --------------------------------------------------------------------------- modrinth
def modrinth_search(q: str, ptype: str, mc: str = "", loader: str = "", limit: int = 20, offset: int = 0,
                    sort: str = "") -> dict:
    facets = [[f"project_type:{ptype}"]]
    if mc:
        facets.append([f"versions:{mc}"])
    if loader:
        facets.append([f"categories:{loader}"])
    from urllib.parse import quote
    index = sort or ("relevance" if q else "downloads")
    limit = max(1, min(int(limit or 20), 100))
    offset = max(0, int(offset or 0))
    url = (f"{MODRINTH}/search?limit={limit}&offset={offset}&index={index}&query={quote(q or '')}"
           f"&facets={quote(json.dumps(facets))}")
    try:
        data = http_json(url, timeout=20)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "hits": []}
    hits = []
    for h in data.get("hits", []):
        hits.append({
            "id": h.get("project_id"),
            "slug": h.get("slug"),
            "title": h.get("title"),
            "description": h.get("description"),
            "downloads": h.get("downloads"),
            "author": h.get("author"),
            "icon": h.get("icon_url"),
            "categories": h.get("categories", [])[:4],
            "versions": h.get("versions", [])[-6:],
        })
    return {"ok": True, "hits": hits, "total": data.get("total_hits", len(hits))}


def modrinth_project(pid: str) -> dict:
    try:
        data = http_json(f"{MODRINTH}/project/{pid}", timeout=25)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    gallery = []
    for g in data.get("gallery", []):
        url = g.get("url", "")
        if url:
            gallery.append({"url": url, "title": g.get("title", ""), "featured": g.get("featured", False)})
    return {
        "ok": True,
        "project": {
            "id": data.get("id"),
            "slug": data.get("slug"),
            "title": data.get("title"),
            "description": data.get("description"),
            "body": (data.get("body") or "")[:4000],
            "icon": data.get("icon_url"),
            "downloads": data.get("downloads"),
            "followers": data.get("followers"),
            "categories": data.get("categories", []),
            "loaders": data.get("loaders", []),
            "gameVersions": data.get("game_versions", [])[-12:],
            "source": data.get("source_url"),
            "issues": data.get("issues_url"),
        },
        "gallery": gallery,
    }


def modrinth_pick_version(pid: str, mc: str, loader: str) -> dict | None:
    try:
        versions = http_json(f"{MODRINTH}/project/{pid}/version", timeout=25)
    except Exception:
        return None
    for v in versions:
        gv = v.get("game_versions", [])
        ld = [x.lower() for x in v.get("loaders", [])]
        if mc and mc not in gv:
            continue
        if loader and loader.lower() not in ld:
            continue
        files = v.get("files", [])
        primary = next((f for f in files if f.get("primary")), files[0] if files else None)
        if not primary:
            continue
        return {"version": v.get("version_number"), "file": primary, "game_versions": gv, "loaders": ld}
    return None


def install_modrinth(pid: str, ptype: str, mc: str = "", loader: str = "", slug: str = "", world: str = "") -> dict:
    if ptype == "modpack":
        return install_modpack(pid, mc, slug)
    picked = modrinth_pick_version(pid, mc, loader)
    if not picked:
        return {"ok": False, "error": f"没有找到适配 {mc or '任意版本'} / {loader or '任意加载器'} 的文件"}
    name = picked["file"]["filename"]
    url = picked["file"]["url"]
    if ptype == "datapack":
        base = (mc_dir() / "saves" / world / "datapacks") if world else (mc_dir() / "datapacks")
        folder = "datapacks" + (f"（{world}）" if world else "")
        dest = base / name
    else:
        folder = {"mod": "mods", "resourcepack": "resourcepacks", "shader": "shaderpacks"}.get(ptype, "mods")
        dest = mc_dir() / folder / name
    set_progress(task=f"下载 {name}", running=True, error=None, done=0, total=1, message=name)
    download(url, dest, name)
    set_progress(running=False, message="完成", done=1, total=1)
    log_line(f"已安装 {folder}/{name}")
    return {"ok": True, "path": str(dest), "version": picked["version"], "folder": folder}


def install_modpack(pid: str, mc: str = "", slug: str = "") -> dict:
    """下载 .mrpack 并解包成 versions/<slug>/ 的独立实例。"""
    picked = modrinth_pick_version(pid, mc, "")
    if not picked:
        return {"ok": False, "error": "没有找到可用的整合包文件"}
    name = picked["file"]["filename"]
    url = picked["file"]["url"]
    tmp = ROOT / "cache" / "packs" / name
    set_progress(task=f"下载整合包 {name}", running=True, error=None, done=0, total=1, message=name)
    download(url, tmp, name)
    pack_id = (slug or name.replace(".mrpack", "")).strip() or f"pack-{int(time.time())}"
    pack_id = re.sub(r"[^A-Za-z0-9._-]", "-", pack_id)
    inst = mc_dir() / "versions" / pack_id
    inst.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(tmp) as z:
            index = json.loads(z.read("modrinth.index.json").decode("utf-8"))
            for f in index.get("files", []):
                rel = f.get("path", "")
                if not rel or rel.startswith("/") or ".." in rel:
                    continue
                target = inst / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                urls = f.get("downloads", [])
                if urls and not target.exists():
                    download(urls[0], target, Path(rel).name)
            for entry in z.namelist():
                if entry.startswith("overrides/"):
                    rel = entry[len("overrides/"):]
                    if not rel or rel.endswith("/"):
                        continue
                    target = inst / rel
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(entry) as s, open(target, "wb") as d:
                        shutil.copyfileobj(s, d)
    except Exception as exc:
        set_progress(running=False, error=str(exc), message="解包失败")
        return {"ok": False, "error": f"整合包解析失败：{exc}"}

    deps = {}
    try:
        deps = index.get("dependencies", {})
    except Exception:
        pass
    game = deps.get("minecraft", mc or "")
    (inst / "instance.marker").write_text(json.dumps({"pack": pack_id, "game": game, "deps": deps}, ensure_ascii=False), "utf-8")

    written = ""
    if deps.get("fabric-loader"):
        try:
            prof = http_json(f"https://meta.fabricmc.net/v2/versions/loader/{game}/{deps['fabric-loader']}/profile/json", timeout=25)
            prof["id"] = pack_id
            (inst / f"{pack_id}.json").write_text(json.dumps(prof, indent=2), "utf-8")
            written = f"fabric-loader {deps['fabric-loader']}"
        except Exception as exc:
            log_line(f"生成 Fabric 配置失败: {exc}")
    if not written:
        (inst / f"{pack_id}.json").write_text(json.dumps({
            "id": pack_id, "inheritsFrom": game, "type": "release",
            "mainClass": "net.minecraft.client.main.Main",
        }, indent=2), "utf-8")
    set_progress(running=False, message="完成", done=1, total=1)
    log_line(f"整合包已安装到 {inst}")
    return {"ok": True, "instance": str(inst), "versionId": pack_id, "game": game,
            "loader": written, "deps": deps}



# --------------------------------------------------------------------------- quilt / optifine / worlds
QUILT_META = [
    "https://meta.quiltmc.org/v3/versions/loader/{mc}",
    "https://bmclapi2.bangbang93.com/quilt-meta/v3/versions/loader/{mc}",
]


def quilt_loaders(mc: str) -> list:
    try:
        data = http_json_any([u.format(mc=mc) for u in QUILT_META], timeout=15)
    except Exception:
        return []
    out = []
    for item in data[:20]:
        loader = item.get("loader", {})
        ver = loader.get("version", "")
        out.append({"version": ver, "stable": "beta" not in ver})
    return out


def install_quilt(mc: str, loader: str) -> dict:
    set_progress(task=f"安装 Quilt {loader}", running=True, message="获取配置", error=None, done=0, total=1)
    prof = None
    for base in ("https://meta.quiltmc.org/v3", "https://bmclapi2.bangbang93.com/quilt-meta/v3"):
        try:
            prof = http_json(f"{base}/versions/loader/{mc}/{loader}/profile/json", timeout=25)
            break
        except Exception:
            continue
    if not prof:
        set_progress(running=False, error="拿不到 Quilt 配置")
        return {"ok": False, "error": "拿不到 Quilt 配置"}
    vid = prof.get("id") or f"quilt-loader-{loader}-{mc}"
    prof["id"] = vid
    vdir = mc_dir() / "versions" / vid
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / f"{vid}.json").write_text(json.dumps(prof, indent=2), "utf-8")
    libs = prof.get("libraries", [])
    for i, lib in enumerate(libs, 1):
        name = lib.get("name", "")
        parts = name.split(":")
        if len(parts) < 3:
            continue
        group, artifact, version = parts[0], parts[1], parts[2]
        rel = Path(*group.split(".")) / artifact / version / f"{artifact}-{version}.jar"
        url = lib.get("url") or "https://maven.quiltmc.org/repository/release/"
        if not url.endswith("/"):
            url += "/"
        target = mc_dir() / "libraries" / rel
        if not target.exists():
            try:
                download(url + rel.as_posix(), target, name)
            except Exception as exc:
                log_line(f"Quilt 依赖失败 {name}: {exc}")
        set_progress(done=i, total=len(libs), message=f"Quilt 依赖 {i}/{len(libs)}")
    set_progress(running=False, message="完成", done=1, total=1)
    log_line(f"Quilt {loader} 安装完成 -> {vid}")
    return {"ok": True, "versionId": vid}


def optifine_versions(mc: str) -> list:
    try:
        data = http_json(f"https://bmclapi2.bangbang93.com/optifine/{mc}", timeout=20)
    except Exception:
        return []
    out = []
    for item in data if isinstance(data, list) else []:
        out.append({
            "type": item.get("type", ""),
            "patch": item.get("patch", ""),
            "filename": item.get("filename", ""),
            "label": f"{item.get('type', '')}_{item.get('patch', '')}".strip("_"),
        })
    return out


def install_optifine(mc: str, filename: str) -> dict:
    set_progress(task=f"下载 OptiFine {filename}", running=True, message="下载中", error=None, done=0, total=1)
    vdir = mc_dir() / "versions" / f"optifine-{mc}"
    vdir.mkdir(parents=True, exist_ok=True)
    jar = vdir / filename
    download(f"https://bmclapi2.bangbang93.com/optifine/{mc}/{filename}", jar, filename)
    set_progress(running=False, message="安装器已就绪", done=1, total=1)
    log_line(f"OptiFine 已下载：{jar}")
    return {"ok": True, "installer": str(jar)}


def run_optifine_installer(mc: str, filename: str) -> dict:
    jar = mc_dir() / "versions" / f"optifine-{mc}" / filename
    if not jar.exists():
        return {"ok": False, "error": "安装器不存在，请先下载"}
    java = pick_java(8)
    if not java:
        return {"ok": False, "error": "找不到 Java"}
    proc = subprocess.Popen([java, "-jar", str(jar)], cwd=str(mc_dir()),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="ignore")
    def pump():
        for line in proc.stdout:
            log_line("[optifine] " + line.rstrip())
        log_line(f"[optifine] 安装器退出码 {proc.wait()}")
    threading.Thread(target=pump, daemon=True).start()
    return {"ok": True}


def list_worlds() -> list:
    saves = mc_dir() / "saves"
    if not saves.exists():
        return []
    out = []
    for d in sorted(saves.iterdir()):
        if d.is_dir() and (d / "level.dat").exists():
            out.append(d.name)
    return out





# --------------------------------------------------------------------------- update
APP_VERSION = "1.0.1"
DEFAULT_UPDATE_REPO = "citybiome/city-minecraft-ide"


def parse_version(v: str):
    parts = re.findall(r"\d+", str(v or ""))
    nums = [int(x) for x in parts[:3]]
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums)


def check_update(repo: str = "", current: str = "") -> dict:
    """问 GitHub 要最新 release，和本地版本比一下。"""
    repo = (repo or cfg().get("update_repo") or DEFAULT_UPDATE_REPO).strip().strip("/")
    current = current or cfg().get("app_version") or APP_VERSION
    if not repo:
        return {"ok": False, "error": "还没有配置更新源（在设置里填 用户名/仓库）", "current": current}
    try:
        data = http_json_any([f"https://api.github.com/repos/{repo}/releases/latest"], timeout=15)
    except Exception as exc:
        msg = str(exc)
        if "404" in msg:
            return {"ok": False, "repo": repo, "current": current,
                    "error": "这个仓库还没有发布 release（草稿不算，去 Releases 页点 Publish）"}
        if "403" in msg:
            return {"ok": False, "repo": repo, "current": current,
                    "error": "GitHub 接口被限流了，过一会再试"}
        return {"ok": False, "repo": repo, "current": current,
                "error": "连不上 GitHub：" + msg[:80]}

    tag = data.get("tag_name") or data.get("name") or ""
    latest = re.sub(r"^[vV]", "", tag)
    if not latest:
        return {"ok": False, "error": "这个仓库没有发布 release", "current": current}

    assets = []
    for a in data.get("assets") or []:
        assets.append({"name": a.get("name"), "url": a.get("browser_download_url"),
                       "size": a.get("size", 0)})
    pick = None
    for a in assets:
        n = (a["name"] or "").lower()
        if n.endswith(".exe") and ("setup" in n or "install" in n):
            pick = a
            break
    if pick is None:
        for a in assets:
            if (a["name"] or "").lower().endswith(".exe"):
                pick = a
                break

    return {
        "ok": True,
        "current": current,
        "latest": latest,
        "tag": tag,
        "hasUpdate": parse_version(latest) > parse_version(current),
        "name": data.get("name") or tag,
        "notes": (data.get("body") or "")[:4000],
        "page": data.get("html_url"),
        "published": data.get("published_at"),
        "asset": pick,
        "assets": assets[:10],
        "repo": repo,
    }


def download_update(url: str, name: str) -> dict:
    if not url:
        return {"ok": False, "error": "没有下载地址"}
    name = Path(name or "CityIDE-Update.exe").name
    dest_dir = Path(os.environ.get("TEMP", str(ROOT))) / "CityIDE-Update"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / name
    try:
        set_progress(running=True, task="下载新版本", done=0, total=0, message=name)
        urls = ordered(url, url.replace("https://github.com", "https://gh-proxy.com/https://github.com"))
        download(urls[0], dest, name, fallbacks=urls[1:])
        set_progress(running=False, task="", done=0, total=0, message="")
        log_line(f"新版本已下载：{dest}")
        try:
            os.startfile(str(dest))
        except Exception:
            pass
        return {"ok": True, "path": str(dest)}
    except Exception as exc:
        set_progress(running=False, task="", done=0, total=0, message="")
        return {"ok": False, "error": str(exc)[:200]}


# --------------------------------------------------------------------------- accounts
MS_CLIENT_ID_DEFAULT = "00000000402b5328"


def account_state() -> dict:
    acc = cfg().get("account") or {"type": "offline", "name": cfg().get("username") or "Steve"}
    skin = mc_dir() / "custom_skins" / (str(acc.get("name") or "Steve") + ".png")
    return {
        "type": acc.get("type", "offline"),
        "name": acc.get("name") or "Steve",
        "uuid": acc.get("uuid") or "",
        "skin": skin.exists(),
        "skinUrl": "/api/account/skin" if skin.exists() else "",
        "clientId": cfg().get("msa_client_id") or "",
    }


THEME_BG = lambda: ROOT / "theme-bg.img"


def get_theme() -> dict:
    return cfg().get("theme") or {}


def save_theme(data: dict) -> dict:
    save_cfg({"theme": data or {}})
    return {"ok": True, "theme": get_theme()}


def save_skin(data: bytes) -> dict:
    if len(data) < 100:
        return {"ok": False, "error": "文件太小，不像是 png"}
    if not data.startswith(b"\x89PNG"):
        return {"ok": False, "error": "只支持 png 皮肤"}
    acc = cfg().get("account") or {}
    name = str(acc.get("name") or cfg().get("username") or "Steve")
    d = mc_dir() / "custom_skins"
    d.mkdir(parents=True, exist_ok=True)
    (d / (name + ".png")).write_bytes(data)
    log_line(f"已保存皮肤 {name}.png（{len(data) // 1024} KB）")
    return {"ok": True, "name": name}


def http_form(url: str, fields: dict, timeout: int = 25) -> dict:
    body = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "CityIDE/1.0",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "ignore"))


def http_post_json(url: str, payload: dict, headers: dict | None = None, timeout: int = 25) -> dict:
    body = json.dumps(payload).encode("utf-8")
    h = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "CityIDE/1.0"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "ignore")
        return json.loads(raw) if raw.strip() else {}



def msa_code_login(code: str) -> dict:
    """用 live.com 授权码换 MSA 令牌，再走 XBL → XSTS → Minecraft。"""
    if not code:
        return {"ok": False, "error": "没有拿到授权码"}
    try:
        tok = http_form("https://login.live.com/oauth20_token.srf", {
            "client_id": MS_CLIENT_ID_DEFAULT,
            "redirect_uri": "https://login.live.com/oauth20_desktop.srf",
            "grant_type": "authorization_code",
            "code": code,
        })
    except Exception as exc:
        return {"ok": False, "error": "换令牌失败：" + str(exc)}
    access = tok.get("access_token")
    if not access:
        return {"ok": False, "error": tok.get("error_description") or "没有 access_token"}

    try:
        xbl = http_post_json("https://user.auth.xboxlive.com/user/authenticate", {
            "Properties": {"AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com",
                           "RpsTicket": "d=" + access},
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT",
        })
        uhs = ((xbl.get("DisplayClaims") or {}).get("xui") or [{}])[0].get("uhs", "")
        xsts = http_post_json("https://xsts.auth.xboxlive.com/xsts/authorize", {
            "Properties": {"SandboxId": "RETAIL", "UserTokens": [xbl.get("Token")]},
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT",
        })
        if not xsts.get("Token"):
            return {"ok": False, "error": "XSTS 授权失败（账号可能没有 Xbox 档案或没有买 Minecraft）"}
        mc = http_post_json("https://api.minecraftservices.com/authentication/login_with_xbox", {
            "identityToken": f"XBL3.0 x={uhs};{xsts.get('Token')}"
        })
        mc_token = mc.get("access_token")
        if not mc_token:
            return {"ok": False, "error": "换取 Minecraft 令牌失败"}
        prof = http_json_any(["https://api.minecraftservices.com/minecraft/profile"], timeout=20)
    except Exception as exc:
        return {"ok": False, "error": "登录链路出错：" + str(exc)}

    if not prof or not prof.get("id"):
        return {"ok": False, "error": "这个账号没有购买 Minecraft"}
    save_cfg({"account": {"type": "msa", "name": prof.get("name"), "uuid": prof.get("id"),
                          "token": mc_token}, "username": prof.get("name")})
    log_line(f"正版登录成功：{prof.get('name')} ({prof.get('id')})")
    return {"ok": True, "name": prof.get("name"), "uuid": prof.get("id")}


def msa_start() -> dict:
    cid = cfg().get("msa_client_id") or MS_CLIENT_ID_DEFAULT
    try:
        r = http_form("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode", {
            "client_id": cid,
            "scope": "XboxLive.signin offline_access",
        })
        return {
            "ok": True,
            "device_code": r.get("device_code"),
            "user_code": r.get("user_code"),
            "uri": r.get("verification_uri") or "https://microsoft.com/link",
            "interval": int(r.get("interval") or 5),
            "expires": int(r.get("expires_in") or 900),
            "clientId": cid,
        }
    except Exception as exc:
        msg = str(exc)
        try:
            err = json.loads(exc.read().decode("utf-8", "ignore")) if hasattr(exc, "read") else {}
            msg = err.get("error_description") or msg
        except Exception:
            pass
        return {"ok": False, "error": msg, "clientId": cid}


def msa_finish(device_code: str) -> dict:
    cid = cfg().get("msa_client_id") or MS_CLIENT_ID_DEFAULT
    try:
        tok = http_form("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
            "client_id": cid,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": device_code,
        })
        access = tok.get("access_token")
        if not access:
            return {"ok": False, "status": "pending", "error": tok.get("error", "")}
    except Exception as exc:
        return {"ok": False, "status": "pending", "error": str(exc)}

    # Xbox Live
    xbl = http_post_json("https://user.auth.xboxlive.com/user/authenticate", {
        "Properties": {"AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com",
                       "RpsTicket": "d=" + access},
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT",
    })
    xbl_token = xbl.get("Token")
    uhs = ((xbl.get("DisplayClaims") or {}).get("xui") or [{}])[0].get("uhs", "")

    xsts = http_post_json("https://xsts.auth.xboxlive.com/xsts/authorize", {
        "Properties": {"SandboxId": "RETAIL", "UserTokens": [xbl_token]},
        "RelyingParty": "rp://api.minecraftservices.com/",
        "TokenType": "JWT",
    })
    xsts_token = xsts.get("Token")
    if not xsts_token:
        return {"ok": False, "status": "error", "error": "XSTS 授权失败（这个账号可能没有 Minecraft）"}

    mc = http_post_json("https://api.minecraftservices.com/authentication/login_with_xbox", {
        "identityToken": f"XBL3.0 x={uhs};{xsts_token}"
    })
    mc_token = mc.get("access_token")
    if not mc_token:
        return {"ok": False, "status": "error", "error": "换取 Minecraft 令牌失败"}

    prof = http_json_any(["https://api.minecraftservices.com/minecraft/profile"], timeout=20)
    if not prof or not prof.get("id"):
        return {"ok": False, "status": "error", "error": "这个账号没有购买 Minecraft"}

    acc = {"type": "msa", "name": prof.get("name"), "uuid": prof.get("id"), "token": mc_token}
    save_cfg({"account": acc, "username": prof.get("name")})
    log_line(f"正版登录成功：{prof.get('name')}")
    return {"ok": True, "status": "ok", "name": prof.get("name"), "uuid": prof.get("id")}


# --------------------------------------------------------------------------- launcher
def detect_loader(vid: str, data: dict | None) -> str:
    low = vid.lower()
    if "neoforge" in low:
        return "NeoForge"
    if "forge" in low:
        return "Forge"
    if "quilt" in low:
        return "Quilt"
    if "fabric" in low:
        return "Fabric"
    if "optifine" in low:
        return "OptiFine"
    if data and data.get("inheritsFrom"):
        return "继承 " + str(data.get("inheritsFrom"))
    return "原版"



def version_dir(vid: str) -> Path:
    return mc_dir() / "versions" / vid


def is_isolated(vid: str) -> bool:
    """PCL 开版本隔离时会在 versions/<版本>/ 下建 PCL 文件夹。"""
    vdir = version_dir(vid)
    return ((vdir / "PCL").exists()
            or (vdir / "instance.marker").exists()
            or (vdir / "mods").is_dir()
            or (vdir / "saves").is_dir())


def mods_dir_for(vid: str) -> Path:
    if vid and is_isolated(vid):
        return version_dir(vid) / "mods"
    return mc_dir() / "mods"


def version_detail(vid: str) -> dict:
    vdir = mc_dir() / "versions" / vid
    vjson = {}
    if (vdir / f"{vid}.json").exists():
        try:
            vjson = json.loads((vdir / f"{vid}.json").read_text("utf-8"))
        except Exception:
            vjson = {}
    isolated = is_isolated(vid)
    mods_dir = mods_dir_for(vid)
    mods = []
    if mods_dir.exists():
        for f in sorted(mods_dir.glob("*.jar")):
            mods.append({"name": f.name, "size": f.stat().st_size})

    worlds = []
    saves = (vdir / "saves") if isolated else (mc_dir() / "saves")
    if saves.exists():
        for d in sorted(saves.iterdir()):
            if d.is_dir() and (d / "level.dat").exists():
                worlds.append(d.name)

    shots = []
    shot_dir = mc_dir() / "screenshots"
    if shot_dir.exists():
        for f in sorted(shot_dir.glob("*.png"), key=lambda x: x.stat().st_mtime, reverse=True)[:12]:
            shots.append({"name": f.name, "time": int(f.stat().st_mtime)})

    def listing(name):
        d = mc_dir() / name
        if not d.exists():
            return []
        return [x.name for x in sorted(d.iterdir()) if x.is_dir() or x.suffix in (".zip", ".jar")][:40]

    return {
        "id": vid,
        "gameVersion": vjson.get("inheritsFrom") or vid,
        "loader": detect_loader(vid, vjson),
        "isolated": isolated,
        "installed": (vdir / f"{vid}.jar").exists() or (vdir / f"{vid}.json").exists(),
        "hasJar": (vdir / f"{vid}.jar").exists(),
        "path": str(vdir),
        "modsDir": str(mods_dir),
        "mods": mods,
        "globalMods": len(list((mc_dir() / "mods").glob("*.jar"))) if (mc_dir() / "mods").exists() else 0,
        "worlds": worlds,
        "screenshots": shots,
        "resourcepacks": listing("resourcepacks"),
        "shaderpacks": listing("shaderpacks"),
        "schematics": listing("schematics"),
        "hasServers": (mc_dir() / "servers.dat").exists(),
        "java": pick_java((vjson.get("javaVersion") or {}).get("majorVersion", 21)) or "",
        "memory": cfg().get("mem", 4096),
    }


def delete_version(vid: str) -> dict:
    vdir = mc_dir() / "versions" / vid
    if not vdir.exists():
        return {"ok": False, "error": "版本目录不存在"}
    try:
        shutil.rmtree(vdir)
        log_line(f"已删除版本 {vid}")
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def export_version(vid: str) -> dict:
    """把这个版本的 mods / config 打成一个 zip，放到桌面。"""
    vdir = mc_dir() / "versions" / vid
    mods_dir = mods_dir_for(vid)
    desktop = Path.home() / "Desktop"
    out = desktop / f"{vid}-整合导出.zip"
    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        if mods_dir.exists():
            for f in mods_dir.glob("*.jar"):
                z.write(f, f"mods/{f.name}")
                count += 1
        cfg_dir = mc_dir() / "config"
        if cfg_dir.exists():
            for f in cfg_dir.glob("*.toml"):
                z.write(f, f"config/{f.name}")
                count += 1
    return {"ok": True, "path": str(out), "files": count}



# --------------------------------------------------------------------------- jar workbench
def extract_jar(path: str) -> dict:
    src = Path(path)
    if not src.exists() or src.suffix.lower() != ".jar":
        return {"ok": False, "error": "不是有效的 jar 文件"}
    dest = project_dir() / "imported" / src.stem
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    count = 0
    try:
        with zipfile.ZipFile(src) as z:
            for item in z.namelist():
                if item.endswith("/"):
                    continue
                rel = Path(item)
                if rel.is_absolute() or ".." in rel.parts:
                    continue
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(item) as f, open(target, "wb") as out:
                    shutil.copyfileobj(f, out)
                count += 1
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    log_line(f"已解包 {src.name} -> imported/{src.stem}（{count} 个文件）")
    return {"ok": True, "dir": str(dest), "files": count, "rel": f"imported/{src.stem}"}


def javap_rel(rel: str) -> dict:
    """对工程里的 .class 直接反编译（javap -p -c 指向文件本身）。"""
    java = pick_java(21)
    if not java:
        return {"ok": False, "error": "找不到 Java"}
    javap = tool_path(java, "javap")
    if not javap:
        return {"ok": False, "error": "这个 JDK 没有 javap"}
    target = (project_dir() / rel).resolve()
    if not str(target).startswith(str(project_dir().resolve())):
        return {"ok": False, "error": "路径越界"}
    if not target.exists():
        return {"ok": False, "error": "文件不存在"}
    try:
        proc = subprocess.run([str(javap), "-p", "-c", str(target)],
                              capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=60)
        out = (proc.stdout or "") + (proc.stderr or "")
        return {"ok": True, "text": out[:30000]}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def javap_class(jar_path: str, entry: str) -> dict:
    java = pick_java(21)
    if not java:
        return {"ok": False, "error": "找不到 Java"}
    javap = tool_path(java, "javap")
    if not javap:
        return {"ok": False, "error": "这个 JDK 没有 javap"}
    cls = entry.replace("\\", "/")
    if cls.endswith(".class"):
        cls = cls[:-6]
    cls = cls.replace("/", ".")
    try:
        proc = subprocess.run([str(javap), "-p", "-c", "-classpath", jar_path, cls],
                              capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=60)
        out = (proc.stdout or "") + (proc.stderr or "")
        return {"ok": proc.returncode == 0, "text": out[:20000], "class": cls}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# --------------------------------------------------------------------------- lessons
LESSONS = [
    {
        "id": "structure",
        "title": "1. 一个 Java 程序长什么样",
        "summary": "包名、类、main 方法——这三层是 Java 的骨架，所有代码都长在它们里面。",
        "points": [
            "package com.example; 表示这个类在 com/example 这个文件夹里，文件夹路径必须和包名一致。",
            "public class Main 定义一个类，文件名必须叫 Main.java（大小写一致）。",
            "public static void main(String[] args) 是程序入口，JVM 只认这一个签名。",
            "大括号 { } 划定范围，必须成对；每条语句以 ; 结尾。",
        ],
        "code": """package com.example;

// 文件名必须和 public 类名一致：这里是 Lesson1.java
public class Lesson1 {
    public static void main(String[] args) {
        System.out.println("Hello!");
    }
}
""",
        "file": "src/main/java/com/example/Lesson1.java",
        "class": "com.example.Lesson1",
    },
    {
        "id": "vars",
        "title": "2. 变量与类型",
        "summary": "Java 是强类型语言：每个变量都要先声明类型，之后只能装这个类型的数据。",
        "points": [
            "int 整数、double 小数、boolean 真假、String 字符串、char 单个字符。",
            "声明格式：类型 名字 = 值;  例如 int hp = 20;",
            "字符串拼接用 +，数字会自动转成字符串。",
            "常量用 final，比如 final int MAX = 100; 之后不能改。",
            "类型转换：int 转 double 自动，double 转 int 要写 (int) x，会丢小数。",
        ],
        "code": """package com.example;

public class Lesson2 {
    public static void main(String[] args) {
        int hp = 20;
        double speed = 1.5;
        boolean flying = false;
        String name = "Jiang";

        System.out.println(name + " 血量 " + hp + "，速度 " + speed);
        System.out.println("在飞？" + flying);

        final int MAX_HP = 20;
        System.out.println("最大血量 " + MAX_HP);

        double half = hp / 2.0;     // 20 / 2.0 = 10.0
        int truncated = (int) 9.99; // 9，小数被砍掉
        System.out.println(half + " / " + truncated);
    }
}
""",
        "file": "src/main/java/com/example/Lesson2.java",
        "class": "com.example.Lesson2",
    },
    {
        "id": "flow",
        "title": "3. 条件与循环",
        "summary": "if 决定走哪条路，for/while 决定重复几次——写逻辑就靠它们。",
        "points": [
            "if (条件) { ... } else if (...) { ... } else { ... }，条件必须是 boolean。",
            "== 比较值，equals() 比较字符串内容（字符串千万别用 ==）。",
            "for (int i = 0; i < n; i++) 是最常用的循环。",
            "for (String s : list) 是增强 for，直接遍历。",
            "break 跳出循环，continue 跳过本次。",
        ],
        "code": """package com.example;

public class Lesson3 {
    public static void main(String[] args) {
        int blocks = 4;

        if (blocks > 5) {
            System.out.println("方块很多");
        } else if (blocks > 0) {
            System.out.println("方块不多，一共 " + blocks + " 个");
        } else {
            System.out.println("一个方块都没有");
        }

        for (int i = 1; i <= 3; i++) {
            System.out.println("第 " + i + " 次循环");
        }

        String[] names = {"讲解石", "路牌"};
        for (String n : names) {
            if (n.equals("路牌")) {
                System.out.println("跳过 " + n);
                continue;
            }
            System.out.println("处理 " + n);
        }
    }
}
""",
        "file": "src/main/java/com/example/Lesson3.java",
        "class": "com.example.Lesson3",
    },
    {
        "id": "method",
        "title": "4. 方法：把一段逻辑打包",
        "summary": "方法 = 名字 + 参数 + 返回值。写好一次，到处调用。",
        "points": [
            "格式：返回类型 名字(参数类型 参数名) { ... return 值; }",
            "void 表示不返回东西；return 会立刻结束方法。",
            "static 方法不用 new 对象就能调用，入口 main 就是 static。",
            "参数是值传递：基本类型传副本，改了不影响外面。",
            "重载：同名方法不同参数，编译器按参数挑。",
        ],
        "code": """package com.example;

public class Lesson4 {
    public static void main(String[] args) {
        int total = add(3, 5);
        System.out.println("3 + 5 = " + total);

        printBlock("讲解石", 4);
        printBlock("路牌");
    }

    private static int add(int a, int b) {
        return a + b;
    }

    private static void printBlock(String name, int count) {
        System.out.println(name + " 有 " + count + " 个");
    }

    // 重载：同名不同参数
    private static void printBlock(String name) {
        printBlock(name, 1);
    }
}
""",
        "file": "src/main/java/com/example/Lesson4.java",
        "class": "com.example.Lesson4",
    },
    {
        "id": "class",
        "title": "5. 类与对象",
        "summary": "类是一张图纸，对象是按图纸造出来的东西。字段存状态，方法做事情。",
        "points": [
            "字段（成员变量）写在类里、方法外，每个对象各有一份。",
            "构造方法名字和类名一样、没有返回类型，new 的时候执行。",
            "this 指当前对象，用来区分字段和参数。",
            "private 只让自己类访问，public 谁都能访问——默认写 private 更安全。",
            "static 字段属于类而不是对象，所有对象共享一份。",
        ],
        "code": """package com.example;

public class Lesson5 {
    public static void main(String[] args) {
        Blockcard a = new Blockcard("讲解石", 4);
        Blockcard b = new Blockcard("路牌", 7);
        a.show();
        b.show();
        System.out.println("一共创建了 " + Blockcard.count + " 个方块信息");
    }
}

class Blockcard {
    static int count = 0;      // 静态：所有对象共享
    private String name;       // 字段：每个对象一份
    private int amount;

    Blockcard(String name, int amount) {   // 构造方法
        this.name = name;                  // this 区分字段和参数
        this.amount = amount;
        count++;
    }

    void show() {
        System.out.println(name + " x" + amount);
    }
}
""",
        "file": "src/main/java/com/example/Lesson5.java",
        "class": "com.example.Lesson5",
    },
    {
        "id": "inherit",
        "title": "6. 继承：Block 就是被继承出来的",
        "summary": "extends 表示「是一种」。Minecraft 的所有方块都继承 Block，你写的方块也一样。",
        "points": [
            "class MyBlock extends Block 表示 MyBlock 是一种 Block，自动 with 父类所有能力。",
            "super(...) 调用父类构造方法，必须放在子类构造第一行。",
            "@Override 表示重写父类方法，写错名字编译器会提醒你。",
            "父类方法不想被改就加 final；抽象方法必须子类实现。",
            "Minecraft 里 BlockBehaviour.Properties 就是「方块的属性配置」。",
        ],
        "code": """package com.example;

/** 不依赖 Minecraft，先看继承长什么样 */
public class Lesson6 {
    public static void main(String[] args) {
        Stone stone = new Stone();
        Glass glass = new Glass();
        stone.describe();
        glass.describe();
    }
}

class BaseBlock {
    String name = "方块";

    void describe() {
        System.out.println("我是一个" + name);
    }
}

class Stone extends BaseBlock {
    Stone() {
        name = "石头";
    }
}

class Glass extends BaseBlock {
    Glass() {
        name = "玻璃";
    }

    @Override
    void describe() {
        System.out.println("我是透明的" + name);   // 重写父类方法
    }
}
""",
        "file": "src/main/java/com/example/Lesson6.java",
        "class": "com.example.Lesson6",
    },
    {
        "id": "mcblock",
        "title": "7. 写一个真正的 Minecraft 方块类",
        "summary": "把前 6 课拼起来：继承 Block、写构造方法、加朝向状态。需要 libs 里有反混淆的 MC/Forge jar。",
        "points": [
            "import net.minecraft.world.level.block.Block; —— 这些类来自 libs 里的 Forge jar。",
            "super(properties) 把属性交给父类，noOcclusion 表示不挡光、不是完整方块。",
            "registerDefaultState 设置默认朝向，FACING 是水平四向。",
            "getStateForPlacement 决定放下去时朝哪边：玩家朝向的反方向。",
            "真正进游戏还要注册方块 + 物品 + 模型，那是下一步（教程第 6、7 步）。",
        ],
        "code": """package com.example;

import net.minecraft.core.Direction;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.HorizontalDirectionalBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.StateDefinition;
import net.minecraft.world.level.block.state.BlockBehaviour;

/**
 * 一个朝东南西北四个方向的方块。
 * 编译前确认：libs 里有 forge-<版本>.jar（构建页「一键导入到 libs」）。
 */
public class Lesson7Block extends HorizontalDirectionalBlock {

    public Lesson7Block() {
        super(BlockBehaviour.Properties.of().strength(1.5F).noOcclusion());
        this.registerDefaultState(this.stateDefinition.any().setValue(FACING, Direction.NORTH));
    }

    @Override
    protected void createBlockStateDefinition(StateDefinition.Builder<Block, BlockState> builder) {
        builder.add(FACING);
    }

    @Override
    public BlockState getStateForPlacement(BlockPlaceContext context) {
        return this.defaultBlockState().setValue(FACING, context.getHorizontalDirection().getOpposite());
    }
}
""",
        "file": "src/main/java/com/example/Lesson7Block.java",
        "class": "com.example.Lesson7Block",
    },
]


def lessons_state() -> dict:
    pd = project_dir()
    out = []
    for i, l in enumerate(LESSONS):
        target = pd / l["file"]
        out.append({
            "index": i,
            "id": l["id"],
            "title": l["title"],
            "summary": l["summary"],
            "points": l["points"],
            "code": l["code"],
            "file": l["file"],
            "mainClass": l["class"],
            "written": target.exists(),
        })
    return {"lessons": out, "projectDir": str(pd)}


def write_lesson(index: int) -> dict:
    if index < 0 or index >= len(LESSONS):
        return {"ok": False, "error": "没有这一课"}
    l = LESSONS[index]
    pd = project_dir()
    target = safe_project_path(pd, l["file"])
    if not target:
        return {"ok": False, "error": "路径不合法"}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(l["code"], "utf-8")
    log_line(f"写入课程代码 {l['file']}")
    return {"ok": True, "file": l["file"], "mainClass": l["class"], "lessons": lessons_state()["lessons"]}


# --------------------------------------------------------------------------- build api

# --------------------------------------------------------------------------- mod dev libs
def deobf_roots() -> list:
    roots = [
        ROOT / "moddev",
        Path.home() / ".gradle" / "caches" / "minecraftforge" / "forgegradle" / "mavenizer" / "repo",
        ROOT.parent / "jiangmod" / "mdk" / ".gradle" / "mavenizer" / "repo",
    ]
    return [r for r in roots if r.exists()]


def find_deobf_jar(vid: str) -> Path | None:
    """找一个已经反混淆（官方命名）的 Forge/MC 整合 jar。"""
    best = None
    for root in deobf_roots():
        for jar in root.rglob(f"*{vid}*.jar"):
            if "-sources" in jar.name or "-javadoc" in jar.name:
                continue
            if best is None or (jar.name.startswith("forge-") and not best.name.startswith("forge-")):
                best = jar
    return best


def version_library_jars(vid: str) -> list:
    try:
        data = merge_version(vid)
    except Exception:
        return []
    jars = []
    for lib in data.get("libraries", []):
        art = lib.get("downloads", {}).get("artifact")
        if not art:
            continue
        path = mc_dir() / "libraries" / art["path"]
        if path.exists() and path.suffix == ".jar":
            jars.append(path)
    return jars


def libs_status() -> dict:
    pd = project_dir()
    libs = pd / "libs"
    jars = sorted(libs.glob("*.jar")) if libs.exists() else []
    has_forge = any("forge" in j.name.lower() for j in jars)
    has_mc = any(j.name.lower().startswith("forge-") or "minecraft" in j.name.lower() for j in jars)
    return {
        "libsDir": str(libs),
        "count": len(jars),
        "size": sum(j.stat().st_size for j in jars),
        "hasForge": has_forge,
        "hasMc": has_mc,
        "names": [j.name for j in jars][:60],
    }


def import_mod_libs(vid: str) -> dict:
    pd = project_dir()
    libs = pd / "libs"
    libs.mkdir(parents=True, exist_ok=True)
    sources = version_library_jars(vid)
    deobf = find_deobf_jar(vid)
    if deobf:
        sources.append(deobf)
    if not sources:
        return {"ok": False, "error": f"没找到 {vid} 的依赖库，先把版本下载下来（版本页点下载）"}
    added, skipped, size = [], 0, 0
    for jar in sources:
        target = libs / jar.name
        if target.exists():
            skipped += 1
            continue
        try:
            os.link(jar, target)
        except Exception:
            shutil.copy2(jar, target)
        added.append(jar.name)
        size += jar.stat().st_size
    log_line(f"导入模组依赖：新增 {len(added)} 个，跳过 {skipped} 个，共 {size // 1048576} MB")
    status = libs_status()
    status.update({
        "ok": True,
        "added": added,
        "skipped": skipped,
        "addedSize": size,
        "deobf": str(deobf) if deobf else "",
    })
    if not deobf:
        status["warning"] = ("没找到反混淆的 Minecraft/Forge jar。原版 client.jar 里的类名是混淆过的，"
                             "直接编译 import net.minecraft... 会全部报找不到。把 ForgeGradle 生成的 "
                             "forge-<版本>.jar 放到 moddev\ 目录再导入一次。")
    return status


def build_get(handler, path: str, qs: dict) -> bool:
    pd = project_dir()
    if path == "/api/project":
        return handler._json({
            "projectDir": str(pd),
            "tree": project_tree(pd),
            "sources": len(collect_sources(pd)),
            "mainClasses": [p.stem for p in collect_sources(pd) if "class " in p.read_text("utf-8", "ignore")],
        }) or True
    if path == "/api/diagnosis":
        return handler._json({"diagnosis": STATE.get("diagnosis"), "launch": STATE.get("launch")}) or True
    if path == "/api/update/check":
        return handler._json(check_update()) or True
    if path == "/api/theme":
        return handler._json({"ok": True, "theme": get_theme()}) or True
    if path == "/api/theme/bg":
        f = THEME_BG()
        if not f.exists():
            handler._json({"ok": False, "error": "没有背景图"}, 404)
            return True
        data = f.read_bytes()
        handler.send_response(200)
        handler.send_header("Content-Type", "image/*")
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        handler.wfile.write(data)
        return True
    if path == "/api/account":
        return handler._json(account_state()) or True
    if path == "/api/account/skin":
        acc = cfg().get("account") or {}
        skin = mc_dir() / "custom_skins" / (str(acc.get("name") or "Steve") + ".png")
        if not skin.exists():
            handler._json({"ok": False, "error": "没有自定义皮肤"}, 404)
            return True
        data = skin.read_bytes()
        handler.send_response(200)
        handler.send_header("Content-Type", "image/png")
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        handler.wfile.write(data)
        return True
    if path == "/api/version/detail":
        return handler._json(version_detail(qs.get("vid", ["26.3"])[0])) or True
    if path == "/api/quilt":
        return handler._json({"versions": quilt_loaders(qs.get("mc", ["26.3"])[0])}) or True
    if path == "/api/optifine":
        return handler._json({"versions": optifine_versions(qs.get("mc", ["1.20.1"])[0])}) or True
    if path == "/api/worlds":
        return handler._json({"worlds": list_worlds()}) or True
    if path == "/api/neoforge":
        return handler._json({"versions": neoforge_versions(qs.get("mc", ["26.3"])[0])}) or True
    if path == "/api/modrinth/project":
        return handler._json(modrinth_project(qs.get("id", [""])[0])) or True
    if path == "/api/modrinth":
        return handler._json(modrinth_search(
            qs.get("q", [""])[0], qs.get("type", ["mod"])[0],
            qs.get("mc", [""])[0], qs.get("loader", [""])[0],
            int(qs.get("limit", ["20"])[0]), int(qs.get("offset", ["0"])[0]),
            qs.get("sort", [""])[0],
        )) or True
    if path == "/api/lessons":
        return handler._json(lessons_state()) or True
    if path == "/api/libs/status":
        return handler._json(libs_status()) or True
    if path == "/api/compilers":
        out = []
        for j in find_javas():
            javac = tool_path(j["path"], "javac")
            if javac:
                out.append({"path": j["path"], "javac": str(javac), "major": j["major"], "version": j["version"]})
        return handler._json({"compilers": out, "preferred": out[0]["path"] if out else ""}) or True
    if path == "/api/file":
        rel = qs.get("path", [""])[0]
        target = safe_project_path(pd, rel)
        if not target or not target.exists() or not target.is_file():
            handler._json({"ok": False, "error": "文件不存在"}, 404)
            return True
        if target.stat().st_size > 2 * 1024 * 1024:
            handler._json({"ok": False, "error": "文件太大，不在编辑器里打开"}, 400)
            return True
        try:
            content = read_text_auto(target)
        except Exception:
            handler._json({"ok": False, "error": "不是文本文件"}, 400)
            return True
        return handler._json({"ok": True, "path": rel, "content": content}) or True
    return False


def build_post(handler, path: str, body: dict) -> bool:
    pd = project_dir()
    if path == "/api/build/compile":
        jdk = body.get("jdk") or preferred_compiler()
        if not jdk:
            handler._json({"ok": False, "error": "没有可用的 JDK"})
            return True
        res = compile_project(pd, jdk, body.get("release"))
        res["tutorial"] = tutorial_state()
        handler._json(res)
        return True
    if path == "/api/autotest":
        return handler._json({"result": STATE.get("autotest", "")}) or True
    if path == "/api/autotest":
        STATE["autotest"] = body.get("result", "")
        log_line("[自测]\n" + str(body.get("result", ""))[:4000])
        handler._json({"ok": True})
        return True
    if path == "/api/clientlog":
        log_line(f"[前端{body.get('level', 'error')}] {body.get('msg', '')} {body.get('stack', '')[:300]}")
        handler._json({"ok": True})
        return True
    if path == "/api/mods/import-global":
        handler._json(import_global_mods(body.get("vid", "")))
        return True
    if path == "/api/jar/extract":
        handler._json(extract_jar(body.get("path", "")))
        return True
    if path == "/api/jar/javaprel":
        handler._json(javap_rel(body.get("path", "")))
        return True
    if path == "/api/jar/javap":
        handler._json(javap_class(body.get("path", ""), body.get("entry", "")))
        return True
    if path == "/api/update/check":
        handler._json(check_update(body.get("repo", ""), body.get("current", "")))
        return True
    if path == "/api/update/download":
        handler._json(download_update(body.get("url", ""), body.get("name", "")))
        return True
    if path == "/api/theme":
        handler._json(save_theme(body.get("theme") or {}))
        return True
    if path == "/api/account/offline":
        name = (body.get("name") or "").strip() or "Steve"
        save_cfg({"account": {"type": "offline", "name": name}, "username": name})
        handler._json({"ok": True, "account": account_state()})
        return True
    if path == "/api/account/skin":
        length = int(handler.headers.get("Content-Length") or 0)
        data = handler.rfile.read(length) if length else b""
        handler._json(save_skin(data))
        return True
    if path == "/api/account/msa/code":
        handler._json(msa_code_login(body.get("code", "")))
        return True
    if path == "/api/account/msa/start":
        handler._json(msa_start())
        return True
    if path == "/api/account/msa/poll":
        handler._json(msa_finish(body.get("device_code", "")))
        return True
    if path == "/api/account/clientid":
        save_cfg({"msa_client_id": (body.get("clientId") or "").strip()})
        handler._json({"ok": True})
        return True
    if path == "/api/mods/delete":
        handler._json(delete_mod(body.get("name", ""), body.get("vid", "")))
        return True
    if path == "/api/mods/upload":
        q = parse_qs(urlparse(handler.path).query)
        name = (q.get("name", [""])[0]) or body.get("name") or "upload.jar"
        length = int(handler.headers.get("Content-Length") or 0)
        raw = handler.rfile.read(length) if length else b""
        handler._json(save_mod(name, raw, q.get("vid", [""])[0]))
        return True
    if path == "/api/version/delete":
        handler._json(delete_version(body.get("vid", "")))
        return True
    if path == "/api/version/export":
        handler._json(export_version(body.get("vid", "")))
        return True
    if path == "/api/modrinth/install":
        res = install_modrinth(body.get("id", ""), body.get("type", "mod"),
                               body.get("mc", ""), body.get("loader", ""), body.get("slug", ""),
                               body.get("world", ""))
        handler._json(res)
        return True
    if path == "/api/loader/install" and body.get("type") == "quilt":
        threading.Thread(target=install_quilt, args=(body.get("mc", ""), body.get("loader", "")), daemon=True).start()
        handler._json({"ok": True})
        return True
    if path == "/api/loader/install" and body.get("type") == "optifine":
        if body.get("run"):
            handler._json(run_optifine_installer(body.get("mc", ""), body.get("filename", "")))
        else:
            threading.Thread(target=install_optifine, args=(body.get("mc", ""), body.get("filename", "")), daemon=True).start()
            handler._json({"ok": True})
        return True
    if path == "/api/loader/install" and body.get("type") == "neoforge":
        if body.get("run"):
            handler._json(run_neoforge_installer(body.get("version", "")))
        else:
            threading.Thread(target=install_neoforge, args=(body.get("mc", ""), body.get("version", "")), daemon=True).start()
            handler._json({"ok": True})
        return True
    if path == "/api/lessons/write":
        handler._json(write_lesson(int(body.get("index", 0))))
        return True
    if path == "/api/libs/import":
        res = import_mod_libs(body.get("version") or "26.3")
        handler._json(res)
        return True
    if path == "/api/build/jar":
        res = package_project(pd, body.get("name") or (pd.name + ".jar"), body.get("mainClass") or "")
        res["tutorial"] = tutorial_state()
        handler._json(res)
        return True
    if path == "/api/build/run":
        jdk = body.get("jdk") or preferred_compiler()
        res = run_project(pd, jdk, body.get("mainClass") or "", body.get("args") or "")
        handler._json(res)
        return True
    if path == "/api/file/save":
        rel = body.get("path", "")
        target = safe_project_path(pd, rel)
        if not target:
            handler._json({"ok": False, "error": "路径不合法"})
            return True
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body.get("content", ""), "utf-8")
        log_line(f"已保存 {rel}")
        handler._json({"ok": True, "tutorial": tutorial_state()})
        return True
    if path == "/api/project/new":
        res = new_project(Path(body.get("path") or project_dir()), body.get("modid") or "mymod",
                          body.get("template") or "hello")
        res["tutorial"] = tutorial_state()
        handler._json(res)
        return True
    if path == "/api/tutorial/write_code":
        step = int(body.get("step", 2))
        cur = TUTORIAL_STEPS[min(step, len(TUTORIAL_STEPS) - 1)]
        if not cur.get("code") or not cur.get("file"):
            handler._json({"ok": False, "error": "这一步没有示例代码"})
            return True
        target = safe_project_path(pd, cur["file"])
        if not target:
            handler._json({"ok": False, "error": "路径不合法"})
            return True
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(cur["code"], "utf-8")
        log_line(f"示例代码已写入 {cur['file']}")
        handler._json({"ok": True, "file": cur["file"], "tutorial": tutorial_state()})
        return True
    return False


def preferred_compiler() -> str:
    best = ""
    best_major = -1
    for j in find_javas():
        if tool_path(j["path"], "javac") and j["major"] > best_major:
            best, best_major = j["path"], j["major"]
    return best


# --------------------------------------------------------------------------- http
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # 开发期避免浏览器缓存旧页面/旧脚本
        if self.path.endswith((".js", ".css", ".html", "/")):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    def _touch(self):
        STATE["last_seen"] = time.time()

    def do_GET(self):
        self._touch()
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        try:
            if build_get(self, path, qs):
                return
            if path == "/api/state":
                return self._json({
                    "root": str(ROOT),
                    "pid": os.getpid(),
                    "version": cfg().get("app_version") or APP_VERSION,
                    "minecraftDir": str(mc_dir()),
                    "projectDir": str(project_dir()),
                    "javas": find_javas(),
                    "config": cfg(),
                })
            if path == "/api/versions":
                return self._json(list_versions(qs.get("refresh", ["0"])[0] == "1"))
            if path == "/api/progress":
                with PROGRESS_LOCK:
                    return self._json(dict(STATE, log=STATE["log"][-120:]))
            if path == "/api/loaders":
                mc = qs.get("mc", ["26.3"])[0]
                return self._json({"fabric": fabric_loaders(mc), "forge": forge_versions(mc)})
            if path == "/api/java":
                return self._json({"local": find_javas(), "remote": java_remote()})
            if path == "/api/mods":
                return self._json({"mods": list_mods(), "dir": str(mc_dir() / "mods")})
            if path == "/api/jar":
                p = Path(qs.get("path", [""])[0])
                if not p.exists():
                    return self._json({"ok": False, "error": "文件不存在"}, 404)
                info = jar_info(p)
                with zipfile.ZipFile(p) as z:
                    names = z.namelist()[:400]
                return self._json({"ok": True, "info": info, "entries": names})
            if path == "/api/logs":
                return self._json({"logs": latest_logs()})
            if path == "/api/tutorial":
                return self._json(tutorial_state())
            if path == "/api/config":
                return self._json(cfg())
            return super().do_GET()
        except Exception as exc:
            return self._json({"ok": False, "error": str(exc)}, 500)

    def do_POST(self):
        self._touch()
        path = urlparse(self.path).path

        # 二进制上传要在解析 JSON 之前处理，否则 body 会被吃掉
        if path == "/api/theme/bg":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            if len(raw) < 100:
                return self._json({"ok": False, "error": "图片太小"})
            THEME_BG().parent.mkdir(parents=True, exist_ok=True)
            THEME_BG().write_bytes(raw)
            return self._json({"ok": True, "size": len(raw)})

        if path in ("/api/account/skin", "/api/mods/upload"):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            q = parse_qs(urlparse(self.path).query)
            if path == "/api/account/skin":
                return self._json(save_skin(raw))
            name = q.get("name", ["upload.jar"])[0]
            return self._json(save_mod(name, raw, q.get("vid", [""])[0]))

        body = self._body()
        try:
            if build_post(self, path, body):
                return
            if path == "/api/version/download":
                vid = body.get("id", "")
                if STATE["running"]:
                    return self._json({"ok": False, "error": "已有任务在进行"})
                threading.Thread(target=download_version, args=(vid, bool(body.get("assets"))), daemon=True).start()
                return self._json({"ok": True})
            if path == "/api/loader/install":
                kind = body.get("type")
                if kind == "fabric":
                    threading.Thread(target=install_fabric, args=(body["mc"], body["loader"]), daemon=True).start()
                    return self._json({"ok": True})
                if kind == "forge":
                    if body.get("run"):
                        return self._json(run_forge_installer(body["full"]))
                    threading.Thread(target=install_forge, args=(body["mc"], body["full"]), daemon=True).start()
                    return self._json({"ok": True})
            if path == "/api/java/download":
                threading.Thread(target=java_download, args=(int(body.get("major", 21)),), daemon=True).start()
                return self._json({"ok": True})
            if path == "/api/mods/check":
                return self._json(check_mods(body.get("loader", "")))
            if path == "/api/logs/analyze":
                logs = latest_logs()
                target = body.get("text")
                result = analyze_text(target if target else "\n".join(l["text"] for l in logs))
                return self._json({"ok": True, "hits": result, "files": [l["file"] for l in logs]})
            if path == "/api/launch":
                res = launch(body.get("id", ""), body.get("username", "Steve"),
                             int(body.get("memory", 4096)), body.get("jvm", ""))
                if res.get("ok"):
                    save_cfg({"ever_launched": True})
                return self._json(res)
            if path == "/api/tutorial/next":
                t = cfg().get("tutorial", {"step": 0, "active": True, "done": False})
                st = tutorial_state()
                if not st["detected"]:
                    return self._json({"ok": False, "error": "这一步还没完成"})
                t["step"] = min(t.get("step", 0) + 1, len(TUTORIAL_STEPS) - 1)
                if t.get("step", 0) >= len(TUTORIAL_STEPS) - 1 and detect_step(TUTORIAL_STEPS[-1]["key"]):
                    t["done"] = True
                save_cfg({"tutorial": t})
                return self._json(tutorial_state())
            if path == "/api/tutorial/cancel":
                t = cfg().get("tutorial", {"step": 0, "active": True, "done": False})
                t["active"] = False
                save_cfg({"tutorial": t})
                return self._json(tutorial_state())
            if path == "/api/tutorial/restart":
                save_cfg({"tutorial": {"step": 0, "active": True, "done": False}})
                return self._json(tutorial_state())
            if path == "/api/config":
                save_cfg(body)
                return self._json({"ok": True, "config": cfg()})
            if path == "/api/open":
                target = body.get("path") or str(mc_dir())
                os.startfile(target)  # noqa: S606
                return self._json({"ok": True})
            if path == "/api/project/new":
                pd = Path(body.get("path") or project_dir())
                modid = body.get("modid") or "mymod"
                (pd / "src/main/java").mkdir(parents=True, exist_ok=True)
                (pd / "src/main/resources/assets" / modid).mkdir(parents=True, exist_ok=True)
                (pd / "src/main/resources/assets" / modid / "models/block").mkdir(parents=True, exist_ok=True)
                (pd / "src/main/resources/assets" / modid / "textures/block").mkdir(parents=True, exist_ok=True)
                readme = pd / "README.md"
                if not readme.exists():
                    readme.write_text(f"# {modid}\n\n用 Java IDE 创建的模组工程。\n", "utf-8")
                save_cfg({"project_dir": str(pd)})
                return self._json({"ok": True, "projectDir": str(pd)})
            return self._json({"ok": False, "error": "unknown endpoint"}, 404)
        except Exception as exc:
            return self._json({"ok": False, "error": str(exc)}, 500)


def ensure_dirs() -> None:
    try:
        project_dir().mkdir(parents=True, exist_ok=True)
        (ROOT / "cache").mkdir(parents=True, exist_ok=True)
    except Exception:
        pass


def main():
    ensure_dirs()
    port = 8777
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        print(f"port {port} already in use - assuming another instance is running")
        return

    def watchdog():
        while True:
            time.sleep(60)
            if not STATE["running"] and (time.time() - STATE["last_seen"]) > 8 * 3600:
                os._exit(0)

    threading.Thread(target=watchdog, daemon=True).start()
    print(f"City Minecraft Java IDE backend on http://127.0.0.1:{port}")
    srv.serve_forever()


if __name__ == "__main__":
    try:
        _log = open(ROOT / "server.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = _log
        sys.stderr = _log
        print(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} 启动 =====")
    except Exception:
        pass
    try:
        main()
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise
