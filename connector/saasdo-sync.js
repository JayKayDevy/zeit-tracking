#!/usr/bin/env node
// Lokaler saas.do-Connector.
//
// Läuft auf dem eigenen, bei saas.do bereits autorisierten Rechner (kein WAF-Umgehungsversuch -
// der reguläre, erlaubte Zugriffsweg). Loggt sich bei saas.do ein, holt für jede in der
// zentralen App-Liste des Organizers aktive App die Versionsdaten und reicht nur diese
// gefilterten Rohdaten an den Organizer weiter. Der Organizer-Server kontaktiert saas.do
// selbst nicht mehr direkt (wird von einer Azure-WAF blockiert, siehe README).
//
// Aufruf: node saasdo-sync.js   (liest Konfiguration aus connector/.env)

require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const SAASDO_BASE = "https://app.dev.saas.toyota.de";
const ORGANIZER_API_URL = process.env.ORGANIZER_API_URL || "https://zeit-tracking.onrender.com/api";
const SAASDO_USERNAME = process.env.SAASDO_USERNAME;
const SAASDO_PASSWORD = process.env.SAASDO_PASSWORD;
const ORGANIZER_TOKEN = process.env.ORGANIZER_TOKEN;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
  "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
};

function fail(message) {
  console.error(`✕ ${message}`);
  process.exit(1);
}

function checkConfig() {
  const missing = [];
  if (!SAASDO_USERNAME) missing.push("SAASDO_USERNAME");
  if (!SAASDO_PASSWORD) missing.push("SAASDO_PASSWORD");
  if (!ORGANIZER_TOKEN) missing.push("ORGANIZER_TOKEN");
  if (missing.length) {
    fail(
      `Fehlende Konfiguration in connector/.env: ${missing.join(", ")}\n` +
        `Siehe connector/.env.example und connector/README.md.`
    );
  }
}

let saasdoCookies = {};
function saasdoCookieHeader() {
  return Object.entries(saasdoCookies).map(([k, v]) => `${k}=${v}`).join("; ");
}
function saasdoStoreCookies(resp) {
  const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const name = pair.slice(0, i).trim();
    if (name === "XSRF-TOKEN" || name === "saas_session") saasdoCookies[name] = pair.slice(i + 1).trim();
  }
}
async function saasdoFetch(path, opts = {}) {
  return fetch(`${SAASDO_BASE}${path}`, {
    ...opts,
    redirect: "manual",
    headers: { ...BROWSER_HEADERS, ...(opts.headers || {}), Cookie: saasdoCookieHeader() },
  });
}

async function saasdoLogin() {
  const getResp = await saasdoFetch("/auth/login");
  const html = await getResp.text();
  saasdoStoreCookies(getResp);
  if (getResp.status !== 200) {
    fail(`saas.do-Loginseite nicht erreichbar (Status ${getResp.status}). Bist du mit dem Firmennetz/deinem üblichen Anschluss online?`);
  }
  const m = html.match(/name="_token" type="hidden" value="([^"]+)"/);
  if (!m) fail("CSRF-Token auf der saas.do-Loginseite nicht gefunden - hat sich die Seite geändert?");

  const body = new URLSearchParams({ _token: m[1], email: SAASDO_USERNAME, password: SAASDO_PASSWORD });
  const postResp = await saasdoFetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  saasdoStoreCookies(postResp);
  const location = postResp.headers.get("location") || "";
  if (postResp.status !== 302 || location.endsWith("/auth/login")) {
    fail("saas.do-Login fehlgeschlagen - bitte SAASDO_USERNAME/SAASDO_PASSWORD in connector/.env prüfen.");
  }
  console.log("✓ Bei saas.do angemeldet");
}

async function saasdoFetchVersions(appId) {
  const resp = await saasdoFetch(`/apps/show/${appId}/versions/api/versions/`);
  const contentType = resp.headers.get("content-type") || "";
  if (resp.status !== 200 || !contentType.includes("application/json")) {
    throw new Error(`unerwartete Antwort (Status ${resp.status})`);
  }
  return resp.json();
}

async function organizerRequest(method, path, body) {
  const res = await fetch(`${ORGANIZER_API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ORGANIZER_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      fail("Organizer-Token abgelehnt (401) - bitte ORGANIZER_TOKEN in connector/.env aus dem Browser neu kopieren (läuft nach ca. 30 Tagen ab).");
    }
    throw new Error(data.error || `Organizer-Anfrage fehlgeschlagen (Status ${res.status})`);
  }
  return data;
}

async function main() {
  checkConfig();

  const apps = (await organizerRequest("GET", "/saasdo-apps")).filter((a) => a.active);
  if (!apps.length) {
    console.log("Keine aktiven saas.do-Apps in den Organizer-Einstellungen konfiguriert. Nichts zu synchronisieren.");
    return;
  }
  console.log(`${apps.length} aktive App(s) gefunden: ${apps.map((a) => `${a.app_name} (${a.app_id})`).join(", ")}`);

  const me = await organizerRequest("GET", "/auth/me");
  const author = me.saasdo_author || me.name;
  console.log(`Autor-Filter: „${author}" (nur diese Commits werden übertragen)`);

  await saasdoLogin();

  const results = [];
  for (const app of apps) {
    try {
      const data = await saasdoFetchVersions(app.app_id);
      const all = data.versions || [];
      const versions = all.filter((v) => v.author === author);
      results.push({ app_id: app.app_id, versions });
      console.log(`✓ ${app.app_name} (${app.app_id}): ${versions.length} von ${all.length} Versionen (Autor „${author}")`);
    } catch (e) {
      console.error(`✕ ${app.app_name} (${app.app_id}): ${e.message}`);
    }
  }

  if (!results.length) {
    fail("Keine App-Daten erfolgreich abgerufen - nichts wird an den Organizer gesendet.");
  }

  const { synced, skipped } = await organizerRequest("POST", "/saasdo/sync", { results });
  console.log(`✓ An Organizer gesendet: ${synced.length} App(s) synchronisiert${skipped.length ? `, ${skipped.length} übersprungen` : ""}`);
}

main().catch((e) => fail(e.message));
