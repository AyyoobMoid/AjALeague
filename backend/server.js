const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const cron = require("node-cron");
const fetch = require("node-fetch");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || "football_points_secret_key";
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || "4756663574ab4d2f980aa1ac8b41dab7";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "69a4b7e72c93d662cb2f42ac703f2bef";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "69a4b7e72c93d662cb2f42ac703f2bef";

// Maps your DB team names <-> football-data.org team names
const TEAM_NAME_MAP = {
  "United States": "USA",
  "South Korea": "Korea Republic",
  "Turkey": "Turkiye",
  "Bosnia-Herzegovina": "Bosnia and Herzegovina",
  "Cape Verde Islands": "Cabo Verde",
  "Curaçao": "Curacao",
  "Ivory Coast": "Ivory Coast",
  "Congo DR": "Congo DR",
};

// Map is now API name -> DB name (direct lookup)
const TEAM_NAME_REVERSE = TEAM_NAME_MAP;

function toDbName(apiName) {
  return TEAM_NAME_REVERSE[apiName] || apiName;
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ message: "Not logged in" });
  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid login session" });
  }
}

function adminOnly(req, res, next) {
  db.get("SELECT is_admin FROM users WHERE id = ?", [req.user.id], (err, user) => {
    if (err || !user || user.is_admin !== 1) {
      return res.status(403).json({ message: "Admin access required" });
    }
    next();
  });
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

app.post("/api/register", async (req, res) => {
  const { username, password, fullName, deviceId } = req.body;

  if (!username || !password || !fullName) {
    return res.status(400).json({ message: "All registration fields are required" });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (username, password, full_name, country, device_id, points)
       VALUES (?, ?, ?, 'N/A', ?, 5000)`,
      [username, hashed, fullName, deviceId || ""],
      function (err) {
        if (err) return res.status(400).json({ message: "Account could not be created" });
        return res.json({ message: "Account created successfully" });
      }
    );
  } catch {
    return res.status(500).json({ message: "Server error while creating account" });
  }
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  db.all("SELECT * FROM users WHERE username = ?", [username], async (err, users) => {
    if (err || !users || users.length === 0) {
      return res.status(400).json({ message: "Invalid username or password" });
    }
    for (const user of users) {
      const match = await bcrypt.compare(password, user.password);
      if (match) {
        if (user.is_active === 0) {
          return res.status(403).json({ message: "Account disabled because you lost all points after match settlement" });
        }
        const token = jwt.sign({ id: user.id, username: user.username, isAdmin: user.is_admin === 1 }, SECRET);
        return res.json({ token, username: user.username, points: user.points, isAdmin: user.is_admin === 1 });
      }
    }
    return res.status(400).json({ message: "Invalid username or password" });
  });
});

app.get("/api/me", auth, (req, res) => {
  db.get("SELECT id, username, points, is_admin, is_active FROM users WHERE id = ?", [req.user.id], (err, user) => {
    if (err) return res.status(500).json({ message: "Server error" });
    if (!user) return res.status(401).json({ message: "User no longer exists" });
    if (user.is_active === 0) return res.status(403).json({ message: "Account is disabled" });
    return res.json(user);
  });
});

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────

app.get("/api/leaderboard", (req, res) => {
  db.all(
    "SELECT full_name, username, points FROM users WHERE is_active = 1 ORDER BY points DESC",
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Could not load leaderboard" });
      return res.json(rows);
    }
  );
});

// ─── MATCHES ─────────────────────────────────────────────────────────────────

app.get("/api/matches", (req, res) => {
  db.all("SELECT * FROM matches ORDER BY match_time ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ message: "Could not load matches" });
    return res.json(rows);
  });
});

// ─── PREDICT ─────────────────────────────────────────────────────────────────

app.post("/api/predict", auth, (req, res) => {
  const { matchId, selectedTeam, pointsUsed } = req.body;
  const amount = Number(pointsUsed);

  if (!matchId || !selectedTeam || !amount) return res.status(400).json({ message: "Prediction details missing" });
  if (amount <= 0) return res.status(400).json({ message: "Points must be greater than 0" });
  if (amount % 5 !== 0) return res.status(400).json({ message: "Points must be multiple of 5" });

  db.get("SELECT points FROM users WHERE id = ?", [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ message: "User not found" });
    if (user.points < amount) return res.status(400).json({ message: "Not enough points" });

    db.get("SELECT * FROM matches WHERE id = ?", [matchId], (err, match) => {
      if (err || !match) return res.status(404).json({ message: "Match not found" });

      const now = new Date();
      const openTime = new Date(match.prediction_open);
      const closeTime = new Date(match.prediction_close);

      if (now < openTime || now > closeTime) {
        return res.status(400).json({ message: "Prediction is not open for this match" });
      }

      const oddsUsed = req.body.oddsUsed || null;
          db.run(
        "INSERT INTO predictions (user_id, match_id, selected_team, points_used, odds_used) VALUES (?, ?, ?, ?, ?)",
        [req.user.id, matchId, selectedTeam, amount, oddsUsed],
        function (err) {
          if (err) return res.status(400).json({ message: "You already predicted this match" });
          db.run("UPDATE users SET points = points - ? WHERE id = ?", [amount, req.user.id], function (err) {
            if (err) return res.status(500).json({ message: "Prediction saved but points could not be updated" });
            return res.json({ message: "Prediction submitted successfully" });
          });
        }
      );
    });
  });
});

// ─── USER HISTORY (public — settled only) ────────────────────────────────────

app.get("/api/user-history/:username", auth, (req, res) => {
  const { username } = req.params;

  db.get("SELECT id, full_name, username, points FROM users WHERE username = ?", [username], (err, user) => {
    if (err || !user) return res.status(404).json({ message: "User not found" });

    db.all(
      `SELECT
        predictions.selected_team,
        predictions.points_used,
        predictions.settled,
        matches.team_a,
        matches.team_b,
        matches.match_time,
        matches.result,
        matches.stage,
        matches.group_name
       FROM predictions
       JOIN matches ON predictions.match_id = matches.id
       WHERE predictions.user_id = ? AND predictions.settled = 1
       ORDER BY predictions.created_at DESC`,
      [user.id],
      (err, rows) => {
        if (err) return res.status(500).json({ message: "Could not load history" });
        return res.json({ user: { username: user.username, fullName: user.full_name, points: user.points }, history: rows });
      }
    );
  });
});

// ─── MY PREDICTIONS ──────────────────────────────────────────────────────────

app.get("/api/my-predictions", auth, (req, res) => {
  db.all(
    `SELECT
      predictions.id,
      predictions.selected_team,
      predictions.points_used,
      predictions.settled,
      predictions.created_at,
      matches.team_a,
      matches.team_b,
      matches.match_time,
      matches.result,
      matches.stage,
      matches.group_name
     FROM predictions
     JOIN matches ON predictions.match_id = matches.id
     WHERE predictions.user_id = ?
     ORDER BY predictions.created_at DESC`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Could not load prediction history" });
      return res.json(rows);
    }
  );
});

app.get("/api/my-predicted-matches", auth, (req, res) => {
  db.all(
    "SELECT match_id, selected_team, points_used FROM predictions WHERE user_id = ?",
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Could not load predicted matches" });
      res.json(rows);
    }
  );
});

app.get("/api/my-stats", auth, (req, res) => {
  db.all(
    `SELECT predictions.selected_team, predictions.points_used, predictions.settled, matches.result
     FROM predictions
     JOIN matches ON predictions.match_id = matches.id
     WHERE predictions.user_id = ?`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Could not load stats" });

      let totalPredictions = rows.length, wins = 0, losses = 0, draws = 0, pending = 0, totalPointsUsed = 0;

      rows.forEach((item) => {
        totalPointsUsed += item.points_used;
        if (!item.result) pending++;
        else if (item.result === "DRAW") draws++;
        else if (item.selected_team === item.result) wins++;
        else losses++;
      });

      const settled = wins + losses + draws;
      const successRate = settled > 0 ? Math.round((wins / settled) * 100) : 0;
      res.json({ totalPredictions, wins, losses, draws, pending, totalPointsUsed, successRate });
    }
  );
});

// ─── SETTLE LOGIC (shared between admin manual + auto) ───────────────────────

function settleMatch(matchId, result, callback) {
  db.get("SELECT * FROM matches WHERE id = ?", [matchId], (err, match) => {
    if (err || !match) return callback(new Error("Match not found"));
    if (match.status === "settled") return callback(null, "already_settled");

    db.run(
      "UPDATE matches SET result = ?, status = 'settled', settled_at = CURRENT_TIMESTAMP WHERE id = ?",
      [result, matchId],
      function (err) {
        if (err) return callback(err);

        db.all("SELECT * FROM predictions WHERE match_id = ? AND settled = 0", [matchId], (err, predictions) => {
          if (err) return callback(err);

          if (predictions.length === 0) {
            const msg = result === "DRAW"
              ? `${match.team_a} drew with ${match.team_b}`
              : `${result} defeated ${result === match.team_a ? match.team_b : match.team_a}`;
            db.run("UPDATE matches SET settlement_message = ? WHERE id = ?", [msg, matchId], () => {
              callback(null, `settled_no_predictions`);
            });
            return;
          }

          let completed = 0;
          predictions.forEach((prediction) => {
            let reward = 0;
            const isWin = prediction.selected_team === result;
            const isDraw = result === "DRAW" && prediction.selected_team === "DRAW";
            if (isDraw) {
              const odds = prediction.odds_used || parseFloat(match.odds_draw) || 1.5;
              reward = Math.floor(prediction.points_used * odds);
            } else if (isWin) {
              let odds;
              if (prediction.odds_used) {
                odds = prediction.odds_used;
              } else {
                odds = result === match.team_a ? (parseFloat(match.odds_a) || 2.0) : (parseFloat(match.odds_b) || 2.0);
              }
              reward = Math.floor(prediction.points_used * odds);
            }

            db.run("UPDATE users SET points = points + ? WHERE id = ?", [reward, prediction.user_id], () => {
              db.run("UPDATE predictions SET settled = 1 WHERE id = ?", [prediction.id], () => {
                completed++;
                if (completed === predictions.length) {
                  db.run("UPDATE users SET is_active = 0 WHERE points <= 0", [], () => {
                    const msg = result === "DRAW"
                      ? `${match.team_a} drew with ${match.team_b}`
                      : `${result} defeated ${result === match.team_a ? match.team_b : match.team_a}`;
                    db.run("UPDATE matches SET settlement_message = ? WHERE id = ?", [msg, matchId], () => {
                      callback(null, "settled");
                    });
                  });
                }
              });
            });
          });
        });
      }
    );
  });
}

// ─── ADMIN: MANUAL RESULT ────────────────────────────────────────────────────

app.post("/api/admin/result", auth, adminOnly, (req, res) => {
  const { matchId, result } = req.body;
  if (!matchId || !result) return res.status(400).json({ message: "Match ID and result required" });

  db.get("SELECT status FROM matches WHERE id = ?", [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ message: "Match not found" });
    if (match.status === "settled") return res.status(400).json({ message: "This match has already been settled" });

    settleMatch(matchId, result, (err, status) => {
      if (err) return res.status(500).json({ message: "Settlement failed" });
      res.json({ message: `Result settled successfully: ${result}` });
    });
  });
});

// ─── AUTO-SETTLE: poll football-data.org ─────────────────────────────────────

async function autoSettleMatches() {
  try {
    // Get all unsettled matches from DB
    db.all(
      "SELECT * FROM matches WHERE status != 'settled' AND match_time < NOW() - INTERVAL '115 minutes'",
      [],
      async (err, pendingMatches) => {
        if (err || !pendingMatches || pendingMatches.length === 0) return;

        // Fetch today's WC matches from football-data.org
        const today = new Date().toISOString().split("T")[0];
        const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().split("T")[0];

        const apiRes = await fetch(
          `https://api.football-data.org/v4/competitions/WC/matches?dateFrom=${threeDaysAgo}&dateTo=${today}&status=FINISHED`,
          { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
        );

        if (!apiRes.ok) {
          console.log("Auto-settle API error:", apiRes.status);
          return;
        }

        const apiData = await apiRes.json();
        const finishedMatches = apiData.matches || [];
        console.log(`Auto-settle: found ${finishedMatches.length} finished matches from API`);
        finishedMatches.forEach(m => console.log(` - ${m.homeTeam.name} vs ${m.awayTeam.name}`));

        for (const apiMatch of finishedMatches) {
          const homeTeam = toDbName(apiMatch.homeTeam.name);
          const awayTeam = toDbName(apiMatch.awayTeam.name);
          const homeScore = apiMatch.score.fullTime.home;
          const awayScore = apiMatch.score.fullTime.away;

          let result;
          if (homeScore === awayScore) result = "DRAW";
          else if (homeScore > awayScore) result = homeTeam;
          else result = awayTeam;

          // Find the matching DB row by team names (order-independent)
          const dbMatch = pendingMatches.find(m =>
            (m.team_a === homeTeam && m.team_b === awayTeam) ||
            (m.team_a === awayTeam && m.team_b === homeTeam)
          );

          if (dbMatch) {
            // If teams are stored reversed vs API order, result label is already correct
            // (result is already set to the winning team's DB name via toDbName())
            settleMatch(dbMatch.id, result, (err, status) => {
              if (err) console.log(`Auto-settle error for match ${dbMatch.id}:`, err.message);
              else if (status === "settled") console.log(`Auto-settled: ${homeTeam} vs ${awayTeam} → ${result}`);
            });
          }
        }
      }
    );
  } catch (err) {
    console.log("Auto-settle fetch error:", err.message);
  }
}


