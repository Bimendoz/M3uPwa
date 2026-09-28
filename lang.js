// Idioma de los canales — MISMO ARCHIVO en la extensión (lib/lang.js) y en la app (lang.js).
// Fuentes: el directorio iptv-org dice el idioma de cada señal (feeds.json → languages, p. ej. "spa")
// y su zona (broadcast_area, p. ej. "c/MX"); si no, se usa el idioma del país del canal.
// Para links que no vienen del directorio (sitio oficial, web) se lee el audio que declara la lista HLS
// (#EXT-X-MEDIA:TYPE=AUDIO,LANGUAGE="es").

const LATAM = new Set(["AR", "BO", "CL", "CO", "CR", "CU", "DO", "EC", "SV", "GT", "HN", "MX", "NI", "PA", "PY", "PE", "PR", "UY", "VE"]);
const LANG_MODES = [
  ["latam", "Español latino (solo Latinoamérica)"],
  ["spa", "Español (latino primero)"],
  ["es", "Español de España"],
  ["any", "Todos los idiomas"]
];
const LANG_NAMES = { spa: "español", eng: "inglés", por: "portugués", fra: "francés", ita: "italiano", deu: "alemán", ara: "árabe", rus: "ruso", zho: "chino", jpn: "japonés", kor: "coreano", tur: "turco", hin: "hindi", cat: "catalán", glg: "gallego", eus: "euskera", und: "sin definir" };
const ISO2 = { es: "spa", en: "eng", pt: "por", fr: "fra", it: "ita", de: "deu", ar: "ara", ru: "rus", zh: "zho", ja: "jpn", ko: "kor", tr: "tur", hi: "hin", ca: "cat", gl: "glg", eu: "eus" };
// Países de habla hispana (para listas del escaneo global)
const SPANISH_COUNTRIES = [["MX", "México"], ["CO", "Colombia"], ["AR", "Argentina"], ["CL", "Chile"], ["PE", "Perú"], ["VE", "Venezuela"],
  ["EC", "Ecuador"], ["GT", "Guatemala"], ["CU", "Cuba"], ["BO", "Bolivia"], ["DO", "Rep. Dominicana"], ["HN", "Honduras"], ["PY", "Paraguay"],
  ["SV", "El Salvador"], ["NI", "Nicaragua"], ["CR", "Costa Rica"], ["PA", "Panamá"], ["UY", "Uruguay"], ["PR", "Puerto Rico"], ["ES", "España"], ["US", "Estados Unidos (hispanos)"]];
const SCAN_CATEGORIES = [["", "Todas"], ["general", "General"], ["news", "Noticias"], ["movies", "Películas"], ["series", "Series"], ["entertainment", "Entretenimiento"],
  ["kids", "Infantil"], ["animation", "Animación"], ["sports", "Deportes"], ["music", "Música"], ["documentary", "Documentales"], ["culture", "Cultura"],
  ["education", "Educación"], ["lifestyle", "Estilo de vida"], ["cooking", "Cocina"], ["travel", "Viajes"], ["comedy", "Comedia"], ["classic", "Clásicos"],
  ["religious", "Religioso"], ["legislative", "Institucional"], ["weather", "Clima"], ["shop", "Compras"]];

