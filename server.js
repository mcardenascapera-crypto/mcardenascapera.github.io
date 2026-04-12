/**
 * English Kids — Backend Server
 * Stack: Express + better-sqlite3 (synchronous, no async mess)
 *
 * Run:
 *   cp .env.example .env   (then edit ADMIN_PASSWORD)
 *   npm install
 *   npm start              (or: npm run dev)
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const { v4: uuid } = require("uuid");
const path       = require("path");
const Database   = require("better-sqlite3");

// ══════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════
const PORT           = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const CORS_ORIGIN    = process.env.CORS_ORIGIN || "*";
const DB_PATH        = path.join(__dirname, "data", "kids.db");

// ══════════════════════════════════════════════════════════════
//  DATABASE SETUP
// ══════════════════════════════════════════════════════════════
const fs = require("fs");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");   // faster writes
db.pragma("foreign_keys = ON");

db.exec(`
  -- One row per device/browser session
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    device_hint TEXT,          -- "iPhone iOS 17", "Android Chrome", etc.
    started_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );

  -- Every meaningful thing a user does
  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    event_type   TEXT NOT NULL,   -- see EVENT TYPES below
    category     TEXT,            -- vocabulary category or practice topic
    value        TEXT,            -- word, answer, etc.
    correct      INTEGER,         -- 1 / 0 / NULL
    stars_delta  INTEGER,         -- stars awarded this event
    ts           INTEGER NOT NULL, -- Unix ms timestamp
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  -- Aggregate cache (refreshed every minute by a lightweight job)
  CREATE TABLE IF NOT EXISTS daily_stats (
    day         TEXT PRIMARY KEY,   -- YYYY-MM-DD
    sessions    INTEGER DEFAULT 0,
    events      INTEGER DEFAULT 0,
    vocab_views INTEGER DEFAULT 0,
    practice_attempts INTEGER DEFAULT 0,
    correct_answers   INTEGER DEFAULT 0,
    stars_earned      INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_events_session  ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_type     ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
`);

// ── Prepared statements (compiled once, reused) ──────────────
const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (id, device_hint, started_at, last_seen)
    VALUES (@id, @device_hint, @ts, @ts)
    ON CONFLICT(id) DO UPDATE SET last_seen = @ts
  `),
  insertEvent: db.prepare(`
    INSERT INTO events (session_id, event_type, category, value, correct, stars_delta, ts)
    VALUES (@session_id, @event_type, @category, @value, @correct, @stars_delta, @ts)
  `),
  // Stats queries
  totalSessions:   db.prepare("SELECT COUNT(*) as n FROM sessions"),
  totalEvents:     db.prepare("SELECT COUNT(*) as n FROM events"),
  activeToday:     db.prepare(`
    SELECT COUNT(DISTINCT session_id) as n FROM events
    WHERE ts >= strftime('%s','now','start of day') * 1000
  `),
  activeThisWeek:  db.prepare(`
    SELECT COUNT(DISTINCT session_id) as n FROM events
    WHERE ts >= strftime('%s','now','-6 days') * 1000
  `),
  totalStars:      db.prepare("SELECT COALESCE(SUM(stars_delta),0) as n FROM events WHERE stars_delta > 0"),
  topCategories:   db.prepare(`
    SELECT category, COUNT(*) as views
    FROM events WHERE event_type = 'vocab_view' AND category IS NOT NULL
    GROUP BY category ORDER BY views DESC LIMIT 10
  `),
  topWords:        db.prepare(`
    SELECT value, COUNT(*) as views
    FROM events WHERE event_type = 'vocab_view' AND value IS NOT NULL
    GROUP BY value ORDER BY views DESC LIMIT 15
  `),
  practiceByTopic: db.prepare(`
    SELECT category,
           COUNT(*) as attempts,
           SUM(correct) as correct_count,
           ROUND(100.0 * SUM(correct) / COUNT(*), 1) as pct
    FROM events WHERE event_type = 'practice_answer' AND category IS NOT NULL
    GROUP BY category ORDER BY attempts DESC
  `),
  hardestQuestions: db.prepare(`
    SELECT value, COUNT(*) as attempts,
           SUM(correct) as correct_count,
           ROUND(100.0 * SUM(correct) / COUNT(*), 1) as pct
    FROM events WHERE event_type = 'practice_answer' AND value IS NOT NULL
    GROUP BY value ORDER BY pct ASC LIMIT 10
  `),
  sessionsPerDay:  db.prepare(`
    SELECT date(ts/1000, 'unixepoch') as day, COUNT(DISTINCT session_id) as n
    FROM events
    WHERE ts >= strftime('%s','now','-29 days') * 1000
    GROUP BY day ORDER BY day
  `),
  eventsPerDay:    db.prepare(`
    SELECT date(ts/1000, 'unixepoch') as day, COUNT(*) as n
    FROM events
    WHERE ts >= strftime('%s','now','-29 days') * 1000
    GROUP BY day ORDER BY day
  `),
  recentSessions:  db.prepare(`
    SELECT s.id, s.device_hint,
           datetime(s.started_at/1000,'unixepoch') as started,
           datetime(s.last_seen/1000,'unixepoch') as last_seen,
           COUNT(e.id) as event_count,
           COALESCE(SUM(e.stars_delta),0) as stars
    FROM sessions s
    LEFT JOIN events e ON e.session_id = s.id
    GROUP BY s.id ORDER BY s.last_seen DESC LIMIT 50
  `),
  recentEvents: db.prepare(`
    SELECT event_type, category, value, correct, stars_delta,
           datetime(ts/1000,'unixepoch') as time
    FROM events ORDER BY ts DESC LIMIT 100
  `),
};

// ══════════════════════════════════════════════════════════════
//  EXPRESS APP
// ══════════════════════════════════════════════════════════════
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));  // CSP off so admin inline scripts work
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "50kb" }));

// Serve the PWA files from a "public" subfolder
app.use(express.static(path.join(__dirname, "public")));

// Rate limiter for the tracking endpoint (prevent flooding)
const trackLimiter = rateLimit({
  windowMs: 60_000, max: 120,
  message: { error: "Too many requests" },
});

// ══════════════════════════════════════════════════════════════
//  PUBLIC API  — called by the PWA
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/track
 * Body: { session_id, device_hint?, events: [...] }
 *
 * EVENT TYPES:
 *   session_start   — app opened
 *   vocab_view      — user saw a word      { category, value: word }
 *   vocab_mastered  — marked as mastered   { category, value: word, stars_delta: 2 }
 *   practice_answer — answered a question  { category, value: prompt, correct: 0|1, stars_delta }
 *   listen          — tapped Listen        { category, value: word }
 */
