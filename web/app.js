const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------- 错误捕获：任何前端异常都送到后端 + 顶部红条 ---------------- */
function showError(text) {
  const bar = $("#errBanner");
  if (!bar) return;
  $("#errText").textContent = text;
  bar.hidden = false;
}

function showOffline(msg) {
  const bar = $("#errBanner");
  if (!bar) return;
  $("#errText").textContent = msg;
  $("#errRetry").hidden = false;
  bar.hidden = false;
}

async function reportError(msg, stack) {
  showError(msg);
  try {
    await fetch("/api/clientlog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "error", msg: String(msg).slice(0, 500), stack: String(stack || "").slice(0, 800) }),
    });
  } catch (e) { /* 后端也可能挂了，忽略 */ }
}

window.addEventListener("error", (e) => reportError(e.message || "脚本错误", `${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => reportError("异步错误：" + (e.reason && e.reason.message ? e.reason.message : e.reason), e.reason && e.reason.stack));

const state = {
  versions: [],
  selected: null,
  javas: [],
  progressTimer: null,
  tutorial: null,
};

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
  } catch (e) {
    showOffline("连不上本地服务，正在自动重连…");
    throw new Error("连不上本地服务，可能后台没启动：" + e.message);
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
const get = (path) => api(path);

/* ------------------------------------------------------------------ routing */
function showPage(name) {
  $$(".rail-btn[data-page]").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + name));
  if (name === "launch") loadLaunch();
  if (name === "tutorial") refreshTutorial();
  if (name === "code") loadProject().catch(() => {});
  if (name === "lan") { bindLanPage(); refreshLanHost(); }
  if (name === "build") {
    loadCompilers().catch(() => {});
    fillLibsVersions();
    loadLibsStatus();
  }
}

$$(".rail-btn[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => showPage(btn.dataset.page));
});

/* ------------------------------------------------------------------ status */
const MESSAGES = [];
function setStatus(text, kind) {
  $("#statusText").textContent = text;
  const dot = $("#statusDot");
  dot.className = "dot" + (kind ? " " + kind : "");
  const last = MESSAGES[MESSAGES.length - 1];
  if (!last || last.text !== text) {
    MESSAGES.push({ at: new Date(), text, kind: kind || "" });
    if (MESSAGES.length > 300) MESSAGES.shift();
    renderMessages();
  }
}

function renderMessages() {
  const box = $("#messageLog");
  if (!box) return;
  box.innerHTML = MESSAGES.slice().reverse().map((m) => {
    const t = m.at.toLocaleTimeString("zh-CN", { hour12: false });
    return `<div class="msg ${m.kind}"><span class="msg-time">${t}</span><span>${m.text}</span></div>`;
  }).join("") || '<div class="empty">还没有消息</div>';
}

function renderProgress(p) {
  const total = p.total || 0;
  const done = p.done || 0;
  const unknown = p.running && total <= 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : p.running ? 0 : 0;
  const fill = $("#barFill");
  fill.style.width = unknown ? "100%" : pct + "%";
  fill.classList.toggle("indeterminate", unknown);
  if (p.running) {
    setStatus(p.task || "下载中", "busy");
    const mb = (n) => (n / 1048576).toFixed(1);
    if (total > 0) {
      $("#progressText").textContent = `${p.message || ""} ${mb(done)} / ${mb(total)} MB（${pct}%）`;
    } else if (done > 0) {
      $("#progressText").textContent = `${p.message || ""} 已下载 ${mb(done)} MB`;
    } else {
      $("#progressText").textContent = p.message || "准备中…";
    }
  } else if (p.error) {
    setStatus("失败：" + p.error, "err");
    $("#progressText").textContent = "";
    $("#barFill").style.width = "0%";
  } else if (p.task) {
    setStatus(p.message || "完成", "ok");
    $("#progressText").textContent = "";
    setTimeout(() => { $("#barFill").style.width = "0%"; }, 600);
  }
  if (p.log) renderConsole(p.log);
}

let consoleLines = [];
function paintConsole(el, lines) {
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const prev = el.scrollTop;
  el.textContent = lines.join("\n");
  // 用户往上翻的时候不要把他拽回底部
  el.scrollTop = atBottom ? el.scrollHeight : prev;
}
function renderConsole(lines) {
  consoleLines = lines;
  paintConsole($("#console"), lines);
  paintConsole($("#console2"), lines);
}

async function pollProgress() {
  try {
    const p = await api("/api/progress");
    renderProgress(p);
    if (!p.running && state.progressTimer) {
      clearInterval(state.progressTimer);
      state.progressTimer = null;
      loadVersions().then(() => fillLaunchVersions());
    }
  } catch (e) { /* ignore */ }
}

function startPolling() {
  if (state.progressTimer) return;
  state.progressTimer = setInterval(pollProgress, 800);
}

/* ------------------------------------------------------------------ versions */
async function loadVersions(force) {
  const box = $("#versionGroups");
  if (force && box) box.innerHTML = '<div class="empty">正在刷新版本清单…</div>';
  try {
    const data = await api("/api/versions" + (force ? "?refresh=1" : ""));
    state.versions = data.versions;
    state.latestIds = [data.latest.release, data.latest.snapshot].filter(Boolean);
    renderVersionGroups();
  } catch (e) {
    if (box) {
      box.innerHTML = `<div class="empty">读取版本失败：${e.message}<br><br>
        <button class="primary" onclick="loadVersions(true)">重试</button></div>`;
    }
  }
}

async function downloadVersion(id) {
  const withAssets = await uiConfirm(`下载 ${id}`,
    "要一起下资源文件吗？\n\n确定 = 完整下载（能正常显示贴图和声音，几百 MB）\n取消 = 只下客户端和依赖库（体积小，进游戏会缺贴图）",
    "完整下载", "只下客户端");
  await post("/api/version/download", { id, assets: withAssets });
  notifyIsland("activity");
  setStatus("开始下载 " + id, "busy");
  startPolling();
}

async function launchVersion(id) {
  const mem = parseInt(localStorage.getItem("mem") || "4096", 10);
  const user = localStorage.getItem("username") || "Steve";
  const res = await post("/api/launch", { id, memory: mem, username: user });
  if (res.ok) {
    setStatus("游戏已启动（PID " + res.pid + "）", "ok");
    if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage("launched");
    showPage("tools");
    startPolling();
  } else {
    setStatus("启动失败：" + res.error, "err");
    uiAlert("启动失败", res.error);
  }
}

/* ------------------------------------------------------------------ loaders */



/* ------------------------------------------------------------------ mods */
async function loadMods() {
  const data = await api("/api/mods");
  const box = $("#modList");
  box.innerHTML = "";
  $("#modsCount").textContent = data.mods.length + " 个";
  if (!data.mods.length) {
    box.innerHTML = '<div class="empty">mods 目录是空的</div>';
    return;
  }
  data.mods.forEach((m) => {
    const row = document.createElement("div");
    row.className = "row";
    const lb = m.loader ? `<span class="badge ${m.loader === "fabric" ? "release" : "old"}">${m.loader}</span>` : '<span class="badge warn">未知</span>';
    row.innerHTML = `
      <div class="row-main">
        <div class="row-title">${m.displayName || m.name} ${lb}</div>
        <div class="row-sub">${m.modId || "无 modId"} · ${m.version || "?"} · ${(m.size / 1024).toFixed(0)} KB${m.mcRange ? " · MC " + m.mcRange : ""}</div>
      </div>
      <div class="row-actions">
        <button class="ghost" data-act="jar">解析</button>
      </div>`;
    row.querySelector('[data-act="jar"]').addEventListener("click", () => {
      $("#jarPath").value = m.path;
      showPage("tools");
      parseJar(m.path);
    });
    box.appendChild(row);
  });
}

async function checkMods() {
  const loader = $("#modsLoader").value;
  const res = await post("/api/mods/check", { loader });
  const box = $("#modFindings");
  box.innerHTML = "";
  res.findings.forEach((f) => {
    const div = document.createElement("div");
    div.className = "finding";
    div.innerHTML = `<span class="badge ${f.level}">${f.level}</span>
      <div><div class="text">${f.text}</div><div class="mod">${f.mod || ""}</div></div>`;
    box.appendChild(div);
  });
  if (!res.findings.length) box.innerHTML = '<div class="empty">没问题</div>';
  setStatus(res.ok ? "模组检查通过" : "模组有问题", res.ok ? "ok" : "err");
}

/* ------------------------------------------------------------------ java */
async function loadJava() {
  const data = await api("/api/java");
  state.javas = data.local;
  const box = $("#javaList");
  box.innerHTML = "";
  if (!data.local.length) {
    box.innerHTML = '<div class="empty">没找到 JDK</div>';
  } else {
    data.local.forEach((j) => {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">Java ${j.major} <span class="badge ${j.major >= 21 ? "ok" : "warn"}">${j.version}</span></div>
          <div class="row-sub">${j.path}</div>
        </div>`;
      box.appendChild(row);
    });
  }
  const remote = $("#javaRemote");
  remote.innerHTML = "";
  data.remote.forEach((r) => {
    const row = document.createElement("div");
    row.className = "row";
    const srcs = (r.sources || ["Adoptium 官方"]).join(" · ");
    row.innerHTML = `
      <div class="row-main"><div class="row-title">JDK ${r.major}</div><div class="row-sub">Windows x64 · ${srcs}</div></div>
      <div class="row-actions"><button class="primary" data-act="dl">下载</button></div>`;
    row.querySelector('[data-act="dl"]').addEventListener("click", async () => {
      await post("/api/java/download", { major: r.major });
      setStatus("下载 JDK " + r.major + "（国内镜像优先）", "busy");
      startPolling();
    });
    remote.appendChild(row);
  });
}

/* ------------------------------------------------------------------ tools */
async function parseJar(path) {
  const p = path || $("#jarPath").value.trim();
  if (!p) return;
  $("#jarResult").innerHTML = '<div class="empty">解析中…</div>';
  try {
    const data = await api("/api/jar?path=" + encodeURIComponent(p));
    const i = data.info;
    const rows = [
      ["文件", i.name],
      ["大小", (i.size / 1024).toFixed(0) + " KB"],
      ["条目", i.entries],
      ["加载器", i.loader || "—"],
      ["modId", i.modId || "—"],
      ["版本", i.version || "—"],
      ["支持 MC", i.mcRange || "—"],
      ["状态", i.broken ? "损坏：" + i.error : "正常"],
    ];
    $("#jarResult").innerHTML = `<table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>
      <div class="muted" style="margin-top:8px">前 ${Math.min(60, data.entries.length)} 个条目：</div>
      <pre class="mini">${data.entries.slice(0, 60).join("\n")}</pre>
      <div class="row-gap" style="margin-top:10px">
        <button class="primary" id="btnExtractJar">解包到工程 imported/</button>
      </div>`;
    $("#btnExtractJar").onclick = () => extractJar(p, i.name);
  } catch (e) {
    $("#jarResult").innerHTML = `<div class="empty">解析失败：${e.message}</div>`;
  }
}

async function extractJar(path, name) {
  setStatus("正在解包 " + name + "…", "busy");
  const r = await post("/api/jar/extract", { path });
  if (!r.ok) { await uiAlert("解包失败", r.error); return; }
  setStatus(`已解包 ${r.files} 个文件 → ${r.rel}`, "ok");
  await loadProject();
  showPage("code");
}

function renderHits(hits, files) {
  const box = $("#analyzeResult");
  if (!hits.length) {
    box.innerHTML = `<div class="empty">没匹配到已知问题${files && files.length ? "（读过 " + files.join(", ") + "）" : ""}</div>`;
    return;
  }
  box.innerHTML = hits.map((h) => `
    <div class="finding">
      <span class="badge err">问题</span>
      <div><div class="text"><b>${h.title}</b></div>
      <div class="mod">命中：${h.match}</div>
      <div class="text" style="color:var(--muted);margin-top:4px">${h.advice}</div></div>
    </div>`).join("");
}

async function analyzeLatest() {
  const res = await post("/api/logs/analyze", {});
  renderHits(res.hits, res.files);
  setStatus("分析完成，命中 " + res.hits.length + " 条", res.hits.length ? "err" : "ok");
}

async function analyzeText() {
  const text = $("#logText").value;
  const res = await post("/api/logs/analyze", { text });
  renderHits(res.hits, []);
}

/* ------------------------------------------------------------------ tutorial */
let lastTutorialJson = "";
async function refreshTutorial() {
  const t = await api("/api/tutorial");
  const snapshot = JSON.stringify(t);
  if (snapshot === lastTutorialJson && $("#tut-steps") && !$("#tut-steps").hidden) {
    return; // 没变化就别重绘，避免滚动位置被打断
  }
  lastTutorialJson = snapshot;
  state.tutorial = t;
  const bar = $("#tutorialBar");
  if (!t.active || t.finished) {
    bar.classList.add("hidden");
  } else {
    bar.classList.remove("hidden");
    $("#tbStep").textContent = `步骤 ${t.step + 1}/${t.total}`;
    $("#tbTitle").textContent = t.title;
    $("#tbHint").textContent = t.hint;
    $("#tbDone").hidden = !t.detected;
    $("#btnTutorialNext").disabled = !t.detected;
  }
  const steps = $("#tutorialSteps");
  steps.innerHTML = "";
  t.steps.forEach((s, idx) => {
    const div = document.createElement("div");
    div.className = "step" + (s.done ? " done" : "") + (idx === t.step ? " current" : "");
    div.innerHTML = `<div class="num">${s.done ? "✓" : idx + 1}</div>
      <div class="step-body"><div class="step-title">${s.title}${s.done ? ' <span class="badge ok">完成！</span>' : idx === t.step ? ' <span class="badge info">进行中</span>' : ""}</div>
      <div class="step-hint">${s.hint || ""}</div></div>`;
    div.addEventListener("click", () => { state.tutorialStep = idx; renderTutorialDetail(); });
    steps.appendChild(div);
  });
  $("#tutorialProgress").textContent = t.steps.filter((s) => s.done).length + "/" + t.total;
  if (state.tutorialStep == null) state.tutorialStep = t.step;
  renderTutorialDetail();
}

function renderTutorialDetail() {
  const t = state.tutorial;
  if (!t) return;
  const idx = Math.min(state.tutorialStep ?? t.step, t.total - 1);
  const step = t.steps[idx] || {};
  const code = idx === t.step ? (t.code || "") : "";
  $("#tdTitle").textContent = `${idx + 1}. ${step.title || ""}`;
  const purpose = idx === t.step ? (t.purpose || "") : (step.hint || "");
  $("#tdPurpose").textContent = purpose;
  const list = $("#tdActions");
  list.innerHTML = "";
  (idx === t.step ? (t.actions || []) : []).forEach((a) => {
    const li = document.createElement("li");
    li.textContent = a;
    list.appendChild(li);
  });
  const wrap = $("#tdCodeWrap");
  const pre = $("#tdCode");
  if (code) {
    wrap.hidden = false;
    pre.hidden = false;
    pre.textContent = code;
  } else {
    wrap.hidden = true;
    pre.hidden = true;
  }
}

async function writeSampleCode() {
  const t = state.tutorial;
  const res = await post("/api/tutorial/write_code", { step: t.step });
  if (res.ok) {
    setStatus("示例代码已写入 " + res.file, "ok");
    await refreshTutorial();
    await loadProject();
    openFile(res.file);
    showPage("code");
  }
}

async function tutorialNext() {
  const res = await post("/api/tutorial/next", {});
  if (res.error) return;
  await refreshTutorial();
}

/* ------------------------------------------------------------------ wiki */
const WIKI = [
  ["Fabric 官方文档", "https://docs.fabricmc.net/"],
  ["Forge 文档", "https://docs.minecraftforge.net/"],
  ["Minecraft Wiki", "https://zh.minecraft.wiki/"],
  ["Blockbench 建模", "https://www.blockbench.net/"],
  ["MC 资源包格式", "https://zh.minecraft.wiki/w/资源包"],
  ["模组开发索引", "https://zh.minecraft.wiki/w/模组"],
  ["Java 25 API", "https://docs.oracle.com/en/java/javase/25/docs/api/"],
  ["崩溃报告怎么读", "https://zh.minecraft.wiki/w/崩溃报告"],
];

function renderWiki() {
  const box = $("#wikiList");
  box.innerHTML = WIKI.map(([name, url]) =>
    `<a class="wiki-item" href="${url}" target="_blank" rel="noreferrer"><span class="ico"></span>${name}</a>`).join("");
}

