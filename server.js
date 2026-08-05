require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-prod";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

// Standardlimit (100kb) reicht nicht für den saas.do-Connector-Sync-Push -
// eine App-Historie kann mehrere zehntausend Commits umfassen.
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Database ──────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        daily_hours DECIMAL(4,2) DEFAULT 8.0,
        vacation_days_per_year INTEGER DEFAULT 28,
        office_lat DECIMAL(10,7),
        office_lng DECIMAL(10,7),
        office_radius INTEGER DEFAULT 200,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        color VARCHAR(7) DEFAULT '#ff2d78',
        external_id VARCHAR(100),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS time_entries (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        check_in TIMESTAMP NOT NULL,
        check_out TIMESTAMP,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS breaks (
        id SERIAL PRIMARY KEY,
        time_entry_id INTEGER REFERENCES time_entries(id) ON DELETE CASCADE,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS absences (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        type VARCHAR(20) NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, date)
      );

      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_access_token TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_token_expiry TIMESTAMP;
      ALTER TABLE absences ADD COLUMN IF NOT EXISTS google_event_id VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bundesland VARCHAR(20);
      ALTER TABLE absences ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS accent_color VARCHAR(7);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS tracking_start_date DATE;

      CREATE TABLE IF NOT EXISTS import_reviews (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        source_type VARCHAR(10) NOT NULL,
        source_id VARCHAR(255) NOT NULL,
        status VARCHAR(10) NOT NULL,
        time_entry_id INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, source_type, source_id)
      );

      CREATE TABLE IF NOT EXISTS billing_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        date DATE NOT NULL,
        hours DECIMAL(5,2) NOT NULL,
        description TEXT,
        source_type VARCHAR(10),
        source_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE import_reviews ADD COLUMN IF NOT EXISTS billing_item_id INTEGER REFERENCES billing_items(id) ON DELETE SET NULL;

      CREATE TABLE IF NOT EXISTS billing_entries (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        service_date DATE NOT NULL,
        end_time TIMESTAMP,
        duration_hours DECIMAL(5,2) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        source_type VARCHAR(20) NOT NULL,
        source_external_id VARCHAR(255),
        source_metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE billing_entries DROP COLUMN IF EXISTS start_time;
      ALTER TABLE billing_entries DROP COLUMN IF EXISTS duration_minutes;
      ALTER TABLE billing_entries ADD COLUMN IF NOT EXISTS duration_hours DECIMAL(5,2);
      ALTER TABLE import_reviews ADD COLUMN IF NOT EXISTS billing_entry_id INTEGER REFERENCES billing_entries(id) ON DELETE SET NULL;
      ALTER TABLE import_reviews ADD COLUMN IF NOT EXISTS label TEXT;
      ALTER TABLE import_reviews ADD COLUMN IF NOT EXISTS item_date DATE;
      ALTER TABLE import_reviews ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS saasdo_app_id INTEGER;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS saasdo_author VARCHAR(255);

      CREATE TABLE IF NOT EXISTS saasdo_apps (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        app_id INTEGER NOT NULL,
        app_name VARCHAR(255) NOT NULL,
        note TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, app_id)
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_selected_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;

      CREATE TABLE IF NOT EXISTS saasdo_synced_versions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        app_id INTEGER NOT NULL,
        versions JSONB NOT NULL,
        synced_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, app_id)
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        key VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Projekt-AppID-Zuordnung (projects.saasdo_app_id, verworfenes Zwischenmodell) einmalig
    // verlustfrei in die zentrale saasdo_apps-Liste überführen. Die Spalte selbst bleibt
    // danach toter Altbestand stehen (nie wieder gelesen/geschrieben) - gleiches Prinzip
    // wie billing_items/import_reviews.time_entry_id in diesem Schema.
    const migrated = await client.query(
      "SELECT 1 FROM schema_migrations WHERE key=$1",
      ["saasdo_apps_backfill"]
    );
    if (!migrated.rows.length) {
      await client.query(`
        INSERT INTO saasdo_apps (user_id, app_id, app_name, active)
        SELECT DISTINCT ON (user_id, saasdo_app_id)
               user_id, saasdo_app_id, 'saas.do App ' || saasdo_app_id, true
        FROM projects
        WHERE saasdo_app_id IS NOT NULL
        ORDER BY user_id, saasdo_app_id, id
        ON CONFLICT (user_id, app_id) DO NOTHING
      `);
      await client.query("INSERT INTO schema_migrations (key) VALUES ($1)", ["saasdo_apps_backfill"]);
    }

    console.log("DB ready");
  } finally {
    client.release();
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.query.token;
  if (!token) return res.status(401).json({ error: "Nicht eingeloggt" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token ungültig" });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Kein Zugriff" });
  next();
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "Alle Felder erforderlich" });
  try {
    const existing = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (existing.rows.length) return res.status(409).json({ error: "E-Mail bereits vergeben" });

    const count = await pool.query("SELECT COUNT(*) FROM users");
    const role = parseInt(count.rows[0].count) === 0 ? "admin" : "user";

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role,daily_hours,vacation_days_per_year",
      [name, email, hash, role]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query(
      "SELECT id,name,email,password_hash,role,daily_hours,vacation_days_per_year,office_lat,office_lng,office_radius,bundesland,accent_color,tracking_start_date,saasdo_author,last_selected_project_id,(google_refresh_token IS NOT NULL) as google_connected FROM users WHERE email=$1",
      [email]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: "E-Mail oder Passwort falsch" });

    const { password_hash, ...safeUser } = user;
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: safeUser });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/auth/me", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT id,name,email,role,daily_hours,vacation_days_per_year,office_lat,office_lng,office_radius,bundesland,accent_color,tracking_start_date,saasdo_author,last_selected_project_id,(google_refresh_token IS NOT NULL) as google_connected FROM users WHERE id=$1",
    [req.user.id]
  );
  res.json(result.rows[0]);
});

app.put("/api/auth/me", auth, async (req, res) => {
  const { name, daily_hours, vacation_days_per_year, office_lat, office_lng, office_radius, bundesland, accent_color, tracking_start_date, saasdo_author } = req.body;
  await pool.query(
    "UPDATE users SET name=$1,daily_hours=$2,vacation_days_per_year=$3,office_lat=$4,office_lng=$5,office_radius=$6,bundesland=$7,accent_color=$8,tracking_start_date=$9,saasdo_author=$10 WHERE id=$11",
    [name, daily_hours, vacation_days_per_year, office_lat || null, office_lng || null, office_radius || 200, bundesland || null, accent_color || null, tracking_start_date || null, saasdo_author || null, req.user.id]
  );
  const result = await pool.query(
    "SELECT id,name,email,role,daily_hours,vacation_days_per_year,office_lat,office_lng,office_radius,bundesland,accent_color,tracking_start_date,saasdo_author,last_selected_project_id,(google_refresh_token IS NOT NULL) as google_connected FROM users WHERE id=$1",
    [req.user.id]
  );
  res.json(result.rows[0]);
});

app.put("/api/auth/password", auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  const result = await pool.query("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
  if (!(await bcrypt.compare(current_password, result.rows[0].password_hash)))
    return res.status(401).json({ error: "Aktuelles Passwort falsch" });
  const hash = await bcrypt.hash(new_password, 10);
  await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash, req.user.id]);
  res.json({ ok: true });
});

// ── Geocoding ─────────────────────────────────────────────────────────────────