// ─── ODDS FETCHING ────────────────────────────────────────────────────────────

async function fetchAndStoreOdds() {
  try {
    const fetch = require("node-fetch");
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`,
      { headers: { "Accept": "application/json" } }
    );
    if (!res.ok) {
      console.log("Odds API error:", res.status);
      return;
    }
    const events = await res.json();
    console.log(`Odds API: fetched odds for ${events.length} events`);

    // For each event, find matching DB match and update odds
    db.all("SELECT * FROM matches WHERE status != 'settled'", [], (err, matches) => {
      if (err || !matches) return;

      events.forEach(event => {
        const apiHome = event.home_team;
        const apiAway = event.away_team;

        // Try to match to our DB
        const dbMatch = matches.find(m =>
          (normalizeTeam(m.team_a) === normalizeTeam(apiHome) && normalizeTeam(m.team_b) === normalizeTeam(apiAway)) ||
          (normalizeTeam(m.team_a) === normalizeTeam(apiAway) && normalizeTeam(m.team_b) === normalizeTeam(apiHome))
        );

        if (!dbMatch) return;

        // Get average odds across bookmakers
        if (!event.bookmakers || event.bookmakers.length === 0) return;

        let homeOdds = [], drawOdds = [], awayOdds = [];

        event.bookmakers.forEach(bk => {
          const h2h = bk.markets.find(m => m.key === "h2h");
          if (!h2h) return;
          h2h.outcomes.forEach(o => {
            const name = normalizeTeam(o.name);
            if (name === normalizeTeam(apiHome)) homeOdds.push(o.price);
            else if (name === normalizeTeam(apiAway)) awayOdds.push(o.price);
            else if (o.name === "Draw") drawOdds.push(o.price);
          });
        });

        const avg = arr => arr.length > 0 ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null;

        // If teams are in opposite order in DB, swap home/away odds
        let oddsHome, oddsAway;
        if (normalizeTeam(dbMatch.team_a) === normalizeTeam(apiHome)) {
          oddsHome = avg(homeOdds);
          oddsAway = avg(awayOdds);
        } else {
          oddsHome = avg(awayOdds);
          oddsAway = avg(homeOdds);
        }
        const oddsDraw = avg(drawOdds);

        db.run(
          "UPDATE matches SET odds_a = ?, odds_draw = ?, odds_b = ? WHERE id = ?",
          [oddsHome, oddsDraw, oddsAway, dbMatch.id],
          () => console.log(`Odds updated: ${dbMatch.team_a} vs ${dbMatch.team_b} | ${oddsHome} / ${oddsDraw} / ${oddsAway}`)
        );
      });
    });
  } catch (err) {
    console.log("Odds fetch error:", err.message);
  }
}

function normalizeTeam(name) {
  if (!name) return "";
  const map = {
    "United States": "USA", "South Korea": "Korea Republic",
    "Turkey": "Turkiye", "Türkiye": "Turkiye",
    "Bosnia-Herzegovina": "Bosnia and Herzegovina",
    "Cape Verde Islands": "Cabo Verde", "Cape Verde": "Cabo Verde",
    "Curaçao": "Curacao", "IR Iran": "Iran",
    "Côte d'Ivoire": "Ivory Coast", "Congo DR": "Congo DR",
    "DR Congo": "Congo DR"
  };
  return map[name] || name;
}

// Fetch odds every 6 hours (low credit usage)
cron.schedule("0 */6 * * *", () => {
  console.log("Fetching odds from API...");
  fetchAndStoreOdds();
});

// Also fetch on startup
setTimeout(fetchAndStoreOdds, 5000);

// Run auto-settle every 5 minutes
cron.schedule("*/5 * * * *", () => {
  console.log("Running auto-settle check...");
  autoSettleMatches();
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────

app.post("/api/admin/add-match", auth, adminOnly, (req, res) => {
  const { teamA, teamB, stage, venue, matchTime } = req.body;
  if (!teamA || !teamB || !matchTime) return res.status(400).json({ message: "Team A, Team B and match time are required" });

  const matchDate = new Date(`${matchTime}:00+04:00`);
  const predictionOpen = new Date(matchDate.getTime() - 24 * 60 * 60 * 1000);
  const predictionClose = new Date(matchDate.getTime() - 5 * 60 * 1000);

  db.run(
    `INSERT INTO matches (team_a, team_b, stage, venue, match_time, prediction_open, prediction_close)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [teamA, teamB, stage || "Group Stage", venue || "TBA", matchDate.toISOString(), predictionOpen.toISOString(), predictionClose.toISOString(), null, null, null],
    (err) => {
      if (err) return res.status(500).json({ message: "Match could not be added" });
      res.json({ message: "Match added successfully" });
    }
  );
});