/* ------------------------------------------------------------------ modal */
function openSettings() {
  const mc = $("#mcPath").textContent;
  const mirrorOn = state.config ? state.config.mirror_first !== false : true;
  $("#modalBody").innerHTML = `
    <label class="field"><span>游戏目录</span><input id="setMc" class="input" value="${mc}"></label>
    <label class="field"><span>默认玩家名（离线模式）</span><input id="setUser" class="input" value="${localStorage.getItem("username") || "Steve"}"></label>
    <label class="field"><span>最大内存 (MB)</span><input id="setMem" class="input" value="${localStorage.getItem("mem") || "4096"}"></label>
    <label class="check" style="margin:6px 0 14px"><input type="checkbox" id="setMirror" ${mirrorOn ? "checked" : ""} /> 下载优先用国内镜像（BMCLAPI）</label>
    <label class="field"><span>更新源（GitHub 用户名/仓库）</span><input id="setRepo" class="input" placeholder="例如: yourname/city-minecraft-ide" value="${(state.config && state.config.update_repo) || ""}"></label>
    <div class="row-gap" style="margin:0 0 14px">
      <button class="ghost" id="setCheckUpdate">检查更新</button>
      <span class="muted" id="setUpdateMsg">当前版本 ${(state.config && state.config.app_version) || "1.0.0"}</span>
    </div>
    <button class="primary wide" id="setSave">保存</button>`;
  $("#modal").hidden = false;
  $("#setCheckUpdate").addEventListener("click", async () => {
    const repo = $("#setRepo").value.trim();
    if (repo) await post("/api/config", { update_repo: repo });
    $("#setUpdateMsg").textContent = "检查中…";
    const res = await post("/api/update/check", { repo });
    if (!res || !res.ok) { $("#setUpdateMsg").textContent = res ? res.error : "检查失败"; return; }
    if (res.hasUpdate) {
      $("#modal").hidden = true;
      showUpdateDialog(res);
    } else {
      $("#setUpdateMsg").textContent = `已是最新版 ${res.current}`;
    }
  });
  $("#setSave").addEventListener("click", async () => {
    localStorage.setItem("username", $("#setUser").value);
    localStorage.setItem("mem", $("#setMem").value);
    await post("/api/config", {
      minecraft_dir: $("#setMc").value,
      mirror_first: $("#setMirror").checked,
      update_repo: $("#setRepo").value.trim()
    });
    $("#modal").hidden = true;
    boot();
  });
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  renderWiki();
  const params = new URLSearchParams(location.search);
  if (params.get("autotest") === "1") setTimeout(runAutotest, 600);
  const page = params.get("page");
  if (page) showPage(page);
  if (params.get("dl")) switchCategory(params.get("dl"), true);
  const wantProject = params.get("project");
  if (wantProject) {
    setTimeout(async () => {
      if (params.get("dl")) switchCategory(params.get("dl"), true);
      openProject({ id: wantProject, slug: wantProject, title: wantProject });
    }, 1800);
  }
  const wantInstall = params.get("install");
  if (wantInstall) {
    setTimeout(async () => {
      if (!state.versions || !state.versions.length) await loadVersions();
      const v = (state.versions || []).find((x) => x.id === wantInstall);
      if (v) openInstall(v);
    }, 1500);
  }

  if (params.get("tut")) switchTutTab(params.get("tut"));
  if (params.get("palette") === "1") {
    setTimeout(() => openPal(), 1500);
  }
  if (params.get("appearance") === "1") {
    setTimeout(() => openAppearance(), 1400);
  }
  if (params.get("account") === "1") {
    setTimeout(() => openAccount(), 1600);
  }
  if (params.get("vset") === "1") {
    setTimeout(async () => {
      await loadLaunch();
      launchSettingsOpen = true;
      if (launchDetail) renderVersionSettings(launchDetail);
    }, 1500);
  }
  if (params.get("demo") === "confirm") {
    setTimeout(() => uiConfirm("26.2-pre-4 还没下载客户端",
      "这个版本现在只有 json，没有 client.jar。\n\n现在下载吗？下载完再点一次「启动游戏」就直接开。",
      "现在下载", "取消"), 1200);
  }
  api("/api/state").then((st) => { $("#mcPath").textContent = st.minecraftDir; state.config = st.config || {}; }).catch(() => {});
  loadTheme();
  setTimeout(() => checkUpdate(true), 2500);
  loadVersions().then(() => {
    fillLaunchVersions();
    if ($("#page-launch").classList.contains("active")) loadLaunch();
  }).catch(() => {});
  loadJava();
  loadCompilers().catch(() => {});
  loadProject().catch(() => {});
  refreshTutorial().catch(() => {});
  pollProgress();
  setInterval(refreshTutorial, 4000);
  setInterval(() => {
    $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }, 1000);
}

/* ------------------------------------------------------------------ build */
async function loadLibsStatus() {
  try {
    const st = await api("/api/libs/status");
    $("#libsCount").textContent = st.count ? st.count + " 个 jar" : "";
    if (!st.count) {
      $("#libsStatus").innerHTML = '<span class="muted">libs 还是空的，选一个版本点导入</span>';
      return;
    }
    let html = `<span class="badge ok">${st.count} 个 jar</span> ${(st.size / 1048576).toFixed(1)} MB`;
    html += st.hasForge ? ' · <span class="badge ok">含 Forge</span>' : ' · <span class="badge warn">没有 Forge/MC</span>';
    $("#libsStatus").innerHTML = html;
  } catch (e) { /* ignore */ }
}

function fillLibsVersions() {
  const sel = $("#libsVersion");
  if (!sel || sel.options.length) return;
  const list = (state.versions || []).filter((v) => v.installed || v.json_only).slice(0, 60);
  if (!list.length) {
    sel.innerHTML = '<option value="26.3">26.3</option>';
    return;
  }
  sel.innerHTML = list.map((v) => `<option value="${v.id}">${v.id}</option>`).join("");
  const preferred = list.find((v) => v.installed) || list[0];
  sel.value = preferred.id;
}

async function importLibs() {
  const version = $("#libsVersion").value;
  $("#libsStatus").innerHTML = '<span class="muted">导入中…</span>';
  const res = await post("/api/libs/import", { version });
  if (!res.ok) {
    $("#libsStatus").innerHTML = `<span class="badge err">失败</span> ${res.error}`;
    return;
  }
  let html = `<span class="badge ok">已导入</span> 新增 ${res.added.length} 个，跳过 ${res.skipped} 个，${(res.addedSize / 1048576).toFixed(1)} MB`;
  if (res.deobf) html += `<div class="muted" style="margin-top:4px">反混淆包：${res.deobf.split(/[\\/]/).pop()}</div>`;
  if (res.warning) html += `<div class="diag-hint" style="margin-top:6px">${res.warning}</div>`;
  $("#libsStatus").innerHTML = html;
  setStatus("依赖已导入 libs", "ok");
  await loadLibsStatus();
}

async function loadCompilers() {
  const data = await api("/api/compilers");
  const sel = $("#compilerSelect");
  sel.innerHTML = "";
  if (!data.compilers.length) {
    sel.innerHTML = '<option value="">没有找到带 javac 的 JDK</option>';
    return;
  }
  data.compilers.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.path;
    o.textContent = `Java ${c.major}（${c.version}）`;
    if (c.path === data.preferred) o.selected = true;
    sel.appendChild(o);
  });
}

function renderDiagnostics(diags) {
  const box = $("#diagnostics");
  box.innerHTML = "";
  $("#diagCount").textContent = diags.length ? diags.length + " 条" : "";
  if (!diags.length) {
    box.innerHTML = '<div class="empty">没有错误</div>';
    return;
  }
  diags.forEach((d) => {
    const div = document.createElement("div");
    div.className = "finding";
    div.innerHTML = `<span class="badge ${d.kind === "error" ? "err" : "warn"}">${d.kind === "error" ? "错误" : "警告"}</span>
      <div class="diag-body">
        <div class="text"><b>${d.message}</b></div>
        <div class="mod">${d.file.split(/[\\/]/).pop()}:${d.line}${d.detail ? " · " + d.detail : ""}</div>
        ${d.hint ? `<div class="diag-hint">${d.hint}</div>` : ""}
      </div>`;
    box.appendChild(div);
  });
}

function renderBuildSummary(html) {
  $("#buildSummary").innerHTML = html;
}

async function compileNow() {
  renderBuildSummary('<span class="muted">编译中…</span>');
  const jdk = $("#compilerSelect").value;
  const res = await post("/api/build/compile", { jdk });
  renderDiagnostics(res.diagnostics || []);
  if (res.ok) {
    renderBuildSummary(`<span class="badge ok">编译成功</span> ${res.classCount} 个 class · ${res.sources} 个源文件 · ${res.ms} ms`);
    setStatus("编译成功", "ok");
  } else {
    renderBuildSummary(`<span class="badge err">编译失败</span> ${(res.diagnostics || []).length} 条错误 / ${res.ms || 0} ms`);
    setStatus("编译失败", "err");
  }
  pollProgress();
  return res;
}

async function packageNow() {
  const res = await post("/api/build/jar", { name: $("#jarName").value, mainClass: $("#mainClass").value });
  if (res.ok) {
    renderBuildSummary(`<span class="badge ok">已打包</span> ${res.files} 个文件 · ${(res.size / 1024).toFixed(0)} KB<br><span class="muted">${res.path}</span>`);
    setStatus("打包完成：" + res.path, "ok");
  } else {
    renderBuildSummary(`<span class="badge err">打包失败</span> ${res.error}`);
    setStatus("打包失败：" + res.error, "err");
  }
  refreshTutorial();
}

async function runNow() {
  const res = await post("/api/build/run", { jdk: $("#compilerSelect").value, mainClass: $("#mainClass").value });
  if (res.ok) {
    setStatus("程序已启动，输出在控制台", "ok");
    startPolling();
  } else {
    setStatus("运行失败：" + res.error, "err");
  }
}

/* ------------------------------------------------------------------ editor */
async function loadProject() {
  const data = await api("/api/project");
  state.projectDir = data.projectDir;
  $("#codeProjectPath").textContent = "工程：" + data.projectDir;
  $("#fileCount").textContent = data.tree.filter((x) => !x.dir).length + " 个文件";
  const box = $("#fileTree");
  box.innerHTML = "";
  if (!data.tree.length) {
    box.innerHTML = '<div class="empty">工程还是空的，去「教程」页点新建工程</div>';
    return;
  }
  data.tree.forEach((item) => {
    const div = document.createElement("div");
    div.className = "tree-item" + (item.dir ? " dir" : "");
    div.style.paddingLeft = 10 + item.depth * 14 + "px";
    div.innerHTML = `<span class="ti-icon">${item.dir ? "▸" : "·"}</span>${item.name}`;
    if (!item.dir) {
      div.addEventListener("click", () => openFile(item.path));
    }
    box.appendChild(div);
  });
}

async function openFile(rel) {
  if (rel.toLowerCase().endsWith(".class")) {
    $("#editor").value = "// 这是编译后的二进制 class 文件，不能直接看源码。\n// 点上面的「反编译 (javap)」，我把它拆成字节码指令给你看。";
    $("#editorTitle").textContent = rel;
    $("#editorStatus").textContent = "二进制";
    state.openFile = rel;
    state.dirty = false;
    $("#btnDecompile").hidden = false;
    $$(".tree-item").forEach((el) => el.classList.remove("active"));
    return;
  }
  $("#btnDecompile").hidden = true;
  try {
    const data = await api("/api/file?path=" + encodeURIComponent(rel));
    $("#editor").value = data.content;
    $("#editorTitle").textContent = rel;
    state.openFile = rel;
    state.dirty = false;
    $("#editorStatus").textContent = "";
    $$(".tree-item").forEach((el) => el.classList.remove("active"));
  } catch (e) {
    setStatus("打不开：" + e.message, "err");
  }
}

async function saveFile() {
  if (!state.openFile) return;
  const res = await post("/api/file/save", { path: state.openFile, content: $("#editor").value });
  if (res.ok) {
    $("#editorStatus").textContent = "已保存 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setStatus("已保存 " + state.openFile, "ok");
    state.dirty = false;
    await refreshTutorial();
    await loadProject();
  } else {
    setStatus("保存失败：" + res.error, "err");
  }
}

async function newFile() {
  const name = $("#newFileName").value.trim();
  if (!name) return;
  const rel = name.includes("/") ? name : "src/main/java/com/example/" + name;
  const res = await post("/api/file/save", { path: rel, content: "" });
  if (res.ok) {
    $("#newFileName").value = "";
    await loadProject();
    openFile(rel);
  }
}



function notifyIsland(msg) {
  try { if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(msg); } catch (e) { }
}

