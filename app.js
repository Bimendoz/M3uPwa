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
  settings: { format: "iptv", ghToken: "", cartvOnly: true, searchCount: 0, langMode: "latam", countries: [], portableOnly: true, ...store.get("m3u.settings", {}) },
  showAll: false, // mostrar también lo que no pasó (o no se pudo confirmar) la prueba como CarTV
  view: "vSearch", listCat: "*",
  search: null // { query, running, step, tried, failed:[], found:[] }
};
// Una sola vez: el formato viejo por defecto («both») pasa a «iptv», que es el que CarTV entiende
// v5.2: «no omitir ningún link» → las búsquedas pasan a probar TODOS los links (se puede volver a poner un número)
if (!S.settings.allLinksV1) { S.settings.searchCount = 0; S.settings.allLinksV1 = true; store.set("m3u.settings", S.settings); }
if (!S.settings.fmtV2) { if (S.settings.format === "both") S.settings.format = "iptv"; S.settings.fmtV2 = true; store.set("m3u.settings", S.settings); }
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
const touch = (list) => { list.dirty = true; save(); if (list.id === "sync") syncSoon(); };
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
      // también dentro de un token (hdnts=exp=…~ip=1.2.3.4~acl=…)
      const im = v.match(/(?:^|[~&;,:])(ip|clientip|cip|asn)=([\d.:a-f]{2,})/i);
      if (im && (/asn/i.test(im[1]) ? /^\d{2,10}$/.test(im[2]) : /^[\d.:a-f]{7,}$/i.test(im[2]))) return /asn/i.test(im[1]) ? "red" : "ip";
    }
  } catch {}
  return "";
}

// ¿Sirve fuera de la red donde se sacó? "" = sí · texto = por qué no (mismo criterio que la extensión)
const portableOn = () => S.settings.portableOnly !== false;
function portableIssue(url, canRenew) {
  if (networkLock(url)) return "amarrado a la red donde se sacó: no funciona con datos ni en otra red";
  const exp = tokenExpiry(url);
  if (exp && exp - Date.now() < 6 * 3600e3 && !canRenew) return `el link vence ${exp <= Date.now() ? "ya" : "en " + Math.max(1, Math.round((exp - Date.now()) / 60e3)) + " min"} y no hay página para renovarlo`;
  return "";
}