app.get("/api/admin/users", auth, adminOnly, (req, res) => {
  db.all("SELECT id, username, points, is_active, is_admin FROM users ORDER BY points DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ message: "Could not load users" });
    res.json(rows);
  });
});

app.post("/api/admin/user-points", auth, adminOnly, (req, res) => {
  const { userId, amount } = req.body;
  const pointsAmount = Number(amount);
  if (!userId || !pointsAmount) return res.status(400).json({ message: "User ID and amount required" });

  db.run("UPDATE users SET points = points + ? WHERE id = ?", [pointsAmount, userId], function (err) {
    if (err) return res.status(500).json({ message: "Could not update points" });
    db.run("UPDATE users SET is_active = 0 WHERE points <= 0");
    db.run("UPDATE users SET is_active = 1 WHERE points > 0");
    res.json({ message: "User points updated successfully" });
  });
});

app.post("/api/admin/toggle-user", auth, adminOnly, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ message: "User ID required" });

  db.get("SELECT is_active FROM users WHERE id = ?", [userId], (err, user) => {
    if (err || !user) return res.status(404).json({ message: "User not found" });
    const newStatus = user.is_active === 1 ? 0 : 1;
    db.run("UPDATE users SET is_active = ? WHERE id = ?", [newStatus, userId], function (err) {
      if (err) return res.status(500).json({ message: "Could not update user status" });
      res.json({ message: newStatus === 1 ? "User activated" : "User disabled" });
    });
  });
});