app.post("/api/track", trackLimiter, (req, res) => {
  const { session_id, device_hint, events } = req.body;

  if (!session_id || !Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Sanitise session id — must look like a uuid
  if (!/^[0-9a-f-]{32,36}$/i.test(session_id)) {
    return res.status(400).json({ error: "Invalid session_id" });
  }

  const now = Date.now();

  // Wrap in a transaction — either all succeed or none
  const insert = db.transaction(() => {
    stmts.upsertSession.run({ id: session_id, device_hint: String(device_hint || "unknown").slice(0, 120), ts: now });
    for (const ev of events.slice(0, 50)) {  // max 50 events per batch
      stmts.insertEvent.run({
        session_id,
        event_type:  String(ev.type   || "unknown").slice(0, 40),
        category:    ev.category ? String(ev.category).slice(0, 60) : null,
        value:       ev.value    ? String(ev.value).slice(0, 100)   : null,
        correct:     ev.correct  != null ? (ev.correct ? 1 : 0)     : null,
        stars_delta: Number.isInteger(ev.stars_delta) ? ev.stars_delta : 0,
        ts:          Number.isInteger(ev.ts) ? ev.ts : now,
      });
    }
  });

  try {
    insert();
    res.json({ ok: true });
  } catch (err) {
    console.error("[track]", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// ── New session ID ──────────────────────────────────────────
app.get("/api/session/new", (req, res) => {
  res.json({ session_id: uuid() });
});

// ══════════════════════════════════════════════════════════════
//  ADMIN API  — password protected
// ══════════════════════════════════════════════════════════════
function adminAuth(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace("Bearer ", "").trim();
  if (token === ADMIN_PASSWORD) return next();

  // Also accept ?pwd=... query param for dashboard convenience
  if (req.query.pwd === ADMIN_PASSWORD) return next();

  res.status(401).json({ error: "Unauthorized" });
}

// Admin rate limiter (stricter)
const adminLimiter = rateLimit({ windowMs: 60_000, max: 30 });

app.get("/api/admin/overview", adminLimiter, adminAuth, (req, res) => {
  res.json({
    total_sessions:      stmts.totalSessions.get().n,
    total_events:        stmts.totalEvents.get().n,
    active_today:        stmts.activeToday.get().n,
    active_this_week:    stmts.activeThisWeek.get().n,
    total_stars_earned:  stmts.totalStars.get().n,
    top_categories:      stmts.topCategories.all(),
    top_words:           stmts.topWords.all(),
    practice_by_topic:   stmts.practiceByTopic.all(),
    hardest_questions:   stmts.hardestQuestions.all(),
    sessions_per_day:    stmts.sessionsPerDay.all(),
    events_per_day:      stmts.eventsPerDay.all(),
  });
});

app.get("/api/admin/sessions", adminLimiter, adminAuth, (req, res) => {
  res.json(stmts.recentSessions.all());
});

app.get("/api/admin/events", adminLimiter, adminAuth, (req, res) => {
  res.json(stmts.recentEvents.all());
});

// Health check
app.get("/api/health", (req, res) => res.json({ status: "ok", ts: Date.now() }));

// ══════════════════════════════════════════════════════════════
//  ADMIN DASHBOARD  (served at /admin?pwd=YOUR_PASSWORD)
// ══════════════════════════════════════════════════════════════
app.get("/admin", (req, res) => {
  // Serve the admin HTML file
  res.sendFile(path.join(__dirname, "admin.html"));
});

// ══════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀  English Kids backend running`);
  console.log(`   API:    http://localhost:${PORT}/api/health`);
  console.log(`   Admin:  http://localhost:${PORT}/admin?pwd=${ADMIN_PASSWORD}`);
  console.log(`   DB:     ${DB_PATH}\n`);
});
