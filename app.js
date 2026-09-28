// Listas M3U (+4dBu) — PWA para Safari/iPhone.
// Busca canales en el directorio público de canales gratuitos (iptv-org), PRUEBA cada link reproduciéndolo
// de verdad en un <video> oculto (Safari reproduce HLS nativo, igual que las apps del iPhone) y deja armar
// listas con categorías para exportarlas como .m3u / .m3u8 o publicarlas con un link fijo.
"use strict";

// ---------- utilidades ----------
const $ = (s) => document.querySelector(s);
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (v !== undefined && v !== null && v !== false) n[k] = v;
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
const put = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast("No se pudo guardar (almacenamiento lleno o bloqueado)"); } }
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
const keyOf = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };
const oneLine = (t) => String(t || "").replace(/[\r\n]+/g, " ").trim();
const cleanTitle = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 70);
const safeFile = (t) => (t || "lista").replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/\s+/g, "_").slice(0, 60) || "lista";
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const NATIVE_HLS = !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl");

let toastTimer = null;
function toast(t) {
  const e = $("#toast");
  e.textContent = t; e.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (e.hidden = true), 2400);
}
async function copyText(t, msg = "Copiado") {
  try { await navigator.clipboard.writeText(t); toast(msg); }
  catch { const ta = el("textarea", { value: t }); document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast(msg); }
}
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? "hace un momento" : s < 3600 ? `hace ${Math.floor(s / 60)} min` : s < 86400 ? `hace ${Math.floor(s / 3600)} h` : new Date(ts).toLocaleDateString();
}

// Alto real visible (con teclado abierto) para hojas y reproductor: --alto / --despl
function syncViewport() {
  const v = window.visualViewport;
  document.documentElement.style.setProperty("--alto", (v ? v.height : innerHeight) + "px");
  document.documentElement.style.setProperty("--despl", (v ? v.offsetTop : 0) + "px");
}
if (window.visualViewport) { visualViewport.addEventListener("resize", syncViewport); visualViewport.addEventListener("scroll", syncViewport); }
addEventListener("resize", syncViewport);
syncViewport();

// ---------- datos ----------
// lists: [{ id, name, categories:[], items:[{id,key,name,url,referer,logo,tvgId,group,live,res,verifiedAt,status,why}], gistId, gistFile, link }]
const S = {
  lists: store.get("m3u.lists", null),
  active: store.get("m3u.active", ""),
  settings: { format: "both", ghToken: "", ...store.get("m3u.settings", {}) },
  view: "vSearch", listCat: "*",
  search: null // { query, running, step, tried, failed:[], found:[] }
};
if (!Array.isArray(S.lists) || !S.lists.length) S.lists = [{ id: uid(), name: "Mi lista", categories: [], items: [] }];
if (!S.lists.some((l) => l.id === S.active)) S.active = S.lists[0].id;
const activeList = () => S.lists.find((l) => l.id === S.active) || S.lists[0];
let pubTimer = null;
function save({ republish = true } = {}) {
  store.set("m3u.lists", S.lists);
  store.set("m3u.active", S.active);
  store.set("m3u.settings", S.settings);
  if (republish) {
    clearTimeout(pubTimer);
    pubTimer = setTimeout(() => S.lists.filter((l) => l.link && l.dirty).forEach((l) => publishList(l).catch(() => {})), 2500);
  }
}
const touch = (list) => { list.dirty = true; save(); };
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

// ---------- links: vencimiento y amarre a la red ----------
function tokenExpiry(url) {
  let u; try { u = new URL(url); } catch { return null; }
  const now = Date.now() / 1000, found = [];
  const push = (v) => { const n = Number(v); if (!Number.isFinite(n)) return; const s = n > 1e12 ? n / 1000 : n; if (s > now - 31536000 && s < now + 315360000) found.push(s); };
  let start = null, dur = null;
  for (const [k, v] of u.searchParams) {
    if (/^(exp|expires|expire|expiry|expiration|e|validto|deadline)$/i.test(k)) push(v);
    const n = Number(v);
    if (/^(s|st|start|starttime|iat)$/i.test(k) && n > 1e9) start = n > 1e12 ? n / 1000 : n;
    if (/^(e|exp|expires|duration|validity|ttl)$/i.test(k) && n > 0 && n < 2592000) dur = n;
  }
  if (start && dur) push(start + dur);
  return found.length ? Math.min(...found) * 1000 : null;
}
function networkLock(url) {
  try {
    for (const [k, v] of new URL(url).searchParams) {
      if (/^(asn|isp)$/i.test(k) && /^\d{2,10}$/.test(v)) return "red";
      if (/^(ip|cip|clientip|client_ip|userip)$/i.test(k) && /^[\d.:a-f]{7,}$/i.test(v)) return "ip";
    }
  } catch {}
  return "";
}