app.post("/api/admin/reset-result", auth, adminOnly, (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ message: "Match ID required" });

  db.run("UPDATE matches SET result = NULL, status = 'open' WHERE id = ?", [matchId], function (err) {
    if (err) return res.status(500).json({ message: "Could not reset match result" });
    db.run("UPDATE predictions SET settled = 0 WHERE match_id = ?", [matchId], function (err) {
      if (err) return res.status(500).json({ message: "Match reset, but predictions could not be reset" });
      res.json({ message: "Match result reset successfully" });
    });
  });
});

app.post("/api/admin/delete-user", auth, adminOnly, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ message: "User ID required" });

  db.get("SELECT is_admin FROM users WHERE id = ?", [userId], (err, user) => {
    if (err || !user) return res.status(404).json({ message: "User not found" });
    if (user.is_admin === 1) return res.status(400).json({ message: "Admin account cannot be deleted" });

    db.run("DELETE FROM predictions WHERE user_id = ?", [userId], function () {
      db.run("DELETE FROM users WHERE id = ?", [userId], function (err) {
        if (err) return res.status(500).json({ message: "Could not delete user" });
        res.json({ message: "User deleted successfully" });
      });
    });
  });
});

app.get("/api/latest-settlement", (req, res) => {
  db.get(
    `SELECT id, team_a, team_b, result, settlement_message, settled_at
     FROM matches WHERE settled_at IS NOT NULL ORDER BY settled_at DESC LIMIT 1`,
    [],
    (err, row) => {
      if (err) return res.status(500).json({ message: "Could not load latest settlement" });
      res.json(row || null);
    }
  );
});