/* ---------------- 自绘对话框（不用系统 confirm/alert，避免露出地址） ---------------- */
function uiDialog(opts) {
  const o = Object.assign({ title: "", message: "", input: false, defaultValue: "",
                            okText: "确定", cancelText: "取消" }, opts || {});
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal ui-modal";
    wrap.innerHTML = `
      <div class="modal-box ui-dialog">
        <div class="modal-head"><b>${o.title}</b><button class="ghost tiny" data-x>×</button></div>
        <div class="modal-body">
          <div class="ui-msg">${(o.message || "").replace(/\n/g, "<br>")}</div>
          ${o.input ? `<input class="input ui-input" value="${o.defaultValue || ""}" />` : ""}
          <div class="ui-actions">
            ${o.cancelText ? `<button class="ghost" data-cancel>${o.cancelText}</button>` : ""}
            <button class="primary" data-ok>${o.okText}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const box = wrap.querySelector(".ui-input");
    const done = (val) => {
      document.removeEventListener("keydown", onKey);
      wrap.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") done(o.input ? null : false);
      else if (e.key === "Enter") done(o.input ? (box ? box.value : "") : true);
    };
    wrap.querySelector("[data-ok]").onclick = () => done(o.input ? (box ? box.value : "") : true);
    wrap.querySelector("[data-cancel]")?.addEventListener("click", () => done(o.input ? null : false));
    wrap.querySelector("[data-x]").onclick = () => done(o.input ? null : false);
    document.addEventListener("keydown", onKey);
    if (box) setTimeout(() => { box.focus(); box.select(); }, 30);
  });
}

const uiConfirm = (title, message, okText, cancelText) =>
  uiDialog({ title, message, okText: okText || "确定", cancelText: cancelText || "取消" });
const uiAlert = (title, message) =>
  uiDialog({ title, message, okText: "知道了", cancelText: "" }).then(() => undefined);
const uiPrompt = (title, message, def) =>
  uiDialog({ title, message, input: true, defaultValue: def || "" });

/* ------------------------------------------------------------------ download center */
const CAT_LABEL = { vanilla: "原版游戏", mod: "Mod", modpack: "整合包", datapack: "数据包", resourcepack: "资源包", shader: "光影包" };
const CAT_HINT = {
  mod: "装进 .minecraft/mods，需要对应的加载器（Fabric / Forge / NeoForge）。",
  modpack: "会解包成独立实例，自带 mods、config 和版本配置。",
  datapack: "选一个存档，装进 存档/datapacks，进游戏 /reload 生效。",
  resourcepack: "装进 .minecraft/resourcepacks，游戏里「选项 → 资源包」启用。",
  shader: "装进 .minecraft/shaderpacks，需要 Iris / OptiFine。",
};
const LOADER_TIP = {
  vanilla: "原版：下载客户端、依赖库和资源文件，下完直接能启动。",
  fabric: "Fabric：直接生成可启动版本，最省事。",
  quilt: "Quilt：和 Fabric 类似，也是直接生成版本。",
  forge: "Forge：下载官方安装器，下完点「运行安装器」。",
  neoforge: "NeoForge：同 Forge，需要跑一次安装器。",
  optifine: "OptiFine：下载安装器后运行，选 Install 即可。OptiFine 只支持部分老版本。",
};

let dlCat = "vanilla";
let marketType = "mod";
let instVersion = null;

function switchCategory(cat, forceOpen) {
  const sec = document.querySelector(`.dl-section[data-cat="${cat}"]`);
  if (!sec) return;
  const willOpen = forceOpen === undefined ? !sec.classList.contains("open") : forceOpen;
  if (forceOpen === true && sec.classList.contains("open")) {
    // 已经是展开状态，不重复加载
  }
  sec.classList.toggle("open", willOpen);
  const body = sec.querySelector(".dl-sec-body");
  body.hidden = !willOpen;
  sec.querySelector(".chev").textContent = willOpen ? "▾" : "▸";
  if (!willOpen) return;
  if (cat === "vanilla") {
    renderVersionGroups();
    return;
  }
  if (cat === "launch") {
    fillLaunchVersions();
    return;
  }
  if (cat === "mod") {
    loadMods();
  }
  marketType = cat;
  // 把唯一的社区资源面板搬进当前展开的分类
  body.insertBefore($("#dl-market"), body.firstChild);
  $("#dl-market").hidden = false;
  $("#marketLoader").hidden = ["resourcepack", "shader", "datapack"].includes(cat);
  $("#marketWorld").hidden = cat !== "datapack";
  $("#marketHint").textContent = CAT_LABEL[cat] + " → " + CAT_HINT[cat];
  $("#marketQuery").value = "";
  if (cat === "datapack") loadWorlds();
  loadMarket(true);
}

async function loadWorlds() {
  try {
    const d = await api("/api/worlds");
    const sel = $("#marketWorld");
    sel.innerHTML = d.worlds.length
      ? d.worlds.map((w) => `<option value="${w}">${w}</option>`).join("")
      : '<option value="">（没有存档，装到 .minecraft/datapacks）</option>';
  } catch (e) { /* ignore */ }
}

function versionRow(v) {
  const row = document.createElement("div");
  row.className = "vrow";
  const badge = v.type === "release" ? "release" : v.type === "snapshot" ? "snapshot" : "old";
  row.innerHTML = `
    <div class="vrow-left">
      <div class="vrow-id">${v.id}<span class="badge ${badge}">${v.type}</span>
        ${v.installed ? '<span class="badge ok">已安装</span>' : v.json_only ? '<span class="badge warn">缺客户端</span>' : ""}</div>
      <div class="vrow-sub">${v.release || ""}${v.installed ? " · " + (v.jar_size / 1048576).toFixed(1) + " MB" : ""}</div>
    </div>
    <div class="vrow-right">
      ${v.installed ? '<button class="ghost" data-act="launch">启动</button>' : ""}
      <button class="primary" data-act="install">${v.installed ? "重装 / 加加载器" : "安装"}</button>
    </div>`;
  row.querySelector('[data-act="install"]').onclick = () => { state.selected = v.id; openInstall(v); };
  row.querySelector('[data-act="launch"]')?.addEventListener("click", (e) => { e.stopPropagation(); launchVersion(v.id); });
  row.onclick = () => openInstall(v);
  return row;
}

function renderVersionGroups() {
  const box = $("#versionGroups");
  const kw = $("#versionSearch").value.trim().toLowerCase();
  let list = state.versions || [];
  if (kw) list = list.filter((v) => v.id.toLowerCase().includes(kw));
  $("#versionCount").textContent = list.length + " 个版本";
  if (!list.length) {
    box.innerHTML = '<div class="empty">没有匹配的版本</div>';
    return;
  }
  const latestIds = new Set((state.latestIds || []).slice(0, 2));
  const groups = [
    ["最新版本", list.filter((v) => latestIds.has(v.id))],
    ["正式版", list.filter((v) => v.type === "release" && !latestIds.has(v.id))],
    ["快照 / 预览版", list.filter((v) => v.type === "snapshot")],
    ["远古版本", list.filter((v) => v.type !== "release" && v.type !== "snapshot")],
  ];
  box.innerHTML = "";
  let isFirst = true;
  groups.forEach(([title, items]) => {
    if (!items.length) return;
    const sec = document.createElement("div");
    sec.className = "vgroup" + (isFirst ? " open" : "");
    const head = document.createElement("div");
    head.className = "vgroup-head";
    head.innerHTML = `<span class="chev">${isFirst ? "▾" : "▸"}</span><span>${title}</span><span class="muted">${items.length}</span>`;
    head.onclick = () => {
      const open = !sec.classList.contains("open");
      sec.classList.toggle("open", open);
      head.querySelector(".chev").textContent = open ? "▾" : "▸";
    };
    sec.appendChild(head);
    items.slice(0, 150).forEach((v) => sec.appendChild(versionRow(v)));
    box.appendChild(sec);
    isFirst = false;
  });
}

function openInstall(v) {
  instVersion = v;
  $("#instVersionBadge").textContent = v.id;
  $("#instTitle").textContent = "安装 " + v.id;
  $("#instSub").textContent = `${v.type} · ${v.release || ""}${v.installed ? " · 已经装过了" : ""}`;
  $("#instName").value = v.id;
  $("#vanillaList").hidden = true;
  $("#vanillaInstall").hidden = false;
  const first = document.querySelector('input[name="loader"][value="vanilla"]');
  if (first) first.checked = true;
  onLoaderChange();
}

async function onLoaderChange() {
  const loader = (document.querySelector('input[name="loader"]:checked') || {}).value || "vanilla";
  const field = $("#loaderVersionField");
  $("#installTip").textContent = LOADER_TIP[loader] || "";
  if (loader === "vanilla") {
    field.hidden = true;
    return;
  }
  field.hidden = false;
  const sel = $("#instLoaderVer");
  sel.innerHTML = '<option value="">读取中…</option>';
  const mc = (instVersion || {}).id || "";
  try {
    let list = [];
    if (loader === "fabric" || loader === "quilt") {
      const d = await api(`/api/${loader}?mc=${encodeURIComponent(mc)}`);
      list = (d.versions || []).map((x) => x.version);
    } else if (loader === "forge") {
      const d = await api(`/api/loaders?mc=${encodeURIComponent(mc)}`);
      list = d.forge || [];
    } else if (loader === "neoforge") {
      const d = await api(`/api/neoforge?mc=${encodeURIComponent(mc)}`);
      list = d.versions || [];
    } else if (loader === "optifine") {
      const d = await api(`/api/optifine?mc=${encodeURIComponent(mc)}`);
      list = (d.versions || []).map((x) => x.filename);
    }
    sel.innerHTML = list.length
      ? list.map((x) => `<option value="${x}">${x}</option>`).join("")
      : `<option value="">${loader === "optifine" ? "这个版本没有 OptiFine" : "没有可用版本"}</option>`;
  } catch (e) {
    sel.innerHTML = '<option value="">读取失败</option>';
  }
}

async function startInstall() {
  if (!instVersion) return;
  const loader = (document.querySelector('input[name="loader"]:checked') || {}).value || "vanilla";
  const ver = $("#instLoaderVer").value;
  const mc = instVersion.id;
  if (loader !== "vanilla" && !ver) {
    uiAlert("没有可用版本", "这个加载器在当前的游戏版本下没有可选版本，换一个加载器试试。");
    return;
  }
  const btn = $("#btnStartInstall");
  btn.disabled = true;
  btn.textContent = "安装中…";
  try {
    if (loader === "vanilla") {
      await post("/api/version/download", { id: mc, assets: true });
    } else if (loader === "fabric" || loader === "quilt") {
      await post("/api/loader/install", { type: loader, mc, loader: ver });
    } else if (loader === "forge") {
      await post("/api/loader/install", { type: "forge", mc, full: ver });
    } else if (loader === "neoforge") {
      await post("/api/loader/install", { type: "neoforge", mc, version: ver });
    } else if (loader === "optifine") {
      await post("/api/loader/install", { type: "optifine", mc, filename: ver });
    }
    setStatus(`已开始：${mc} ${loader === "vanilla" ? "" : "+ " + loader}`, "ok");
    notifyIsland("activity");
    $("#installTip").textContent = loader === "vanilla"
      ? "正在下载，进度看底部状态栏；完成后回列表点「启动」。"
      : "正在下载，完成后会提示你运行安装器。";
    startPolling();
  } finally {
    btn.disabled = false;
    btn.textContent = "开始安装";
  }
}

let marketOffset = 0;
let marketTotal = 0;
let marketLoading = false;
const MARKET_CAP = 2000;

async function loadMarket(reset = true) {
  if (marketLoading) return;
  const box = $("#marketList");
  if (reset) {
    box.innerHTML = "";
    box.scrollTop = 0;
    marketOffset = 0;
    marketTotal = 0;
  }
  if (marketOffset >= MARKET_CAP) return;
  marketLoading = true;
  const q = $("#marketQuery").value.trim();
  const mc = $("#marketMc").value.trim();
  const loader = $("#marketLoader").hidden ? "" : $("#marketLoader").value;
  const sort = q ? "relevance" : "downloads";
  if (reset) box.innerHTML = '<div class="empty">加载中…</div>';
  const foot = $("#marketFoot");
  if (foot) foot.textContent = "加载中…";
  try {
    const url = `/api/modrinth?type=${marketType}&q=${encodeURIComponent(q)}&mc=${encodeURIComponent(mc)}`
      + `&loader=${encodeURIComponent(loader)}&limit=100&offset=${marketOffset}&sort=${sort}`;
    const data = await api(url);
    if (!data.ok) {
      if (reset) box.innerHTML = `<div class="empty">加载失败：${data.error}</div>`;
      if (foot) foot.textContent = "";
      return;
    }
    if (reset) box.innerHTML = "";
    marketTotal = Math.min(data.total || 0, MARKET_CAP);
    appendHits(data.hits || []);
    marketOffset += (data.hits || []).length;
    updateMarketFoot(q);
    setStatus(`${CAT_LABEL[marketType]}：已加载 ${marketOffset} / ${marketTotal}`, "ok");
  } catch (e) {
    if (reset) box.innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
  } finally {
    marketLoading = false;
  }
}

function appendHits(hits) {
  const box = $("#marketList");
  hits.forEach((h) => {
    const row = document.createElement("div");
    row.className = "market-item";
    const icon = h.icon
      ? `<img class="mi-icon" src="${h.icon}" loading="lazy" alt="" onerror="this.classList.add('mi-icon-empty');this.removeAttribute('src')">`
      : '<div class="mi-icon mi-icon-empty"></div>';
    row.innerHTML = `
      ${icon}
      <div class="mi-body">
        <div class="mi-head"><div class="mi-title">${h.title}</div><div class="mi-dl">${fmtNum(h.downloads)}</div></div>
        <div class="mi-desc">${h.description || ""}</div>
        <div class="mi-foot"><span class="muted">${h.author || ""}</span><button class="primary tiny-btn">安装</button></div>
      </div>`;
    row.querySelector("button").onclick = (e) => { e.stopPropagation(); installMarket(h, e.target); };
    row.querySelector(".mi-icon")?.addEventListener("click", () => openProject(h));
    row.querySelector(".mi-title").onclick = () => openProject(h);
    box.appendChild(row);
  });
}

async function openProject(hit) {
  document.querySelector(".modal-box").classList.add("wide");
  $("#modalTitle").textContent = hit.title;
  $("#modalBody").innerHTML = '<div class="empty">加载宣传图…</div>';
  $("#modal").hidden = false;
  let data;
  try {
    data = await api("/api/modrinth/project?id=" + encodeURIComponent(hit.id));
  } catch (e) {
    $("#modalBody").innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
    return;
  }
  if (!data.ok) {
    $("#modalBody").innerHTML = `<div class="empty">加载失败：${data.error}</div>`;
    return;
  }
  const p = data.project;
  const gallery = data.gallery || [];
  const shots = gallery.length
    ? gallery.map((g, i) => `<img class="shot-thumb${i === 0 ? " active" : ""}" src="${g.url}" data-idx="${i}" loading="lazy" alt="">`).join("")
    : '<div class="empty">这个项目没有上传宣传图</div>';
  $("#modalBody").innerHTML = `
    <div class="proj">
      <div class="proj-head">
        ${p.icon ? `<img class="proj-icon" src="${p.icon}" alt="">` : ""}
        <div class="proj-meta">
          <div class="proj-title">${p.title}</div>
          <div class="muted">${p.description || ""}</div>
          <div class="proj-stats">
            <span>${fmtNum(p.downloads)} 下载</span>
            <span>${fmtNum(p.followers)} 关注</span>
            <span>${(p.categories || []).slice(0, 4).join(" · ")}</span>
          </div>
        </div>
      </div>
      ${gallery.length ? `<div class="proj-preview"><img id="shotMain" src="${gallery[0].url}" alt=""></div>
      <div class="shot-strip" id="shotStrip">${shots}</div>` : ""}
      <div class="proj-actions">
        <button class="primary" id="btnProjInstall">安装到 ${CAT_LABEL[marketType] || "本地"}</button>
      </div>
    </div>`;
  $("#btnProjInstall").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "安装中…";
    await installMarketId(hit, e.target);
    e.target.disabled = false;
    e.target.textContent = "安装";
  };
  $$(".shot-thumb").forEach((img) => {
    img.onclick = () => {
      $("#shotMain").src = img.src;
      $$(".shot-thumb").forEach((x) => x.classList.remove("active"));
      img.classList.add("active");
    };
  });
}

async function installMarketId(hit, btn) {
  const res = await post("/api/modrinth/install", {
    id: hit.id, type: marketType,
    mc: $("#marketMc").value.trim(),
    loader: $("#marketLoader").hidden ? "" : $("#marketLoader").value,
    slug: hit.slug,
    world: $("#marketWorld").hidden ? "" : $("#marketWorld").value,
  });
  if (!res.ok) {
    uiAlert("安装失败", res.error);
    return;
  }
  setStatus(`已安装：${res.folder ? res.folder + "/" : ""}${(res.path || res.instance || "").split(/[\\/]/).pop()}`, "ok");
}

function updateMarketFoot(q) {
  const foot = $("#marketFoot");
  if (!foot) return;
  if (marketOffset >= marketTotal || marketOffset >= MARKET_CAP) {
    foot.textContent = `共 ${marketOffset} 个${q ? "（搜索结果）" : "（按下载量排序）"}`;
  } else {
    foot.innerHTML = `已加载 ${marketOffset} / ${marketTotal} · <a href="#" id="marketMore">加载更多</a>`;
    $("#marketMore").onclick = (e) => { e.preventDefault(); loadMarket(false); };
  }
}

async function installMarket(hit, btn) {
  btn.disabled = true;
  btn.textContent = "安装中…";
  const res = await post("/api/modrinth/install", {
    id: hit.id, type: marketType,
    mc: $("#marketMc").value.trim(),
    loader: $("#marketLoader").hidden ? "" : $("#marketLoader").value,
    slug: hit.slug,
    world: $("#marketWorld").hidden ? "" : $("#marketWorld").value,
  });
  btn.disabled = false;
  btn.textContent = "安装";
  if (!res.ok) {
    uiAlert("安装失败", res.error);
    return;
  }
  if (marketType === "modpack") {
    setStatus(`整合包已解包：${res.versionId}（${res.game}${res.loader ? " / " + res.loader : ""}）`, "ok");
    loadVersions();
  } else {
    setStatus(`已放入 ${res.folder}/：${res.path.split(/[\\/]/).pop()}`, "ok");
  }
}

function fmtNum(n) {
  if (!n && n !== 0) return "?";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/* ------------------------------------------------------------------ launch & diagnosis */
function fillLaunchVersions() {
  // 启动页自己有版本列表，这里只需要保证下拉存在时能填（旧位置已移除）
  const sel = $("#launchVersion");
  if (!sel) return;
  const installed = (state.versions || []).filter((v) => v.installed || v.json_only);
  const keep = sel.value;
  sel.innerHTML = installed.length
    ? installed.map((v) => `<option value="${v.id}">${v.id}${v.installed ? "" : "（缺客户端）"}</option>`).join("")
    : '<option value="">还没有安装版本</option>';
  if (keep && installed.some((v) => v.id === keep)) sel.value = keep;
}

function setLaunchStatus(text) {
  const el = $("#launchStatus");
  if (el) el.textContent = text;
  setStatus(text, "busy");
}

function renderDiagnosis(d) {
  const box = $("#diagnosis");
  if (!box) return; // 诊断结果现在主要显示在灵动岛上
  const head = d.crashed
    ? `<span class="badge err">检测到崩溃</span>`
    : `<span class="badge ok">没有检测到崩溃</span>`;
  const hits = (d.hits || []).map((h) => `
    <div class="diag-item">
      <div class="diag-title">${h.title}</div>
      <div class="diag-match">命中：${h.match}</div>
      <div class="diag-advice">${h.advice}</div>
    </div>`).join("");
  box.innerHTML = `
    <div class="diag-head">${head}<span class="muted">版本 ${d.version} · ${new Date((d.when || 0) * 1000).toLocaleTimeString("zh-CN", { hour12: false })}${d.exited !== null && d.exited !== undefined ? " · 退出码 " + d.exited : ""}</span></div>
    ${hits || '<div class="muted" style="margin:10px 0">日志里没有匹配到已知问题。</div>'}
    <details class="diag-log"><summary>看日志最后一段</summary><pre>${(d.tail || "").replace(/</g, "&lt;")}</pre></details>`;
}

async function startLaunchTest(vidArg) {
  const vid = vidArg || ($("#launchVersion") || {}).value;
  if (!vid) {
    setLaunchStatus("先在「下载」页装一个版本");
    return;
  }
  const meta = (state.versions || []).find((v) => v.id === vid);
  if (meta && !meta.installed) {
    if (await uiConfirm(`${vid} 还没下载客户端`,
      "这个版本现在只有 json，没有 client.jar。\n\n现在下载吗？下载完再点一次「启动游戏」就直接开。",
      "现在下载")) {
      await post("/api/version/download", { id: vid, assets: true });
      notifyIsland("activity");
      setLaunchStatus("正在下载 " + vid + "…");
      startPolling();
    } else {
      setLaunchStatus("这个版本缺客户端，先在「下载」页点「安装」补全");
    }
    return;
  }
  const mem = parseInt(localStorage.getItem("mem") || "4096", 10);
  const user = localStorage.getItem("username") || "Steve";
  const box = $("#diagnosis");
  if (box) box.innerHTML = "";
  setLaunchStatus("启动中…");
  const res = await post("/api/launch", { id: vid, memory: mem, username: user });
  if (!res.ok) {
    setLaunchStatus("启动失败：" + res.error);
    return;
  }
  setLaunchStatus(`已启动（PID ${res.pid}），15 秒后自动诊断…`);
  notifyIsland("launched");
  startPolling();
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    try {
      const d = await api("/api/diagnosis");
      if (d.diagnosis) {
        clearInterval(timer);
        renderDiagnosis(d.diagnosis);
        setStatus(d.diagnosis.crashed ? "启动后检测到问题，看灵动岛" : "游戏已启动，运行正常", d.diagnosis.crashed ? "err" : "ok");
      } else if (tries > 25) {
        clearInterval(timer);
      }
    } catch (e) { /* ignore */ }
  }, 2000);
}

async function analyzeLatestNow() {
  const res = await post("/api/logs/analyze", {});
  if (!res.hits.length) {
    setStatus("日志里没匹配到已知问题", "ok");
    return;
  }
  renderDiagnosis({ version: "-", when: Date.now() / 1000, crashed: true, hits: res.hits, tail: "" });
  setStatus(`命中 ${res.hits.length} 条问题`, "err");
}





/* ------------------------------------------------------------------ update */
const SKIP_KEY = "skipVersion";

async function checkUpdate(silent) {
  let res;
  try {
    res = await post("/api/update/check", {});
  } catch (e) {
    if (!silent) setStatus("检查更新失败：" + e.message, "err");
    return null;
  }
  if (!res || !res.ok) {
    if (!silent && res) setStatus(res.error || "检查更新失败", "err");
    return res;
  }
  const skipped = localStorage.getItem(SKIP_KEY);
  if (res.hasUpdate && skipped !== res.latest) {
    showUpdateDialog(res);
  } else if (!silent) {
    setStatus(res.hasUpdate ? `已跳过 ${res.latest}，当前 ${res.current}` : `已是最新版 ${res.current}`, "ok");
  }
  return res;
}

function showUpdateDialog(u) {
  const wrap = document.createElement("div");
  wrap.className = "modal ui-modal";
  wrap.innerHTML = `
    <div class="modal-box ui-dialog upd-dialog">
      <div class="modal-head"><b>发现新版本</b><button class="ghost tiny" data-x>×</button></div>
      <div class="modal-body">
        <div class="upd-head">
          <span class="upd-badge">新</span>
          <div>
            <div class="upd-ver">${u.latest}</div>
            <div class="muted">当前版本 ${u.current}${u.published ? " · 发布于 " + u.published.slice(0, 10) : ""}</div>
          </div>
        </div>
        ${u.notes ? `<div class="upd-notes">${escapeHtml(u.notes)}</div>` : ""}
        ${u.asset ? `<div class="upd-file">安装包：${u.asset.name} · ${(u.asset.size / 1048576).toFixed(1)} MB</div>` : `<div class="upd-file">这个版本没有可下载的 exe，去发布页看看。</div>`}
        <div class="row-gap" style="justify-content:flex-end;margin-top:16px">
          <button class="ghost" data-act="skip">跳过这个版本</button>
          <button class="ghost" data-act="later">以后再说</button>
          ${u.asset ? `<button class="primary" data-act="download">下载并安装</button>` : `<button class="primary" data-act="page">打开发布页</button>`}
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector("[data-x]").onclick = close;
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

  wrap.querySelector('[data-act="later"]').onclick = close;
  wrap.querySelector('[data-act="skip"]').onclick = () => {
    localStorage.setItem(SKIP_KEY, u.latest);
    setStatus(`已跳过 ${u.latest}`, "ok");
    close();
  };
  const dl = wrap.querySelector('[data-act="download"]');
  if (dl) {
    dl.onclick = async () => {
      dl.disabled = true;
      dl.textContent = "下载中…";
      const r = await post("/api/update/download", { url: u.asset.url, name: u.asset.name });
      if (r.ok) {
        dl.textContent = "已开始安装";
        setStatus("新版本已下载，安装程序已启动", "ok");
        setTimeout(close, 1500);
      } else {
        dl.disabled = false;
        dl.textContent = "下载并安装";
        await uiAlert("下载失败", r.error || "");
      }
    };
  }
  const page = wrap.querySelector('[data-act="page"]');
  if (page) page.onclick = () => { if (u.page) window.open(u.page, "_blank"); close(); };
}