app.get("/api/geocode", auth, async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Adresse erforderlich" });
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: { "User-Agent": "zeit-tracking-app (https://github.com/JayKayDevy/zeit-tracking)" },
    });
    const results = await r.json();
    if (!results.length) return res.status(404).json({ error: "Adresse nicht gefunden" });
    res.json({
      lat: parseFloat(results[0].lat),
      lng: parseFloat(results[0].lon),
      display_name: results[0].display_name,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Google Calendar ──────────────────────────────────────────────────────────

const GOOGLE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly";

async function getValidAccessToken(userId) {
  const result = await pool.query(
    "SELECT google_refresh_token, google_access_token, google_token_expiry FROM users WHERE id=$1",
    [userId]
  );
  const user = result.rows[0];
  if (!user || !user.google_refresh_token) return null;

  if (user.google_access_token && user.google_token_expiry && new Date(user.google_token_expiry) > new Date(Date.now() + 60000)) {
    return user.google_access_token;
  }

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: user.google_refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = await r.json();
  if (!r.ok) return null;

  const expiry = new Date(Date.now() + data.expires_in * 1000);
  await pool.query(
    "UPDATE users SET google_access_token=$1, google_token_expiry=$2 WHERE id=$3",
    [data.access_token, expiry, userId]
  );
  return data.access_token;
}

function absenceEventSummary(absence) {
  if (absence.type === "holiday" && absence.notes) return `🎉 ${absence.notes}`;
  return { vacation: "🏖️ Urlaub", sick: "🤒 Krank", holiday: "🎉 Feiertag" }[absence.type] || absence.type;
}

async function syncAbsenceToGoogle(userId, absence) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) return;

  const nextDay = new Date(absence.date);
  nextDay.setDate(nextDay.getDate() + 1);
  const body = JSON.stringify({
    summary: absenceEventSummary(absence),
    start: { date: absence.date.toISOString().split("T")[0] },
    end: { date: nextDay.toISOString().split("T")[0] },
  });

  try {
    if (absence.google_event_id) {
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${absence.google_event_id}`,
        { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body }
      );
    } else {
      const r = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body }
      );
      const event = await r.json();
      if (event.id) {
        await pool.query("UPDATE absences SET google_event_id=$1 WHERE id=$2", [event.id, absence.id]);
      }
    }
  } catch (e) {
    console.error("Google-Sync fehlgeschlagen:", e.message);
  }
}

async function deleteAbsenceFromGoogle(userId, googleEventId) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) return;
  try {
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${googleEventId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
    );
  } catch (e) {
    console.error("Google-Event-Löschung fehlgeschlagen:", e.message);
  }
}

app.get("/api/google/connect", auth, (req, res) => {
  const state = jwt.sign({ id: req.user.id, purpose: "google-oauth" }, JWT_SECRET, { expiresIn: "10m" });
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get("/api/google/callback", async (req, res) => {
  const { code, state } = req.query;
  try {
    const payload = jwt.verify(state, JWT_SECRET);
    if (payload.purpose !== "google-oauth") throw new Error("invalid state");

    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: GOOGLE_REDIRECT_URI,
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.refresh_token) throw new Error(data.error_description || "Kein Refresh-Token erhalten");

    const expiry = new Date(Date.now() + data.expires_in * 1000);
    await pool.query(
      "UPDATE users SET google_refresh_token=$1, google_access_token=$2, google_token_expiry=$3 WHERE id=$4",
      [data.refresh_token, data.access_token, expiry, payload.id]
    );
    res.redirect("/#settings?google=connected");
  } catch (e) {
    console.error("Google-OAuth-Callback-Fehler:", e.message);
    res.redirect("/#settings?google=error");
  }
});

app.post("/api/google/disconnect", auth, async (req, res) => {
  await pool.query(
    "UPDATE users SET google_refresh_token=NULL, google_access_token=NULL, google_token_expiry=NULL WHERE id=$1",
    [req.user.id]
  );
  res.json({ ok: true });
});

app.get("/api/google/events", auth, async (req, res) => {
  const { from, to } = req.query;
  const accessToken = await getValidAccessToken(req.user.id);
  if (!accessToken) return res.json([]);

  const params = new URLSearchParams({
    timeMin: new Date(from).toISOString(),
    timeMax: new Date(to).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
  });
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await r.json();
  if (!r.ok) return res.json([]);

  const events = (data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || "(Ohne Titel)",
    start: e.start.date || e.start.dateTime,
    end: e.end.date || e.end.dateTime,
    allDay: !!e.start.date,
  }));
  res.json(events);
});

// ── Import: Kalender & E-Mails für Abrechnung ───────────────────────────────────

function berlinOffsetMinutes(utcDate) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(utcDate).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === "24" ? 0 : parts.hour, parts.minute, parts.second);
  return (asUTC - utcDate.getTime()) / 60000;
}

function berlinLocalToUTC(y, m, d, hh = 0, mm = 0) {
  const naiveUTC = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const offsetMin = berlinOffsetMinutes(naiveUTC);
  return new Date(naiveUTC.getTime() - offsetMin * 60000);
}

function berlinMonthBounds(year, month) {
  const y = Number(year);
  const m = Number(month);
  const from = berlinLocalToUTC(y, m, 1);
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextYear = m === 12 ? y + 1 : y;
  const to = berlinLocalToUTC(nextYear, nextMonth, 1);
  return { from, to };
}

app.get("/api/import/calendar-events", auth, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: "year und month erforderlich" });
  const accessToken = await getValidAccessToken(req.user.id);
  if (!accessToken) return res.status(400).json({ error: "Google nicht verbunden" });

  const { from, to } = berlinMonthBounds(year, month);
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
  });
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await r.json();
  if (!r.ok) return res.status(502).json({ error: "Google-Kalender-Anfrage fehlgeschlagen" });

  const reviewed = await pool.query(
    "SELECT source_id FROM import_reviews WHERE user_id=$1 AND source_type='calendar'",
    [req.user.id]
  );
  const reviewedIds = new Set(reviewed.rows.map((row) => row.source_id));

  const events = (data.items || [])
    .filter((e) => e.status !== "cancelled" && !reviewedIds.has(e.id))
    .map((e) => ({
      id: e.id,
      source_type: "calendar",
      title: e.summary || "(Ohne Titel)",
      description: e.description || "",
      start: e.start.date || e.start.dateTime,
      end: e.end.date || e.end.dateTime,
      allDay: !!e.start.date,
      status: e.status || "",
      location: e.location || "",
      conferenceLink:
        e.hangoutLink || e.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === "video")?.uri || "",
      organizer: e.organizer ? e.organizer.displayName || e.organizer.email || "" : "",
      organizerEmail: e.organizer ? e.organizer.email || "" : "",
      attendees: (e.attendees || []).map((a) => ({
        name: a.displayName || a.email,
        email: a.email,
        responseStatus: a.responseStatus,
      })),
    }));
  res.json(events);
});

app.get("/api/import/emails", auth, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: "year und month erforderlich" });
  const accessToken = await getValidAccessToken(req.user.id);
  if (!accessToken) return res.status(400).json({ error: "Google nicht verbunden" });

  const { from, to } = berlinMonthBounds(year, month);
  const fmtQ = (d) =>
    `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
  const q = `in:sent after:${fmtQ(from)} before:${fmtQ(to)}`;

  const listParams = new URLSearchParams({ q, maxResults: "50" });
  const listR = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${listParams}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const listData = await listR.json();
  if (!listR.ok) {
    if (listR.status === 403)
      return res.status(403).json({ error: "Bitte Google-Verbindung erneuern (E-Mail-Zugriff fehlt)" });
    return res.status(502).json({ error: "Gmail-Anfrage fehlgeschlagen" });
  }

  const reviewed = await pool.query(
    "SELECT source_id FROM import_reviews WHERE user_id=$1 AND source_type='email'",
    [req.user.id]
  );
  const reviewedIds = new Set(reviewed.rows.map((row) => row.source_id));
  const messageIds = (listData.messages || [])
    .map((m) => m.id)
    .filter((id) => !reviewedIds.has(id));

  const emails = [];
  for (const id of messageIds) {
    const metaParams = new URLSearchParams({ format: "metadata" });
    metaParams.append("metadataHeaders", "Subject");
    metaParams.append("metadataHeaders", "Date");
    metaParams.append("metadataHeaders", "To");
    const mr = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?${metaParams}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!mr.ok) continue;
    const m = await mr.json();
    const headers = m.payload?.headers || [];
    const subject = headers.find((h) => h.name === "Subject")?.value || "(Kein Betreff)";
    const dateHeader = headers.find((h) => h.name === "Date")?.value;
    const to_ = headers.find((h) => h.name === "To")?.value || "";
    emails.push({
      id: m.id,
      source_type: "email",
      title: subject,
      to: to_,
      snippet: m.snippet || "",
      sentAt: dateHeader ? new Date(dateHeader).toISOString() : null,
    });
  }
  res.json(emails);
});

function extractEmailBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return Buffer.from(plain.body.data, "base64url").toString("utf-8");
    for (const part of payload.parts) {
      const body = extractEmailBody(part);
      if (body) return body;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    const html = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

app.get("/api/import/emails/:id/body", auth, async (req, res) => {
  const accessToken = await getValidAccessToken(req.user.id);
  if (!accessToken) return res.status(400).json({ error: "Google nicht verbunden" });
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${req.params.id}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await r.json();
  if (!r.ok) return res.status(502).json({ error: "Gmail-Anfrage fehlgeschlagen" });
  res.json({ body: extractEmailBody(data.payload) || data.snippet || "" });
});

function normalizeSourceIds(source_ids) {
  return [...new Set(Array.isArray(source_ids) ? source_ids.filter((x) => typeof x === "string" && x) : [])];
}

app.post("/api/import/confirm", auth, async (req, res) => {
  const {
    source_type, source_ids, project_id,
    service_date, end_time, duration_hours,
    title, description, metadata,
  } = req.body;
  const ids = normalizeSourceIds(source_ids);
  if (!source_type || !ids.length || ids.length > 200 || !service_date || !title || !duration_hours) {
    return res.status(400).json({ error: "source_ids, service_date, title und duration_hours erforderlich" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let validProjectId = null;
    if (project_id) {
      const proj = await client.query(
        "SELECT id FROM projects WHERE id=$1 AND user_id=$2 AND active=true",
        [project_id, req.user.id]
      );
      if (proj.rows.length) validProjectId = proj.rows[0].id;
    }
    const entry = await client.query(
      `INSERT INTO billing_entries
         (user_id,project_id,service_date,end_time,duration_hours,title,description,source_type,source_external_id,source_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        req.user.id, validProjectId, service_date,
        end_time || null, duration_hours,
        title, description || null, source_type,
        ids.length === 1 ? ids[0] : null,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
    const entryId = entry.rows[0].id;
    const values = [];
    const rows = ids.map((id, i) => {
      values.push(req.user.id, source_type, id, entryId, title, service_date);
      const b = i * 6;
      return `($${b + 1},$${b + 2},$${b + 3},'confirmed',$${b + 4},$${b + 5},$${b + 6},NOW())`;
    });
    await client.query(
      `INSERT INTO import_reviews (user_id,source_type,source_id,status,billing_entry_id,label,item_date,updated_at)
       VALUES ${rows.join(",")}
       ON CONFLICT (user_id,source_type,source_id)
       DO UPDATE SET status='confirmed', billing_entry_id=EXCLUDED.billing_entry_id,
                     label=EXCLUDED.label, item_date=EXCLUDED.item_date, updated_at=NOW()`,
      values
    );
    if (validProjectId) {
      await client.query("UPDATE users SET last_selected_project_id=$1 WHERE id=$2", [validProjectId, req.user.id]);
    }
    await client.query("COMMIT");
    res.json(entry.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Übernehmen fehlgeschlagen" });
  } finally {
    client.release();
  }
});

app.post("/api/import/ignore", auth, async (req, res) => {
  const { source_type, source_ids, label, item_date } = req.body;
  const ids = normalizeSourceIds(source_ids);
  if (!source_type || !ids.length || ids.length > 200) {
    return res.status(400).json({ error: "source_type und source_ids erforderlich" });
  }
  const values = [];
  const rows = ids.map((id, i) => {
    values.push(req.user.id, source_type, id, label || null, item_date || null);
    const b = i * 5;
    return `($${b + 1},$${b + 2},$${b + 3},'ignored',$${b + 4},$${b + 5},NOW())`;
  });
  await pool.query(
    `INSERT INTO import_reviews (user_id,source_type,source_id,status,label,item_date,updated_at)
     VALUES ${rows.join(",")}
     ON CONFLICT (user_id,source_type,source_id)
     DO UPDATE SET status='ignored', label=EXCLUDED.label, item_date=EXCLUDED.item_date, updated_at=NOW()`,
    values
  );
  res.json({ ok: true });
});

app.post("/api/import/restore", auth, async (req, res) => {
  const { source_type, source_ids } = req.body;
  const ids = normalizeSourceIds(source_ids);
  if (!source_type || !ids.length) return res.status(400).json({ error: "source_type und source_ids erforderlich" });
  await pool.query(
    "DELETE FROM import_reviews WHERE user_id=$1 AND source_type=$2 AND source_id = ANY($3::text[]) AND status='ignored'",
    [req.user.id, source_type, ids]
  );
  res.json({ ok: true });
});

app.get("/api/import/ignored", auth, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: "year und month erforderlich" });
  const result = await pool.query(
    `SELECT source_type, source_id, label, item_date FROM import_reviews
     WHERE user_id=$1 AND status='ignored' AND item_date IS NOT NULL
       AND EXTRACT(YEAR FROM item_date)=$2 AND EXTRACT(MONTH FROM item_date)=$3
     ORDER BY item_date`,
    [req.user.id, year, month]
  );
  res.json(result.rows);
});

// ── Abrechnungspositionen ────────────────────────────────────────────────────

app.get("/api/billing", auth, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: "year und month erforderlich" });
  const result = await pool.query(
    `SELECT b.*, p.name as project_name, p.color as project_color, p.external_id as project_ref
     FROM billing_entries b
     LEFT JOIN projects p ON p.id = b.project_id
     WHERE b.user_id=$1
       AND EXTRACT(YEAR FROM b.service_date)=$2 AND EXTRACT(MONTH FROM b.service_date)=$3
     ORDER BY b.service_date`,
    [req.user.id, year, month]
  );
  res.json(result.rows);
});

app.put("/api/billing/:id", auth, async (req, res) => {
  const { project_id, service_date, end_time, duration_hours, title, description } = req.body;
  if (!service_date || !title || !duration_hours) {
    return res.status(400).json({ error: "service_date, title und duration_hours erforderlich" });
  }
  const result = await pool.query(
    `UPDATE billing_entries SET
       project_id=$1, service_date=$2, end_time=$3,
       duration_hours=$4, title=$5, description=$6, updated_at=NOW()
     WHERE id=$7 AND user_id=$8 RETURNING *`,
    [
      project_id || null, service_date, end_time || null,
      duration_hours, title, description || null, req.params.id, req.user.id,
    ]
  );
  if (!result.rows.length) return res.status(404).json({ error: "Nicht gefunden" });
  res.json(result.rows[0]);
});

app.delete("/api/billing/:id", auth, async (req, res) => {
  await pool.query("DELETE FROM billing_entries WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.get("/api/billing/export/xlsx/:year/:month", auth, async (req, res) => {
  const { year, month } = req.params;
  const result = await pool.query(
    `SELECT b.service_date, b.duration_hours, b.title, b.description, b.source_type,
            p.name as project_name, p.external_id as project_ref
     FROM billing_entries b
     LEFT JOIN projects p ON p.id = b.project_id
     WHERE b.user_id=$1
       AND EXTRACT(YEAR FROM b.service_date)=$2 AND EXTRACT(MONTH FROM b.service_date)=$3
     ORDER BY b.service_date`,
    [req.user.id, year, month]
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Abrechnung");
  sheet.columns = [
    { header: "Enddatum", key: "date", width: 12 },
    { header: "Titel", key: "title", width: 30 },
    { header: "Kommentar", key: "desc", width: 40 },
    { header: "Projekt", key: "project", width: 24 },
    { header: "Auftragsnummer", key: "ref", width: 16 },
    { header: "Dauer (Std)", key: "hours", width: 12 },
    { header: "Quelle", key: "source", width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn("date").numFmt = "dd.mm.yyyy";
  sheet.getColumn("hours").numFmt = "0.00";

  for (const r of result.rows) {
    sheet.addRow({
      date: new Date(r.service_date),
      title: r.title,
      project: r.project_name || "",
      ref: r.project_ref || "",
      hours: parseFloat(r.duration_hours) || 0,
      source: r.source_type || "",
      desc: r.description || "",
    });
  }

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="abrechnung-${year}-${String(month).padStart(2, "0")}.xlsx"`
  );
  await workbook.xlsx.write(res);
  res.end();
});

// ── saas.do: Entwicklungsaktivität ──────────────────────────────────────────

const SAASDO_BASE = "https://app.dev.saas.toyota.de";
const SAASDO_TIMEOUT_MS = 15000;
const SAASDO_CACHE_TTL_MS = 20 * 60 * 1000;
const SAASDO_GAP_MINUTES = 30;

let saasdoCookies = {};
let saasdoLoginPromise = null;
const saasdoVersionsCache = new Map();

function saasdoCookieHeader() {
  return Object.entries(saasdoCookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function saasdoStoreCookies(resp) {
  const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const name = pair.slice(0, i).trim();
    if (name === "XSRF-TOKEN" || name === "saas_session") {
      saasdoCookies[name] = pair.slice(i + 1).trim();
    }
  }
}

async function saasdoFetch(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SAASDO_TIMEOUT_MS);
  try {
    return await fetch(`${SAASDO_BASE}${path}`, {
      ...opts,
      redirect: "manual",
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "max-age=0",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "sec-ch-ua": '"Not=A?Brand";v="99", "Google Chrome";v="124", "Chromium";v="124"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        Origin: SAASDO_BASE,
        Referer: `${SAASDO_BASE}/auth/login`,
        ...(opts.headers || {}),
        Cookie: saasdoCookieHeader(),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function saasdoLogin() {
  if (saasdoLoginPromise) return saasdoLoginPromise;
  saasdoLoginPromise = (async () => {
    if (!process.env.SAASDO_USERNAME || !process.env.SAASDO_PASSWORD) {
      throw new Error("saas.do-Zugangsdaten sind nicht konfiguriert");
    }
    saasdoCookies = {};
    const getResp = await saasdoFetch("/auth/login");
    const html = await getResp.text();
    saasdoStoreCookies(getResp);
    const m = html.match(/name="_token" type="hidden" value="([^"]+)"/);
    if (!m) throw new Error("saas.do Login fehlgeschlagen");
    const body = new URLSearchParams({
      _token: m[1],
      email: process.env.SAASDO_USERNAME,
      password: process.env.SAASDO_PASSWORD,
    });
    const postResp = await saasdoFetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    saasdoStoreCookies(postResp);
    const location = postResp.headers.get("location") || "";
    if (postResp.status !== 302 || location.endsWith("/auth/login")) {
      saasdoCookies = {};
      throw new Error("saas.do Login fehlgeschlagen");
    }
  })();
  try {
    await saasdoLoginPromise;
  } finally {
    saasdoLoginPromise = null;
  }
}

function saasdoLooksAuthenticated(resp) {
  const contentType = resp.headers.get("content-type") || "";
  return resp.status === 200 && contentType.includes("application/json");
}

async function saasdoFetchVersionsRaw(appId) {
  const path = `/apps/show/${appId}/versions/api/versions/`;
  let resp;
  try {
    resp = await saasdoFetch(path);
  } catch (e) {
    throw new Error("saas.do nicht erreichbar");
  }
  saasdoStoreCookies(resp);
  // Nicht nur 302 (Redirect auf /auth/login) gilt als "nicht eingeloggt" – ein komplett
  // cookieloser Request (z.B. beim allerersten Aufruf nach Prozessstart) kann von saas.do
  // auch direkt mit 401/403 statt einem Redirect beantwortet werden.
  if (!saasdoLooksAuthenticated(resp)) {
    await saasdoLogin();
    try {
      resp = await saasdoFetch(path);
    } catch (e) {
      throw new Error("saas.do nicht erreichbar");
    }
    saasdoStoreCookies(resp);
  }
  if (!saasdoLooksAuthenticated(resp)) {
    throw new Error(
      resp.status === 302 || resp.status === 401 || resp.status === 403
        ? "saas.do: Login fehlgeschlagen oder App nicht gefunden"
        : `saas.do antwortete unerwartet (Status ${resp.status})`
    );
  }
  return resp.json();
}

async function saasdoFetchVersions(appId) {
  const key = String(appId);
  const cached = saasdoVersionsCache.get(key);
  if (cached?.data && Date.now() - cached.fetchedAt < SAASDO_CACHE_TTL_MS) {
    return cached.data;
  }
  if (cached?.inflight) return cached.inflight;
  const inflight = saasdoFetchVersionsRaw(appId)
    .then((data) => {
      saasdoVersionsCache.set(key, { data, fetchedAt: Date.now() });
      return data;
    })
    .catch((e) => {
      saasdoVersionsCache.delete(key);
      throw e;
    });
  saasdoVersionsCache.set(key, { ...(cached || {}), inflight });
  return inflight;
}

// Parst "dd/MM/yyyy, HH:mm:ss" explizit (kein new Date(...) auf unbekanntes Format),
// behandelt die Werte konsistent als Berlin-Wanduhrzeit (ausreichend für eine Schätzung).
function parseSaasdoDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})$/.exec(s || "");
  if (!m) return null;
  const [, dd, mo, yyyy, hh, mi, ss] = m;
  return Date.UTC(Number(yyyy), Number(mo) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
}

function saasdoDateKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function computeDayBlocks(commits, gapMinutes = SAASDO_GAP_MINUTES) {
  const sorted = [...commits].sort((a, b) => a.ts - b.ts);
  const blocks = [];
  let current = [];
  for (const c of sorted) {
    if (current.length && c.ts - current[current.length - 1].ts > gapMinutes * 60000) {
      blocks.push(current);
      current = [];
    }
    current.push(c);
  }
  if (current.length) blocks.push(current);
  return blocks.map((block) => ({
    commits: block,
    startTs: block[0].ts,
    endTs: block[block.length - 1].ts,
    durationMs: block.length > 1 ? block[block.length - 1].ts - block[0].ts : 0,
    hasDuration: block.length > 1,
  }));
}

const SAASDO_VERBS = [
  "create", "update", "delete", "add", "remove", "fix", "test", "debug", "cleanup", "refactor",
  "erstellt", "erstellen", "angepasst", "anpassen", "behoben", "gelöscht", "löschen", "hinzugefügt",
  "entfernt", "bereinigt", "getestet", "geändert", "ändern", "überarbeitet",
];
const SAASDO_NOUNS = ["flux", "api", "entity", "entities", "scheduler", "component", "komponente", "page", "view", "query", "table", "field", "widget"];

function summarizeSaasdoMessage(message) {
  const firstLine = (message || "").split("\n")[0].trim();
  if (!firstLine) return null;
  const lower = firstLine.toLowerCase();
  const verb = SAASDO_VERBS.find((v) => lower.includes(v));
  const quoted = firstLine.match(/["'`]([^"'`]{2,60})["'`]/);
  const noun = SAASDO_NOUNS.find((n) => lower.includes(n));
  if (verb && (quoted || noun)) {
    const subject = quoted ? quoted[1] : noun;
    return { matched: true, verb, subject, text: firstLine };
  }
  return { matched: false, text: firstLine };
}

// Regelbasierte, nicht erfundene Zusammenfassung: pro Commit einzeln klassifizieren,
// Treffer kompakt aggregieren, Rest als eindeutige Commit-Titel anhängen (Fallback ist
// erwartbar häufig, z.B. bei deutschsprachigen oder unstrukturierten Nachrichten).
function summarizeSaasdoCommits(commits) {
  const seen = new Set();
  const matched = [];
  const fallback = [];
  for (const c of commits) {
    const s = summarizeSaasdoMessage(c.message);
    if (!s || seen.has(s.text)) continue;
    seen.add(s.text);
    if (s.matched) matched.push(s);
    else fallback.push(s.text);
  }
  const lines = [];
  for (const s of matched) lines.push(`${s.verb} „${s.subject}": ${s.text}`);
  for (const t of fallback) lines.push(t);
  const CAP = 20;
  if (lines.length > CAP) {
    const shown = lines.slice(0, CAP);
    shown.push(`+${lines.length - CAP} weitere`);
    return shown.join("\n");
  }
  return lines.join("\n");
}

app.get("/api/import/saasdo", auth, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: "year und month erforderlich" });

  const userResult = await pool.query("SELECT name, saasdo_author FROM users WHERE id=$1", [req.user.id]);
  const author = userResult.rows[0]?.saasdo_author || userResult.rows[0]?.name;

  const appsResult = await pool.query(
    "SELECT id, app_id, app_name FROM saasdo_apps WHERE user_id=$1 AND active=true ORDER BY id",
    [req.user.id]
  );
  if (!appsResult.rows.length) return res.json({ days: [], warnings: [] });

  const appIdToApp = new Map();
  for (const a of appsResult.rows) appIdToApp.set(a.app_id, a);

  const reviewed = await pool.query(
    "SELECT source_id FROM import_reviews WHERE user_id=$1 AND source_type='saasdo'",
    [req.user.id]
  );
  const reviewedIds = new Set(reviewed.rows.map((r) => r.source_id));

  const appIds = [...appIdToApp.keys()];
  const synced = await pool.query(
    "SELECT app_id, versions, synced_at FROM saasdo_synced_versions WHERE user_id=$1 AND app_id = ANY($2::int[])",
    [req.user.id, appIds]
  );
  const syncedByAppId = new Map(synced.rows.map((r) => [r.app_id, r]));

  const warnings = [];
  const allCommits = [];
  for (const appId of appIds) {
    const app = appIdToApp.get(appId);
    const row = syncedByAppId.get(appId);
    if (!row) {
      warnings.push(`App „${app.app_name}" (${appId}): noch nicht synchronisiert – bitte lokalen Connector ausführen`);
      continue;
    }
    for (const v of row.versions) {
      if (v.author !== author) continue;
      const ts = parseSaasdoDate(v.date);
      if (ts == null) continue;
      const sourceId = `saasdo:${appId}:${v.tag}`;
      if (reviewedIds.has(sourceId)) continue;
      allCommits.push({
        sourceId, appId, appName: app.app_name,
        tag: v.tag, author: v.author, message: v.message || "", ts,
      });
    }
  }

  if (!syncedByAppId.size) {
    return res.status(200).json({ days: [], warnings });
  }

  const y = Number(year), mo = Number(month);
  const inMonth = allCommits.filter((c) => {
    const d = new Date(c.ts);
    return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === mo;
  });

  const byDay = new Map();
  for (const c of inMonth) {
    const key = saasdoDateKey(c.ts);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(c);
  }

  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, commits]) => {
      const blocks = computeDayBlocks(commits);
      const sortedCommits = [...commits].sort((a, b) => a.ts - b.ts);
      const estimatedActivityMs = blocks.reduce((s, b) => s + b.durationMs, 0);
      const activityWindowMs =
        sortedCommits.length > 1 ? sortedCommits[sortedCommits.length - 1].ts - sortedCommits[0].ts : 0;
      const apps = [...new Map(commits.map((c) => [c.appId, { appId: c.appId, appName: c.appName }])).values()];
      return {
        date,
        commitCount: commits.length,
        apps,
        firstCommitAt: sortedCommits[0].ts,
        lastCommitAt: sortedCommits[sortedCommits.length - 1].ts,
        activityWindowMs,
        estimatedActivityMs,
        summary: summarizeSaasdoCommits(sortedCommits),
        blocks: blocks.map((b, i) => ({
          blockIndex: i,
          startTs: b.startTs,
          endTs: b.endTs,
          durationMs: b.durationMs,
          hasDuration: b.hasDuration,
          commits: b.commits.map((c) => ({
            sourceId: c.sourceId, appId: c.appId, appName: c.appName,
            tag: c.tag, author: c.author, message: c.message, ts: c.ts,
          })),
        })),
      };
    });

  res.json({ days, warnings });
});

// ── Feiertage ─────────────────────────────────────────────────────────────────

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function bussUndBettag(year) {
  const nov23 = new Date(Date.UTC(year, 10, 23));
  const diff = ((nov23.getUTCDay() - 3 + 7) % 7) || 7;
  return addDays(nov23, -diff);
}

const iso = (d) => d.toISOString().split("T")[0];

function germanHolidays(year, bundesland) {
  const easter = easterSunday(year);

  const holidays = [
    { date: iso(new Date(Date.UTC(year, 0, 1))), name: "Neujahr" },
    { date: iso(addDays(easter, -2)), name: "Karfreitag" },
    { date: iso(addDays(easter, 1)), name: "Ostermontag" },
    { date: iso(new Date(Date.UTC(year, 4, 1))), name: "Tag der Arbeit" },
    { date: iso(addDays(easter, 39)), name: "Christi Himmelfahrt" },
    { date: iso(addDays(easter, 50)), name: "Pfingstmontag" },
    { date: iso(new Date(Date.UTC(year, 9, 3))), name: "Tag der Deutschen Einheit" },
    { date: iso(new Date(Date.UTC(year, 11, 25))), name: "1. Weihnachtsfeiertag" },
    { date: iso(new Date(Date.UTC(year, 11, 26))), name: "2. Weihnachtsfeiertag" },
  ];

  const stateHolidays = [
    { date: iso(new Date(Date.UTC(year, 0, 6))), name: "Heilige Drei Könige", states: ["BW", "BY", "ST"] },
    { date: iso(addDays(easter, 60)), name: "Fronleichnam", states: ["BW", "BY", "HE", "NW", "RP", "SL"] },
    { date: iso(new Date(Date.UTC(year, 7, 15))), name: "Mariä Himmelfahrt", states: ["BY", "SL"] },
    { date: iso(new Date(Date.UTC(year, 8, 20))), name: "Weltkindertag", states: ["TH"] },
    { date: iso(new Date(Date.UTC(year, 9, 31))), name: "Reformationstag", states: ["BB", "MV", "SN", "ST", "TH", "HB", "HH", "NI", "SH"] },
    { date: iso(new Date(Date.UTC(year, 10, 1))), name: "Allerheiligen", states: ["BW", "BY", "NW", "RP", "SL"] },
    { date: iso(bussUndBettag(year)), name: "Buß- und Bettag", states: ["SN"] },
  ];

  for (const h of stateHolidays) {
    if (h.states.includes(bundesland)) holidays.push({ date: h.date, name: h.name });
  }

  return holidays;
}

app.post("/api/holidays/generate", auth, async (req, res) => {
  const user = await pool.query("SELECT bundesland FROM users WHERE id=$1", [req.user.id]);
  const bundesland = user.rows[0]?.bundesland;
  if (!bundesland) return res.status(400).json({ error: "Bitte zuerst ein Bundesland auswählen" });

  const thisYear = new Date().getFullYear();
  const years = [thisYear, thisYear + 1];

  for (const year of years) {
    for (const h of germanHolidays(year, bundesland)) {
      const result = await pool.query(
        `INSERT INTO absences (user_id,date,type,notes,auto_generated) VALUES ($1,$2,'holiday',$3,true)
         ON CONFLICT (user_id,date) DO UPDATE SET type='holiday',notes=$3,auto_generated=true
         WHERE absences.type='holiday' OR absences.auto_generated=true
         RETURNING *`,
        [req.user.id, h.date, h.name]
      );
      if (result.rows.length) syncAbsenceToGoogle(req.user.id, result.rows[0]);
    }
  }

  const countResult = await pool.query(
    "SELECT COUNT(*) FROM absences WHERE user_id=$1 AND type='holiday' AND auto_generated=true AND EXTRACT(YEAR FROM date) = ANY($2)",
    [req.user.id, years]
  );
  res.json({ count: parseInt(countResult.rows[0].count) });
});

// ── Time tracking ─────────────────────────────────────────────────────────────

app.get("/api/time/today", auth, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const entry = await pool.query(
    `SELECT te.*
     FROM time_entries te
     WHERE te.user_id=$1 AND DATE(te.check_in AT TIME ZONE 'Europe/Berlin') = $2
     ORDER BY te.check_in DESC LIMIT 1`,
    [req.user.id, today]
  );
  if (!entry.rows.length) return res.json({ status: "out", entry: null, breaks: [] });

  const e = entry.rows[0];
  const breaks = await pool.query(
    "SELECT * FROM breaks WHERE time_entry_id=$1 ORDER BY start_time",
    [e.id]
  );
  res.json({ status: e.check_out ? "out" : "in", entry: e, breaks: breaks.rows });
});

