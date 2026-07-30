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

app.use(express.json());
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
    `);
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
      "SELECT id,name,email,password_hash,role,daily_hours,vacation_days_per_year,office_lat,office_lng,office_radius,bundesland,accent_color,tracking_start_date,(google_refresh_token IS NOT NULL) as google_connected FROM users WHERE email=$1",
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
    "SELECT id,name,email,role,daily_hours,vacation_days_per_year,office_lat,office_lng,office_radius,bundesland,accent_color,tracking_start_date,(google_refresh_token IS NOT NULL) as google_connected FROM users WHERE id=$1",
    [req.user.id]
  );
  res.json(result.rows[0]);
});

app.put("/api/auth/me", auth, async (req, res) => {
  const { name, daily_hours, vacation_days_per_year, office_lat, office_lng, office_radius, bundesland, accent_color, tracking_start_date } = req.body;
  await pool.query(
    "UPDATE users SET name=$1,daily_hours=$2,vacation_days_per_year=$3,office_lat=$4,office_lng=$5,office_radius=$6,bundesland=$7,accent_color=$8,tracking_start_date=$9 WHERE id=$10",
    [name, daily_hours, vacation_days_per_year, office_lat || null, office_lng || null, office_radius || 200, bundesland || null, accent_color || null, tracking_start_date || null, req.user.id]
  );
  const result = await pool.query(
    "SELECT id,name,email,role,daily_hours,vacation_days_per_year,office_lat,office_lng,office_radius,bundesland,accent_color,tracking_start_date,(google_refresh_token IS NOT NULL) as google_connected FROM users WHERE id=$1",
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

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

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
  const { notes } = req.body;

  const existing = await pool.query(
    `SELECT id FROM time_entries WHERE user_id=$1 AND check_out IS NULL`,
    [req.user.id]
  );
  if (existing.rows.length) return res.status(400).json({ error: "Bereits eingecheckt" });

  const result = await pool.query(
    "INSERT INTO time_entries (user_id,check_in,notes) VALUES ($1,NOW(),$2) RETURNING *",
    [req.user.id, notes || null]
  );
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

  // compute net hours per entry
  const enriched = entries.rows.map((e) => ({
    ...e,
    net_hours: Math.max(0, parseFloat(e.gross_hours) - parseFloat(e.break_hours)),
  }));

  const totalNet = enriched.reduce((s, e) => s + e.net_hours, 0);
  const workDays = enriched.length;
  const shouldHours = workDays * dailyHours;
  const overtime = totalNet - shouldHours;

  const lastDay = new Date(Date.UTC(year, month, 0));
  const allTime = await pool.query(
    `SELECT
       COUNT(*) as work_days,
       COALESCE(SUM(GREATEST(0,
         EXTRACT(EPOCH FROM (COALESCE(te.check_out,NOW()) - te.check_in))/3600 -
         COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(b.end_time,NOW()) - b.start_time)))
                    FROM breaks b WHERE b.time_entry_id = te.id) / 3600, 0)
       )), 0) as total_net
     FROM time_entries te
     WHERE te.user_id=$1 AND te.check_in <= $2`,
    [userId, lastDay]
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
  const { check_in, check_out, notes } = req.body;
  const result = await pool.query(
    `UPDATE time_entries SET check_in=$1,check_out=$2,notes=$3
     WHERE id=$4 AND user_id=$5 RETURNING *`,
    [check_in, check_out || null, notes || null, req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: "Nicht gefunden" });
  res.json(result.rows[0]);
});

app.delete("/api/time/:id", auth, async (req, res) => {
  await pool.query("DELETE FROM time_entries WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok: true });
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