// ---------- M3U ----------
// both = VLC + apps IPTV · iptv = CarTV/Kodi (url|User-Agent=…&Referer=…) · vlc = solo VLC
// User-Agent de la lista = el del ejemplo que funciona en CarTV (Blu Radio): Chrome de escritorio, MISMO que la extensión.
const CARTV_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
function m3uEntry(it, group, format) {
  const q = (v) => oneLine(v).replace(/"/g, "'");
  const ua = oneLine(it.ua) || CARTV_UA;
  let a = ` tvg-name="${q(it.name)}"`;
  if (it.tvgId) a += ` tvg-id="${q(it.tvgId)}"`;
  if (it.logo) a += ` tvg-logo="${q(it.logo)}"`;
  if (group) a += ` group-title="${q(group)}"`;
  const ref = it.referer ? oneLine(it.referer) : "";
  // «Apps IPTV» (CarTV): SIEMPRE con User-Agent (atributo, #EXTHTTP y «|User-Agent=»), como el ejemplo que funciona
  const iptv = format === "iptv", yt = /youtube\.com|youtu\.be/i.test(it.url);
  if (!yt && (iptv || (ref && format !== "vlc"))) a += (ref ? ` http-referrer="${q(ref)}"` : "") + ` http-user-agent="${q(ua)}"`;
  let s = `#EXTINF:-1${a},${q(it.name)}\n`;
  if (ref && format !== "iptv") s += `#EXTVLCOPT:http-referrer=${ref}\n#EXTVLCOPT:http-user-agent=${ua}\n`;
  if (!yt && (iptv || (ref && format !== "vlc"))) s += `#EXTHTTP:${JSON.stringify(ref ? { "User-Agent": ua, Referer: ref } : { "User-Agent": ua })}\n`;
  let u = it.url;
  if (!yt && iptv) u += `|User-Agent=${encodeURIComponent(ua)}` + (ref ? `&Referer=${encodeURIComponent(ref)}` : "");
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
      cur.logo = g("tvg-logo"); cur.group = g("group-title"); cur.tvgId = g("tvg-id"); cur.referer = g("http-referrer") || cur.referer || ""; cur.ua = g("http-user-agent") || cur.ua || "";
    } else if (l.startsWith("#EXTVLCOPT:http-referrer=")) cur.referer = l.slice(25);
    else if (l.startsWith("#EXTVLCOPT:http-user-agent=")) cur.ua = l.slice(27);
    else if (l.startsWith("#EXTHTTP:")) { try { const j = JSON.parse(l.slice(9)); if (j.Referer) cur.referer = j.Referer; if (j["User-Agent"]) cur.ua = j["User-Agent"]; } catch {} }
    else if (!l.startsWith("#")) {
      let url = l;
      const p = l.indexOf("|");
      if (p > 0) { url = l.slice(0, p); const pp = new URLSearchParams(l.slice(p + 1)); if (pp.get("Referer")) cur.referer = pp.get("Referer"); if (pp.get("User-Agent")) cur.ua = pp.get("User-Agent"); }
      if (/^https?:\/\//i.test(url)) out.push({ name: cur.name || hostOf(url) || "Canal", url, referer: cur.referer || "", logo: cur.logo || "", group: cur.group || "", tvgId: cur.tvgId || "", ua: cur.ua || "" });
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
async function findRelayGist() {
  const hits = [];
  for (let page = 1; page <= 3; page++) {
    const list = await ghApi(`/gists?per_page=100&page=${page}`);
    hits.push(...list.filter((g) => g.description === RELAY_DESC));
    if (list.length < 100) break;
  }
  hits.sort((x, y) => String(x.created_at || "").localeCompare(String(y.created_at || "")) || String(x.id).localeCompare(String(y.id)));
  return hits[0]?.id || "";
}
// Si hubiera más de un Gist del puente, los dos lados eligen el más antiguo (se revisa cada 10 min)
async function relayGistId() {
  if (S.settings.relayGistId && Date.now() - (S.settings.relayGistAt || 0) < 10 * 60e3) return S.settings.relayGistId;
  let id = await findRelayGist();
  if (!id) {
    await ghApi("/gists", { method: "POST", body: JSON.stringify({ description: RELAY_DESC, public: false,
      files: { "LEEME.md": { content: "Puente entre la extensión HLS Stream Detector y la app Listas M3U del iPhone. No lo borres." } } }) });
    id = await findRelayGist();
  }
  S.settings.relayGistId = id; S.settings.relayGistAt = Date.now(); save({ republish: false });
  return id;
}
// Encarga a la extensión una búsqueda ({query}) o una extracción ({pageUrl}) y espera la respuesta.
async function relayJob(payload, job, my, raw = false, o = {}) {
  const alive = o.alive || (() => my === searchToken), redraw = o.render || renderSearch;
  job.step = "Enviando el encargo a tu computador…"; job.viaPc = true; redraw();
  const triedBase = job.tried || 0; // lo que ya probó el iPhone + lo que pruebe el computador
  let id = await relayGistId();
  const rid = uid();
  try { await ghApi(`/gists/${id}`, { method: "PATCH", body: JSON.stringify({ files: { [`req-${rid}.json`]: { content: JSON.stringify({ ...payload, at: Date.now() }) } } }) }); }
  catch (e) { if (!/404/.test(e.message)) throw e; S.settings.relayGistId = ""; S.settings.relayGistAt = 0; id = await relayGistId(); await ghApi(`/gists/${id}`, { method: "PATCH", body: JSON.stringify({ files: { [`req-${rid}.json`]: { content: JSON.stringify({ ...payload, at: Date.now() }) } } }) }); }
  job.step = "Esperando a tu computador (revisa cada 30 s)…"; redraw();
  const t0 = Date.now();
  let acked = false, lastAt = 0, lastMove = Date.now();
  while (alive()) {
    await new Promise((r) => setTimeout(r, 5000));
    if (!alive()) break;
    let g;
    try { g = await ghApi(`/gists/${id}`); } catch { continue; }
    const f = g.files[`res-${rid}.json`];
    if (f) {
      let res = null;
      try { res = JSON.parse(f.truncated ? await (await fetchT(f.raw_url)).text() : f.content); } catch {}
      if (res) {
        acked = true;
        if (res.at !== lastAt) { lastAt = res.at; lastMove = Date.now(); } // el computador sigue avanzando
        job.step = "Tu computador: " + res.step; if (!raw) job.tried = triedBase + (res.tried || 0);
        if (Array.isArray(res.pages)) job.pages = res.pages;
        redraw();
        if (res.status === "done") {
          ghApi(`/gists/${id}`, { method: "PATCH", body: JSON.stringify({ files: { [`res-${rid}.json`]: null } }) }).catch(() => {});
          for (const x of res.failed || []) job.failed.push({ host: x.host, why: "(computador) " + x.why });
          return raw ? res : res.found || [];
        }
      }
    }
    if (!acked && Date.now() - t0 > 100000) {
      ghApi(`/gists/${id}`, { method: "PATCH", body: JSON.stringify({ files: { [`req-${rid}.json`]: null } }) }).catch(() => {});
      throw new Error("Tu computador no respondió. Revisa que esté prendido con Chrome abierto, y que la extensión esté conectada al mismo GitHub (Opciones, «Puente con la app del iPhone»).");
    }
    if (acked && Date.now() - lastMove > 4 * 60e3) throw new Error("Tu computador dejó de responder. Intenta de nuevo.");
  }
  return [];
}
// Lo que devuelve el computador se prueba otra vez aquí (si no necesita Referer), para saber si sirve en ESTE equipo
async function addPcResults(found, job, my) {
  for (const f of found) {
    if (my !== searchToken || job.found.some((x) => x.key === keyOf(f.url))) continue;
    const item = { car: f.car, tier: f.tier || sourceInfo(f.url, { pageUrl: f.pageUrl }).tier, tierWhy: f.tierWhy || [], url: f.url, referer: f.referer || "", name: f.name, logo: f.thumb || "", tvgId: f.tvgId || "", key: keyOf(f.url),
      live: f.live, res: f.res ? String(f.res).split("x").pop() + "p" : "", verifiedAt: f.verifiedAt || Date.now(), lock: networkLock(f.url), exp: tokenExpiry(f.url), viaPc: true,
      lang: f.lang || "", audio: f.audio || [], country: f.country || "" };
    const pi = portableOn() ? portableIssue(f.url, !!f.pageUrl) : "";
    if (pi) { job.failed.push({ host: hostOf(f.url), why: pi }); renderSearch(); continue; }
    if (f.needs === "referer") item.note = "Probado por tu computador (necesita Referer: Safari no puede probarlo)";
    else {
      job.step = `Probando aquí ${hostOf(f.url)}…`; renderSearch();
      try { const r = await verifyVideo(f.url); item.res = r.h ? r.h + "p" : item.res; item.note = "Apto CarTV y también abre en este celular"; }
      catch (e) { item.note = `Apto CarTV (probado por tu computador) · en Safari no abrió: ${e.message}`; }
    }
    job.found.push(item); renderSearch();
  }
}

// ---------- ¿de dónde viene el link? (mismo código en la extensión y en la PWA) ----------
// official  -> sale de la página del canal o de su mismo dominio
// cdn       -> plataforma profesional de video (Mediastream, Akamai, CloudFront, Wowza…): casi siempre la del canal
// unofficial-> IP suelta, puerto raro, DNS casero o panel IPTV de terceros: suele caerse o bloquear
// unknown   -> no se puede saber
const PRO_CDN = /(^|\.)(mdstrm\.com|mediastre\.am|akamaized\.net|akamaihd\.net|akamai\.net|cloudfront\.net|fastly\.net|fastlylb\.net|llnwd\.net|llnwi\.net|edgecastcdn\.net|azureedge\.net|streamlock\.net|wowza\.com|bcovlive\.io|brightcove\.(com|net)|jwpcdn\.com|jwplayer\.com|dailymotion\.com|dmcdn\.net|ttvnw\.net|cdn77\.org|cdnvideo\.ru|vimeocdn\.com|amagi\.tv|cloudflarestream\.com|videodelivery\.net|mediapackage\.[\w-]+\.amazonaws\.com|mediatailor\.[\w-]+\.amazonaws\.com|zype\.com|castr\.(io|com)|hlsliveamdgl|googlevideo\.com|youtube\.com|livestream\.com|ustream\.tv|kaltura\.com|vhx\.tv|lldns\.net|footprint\.net|level3\.net|limelight\.com|b-cdn\.net|bunnycdn\.com|gcdn\.co|streamhoster\.com|tulix\.tv|streann\.com|mux\.com|dacast\.com|boxcast\.io|ottera\.tv)$/i;
const HOME_DNS = /(^|\.)(ddns\.net|duckdns\.org|no-ip\.(com|org|biz|info)|noip\.me|myftp\.(org|biz)|hopto\.org|zapto\.org|sytes\.net|servehttp\.com|serveftp\.com|dyndns\.(org|info|tv)|dynu\.net|freeddns\.org|ddnsking\.com|3utilities\.com|mooo\.com)$/i;
function isIpHost(h) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || /^\[/.test(h); }
function baseDomain(host) {
  host = (host || "").toLowerCase().replace(/^www\./, "");
  if (!host || isIpHost(host)) return host;
  const p = host.split(".");
  if (p.length > 2 && p[p.length - 1].length === 2 && /^(com|gov|gob|net|org|edu|co|ac|mil|tv)$/.test(p[p.length - 2])) return p.slice(-3).join(".");
  return p.slice(-2).join(".");
}
function sourceInfo(url, ctx = {}) {
  let u; try { u = new URL(url); } catch { return { tier: "unknown", why: ["link inválido"] }; }
  const host = u.hostname.replace(/^\[|\]$/g, ""), why = [];
  const dom = (x) => { try { return baseDomain(new URL(x).hostname); } catch { return ""; } };
  const sameOfficial = !!ctx.website && dom(ctx.website) === baseDomain(host);
  const samePage = !!ctx.pageUrl && dom(ctx.pageUrl) === baseDomain(host);
  const sameSite = sameOfficial || samePage;
  const port = u.port && !["80", "443"].includes(u.port) ? u.port : "";
  const xtream = /\/(live|movie|series)\/[^/]+\/[^/]+\/\d+(\.\w+)?$/i.test(u.pathname) || /\/get\.php$/i.test(u.pathname) || /[?&](username|password)=/i.test(u.search);
  if (isIpHost(host)) why.push("servidor sin dominio, solo una dirección IP");
  if (port) why.push(`puerto no estándar (${port})`);
  if (HOME_DNS.test(host)) why.push("dominio de IP dinámica (servidor casero)");
  if (xtream) why.push("formato de panel IPTV de terceros");
  if (u.protocol === "http:") why.push("sin cifrar (http)");
  const bad = isIpHost(host) || HOME_DNS.test(host) || xtream || (port && !sameSite);
  if (sameOfficial && !bad) return { tier: "official", why: ["mismo dominio que la página oficial del canal"] };
  if (ctx.fromOfficialPage && !bad) return { tier: "official", why: ["lo pide el reproductor de la página oficial del canal"] };
  if (samePage && !bad) return { tier: "page", why: ["del mismo sitio donde lo encontraste (" + baseDomain(host) + "); no se sabe si es el oficial del canal"] };
  if (bad) return { tier: "unofficial", why };
  if (PRO_CDN.test(host)) return { tier: "cdn", why: ["plataforma profesional de video (" + baseDomain(host) + ")"] };
  return { tier: "unknown", why: why.length ? why : ["dominio " + baseDomain(host) + " (no se puede confirmar si es del canal)"] };
}
const TIER_LABEL = { official: "Oficial", cdn: "Plataforma", page: "De la página", unknown: "Sin confirmar", unofficial: "No oficial" };
const TIER_RANK = { official: 0, cdn: 1, page: 2, unknown: 3, unofficial: 4 };
const tierOf = (item) => (item.tier ? { tier: item.tier, why: item.tierWhy || [] } : sourceInfo(item.url, { pageUrl: item.pageUrl }));


// ---------- sincronización de canales (extensión ↔ PWA) — mismo código en los dos lados ----------
// Un solo archivo en el Gist del puente guarda la lista compartida: { items, tomb, categories, catU, pub }.
// Cada canal lleva _u (cuándo cambió). Gana el cambio más reciente; lo borrado deja una «lápida» (tomb)
// para que el otro lado no lo vuelva a agregar. «base» es lo último que este equipo sincronizó: comparando
// contra ella se sabe qué cambió aquí sin tener que marcar cada edición a mano.
const SYNC_FILE = "canales-sync.json";
const SHARED_FIELDS = ["key", "url", "kind", "referer", "name", "group", "thumb", "live", "tvgId", "tier", "tierWhy", "pageUrl", "useChannel", "channelLive", "ytId", "author", "car"];
// car = { ok, verdict, why, at }: última prueba «como CarTV» hecha por el computador (ok/referer = apto)
const carFrom = (verdict, why = "") => ({ ok: verdict === "ok" || verdict === "referer", verdict, why, at: Date.now() });
function shareOf(it) {
  const o = {};
  for (const f of SHARED_FIELDS) if (it[f] !== undefined && it[f] !== null && it[f] !== "") o[f] = it[f];
  return o;
}
function syncMerge(localItems, localCats, base, remote, now = Date.now()) {
  base = base || {}; remote = remote || {};
  const bh = base.hashes || {}, bu = base.u || {};
  const tomb = { ...(remote.tomb || {}) };
  const local = localItems.map((it) => {
    const s = shareOf(it), h = JSON.stringify(s);
    return { ...s, _u: bh[s.key] === h ? (bu[s.key] || 1) : now }; // cambió aquí desde la última vez -> ahora
  });
  const localKeys = new Set(local.map((x) => x.key));
  for (const k of Object.keys(bh)) if (!localKeys.has(k)) tomb[k] = Math.max(tomb[k] || 0, now); // borrado aquí
  const out = new Map();
  for (const it of remote.items || []) out.set(it.key, it);
  for (const it of local) { const r = out.get(it.key); if (!r || it._u >= (r._u || 0)) out.set(it.key, it); }
  for (const [k, t] of Object.entries(tomb)) {
    const it = out.get(k);
    if (it && (it._u || 0) <= t) out.delete(k);
    if (now - t > 60 * 864e5) delete tomb[k]; // las lápidas viejas se limpian a los 60 días
  }
  // categorías: la primera vez se juntan; después gana el cambio más reciente
  const lc = localCats || [], rc = remote.categories;
  let categories, catU;
  if (base.cats === undefined) { categories = [...new Set([...(rc || []), ...lc])]; catU = now; }
  else if (JSON.stringify(lc) !== base.cats && now >= (remote.catU || 0)) { categories = lc; catU = now; }
  else { categories = rc || lc; catU = remote.catU || now; }
  const items = [...out.values()];
  const hashes = {}, u = {};
  for (const it of items) { const { _u, ...s } = it; hashes[it.key] = JSON.stringify(shareOf(s)); u[it.key] = _u || 1; }
  return { items, tomb, categories, catU, base: { hashes, u, cats: JSON.stringify(categories) } };
}
// Rehace la lista local con lo sincronizado, conservando los datos que solo existen en este equipo
function syncApply(localItems, mergedItems, toLocal) {
  const byKey = new Map(localItems.map((x) => [x.key, x]));
  return mergedItems.map((s) => {
    const { _u, ...shared } = s;
    const old = byKey.get(s.key);
    if (!old) return toLocal ? toLocal(shared, null) : { ...shared, addedAt: Date.now() };
    const keep = { ...old };
    for (const f of SHARED_FIELDS) delete keep[f];
    return toLocal ? toLocal(shared, keep) : { ...keep, ...shared };
  });
}

// La lista con id "sync" es la misma que «Guardados» de la extensión
let syncBusy = false, syncAgain = false, syncTimer = null;
function ensureSyncList() {
  if (S.lists.some((l) => l.id === "sync")) return;
  const l = activeList();
  l.id = "sync";
  if (l.name === "Mi lista") l.name = "Mis canales";
  S.active = "sync";
  save({ republish: false });
}
const syncPubLink = () => { const p = S.settings.syncPub; return p?.gistId && p.owner ? `https://gist.githubusercontent.com/${p.owner}/${p.gistId}/raw/${p.file || "lista.m3u"}` : ""; };
async function pwaSync(reason = "auto") {
  if (!S.settings.ghToken) return;
  ensureSyncList();
  if (syncBusy) { syncAgain = true; return; }
  syncBusy = true;
  try {
    const list = S.lists.find((l) => l.id === "sync");
    const id = await relayGistId();
    const g = await ghApi(`/gists/${id}`);
    const f = g.files[SYNC_FILE];
    let remote = {};
    if (f) { try { remote = JSON.parse(f.truncated ? await (await fetchT(f.raw_url)).text() : f.content); } catch {} }
    const localShared = list.items.map((it) => ({ ...it, thumb: it.logo || it.thumb || "", kind: it.kind || "hls" }));
    const m = syncMerge(localShared, list.categories, S.settings.syncBase, remote);
    const next = { v: 1, items: m.items, tomb: m.tomb, categories: m.categories, catU: m.catU, pub: remote.pub };
    const changedRemote = JSON.stringify(next) !== JSON.stringify({ v: remote.v, items: remote.items, tomb: remote.tomb, categories: remote.categories, catU: remote.catU, pub: remote.pub });
    if (changedRemote) await ghApi(`/gists/${id}`, { method: "PATCH", body: JSON.stringify({ files: { [SYNC_FILE]: { content: JSON.stringify({ ...next, at: Date.now() }) } } }) });
    list.items = syncApply(localShared, m.items, (sh, keep) => ({ id: keep?.id || uid(), status: "", verifiedAt: 0, ...(keep || {}), ...sh, logo: sh.thumb || "" }));
    list.categories = m.categories;
    S.settings.syncBase = m.base;
    S.settings.syncPub = remote.pub || S.settings.syncPub || null;
    S.settings.syncMeta = { lastSync: Date.now(), count: list.items.length, error: "" };
    save({ republish: false });
    // el link fijo de la extensión (el que tienes en CarTV) se actualiza también desde aquí
    if (changedRemote && remote.pub?.gistId) {
      ghApi(`/gists/${remote.pub.gistId}`, { method: "PATCH", body: JSON.stringify({ files: { [remote.pub.file || "lista.m3u"]: { content: m3uText(list) } } }) }).catch(() => {});
    }
    if (S.view === "vLists" && $("#sheet").hidden) renderLists();
    renderHeader();
  } catch (e) {
    S.settings.syncMeta = { ...(S.settings.syncMeta || {}), error: e.message, lastTry: Date.now() };
    save({ republish: false });
    if (S.view === "vLists" && $("#sheet").hidden) renderLists();
  } finally {
    syncBusy = false;
    if (syncAgain) { syncAgain = false; setTimeout(() => pwaSync("repetir"), 500); }
  }
}
function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(() => pwaSync("cambio"), 2500); }

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
// (los /live-stream-playlist/ de Mediastream funcionan sin sesión: ejemplo de Blu Radio en CarTV)
const needsPlayerSession = (url) => { try { const u = new URL(url); return /(^|\.)(mdstrm\.com|mediastream\.[a-z.]+)$/i.test(u.hostname) && !u.searchParams.has("player") && !/\/live-stream-playlist\//i.test(u.pathname); } catch { return false; } };
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
async function candidates(query, mode = "any", wantCountries = []) {
  mode = langMode(mode);
  const want = cleanCountries(wantCountries);
  const [channels, streams] = await Promise.all([dirJson("channels"), dirJson("streams")]);
  let logos = [], feeds = [], countries = [];
  try { logos = await dirJson("logos"); } catch {}
  try { [feeds, countries] = await Promise.all([dirJson("feeds"), dirJson("countries")]); } catch {}
  const idx = buildLangIndex(feeds, countries);
  const byId = new Map(channels.map((c) => [c.id, c]));
  const feedsOf = new Map();
  for (const f of feeds) { if (!feedsOf.has(f.channel)) feedsOf.set(f.channel, []); feedsOf.get(f.channel).push(f); }
  const chOk = (c) => (feedsOf.get(c.id) || [null]).some((f) => { const s0 = { channel: c.id, feed: f?.id };
    return langOk(streamLang(s0, c, idx), mode) && countryOk(c.country, streamAreas(s0, idx), want); });
  const cc = userCountry();
  const scored = [];
  for (const c of channels) {
    if (c.is_nsfw || c.closed) continue;
    const best = Math.max(nameScore(query, c.name), ...(c.alt_names || []).map((a) => nameScore(query, a)));
    if (best && chOk(c)) scored.push({ c, score: best + (cc && c.country === cc ? 8 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = new Map(scored.map((x) => [x.c.id, x])); // TODOS los canales que coinciden
  const logoOf = (id) => byId.get(id)?.logo || logos.find((l) => l.channel === id)?.url || "";
  const out = [];
  for (const s of streams) {
    if (!s.url || !/\.m3u8(\?|$)/i.test(s.url)) continue;
    const hit = top.get(s.channel);
    const ts = !hit && s.title ? nameScore(query, s.title) : 0;
    if (!hit && ts < 70) continue;
    const ch = hit?.c || byId.get(s.channel) || null;
    const lang = streamLang(s, ch, idx);
    if (!langOk(lang, mode) || !countryOk(ch?.country || "", streamAreas(s, idx), want)) continue;
    out.push({ url: s.url, referer: s.referrer || "", name: hit ? hit.c.name : s.title, logo: ch ? logoOf(ch.id) : "",
      tvgId: ch ? ch.id : "", website: ch?.website || "", country: ch?.country || "", score: hit ? hit.score : ts, lang: lang.label, langInfo: lang });
  }
  // español latino primero; dentro de cada idioma, el nombre que más se parece
  out.sort((a, b) => (mode === "any" ? 0 : langRank(a.langInfo) - langRank(b.langInfo)) || b.score - a.score);
  const sites = [...new Set(scored.filter((x) => x.score >= 60 && x.c.website).map((x) => x.c.website))];
  return { streams: out, sites };
}

// ---------- prueba real: reproducir en un <video> oculto ----------
// Safari reproduce HLS igual que las apps del iPhone. Solo cuenta como "funciona" si el video AVANZA de verdad.
// Safari da el mismo error para cosas distintas: se revisa la lista para decir el motivo real
async function diagnose(url, referer = "") {
  if (referer) return "este canal exige Referer y Safari no puede mandarlo; en CarTV (formato «Apps IPTV») sí puede funcionar";
  const exp = tokenExpiry(url);
  if (exp && exp < Date.now()) return "el token del link ya venció: hay que renovarlo desde su página";
  let r;
  try { r = await fetchT(url, 8000); }
  catch (e) { return e.name === "AbortError" ? "el servidor no respondió a tiempo (caído o bloquea tu red)" : "el servidor no deja revisarlo desde la web; puede que en CarTV sí funcione. Usa «Diagnosticar con mi computador»"; }
  if (r.status === 403 || r.status === 401) return `el servidor lo bloquea (${r.status}): exige Referer, sesión, o no acepta tu red o país`;
  if (r.status === 404 || r.status === 410) return `el link ya no existe (${r.status}): el canal cambió de dirección`;
  if (!r.ok) return `el servidor respondió ${r.status}`;
  const text = await r.text().catch(() => "");
  if (!text.trimStart().startsWith("#EXTM3U")) return "el link no devuelve una lista de video (puede ser una página o un error)";
  if (/KEYFORMAT="?(com\.widevine|com\.microsoft|com\.apple\.streamingkeydelivery)|METHOD=SAMPLE-AES/i.test(text)) return "el video tiene DRM (protección): solo se ve en la app o página oficial";
  if (/CODECS="[^"]*(hvc1|hev1)/i.test(text)) return "el video es H.265/HEVC: este equipo o la app puede no soportarlo";
  if (/CODECS="[^"]*av01/i.test(text)) return "el video es AV1: muchos equipos no lo soportan";
  return "la lista responde pero el video no arranca aquí; prueba «Diagnosticar con mi computador»";
}
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
    v.addEventListener("error", () => { const code = v.error?.code; diagnose(url).then((m) => finish(new Error(code === 3 ? mediaError(v) : m)), () => finish(new Error(mediaError(v)))); });
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
const MAX_FOUND = Infinity, MAX_TESTS = Infinity; // sin límite: se prueban todos y tú eliges cuáles agregar
// Orden estricto: un link a la vez, en el orden de la búsqueda; con «parar en el primero» termina apenas uno funciona
// «Links a probar»: igual que la extensión, cada búsqueda prueba exactamente esa cantidad, uno por uno y en orden
// (directorio aquí en el iPhone → sitio oficial y web con tu computador). No se detiene aunque alguno funcione.
const searchCountOf = (v) => (v === "" || v == null || !Number.isFinite(+v) ? 0 : Math.max(0, Math.round(+v))); // 0 = todos
const goalOf = () => searchCountOf(S.settings.searchCount);
const searchDone = (job) => job.goal > 0 && job.tried >= job.goal; // goal 0 = todos: nunca «ya basta»
let searchToken = 0;
async function runSearch(query) {
  query = cleanTitle(query);
  if (!query) return;
  const my = ++searchToken;
  const job = S.search = { query, goal: goalOf(), running: true, step: "Buscando en el directorio de canales…", tried: 0, failed: [], found: [], untested: [], sites: [] };
  renderSearch();
  try {
    const { streams, sites } = await candidates(query, S.settings.langMode, S.settings.countries);
    job.sites = sites;
    const list = streams.slice(0, MAX_TESTS);
    job.step = list.length ? `Directorio: ${list.length} link(s) del canal · los reproduzco uno por uno, en orden${job.goal ? ` (meta: ${job.goal})` : " (todos)"}…` : "No está en el directorio de canales.";
    renderSearch();
    const seen = new Set();
    const conc = 1; // de a uno, en el orden de la búsqueda
    const q = [...list];
    await Promise.all(Array.from({ length: conc }, async () => {
      while (q.length && my === searchToken && !searchDone(job)) {
        const c = q.shift();
        const k = keyOf(c.url);
        if (seen.has(k)) continue;
        seen.add(k);
        job.tried++; renderSearch();
        const pi = portableOn() ? portableIssue(c.url, !!c.website) : "";
        if (pi) { job.failed.push({ host: hostOf(c.url), why: pi }); renderSearch(); continue; }
        try {
          const r = await verifyVideo(c.url, 12000);
          if (my !== searchToken) return;
          const si = sourceInfo(c.url, { website: c.website });
          job.found.push({ ...c, tier: si.tier, tierWhy: si.why, key: k, live: r.live, res: r.h ? r.h + "p" : r.audioOnly ? "solo audio" : "", verifiedAt: Date.now(), lock: networkLock(c.url), exp: tokenExpiry(c.url) });
        } catch (e) {
          // lo que importa es CarTV, no Safari: lo que aquí no abre lo prueba tu computador como CarTV
          const si = sourceInfo(c.url, { website: c.website });
          job.untested.push({ ...c, tier: si.tier, tierWhy: si.why, key: k, safariWhy: c.referer ? "necesita Referer" : e.message });
        }
        renderSearch();
      }
    }));
    if (my !== searchToken) return;
    job.step = job.found.length ? `${job.found.length} link(s) verificado(s) de ${job.tried} probado(s).` : list.length ? `Probé ${job.tried} link(s) y ninguno funcionó.` : "No encontré ese canal en el directorio.";
    await confirmCarTV(job, my);
    if (my !== searchToken) return;
    // Igual que la extensión: si con el directorio no se completan los links pedidos, sigue con el sitio oficial y
    // la web hasta completarlos. Safari no puede abrir páginas por detrás: eso lo hace tu computador.
    if (!searchDone(job) && S.settings.ghToken && job.pcState !== "off") { // si el computador ya no respondió, no se le vuelve a esperar
      const had = job.found.length;
      job.pcSearched = true;
      await addPcResults(await relayJob({ query, skipDirTests: q.length === 0, searchCount: job.goal ? job.goal - job.tried : 0, langMode: langMode(S.settings.langMode), countries: cleanCountries(S.settings.countries), portableOnly: portableOn() }, job, my), job, my);
      if (my !== searchToken) return;
      job.viaPc = false;
      job.step = `${job.found.length} funcionan de ${job.tried} probado(s)${job.found.length > had ? ` · ${job.found.length - had} por tu computador (sitio oficial y web)` : ""}.`;
    } else if (!searchDone(job) && !S.settings.ghToken) job.step += ` Llevo ${job.tried}${job.goal ? ` de ${job.goal}` : ""}: para seguir con el sitio oficial y la web, conecta en Ajustes el mismo GitHub de la extensión.`;
    if (job.goal && job.tried < job.goal) job.step += ` Pediste ${job.goal}, pero solo encontré ${job.tried} link(s) para probar.`;
  } catch (e) {
    if (my !== searchToken) return;
    job.step = job.viaPc ? e.message : "No se pudo leer el directorio de canales. Revisa tu conexión e intenta de nuevo.";
  } finally {
    if (my === searchToken) { job.running = false; renderSearch(); }
  }
}
// Pide al computador la prueba «como CarTV» de todo lo encontrado (también lo que Safari no pudo probar).
// Sin computador disponible, los resultados quedan marcados «probado solo en el iPhone».
async function confirmCarTV(job, my) {
  const pool = [...job.found, ...(job.untested || [])].filter((f) => !f.car);
  if (!pool.length) return;
  if (!S.settings.ghToken) { job.pcState = "none"; return; }
  job.pcState = "confirming"; renderSearch();
  const done = job.step;
  try {
    const res = await relayJob({ checkUrls: pool.map((f) => ({ url: f.url, referer: f.referer || "" })) }, job, my, true);
    if (my !== searchToken) return;
    for (const c of res?.checks || []) {
      const f = pool.find((x) => x.url === c.url);
      if (!f) continue;
      f.car = carFrom(c.verdict, c.why);
      if (f.car.ok && job.untested?.includes(f)) { job.untested = job.untested.filter((x) => x !== f); job.found.push(f); }
    }
    job.pcState = "done";
    const ok = job.found.filter((f) => f.car?.ok).length;
    job.step = `${ok} apto(s) para CarTV · confirmado por tu computador.`;
  } catch {
    job.pcState = "off";
    job.step = done + " Tu computador no respondió: probados solo en el iPhone.";
  } finally {
    job.viaPc = false;
    // se deja el orden de la búsqueda
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
        if (my !== searchToken) break;
        job.tried++; job.step = `Probando ${hostOf(u)}…`; renderSearch();
        try { const r = await verifyVideo(u); const si = sourceInfo(u, { pageUrl }); job.found.push({ tier: si.tier, tierWhy: si.why, url: u, name: title, key: keyOf(u), live: r.live, res: r.h ? r.h + "p" : "", verifiedAt: Date.now(), lock: networkLock(u), exp: tokenExpiry(u), referer: "" }); }
        catch (e) { job.failed.push({ host: hostOf(u), why: e.message }); }
      }
    } else job.failed.push({ host: hostOf(pageUrl), why: "Safari no deja leer esa página desde otra web (normal)" });
    // 2) con el computador: abre la página en Chrome, le da play y captura lo que pide el reproductor
    if (!job.found.length && my === searchToken) {
      if (!S.settings.ghToken) { job.step = "Aquí no encontré el video. Para sacarlo con tu computador, conecta en Ajustes el mismo GitHub de la extensión."; return; }
      await addPcResults(await relayJob({ pageUrl }, job, my), job, my);
    }
    if (my !== searchToken) return;
    if (job.found.some((f) => !f.car)) await confirmCarTV(job, my);
    if (my !== searchToken) return;
    job.step = job.pcState === "done" ? job.step : job.found.length ? `${job.found.length} link(s) encontrado(s).` : job.viaPc ? job.step.replace(/^Tu computador: /, "Tu computador: ") : "No encontré ningún video en esa página.";
  } catch (e) {
    if (my === searchToken) job.step = e.message;
  } finally {
    if (my === searchToken) { job.running = false; renderSearch(); }
  }
}
async function runPcSearch(query) {
  const my = ++searchToken;
  const job = S.search = { query, running: true, step: "", tried: 0, failed: [], found: [], sites: [], viaPc: true };
  try { job.goal = goalOf(); await addPcResults(await relayJob({ query, searchCount: job.goal, langMode: langMode(S.settings.langMode), countries: cleanCountries(S.settings.countries), portableOnly: portableOn() }, job, my), job, my); if (my === searchToken) job.step = job.found.length ? `${job.found.length} link(s) encontrado(s) por tu computador.` : job.step; }
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
    el("div", { class: "meta" }, `${j.tried}${j.goal ? ` de ${j.goal}` : ""} probado(s) · ${j.found.length} verificado(s) · ${j.failed.length} descartado(s)`));
  if (j.pages?.length) st.append(el("details", {}, el("summary", {}, `Páginas revisadas (${j.pages.length})`),
    el("ul", {}, j.pages.map((p) => el("li", {}, `${p.found ? "✓" : "·"} ${p.url.replace(/^https?:\/\/(www\.)?/, "")}${p.found ? ` — ${p.found} link(s)` : ""}`)))));
  if (j.failed.length) st.append(el("details", {}, el("summary", {}, "Ver por qué se descartaron"), el("ul", {}, j.failed.slice(-15).map((f) => el("li", {}, `${f.host}: ${f.why}`)))));
  out.append(st);
  if (j.found.length) {
    const c = {}; j.found.forEach((f) => { const t = tierOf(f).tier; c[t] = (c[t] || 0) + 1; });
    out.append(el("p", { class: "hint" }, "Funcionan: " + ["official", "cdn", "page", "unknown", "unofficial"].filter((t) => c[t]).map((t) => `${c[t]} ${TIER_LABEL[t].toLowerCase()}`).join(" · ") + ". Tú eliges cuáles agregar."));
  }
  const hasOfficial = j.found.some((f) => ["official", "cdn"].includes(tierOf(f).tier) && !needsPlayerSession(f.url));
  if (!j.running && !hasOfficial && !j.pageUrl && !j.viaPc && !j.pcSearched) {
    out.append(el("p", { class: "hint" }, j.found.length
      ? "Ninguno es oficial. Si quieres, tu computador (si está prendido) saca el link de la página oficial:"
      : "Prueba con otro nombre (sin «canal» ni «TV»), pega arriba el link de la página donde lo ves, o pídele a tu computador que lo busque en la web y en su página oficial:"),
      el("button", { class: "btn", style: "width:100%", onclick: () => (S.settings.ghToken ? runPcSearch(j.query) : (toast("Conecta GitHub en Ajustes"), setView("vSettings"))) }, icon("laptop"), "Buscar con mi computador"));
    for (const s of j.sites) out.append(el("a", { class: "btn sm", href: s, target: "_blank", rel: "noopener", style: "display:inline-block;margin:4px 6px 0 0;text-decoration:none" }, "Abrir " + hostOf(s)));
  }
  // Solo aptos para CarTV: si el computador confirmó, se muestran solo los que pasaron; lo demás queda a un toque
  const strict = S.settings.cartvOnly && !S.showAll && j.pcState === "done";
  const shown = strict ? j.found.filter((f) => f.car?.ok) : j.found;
  const hidden = j.found.length - shown.length + (S.settings.cartvOnly && !S.showAll ? (j.untested?.length || 0) : 0);
  if (j.pcState === "confirming") out.append(el("p", { class: "hint" }, el("span", { class: "spin" }), "Confirmando con tu computador cuáles funcionan en CarTV…"));
  if (j.pcState === "off" || j.pcState === "none") out.append(el("p", { class: "hint warn" }, icon("alert", 13), j.pcState === "none"
    ? " Probados solo en el iPhone. Conecta GitHub en Ajustes para que tu computador confirme cuáles sirven en CarTV."
    : " Tu computador no respondió: estos resultados están probados solo en el iPhone."));
  if (hidden > 0 && !j.running) out.append(el("button", { class: "btn sm", style: "margin:4px 0 6px", onclick: () => { S.showAll = true; renderSearch(); } }, icon("filter", 14), `Mostrar ${hidden} que no pasaron la prueba de CarTV`));
  if (S.showAll && S.settings.cartvOnly) out.append(el("button", { class: "btn sm", style: "margin:4px 0 6px", onclick: () => { S.showAll = false; renderSearch(); } }, icon("filter", 14), "Ver solo aptos para CarTV"));
  for (const f of shown) {
    const ti = tierOf(f);
    const info = [f.car ? (f.car.ok ? "Apto CarTV" : "No apto CarTV") : f.warn ? "Verificado solo en tu computador" : j.pcState === "confirming" ? "Confirmando CarTV…" : "Probado en el iPhone", f.lang || "", audioLabel(f.audio), f.res, f.live === false ? "grabado" : "en vivo"].filter(Boolean).join(" · ");
    const weak = needsPlayerSession(f.url);
    const notes = [f.note || "", weak ? "Link sin la sesión del reproductor: puede fallar en CarTV. Mejor sácalo de la página oficial." : "", f.lock ? `Solo funciona en la red donde lo probaste (${f.lock === "ip" ? "tu IP" : "tu proveedor"})` : "", f.exp ? `Vence ${new Date(f.exp).toLocaleString()}` : ""].filter(Boolean);
    out.append(el("div", { class: "card " + (f.warn || weak ? "st-warn" : "st-ok") },
      el("div", { class: "ch" }, logoEl(f.logo), el("div", { class: "t" }, el("span", { class: "tier t-" + ti.tier, title: ti.why.join(" · ") }, TIER_LABEL[ti.tier]), el("b", {}, f.name), el("div", { class: "meta tag " + (f.car ? (f.car.ok ? "ok" : "bad") : f.warn ? "warn" : "muted") }, icon(f.car ? (f.car.ok ? "cast" : "x") : f.warn ? "alert" : "check", 12), info),
          f.car && !f.car.ok ? el("div", { class: "meta bad" }, f.car.why || "no pasó la prueba como CarTV") : null, notes.length ? el("div", { class: "meta warn" }, notes.join(" · ")) : null)),
      el("div", { class: "meta", style: "margin-top:6px" }, f.url),
      ti.tier === "unofficial" || ti.tier === "unknown" ? el("div", { class: "meta " + (ti.tier === "unofficial" ? "warn" : ""), style: "margin-top:4px" }, ti.why.join(" · ")) : null,
      el("div", { class: "acts" },
        el("button", { class: "btn primary", onclick: () => addSheet(f) }, icon("plus"), "Agregar a lista"),
        el("button", { class: "btn icon", title: "Ver", onclick: () => play(f) }, icon("play")),
        el("button", { class: "btn icon", title: "Copiar link", onclick: () => copyText(f.url, "Link copiado") }, icon("copy"))),
      weak && f.website ? el("button", { class: "btn", style: "width:100%;margin-top:8px", onclick: () => runPage(f.website) }, icon("laptop"), `Sacar link completo de ${hostOf(f.website)}`) : null));
  }
  // los que Safari no abrió (o exigen Referer) y el computador no confirmó: en CarTV pueden funcionar
  if (j.untested?.length && (!S.settings.cartvOnly || S.showAll)) {
    out.append(el("h2", {}, "Sin probar aquí", el("span", { class: "n" }, j.untested.length)),
      el("p", { class: "hint" }, "Safari no los pudo abrir y tu computador no los ha confirmado. En CarTV pueden funcionar: conecta GitHub (Ajustes) para que tu computador los pruebe como CarTV."));
    for (const f of j.untested) {
      const ti = tierOf(f);
      out.append(el("div", { class: "card st-warn" },
        el("div", { class: "ch" }, logoEl(f.logo), el("div", { class: "t" }, el("span", { class: "tier t-" + ti.tier, title: ti.why.join(" · ") }, TIER_LABEL[ti.tier]), el("b", {}, f.name),
          el("div", { class: "meta tag warn" }, icon("alert", 12), `Falta la prueba como CarTV · Safari: ${f.safariWhy || "necesita Referer"}`))),
        el("div", { class: "meta", style: "margin-top:6px" }, f.url),
        el("div", { class: "acts" }, el("button", { class: "btn", onclick: () => addSheet(f) }, icon("plus"), "Agregar igual"),
          el("button", { class: "btn icon", title: "Copiar link", onclick: () => copyText(f.url, "Link copiado") }, icon("copy")))));
    }
  }
}

// ---------- idioma y escaneo global (espejo de la extensión) ----------
S.searchMode = "search";
S.scanForm = { category: "", max: 0 }; // 0 = todos
S.countryOpen = false;
S.scanSel = new Set();
S.scan = null;
let scanToken = 0;
function renderSearchMode() {
  const lang = el("select", { class: "field", "aria-label": "Idioma" }, LANG_MODES.map(([v, t]) => el("option", { value: v }, t)));
  lang.value = langMode(S.settings.langMode);
  lang.onchange = () => { S.settings.langMode = lang.value; save({ republish: false }); toast("Idioma: " + lang.selectedOptions[0].textContent); };
  const chip = (v, ic, t) => el("button", { class: "chip" + (S.searchMode === v ? " on" : ""), type: "button", onclick: () => { S.searchMode = v; renderSearchMode(); } }, icon(ic, 14), t);
  // Países (varios a la vez): se usan en la búsqueda por nombre y en el escaneo global
  const want = cleanCountries(S.settings.countries);
  const setC = (list) => { S.settings.countries = cleanCountries(list); save({ republish: false }); renderSearchMode(); };
  const cchip = (code, label) => {
    const on = code === "" ? !want.length : want.includes(code);
    return el("button", { class: "chip" + (on ? " on" : ""), type: "button", onclick: () => code === "" ? setC([]) : setC(on ? want.filter((c) => c !== code) : [...want, code]) }, label);
  };
  const head = el("button", { class: "chip" + (want.length ? " on" : ""), type: "button", style: "width:100%;justify-content:space-between", onclick: () => { S.countryOpen = !S.countryOpen; renderSearchMode(); } },
    el("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, "Países: " + countriesLabel(want)), icon(S.countryOpen ? "x" : "plus", 14));
  put($("#searchMode"), el("div", { class: "modebar" }, chip("search", "search", "Buscar canal"), chip("scan", "globe", "Escaneo global"), lang),
    head, S.countryOpen ? el("div", { class: "chips", style: "flex-wrap:wrap" }, cchip("", "Todos"), cchip("LATAM", "Toda Latinoamérica"),
      LATAM_SPANISH.map(([c, n]) => cchip(c, n)), cchip("US", "EE. UU. (hispanos)"), cchip("ES", "España")) : null);
  $("#searchPane").hidden = S.searchMode !== "search";
  $("#scanOut").hidden = S.searchMode !== "scan";
  if (S.searchMode === "scan") renderScan();
}
// Lista del escaneo: MISMA lógica que scanList() de la extensión (lib/scan.js)
async function scanList(f) {
  const mode = langMode(f.langMode);
  const [channels, streams] = await Promise.all([dirJson("channels"), dirJson("streams")]);
  let feeds = [], countries = [], logos = [], blocked = new Set();
  try { [feeds, countries] = await Promise.all([dirJson("feeds"), dirJson("countries")]); } catch {}
  try { logos = await dirJson("logos"); } catch {}
  try { blocked = new Set((await dirJson("blocklist")).map((b) => b.channel)); } catch {}
  const idx = buildLangIndex(feeds, countries);
  const byId = new Map(channels.map((c) => [c.id, c]));
  const logoBy = new Map();
  for (const l of logos) if (!logoBy.has(l.channel)) logoBy.set(l.channel, l.url);
  const want = cleanCountries(f.countries);
  const order = SPANISH_COUNTRIES.map(([c]) => c);
  const seen = new Set(), out = [];
  for (const s of streams) {
    if (!s.url || !/\.m3u8(\?|$)/i.test(s.url)) continue;
    const ch = byId.get(s.channel);
    if (!ch || ch.closed || ch.is_nsfw || blocked.has(ch.id)) continue;
    if (f.category && !(ch.categories || []).includes(f.category)) continue;
    if (!countryOk(ch.country, streamAreas(s, idx), want)) continue;
    const lang = streamLang(s, ch, idx);
    if (!langOk(lang, mode)) continue;
    const k = keyOf(s.url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ url: s.url, referer: s.referrer || "", name: s.title || ch.name, logo: logoBy.get(ch.id) || "", tvgId: ch.id, website: ch.website || "",
      country: ch.country || "", lang: lang.label, langInfo: lang, geo: /geo-?block/i.test(s.label || "") });
  }
  const oi = (c) => { const i = order.indexOf(c); return i < 0 ? 99 : i; };
  out.sort((a, b) => (mode === "any" ? 0 : langRank(a.langInfo) - langRank(b.langInfo)) || oi(a.country) - oi(b.country)
    || String(a.country).localeCompare(String(b.country)) || String(a.name).localeCompare(String(b.name), "es"));
  return out;
}
const scanFilters = () => ({ portableOnly: portableOn(), langMode: langMode(S.settings.langMode), countries: cleanCountries(S.settings.countries), category: S.scanForm.category, max: S.scanForm.max });
// Escanear aquí (Safari): reproduce cada link, uno por uno y en orden. Los que exigen Referer no se pueden probar aquí.
async function runScanHere() {
  const my = ++scanToken, f = scanFilters();
  const job = S.scan = { running: true, where: "iPhone", step: "Leyendo el directorio de canales…", tried: 0, goal: 0, total: 0, found: [], failed: [], skipped: 0 };
  S.scanSel.clear(); renderScan();
  try {
    const list = await scanList(f);
    job.total = list.length;
    const todo = f.max ? list.slice(0, f.max) : list;
    job.goal = todo.length;
    for (const c of todo) {
      if (my !== scanToken) return;
      job.tried++;
      job.step = `Probando ${job.tried} de ${todo.length}: ${c.name}`;
      renderScan();
      if (c.referer) { job.skipped++; job.failed.push({ name: c.name, why: "necesita Referer: Safari no lo puede probar (escanea con tu computador)" }); continue; }
      try {
        const r = await verifyVideo(c.url, 12000);
        if (my !== scanToken) return;
        const pi = portableOn() ? portableIssue(c.url, !!c.website) : "";
        if (pi) throw new Error(pi);
        const si = sourceInfo(c.url, { website: c.website });
        job.found.push({ ...c, tier: si.tier, tierWhy: si.why, key: keyOf(c.url), live: r.live, res: r.h ? r.h + "p" : r.audioOnly ? "solo audio" : "",
          verifiedAt: Date.now(), lock: networkLock(c.url), exp: tokenExpiry(c.url) });
      } catch (e) { job.failed.push({ name: c.name, host: hostOf(c.url), why: e.message }); }
    }
    job.step = `Listo: ${job.found.length} funcionan de ${job.tried} probado(s)${list.length > todo.length ? ` (había ${list.length}; sube la cantidad para probar más)` : ""}.`;
  } catch (e) {
    if (my === scanToken) job.step = "No se pudo leer el directorio de canales. Revisa tu conexión.";
  } finally {
    if (my === scanToken) { job.running = false; renderScan(); }
  }
}
// Escanear con el computador: el mismo motor de la extensión (prueba como CarTV, también los que exigen Referer)
async function runScanPc() {
  if (!S.settings.ghToken) { toast("Conecta GitHub en Ajustes"); return setView("vSettings"); }
  const my = ++scanToken;
  const job = S.scan = { running: true, where: "computador", step: "", tried: 0, goal: 0, total: 0, found: [], failed: [] };
  S.scanSel.clear(); renderScan();
  const alive = () => my === scanToken;
  try {
    const res = await relayJob({ scan: scanFilters() }, job, my, true, { alive, render: renderScan });
    if (!alive()) return;
    job.tried = res?.tried || 0; job.goal = res?.goal || 0; job.total = res?.total || 0;
    for (const f of res?.found || []) {
      const pi = portableOn() ? portableIssue(f.url, !!f.pageUrl) : "";
      if (pi) { job.failed.push({ name: f.name, why: pi }); continue; }
      job.found.push({ ...f, logo: f.thumb || "", res: f.res ? String(f.res).split("x").pop() + "p" : "", exp: tokenExpiry(f.url), viaPc: true });
    }
    job.step = `${job.found.length} aptos para CarTV · tu computador: ${res?.step || "listo"}`;
  } catch (e) { if (alive()) job.step = e.message; }
  finally { if (alive()) { job.running = false; job.viaPc = false; renderScan(); } }
}
function stopScan() { scanToken++; if (S.scan) { S.scan.running = false; S.scan.step = "Escaneo detenido."; } renderScan(); }
function renderScan() {
  const out = $("#scanOut");
  if (!out || S.searchMode !== "scan") return;
  const j = S.scan, running = !!j?.running, F = S.scanForm;
  const cat = el("select", { class: "field" }, SCAN_CATEGORIES.map(([c, n]) => el("option", { value: c }, n)));
  cat.value = F.category; cat.onchange = () => (F.category = cat.value);
  const max = el("input", { class: "field", type: "number", min: "0", step: "1", inputmode: "numeric", value: String(F.max) });
  max.onchange = () => { F.max = Math.max(0, Math.round(+max.value) || 0); max.value = String(F.max); };
  const nodes = [el("div", { class: "scanf" },
    el("div", { class: "full" }, el("label", {}, "Categoría"), cat),
    el("div", { class: "full" }, el("label", {}, "Cuántos links probar (0 = todos)"), max),
    running ? el("button", { class: "btn full", type: "button", onclick: stopScan }, icon("x"), "Detener")
      : el("div", { class: "full acts", style: "display:flex;gap:8px" },
        el("button", { class: "btn primary", style: "flex:1", type: "button", onclick: () => { max.onchange(); runScanPc(); } }, icon("laptop"), "Con mi computador"),
        el("button", { class: "btn", style: "flex:1", type: "button", onclick: () => { max.onchange(); runScanHere(); } }, icon("phone"), "Aquí en el iPhone")))];
  nodes.push(el("p", { class: "hint" }, "«Con mi computador» es más rápido y prueba como CarTV (también los que exigen Referer). «Aquí» reproduce cada link en Safari, uno por uno."));
  if (j) {
    const st = el("div", { class: "status" + (running ? " run" : "") },
      el("div", {}, running ? el("span", { class: "spin" }) : null, j.step),
      el("div", { class: "meta" }, `${j.tried} de ${j.goal} probado(s) · ${j.found.length} funcionan${j.total ? ` · ${j.total} cumplen los filtros` : ""}`));
    if (j.failed.length) st.append(el("details", {}, el("summary", {}, "Ver por qué se descartaron (últimos)"), el("ul", {}, j.failed.slice(-20).map((f) => el("li", {}, `${f.name || f.host}: ${f.why}`)))));
    nodes.push(st);
  }
  const list = activeList();
  const inList = (f) => list.items.some((x) => x.key === f.key);
  const found = j?.found || [];
  const pending = found.filter((f) => !inList(f));
  const selN = pending.filter((f) => S.scanSel.has(f.key)).length;
  for (const f of found) {
    const already = inList(f);
    const cb = el("input", { type: "checkbox" });
    cb.checked = already || S.scanSel.has(f.key); cb.disabled = already;
    cb.onchange = () => { cb.checked ? S.scanSel.add(f.key) : S.scanSel.delete(f.key); renderScan(); };
    const meta = [f.lang, audioLabel(f.audio), f.country, f.res, f.live === false ? "grabado" : "en vivo", f.car ? (f.car.ok ? "Apto CarTV" : "") : "Probado en el iPhone",
      f.needs === "referer" ? "necesita Referer" : "", f.lock ? "solo esta red" : "", f.geo ? "puede tener bloqueo por país" : "", already ? `ya está en «${list.name}»` : ""].filter(Boolean).join(" · ");
    nodes.push(el("label", { class: "scanrow" + (already ? " saved" : "") }, cb, logoEl(f.logo),
      el("div", { class: "t" }, el("b", {}, f.name), el("div", { class: "meta" }, meta), el("div", { class: "u" }, f.url))));
  }
  if (found.length) nodes.push(el("div", { class: "scanbar" },
    el("button", { class: "btn", type: "button", onclick: () => { if (selN === pending.length) S.scanSel.clear(); else pending.forEach((f) => S.scanSel.add(f.key)); renderScan(); } },
      icon("check"), selN === pending.length && pending.length ? "Quitar todos" : "Marcar todos"),
    el("button", { class: "btn primary", type: "button", disabled: !selN, onclick: () => addManySheet(pending.filter((f) => S.scanSel.has(f.key))) }, icon("plus"), `Agregar ${selN}`)));
  put(out, nodes);
}
function addManySheet(items) {
  if (!items.length) return;
  const state = { listId: S.active, group: "" };
  const doAdd = () => {
    const list = S.lists.find((l) => l.id === state.listId);
    let n = 0;
    for (const f of items) {
      if (list.items.some((x) => x.key === f.key)) continue;
      list.items.push({ id: uid(), car: f.car || undefined, tier: tierOf(f).tier, tierWhy: tierOf(f).why, key: f.key, name: f.name, url: f.url, referer: f.referer || "", logo: f.logo || "", tvgId: f.tvgId || "", ua: f.ua || "",
        group: state.group, live: f.live, res: f.res || "", verifiedAt: f.verifiedAt || 0, status: f.verifiedAt ? "ok" : "" });
      n++;
    }
    S.active = list.id;
    touch(list);
    S.scanSel.clear();
    closeSheet();
    toast(`${n} canal(es) agregado(s) a «${list.name}»${state.group ? " · " + state.group : ""}`);
    renderHeader(); renderScan();
  };
  sheet(`Agregar ${items.length} canal(es)`, [pickTarget(state)],
    [el("button", { class: "btn", onclick: closeSheet }, "Cancelar"), el("button", { class: "btn primary", onclick: doAdd }, "Agregar")]);
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
    list.items.push({ id: uid(), car: f.car || undefined, tier: tierOf(f).tier, tierWhy: tierOf(f).why, key: f.key, name: cleanTitle(name.value) || f.name, url: f.url, referer: f.referer || "", logo: f.logo || "", tvgId: f.tvgId || "", ua: f.ua || "",
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
  v.onerror = async () => {
    $("#playerMsg").textContent = "No se pudo reproducir. Revisando por qué…";
    const why = v.error?.code === 3 ? mediaError(v) : await diagnose(it.url, it.referer);
    put($("#playerMsg"), `No se pudo reproducir: ${why}. `, S.settings.ghToken ? el("button", { class: "btn sm", style: "margin-top:8px", onclick: () => { $("#playerClose").click(); pcCheckSheet(it); } }, icon("laptop"), "Diagnosticar con mi computador") : null);
  };
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
    list.id === "sync" ? el("div", { class: "meta tag " + (S.settings.syncMeta?.error ? "bad" : "ok"), style: "margin-top:8px" }, icon("refresh", 12),
      S.settings.syncMeta?.error ? "Error al sincronizar: " + S.settings.syncMeta.error
        : S.settings.syncMeta?.lastSync ? `Sincronizada con el computador · ${ago(S.settings.syncMeta.lastSync)}` : "Sincronizando…")
      : list.link ? el("div", { class: "meta tag", style: "margin-top:8px" }, icon("link", 12), "Link fijo publicado: se actualiza solo al cambiar la lista.") : null,
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
      el("div", { class: "t" }, el("span", { class: "tier t-" + tierOf(it).tier, title: tierOf(it).why.join(" · ") }, TIER_LABEL[tierOf(it).tier]),
        it.car ? el("span", { class: "tier " + (it.car.ok ? "car-ok" : "car-bad"), style: "margin-left:4px", title: (it.car.why || "") + " · " + ago(it.car.at) }, it.car.ok ? "Apto CarTV" : "No apto CarTV") : null,
        el("b", {}, it.name),
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
// Le pide a la extensión la prueba «como CarTV» del link y muestra el veredicto aquí
function pcCheckSheet(it) {
  const box = el("div", {}, el("p", { class: "hint" }, el("span", { class: "spin" }), "Enviando el link a tu computador…"));
  sheet("Diagnóstico · " + it.name, box, [el("button", { class: "btn", onclick: closeSheet }, "Cerrar")]);
  const my = ++searchToken, job = { step: "", failed: [], found: [], tried: 0 };
  const show = () => put(box, el("p", { class: "hint" }, el("span", { class: "spin" }), job.step || "Esperando a tu computador…"));
  const t = setInterval(show, 1000);
  relayJob({ checkUrl: it.url, referer: it.referer || "" }, job, my, true).then((res) => {
    const c = res?.check || {};
    const v = { ok: ["ok", "check", "Funciona en CarTV tal cual."],
      referer: ["warn", "alert", "Funciona en CarTV solo con Referer: usa el formato «Apps IPTV» (ya viene por defecto)."],
      browser: ["bad", "x", "No sirve en CarTV: solo funciona dentro de Chrome (el servidor exige las cookies o el origen de la página)."],
      down: ["bad", "x", "No funciona ni en el computador: " + (c.why || "sin detalle") + "."] }[c.verdict] || ["bad", "x", "Sin respuesta clara."];
    put(box, el("div", { class: "meta tag " + v[0], style: "font-size:13px;margin-bottom:8px" }, icon(v[1], 14), v[2]),
      c.lock ? el("p", { class: "hint" }, c.lock) : null,
      c.exp ? el("p", { class: "hint" }, c.exp < Date.now() ? "El token ya venció: renuévalo desde su página." : `El token vence ${new Date(c.exp).toLocaleString()}.`) : null,
      c.verdict === "down" || c.verdict === "browser" ? el("p", { class: "hint" }, "Busca el canal de nuevo o extráelo de su página oficial para conseguir un link que sirva.") : null);
  }).catch((e) => put(box, el("p", { class: "hint bad" }, e.message))).finally(() => clearInterval(t));
}
function itemMenu(list, it) {
  const opt = (i, t, fn, cls = "") => el("button", { class: "opt " + cls, onclick: fn }, el("span", { class: "i" }, icon(i, 18)), t);
  sheet(it.name, [
    opt("refresh", "Probar de nuevo", () => { closeSheet(); retest(list, it); }),
    S.settings.ghToken ? opt("laptop", "Diagnosticar con mi computador (como CarTV)", () => pcCheckSheet(it)) : null,
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
    list.id === "sync" ? opt("refresh", "Sincronizar ahora con el computador", () => { closeSheet(); pwaSync("manual").then(() => toast(S.settings.syncMeta?.error ? "No se pudo sincronizar" : "Sincronizado")); }) : null,
    opt("refresh", "Probar todos los canales", () => retestAll(list)),
    opt("upload", "Importar .m3u / .m3u8", () => importSheet(list)),
    opt("edit", "Cambiar nombre de la lista", () => { const n = cleanTitle(prompt("Nuevo nombre", list.name) || ""); if (n) { list.name = n; touch(list); } closeSheet(); renderLists(); renderHeader(); }),
    S.lists.length > 1 && list.id !== "sync" ? opt("trash", "Borrar esta lista", () => {
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
    el("option", { value: "iptv" }, "Apps IPTV: CarTV, Kodi (recomendado)"),
    el("option", { value: "both" }, "VLC + apps IPTV (el Referer no llega a CarTV)"),
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
    if (list.id === "sync" && syncPubLink()) {
      pub.append(el("div", { class: "linkbox" }, syncPubLink()),
        el("div", { class: "acts" }, el("button", { class: "btn primary", onclick: () => copyText(syncPubLink(), "Link copiado") }, icon("copy"), "Copiar link")),
        el("p", { class: "hint" }, "Es el mismo link de la extensión: se actualiza desde aquí y desde el computador. Pégalo una vez en CarTV («M3U por URL»)."));
      return;
    }
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
    el("p", { class: "hint" }, "Para CarTV usa «Apps IPTV»: el Referer va pegado al link, que es como CarTV lo lee."),
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
  tok.onchange = () => { S.settings.ghToken = tok.value.trim(); S.settings.relayGistId = ""; save({ republish: false }); toast(S.settings.ghToken ? "GitHub conectado: sincronizando…" : "GitHub desconectado"); if (S.settings.ghToken) pwaSync("conectar"); };
  const fmt = el("select", { class: "field" }, el("option", { value: "iptv" }, "Apps IPTV: CarTV, Kodi (recomendado)"), el("option", { value: "both" }, "VLC + apps IPTV (el Referer no llega a CarTV)"), el("option", { value: "vlc" }, "Solo VLC"));
  fmt.value = S.settings.format;
  fmt.onchange = () => { S.settings.format = fmt.value; S.lists.forEach((l) => (l.dirty = true)); save(); };
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  put($("#vSettings"),
    standalone ? null : el("div", { class: "set" }, el("h3", {}, icon("phone"), "Instalar en el iPhone"),
      el("p", { class: "hint" }, "En Safari toca Compartir (el cuadro con la flecha) y luego «Añadir a pantalla de inicio». Así abre como app, a pantalla completa, y tus listas quedan guardadas.")),
    el("div", { class: "set" }, el("h3", {}, icon("cast"), "Solo aptos para CarTV"),
      el("label", { style: "display:flex;gap:10px;align-items:center;text-transform:none;letter-spacing:0;font:inherit;color:var(--text)" },
        (() => { const c = el("input", { type: "checkbox", checked: S.settings.cartvOnly !== false, style: "width:22px;height:22px" }); c.onchange = () => { S.settings.cartvOnly = c.checked; save({ republish: false }); }; return c; })(),
        "Mostrar en la búsqueda solo lo que pasó la prueba como CarTV"),
      el("p", { class: "hint" }, "Tu computador (si está prendido) prueba cada resultado exactamente como lo pide CarTV, incluso los que Safari no puede probar. Tus canales guardados se vuelven a probar solos y llevan la marca «Apto CarTV».")),
    el("div", { class: "set" }, el("h3", {}, icon("search"), "Búsqueda"),
      el("label", {}, "Links a probar en cada búsqueda"),
      (() => {
        const txt = (v) => (v ? `${v} links` : "todos los links");
        const n = el("input", { class: "field", type: "number", min: "0", step: "1", inputmode: "numeric", value: String(goalOf()), style: "width:90px" });
        const ok = el("span", { class: "hint", style: "margin:0" }, `Ahora: ${txt(goalOf())}`);
        const put = (v) => {
          v = searchCountOf(v);
          n.value = String(v); S.settings.searchCount = v; save({ republish: false });
          ok.textContent = store.get("m3u.settings", {}).searchCount === v ? `✓ Guardado: ${txt(v)}` : "No se pudo guardar";
          toast(`Guardado: ${txt(v)} por búsqueda`);
        };
        n.onchange = () => put(n.value); n.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); n.blur(); } };
        return el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" }, n,
          el("button", { class: "btn primary", onclick: () => put(n.value) }, icon("check"), "Guardar"),
          el("button", { class: "btn", onclick: () => put(0) }, "Todos"), ok);
      })(),
      el("p", { class: "hint" }, "0 o «Todos» = no omite ningún link: prueba TODO lo que aparezca, uno por uno y en orden: directorio (aquí en el iPhone) → todos los sitios oficiales y todas sus páginas → todos los resultados de la web (con tu computador, porque Safari no puede abrir otras páginas por detrás). Con un número, prueba exactamente esa cantidad.")),
    el("div", { class: "set" }, el("h3", {}, icon("cast"), "Solo lo que abra en CarTV con datos"),
      el("label", { style: "display:flex;gap:10px;align-items:center;text-transform:none;letter-spacing:0;font:inherit;color:var(--text)" },
        (() => { const c = el("input", { type: "checkbox", checked: portableOn(), style: "width:22px;height:22px" }); c.onchange = () => { S.settings.portableOnly = c.checked; save({ republish: false }); toast(c.checked ? "Solo se mostrarán links que abren en este celular" : "Se mostrará todo"); }; return c; })(),
        "Descartar links que en CarTV no abrirían fuera de tu casa"),
      el("p", { class: "hint" }, "Descarta los links amarrados a la red del computador (con datos no abren) y los que vencen pronto sin poder renovarse. Lo que decide si un link sirve es la prueba «como CarTV» que hace tu computador, no Safari.")),
    el("div", { class: "set" }, el("h3", {}, "Formato de las listas"), el("label", {}, "Cómo van el Referer y el User-Agent"), fmt),
    el("div", { class: "set" }, el("h3", {}, "Link fijo (GitHub)"),
      el("p", { class: "hint" }, "Publica cada lista como un Gist secreto de GitHub (gratis). El link no cambia aunque edites la lista."),
      el("a", { href: "https://github.com/settings/tokens/new?scopes=gist&description=Listas%20M3U", target: "_blank", rel: "noopener" }, "1. Crear token con permiso «gist» ", icon("external", 13)),
      el("label", {}, "2. Pega el token"), tok,
      el("p", { class: "hint" }, "El token se guarda solo en este equipo. Quien tenga el link de una lista puede verla."),
      el("p", { class: "hint" }, "Con el mismo usuario de GitHub que tiene la extensión, tus canales quedan sincronizados: lo que agregues, borres o cambies aquí aparece en Guardados del computador y al revés, desde cualquier red y aunque el computador esté apagado. Además, esta app le puede pedir a tu computador que busque un canal o que saque el video de una página (Chrome sí puede abrir páginas por detrás; Safari no). El computador debe estar prendido con Chrome abierto.")),
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
function renderAll() { renderHeader(); renderSearchMode(); renderSearch(); if (S.view === "vLists") renderLists(); if (S.view === "vSettings") renderSettings(); }
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
if (S.settings.ghToken) { ensureSyncList(); pwaSync("abrir"); }
document.addEventListener("visibilitychange", () => { if (!document.hidden) pwaSync("volver"); });
setInterval(() => { if (!document.hidden) pwaSync("periódica"); }, 30000);
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