app.get("/api/time/month-progress", auth, async (req, res) => {
  const user = await pool.query("SELECT daily_hours FROM users WHERE id=$1", [req.user.id]);
  const dailyHours = parseFloat(user.rows[0]?.daily_hours || 8);

  const weekdays = await pool.query(
    `WITH info AS (
       SELECT
         date_trunc('month', (NOW() AT TIME ZONE 'Europe/Berlin'))::date AS month_start,
         (date_trunc('month', (NOW() AT TIME ZONE 'Europe/Berlin')) + interval '1 month - 1 day')::date AS month_end,
         COALESCE(u.tracking_start_date, u.created_at::date) AS start_date
       FROM users u WHERE u.id=$1
     ),
     bounds AS (
       SELECT GREATEST(month_start, start_date) AS range_start, month_end AS range_end FROM info
     ),
     month_days AS (
       SELECT generate_series(range_start, range_end, interval '1 day')::date AS d
       FROM bounds
     ),
     weekdays AS (
       SELECT d FROM month_days WHERE EXTRACT(DOW FROM d) NOT IN (0,6)
     )
     SELECT
       (SELECT COUNT(*) FROM weekdays) AS total_weekdays,
       (SELECT COUNT(*) FROM weekdays w
          JOIN absences a ON a.date = w.d AND a.user_id=$1 AND a.type IN ('holiday','vacation','sick')
       ) AS absence_weekdays`,
    [req.user.id]
  );
  const totalWeekdays = parseInt(weekdays.rows[0].total_weekdays);
  const absenceWeekdays = parseInt(weekdays.rows[0].absence_weekdays);
  const requiredHours = (totalWeekdays - absenceWeekdays) * dailyHours;

  const worked = await pool.query(
    `SELECT COALESCE(SUM(GREATEST(0,
       EXTRACT(EPOCH FROM (COALESCE(te.check_out,NOW()) - te.check_in))/3600 -
       COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(b.end_time,NOW()) - b.start_time)))
                  FROM breaks b WHERE b.time_entry_id = te.id) / 3600, 0)
     )), 0) AS worked_hours
     FROM time_entries te
     WHERE te.user_id=$1
       AND EXTRACT(YEAR FROM te.check_in AT TIME ZONE 'Europe/Berlin') = EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Europe/Berlin')
       AND EXTRACT(MONTH FROM te.check_in AT TIME ZONE 'Europe/Berlin') = EXTRACT(MONTH FROM NOW() AT TIME ZONE 'Europe/Berlin')`,
    [req.user.id]
  );
  const workedHours = parseFloat(worked.rows[0].worked_hours);

  res.json({
    requiredHours,
    workedHours,
    remainingHours: Math.max(0, requiredHours - workedHours),
    overtimeHours: Math.max(0, workedHours - requiredHours),
  });
});