// ---------- M3U ----------
// both = VLC + apps IPTV · iptv = CarTV/Kodi (url|Referer=…) · vlc = solo VLC
function m3uEntry(it, group, format) {
  const q = (v) => oneLine(v).replace(/"/g, "'");
  const ua = navigator.userAgent;
  let a = ` tvg-name="${q(it.name)}"`;
  if (it.tvgId) a += ` tvg-id="${q(it.tvgId)}"`;
  if (it.logo) a += ` tvg-logo="${q(it.logo)}"`;
  if (group) a += ` group-title="${q(group)}"`;
  const ref = it.referer ? oneLine(it.referer) : "";
  if (ref && format !== "vlc") a += ` http-referrer="${q(ref)}" http-user-agent="${q(ua)}"`;
  let s = `#EXTINF:-1${a},${q(it.name)}\n`;
  if (ref && format !== "iptv") s += `#EXTVLCOPT:http-referrer=${ref}\n#EXTVLCOPT:http-user-agent=${ua}\n`;
  let u = it.url;
  if (ref && format === "iptv") u += `|User-Agent=${encodeURIComponent(ua)}&Referer=${encodeURIComponent(ref)}`;
  return s + u + "\n";
}
const groupOf = (it) => it.group || (it.live === false ? "Grabados" : "En vivo");
function sortedItems(list) {
  const order = [...list.categories, "En vivo", "Grabados"];
  const rank = (g) => { const i = order.indexOf(g); return i < 0 ? order.length : i; };
  return list.items.map((it, i) => [it, i]).sort((a, b) => rank(groupOf(a[0])) - rank(groupOf(b[0])) || a[1] - b[1]).map((x) => x[0]);
}
function m3uText(list, format = S.settings.format) {
  return "#EXTM3U\n" + sortedItems(list).map((it) => m3uEntry(it, groupOf(it), format)).join("");
}
function parseM3u(text) {
  const out = []; let cur = {};
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith("#EXTM3U")) continue;
    if (l.startsWith("#EXTINF:")) {
      const m = l.match(/^#EXTINF:[^,"]*(?:"[^"]*"[^,"]*)*,(.*)$/);
      cur.name = (m ? m[1] : l.slice(l.indexOf(",") + 1)).trim();
      const g = (k) => (l.match(new RegExp(k + '="([^"]*)"')) || [])[1] || "";
      cur.logo = g("tvg-logo"); cur.group = g("group-title"); cur.tvgId = g("tvg-id"); cur.referer = g("http-referrer") || cur.referer || "";
    } else if (l.startsWith("#EXTVLCOPT:http-referrer=")) cur.referer = l.slice(25);
    else if (!l.startsWith("#")) {
      let url = l;
      const p = l.indexOf("|");
      if (p > 0) { url = l.slice(0, p); const r = new URLSearchParams(l.slice(p + 1)).get("Referer"); if (r) cur.referer = r; }
      if (/^https?:\/\//i.test(url)) out.push({ name: cur.name || hostOf(url) || "Canal", url, referer: cur.referer || "", logo: cur.logo || "", group: cur.group || "", tvgId: cur.tvgId || "" });
      cur = {};
    }
  }
  return out;
}

// ---------- extraer links de video del código de una página (mismo código que la extensión) ----------
function unescapeUrl(u) {
  return u.replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/\\u002F/gi, "/").replace(/&amp;/g, "&").replace(/[\\'"),;]+$/, "");
}
function findM3u8(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/https?:(?:\\?\/){2}[^\s"'<>`]+?\.m3u8(?:[^\s"'<>`]*)?/gi)) out.add(unescapeUrl(m[0]));
  for (const m of html.matchAll(/["'`]([^"'`\s<>]+?\.m3u8[^"'`\s<>]*)["'`]/gi)) { try { out.add(new URL(unescapeUrl(m[1]), base).href); } catch {} }
  return [...out].filter((u) => /^https?:\/\//i.test(u));
}
function fetchT(url, ms = 9000, init = {}) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  return fetch(url, { cache: "no-store", ...init, signal: c.signal }).finally(() => clearTimeout(t));
}

// ---------- puente con la extensión del computador (Gist secreto de GitHub) ----------
// La app deja  req-<id>.json ; la extensión abre la página en Chrome, captura, prueba como CarTV y responde  res-<id>.json .
const RELAY_DESC = "HLS-M3U-RELAY · puente entre la extensión y la app del iPhone (no borrar)";
async function ghApi(path, init = {}) {
  const r = await fetchT("https://api.github.com" + path, 15000, { ...init, headers: {
    Authorization: `Bearer ${S.settings.ghToken}`, Accept: "application/vnd.github+json", ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  if (!r.ok) throw new Error(r.status === 401 ? "El token de GitHub no es válido o venció" : r.status === 403 ? "GitHub rechazó el pedido (permiso «gist» o límite de uso)" : `GitHub respondió ${r.status}`);
  return r.json();
}
async function relayGistId() {
  if (S.settings.relayGistId) return S.settings.relayGistId;
  for (let page = 1; page <= 3; page++) {
    const list = await ghApi(`/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.description === RELAY_DESC);
    if (hit) { S.settings.relayGistId = hit.id; save({ republish: false }); return hit.id; }
    if (list.length < 100) break;
  }
  const g = await ghApi("/gists", { method: "POST", body: JSON.stringify({ description: RELAY_DESC, public: false,
    files: { "LEEME.md": { content: "Puente entre la extensión HLS Stream Detector y la app Listas M3U del iPhone. No lo borres." } } }) });
  S.settings.relayGistId = g.id; save({ republish: false });
  return g.id;
}
// Encarga a la extensión una búsqueda ({query}) o una extracción ({pageUrl}) y espera la respuesta.
async function relayJob(payload, job, my) {
  job.step = "Enviando el encargo a tu computador…"; job.viaPc = true; renderSearch();
  let id = await relayGistId();
  const rid = uid();
  try { await ghApi(`/gists/${id}`, { method: "PATCH", body: JSON.stringify({ files: { [`req-${rid}.json`]: { content: JSON.stringify({ ...payload, at: Date.now() }) } } }) }); }
  catch (e) { if (!/404/.test(e.message)) throw e; S.settings.relayGistId = ""; id = await relayGistId(); await ghApi(`/gists/${id}`, { method: "PATCH", body: JSON.stringify({ files: { [`req-${rid}.json`]: { content: JSON.stringify({ ...payload, at: Date.now() }) } } }) }); }
  job.step = "Esperando a tu computador (revisa cada 30 s)…"; renderSearch();
  const t0 = Date.now();
  let acked = false;
  while (my === searchToken) {
    await new Promise((r) => setTimeout(r, 5000));
    if (my !== searchToken) break;
    let g;
    try { g = await ghApi(`/gists/${id}`); } catch { continue; }
    const f = g.files[`res-${rid}.json`];
    if (f) {
      let res = null;
      try { res = JSON.parse(f.truncated ? await (await fetchT(f.raw_url)).text() : f.content); } catch {}
      if (res) {
        acked = true;
        job.step = "Tu computador: " + res.step; job.tried = res.tried || job.tried; renderSearch();
        if (res.status === "done") {
          ghApi(`/gists/${id}`, { method: "PATCH", body: JSON.stringify({ files: { [`res-${rid}.json`]: null } }) }).catch(() => {});
          for (const x of res.failed || []) job.failed.push({ host: x.host, why: "(computador) " + x.why });
          return res.found || [];
        }
      }
    }
    if (!acked && Date.now() - t0 > 100000) {
      ghApi(`/gists/${id}`, { method: "PATCH", body: JSON.stringify({ files: { [`req-${rid}.json`]: null } }) }).catch(() => {});
      throw new Error("Tu computador no respondió. Revisa que esté prendido con Chrome abierto, y que la extensión esté conectada al mismo GitHub (Opciones, «Puente con la app del iPhone»).");
    }
    if (acked && Date.now() - t0 > 5 * 60e3) throw new Error("Tu computador tardó demasiado. Intenta de nuevo.");
  }
  return [];
}
// Lo que devuelve el computador se prueba otra vez aquí (si no necesita Referer), para saber si sirve en ESTE equipo
async function addPcResults(found, job, my) {
  for (const f of found) {
    if (my !== searchToken || job.found.some((x) => x.key === keyOf(f.url))) continue;
    const item = { url: f.url, referer: f.referer || "", name: f.name, logo: f.thumb || "", tvgId: f.tvgId || "", key: keyOf(f.url),
      live: f.live, res: f.res ? String(f.res).split("x").pop() + "p" : "", verifiedAt: f.verifiedAt || Date.now(), lock: networkLock(f.url), exp: tokenExpiry(f.url), viaPc: true };
    if (f.referer) item.note = "Probado por tu computador (necesita Referer; en CarTV usa el formato «Solo apps IPTV»)";
    else {
      job.step = `Probando aquí ${hostOf(f.url)}…`; renderSearch();
      try { const r = await verifyVideo(f.url); item.res = r.h ? r.h + "p" : item.res; item.note = "Probado por tu computador y en este equipo"; }
      catch (e) { item.note = `Funciona en tu computador pero aquí no: ${e.message}`; item.warn = true; }
    }
    job.found.push(item); renderSearch();
  }
}

// ---------- directorio de canales (iptv-org, caché 24 h) ----------
const DIR = "https://iptv-org.github.io/api/";
const dirMem = {};
async function dirJson(name) {
  if (dirMem[name]) return dirMem[name];
  const url = DIR + name + ".json";
  let cache = null, hit = null;
  try { cache = await caches.open("directorio-app"); hit = await cache.match(url); } catch {}
  if (hit && Date.now() - (+hit.headers.get("x-fetched") || 0) < 864e5) return (dirMem[name] = await hit.json());
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const body = await r.text();
    cache?.put(url, new Response(body, { headers: { "content-type": "application/json", "x-fetched": String(Date.now()) } })).catch(() => {});
    return (dirMem[name] = JSON.parse(body));
  } catch (e) {
    if (hit) return (dirMem[name] = await hit.json());
    throw e;
  }
}
// Servicios que solo entregan el directo con la sesión de su reproductor: el link del directorio suele fallar en CarTV
const needsPlayerSession = (url) => { try { const u = new URL(url); return /(^|\.)(mdstrm\.com|mediastream\.[a-z.]+)$/i.test(u.hostname) && !u.searchParams.has("player"); } catch { return false; } };
const STOP = new Set(["canal", "tv", "television", "hd", "channel", "en", "vivo", "el", "la", "de", "del", "y", "senal", "live"]);
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter((w) => w && !STOP.has(w));
function nameScore(query, name) {
  const q = norm(query), n = norm(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.replace(/ /g, "") === q.replace(/ /g, "")) return 95;
  if (n.startsWith(q + " ")) return 85;
  const nw = n.split(" "), qw = q.split(" ");
  if (qw.every((w) => nw.includes(w))) return 75;
  const cq = words(query), cn = words(name);
  if (cq.length && cq.every((w) => cn.includes(w))) return cn.length === cq.length ? 72 : 62;
  if (cq.length && cq.join("").length >= 4 && cn.join("").includes(cq.join(""))) return 50;
  return 0;
}
const userCountry = () => ((navigator.language || "").match(/-([A-Z]{2})$/i) || [])[1]?.toUpperCase() || "";
async function candidates(query) {
  const [channels, streams] = await Promise.all([dirJson("channels"), dirJson("streams")]);
  let logos = [];
  try { logos = await dirJson("logos"); } catch {}
  const cc = userCountry();
  const scored = [];
  for (const c of channels) {
    if (c.is_nsfw || c.closed) continue;
    const best = Math.max(nameScore(query, c.name), ...(c.alt_names || []).map((a) => nameScore(query, a)));
    if (best) scored.push({ c, score: best + (cc && c.country === cc ? 8 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = new Map(scored.slice(0, 8).map((x) => [x.c.id, x]));
  const logoOf = (id) => top.get(id)?.c.logo || logos.find((l) => l.channel === id)?.url || "";
  const out = [];
  for (const s of streams) {
    if (!s.url || !/\.m3u8(\?|$)/i.test(s.url)) continue;
    const hit = top.get(s.channel);
    const ts = !hit && s.title ? nameScore(query, s.title) : 0;
    if (!hit && ts < 70) continue;
    out.push({ url: s.url, referer: s.referrer || "", name: hit ? hit.c.name : s.title, logo: hit ? logoOf(hit.c.id) : "",
      tvgId: hit ? hit.c.id : "", website: hit?.c.website || "", score: hit ? hit.score : ts });
  }
  out.sort((a, b) => b.score - a.score);
  const sites = [...new Set(scored.slice(0, 3).filter((x) => x.score >= 60 && x.c.website).map((x) => x.c.website))];
  return { streams: out, sites };
}

// ---------- prueba real: reproducir en un <video> oculto ----------
// Safari reproduce HLS igual que las apps del iPhone. Solo cuenta como "funciona" si el video AVANZA de verdad.
function mediaError(v) {
  const c = v.error?.code;
  return c === 2 ? "error de red: el servidor no entrega el video"
    : c === 3 ? "el equipo no puede decodificar este video (formato no compatible)"
    : c === 4 ? "link caído o formato no compatible"
    : "no se pudo reproducir";
}
function verifyVideo(url, ms = 16000) {
  return new Promise((resolve, reject) => {
    const v = el("video", { muted: true, playsInline: true, preload: "auto" });
    v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
    $("#lab").append(v);
    let hls = null, t0 = null, done = false;
    const finish = (err, res) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { hls?.destroy(); } catch {}
      v.removeAttribute("src"); try { v.load(); } catch {}
      v.remove();
      err ? reject(err) : resolve(res);
    };
    const timer = setTimeout(() => finish(new Error("no respondió a tiempo")), ms);
    v.addEventListener("timeupdate", () => {
      if (t0 === null) t0 = v.currentTime;
      if (v.currentTime - t0 >= 1.2) {
        // Safari: un directo tiene duración infinita · hls.js: lo dice la lista
        const live = hls ? !!(hls.levels?.[Math.max(0, hls.currentLevel)]?.details?.live) : !Number.isFinite(v.duration);
        finish(null, { w: v.videoWidth, h: v.videoHeight, live, audioOnly: !v.videoWidth });
      }
    });
    v.addEventListener("error", () => finish(new Error(mediaError(v))));
    if (NATIVE_HLS) v.src = url;
    else if (window.Hls?.isSupported()) {
      hls = new Hls({ enableWorker: true, maxBufferLength: 6 });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        const code = d.response?.code;
        const why = { manifestLoadError: "no se pudo leer la lista desde la web (en Safari se prueba mejor)", manifestParsingError: "la lista no es válida",
          fragLoadError: "el video no descarga", fragParsingError: "el video viene en un formato que este equipo no puede leer",
          bufferAppendError: "formato de video no compatible con este equipo", levelLoadError: "no se pudo leer la calidad del video", keyLoadError: "la llave de cifrado no descarga" }[d.details];
        finish(new Error(code ? `el servidor respondió ${code}` : why || "no se pudo reproducir"));
      });
      hls.loadSource(url); hls.attachMedia(v);
    } else return finish(new Error("este navegador no reproduce HLS"));
    v.play().catch(() => {});
  });
}

// ---------- búsqueda ----------
const MAX_FOUND = 3, MAX_TESTS = 16;
let searchToken = 0;
async function runSearch(query) {
  query = cleanTitle(query);
  if (!query) return;
  const my = ++searchToken;
  const job = S.search = { query, running: true, step: "Buscando en el directorio de canales…", tried: 0, failed: [], found: [], sites: [] };
  renderSearch();
  try {
    const { streams, sites } = await candidates(query);
    job.sites = sites;
    if (!streams.length) { job.step = "No encontré ese canal en el directorio."; return; }
    const list = streams.slice(0, MAX_TESTS);
    job.step = `Probando ${list.length} link(s): los reproduzco uno por uno…`;
    renderSearch();
    const seen = new Set();
    const conc = IS_IOS ? 1 : 2; // el iPhone reproduce un video a la vez
    const q = [...list];
    await Promise.all(Array.from({ length: conc }, async () => {
      while (q.length && my === searchToken && job.found.length < MAX_FOUND) {
        const c = q.shift();
        const k = keyOf(c.url);
        if (seen.has(k)) continue;
        seen.add(k);
        job.tried++; renderSearch();
        try {
          const r = await verifyVideo(c.url);
          if (my !== searchToken) return;
          job.found.push({ ...c, key: k, live: r.live, res: r.h ? r.h + "p" : r.audioOnly ? "solo audio" : "", verifiedAt: Date.now(), lock: networkLock(c.url), exp: tokenExpiry(c.url) });
        } catch (e) {
          job.failed.push({ host: hostOf(c.url), why: (c.referer ? "necesita Referer (no se puede probar en Safari) · " : "") + e.message });
        }
        renderSearch();
      }
    }));
    if (my !== searchToken) return;
    job.step = job.found.length ? `${job.found.length} link(s) verificado(s) de ${job.tried} probado(s).` : `Probé ${job.tried} link(s) y ninguno funcionó.`;
  } catch (e) {
    if (my !== searchToken) return;
    job.step = "No se pudo leer el directorio de canales. Revisa tu conexión e intenta de nuevo.";
  } finally {
    if (my === searchToken) { job.running = false; renderSearch(); }
  }
}
async function runPage(pageUrl) {
  const my = ++searchToken;
  const job = S.search = { query: hostOf(pageUrl), pageUrl, running: true, step: "Leyendo la página…", tried: 0, failed: [], found: [], sites: [] };
  renderSearch();
  try {
    // 1) directo: links escritos en el código (solo si la página deja leerse desde otra web)
    let page = null;
    try { const r = await fetchT(pageUrl, 8000); if (r.ok) page = { text: await r.text(), url: r.url || pageUrl }; } catch {}
    if (page) {
      const urls = findM3u8(page.text, page.url).slice(0, 6);
      const title = cleanTitle(((page.text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").replace(/&amp;/g, "&")) || hostOf(pageUrl);
      for (const u of urls) {
        if (my !== searchToken || job.found.length >= MAX_FOUND) break;
        job.tried++; job.step = `Probando ${hostOf(u)}…`; renderSearch();
        try { const r = await verifyVideo(u); job.found.push({ url: u, name: title, key: keyOf(u), live: r.live, res: r.h ? r.h + "p" : "", verifiedAt: Date.now(), lock: networkLock(u), exp: tokenExpiry(u), referer: "" }); }
        catch (e) { job.failed.push({ host: hostOf(u), why: e.message }); }
      }
    } else job.failed.push({ host: hostOf(pageUrl), why: "Safari no deja leer esa página desde otra web (normal)" });
    // 2) con el computador: abre la página en Chrome, le da play y captura lo que pide el reproductor
    if (!job.found.length && my === searchToken) {
      if (!S.settings.ghToken) { job.step = "Aquí no encontré el video. Para sacarlo con tu computador, conecta en Ajustes el mismo GitHub de la extensión."; return; }
      await addPcResults(await relayJob({ pageUrl }, job, my), job, my);
    }
    if (my !== searchToken) return;
    job.step = job.found.length ? `${job.found.length} link(s) encontrado(s).` : job.viaPc ? job.step.replace(/^Tu computador: /, "Tu computador: ") : "No encontré ningún video en esa página.";
  } catch (e) {
    if (my === searchToken) job.step = e.message;
  } finally {
    if (my === searchToken) { job.running = false; renderSearch(); }
  }
}
async function runPcSearch(query) {
  const my = ++searchToken;
  const job = S.search = { query, running: true, step: "", tried: 0, failed: [], found: [], sites: [], viaPc: true };
  try { await addPcResults(await relayJob({ query }, job, my), job, my); if (my === searchToken) job.step = job.found.length ? `${job.found.length} link(s) encontrado(s) por tu computador.` : job.step; }
  catch (e) { if (my === searchToken) job.step = e.message; }
  finally { if (my === searchToken) { job.running = false; renderSearch(); } }
}

function stopSearch() {
  searchToken++;
  if (S.search) { S.search.running = false; S.search.step = "Búsqueda detenida."; }
  renderSearch();
}

function logoEl(src) {
  if (!src) return el("div", { class: "logo" }, icon("tv", 20));
  const img = el("img", { class: "logo", src, alt: "", loading: "lazy", referrerPolicy: "no-referrer" });
  img.onerror = () => img.replaceWith(el("div", { class: "logo" }, icon("tv", 20)));
  return img;
}
function renderSearch() {
  const out = $("#searchOut");
  const j = S.search;
  $("#btnSearch").replaceChildren(icon(j?.running ? "x" : "search", 20));
  $("#btnSearch").setAttribute("aria-label", j?.running ? "Detener" : "Buscar");
  $("#btnSearch").classList.toggle("primary", !j?.running);
  $("#btnPage").disabled = !!j?.running;
  out.replaceChildren();
  if (!j) {
    out.append(el("p", { class: "hint" }, "Escribe el nombre de un canal: lo busco en el directorio público de canales gratuitos, reproduzco cada link para probarlo y solo te muestro los que funcionan. Si no aparece, pega el link de la página donde lo ves y lo saco de ahí (con ayuda de tu computador si hace falta)."));
    return;
  }
  const st = el("div", { class: "status" + (j.running ? " run" : "") },
    el("div", {}, j.running ? el("span", { class: "spin" }) : null, `${j.pageUrl ? "Página " + hostOf(j.pageUrl) : "«" + j.query + "»"} · ${j.step}`),
    el("div", { class: "meta" }, `${j.tried} probado(s) · ${j.found.length} verificado(s) · ${j.failed.length} descartado(s)`));
  if (j.failed.length) st.append(el("details", {}, el("summary", {}, "Ver por qué se descartaron"), el("ul", {}, j.failed.slice(-15).map((f) => el("li", {}, `${f.host}: ${f.why}`)))));
  out.append(st);
  if (!j.running && !j.found.length && !j.pageUrl && !j.viaPc) {
    out.append(el("p", { class: "hint" }, "Prueba con otro nombre (sin «canal» ni «TV»), pega arriba el link de la página donde lo ves, o pídele a tu computador que lo busque en la web y en su página oficial:"),
      el("button", { class: "btn", style: "width:100%", onclick: () => (S.settings.ghToken ? runPcSearch(j.query) : (toast("Conecta GitHub en Ajustes"), setView("vSettings"))) }, icon("laptop"), "Buscar con mi computador"));
    for (const s of j.sites) out.append(el("a", { class: "btn sm", href: s, target: "_blank", rel: "noopener", style: "display:inline-block;margin:4px 6px 0 0;text-decoration:none" }, "Abrir " + hostOf(s)));
  }
  for (const f of j.found) {
    const info = [f.warn ? "Verificado solo en tu computador" : "Verificado", f.res, f.live === false ? "grabado" : "en vivo"].filter(Boolean).join(" · ");
    const weak = needsPlayerSession(f.url);
    const notes = [f.note || "", weak ? "Link sin la sesión del reproductor: puede fallar en CarTV. Mejor sácalo de la página oficial." : "", f.lock ? `Solo funciona en la red donde lo probaste (${f.lock === "ip" ? "tu IP" : "tu proveedor"})` : "", f.exp ? `Vence ${new Date(f.exp).toLocaleString()}` : ""].filter(Boolean);
    out.append(el("div", { class: "card " + (f.warn || weak ? "st-warn" : "st-ok") },
      el("div", { class: "ch" }, logoEl(f.logo), el("div", { class: "t" }, el("b", {}, f.name), el("div", { class: "meta tag " + (f.warn ? "warn" : "ok") }, icon(f.warn ? "alert" : "check", 12), info), notes.length ? el("div", { class: "meta warn" }, notes.join(" · ")) : null)),
      el("div", { class: "meta", style: "margin-top:6px" }, f.url),
      el("div", { class: "acts" },
        el("button", { class: "btn primary", onclick: () => addSheet(f) }, icon("plus"), "Agregar a lista"),
        el("button", { class: "btn icon", title: "Ver", onclick: () => play(f) }, icon("play")),
        el("button", { class: "btn icon", title: "Copiar link", onclick: () => copyText(f.url, "Link copiado") }, icon("copy"))),
      weak && f.website ? el("button", { class: "btn", style: "width:100%;margin-top:8px", onclick: () => runPage(f.website) }, icon("laptop"), `Sacar link completo de ${hostOf(f.website)}`) : null));
  }
}

// ---------- hoja inferior ----------
let sheetOnClose = null;
function sheet(title, body, foot = [], onClose = null) {
  $("#sheetTitle").textContent = title;
  put($("#sheetBody"), body);
  put($("#sheetFoot"), foot);
  $("#sheetFoot").hidden = !foot.length;
  $("#sheet").hidden = false;
  sheetOnClose = onClose;
  syncViewport();
}
function closeSheet() { $("#sheet").hidden = true; const f = sheetOnClose; sheetOnClose = null; f?.(); }
$("#sheetClose").onclick = closeSheet;
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
// el campo enfocado siempre visible sobre el teclado
$("#sheetBody").addEventListener("focusin", (e) => setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 300));

// selector de lista + categoría reutilizable
function pickTarget(state) {
  const box = el("div");
  const draw = () => {
    const list = S.lists.find((l) => l.id === state.listId) || S.lists[0];
    if (!list.categories.includes(state.group)) state.group = "";
    box.replaceChildren(
      el("label", {}, "Lista"),
      el("div", { class: "chips" }, S.lists.map((l) => el("button", { class: "chip" + (l.id === list.id ? " on" : ""), type: "button", onclick: () => { state.listId = l.id; state.group = ""; draw(); } }, l.name)),
        el("button", { class: "chip add", type: "button", onclick: () => { const n = prompt("Nombre de la nueva lista"); if (n && cleanTitle(n)) { const nl = { id: uid(), name: cleanTitle(n), categories: [], items: [] }; S.lists.push(nl); save({ republish: false }); state.listId = nl.id; draw(); } } }, icon("plus", 14), "Nueva lista")),
      el("label", {}, "Categoría"),
      el("div", { class: "chips" },
        el("button", { class: "chip" + (!state.group ? " on" : ""), type: "button", onclick: () => { state.group = ""; draw(); } }, "Automática"),
        list.categories.map((c) => el("button", { class: "chip" + (state.group === c ? " on" : ""), type: "button", onclick: () => { state.group = c; draw(); } }, c)),
        el("button", { class: "chip add", type: "button", onclick: () => { const n = cleanTitle(prompt("Nombre de la nueva categoría") || "").slice(0, 40); if (n) { if (!list.categories.includes(n)) list.categories.push(n); state.group = n; save({ republish: false }); draw(); } } }, icon("plus", 14), "Categoría")));
  };
  draw();
  return box;
}

function addSheet(f) {
  const state = { listId: S.active, group: "" };
  const name = el("input", { class: "field", value: f.name, enterKeyHint: "done", maxLength: 70 });
  const doAdd = () => {
    const list = S.lists.find((l) => l.id === state.listId);
    if (list.items.some((x) => x.key === f.key)) { toast("Ya está en esa lista"); return; }
    list.items.push({ id: uid(), key: f.key, name: cleanTitle(name.value) || f.name, url: f.url, referer: f.referer || "", logo: f.logo || "", tvgId: f.tvgId || "",
      group: state.group, live: f.live, res: f.res || "", verifiedAt: f.verifiedAt || 0, status: f.verifiedAt ? "ok" : "" });
    S.active = list.id;
    touch(list);
    closeSheet();
    toast(`Agregado a «${list.name}»${state.group ? " · " + state.group : ""}`);
    renderHeader();
  };
  name.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); name.blur(); } };
  sheet("Agregar a una lista", [el("label", {}, "Nombre"), name, pickTarget(state)],
    [el("button", { class: "btn", onclick: closeSheet }, "Cancelar"), el("button", { class: "btn primary", onclick: doAdd }, "Agregar")]);
}

// ---------- reproductor ----------
let playerHls = null;
function play(it) {
  const v = $("#playerVideo");
  $("#playerName").textContent = it.name;
  $("#playerMsg").textContent = "Cargando…";
  $("#player").hidden = false;
  syncViewport();
  try { playerHls?.destroy(); } catch {}
  playerHls = null;
  v.onerror = () => ($("#playerMsg").textContent = "Error: " + mediaError(v));
  v.onplaying = () => ($("#playerMsg").textContent = `EN VIVO · ${v.videoHeight ? v.videoHeight + "p · " : ""}${hostOf(it.url)}`);
  if (NATIVE_HLS) v.src = it.url;
  else if (window.Hls?.isSupported()) { playerHls = new Hls(); playerHls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) $("#playerMsg").textContent = "Error: " + (d.response?.code ? "el servidor respondió " + d.response.code : d.details); }); playerHls.loadSource(it.url); playerHls.attachMedia(v); }
  v.play().catch(() => ($("#playerMsg").textContent = "Toca reproducir"));
}
$("#playerClose").onclick = () => {
  const v = $("#playerVideo");
  v.pause(); try { playerHls?.destroy(); } catch {}
  playerHls = null; v.removeAttribute("src"); v.load();
  $("#player").hidden = true;
};

// ---------- mis listas ----------
function renderLists() {
  const view = $("#vLists");
  const list = activeList();
  if (S.listCat !== "*" && S.listCat !== "" && !list.categories.includes(S.listCat) && !list.items.some((it) => groupOf(it) === S.listCat)) S.listCat = "*";
  const groups = new Map(list.categories.map((c) => [c, []]));
  for (const it of sortedItems(list)) { const g = groupOf(it); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it); }

  put(view,
    el("div", { class: "chips" }, S.lists.map((l) => el("button", { class: "chip" + (l.id === list.id ? " on" : ""), onclick: () => { S.active = l.id; S.listCat = "*"; save({ republish: false }); renderLists(); renderHeader(); } }, `${l.name} · ${l.items.length}`)),
      el("button", { class: "chip add", onclick: newList }, icon("plus", 14), "Nueva lista")),
    el("div", { class: "listhead" }, el("b", {}, list.name), el("button", { class: "btn sm", onclick: () => listMenu(list) }, icon("more"), "Lista")),
    el("div", { class: "acts", style: "margin-top:4px" },
      el("button", { class: "btn primary", onclick: () => exportSheet(list), disabled: !list.items.length }, icon("share"), "Exportar"),
      el("button", { class: "btn", onclick: () => manualSheet(list) }, icon("plus"), "Link")),
    list.link ? el("div", { class: "meta tag", style: "margin-top:8px" }, icon("link", 12), "Link fijo publicado: se actualiza solo al cambiar la lista.") : null,
    groups.size ? el("div", { class: "chips", style: "margin-top:12px" },
      el("button", { class: "chip" + (S.listCat === "*" ? " on" : ""), onclick: () => { S.listCat = "*"; renderLists(); } }, "Todas"),
      [...groups.keys()].map((g) => el("button", { class: "chip" + (S.listCat === g ? " on" : ""), onclick: () => { S.listCat = g; renderLists(); } }, `${g} · ${groups.get(g).length}`)),
      el("button", { class: "chip add", onclick: () => { const n = cleanTitle(prompt("Nombre de la nueva categoría") || "").slice(0, 40); if (n && !list.categories.includes(n)) { list.categories.push(n); touch(list); renderLists(); } } }, icon("plus", 14), "Categoría")) : null
  );
  if (!list.items.length) view.append(el("p", { class: "empty" }, "Esta lista está vacía. Busca un canal en Buscar y agrégalo, agrega un link con «Link» o importa un .m3u desde el menú «Lista»."));
  for (const [g, items] of groups) {
    if (S.listCat !== "*" && S.listCat !== g) continue;
    const isUser = list.categories.includes(g);
    view.append(el("h2", {}, g, el("span", { class: "n" }, items.length), isUser ? null : el("span", { style: "font-weight:400;text-transform:none;letter-spacing:0" }, "automática"),
      isUser ? el("span", { class: "grow" }) : null,
      isUser ? el("button", { class: "btn sm", style: "text-transform:none;letter-spacing:0", onclick: () => catMenu(list, g) }, icon("more")) : null));
    if (!items.length) view.append(el("p", { class: "hint" }, "Vacía. Envía canales aquí desde el menú de cada canal, «Mover a categoría»."));
    for (const it of items) view.append(itemCard(list, it));
  }
}
function itemCard(list, it) {
  const tag = (cls, text) => el("span", { class: "tag " + cls }, icon("dot", 10), text);
  const st = it.status === "ok" ? tag("ok", "Funciona") : it.status === "bad" ? tag("bad", "No funciona") : it.status === "testing" ? tag("warn", "Probando…") : tag("muted", "Sin probar");
  const exp = tokenExpiry(it.url);
  return el("div", { class: "card" + (it.status ? " st-" + (it.status === "testing" ? "warn" : it.status) : "") },
    el("div", { class: "ch" }, logoEl(it.logo),
      el("div", { class: "t" }, el("b", {}, it.name),
        el("div", { class: "meta" }, st, it.verifiedAt ? ` · ${ago(it.verifiedAt)}` : "", it.res ? ` · ${it.res}` : "", it.why && it.status === "bad" ? ` · ${it.why}` : ""),
        exp || networkLock(it.url) ? el("div", { class: "meta warn" }, [networkLock(it.url) ? "Amarrado a la red" : "", exp ? (exp < Date.now() ? "Token vencido" : `Vence ${new Date(exp).toLocaleString()}`) : ""].filter(Boolean).join(" · ")) : null),
      el("button", { class: "btn icon", title: "Ver", onclick: () => play(it) }, icon("play")),
      el("button", { class: "btn icon", title: "Opciones", onclick: () => itemMenu(list, it) }, icon("more"))));
}
async function retest(list, it) {
  it.status = "testing"; renderLists();
  try { const r = await verifyVideo(it.url); Object.assign(it, { status: "ok", why: "", verifiedAt: Date.now(), res: r.h ? r.h + "p" : it.res, live: r.live }); }
  catch (e) { Object.assign(it, { status: "bad", why: e.message, verifiedAt: Date.now() }); }
  save({ republish: false }); renderLists();
}
async function retestAll(list) {
  closeSheet();
  toast(`Probando ${list.items.length} canal(es)…`);
  for (const it of list.items) await retest(list, it);
  const bad = list.items.filter((x) => x.status === "bad").length;
  toast(bad ? `${bad} canal(es) no funcionan` : "Todos funcionan");
}
function itemMenu(list, it) {
  const opt = (i, t, fn, cls = "") => el("button", { class: "opt " + cls, onclick: fn }, el("span", { class: "i" }, icon(i, 18)), t);
  sheet(it.name, [
    opt("refresh", "Probar de nuevo", () => { closeSheet(); retest(list, it); }),
    opt("folder", "Mover a categoría", () => moveSheet(list, it)),
    opt("edit", "Cambiar nombre", () => { const n = cleanTitle(prompt("Nuevo nombre", it.name) || ""); if (n) { it.name = n; touch(list); renderLists(); } closeSheet(); }),
    opt("copy", "Copiar link", () => { copyText(it.url, "Link copiado"); closeSheet(); }),
    opt("trash", "Quitar de la lista", () => { list.items = list.items.filter((x) => x !== it); touch(list); closeSheet(); renderLists(); renderHeader(); }, "danger")
  ]);
}
function moveSheet(list, it) {
  const state = { listId: list.id, group: it.group || "" };
  sheet("Mover a…", pickTarget(state), [el("button", { class: "btn", onclick: closeSheet }, "Cancelar"), el("button", { class: "btn primary", onclick: () => {
    const to = S.lists.find((l) => l.id === state.listId);
    if (to !== list) {
      if (to.items.some((x) => x.key === it.key)) { toast("Ya está en esa lista"); return; }
      list.items = list.items.filter((x) => x !== it); to.items.push(it); touch(to);
    }
    it.group = state.group; touch(list); closeSheet(); renderLists(); renderHeader();
  } }, "Mover")]);
}
function catMenu(list, g) {
  const opt = (i, t, fn, cls = "") => el("button", { class: "opt " + cls, onclick: fn }, el("span", { class: "i" }, icon(i, 18)), t);
  const idx = list.categories.indexOf(g);
  sheet(g, [
    opt("edit", "Cambiar nombre", () => { const n = cleanTitle(prompt("Nuevo nombre", g) || "").slice(0, 40); if (n && !list.categories.includes(n)) { list.categories[idx] = n; list.items.forEach((x) => { if (x.group === g) x.group = n; }); if (S.listCat === g) S.listCat = n; touch(list); } closeSheet(); renderLists(); }),
    idx > 0 ? opt("up", "Subir (sale antes en la lista)", () => { list.categories.splice(idx - 1, 0, list.categories.splice(idx, 1)[0]); touch(list); closeSheet(); renderLists(); }) : null,
    idx < list.categories.length - 1 ? opt("down", "Bajar", () => { list.categories.splice(idx + 1, 0, list.categories.splice(idx, 1)[0]); touch(list); closeSheet(); renderLists(); }) : null,
    opt("trash", "Borrar categoría (sus canales pasan a Automática)", () => { list.categories.splice(idx, 1); list.items.forEach((x) => { if (x.group === g) x.group = ""; }); S.listCat = "*"; touch(list); closeSheet(); renderLists(); }, "danger")
  ].filter(Boolean));
}
function newList() {
  const n = cleanTitle(prompt("Nombre de la nueva lista", "Lista " + (S.lists.length + 1)) || "");
  if (!n) return;
  const l = { id: uid(), name: n, categories: [], items: [] };
  S.lists.push(l); S.active = l.id; S.listCat = "*";
  save({ republish: false }); renderLists(); renderHeader();
}
function listMenu(list) {
  const opt = (i, t, fn, cls = "") => el("button", { class: "opt " + cls, onclick: fn }, el("span", { class: "i" }, icon(i, 18)), t);
  sheet(list.name, [
    opt("refresh", "Probar todos los canales", () => retestAll(list)),
    opt("upload", "Importar .m3u / .m3u8", () => importSheet(list)),
    opt("edit", "Cambiar nombre de la lista", () => { const n = cleanTitle(prompt("Nuevo nombre", list.name) || ""); if (n) { list.name = n; touch(list); } closeSheet(); renderLists(); renderHeader(); }),
    S.lists.length > 1 ? opt("trash", "Borrar esta lista", () => {
      if (!confirm(`¿Borrar «${list.name}» y sus ${list.items.length} canal(es)?`)) return;
      S.lists = S.lists.filter((l) => l !== list); S.active = S.lists[0].id; save({ republish: false }); closeSheet(); renderLists(); renderHeader();
    }, "danger") : null
  ].filter(Boolean));
}

// agregar un link a mano
function manualSheet(list) {
  const state = { listId: list.id, group: S.listCat !== "*" && list.categories.includes(S.listCat) ? S.listCat : "" };
  const url = el("input", { class: "field", type: "url", placeholder: "https://…/playlist.m3u8", autocapitalize: "off", spellcheck: false, enterKeyHint: "next" });
  const name = el("input", { class: "field", placeholder: "Nombre del canal", maxLength: 70, enterKeyHint: "done" });
  const msg = el("div", { class: "meta", style: "margin-top:10px" });
  url.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); name.focus(); } };
  name.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); name.blur(); } };
  const add = (verified, r) => {
    const to = S.lists.find((l) => l.id === state.listId);
    const u = url.value.trim(), k = keyOf(u);
    if (to.items.some((x) => x.key === k)) { msg.textContent = "Ese link ya está en la lista."; return; }
    to.items.push({ id: uid(), key: k, name: cleanTitle(name.value) || hostOf(u), url: u, referer: "", logo: "", tvgId: "", group: state.group,
      live: r?.live, res: r?.h ? r.h + "p" : "", verifiedAt: verified ? Date.now() : 0, status: verified ? "ok" : "" });
    S.active = to.id; touch(to); closeSheet(); renderLists(); renderHeader(); toast("Agregado");
  };
  const test = el("button", { class: "btn primary", onclick: async () => {
    const u = url.value.trim();
    if (!/^https?:\/\/\S+$/i.test(u)) { msg.className = "meta bad"; msg.textContent = "Pega un link completo que empiece por http:// o https://"; url.focus(); return; }
    test.disabled = true; msg.className = "meta"; msg.textContent = "Probando: reproduciendo el link…";
    try { const r = await verifyVideo(u); add(true, r); }
    catch (e) {
      test.disabled = false; msg.className = "meta bad";
      msg.replaceChildren(`No funcionó: ${e.message}. `, el("button", { class: "btn sm", onclick: () => add(false) }, "Agregar igual"));
    }
  } }, "Probar y agregar");
  sheet("Agregar un link", [el("label", {}, "Link del video (.m3u8, .mp4)"), url, el("label", {}, "Nombre"), name, pickTarget(state), msg],
    [el("button", { class: "btn", onclick: closeSheet }, "Cancelar"), test]);
  setTimeout(() => url.focus(), 200);
}

// importar
function importSheet(list) {
  const file = el("input", { type: "file", accept: ".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain", hidden: true });
  const url = el("input", { class: "field", type: "url", placeholder: "https://…/lista.m3u", autocapitalize: "off", spellcheck: false, enterKeyHint: "go" });
  const msg = el("div", { class: "meta", style: "margin-top:10px" });
  const ingest = (text) => {
    const items = parseM3u(text);
    let added = 0;
    for (const it of items) {
      const k = keyOf(it.url);
      if (list.items.some((x) => x.key === k)) continue;
      if (it.group && !["En vivo", "Grabados"].includes(it.group) && !list.categories.includes(it.group)) list.categories.push(it.group);
      list.items.push({ id: uid(), key: k, ...it, group: ["En vivo", "Grabados"].includes(it.group) ? "" : it.group, status: "", verifiedAt: 0 });
      added++;
    }
    touch(list); closeSheet(); renderLists(); renderHeader();
    toast(items.length ? `+${added} canal(es) importado(s)` : "No encontré canales en esa lista");
  };
  file.onchange = async () => { const f = file.files[0]; if (f) ingest(await f.text()); };
  const fetchUrl = async () => {
    const u = url.value.trim();
    if (!/^https?:\/\//i.test(u)) { msg.textContent = "Pega un link completo."; return; }
    msg.textContent = "Descargando…";
    try { const r = await fetch(u); if (!r.ok) throw new Error("HTTP " + r.status); ingest(await r.text()); }
    catch { msg.className = "meta bad"; msg.textContent = "No se pudo descargar desde la web (el servidor no lo permite). Descárgala como archivo y usa «Elegir archivo»."; }
  };
  url.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); fetchUrl(); } };
  sheet("Importar lista", [
    el("button", { class: "btn primary", style: "width:100%", onclick: () => file.click() }, icon("upload"), "Elegir archivo .m3u / .m3u8"), file,
    el("label", {}, "…o desde un link"), el("div", { class: "row" }, el("div", { class: "grow" }, url), el("button", { class: "btn", onclick: fetchUrl }, "Traer")), msg
  ]);
}

// exportar / compartir / publicar
function exportSheet(list) {
  const fmt = el("select", { class: "field" },
    el("option", { value: "both" }, "VLC + apps IPTV (recomendado)"),
    el("option", { value: "iptv" }, "Solo apps IPTV (CarTV, Kodi) — manda Referer"),
    el("option", { value: "vlc" }, "Solo VLC"));
  fmt.value = S.settings.format;
  fmt.onchange = () => { S.settings.format = fmt.value; list.dirty = true; save(); };
  const fileOf = (ext) => new File([m3uText(list, fmt.value)], safeFile(list.name) + ext, { type: ext === ".m3u8" ? "application/vnd.apple.mpegurl" : "audio/x-mpegurl" });
  const download = (ext) => {
    const f = fileOf(ext), a = el("a", { href: URL.createObjectURL(f), download: f.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };
  const share = async (ext) => {
    const f = fileOf(ext);
    if (navigator.canShare?.({ files: [f] })) {
      try { await navigator.share({ files: [f], title: list.name }); } catch (e) { if (e.name !== "AbortError") toast("No se pudo compartir"); }
    } else download(ext);
  };
  const pub = el("div");
  const drawPub = () => {
    pub.replaceChildren();
    if (!S.settings.ghToken) { pub.append(el("p", { class: "hint" }, "Para un link fijo que se actualiza solo (ideal para pegar una vez en CarTV), conecta GitHub en Ajustes.")); return; }
    if (list.link) {
      pub.append(el("div", { class: "linkbox" }, list.link),
        el("div", { class: "acts" }, el("button", { class: "btn primary", onclick: () => copyText(list.link, "Link copiado") }, icon("copy"), "Copiar link"),
          el("button", { class: "btn", onclick: async (e) => { e.target.disabled = true; try { await publishList(list, fmt.value); toast("Actualizado"); } catch (er) { toast(er.message); } e.target.disabled = false; } }, "Actualizar ahora")),
        el("p", { class: "hint" }, "En CarTV: agregar lista, «M3U por URL», pega este link. Se actualiza solo cuando cambias la lista (las apps pueden tardar unos minutos en verlo)."));
    } else {
      pub.append(el("button", { class: "btn primary", style: "width:100%", onclick: async (e) => { e.target.disabled = true; e.target.textContent = "Publicando…"; try { await publishList(list, fmt.value); drawPub(); } catch (er) { toast(er.message); e.target.disabled = false; e.target.textContent = "Crear link fijo"; } } }, icon("link"), "Crear link fijo"));
    }
  };
  drawPub();
  sheet(`Exportar «${list.name}»`, [
    el("label", {}, "Formato"), fmt,
    el("p", { class: "hint" }, "Si un canal necesita Referer y CarTV no lo abre, elige «Solo apps IPTV»."),
    el("label", {}, "Archivo"),
    el("div", { class: "acts" }, el("button", { class: "btn primary", onclick: () => share(".m3u") }, icon("share"), ".m3u"), el("button", { class: "btn", onclick: () => share(".m3u8") }, icon("share"), ".m3u8")),
    el("div", { class: "acts" }, el("button", { class: "btn", onclick: () => download(".m3u") }, icon("download"), ".m3u"), el("button", { class: "btn", onclick: () => download(".m3u8") }, icon("download"), ".m3u8")),
    el("div", { class: "acts" }, el("button", { class: "btn", onclick: () => copyText(m3uText(list, fmt.value), "Lista copiada") }, icon("copy"), "Copiar texto de la lista")),
    el("p", { class: "hint" }, "«Compartir» abre el menú del iPhone: elige CarTV, VLC o «Guardar en Archivos»."),
    el("label", {}, "Link fijo"), pub
  ]);
}

async function publishList(list, format = S.settings.format) {
  const token = S.settings.ghToken;
  if (!token) throw new Error("Conecta GitHub en Ajustes");
  const file = safeFile(list.name) + ".m3u";
  const files = { [file]: { content: m3uText(list, format) } };
  if (list.gistFile && list.gistFile !== file) files[list.gistFile] = null; // la lista cambió de nombre
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  const body = JSON.stringify({ description: `Lista M3U — ${list.name}`, files, ...(list.gistId ? {} : { public: false }) });
  let r = list.gistId ? await fetch(`https://api.github.com/gists/${list.gistId}`, { method: "PATCH", headers, body }) : null;
  if (!r || r.status === 404) r = await fetch("https://api.github.com/gists", { method: "POST", headers, body: JSON.stringify({ description: `Lista M3U — ${list.name}`, public: false, files: { [file]: files[file] } }) });
  if (!r.ok) throw new Error(r.status === 401 ? "El token de GitHub no es válido o venció" : r.status === 403 || r.status === 422 ? "El token no tiene permiso «gist»" : `GitHub respondió ${r.status}`);
  const g = await r.json();
  Object.assign(list, { gistId: g.id, gistFile: file, link: `https://gist.githubusercontent.com/${g.owner.login}/${g.id}/raw/${file}`, dirty: false, publishedAt: Date.now() });
  save({ republish: false });
  return list.link;
}

// ---------- ajustes ----------
function renderSettings() {
  const tok = el("input", { class: "field", type: "password", placeholder: "ghp_…", value: S.settings.ghToken, autocapitalize: "off", spellcheck: false });
  tok.onchange = () => { S.settings.ghToken = tok.value.trim(); save({ republish: false }); toast(S.settings.ghToken ? "GitHub conectado" : "GitHub desconectado"); };
  const fmt = el("select", { class: "field" }, el("option", { value: "both" }, "VLC + apps IPTV (recomendado)"), el("option", { value: "iptv" }, "Solo apps IPTV (CarTV, Kodi)"), el("option", { value: "vlc" }, "Solo VLC"));
  fmt.value = S.settings.format;
  fmt.onchange = () => { S.settings.format = fmt.value; S.lists.forEach((l) => (l.dirty = true)); save(); };
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  put($("#vSettings"),
    standalone ? null : el("div", { class: "set" }, el("h3", {}, icon("phone"), "Instalar en el iPhone"),
      el("p", { class: "hint" }, "En Safari toca Compartir (el cuadro con la flecha) y luego «Añadir a pantalla de inicio». Así abre como app, a pantalla completa, y tus listas quedan guardadas.")),
    el("div", { class: "set" }, el("h3", {}, "Formato de las listas"), el("label", {}, "Cómo van el Referer y el User-Agent"), fmt),
    el("div", { class: "set" }, el("h3", {}, "Link fijo (GitHub)"),
      el("p", { class: "hint" }, "Publica cada lista como un Gist secreto de GitHub (gratis). El link no cambia aunque edites la lista."),
      el("a", { href: "https://github.com/settings/tokens/new?scopes=gist&description=Listas%20M3U", target: "_blank", rel: "noopener" }, "1. Crear token con permiso «gist» ", icon("external", 13)),
      el("label", {}, "2. Pega el token"), tok,
      el("p", { class: "hint" }, "El token se guarda solo en este equipo. Quien tenga el link de una lista puede verla."),
      el("p", { class: "hint" }, "Con el mismo usuario de GitHub que tiene la extensión, esta app le puede pedir a tu computador que busque un canal o que saque el video de una página (Chrome sí puede abrir páginas por detrás; Safari no). El computador debe estar prendido con Chrome abierto.")),
    el("div", { class: "set" }, el("h3", {}, "Datos"),
      el("p", { class: "hint" }, `${S.lists.length} lista(s) · ${S.lists.reduce((a, l) => a + l.items.length, 0)} canal(es) guardados en este equipo.`),
      el("div", { class: "acts" },
        el("button", { class: "btn", onclick: backup }, icon("download"), "Copia de seguridad"),
        el("button", { class: "btn", onclick: () => { const f = el("input", { type: "file", accept: ".json,application/json" }); f.onchange = () => restore(f.files[0]); f.click(); } }, icon("upload"), "Restaurar")),
      el("div", { class: "acts" }, el("button", { class: "btn", onclick: async () => { try { await caches.delete("directorio-app"); } catch {} Object.keys(dirMem).forEach((k) => delete dirMem[k]); toast("Directorio se descargará de nuevo"); } }, icon("refresh"), "Actualizar directorio de canales"))),
    el("div", { class: "set" }, el("h3", {}, "Cómo prueba los canales"),
      el("p", { class: "hint" }, "Cada link se reproduce de verdad en segundo plano: solo cuenta como «funciona» si el video avanza. Los links que exigen Referer no se pueden probar desde Safari y se descartan; los que están amarrados a la red solo funcionan en la red donde se probaron.")));
}
function backup() {
  const data = JSON.stringify({ app: "Listas M3U", exportedAt: new Date().toISOString(), lists: S.lists.map(({ dirty, ...l }) => l), settings: { format: S.settings.format } }, null, 2);
  const f = new File([data], `listas_m3u_${new Date().toISOString().slice(0, 10)}.json`, { type: "application/json" });
  if (navigator.canShare?.({ files: [f] })) navigator.share({ files: [f] }).catch(() => {});
  else { const a = el("a", { href: URL.createObjectURL(f), download: f.name }); document.body.append(a); a.click(); a.remove(); }
}
async function restore(file) {
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.lists)) throw 0;
    let n = 0;
    for (const l of d.lists) {
      if (!l || !Array.isArray(l.items)) continue;
      const ex = S.lists.find((x) => x.id === l.id);
      if (ex) { for (const it of l.items) if (!ex.items.some((x) => x.key === it.key)) { ex.items.push(it); n++; } for (const c of l.categories || []) if (!ex.categories.includes(c)) ex.categories.push(c); }
      else { S.lists.push({ categories: [], ...l }); n += l.items.length; }
    }
    save({ republish: false }); renderAll(); toast(`Restaurado: ${n} canal(es)`);
  } catch { toast("Ese archivo no es una copia válida"); }
}

// ---------- navegación ----------
const TITLES = { vSearch: "Buscar canal", vLists: "Mis listas", vSettings: "Ajustes" };
function renderHeader() {
  $("#title").textContent = TITLES[S.view];
  const l = activeList();
  $("#activePill").textContent = `${l.name} · ${l.items.length}`;
}
function setView(v) {
  S.view = v;
  document.querySelectorAll(".view").forEach((s) => (s.hidden = s.id !== v));
  document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  if (v === "vLists") renderLists();
  if (v === "vSettings") renderSettings();
  renderHeader();
  scrollTo(0, 0);
}
function renderAll() { renderHeader(); renderSearch(); if (S.view === "vLists") renderLists(); if (S.view === "vSettings") renderSettings(); }
document.querySelectorAll("nav.tabs button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
$("#activePill").onclick = () => setView("vLists");
$("#pageForm").onsubmit = (e) => {
  e.preventDefault();
  const u = $("#pageUrl").value.trim();
  if (!/^https?:\/\/\S+$/i.test(u)) { toast("Pega un link completo (https://…)"); return $("#pageUrl").focus(); }
  $("#pageUrl").blur();
  runPage(u);
};
$("#searchForm").onsubmit = (e) => {
  e.preventDefault();
  if (S.search?.running) return stopSearch();
  $("#q").blur();
  runSearch($("#q").value);
};

hydrateIcons();
renderAll();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