app.get("/api/user-profile/:username", auth, (req, res) => {
  const username = req.params.username;
  db.get(
    `SELECT id, username, full_name, room_number, country, created_at, points FROM users WHERE username = ?`,
    [username],
    (err, user) => {
      if (err || !user) return res.status(404).json({ message: "User not found" });

      db.all(
        `SELECT predictions.selected_team, matches.result
         FROM predictions JOIN matches ON predictions.match_id = matches.id
         WHERE predictions.user_id = ?`,
        [user.id],
        (err, predictions) => {
          if (err) return res.status(500).json({ message: "Could not load profile stats" });

          let wins = 0;
          predictions.forEach((p) => {
            if (p.result && p.result !== "DRAW" && p.selected_team === p.result) wins++;
          });

          const successRate = predictions.length > 0 ? Math.round((wins / predictions.length) * 100) : 0;
          res.json({
            username: user.username, fullName: user.full_name, roomNumber: user.room_number,
            country: user.country, joined: user.created_at, points: user.points,
            wins, totalPredictions: predictions.length, successRate
          });
        }
      );
    }
  );
});


// ─── ADMIN: ADD USER WITH CUSTOM POINTS (for migrating from Yugo league) ─────

app.post("/api/admin/add-user", auth, adminOnly, async (req, res) => {
  const { username, password, fullName, country, startingPoints } = req.body;

  if (!username || !password || !fullName || !country) {
    return res.status(400).json({ message: "Username, password, full name and country are required" });
  }

  const points = Number(startingPoints) || 5000;

  try {
    const hashed = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (username, password, full_name, country, device_id, points) VALUES (?, ?, ?, ?, ?, ?)`,
      [username, hashed, fullName, country, "", points],
      function (err) {
        if (err) return res.status(400).json({ message: "Could not create user — username may already exist" });
        return res.json({ message: `User ${username} created with ${points} points` });
      }
    );
  } catch {
    return res.status(500).json({ message: "Server error" });
  }
});


// ─── ADMIN: IMPORT USERS FROM YUGO (bulk, admin only) ────────────────────────
// Accepts an array of users: [{ username, password (hashed ok), fullName, country, points }]
// If username already exists, updates their points only.

app.post("/api/admin/import-users", auth, adminOnly, async (req, res) => {
  const { users } = req.body;

  if (!Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ message: "No users provided" });
  }

  let imported = 0;
  let updated = 0;
  let failed = 0;
  let completed = 0;
  const total = users.length;

  for (const u of users) {
    if (!u.username || !u.fullName || !u.points) {
      failed++;
      completed++;
      if (completed === total) return res.json({ imported, updated, failed });
      continue;
    }

    const points = Number(u.points) || 5000;
    const password = u.password || "changeme123";
    const hashed = u.password && u.password.startsWith("$2")
      ? u.password  // already bcrypt hashed
      : await require("bcryptjs").hash(password, 10);

    db.get("SELECT id FROM users WHERE username = ?", [u.username], (err, existing) => {
      if (existing) {
        // User exists — just update points
        db.run("UPDATE users SET points = ?, is_active = 1 WHERE id = ?", [points, existing.id], () => {
          updated++;
          completed++;
          if (completed === total) return res.json({ imported, updated, failed });
        });
      } else {
        // New user — insert
        db.run(
          `INSERT INTO users (username, password, full_name, country, device_id, points) VALUES (?, ?, ?, ?, ?, ?)`,
          [u.username, hashed, u.fullName, u.country || "Unknown", "", points],
          function(err) {
            if (err) failed++;
            else imported++;
            completed++;
            if (completed === total) return res.json({ imported, updated, failed });
          }
        );
      }
    });
  }
});


// ─── ADMIN: SET ODDS MANUALLY ─────────────────────────────────────────────────

app.post("/api/admin/set-odds", auth, adminOnly, (req, res) => {
  const { matchId, oddsA, oddsB, oddsDraw } = req.body;
  if (!matchId) return res.status(400).json({ message: "Match ID required" });

  db.run(
    "UPDATE matches SET odds_a = ?, odds_draw = ?, odds_b = ? WHERE id = ?",
    [oddsA || null, oddsB || null, oddsDraw || null, matchId],
    (err) => {
      if (err) return res.status(500).json({ message: "Could not update odds" });
      res.json({ message: "Odds updated" });
    }
  );
});

// ─── ADMIN: REFRESH ODDS NOW ──────────────────────────────────────────────────

app.post("/api/admin/refresh-odds", auth, adminOnly, (req, res) => {
  fetchAndStoreOdds();
  res.json({ message: "Odds refresh triggered" });
});

// ─── ODDS: fetch from The Odds API ───────────────────────────────────────────

async function fetchOddsForMatch(teamA, teamB) {
  try {
    const res = await fetch(
      "https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/?apiKey=" + ODDS_API_KEY + "&regions=eu&markets=h2h&oddsFormat=decimal"
    );
    if (!res.ok) {
      console.log("Odds API error:", res.status);
      return null;
    }
    const data = await res.json();

    // Find the match — try both team orderings
    const match = data.find(m =>
      (m.home_team.includes(teamA) || teamA.includes(m.home_team) ||
       m.away_team.includes(teamA) || teamA.includes(m.away_team)) &&
      (m.home_team.includes(teamB) || teamB.includes(m.home_team) ||
       m.away_team.includes(teamB) || teamB.includes(m.away_team))
    );

    if (!match || !match.bookmakers || match.bookmakers.length === 0) return null;

    // Use first available bookmaker
    const book = match.bookmakers[0];
    const h2h = book.markets.find(m => m.key === "h2h");
    if (!h2h) return null;

    const outcomes = h2h.outcomes;
    const homeOdds = outcomes.find(o => o.name === match.home_team);
    const awayOdds = outcomes.find(o => o.name === match.away_team);
    const drawOdds = outcomes.find(o => o.name === "Draw");

    // Map to our DB team names
    const teamAIsHome = match.home_team.includes(teamA) || teamA.includes(match.home_team);

    return {
      odds_a: teamAIsHome ? (homeOdds ? homeOdds.price : null) : (awayOdds ? awayOdds.price : null),
      odds_b: teamAIsHome ? (awayOdds ? awayOdds.price : null) : (homeOdds ? homeOdds.price : null),
      odds_draw: drawOdds ? drawOdds.price : null
    };
  } catch (err) {
    console.log("Odds fetch error:", err.message);
    return null;
  }
}

// ─── GET ODDS FOR A MATCH ─────────────────────────────────────────────────────

app.get("/api/match-odds/:matchId", async (req, res) => {
  db.get("SELECT * FROM matches WHERE id = ?", [req.params.matchId], async (err, match) => {
    if (err || !match) return res.status(404).json({ message: "Match not found" });

    // If odds already stored, return them
    if (match.odds_a && match.odds_b) {
      return res.json({ odds_a: match.odds_a, odds_b: match.odds_b, odds_draw: match.odds_draw });
    }

    // Otherwise fetch fresh
    const odds = await fetchOddsForMatch(match.team_a, match.team_b);
    if (!odds) return res.json({ odds_a: null, odds_b: null, odds_draw: null });

    // Store in DB for future
    db.run(
      "UPDATE matches SET odds_a = ?, odds_b = ?, odds_draw = ? WHERE id = ?",
      [odds.odds_a, odds.odds_b, odds.odds_draw, match.id],
      () => res.json(odds)
    );
  });
});

// ─── ADMIN: REFRESH ODDS FOR A MATCH ─────────────────────────────────────────

app.post("/api/admin/refresh-odds/:matchId", auth, adminOnly, async (req, res) => {
  db.get("SELECT * FROM matches WHERE id = ?", [req.params.matchId], async (err, match) => {
    if (err || !match) return res.status(404).json({ message: "Match not found" });

    const odds = await fetchOddsForMatch(match.team_a, match.team_b);
    if (!odds) return res.status(404).json({ message: "No odds found for this match" });

    db.run(
      "UPDATE matches SET odds_a = ?, odds_b = ?, odds_draw = ? WHERE id = ?",
      [odds.odds_a, odds.odds_b, odds.odds_draw, match.id],
      () => res.json({ message: "Odds updated", ...odds })
    );
  });
});

// ─── ADMIN: SET ODDS MANUALLY ─────────────────────────────────────────────────

app.post("/api/admin/set-odds", auth, adminOnly, (req, res) => {
  const { matchId, oddsA, oddsB, oddsDraw } = req.body;
  if (!matchId) return res.status(400).json({ message: "Match ID required" });

  db.run(
    "UPDATE matches SET odds_a = ?, odds_b = ?, odds_draw = ? WHERE id = ?",
    [parseFloat(oddsA) || null, parseFloat(oddsB) || null, parseFloat(oddsDraw) || null, matchId],
    (err) => {
      if (err) return res.status(500).json({ message: "Could not update odds" });
      res.json({ message: "Odds updated" });
    }
  );
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`Football Points League running on http://localhost:${PORT}`);
});