app.post("/api/time/checkin", auth, async (req, res) => {
  const { notes, project_id } = req.body;

  const existing = await pool.query(
    `SELECT id FROM time_entries WHERE user_id=$1 AND check_out IS NULL`,
    [req.user.id]
  );
  if (existing.rows.length) return res.status(400).json({ error: "Bereits eingecheckt" });

  let validProjectId = null;
  if (project_id) {
    const proj = await pool.query(
      "SELECT id FROM projects WHERE id=$1 AND user_id=$2 AND active=true",
      [project_id, req.user.id]
    );
    if (proj.rows.length) validProjectId = proj.rows[0].id;
  }

  const result = await pool.query(
    "INSERT INTO time_entries (user_id,project_id,check_in,notes) VALUES ($1,$2,NOW(),$3) RETURNING *",
    [req.user.id, validProjectId, notes || null]
  );
  if (validProjectId) {
    try {
      await pool.query("UPDATE users SET last_selected_project_id=$1 WHERE id=$2", [validProjectId, req.user.id]);
    } catch (e) {
      console.error("last_selected_project_id update failed", e.message);
    }
  }
  res.json(result.rows[0]);
});

app.post("/api/time/checkout", auth, async (req, res) => {
  const { notes } = req.body;
  const entry = await pool.query(
    "SELECT * FROM time_entries WHERE user_id=$1 AND check_out IS NULL ORDER BY check_in DESC LIMIT 1",
    [req.user.id]
  );
  if (!entry.rows.length) return res.status(400).json({ error: "Nicht eingecheckt" });

  const e = entry.rows[0];

  // close any open break first
  await pool.query(
    "UPDATE breaks SET end_time=NOW() WHERE time_entry_id=$1 AND end_time IS NULL",
    [e.id]
  );

  const result = await pool.query(
    "UPDATE time_entries SET check_out=NOW(), notes=COALESCE($1,notes) WHERE id=$2 RETURNING *",
    [notes || null, e.id]
  );
  res.json(result.rows[0]);
});