function escapeHtml(t) {
  return String(t || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

/* ------------------------------------------------------------------ code palette (F5) */
const SNIPPETS = [
  // 常用
  { id: "main", cat: "常用", name: "main 方法", desc: "程序入口", code: "public static void main(String[] args) {\n    {{c}}\n}" },
  { id: "print", cat: "常用", name: "打印输出", desc: "System.out.println", code: "System.out.println({{c}});" },
  { id: "ifelse", cat: "常用", name: "if / else", desc: "条件判断", code: "if ({{c}}) {\n    \n} else {\n    \n}" },
  { id: "for", cat: "常用", name: "for 循环", desc: "从 0 到 n", code: "for (int i = 0; i < {{c}}; i++) {\n    \n}" },
  { id: "foreach", cat: "常用", name: "for-each", desc: "遍历集合", code: "for (var item : {{c}}) {\n    \n}" },
  { id: "while", cat: "常用", name: "while 循环", desc: "条件循环", code: "while ({{c}}) {\n    \n}" },
  { id: "try", cat: "常用", name: "try / catch", desc: "异常处理 + 打印堆栈", code: "try {\n    {{c}}\n} catch (Exception e) {\n    e.printStackTrace();\n}" },
  { id: "switch", cat: "常用", name: "switch 表达式", desc: "Java 14+ 箭头写法", code: "String result = switch ({{c}}) {\n    case 1 -> \"一\";\n    case 2 -> \"二\";\n    default -> \"其他\";\n};" },

  // 类与对象
  { id: "class", cat: "类与对象", name: "类骨架", desc: "字段 + 构造 + 方法", code: "public class {{c}} {\n    private final String name;\n\n    public {{c}}(String name) {\n        this.name = name;\n    }\n\n    public String getName() {\n        return name;\n    }\n}" },
  { id: "record", cat: "类与对象", name: "record", desc: "不可变数据类", code: "public record {{c}}(int x, int y) {\n    public int sum() {\n        return x + y;\n    }\n}" },
  { id: "interface", cat: "类与对象", name: "接口 + 实现", desc: "interface / implements", code: "public interface {{c}} {\n    void run();\n}\n\nclass Impl implements {{c}} {\n    @Override\n    public void run() {\n        \n    }\n}" },
  { id: "enum", cat: "类与对象", name: "枚举", desc: "带字段的枚举", code: "public enum {{c}} {\n    A(1), B(2);\n\n    private final int value;\n\n    {{c}}(int value) {\n        this.value = value;\n    }\n\n    public int value() {\n        return value;\n    }\n}" },
  { id: "override", cat: "类与对象", name: "重写方法", desc: "@Override + super", code: "@Override\npublic {{c}}() {\n    super();\n}" },

  // 集合与字符串
  { id: "list", cat: "集合与字符串", name: "ArrayList", desc: "建列表 + 添加 + 遍历", code: "List<String> list = new ArrayList<>();\nlist.add({{c}});\nfor (String s : list) {\n    System.out.println(s);\n}" },
  { id: "map", cat: "集合与字符串", name: "HashMap 遍历", desc: "entrySet 遍历", code: "Map<String, Integer> map = new HashMap<>();\nmap.put({{c}}, 1);\nfor (Map.Entry<String, Integer> e : map.entrySet()) {\n    System.out.println(e.getKey() + \" = \" + e.getValue());\n}" },
  { id: "stream", cat: "集合与字符串", name: "Stream 过滤", desc: "filter + collect", code: "List<String> result = list.stream()\n        .filter(s -> s.contains({{c}}))\n        .collect(Collectors.toList());" },
  { id: "format", cat: "集合与字符串", name: "字符串格式化", desc: "String.format", code: "String s = String.format(\"%s: %d\", {{c}}, 0);" },
  { id: "sb", cat: "集合与字符串", name: "StringBuilder 拼接", desc: "循环拼接", code: "StringBuilder sb = new StringBuilder();\nfor (String s : {{c}}) {\n    sb.append(s).append('\\n');\n}\nString out = sb.toString();" },

  // 文件与网络
  { id: "readfile", cat: "文件与网络", name: "读文本文件", desc: "Files.readString", code: "Path path = Path.of({{c}});\nString text = Files.readString(path);" },
  { id: "writefile", cat: "文件与网络", name: "写文本文件", desc: "Files.writeString", code: "Path path = Path.of({{c}});\nFiles.writeString(path, \"内容\", StandardCharsets.UTF_8);" },
  { id: "readlines", cat: "文件与网络", name: "逐行读取", desc: "BufferedReader", code: "try (BufferedReader r = Files.newBufferedReader(Path.of({{c}}))) {\n    String line;\n    while ((line = r.readLine()) != null) {\n        System.out.println(line);\n    }\n}" },
  { id: "http", cat: "文件与网络", name: "HTTP GET", desc: "java.net.http 请求", code: "HttpClient client = HttpClient.newHttpClient();\nHttpRequest req = HttpRequest.newBuilder(URI.create({{c}})).GET().build();\nHttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());\nSystem.out.println(res.statusCode() + \" \" + res.body());" },

  // Minecraft
  { id: "block", cat: "Minecraft", name: "方块类", desc: "Block 子类 + 属性", code: "public class {{c}} extends Block {\n    public {{c}}() {\n        super(Properties.of()\n                .setId(ResourceKey.create(Registries.BLOCK, Identifier.fromNamespaceAndPath(\"mymod\", \"{{c}}\")))\n                .strength(3.0f, 6.0f)\n                .requiresCorrectToolForDrops());\n    }\n}" },
  { id: "item", cat: "Minecraft", name: "物品类", desc: "Item 子类", code: "public class {{c}} extends Item {\n    public {{c}}() {\n        super(new Item.Properties().stacksTo(16));\n    }\n}" },
  { id: "blockentity", cat: "Minecraft", name: "BlockEntity 骨架", desc: "含保存/加载", code: "public class {{c}} extends BlockEntity {\n    private int count = 0;\n\n    public {{c}}(BlockPos pos, BlockState state) {\n        super(ModBlockEntities.{{c}}.get(), pos, state);\n    }\n\n    @Override\n    protected void saveAdditional(ValueOutput out) {\n        super.saveAdditional(out);\n        out.putInt(\"count\", count);\n    }\n\n    @Override\n    protected void loadAdditional(ValueInput in) {\n        super.loadAdditional(in);\n        count = in.getIntOr(\"count\", 0);\n    }\n}" },
  { id: "forgeevent", cat: "Minecraft", name: "Forge 事件订阅", desc: "@SubscribeEvent 方法", code: "@SubscribeEvent\npublic static void on{{c}}(PlayerEvent.PlayerLoggedInEvent event) {\n    System.out.println(\"玩家登录：\" + event.getEntity().getName().getString());\n}" },
  { id: "deferred", cat: "Minecraft", name: "DeferredRegister", desc: "注册方块/物品", code: "public static final DeferredRegister.Blocks BLOCKS =\n        DeferredRegister.createBlocks(\"{{c}}\");\n\npublic static final DeferredBlock<Block> EXAMPLE = BLOCKS.register(\"example\",\n        () -> new Block(BlockBehaviour.Properties.of().setId(ResourceKey.create(\n                Registries.BLOCK, Identifier.fromNamespaceAndPath(\"{{c}}\", \"example\")))));" },

  // Fabric
  { id: "fabricentry", cat: "Fabric", name: "Fabric 入口", desc: "ModInitializer", code: "public class {{c}} implements ModInitializer {\n    public static final String MOD_ID = \"{{c}}\";\n\n    @Override\n    public void onInitialize() {\n        Registry.register(Registries.BLOCK, Identifier.of(MOD_ID, \"example\"), BLOCK);\n    }\n}" },
  { id: "fabricblock", cat: "Fabric", name: "Fabric 注册方块", desc: "Registry.register", code: "public static final Block EXAMPLE = new Block(AbstractBlock.Settings.create().strength(3.0f));" },

  // Forge
  { id: "forge_main", cat: "Forge", name: "模组主类 @Mod", desc: "Forge 入口 + 事件总线", code: "@Mod({{c}})\npublic class MyMod {\n    public MyMod(IEventBus modBus, ModContainer container) {\n        ModBlocks.BLOCKS.register(modBus);\n        modBus.addListener(this::commonSetup);\n    }\n\n    private void commonSetup(final FMLCommonSetupEvent event) {\n        \n    }\n}" },
  { id: "forge_blocks", cat: "Forge", name: "注册方块", desc: "DeferredRegister.Blocks", code: "public static final DeferredRegister.Blocks BLOCKS =\n        DeferredRegister.createBlocks(\"{{c}}\");\n\npublic static final DeferredBlock<Block> EXAMPLE = BLOCKS.register(\"example\",\n        () -> new Block(BlockBehaviour.Properties.of()\n                .setId(ResourceKey.create(Registries.BLOCK,\n                        Identifier.fromNamespaceAndPath(\"{{c}}\", \"example\")))));" },
  { id: "forge_items", cat: "Forge", name: "注册物品", desc: "DeferredRegister.Items", code: "public static final DeferredRegister.Items ITEMS =\n        DeferredRegister.createItems(\"{{c}}\");\n\npublic static final DeferredItem<Item> EXAMPLE = ITEMS.registerSimpleItem(\"example\",\n        new Item.Properties().stacksTo(16));" },
  { id: "forge_event", cat: "Forge", name: "@SubscribeEvent", desc: "监听玩家登录", code: "@SubscribeEvent\npublic static void onPlayerJoin(PlayerEvent.PlayerLoggedInEvent event) {\n    {{c}}\n    System.out.println(\"登录：\" + event.getEntity().getName().getString());\n}" },
  { id: "forge_tab", cat: "Forge", name: "创造模式标签页", desc: "CreativeModeTab", code: "public static final DeferredRegister<CreativeModeTab> TABS =\n        DeferredRegister.create(Registries.CREATIVE_MODE_TAB, \"{{c}}\");\n\npublic static final Supplier<CreativeModeTab> TAB = TABS.register(\"main\",\n        () -> CreativeModeTab.builder()\n                .title(Component.translatable(\"itemGroup.{{c}}\"))\n                .icon(() -> new ItemStack(ModItems.EXAMPLE.get()))\n                .displayItems((params, output) -> output.accept(ModItems.EXAMPLE.get()))\n                .build());" },
  { id: "forge_config", cat: "Forge", name: "配置文件", desc: "ForgeConfigSpec", code: "public static final ForgeConfigSpec.Builder BUILDER = new ForgeConfigSpec.Builder();\npublic static final ForgeConfigSpec.IntValue {{c}} = BUILDER\n        .comment(\"说明写这里\")\n        .defineInRange(\"value\", 10, 1, 100);\npublic static final ForgeConfigSpec SPEC = BUILDER.build();" },

  // NeoForge
  { id: "neo_main", cat: "NeoForge", name: "模组主类 @Mod", desc: "NeoForge 入口", code: "@Mod({{c}})\npublic class MyMod {\n    public MyMod(IEventBus modBus, ModContainer container) {\n        ModBlocks.BLOCKS.register(modBus);\n        modBus.addListener(this::commonSetup);\n    }\n\n    private void commonSetup(final FMLCommonSetupEvent event) {\n        \n    }\n}" },
  { id: "neo_blocks", cat: "NeoForge", name: "注册方块", desc: "DeferredRegister.Blocks", code: "public static final DeferredRegister.Blocks BLOCKS =\n        DeferredRegister.createBlocks(\"{{c}}\");\n\npublic static final DeferredBlock<Block> EXAMPLE = BLOCKS.register(\"example\",\n        () -> new Block(BlockBehaviour.Properties.of()\n                .setId(ResourceKey.create(Registries.BLOCK,\n                        Identifier.fromNamespaceAndPath(\"{{c}}\", \"example\")))));" },
  { id: "neo_items", cat: "NeoForge", name: "注册物品", desc: "DeferredRegister.Items", code: "public static final DeferredRegister.Items ITEMS =\n        DeferredRegister.createItems(\"{{c}}\");\n\npublic static final DeferredItem<Item> EXAMPLE = ITEMS.registerSimpleItem(\"example\",\n        new Item.Properties());" },
  { id: "neo_events", cat: "NeoForge", name: "事件订阅类", desc: "@EventBusSubscriber", code: "@EventBusSubscriber(modid = \"{{c}}\")\npublic class ModEvents {\n    @SubscribeEvent\n    public static void onJoin(PlayerEvent.PlayerLoggedInEvent event) {\n        \n    }\n}" },
  { id: "neo_blockentity", cat: "NeoForge", name: "BlockEntity 注册", desc: "DeferredRegister + Builder", code: "public static final DeferredRegister<BlockEntityType<?>> BLOCK_ENTITIES =\n        DeferredRegister.create(Registries.BLOCK_ENTITY_TYPE, \"{{c}}\");\n\npublic static final Supplier<BlockEntityType<ExampleBlockEntity>> EXAMPLE =\n        BLOCK_ENTITIES.register(\"example\",\n                () -> new BlockEntityType<>(ExampleBlockEntity::new, ModBlocks.EXAMPLE.get()));" },

  // Quilt
  { id: "quilt_entry", cat: "Quilt", name: "Quilt 入口", desc: "QuiltModInitializer", code: "public class {{c}} implements QuiltModInitializer {\n    @Override\n    public void onInitialize(ModContainer mod) {\n        Registry.register(Registries.BLOCK,\n                Identifier.of(\"{{c}}\", \"example\"), BLOCK);\n    }\n}" },
  { id: "quilt_manifest", cat: "Quilt", name: "quilt.mod.json", desc: "Quilt 的模组描述文件", code: "{\n  \"schema_version\": 1,\n  \"quilt_loader\": {\n    \"group\": \"com.example\",\n    \"id\": \"{{c}}\",\n    \"version\": \"1.0.0\",\n    \"metadata\": {\n      \"name\": \"Example Mod\",\n      \"description\": \"说明\"\n    },\n    \"entrypoints\": {\n      \"init\": \"com.example.ExampleMod\"\n    }\n  }\n}" },
  { id: "quilt_register", cat: "Quilt", name: "注册方块/物品", desc: "Registry.register", code: "public static final Block EXAMPLE = new Block(AbstractBlock.Settings.create().strength(3.0f));\n\n// onInitialize 里：\nRegistry.register(Registries.BLOCK, Identifier.of(\"{{c}}\", \"example\"), EXAMPLE);\nRegistry.register(Registries.ITEM, Identifier.of(\"{{c}}\", \"example\"),\n        new BlockItem(EXAMPLE, new Item.Settings()));" },

  // 构建
  { id: "build_forge", cat: "构建", name: "build.gradle · Forge", desc: "ForgeGradle 7", code: "plugins {\n    id 'net.minecraftforge.gradle' version '[7.0,7.2)'\n}\n\nminecraft {\n    mappings channel: 'official', version: '{{c}}'\n}" },
  { id: "build_neo", cat: "构建", name: "build.gradle · NeoForge", desc: "ModDevGradle", code: "plugins {\n    id 'net.neoforged.moddev' version '2.0.78'\n}\n\nneoForge {\n    version = '{{c}}'\n}" },
  { id: "build_fabric", cat: "构建", name: "build.gradle · Fabric", desc: "fabric-loom", code: "plugins {\n    id 'fabric-loom' version '1.7-SNAPSHOT'\n}\n\ndependencies {\n    minecraft \"com.mojang:minecraft:{{c}}\"\n    mappings \"net.fabricmc:yarn:{{c}}+build.1:v2\"\n}" },
  { id: "build_quilt", cat: "构建", name: "build.gradle · Quilt", desc: "quilt-loom", code: "plugins {\n    id 'org.quiltmc.loom' version '1.7-SNAPSHOT'\n}\n\ndependencies {\n    minecraft \"com.mojang:minecraft:{{c}}\"\n    mappings \"org.quiltmc:quilt-mappings:{{c}}+build.1:v2\"\n}" },

  // 调试
  { id: "bench", cat: "调试", name: "计时一段代码", desc: "System.nanoTime", code: "long t0 = System.nanoTime();\n{{c}}\nSystem.out.println(\"耗时 \" + ((System.nanoTime() - t0) / 1_000_000) + \" ms\");" },
  { id: "assert", cat: "调试", name: "断言/输出对象", desc: "打印变量与类型", code: "System.out.println({{c}} + \"  [\" + ({{c}} != null ? {{c}}.getClass().getSimpleName() : \"null\") + \"]\");" },
];

let palState = { open: false, mode: "template", q: "", cat: "全部", idx: 0, list: [], results: [] };

function palCats() {
  const cats = ["全部"];
  for (const s of SNIPPETS) if (!cats.includes(s.cat)) cats.push(s.cat);
  return cats;
}

function palFilter() {
  const q = palState.q.trim().toLowerCase();
  let list = SNIPPETS;
  if (palState.cat !== "全部") list = list.filter((s) => s.cat === palState.cat);
  if (q) {
    list = list.filter((s) =>
      (s.name + " " + s.desc + " " + s.code + " " + s.cat + " " + s.id).toLowerCase().includes(q));
  }
  return list;
}

function palRender() {
  const box = $("#palModal");
  if (!box) return;
  const listEl = box.querySelector("#palList");
  const prevEl = box.querySelector("#palPrev");
  const catsEl = box.querySelector("#palCats");

  catsEl.innerHTML = palCats().map((c) =>
    `<button class="pal-cat${c === palState.cat ? " on" : ""}" data-cat="${c}">${c}</button>`).join("");
  catsEl.querySelectorAll(".pal-cat").forEach((b) => {
    b.onclick = () => { palState.cat = b.dataset.cat; palState.idx = 0; refreshPal(); };
  });

  if (palState.mode === "template") {
    palState.list = palFilter();
    if (!palState.list.length) {
      listEl.innerHTML = `<div class="pal-empty">没有匹配的片段</div>`;
      prevEl.textContent = "";
      return;
    }
    palState.idx = Math.min(palState.idx, palState.list.length - 1);
    listEl.innerHTML = palState.list.map((s, i) => `
      <div class="pal-item${i === palState.idx ? " on" : ""}" data-i="${i}">
        <div class="pal-name">${s.name}${s.desc ? `<span class="pal-desc">${s.desc}</span>` : ""}</div>
        <div class="pal-tag">${s.cat}</div>
      </div>`).join("");
    listEl.querySelectorAll(".pal-item").forEach((el) => {
      el.onmouseenter = () => { palState.idx = +el.dataset.i; refreshPal(); };
      el.onclick = () => { palState.idx = +el.dataset.i; palInsert(); };
    });
    const cur = palState.list[palState.idx];
    prevEl.textContent = cur ? cur.code.replace(/\{\{c\}\}/g, "") : "";
    const on = listEl.querySelector(".pal-item.on");
    if (on) on.scrollIntoView({ block: "nearest" });
  } else {
    const res = palState.results;
    if (!palState.q.trim()) {
      listEl.innerHTML = `<div class="pal-empty">输入两个字符以上，搜索工程里的代码</div>`;
      prevEl.textContent = "";
      return;
    }
    if (!res.length) {
      listEl.innerHTML = `<div class="pal-empty">工程里没搜到“${palState.q}”</div>`;
      prevEl.textContent = "";
      return;
    }
    palState.idx = Math.min(palState.idx, res.length - 1);
    listEl.innerHTML = res.map((r, i) => `
      <div class="pal-item${i === palState.idx ? " on" : ""}" data-i="${i}">
        <div class="pal-name">${r.text}</div>
        <div class="pal-tag">${r.path}:${r.line}</div>
      </div>`).join("");
    listEl.querySelectorAll(".pal-item").forEach((el) => {
      el.onmouseenter = () => { palState.idx = +el.dataset.i; refreshPal(); };
      el.onclick = () => palOpenResult(+el.dataset.i);
    });
    prevEl.textContent = res[palState.idx] ? res[palState.idx].path + " : " + res[palState.idx].line : "";
    const on2 = listEl.querySelector(".pal-item.on");
    if (on2) on2.scrollIntoView({ block: "nearest" });
  }
}

let palTimer = null;
function refreshPal(immediate) {
  if (palState.mode === "project") {
    clearTimeout(palTimer);
    palTimer = setTimeout(async () => {
      const q = palState.q.trim();
      if (q.length < 2) { palState.results = []; palRender(); return; }
      try {
        const r = await api("/api/search?q=" + encodeURIComponent(q));
        palState.results = r.results || [];
      } catch { palState.results = []; }
      palRender();
    }, immediate ? 0 : 220);
  } else {
    palRender();
  }
}

async function palOpenResult(i) {
  const r = palState.results[i];
  if (!r) return;
  closePal();
  await openFile(r.path);
  const ed = $("#editor");
  const lines = ed.value.split("\n");
  let pos = 0;
  for (let k = 0; k < Math.min(r.line - 1, lines.length); k++) pos += lines[k].length + 1;
  ed.focus();
  ed.setSelectionRange(pos, pos + (lines[r.line - 1] || "").length);
  const lh = 21;
  ed.scrollTop = Math.max(0, (r.line - 4) * lh);
  setStatus(`${r.path}:${r.line}`, "ok");
}

function openPal(mode) {
  if (palState.open) { closePal(); return; }
  palState = { open: true, mode: mode || "template", q: "", cat: "全部", idx: 0, list: [], results: [] };

  const wrap = document.createElement("div");
  wrap.className = "pal-modal";
  wrap.id = "palModal";
  wrap.innerHTML = `
    <div class="pal-box">
      <div class="pal-head">
        <div class="pal-tabs">
          <button class="pal-tab on" data-mode="template">代码片段</button>
          <button class="pal-tab" data-mode="project">搜索工程</button>
        </div>
        <input id="palSearch" class="pal-input" placeholder="搜片段：for、HashMap、方块、事件…（F5 开/关）" spellcheck="false" />
        <button class="pal-x" title="关闭">×</button>
      </div>
      <div class="pal-body">
        <div class="pal-side" id="palCats"></div>
        <div class="pal-list" id="palList"></div>
        <pre class="pal-prev" id="palPrev"></pre>
      </div>
      <div class="pal-foot">
        <span>↑↓ 选择 · Enter ${palState.mode === "template" ? "插入到光标处" : "打开文件"} · Esc 关闭</span>
        <button class="pal-insert" id="palInsertBtn">插入</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  palState.open = true;

  const input = wrap.querySelector("#palSearch");
  input.focus();
  input.oninput = () => { palState.q = input.value; palState.idx = 0; refreshPal(); };

  wrap.querySelector(".pal-x").onclick = closePal;
  wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) closePal(); });

  wrap.querySelectorAll(".pal-tab").forEach((t) => {
    t.onclick = () => {
      palState.mode = t.dataset.mode;
      palState.idx = 0;
      palState.results = [];
      wrap.querySelectorAll(".pal-tab").forEach((x) => x.classList.toggle("on", x === t));
      wrap.querySelector(".pal-insert").style.display = palState.mode === "template" ? "" : "none";
      wrap.querySelector(".pal-foot span").textContent =
        palState.mode === "template" ? "↑↓ 选择 · Enter 插入到光标处 · Esc 关闭" : "↑↓ 选择 · Enter 打开文件 · Esc 关闭";
      refreshPal(true);
    };
  });

  wrap.querySelector("#palInsertBtn").onclick = palInsert;
  palRender();
}

function closePal() {
  const box = $("#palModal");
  if (box) box.remove();
  palState.open = false;
}

function palInsert() {
  if (palState.mode === "project") { palOpenResult(palState.idx); return; }
  const s = palState.list[palState.idx];
  if (!s) return;
  const ed = $("#editor");
  if (!ed) return;

  const before = ed.value.slice(0, ed.selectionStart);
  const after = ed.value.slice(ed.selectionEnd);
  const lineStart = before.lastIndexOf("\n") + 1;
  const indentMatch = before.slice(lineStart).match(/^[ \t]*/);
  const indent = indentMatch ? indentMatch[0] : "";

  const marker = "{{c}}";
  const rawLines = s.code.split("\n");
  const outLines = [];
  let pos = 0;
  let caret = null;

  for (let i = 0; i < rawLines.length; i++) {
    const hasMarkerHere = rawLines[i].includes(marker);
    const colInRaw = hasMarkerHere ? rawLines[i].indexOf(marker) : -1;
    let line = rawLines[i].replace(/\{\{c\}\}/g, "");
    if (i > 0 && line.length > 0) line = indent + line;
    if (hasMarkerHere) {
      caret = pos + (i > 0 && outLines.length ? 0 : 0) + line.length - (rawLines[i].replace(/\{\{c\}\}/g, "").length - colInRaw) * 0;
      // 光标 = 本行起始 + 该行内 marker 之前的字符数
      const beforeInLine = rawLines[i].slice(0, colInRaw).replace(/\{\{c\}\}/g, "");
      caret = pos + beforeInLine.length + (i > 0 && line.length !== rawLines[i].replace(/\{\{c\}\}/g, "").length ? indent.length : 0);
    }
    outLines.push(line);
    pos += line.length + 1;
  }

  const text = outLines.join("\n");
  ed.value = before + text + after;

  const finalCaret = caret === null ? before.length + text.length : before.length + caret;
  ed.focus();
  ed.setSelectionRange(finalCaret, finalCaret);
  ed.dispatchEvent(new Event("input", { bubbles: true }));
  state.dirty = true;
  closePal();
  setStatus("已插入片段：" + s.name, "ok");
}

document.addEventListener("keydown", (e) => {
  if (e.key === "F5") {
    e.preventDefault();
    const codePage = document.querySelector("#page-code");
    if (codePage && codePage.classList.contains("active")) openPal();
    return;
  }
  if (!palState.open) return;
  const box = $("#palModal");
  if (e.key === "Escape") { e.preventDefault(); closePal(); return; }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const n = palState.mode === "template" ? palState.list.length : palState.results.length;
    if (n) { palState.idx = (palState.idx + 1) % n; refreshPal(true); }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    const n = palState.mode === "template" ? palState.list.length : palState.results.length;
    if (n) { palState.idx = (palState.idx - 1 + n) % n; refreshPal(true); }
  } else if (e.key === "Enter") {
    e.preventDefault();
    palInsert();
  }
});


/* ------------------------------------------------------------------ 联机页 */
let lanTimer = null;
let lanBound = false;

function fmtPortInfo(r) {
  if (!r || !r.port) return `<div class="empty">还没抓到端口，先去游戏里「对局域网开放」</div>`;
  const lan = r.lan || `本机:${r.port}`;
  return `
    <div class="lan-row"><span class="lan-k">端口</span><b>${r.port}</b></div>
    <div class="lan-row"><span class="lan-k">局域网地址</span><code>${lan}</code>
      <button class="ghost tiny" data-copy="${lan}">复制</button></div>
    <div class="lan-row"><span class="lan-k">本机 IP</span><code>${(r.ips || []).join(" / ") || "-"}</code></div>
    <div class="muted" style="margin-top:8px;font-size:11.5px">同一个 Wi-Fi 下，朋友在「加入」里填上面的地址就能进。</div>`;
}

async function refreshLanHost() {
  const box = $("#lanHostInfo");
  if (!box) return;
  const vid = (state && state.selected) || "";
  const r = await get(`/api/lan/info?vid=${encodeURIComponent(vid)}`);
  box.innerHTML = fmtPortInfo(r);
  box.querySelectorAll("[data-copy]").forEach((b) => {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); setStatus("地址已复制", "ok"); }
      catch { setStatus("复制失败", "err"); }
    };
  });
  return r;
}

function renderWorlds(worlds) {
  const box = $("#lanWorlds");
  const list = (worlds || []).filter((w) => !w.error && w.port);
  if (!list.length) {
    box.innerHTML = `<div class="empty">没有扫到局域网世界（朋友要先「对局域网开放」）</div>`;
    return;
  }
  box.innerHTML = list.map((w) => `
    <button class="lan-world" data-addr="${w.host}:${w.port}">
      <b>${escapeHtml(w.motd || "未命名世界")}</b>
      <span>${w.host}:${w.port}</span>
    </button>`).join("");
  box.querySelectorAll(".lan-world").forEach((b) => {
    b.onclick = () => {
      $("#lanAddr").value = b.dataset.addr;
      setStatus("已填入地址，点「加入」", "ok");
    };
  });
}

async function lanJoin() {
  const addr = ($("#lanAddr").value || "").trim();
  if (!addr) { await uiAlert("地址是空的", "填一个 主机:端口，比如 192.168.1.5:25565。"); return; }
  const r = await post("/api/lan/join", { addr });
  if (!r.ok) { setStatus(r.error || "加入失败", "err"); return; }
  setStatus(`正在连 ${addr}…`, "ok");
  const vid = (state && state.selected) || "";
  await post("/api/launch", { id: vid, memory: (state && state.memory) || 4096 });
}

async function lanHost() {
  const vid = (state && state.selected) || "";
  if (!vid) { await uiAlert("先选个版本", "在启动页左边选一个 Minecraft 版本。"); return; }
  setStatus("正在启动游戏，进去后 Esc → 对局域网开放", "ok");
  await post("/api/launch", { id: vid, memory: (state && state.memory) || 4096 });
  if (lanTimer) clearInterval(lanTimer);
  lanTimer = setInterval(refreshLanHost, 3000);
}

function bindLanPage() {
  if (lanBound) return;
  lanBound = true;
  $("#btnLanHost").onclick = lanHost;
  $("#btnLanRefresh").onclick = async () => { const r = await refreshLanHost(); setStatus(r && r.port ? "端口 " + r.port : "还没抓到端口", r && r.port ? "ok" : "err"); };
  $("#btnLanJoin").onclick = lanJoin;
  $("#btnLanScan").onclick = async () => {
    const msg = $("#lanScanMsg");
    msg.textContent = "扫描中…";
    const r = await get("/api/lan/scan");
    const n = ((r.worlds || []).filter((w) => w.port)).length;
    msg.textContent = n ? `找到 ${n} 个` : "没找到";
    renderWorlds(r.worlds);
  };
  $("#btnLanUpnp").onclick = async () => {
    const msg = $("#lanUpnpMsg");
    const info = await get(`/api/lan/info?vid=${encodeURIComponent((state && state.selected) || "")}`);
    if (!info.port) { msg.textContent = "先开房拿到端口"; return; }
    msg.textContent = "正在请求路由器…";
    const r = await post("/api/lan/upnp", { port: info.port });
    if (r.ok) {
      msg.innerHTML = `公网地址：<code>${r.externalIp || "?"}:${r.port}</code>（朋友直接连这个）`;
    } else {
      msg.textContent = r.error || "映射失败";
    }
  };
  $("#btnInstallRedstone").onclick = async () => {
    const msg = $("#lanExtraMsg");
    msg.textContent = "正在 Modrinth 上找…";
    const r = await post("/api/mods/install-online", { query: "redstoneonline", vid: (state && state.selected) || "" });
    if (r.ok) {
      msg.innerHTML = `已装好：<b>${escapeHtml(r.name || "")}</b> ${escapeHtml(r.version || "")} → mods 目录，进游戏后在多人游戏里用房号`;
    } else {
      msg.textContent = r.error || "没装成";
    }
  };
  $("#btnOpenTerracotta").onclick = () => { post("/api/open", { path: "https://github.com/burningtnt/Terracotta" }); };
}

/* 版本号写进标题栏 */
async function showAppVersion() {
  try {
    const s = await get("/api/state");
    const el = $("#appVer");
    if (el) el.textContent = "v" + (s.version || "?");
  } catch {}
}

/* ------------------------------------------------------------------ bbmodel 转换 */
let bbContent = "";

async function convertBbmodel() {
  const path = ($("#bbPath").value || "").trim();
  const modid = ($("#bbModid").value || "mymod").trim() || "mymod";
  const kind = $("#bbKind").value || "block";
  let name = ($("#bbName").value || "").trim();

  if (!bbContent && !path) {
    await uiAlert("还没有模型", "点「选文件…」选一个 .bbmodel，或者把完整路径粘到输入框里。");
    return;
  }
  if (!name) {
    const src = path || "model.bbmodel";
    name = src.split(/[\\/]/).pop().replace(/\.bbmodel$/i, "");
  }

  const box = $("#bbResult");
  box.innerHTML = `<div class="empty">转换中…</div>`;

  const applySkin = !!($("#bbApplySkin") && $("#bbApplySkin").checked);
  const payload = { modid, name, kind, applySkin };
  if (bbContent) payload.content = bbContent; else payload.path = path;

  let r;
  try { r = await post("/api/bbmodel/convert", payload); }
  catch (e) { box.innerHTML = `<div class="empty">请求失败：${e.message}</div>`; return; }

  if (!r.ok) {
    box.innerHTML = `<div class="empty">转换失败：${escapeHtml(r.error || "未知错误")}</div>`;
    return;
  }

  const files = (r.files || []).map((f) => `<li>${f}</li>`).join("");
  const warns = (r.warnings || []).length
    ? `<div class="bb-warn"><b>注意（${r.warnings.length}）</b><ul>${r.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`
    : "";
  const disp = (r.display || []).join(" · ");

  const kindName = r.kind === "entity" ? "实体模型" : r.kind === "skin" ? "玩家皮肤" : "方块/物品";
  box.innerHTML = `
    <div class="bb-sum">
      <span class="badge ok">转换成功</span>
      <span class="badge off">${kindName}</span>
      <span class="muted">${r.elements} 个${r.kind === "entity" ? "骨骼" : "元素"} · ${r.textures} 张贴图 · ${(r.files || []).length} 个文件</span>
    </div>
    <div class="muted" style="margin:8px 0 4px">手持 / 地面 / GUI 变换：${disp || "（无）"}</div>
    <ul class="bb-files">${files}</ul>
    ${warns}
    <div class="muted" style="margin:10px 0 4px">注册代码（复制到你的 ModBlocks / ModItems）</div>
    <pre class="bb-code" id="bbSnippet">${escapeHtml(r.snippet || "")}</pre>
    <div class="row-gap" style="margin-top:10px">
      <button class="ghost" id="bbCopy">复制注册代码</button>
      <button class="ghost" id="bbOpenDir">打开资源目录</button>
    </div>`;

  $("#bbCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(r.snippet || ""); setStatus("注册代码已复制", "ok"); }
    catch { setStatus("复制失败，手动选一下", "err"); }
  };
  if (r.kind === "skin") {
    const ob = $("#bbOpenDir");
    if (ob) ob.textContent = "去账户页看看";
  }
  $("#bbOpenDir").onclick = () => {
    const dir = (r.files && r.files[0]) ? r.files[0] : "";
    post("/api/open", { path: "" });
    setStatus("已打开工程目录", "ok");
  };

  setStatus(`bbmodel 转换完成：${name}`, "ok");
  await loadProject();
}

$("#bbPick")?.addEventListener("click", () => $("#bbFile").click());
$("#bbFile")?.addEventListener("change", async (e) => {
  const f = (e.target.files || [])[0];
  if (!f) return;
  bbContent = await f.text();
  $("#bbPath").value = f.name;
  if (!$("#bbName").value.trim()) $("#bbName").value = f.name.replace(/\.bbmodel$/i, "");
  setStatus(`已载入 ${f.name}（${Math.round(f.size / 1024)} KB）`, "ok");
  e.target.value = "";
});
$("#btnConvertBb")?.addEventListener("click", convertBbmodel);


/* ------------------------------------------------------------------ appearance */
const ACCENTS = ["#4f8cff", "#37c98b", "#e2a336", "#e4605f", "#a874ff", "#22c3d6", "#ff7ab6"];
let theme = { accent: "#4f8cff", accent2: "#2f6ae0", bg: "#0d1014", bg2: "#161b22",
              bgMode: "solid", fade: 0.35, blur: 0, hasImage: false };

function shade(hex, k) {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * k)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * k)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * k)));
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function luminance(hex) {
  const n = parseInt(String(hex || "#000000").replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function applyTheme(t) {
  theme = Object.assign(theme, t || {});
  const root = document.documentElement;
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-2", theme.accent2 || shade(theme.accent, 0.75));
  root.style.setProperty("--bg", theme.bg);
  root.style.setProperty("--bg-fade", String(theme.fade));
  root.style.setProperty("--bg-blur", theme.blur + "px");
  // 背景越亮，暗化越重，避免浅色把界面冲成一片白
  const lum = luminance(theme.bg);
  const scrim = Math.max(theme.scrim ?? 0.45, lum > 0.55 ? 0.72 : 0.35);
  root.style.setProperty("--scrim", String(scrim));
  // 背景统一交给 html + ::before 绘制，body 保持透明，这样暗化层才压得住
  let layer = "none";
  let fade = theme.fade;
  if (theme.bgMode === "image" && theme.hasImage) {
    layer = `url(/api/theme/bg?v=${Date.now()})`;
  } else if (theme.bgMode === "gradient") {
    layer = `linear-gradient(160deg, ${theme.bg} 0%, ${theme.bg2} 100%)`;
    fade = 1;
  }
  root.style.setProperty("--bg-image", layer);
  root.style.setProperty("--bg-fade", String(fade));
}

async function saveTheme() {
  await post("/api/theme", { theme });
  localStorage.setItem("theme", JSON.stringify(theme));
  setStatus("外观已保存", "ok");
}

async function loadTheme() {
  let t = null;
  try { t = (await api("/api/theme")).theme; } catch (e) { }
  if (!t || !Object.keys(t).length) {
    try { t = JSON.parse(localStorage.getItem("theme") || "{}"); } catch (e) { t = {}; }
  }
  if (t && Object.keys(t).length) applyTheme(t);
}

async function openAppearance() {
  const wrap = document.createElement("div");
  wrap.className = "modal ui-modal";
  wrap.innerHTML = `
    <div class="modal-box ui-dialog" style="width:520px">
      <div class="modal-head"><b>外观设置</b><button class="ghost tiny" data-x>×</button></div>
      <div class="modal-body">
        <div class="acc-sec">
          <div class="acc-title">主题色</div>
          <div class="row-gap">
            <input type="color" id="apAccent" value="${theme.accent}" style="width:44px;height:32px;background:none;border:1px solid var(--line);border-radius:8px" />
            <div class="swatches">
              ${ACCENTS.map((c) => `<button class="swatch${c === theme.accent ? " active" : ""}" data-c="${c}" style="background:${c}"></button>`).join("")}
            </div>
          </div>
        </div>

        <div class="acc-sec">
          <div class="acc-title">背景</div>
          <div class="row-gap" style="margin-bottom:10px">
            <button class="ghost ${theme.bgMode === "solid" ? "on" : ""}" data-mode="solid">纯色</button>
            <button class="ghost ${theme.bgMode === "gradient" ? "on" : ""}" data-mode="gradient">渐变</button>
            <button class="ghost ${theme.bgMode === "image" ? "on" : ""}" data-mode="image">图片</button>
          </div>
          <div id="apSolid" ${theme.bgMode !== "solid" ? "hidden" : ""} class="row-gap">
            <input type="color" id="apBg" value="${theme.bg}" style="width:44px;height:32px;background:none;border:1px solid var(--line);border-radius:8px" />
            <span class="muted">背景底色</span>
          </div>
          <div id="apGrad" ${theme.bgMode !== "gradient" ? "hidden" : ""} class="row-gap">
            <input type="color" id="apBg1" value="${theme.bg}" style="width:44px;height:32px;background:none;border:1px solid var(--line);border-radius:8px" />
            <input type="color" id="apBg2" value="${theme.bg2}" style="width:44px;height:32px;background:none;border:1px solid var(--line);border-radius:8px" />
            <span class="muted">上 → 下</span>
          </div>
          <div id="apImage" ${theme.bgMode !== "image" ? "hidden" : ""}>
            <div class="row-gap" style="margin-bottom:8px">
              <button class="ghost" id="apPickBg">选择图片</button>
              <span class="muted">${theme.hasImage ? "已设置背景图" : "用一张图片做背景"}</span>
            </div>
          </div>
          <label class="field"><span>背景强度</span><input type="range" id="apFade" min="0" max="1" step="0.05" value="${theme.fade}"></label>
          <label class="field"><span>暗化</span><input type="range" id="apScrim" min="0" max="0.9" step="0.05" value="${theme.scrim ?? 0.45}"></label>
          <label class="field" id="apBlurRow" ${theme.bgMode !== "image" ? "hidden" : ""}><span>模糊</span><input type="range" id="apBlur" min="0" max="20" step="1" value="${theme.blur}"></label>
        </div>

        <div class="row-gap" style="justify-content:flex-end;margin-top:14px">
          <button class="ghost" id="apReset">恢复默认</button>
          <button class="primary" id="apSave">保存</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const $q = (sel) => wrap.querySelector(sel);
  const close = () => wrap.remove();
  $q("[data-x]").onclick = close;
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

  const refresh = () => applyTheme(theme);

  $q("#apAccent").oninput = (e) => { theme.accent = e.target.value; theme.accent2 = shade(theme.accent, 0.75); refresh(); };
  wrap.querySelectorAll(".swatch").forEach((b) => {
    b.onclick = () => {
      theme.accent = b.dataset.c;
      theme.accent2 = shade(theme.accent, 0.75);
      $q("#apAccent").value = theme.accent;
      wrap.querySelectorAll(".swatch").forEach((x) => x.classList.toggle("active", x === b));
      refresh();
    };
  });

  wrap.querySelectorAll("[data-mode]").forEach((b) => {
    b.onclick = () => {
      theme.bgMode = b.dataset.mode;
      wrap.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
      $q("#apSolid").hidden = theme.bgMode !== "solid";
      $q("#apGrad").hidden = theme.bgMode !== "gradient";
      $q("#apImage").hidden = theme.bgMode !== "image";
      $q("#apBlurRow").hidden = theme.bgMode !== "image";
      refresh();
    };
  });

  $q("#apBg").oninput = (e) => { theme.bg = e.target.value; refresh(); };
  $q("#apBg1").oninput = (e) => { theme.bg = e.target.value; refresh(); };
  $q("#apBg2").oninput = (e) => { theme.bg2 = e.target.value; refresh(); };
  $q("#apFade").oninput = (e) => { theme.fade = parseFloat(e.target.value); refresh(); };
  $q("#apScrim").oninput = (e) => { theme.scrim = parseFloat(e.target.value); refresh(); };
  $q("#apBlurRow").hidden = theme.bgMode !== "image";
  $q("#apBlur").oninput = (e) => { theme.blur = parseInt(e.target.value, 10); refresh(); };

  const file = document.createElement("input");
  file.type = "file";
  file.accept = "image/*";
  file.onchange = async (e) => {
    const f = (e.target.files || [])[0];
    if (!f) return;
    const r = await fetch("/api/theme/bg", { method: "POST", body: f });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { await uiAlert("背景图没保存", j.error || "未知错误"); return; }
    theme.hasImage = true;
    theme.bgMode = "image";
    setupImageMode();
    refresh();
  };
  $q("#apPickBg").onclick = () => file.click();

  function setupImageMode() {
    wrap.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === "image"));
    $q("#apSolid").hidden = true;
    $q("#apGrad").hidden = true;
    $q("#apImage").hidden = false;
  }

  $q("#apSave").onclick = async () => { await saveTheme(); close(); };
  $q("#apReset").onclick = async () => {
    theme = { accent: "#4f8cff", accent2: "#2f6ae0", bg: "#0d1014", bg2: "#161b22",
              bgMode: "solid", fade: 0.35, blur: 0, hasImage: false };
    document.documentElement.style.setProperty("--bg-image", "none");
    applyTheme(theme);
    await saveTheme();
    close();
  };
}

$("#btnAppearance")?.addEventListener("click", openAppearance);
$("#btnCheckUpdate")?.addEventListener("click", () => checkUpdate(false));

/* ------------------------------------------------------------------ account */
state.account = null;

function drawFace(img, el) {
  el.textContent = "";
  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;
  c.style.cssText = "width:100%;height:100%;border-radius:10px;image-rendering:pixelated";
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 8, 8, 8, 8, 0, 0, 64, 64);
  g.drawImage(img, 40, 8, 8, 8, 0, 0, 64, 64);
  el.appendChild(c);
}