// Países elegidos: [] = todos · "LATAM" = toda Latinoamérica · o códigos sueltos ("MX","CO"…)
const LATAM_SPANISH = SPANISH_COUNTRIES.filter(([c]) => LATAM.has(c));
const cleanCountries = (list) => (Array.isArray(list) ? [...new Set(list.filter((c) => c === "LATAM" || SPANISH_COUNTRIES.some(([k]) => k === c)))] : []);
function countryOk(country, areas, want) {
  if (!want?.length) return true;
  const w = new Set(want);
  if (w.has(country) || areas.some((a) => w.has(a))) return true;
  return w.has("LATAM") && (LATAM.has(country) || areas.some((a) => LATAM.has(a)));
}
// Zonas de emisión de un stream del directorio (["MX","CO"…])
function streamAreas(s, idx) {
  const feed = (s.feed && idx.byFeed.get(s.channel + "@" + s.feed)) || idx.mainOf.get(s.channel);
  return (feed?.broadcast_area || []).map((a) => a.replace(/^[a-z]\//, "").toUpperCase());
}
// Texto corto de los países elegidos
function countriesLabel(want) {
  if (!want?.length) return "Todos los países";
  return want.map((c) => (c === "LATAM" ? "Toda Latinoamérica" : (SPANISH_COUNTRIES.find(([k]) => k === c) || [c, c])[1])).join(", ");
}

const langMode = (m) => (LANG_MODES.some(([k]) => k === m) ? m : "latam");
const LATIN_HINT = /\b(latino|latin ?america|latinoam[eé]rica|am[eé]rica latina|latam|lat)\b/i;
const SPAIN_HINT = /\b(espa[ñn]a|spain)\b/i;

// Índice del directorio para saber el idioma de cada stream
function buildLangIndex(feeds = [], countries = []) {
  const byFeed = new Map(), mainOf = new Map(), cLang = new Map();
  for (const f of feeds) {
    byFeed.set(f.channel + "@" + f.id, f);
    if (f.is_main || !mainOf.has(f.channel)) mainOf.set(f.channel, f);
  }
  for (const c of countries) cLang.set(c.code, c.languages || []);
  return { byFeed, mainOf, cLang };
}
// { langs:["spa"], latino, spain, label } de un stream del directorio (s = stream, ch = canal o null)
function streamLang(s, ch, idx) {
  const feed = (s.feed && idx.byFeed.get(s.channel + "@" + s.feed)) || idx.mainOf.get(s.channel) || null;
  const country = ch?.country || "";
  let langs = feed?.languages?.length ? feed.languages : (idx.cLang.get(country) || []);
  const text = [s.title, feed?.name, ch?.name].filter(Boolean).join(" ");
  const areas = (feed?.broadcast_area || []).map((a) => a.replace(/^[a-z]\//, "").toUpperCase());
  let latino = LATAM.has(country) || areas.some((a) => LATAM.has(a) || /LATAM|LAC|LATIN|CAM|SAM/.test(a)) || LATIN_HINT.test(text);
  const spain = country === "ES" || areas.includes("ES") || SPAIN_HINT.test(text);
  if (spain && !LATAM.has(country) && !areas.some((a) => LATAM.has(a)) && !LATIN_HINT.test(text)) latino = false;
  if (!langs.includes("spa") && /\b(espa[ñn]ol|spanish|latino)\b/i.test(text)) langs = [...langs, "spa"];
  return { langs, latino: latino && langs.includes("spa"), spain: spain && langs.includes("spa"), label: langLabel(langs, latino, spain) };
}
function langLabel(langs, latino, spain) {
  if (!langs?.length) return "Idioma sin confirmar";
  if (langs.includes("spa")) return latino ? "Español latino" : spain ? "Español de España" : "Español";
  return langs.map((l) => LANG_NAMES[l] || l).join(", ");
}
// ¿Pasa el filtro de idioma? info = streamLang(...) · mode = latam | spa | es | any
function langOk(info, mode) {
  mode = langMode(mode);
  if (mode === "any") return true;
  if (!info?.langs?.length) return true; // el directorio no dice el idioma: no se omite (queda «idioma sin confirmar»)
  if (!info.langs.includes("spa")) return false;
  if (mode === "latam") return !!info.latino || !info.spain; // español sin zona clara también cuenta; España no
  if (mode === "es") return !!info.spain;
  return true;
}
// Orden: español latino → español → el resto
const langRank = (info) => (info?.latino ? 0 : info?.langs?.includes("spa") ? (info.spain ? 2 : 1) : 3);

// Audio que declara una lista HLS maestra → ["spa","eng"] (vacío si no dice nada)
function audioLangs(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/#EXT-X-MEDIA:([^\n]*)/g)) {
    if (!/TYPE=AUDIO/i.test(m[1])) continue;
    const lang = ((m[1].match(/LANGUAGE="([^"]+)"/i) || [])[1] || "").toLowerCase().split("-")[0];
    const name = (m[1].match(/NAME="([^"]+)"/i) || [])[1] || "";
    let code = lang.length === 2 ? ISO2[lang] || lang : lang;
    if (/espa[ñn]ol|spanish|castellano|latino/i.test(name)) code = "spa";
    else if (!code && /english|ingl[eé]s/i.test(name)) code = "eng";
    else if (!code && /portugu/i.test(name)) code = "por";
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}
// Para links sin dato del directorio: con audio declarado se decide; sin audio declarado, «sin confirmar» (se deja pasar)
function audioOk(audio, mode) {
  if (langMode(mode) === "any" || !audio?.length) return true;
  return audio.includes("spa");
}
const audioLabel = (audio) => (audio?.length ? "Audio: " + audio.map((l) => LANG_NAMES[l] || l).join(", ") : "");