app.post("/api/time/break/start", auth, async (req, res) => {
  const entry = await pool.query(
    "SELECT id FROM time_entries WHERE user_id=$1 AND check_out IS NULL ORDER BY check_in DESC LIMIT 1",
    [req.user.id]
  );
  if (!entry.rows.length) return res.status(400).json({ error: "Nicht eingecheckt" });

  const openBreak = await pool.query(
    "SELECT id FROM breaks WHERE time_entry_id=$1 AND end_time IS NULL",
    [entry.rows[0].id]
  );
  if (openBreak.rows.length) return res.status(400).json({ error: "Pause läuft bereits" });

  const result = await pool.query(
    "INSERT INTO breaks (time_entry_id,start_time) VALUES ($1,NOW()) RETURNING *",
    [entry.rows[0].id]
  );
  res.json(result.rows[0]);
});

app.post("/api/time/break/end", auth, async (req, res) => {
  const entry = await pool.query(
    "SELECT id FROM time_entries WHERE user_id=$1 AND check_out IS NULL ORDER BY check_in DESC LIMIT 1",
    [req.user.id]
  );
  if (!entry.rows.length) return res.status(400).json({ error: "Nicht eingecheckt" });

  const result = await pool.query(
    "UPDATE breaks SET end_time=NOW() WHERE time_entry_id=$1 AND end_time IS NULL RETURNING *",
    [entry.rows[0].id]
  );
  if (!result.rows.length) return res.status(400).json({ error: "Keine aktive Pause" });
  res.json(result.rows[0]);
});

// ── Monthly report ────────────────────────────────────────────────────────────