async function refreshAccount() {
  let a;
  try { a = await api("/api/account"); } catch (e) { return; }
  state.account = a;
  const el = $("#userAvatar");
  if (a.skin) {
    const img = new Image();
    img.onload = () => drawFace(img, el);
    img.src = "/api/account/skin?v=" + Date.now();
  } else {
    el.textContent = (a.name || "S").slice(0, 1).toUpperCase();
  }
  if ($("#userName") && document.activeElement !== $("#userName")) $("#userName").value = a.name;
}

async function openAccount() {
  const a = state.account || await api("/api/account");
  const wrap = document.createElement("div");
  wrap.className = "modal ui-modal";
  wrap.innerHTML = `
    <div class="modal-box ui-dialog acc-dialog">
      <div class="modal-head"><b>账户</b><button class="ghost tiny" data-x>×</button></div>
      <div class="modal-body">
        <div class="acc-head">
          <div class="avatar acc-avatar" id="accAvatar">${(a.name || "S").slice(0, 1).toUpperCase()}</div>
          <div>
            <div class="acc-name">${a.name}</div>
            <div class="muted">${a.type === "msa" ? "正版账户（Microsoft）" : a.type === "yggdrasil" ? "外置登录（皮肤站）" : "离线账户"}</div>
          </div>
          <span class="badge ${a.type === "offline" ? "off" : "ok"}">${a.type === "msa" ? "正版" : a.type === "yggdrasil" ? "外置登录" : "离线"}</span>
        </div>

        <div class="acc-sec">
          <div class="acc-title">自定义皮肤</div>
          <div class="row-gap">
            <button class="ghost" id="accSkinPick">选择 PNG 皮肤</button>
            <span class="muted" id="accSkinHint">${a.skin ? "已设置" : "64×64 的 png，头像会立刻变"}</span>
          </div>
          <input type="file" id="accSkinFile" accept="image/png" hidden />
        </div>

        <div class="acc-sec">
          <div class="acc-title">离线账户</div>
          <div class="row-gap">
            <input id="accName" class="input" value="${a.name}" maxlength="16" />
            <button class="ghost" id="accSaveOffline">使用这个名字</button>
          </div>
          <div class="muted">3～16 位，字母数字下划线。离线模式不能进正版服务器。</div>
        </div>

        <div class="acc-sec">
          <div class="acc-title">外置登录（皮肤站）</div>
          <div class="row-gap" style="margin-bottom:8px">
            <input id="accYggUrl" class="input" value="${a.yggServer || "https://littleskin.cn/api/yggdrasil"}" placeholder="认证服务器地址" />
          </div>
          <div class="row-gap" style="margin-bottom:8px">
            <input id="accYggUser" class="input" placeholder="邮箱 / 用户名" />
            <input id="accYggPass" class="input" type="password" placeholder="密码" />
          </div>
          <div class="row-gap">
            <button class="primary" id="accYggLogin">登录皮肤站</button>
            <span class="muted" id="accYggMsg"></span>
          </div>
          <div class="muted">皮肤站的皮肤要在网站上上传（本地上传的只影响启动器头像）。登录后启动游戏，皮肤、披风都会带进游戏。</div>
        </div>

        <div class="acc-sec">
          <div class="acc-title">正版账户</div>
          <div class="row-gap">
            <button class="primary" id="accLoginMs">登录 Microsoft 账户</button>
          </div>
          <div class="muted">会打开微软登录窗口，成功后启动游戏自动用正版身份（带皮肤）。</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.querySelector("[data-x]").onclick = close;
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

  if (a.skin) {
    const img = new Image();
    img.onload = () => drawFace(img, wrap.querySelector("#accAvatar"));
    img.src = "/api/account/skin?v=" + Date.now();
  }

  wrap.querySelector("#accSkinPick").onclick = () => wrap.querySelector("#accSkinFile").click();
  wrap.querySelector("#accSkinFile").onchange = async (e) => {
    const f = (e.target.files || [])[0];
    if (!f) return;
    const r = await fetch("/api/account/skin", { method: "POST", body: f });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { await uiAlert("皮肤没保存", j.error || "未知错误"); return; }
    wrap.querySelector("#accSkinHint").textContent = "已设置";
    await refreshAccount();
    setStatus("皮肤已更新", "ok");
  };

  wrap.querySelector("#accSaveOffline").onclick = async () => {
    const name = wrap.querySelector("#accName").value.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      await uiAlert("名字不合法", "3～16 位，只能用字母、数字、下划线。");
      return;
    }
    const r = await post("/api/account/offline", { name });
    if (r.ok) {
      localStorage.setItem("username", name);
      await refreshAccount();
      await loadLaunch(true);
      setStatus("已切换到离线账户 " + name, "ok");
      close();
    }
  };

  wrap.querySelector("#accYggLogin").onclick = async () => {
    const msg = wrap.querySelector("#accYggMsg");
    const server = wrap.querySelector("#accYggUrl").value.trim();
    const user = wrap.querySelector("#accYggUser").value.trim();
    const pass = wrap.querySelector("#accYggPass").value;
    if (!user || !pass) { msg.textContent = "用户名和密码都要填"; return; }
    msg.textContent = "登录中…";
    const r = await post("/api/yggdrasil/login", { server, username: user, password: pass });
    if (!r.ok) { msg.textContent = r.error || "登录失败"; return; }
    msg.textContent = r.hasInjector ? "登录成功（已挂载 authlib-injector）" : "登录成功（injector 缺失，皮肤可能不生效）";
    await refreshAccount();
    await loadLaunch(true);
    setStatus("外置登录成功：" + r.name, "ok");
    setTimeout(close, 1200);
  };

  wrap.querySelector("#accLoginMs").onclick = () => {
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage("login");
      close();
      setStatus("已打开微软登录窗口，登录完会自动回来", "busy");
    } else {
      uiAlert("只能在桌面版登录", "正版登录需要桌面窗口（CityIDE.exe），浏览器里打不开。");
    }
  };
}

$("#userName")?.addEventListener("focus", () => { if (state.account) $("#userName").value = state.account.name; });
document.querySelector(".user-card")?.addEventListener("click", (e) => {
  if (e.target.id === "userName") return;
  openAccount();
});

/* ------------------------------------------------------------------ launcher */
let launchVer = null;
let launchDetail = null;
let launchSettingsOpen = false;

async function loadLaunch(keep) {
  if (!state.versions || !state.versions.length) await loadVersions();
  const list = (state.versions || []).filter((v) => v.installed || v.json_only).slice(0, 80);
  const box = $("#launchVersions");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没装版本，去「下载」页装一个</div>';
    $("#launchMain").innerHTML = '<div class="empty">先去「下载」页装一个版本</div>';
    return;
  }
  if (!launchVer || !list.some((v) => v.id === launchVer)) {
    launchVer = (list.find((v) => v.installed) || list[0]).id;
    launchSettingsOpen = false;
  }
  list.forEach((v) => {
    const el = document.createElement("div");
    el.className = "ver-item" + (v.id === launchVer ? " active" : "");
    el.innerHTML = `<span class="vi-dot ${v.installed ? "ok" : "warn"}"></span><span class="vi-name">${v.id}</span>`;
    el.onclick = () => { launchVer = v.id; launchSettingsOpen = false; loadLaunch(true); };
    box.appendChild(el);
  });

  await refreshAccount();

  await loadVersionDetail(launchVer);
}

async function loadVersionDetail(vid) {
  vid = vid || launchVer;
  let d;
  try {
    d = await api("/api/version/detail?vid=" + encodeURIComponent(vid));
  } catch (e) {
    $("#launchMain").innerHTML = `<div class="empty">读取版本失败：${e.message}</div>`;
    return;
  }
  if (vid !== launchVer) return; // 选版本切得太快，丢掉旧结果
  launchDetail = d;
  $("#modCount").textContent = d.mods.length || "";
  $("#worldCount").textContent = d.worlds.length || "";

  const mb = $("#launchMods");
  const hint = (d.isolated && d.mods.length === 0 && d.globalMods > 0)
    ? `<div class="mod-hint">版本隔离中，全局 mods 里有 ${d.globalMods} 个 Mod 对这个版本不生效
         <button class="mini-btn wide" id="btnImportGlobal">导入</button></div>`
    : "";
  mb.innerHTML = (d.mods.length ? "" : '<div class="empty">没有 Mod，点上面的 ＋ 加一个</div>') + hint;
  d.mods.slice(0, 40).forEach((m) => {
    const el = document.createElement("div");
    el.className = "ver-item mini mod-row";
    el.title = m.name;
    el.innerHTML = `<span class="vi-name">${m.name.replace(/\.jar$/i, "")}</span>
      <button class="mod-del" title="删除这个 Mod">×</button>`;
    el.onclick = () => { showPage("tools"); $("#jarPath").value = d.modsDir + "\\" + m.name; parseJar(d.modsDir + "\\" + m.name); };
    el.querySelector(".mod-del").onclick = async (e) => {
      e.stopPropagation();
      const ok = await uiConfirm("删除 Mod", `确定删掉 ${m.name} 吗？`, "删除", "取消");
      if (!ok) return;
      const r = await post("/api/mods/delete", { name: m.name, vid: launchVer || "" });
      if (!r.ok) { await uiAlert("删除失败", r.error); return; }
      setStatus("已删除 " + m.name, "ok");
      await loadVersionDetail(launchVer);
    };
    mb.appendChild(el);
  });

  if ($("#btnImportGlobal")) {
    $("#btnImportGlobal").onclick = async () => {
      const r = await post("/api/mods/import-global", { vid: launchVer });
      setStatus(`已导入 ${r.count} 个 Mod${r.skipped ? "（跳过 " + r.skipped + " 个已存在）" : ""}`, "ok");
      await loadVersionDetail(launchVer);
    };
  }

  const wb = $("#launchWorlds");
  wb.innerHTML = d.worlds.length ? "" : '<div class="empty">没有存档</div>';
  d.worlds.forEach((w) => {
    const el = document.createElement("div");
    el.className = "ver-item mini";
    el.textContent = w;
    wb.appendChild(el);
  });

  if (launchSettingsOpen) renderVersionSettings(d); else renderVersionMain(d);
}

function renderVersionMain(d) {
  $("#launchMain").innerHTML = `
    <div class="vm-head">
      <div class="vm-icon">${(d.loader || "原版").slice(0, 1)}</div>
      <div>
        <div class="vm-title">${d.id}</div>
        <div class="muted">${d.loader} · 游戏版本 ${d.gameVersion}${d.hasJar ? "" : " · 缺客户端"}${d.isolated ? ' · <span class="badge ok" style="font-size:10px">版本隔离</span>' : ' · <span class="badge off" style="font-size:10px">目录共用</span>'}</div>
      </div>
    </div>
    <div class="meta-grid">
      <div class="meta"><span>Mod</span><b>${d.mods.length}</b></div>
      <div class="meta"><span>存档</span><b>${d.worlds.length}</b></div>
      <div class="meta"><span>资源包</span><b>${d.resourcepacks.length}</b></div>
      <div class="meta"><span>光影包</span><b>${d.shaderpacks.length}</b></div>
    </div>
    <div class="vm-path"><span class="muted">版本目录</span><code>${d.path}</code></div>
    <div class="row-gap" style="margin-top:16px">
      <button class="primary" id="btnVmLaunch">启动游戏</button>
      <button class="ghost" id="btnVmOpen">打开目录</button>
      <button class="ghost" id="btnVmSettings">版本设置</button>
    </div>`;
  $("#btnVmLaunch").onclick = launchSelected;
  $("#btnVmOpen").onclick = () => post("/api/open", { path: d.path });
  $("#btnVmSettings").onclick = () => { launchSettingsOpen = true; renderVersionSettings(d); };
}

const VSET = [
  ["游戏本体", [["overview", "概览"], ["settings", "设置"], ["modify", "修改"], ["export", "导出"]]],
  ["游戏资源", [["saves", "存档"], ["shots", "截图"], ["mods", "Mod"], ["rp", "资源包"], ["sp", "光影包"], ["schematics", "投影原理图"], ["servers", "服务器"]]],
];
let vsetTab = "overview";

function renderVersionSettings(d) {
  const nav = VSET.map(([group, items]) => `
    <div class="sv-group">${group}</div>
    ${items.map(([key, label]) => `<button class="sv-item${key === vsetTab ? " active" : ""}" data-k="${key}">${label}</button>`).join("")}
  `).join("");
  $("#launchMain").innerHTML = `
    <div class="sv-layout">
      <div class="sv-nav">${nav}<button class="sv-item back" data-k="__back">← 返回</button></div>
      <div class="sv-body" id="svBody"></div>
    </div>`;
  $$(".sv-item").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.k;
      if (k === "__back") { launchSettingsOpen = false; renderVersionMain(d); return; }
      vsetTab = k;
      renderVersionSettings(d);
    };
  });
  renderVsetBody(d);
}

function renderVsetBody(d) {
  const box = $("#svBody");
  const openDir = (path, label) => `<div class="sv-row"><span>${label}</span><code>${path}</code>
      <button class="ghost tiny" onclick="post('/api/open',{path:'${path.replace(/\\/g, "\\\\")}'})">打开</button></div>`;

  if (vsetTab === "overview") {
    box.innerHTML = `
      <h3>概览</h3>
      <div class="sv-row"><span>实例名称</span><b>${d.id}</b></div>
      <div class="sv-row"><span>加载器</span><b>${d.loader}</b></div>
      <div class="sv-row"><span>游戏版本</span><b>${d.gameVersion}</b></div>
      <div class="sv-row"><span>客户端</span><b>${d.hasJar ? "已下载" : "缺 client.jar"}</b></div>
      <div class="sv-row"><span>Java</span><code>${d.java || "未找到"}</code></div>
      <div class="sv-row"><span>Mod 数量</span><b>${d.mods.length}</b></div>
      <div class="sv-row"><span>存档数量</span><b>${d.worlds.length}</b></div>`;
  } else if (vsetTab === "settings") {
    const mem = localStorage.getItem("mem") || String(d.memory || 4096);
    box.innerHTML = `
      <h3>设置</h3>
      <label class="field"><span>玩家名</span><input id="vsUser" class="input" value="${localStorage.getItem("username") || "Steve"}"></label>
      <label class="field"><span>最大内存 (MB)</span><input id="vsMem" class="input" value="${mem}"></label>
      <label class="field"><span>Java 路径</span><input id="vsJava" class="input" value="${d.java || ""}"></label>
      <div class="row-gap"><button class="primary" id="vsSave">保存</button></div>`;
    $("#vsSave").onclick = () => {
      localStorage.setItem("username", $("#vsUser").value);
      localStorage.setItem("mem", $("#vsMem").value);
      setStatus("设置已保存", "ok");
    };
  } else if (vsetTab === "modify") {
    box.innerHTML = `<h3>修改</h3>
      ${openDir(d.path, "版本目录")}
      ${openDir(d.modsDir, "Mod 目录")}
      <div class="sv-row"><span>版本 json</span><code>${d.path}\\${d.id}.json</code>
        <button class="ghost tiny" onclick="post('/api/open',{path:'${d.path.replace(/\\/g, "\\\\")}'})">打开目录</button></div>`;
  } else if (vsetTab === "export") {
    box.innerHTML = `<h3>导出</h3>
      <p class="muted">把 Mod 和 config 打成一个 zip 放到桌面。</p>
      <button class="primary" id="vsExport">导出整合 zip</button>
      <div id="vsExportMsg" class="muted" style="margin-top:10px"></div>`;
    $("#vsExport").onclick = async () => {
      const r = await post("/api/version/export", { vid: d.id });
      $("#vsExportMsg").textContent = r.ok ? `已导出：${r.path}（${r.files} 个文件）` : "导出失败：" + r.error;
    };
  } else if (vsetTab === "saves") {
    box.innerHTML = `<h3>存档</h3>` + (d.worlds.length
      ? d.worlds.map((w) => `<div class="sv-row"><span>${w}</span><code>saves\\${w}</code>
          <button class="ghost tiny" onclick="post('/api/open',{path:''})">打开存档目录</button></div>`).join("")
      : '<div class="empty">没有存档</div>');
  } else if (vsetTab === "shots") {
    box.innerHTML = `<h3>截图</h3>` + (d.screenshots.length
      ? d.screenshots.map((s) => `<div class="sv-row"><span>${s.name}</span><code>screenshots</code></div>`).join("")
      : '<div class="empty">还没有截图</div>');
  } else if (vsetTab === "mods") {
    box.innerHTML = `<h3>Mod（${d.mods.length}）</h3>` + (d.mods.length
      ? d.mods.map((m) => `<div class="sv-row"><span>${m.name}</span><code>${(m.size / 1024).toFixed(0)} KB</code></div>`).join("")
      : '<div class="empty">没有 Mod</div>') + `<div class="row-gap" style="margin-top:10px">
        <button class="ghost" onclick="post('/api/open',{path:''})">打开 mods 目录</button></div>`;
  } else if (vsetTab === "rp") {
    box.innerHTML = `<h3>资源包</h3>` + (d.resourcepacks.length
      ? d.resourcepacks.map((n) => `<div class="sv-row"><span>${n}</span></div>`).join("")
      : '<div class="empty">没有资源包</div>');
  } else if (vsetTab === "sp") {
    box.innerHTML = `<h3>光影包</h3>` + (d.shaderpacks.length
      ? d.shaderpacks.map((n) => `<div class="sv-row"><span>${n}</span></div>`).join("")
      : '<div class="empty">没有光影包</div>');
  } else if (vsetTab === "schematics") {
    box.innerHTML = `<h3>投影原理图</h3>` + (d.schematics.length
      ? d.schematics.map((n) => `<div class="sv-row"><span>${n}</span></div>`).join("")
      : '<div class="empty">没有原理图</div>');
  } else if (vsetTab === "servers") {
    box.innerHTML = `<h3>服务器</h3><div class="sv-row"><span>servers.dat</span>
      <b>${d.hasServers ? "已存在" : "还没有添加过服务器"}</b></div>`;
  }
}

async function launchSelected() {
  if (!launchVer) return;
  const btn = $("#btnLaunchBig");
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "启动中…";
  try {
    await startLaunchTest(launchVer);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ------------------------------------------------------------------ lessons */
let lessonIndex = 0;
let lessonsCache = [];

function escapeHtml(s) {
  return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

async function loadLessons() {
  const data = await api("/api/lessons");
  lessonsCache = data.lessons;
  $("#lessonCount").textContent = data.lessons.length + " 课";
  const box = $("#lessonList");
  box.innerHTML = "";
  data.lessons.forEach((l) => {
    const div = document.createElement("div");
    div.className = "row lesson-row";
    div.innerHTML = `<div class="row-main">
      <div class="row-title">${l.title} ${l.written ? '<span class="badge ok">已写入</span>' : ""}</div>
      <div class="row-sub">${l.summary}</div></div>`;
    div.onclick = () => { lessonIndex = l.index; renderLesson(); };
    box.appendChild(div);
  });
  renderLesson();
}

function renderLesson() {
  const l = lessonsCache[lessonIndex];
  if (!l) return;
  $("#lessonTitle").textContent = l.title;
  $("#lessonBody").innerHTML = `
    <p class="td-purpose">${l.summary}</p>
    <ul class="lesson-points">${l.points.map((p) => `<li>${p}</li>`).join("")}</ul>
    <pre class="code-block">${escapeHtml(l.code)}</pre>
    <div class="row-gap" style="margin-top:12px">
      <button class="primary" id="btnLessonWrite">写入工程</button>
      <button class="ghost" id="btnLessonCompile">写入并编译</button>
      <button class="ghost" id="btnLessonOpen">在代码页打开</button>
    </div>
    <p class="tip">编译会用「构建」页选的 JDK。第 7 课需要 libs 里有反混淆的 MC/Forge jar（构建页可以一键导入）。</p>`;
  $("#btnLessonWrite").onclick = () => writeLesson(false);
  $("#btnLessonCompile").onclick = () => writeLesson(true);
  $("#btnLessonOpen").onclick = () => { showPage("code"); openFile(l.file); };
  $$("#lessonList .lesson-row").forEach((r, i) => r.classList.toggle("active", i === lessonIndex));
}

async function writeLesson(compile) {
  const l = lessonsCache[lessonIndex];
  const res = await post("/api/lessons/write", { index: lessonIndex });
  if (!res.ok) {
    setStatus("写入失败：" + res.error, "err");
    return;
  }
  lessonsCache = res.lessons;
  $("#lessonList").querySelectorAll(".row-title")[lessonIndex]?.insertAdjacentHTML("beforeend", ' <span class="badge ok">已写入</span>');
  setStatus("已写入 " + res.file, "ok");
  if (!compile) return;
  $("#mainClass").value = l.class;
  const r = await post("/api/build/compile", { jdk: $("#compilerSelect").value || undefined });
  if (r.ok) {
    setStatus(`第 ${lessonIndex + 1} 课编译通过（${r.classCount} 个 class）`, "ok");
    uiAlert(`第 ${lessonIndex + 1} 课编译通过`,
      `产物：build/classes/${l.class.replace(/\./g, "/")}.class\n主类：${l.class}\n\n想跑一下就去「构建」页点「运行」。`);
  } else {
    const first = (r.diagnostics || [])[0];
    setStatus("编译失败", "err");
    uiAlert("编译失败", first ? `${first.message}\n${first.hint || ""}` : r.error);
  }
}

/* ------------------------------------------------------------------ tutorial tabs */
function switchTutTab(name) {
  $$("#tutTabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tut === name));
  $("#tut-steps").hidden = name !== "steps";
  $("#tut-lessons").hidden = name !== "lessons";
  if (name === "lessons") loadLessons();
}

/* events */
$("#btnRefreshVersions").addEventListener("click", () => loadVersions(true));
$("#versionSearch").addEventListener("input", renderVersionGroups);
$("#btnCheckMods").addEventListener("click", checkMods);
$("#btnOpenMods").addEventListener("click", () => post("/api/open", { path: "" }));
$("#btnOpenMc").addEventListener("click", () => post("/api/open", { path: "" }));
$("#btnRescanJava").addEventListener("click", loadJava);
$("#btnParseJar").addEventListener("click", () => parseJar());
$("#btnAnalyzeLatest").addEventListener("click", analyzeLatest);
$("#btnAnalyzeText").addEventListener("click", analyzeText);
$("#btnClearConsole").addEventListener("click", () => { consoleLines = []; renderConsole([]); });
$("#btnClearConsole2")?.addEventListener("click", () => { consoleLines = []; renderConsole([]); });
$("#dlAccordion").addEventListener("click", (e) => {
  const head = e.target.closest(".dl-sec-head");
  if (!head) return;
  const sec = head.closest(".dl-section");
  switchCategory(sec.dataset.cat);
});
$$('input[name="loader"]').forEach((r) => r.addEventListener("change", onLoaderChange));
$("#btnStartInstall").addEventListener("click", startInstall);
$("#btnBackList").addEventListener("click", () => {
  $("#vanillaInstall").hidden = true;
  $("#vanillaList").hidden = false;
});
$$("#loaderPicker .lp").forEach((el) => el.addEventListener("click", () => setTimeout(onLoaderChange, 0)));
$("#tutTabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (t) switchTutTab(t.dataset.tut);
});
$("#btnMarketSearch").addEventListener("click", () => loadMarket(true));
$("#marketQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") loadMarket(true); });
$("#marketList")?.addEventListener("scroll", () => {
  const el = $("#marketList");
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 240 && !marketLoading && marketOffset < marketTotal && marketOffset < MARKET_CAP) {
    loadMarket(false);
  }
});
$("#btnLaunchTest")?.addEventListener("click", () => startLaunchTest());

$("#btnLaunchBig").addEventListener("click", launchSelected);
$("#btnGotoLaunch")?.addEventListener("click", () => showPage("launch"));

$("#btnAddMod").addEventListener("click", () => $("#modFile").click());
$("#btnOpenMods2").addEventListener("click", () => {
  const dir = launchDetail ? launchDetail.modsDir : "";
  post("/api/open", { path: dir });
});
$("#modFile").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  setStatus(`正在添加 ${files.length} 个 Mod…`, "busy");
  for (const f of files) {
    try {
      await fetch("/api/mods/upload?name=" + encodeURIComponent(f.name) + "&vid=" + encodeURIComponent(launchVer || ""),
                  { method: "POST", body: f });
    } catch (err) { /* ignore */ }
  }
  e.target.value = "";
  setStatus(`已添加 ${files.length} 个 Mod`, "ok");
  await loadVersionDetail(launchVer);
});
$("#btnVerSettings").addEventListener("click", () => {
  if (!launchDetail) return;
  launchSettingsOpen = true;
  renderVersionSettings(launchDetail);
});
$("#btnVerDelete").addEventListener("click", async () => {
  if (!launchVer) return;
  const ok = await uiConfirm("删除版本 " + launchVer,
    "会把这个版本的目录整个删掉（客户端、这个版本独立放的 mod 都会没）。\n\n确定删除吗？", "删除", "取消");
  if (!ok) return;
  const r = await post("/api/version/delete", { vid: launchVer });
  if (!r.ok) { await uiAlert("删除失败", r.error); return; }
  await loadVersions();
  launchVer = null;
  await loadLaunch(true);
  setStatus("已删除 " + launchVer, "ok");
});
$("#userName").addEventListener("change", (e) => {
  localStorage.setItem("username", e.target.value);
  $("#userAvatar").textContent = (e.target.value || "S").slice(0, 1).toUpperCase();
});

$("#btnCompile").addEventListener("click", compileNow);
$("#btnImportLibs").addEventListener("click", importLibs);
$("#btnPackage").addEventListener("click", packageNow);
$("#btnRun").addEventListener("click", runNow);
$("#btnSaveFile").addEventListener("click", saveFile);

$("#btnDecompile").addEventListener("click", async () => {
  if (!state.openFile) return;
  setStatus("javap 反编译中…", "busy");
  const r = await post("/api/jar/javaprel", { path: state.openFile });
  if (!r.ok) { await uiAlert("反编译失败", r.error || ""); return; }
  $("#editor").value = r.text;
  $("#editorStatus").textContent = "javap 输出（只读）";
  setStatus("反编译完成", "ok");
});
$("#btnNewFile").addEventListener("click", newFile);
$("#btnWriteCode")?.addEventListener("click", writeSampleCode);
$("#btnOpenCode")?.addEventListener("click", () => { showPage("code"); if (state.tutorial?.file) openFile(state.tutorial.file); });
$("#editor")?.addEventListener("input", () => {
  state.dirty = true;
  $("#editorStatus").textContent = "未保存";
});
$("#editor")?.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const el = e.target;
    const start = el.selectionStart;
    el.value = el.value.slice(0, start) + "    " + el.value.slice(el.selectionEnd);
    el.selectionStart = el.selectionEnd = start + 4;
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!$("#page-code").classList.contains("active")) return;
    saveFile();
  }
});
$("#btnTutorialNext").addEventListener("click", tutorialNext);
$("#btnTutorialCancel").addEventListener("click", async () => { await post("/api/tutorial/cancel", {}); refreshTutorial(); });
$("#btnRestartTutorial").addEventListener("click", async () => { await post("/api/tutorial/restart", {}); state.tutorialStep = null; await refreshTutorial(); showPage("tutorial"); switchTutTab("steps"); });
$("#btnRestartTutorial2").addEventListener("click", async () => { await post("/api/tutorial/restart", {}); state.tutorialStep = null; await refreshTutorial(); switchTutTab("steps"); });
$("#btnNewProject").addEventListener("click", async () => {
  const name = await uiPrompt("新建工程", "工程名 / modid（小写英文，如 mymod）", "mymod");
  if (!name) return;
  const template = (await uiConfirm("工程模板",
    "要生成 Minecraft 模组骨架吗？\n\n模组骨架：带 mods.toml，编译需要 libs 里有 MC/Forge jar\nJava 入门：普通 Java 工程，直接能编译运行",
    "模组骨架", "Java 入门")) ? "mod" : "hello";
  const res = await post("/api/project/new", { modid: name, template });
  setStatus("已创建工程：" + res.projectDir, "ok");
  await loadProject();
  await refreshTutorial();
  showPage("code");
  openFile("src/main/java/com/example/Main.java");
});
$("#btnSettings").addEventListener("click", openSettings);
$("#btnMessages").addEventListener("click", () => {
  $("#modalTitle").textContent = "消息记录";
  $("#modalBody").innerHTML = '<div class="msg-list" id="messageLog"></div>' +
    '<div class="row-gap" style="margin-top:10px"><button class="primary" id="btnSelfTest">自检</button></div>' +
    '<div id="selfTestResult" class="msg-list" style="margin-top:8px"></div>';
  document.querySelector(".modal-box").classList.remove("wide");
  $("#modal").hidden = false;
  renderMessages();
  $("#btnSelfTest").addEventListener("click", selfTest);
});

async function selfTest() {
  const box = $("#selfTestResult");
  box.innerHTML = "";
  const checks = [
    ["后端", "/api/state"],
    ["版本清单", "/api/versions"],
    ["Java", "/api/java"],
    ["课程", "/api/lessons"],
    ["libs", "/api/libs/status"],
    ["编译器", "/api/compilers"],
    ["教程", "/api/tutorial"],
    ["Modrinth", "/api/modrinth?q=sodium&type=mod&limit=1"],
  ];
  for (const [name, url] of checks) {
    const t0 = performance.now();
    try {
      const r = await fetch(url);
      const ms = Math.round(performance.now() - t0);
      box.insertAdjacentHTML("beforeend",
        `<div class="msg ${r.ok ? "ok" : "err"}"><span class="msg-time">${ms}ms</span><span>${name}：${r.ok ? "正常" : "HTTP " + r.status}</span></div>`);
    } catch (e) {
      box.insertAdjacentHTML("beforeend",
        `<div class="msg err"><span class="msg-time">-</span><span>${name}：${e.message}</span></div>`);
    }
  }
}
$("#modalClose").addEventListener("click", () => { $("#modal").hidden = true; document.querySelector(".modal-box").classList.remove("wide"); });
$("#errClose")?.addEventListener("click", () => { $("#errBanner").hidden = true; $("#errRetry").hidden = true; });
$("#errRetry")?.addEventListener("click", () => location.reload());

// 后台断开时每 5 秒探一次，恢复后自动重载
setInterval(async () => {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (r.ok && !$("#errBanner").hidden) location.reload();
  } catch (e) {
    if ($("#errBanner").hidden) showOffline("连不上本地服务，正在自动重连…");
  }
}, 5000);
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").hidden = true; document.querySelector(".modal-box").classList.remove("wide"); });

/* ---------------- 自测模式：?autotest=1 ---------------- */
async function runAutotest() {
  const lines = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = async (name, fn) => {
    try {
      await fn();
      lines.push("OK   " + name);
    } catch (e) {
      lines.push("FAIL " + name + " -> " + (e && e.message ? e.message : e));
    }
  };
  await sleep(1200);

  for (const cat of ["vanilla", "mod", "modpack", "datapack", "resourcepack", "shader"]) {
    await check("下载分类 " + cat, async () => { switchCategory(cat); await sleep(120); });
  }
  await check("原版列表", async () => {
    switchCategory("vanilla");
    if (!$("#versionGroups").querySelector(".vrow")) throw new Error("版本列表为空");
  });
  await check("安装页", async () => {
    const v = (state.versions || [])[0];
    openInstall(v);
    if ($("#vanillaInstall").hidden) throw new Error("安装页没打开");
    $("#btnBackList").click();
  });
  for (const tut of ["steps", "lessons"]) {
    await check("教程页签 " + tut, async () => { switchTutTab(tut); await sleep(200); });
  }
  await check("课程列表", async () => { await loadLessons(); if (!lessonsCache.length) throw new Error("课程为空"); });
  await check("打开第 1 课", async () => { lessonIndex = 0; renderLesson(); if (!$("#btnLessonWrite")) throw new Error("按钮没渲染"); });
  await check("代码页", async () => { showPage("code"); await loadProject(); await sleep(200); if (!$("#fileTree").children.length) throw new Error("文件树为空"); });
  await check("打开 Main.java", async () => { await openFile("src/main/java/com/example/Main.java"); if (!$("#editor").value) throw new Error("编辑器为空"); });
  await check("构建页", async () => { showPage("build"); await loadCompilers(); await sleep(200); if (!$("#compilerSelect").options.length) throw new Error("没有编译器"); });
  await check("libs 状态", async () => { await loadLibsStatus(); });
  await check("已装模组", async () => { showPage("versions"); switchCategory("mod", true); await sleep(400); if (!$("#modList")) throw new Error("没有模组列表"); });
  await check("启动页", async () => { showPage("launch"); await sleep(500); if (!$("#launchVersions")) throw new Error("启动页没渲染"); });
  await check("Java 页", async () => { showPage("java"); await loadJava(); await sleep(200); });
  await check("工具页", async () => { showPage("tools"); await sleep(150); });
  await check("Modrinth 搜索", async () => {
    switchCategory("mod");
    $("#marketQuery").value = "sodium";
    await loadMarket(true);
    if (!$("#marketList").querySelector(".market-item")) throw new Error("没有结果卡片");
  });
  await check("编译", async () => {
    showPage("build");
    const r = await post("/api/build/compile", { jdk: $("#compilerSelect").value });
    if (!r.ok) throw new Error("编译失败：" + ((r.diagnostics || [])[0] || {}).message);
  });
  await check("打包 jar", async () => {
    const r = await post("/api/build/jar", { name: "autotest.jar", mainClass: "com.example.Main" });
    if (!r.ok) throw new Error(r.error);
  });

  const ok = lines.filter((l) => l.startsWith("OK")).length;
  try {
    await fetch("/api/autotest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result: `${ok}/${lines.length} passed\n` + lines.join("\n") }),
    });
  } catch (e) { /* ignore */ }
  const bad = lines.length - ok;
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;inset:40px;background:#0b0f14;color:#cfe0f3;z-index:9999;padding:18px;overflow:auto;font:12px/1.6 Consolas,monospace;border:1px solid #2a3646;border-radius:10px";
  box.innerHTML = `<div style="font-size:15px;margin-bottom:10px;color:${bad ? "#ff8b8b" : "#7ee2b0"}">自测：${ok} 通过 / ${bad} 失败</div>` +
    lines.map((l) => `<div style="color:${l.startsWith("OK") ? "#8fd6b0" : "#ff9b9b"}">${l}</div>`).join("");
  document.body.appendChild(box);
}

boot().catch((e) => {
  setStatus("初始化失败：" + e.message, "err");
  console.error(e);
});

showAppVersion();
