# English Kids — Backend Setup

## What's included

```
backend/
  server.js            ← Express API + admin routes
  admin.html           ← Admin dashboard (password protected)
  analytics-client.js  ← Drop into your PWA to send events
  package.json
  .env.example
  data/                ← Created automatically (SQLite file lives here)
```

---

## 1. Install & Run

```bash
cd backend
cp .env.example .env       # Edit ADMIN_PASSWORD!
npm install
npm start                  # Production
npm run dev                # Development (auto-restart)
```

Server starts on **http://localhost:3001** by default.

---

## 2. Connect the PWA

In your `index.html`, add **before** the closing `</body>`:

```html
<!-- Point to your deployed backend URL -->
<script>window.ANALYTICS_URL = "https://your-server.com";</script>
<script src="analytics-client.js"></script>
```

Then add `window.track(...)` calls where things happen:

```js
// User sees a vocabulary word
window.track("vocab_view", { category: vCat, value: entry.word });

// User marks a word as mastered
window.track("vocab_mastered", { category: vCat, value: entry.word, stars_delta: 2 });

// User answers a practice question
window.track("practice_answer", {
  category: pTopic,
  value: item.prompt,
  correct: isCorrect,
  stars_delta: isCorrect ? 3 : 0,
});

// User taps Listen
window.track("listen", { category: vCat, value: entry.word });
```

Events are **batched and sent every 5 seconds** — never blocks the UI.

---

## 3. View the Admin Dashboard

```
http://localhost:3001/admin
```

Enter your `ADMIN_PASSWORD`. You'll see:

- 📊 KPI cards (sessions, daily active users, events, stars)
- 📈 30-day activity charts (users + events)
- 🧠 Top vocabulary categories and most viewed words
- 🎯 Practice accuracy by topic
- 🔥 Hardest questions (lowest accuracy)
- 📱 Recent sessions with device info
- ⚡ Live event feed

Auto-refreshes every **30 seconds**.

---

## 4. Deploy to the Internet (free options)

### Option A — Railway (easiest)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Option B — Render
1. Push to GitHub
2. Go to render.com → New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add env vars: `ADMIN_PASSWORD`, `PORT`

### Option C — VPS (DigitalOcean / Hetzner)
```bash
# On the server:
git clone your-repo
cd backend && npm install
npm install -g pm2
pm2 start server.js --name english-kids
pm2 save && pm2 startup
```

---

## 5. Database

SQLite file is at `data/kids.db`. To back it up:
```bash
cp data/kids.db data/kids.backup-$(date +%Y%m%d).db
```

To inspect it directly:
```bash
npx better-sqlite3-explorer data/kids.db
# or
sqlite3 data/kids.db "SELECT * FROM events LIMIT 10;"
```

---

## API Reference

| Endpoint | Auth | Description |
|---|---|---|
| `POST /api/track` | None | Receive events from PWA |
| `GET /api/session/new` | None | Get a new session UUID |
| `GET /api/admin/overview` | Password | Full analytics data |
| `GET /api/admin/sessions` | Password | Recent sessions |
| `GET /api/admin/events` | Password | Recent events |
| `GET /api/health` | None | Health check |

Admin auth: pass `?pwd=YOUR_PASSWORD` or `Authorization: Bearer YOUR_PASSWORD` header.