app.get("/api/time/month/:year/:month", auth, async (req, res) => {
  const { year, month } = req.params;
  const userId = req.query.user_id && req.user.role === "admin" ? req.query.user_id : req.user.id;

  const entries = await pool.query(
    `SELECT te.*,
            p.name as project_name, p.color as project_color,
            COALESCE(
              EXTRACT(EPOCH FROM (COALESCE(te.check_out,NOW()) - te.check_in))/3600, 0
            ) as gross_hours,
            COALESCE(
              (SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(b.end_time,NOW()) - b.start_time)))
               FROM breaks b WHERE b.time_entry_id = te.id) / 3600,
              0
            ) as break_hours
     FROM time_entries te
     LEFT JOIN projects p ON p.id = te.project_id
     WHERE te.user_id=$1
       AND EXTRACT(YEAR FROM te.check_in AT TIME ZONE 'Europe/Berlin') = $2
       AND EXTRACT(MONTH FROM te.check_in AT TIME ZONE 'Europe/Berlin') = $3
     ORDER BY te.check_in DESC`,
    [userId, year, month]
  );

  const absences = await pool.query(
    `SELECT * FROM absences WHERE user_id=$1
     AND EXTRACT(YEAR FROM date)=$2 AND EXTRACT(MONTH FROM date)=$3
     ORDER BY date`,
    [userId, year, month]
  );

  const user = await pool.query(
    "SELECT daily_hours, vacation_days_per_year FROM users WHERE id=$1",
    [userId]
  );

  const dailyHours = parseFloat(user.rows[0]?.daily_hours || 8);

  const entryIds = entries.rows.map((e) => e.id);
  const breaksResult = entryIds.length
    ? await pool.query(
        "SELECT * FROM breaks WHERE time_entry_id = ANY($1) ORDER BY start_time",
        [entryIds]
      )
    : { rows: [] };
  const breaksByEntry = {};
  for (const b of breaksResult.rows) {
    (breaksByEntry[b.time_entry_id] ??= []).push(b);
  }

  // compute net hours per entry
  const enriched = entries.rows.map((e) => ({
    ...e,
    net_hours: Math.max(0, parseFloat(e.gross_hours) - parseFloat(e.break_hours)),
    breaks: breaksByEntry[e.id] || [],
  }));

  const totalNet = enriched.reduce((s, e) => s + e.net_hours, 0);
  const workDays = enriched.length;
  const shouldHours = workDays * dailyHours;
  const overtime = totalNet - shouldHours;

  const allTime = await pool.query(
    `SELECT
       COUNT(*) as work_days,
       COALESCE(SUM(GREATEST(0,
         EXTRACT(EPOCH FROM (COALESCE(te.check_out,NOW()) - te.check_in))/3600 -
         COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(b.end_time,NOW()) - b.start_time)))
                    FROM breaks b WHERE b.time_entry_id = te.id) / 3600, 0)
       )), 0) as total_net
     FROM time_entries te
     WHERE te.user_id=$1
       AND (te.check_in AT TIME ZONE 'Europe/Berlin')::date
           <= (make_date($2::int,$3::int,1) + interval '1 month - 1 day')::date`,
    [userId, year, month]
  );
  const runningWorkDays = parseInt(allTime.rows[0].work_days);
  const runningNet = parseFloat(allTime.rows[0].total_net);
  const runningBalance = runningNet - runningWorkDays * dailyHours;

  res.json({
    entries: enriched,
    absences: absences.rows,
    summary: { totalNet, workDays, shouldHours, overtime, dailyHours, runningBalance },
  });
});

// ── Excel export ──────────────────────────────────────────────────────────────

