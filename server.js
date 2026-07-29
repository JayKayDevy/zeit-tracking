require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-prod";

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
    `);
    console.log("DB ready");
  } finally {
    client.release();
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
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
      "SELECT id,name,email,password_hash,role,daily_hours,vacation_days_per_year,office_lat,office_lng,office_radius FROM users WHERE email=$1",
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
    "SELECT id,name,email,role,daily_hours,vacation_days_per_year,office_lat,office_lng,office_radius FROM users WHERE id=$1",
    [req.user.id]
  );
  res.json(result.rows[0]);
});

app.put("/api/auth/me", auth, async (req, res) => {
  const { name, daily_hours, vacation_days_per_year, office_lat, office_lng, office_radius } = req.body;
  await pool.query(
    "UPDATE users SET name=$1,daily_hours=$2,vacation_days_per_year=$3,office_lat=$4,office_lng=$5,office_radius=$6 WHERE id=$7",
    [name, daily_hours, vacation_days_per_year, office_lat || null, office_lng || null, office_radius || 200, req.user.id]
  );
  const result = await pool.query(
    "SELECT id,name,email,role,daily_hours,vacation_days_per_year,office_lat,office_lng,office_radius FROM users WHERE id=$1",
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
     ORDER BY te.check_in`,
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

  res.json({
    entries: enriched,
    absences: absences.rows,
    summary: { totalNet, workDays, shouldHours, overtime, dailyHours },
  });
});

// ── CSV export ────────────────────────────────────────────────────────────────

app.get("/api/time/export/csv/:year/:month", auth, async (req, res) => {
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

  const fmt = (ts) => ts ? new Date(ts).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : "";
  const h = (v) => Math.max(0, parseFloat(v)).toFixed(2).replace(".", ",");

  let csv = "Datum;Check-In;Check-Out;Brutto-Stunden;Pause (h);Netto-Stunden;Notiz\n";
  for (const e of entries.rows) {
    const net = Math.max(0, parseFloat(e.gross_hours) - parseFloat(e.break_hours));
    const date = new Date(e.check_in).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
    csv += `${date};${fmt(e.check_in)};${fmt(e.check_out)};${h(e.gross_hours)};${h(e.break_hours)};${net.toFixed(2).replace(".", ",")};${(e.notes || "").replace(/;/g, ",")}\n`;
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="zeiten-${year}-${String(month).padStart(2,"0")}.csv"`);
  res.send("﻿" + csv); // BOM for Excel
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
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/absences/:id", auth, async (req, res) => {
  await pool.query("DELETE FROM absences WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
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