app.get("/api/time/export/xlsx/:year/:month", auth, async (req, res) => {
  const { year, month } = req.params;
  const userId = req.query.user_id && req.user.role === "admin" ? req.query.user_id : req.user.id;

  const entries = await pool.query(
    `SELECT te.check_in, te.check_out, te.notes,
            COALESCE(
              EXTRACT(EPOCH FROM (COALESCE(te.check_out,NOW()) - te.check_in))/3600, 0
            ) as gross_hours,
            COALESCE(
              (SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(b.end_time,NOW()) - b.start_time)))
               FROM breaks b WHERE b.time_entry_id = te.id) / 3600,
              0
            ) as break_hours
     FROM time_entries te
     WHERE te.user_id=$1
       AND EXTRACT(YEAR FROM te.check_in AT TIME ZONE 'Europe/Berlin') = $2
       AND EXTRACT(MONTH FROM te.check_in AT TIME ZONE 'Europe/Berlin') = $3
     ORDER BY te.check_in`,
    [userId, year, month]
  );

  const berlinDateOnly = (ts) => {
    const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" })
      .format(new Date(ts))
      .split("-")
      .map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : "");
  const round2 = (v) => Math.round(Math.max(0, parseFloat(v)) * 100) / 100;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Zeiten");
  sheet.columns = [
    { header: "Datum", key: "date", width: 12 },
    { header: "Check-In", key: "checkIn", width: 18 },
    { header: "Check-Out", key: "checkOut", width: 18 },
    { header: "Brutto-Stunden", key: "gross", width: 14 },
    { header: "Pause (h)", key: "pause", width: 12 },
    { header: "Netto-Stunden", key: "net", width: 14 },
    { header: "Notiz", key: "notes", width: 30 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn("date").numFmt = "dd.mm.yyyy";
  sheet.getColumn("gross").numFmt = "0.00";
  sheet.getColumn("pause").numFmt = "0.00";
  sheet.getColumn("net").numFmt = "0.00";

  for (const e of entries.rows) {
    sheet.addRow({
      date: berlinDateOnly(e.check_in),
      checkIn: fmt(e.check_in),
      checkOut: fmt(e.check_out),
      gross: round2(e.gross_hours),
      pause: round2(e.break_hours),
      net: round2(parseFloat(e.gross_hours) - parseFloat(e.break_hours)),
      notes: e.notes || "",
    });
  }

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="zeiten-${year}-${String(month).padStart(2, "0")}.xlsx"`
  );
  await workbook.xlsx.write(res);
  res.end();
});

// ── Projects ──────────────────────────────────────────────────────────────────

app.get("/api/projects", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM projects WHERE user_id=$1 AND active=true ORDER BY name",
    [req.user.id]
  );
  res.json(result.rows);
});

function parseSaasdoAppId(value) {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return { ok: false };
  return { ok: true, value: n };
}

app.post("/api/projects", auth, async (req, res) => {
  const { name, color, external_id } = req.body;
  if (!name) return res.status(400).json({ error: "Name erforderlich" });
  const result = await pool.query(
    "INSERT INTO projects (user_id,name,color,external_id) VALUES ($1,$2,$3,$4) RETURNING *",
    [req.user.id, name, color || "#c08552", external_id || null]
  );
  res.json(result.rows[0]);
});

app.put("/api/projects/:id", auth, async (req, res) => {
  const { name, color, external_id, active } = req.body;
  const result = await pool.query(
    "UPDATE projects SET name=$1,color=$2,external_id=$3,active=$4 WHERE id=$5 AND user_id=$6 RETURNING *",
    [name, color, external_id || null, active !== false, req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: "Nicht gefunden" });
  res.json(result.rows[0]);
});

app.delete("/api/projects/:id", auth, async (req, res) => {
  await pool.query("UPDATE projects SET active=false WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ── saas.do-Apps (zentrale, projektunabhängige Liste) ───────────────────────

app.get("/api/saasdo-apps", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT sa.*, sv.synced_at
     FROM saasdo_apps sa
     LEFT JOIN saasdo_synced_versions sv ON sv.user_id = sa.user_id AND sv.app_id = sa.app_id
     WHERE sa.user_id=$1
     ORDER BY sa.app_name`,
    [req.user.id]
  );
  res.json(result.rows);
});

app.post("/api/saasdo-apps", auth, async (req, res) => {
  const { app_id, app_name, note } = req.body;
  const appId = parseSaasdoAppId(app_id);
  if (!appId.ok || appId.value === null) {
    return res.status(400).json({ error: "App-ID muss eine positive Ganzzahl sein" });
  }
  if (!app_name) return res.status(400).json({ error: "App-Name erforderlich" });
  const existing = await pool.query(
    "SELECT id FROM saasdo_apps WHERE user_id=$1 AND app_id=$2",
    [req.user.id, appId.value]
  );
  if (existing.rows.length) return res.status(409).json({ error: "App-ID bereits vorhanden" });
  const result = await pool.query(
    "INSERT INTO saasdo_apps (user_id,app_id,app_name,note) VALUES ($1,$2,$3,$4) RETURNING *",
    [req.user.id, appId.value, app_name, note || null]
  );
  res.json(result.rows[0]);
});

app.put("/api/saasdo-apps/:id", auth, async (req, res) => {
  const { app_name, note, active } = req.body;
  if (!app_name) return res.status(400).json({ error: "App-Name erforderlich" });
  const result = await pool.query(
    "UPDATE saasdo_apps SET app_name=$1,note=$2,active=$3,updated_at=NOW() WHERE id=$4 AND user_id=$5 RETURNING *",
    [app_name, note || null, active !== false, req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: "Nicht gefunden" });
  res.json(result.rows[0]);
});

app.delete("/api/saasdo-apps/:id", auth, async (req, res) => {
  const app = await pool.query(
    "SELECT app_id FROM saasdo_apps WHERE id=$1 AND user_id=$2",
    [req.params.id, req.user.id]
  );
  if (!app.rows.length) return res.status(404).json({ error: "Nicht gefunden" });
  const referenced = await pool.query(
    `SELECT 1 FROM import_reviews
     WHERE user_id=$1 AND source_type='saasdo' AND source_id LIKE 'saasdo:' || $2::text || ':%'
     LIMIT 1`,
    [req.user.id, app.rows[0].app_id]
  );
  if (referenced.rows.length) {
    return res.status(400).json({ error: "App wird bereits von Organizer-Daten referenziert – bitte stattdessen deaktivieren" });
  }
  await pool.query(
    "DELETE FROM saasdo_synced_versions WHERE user_id=$1 AND app_id=$2",
    [req.user.id, app.rows[0].app_id]
  );
  await pool.query("DELETE FROM saasdo_apps WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// Push-Ziel für den lokalen saas.do-Connector (server-seitiger Live-Abruf wird von der
// WAF vor app.dev.saas.toyota.de blockiert - der Connector läuft stattdessen vom
// bereits autorisierten Rechner des Nutzers aus und reicht die Rohdaten hier durch.
app.post("/api/saasdo/sync", auth, async (req, res) => {
  const { results } = req.body;
  if (!Array.isArray(results) || !results.length) {
    return res.status(400).json({ error: "results erforderlich" });
  }
  const owned = await pool.query("SELECT app_id FROM saasdo_apps WHERE user_id=$1", [req.user.id]);
  const ownedIds = new Set(owned.rows.map((r) => r.app_id));

  const synced = [];
  const skipped = [];
  for (const entry of results) {
    const appId = Number(entry?.app_id);
    if (!Number.isInteger(appId) || !ownedIds.has(appId) || !Array.isArray(entry?.versions)) {
      skipped.push(entry?.app_id);
      continue;
    }
    await pool.query(
      `INSERT INTO saasdo_synced_versions (user_id,app_id,versions,synced_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id,app_id) DO UPDATE SET versions=EXCLUDED.versions, synced_at=NOW()`,
      [req.user.id, appId, JSON.stringify(entry.versions)]
    );
    synced.push(appId);
  }
  res.json({ synced, skipped });
});

// ── Absences ──────────────────────────────────────────────────────────────────

app.get("/api/absences/:year", auth, async (req, res) => {
  const userId = req.query.user_id && req.user.role === "admin" ? req.query.user_id : req.user.id;
  const result = await pool.query(
    "SELECT * FROM absences WHERE user_id=$1 AND EXTRACT(YEAR FROM date)=$2 ORDER BY date",
    [userId, req.params.year]
  );
  const vacationCount = result.rows.filter((r) => r.type === "vacation").length;
  const user = await pool.query("SELECT vacation_days_per_year FROM users WHERE id=$1", [userId]);
  res.json({
    absences: result.rows,
    vacation_taken: vacationCount,
    vacation_total: user.rows[0]?.vacation_days_per_year || 28,
    vacation_remaining: (user.rows[0]?.vacation_days_per_year || 28) - vacationCount,
  });
});

app.post("/api/absences", auth, async (req, res) => {
  const { date, type, notes } = req.body;
  if (!date || !type) return res.status(400).json({ error: "Datum und Typ erforderlich" });
  try {
    const result = await pool.query(
      "INSERT INTO absences (user_id,date,type,notes) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,date) DO UPDATE SET type=$3,notes=$4 RETURNING *",
      [req.user.id, date, type, notes || null]
    );
    const absence = result.rows[0];
    syncAbsenceToGoogle(req.user.id, absence);
    res.json(absence);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/absences/:id", auth, async (req, res) => {
  const result = await pool.query(
    "DELETE FROM absences WHERE id=$1 AND user_id=$2 RETURNING google_event_id",
    [req.params.id, req.user.id]
  );
  if (result.rows[0]?.google_event_id) {
    deleteAbsenceFromGoogle(req.user.id, result.rows[0].google_event_id);
  }
  res.json({ ok: true });
});

// ── Admin ─────────────────────────────────────────────────────────────────────

app.get("/api/admin/users", auth, adminOnly, async (req, res) => {
  const result = await pool.query(
    "SELECT id,name,email,role,daily_hours,vacation_days_per_year,created_at FROM users ORDER BY name"
  );
  res.json(result.rows);
});

app.put("/api/admin/users/:id", auth, adminOnly, async (req, res) => {
  const { name, role, daily_hours, vacation_days_per_year } = req.body;
  const result = await pool.query(
    "UPDATE users SET name=$1,role=$2,daily_hours=$3,vacation_days_per_year=$4 WHERE id=$5 RETURNING id,name,email,role,daily_hours,vacation_days_per_year",
    [name, role, daily_hours, vacation_days_per_year, req.params.id]
  );
  res.json(result.rows[0]);
});

app.delete("/api/admin/users/:id", auth, adminOnly, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: "Eigenen Account nicht löschbar" });
  await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ── Time entry edit ───────────────────────────────────────────────────────────

app.put("/api/time/:id", auth, async (req, res) => {
  const { check_in, check_out, notes, project_id } = req.body;
  const result = await pool.query(
    `UPDATE time_entries SET check_in=$1,check_out=$2,notes=$3,project_id=$4
     WHERE id=$5 AND user_id=$6 RETURNING *`,
    [check_in, check_out || null, notes || null, project_id || null, req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: "Nicht gefunden" });
  res.json(result.rows[0]);
});

app.delete("/api/time/:id", auth, async (req, res) => {
  await pool.query("DELETE FROM time_entries WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.put("/api/breaks/:id", auth, async (req, res) => {
  const { start_time, end_time } = req.body;
  const result = await pool.query(
    `UPDATE breaks SET start_time=$1, end_time=$2
     WHERE id=$3 AND time_entry_id IN (SELECT id FROM time_entries WHERE user_id=$4)
     RETURNING *`,
    [start_time, end_time || null, req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: "Nicht gefunden" });
  res.json(result.rows[0]);
});

// ── Catch-all → SPA ──────────────────────────────────────────────────────────

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────

initDB().then(() => {
  app.listen(PORT, () => console.log(`Zeit-Tracking läuft auf Port ${PORT}`));
}).catch((e) => {
  console.error("DB-Fehler:", e.message);
  process.exit(1);
});
