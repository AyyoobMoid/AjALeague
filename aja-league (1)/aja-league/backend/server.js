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

// Maps your DB team names <-> football-data.org team names
const TEAM_NAME_MAP = {
  "USA": "United States",
  "Korea Republic": "Korea Republic",
  "Czechia": "Czechia",
  "Bosnia and Herzegovina": "Bosnia and Herzegovina",
};

// Reverse map built once at startup for performance
const TEAM_NAME_REVERSE = Object.fromEntries(
  Object.entries(TEAM_NAME_MAP).map(([k, v]) => [v, k])
);

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
  const { username, password, fullName, country, deviceId } = req.body;

  if (!username || !password || !fullName || !country) {
    return res.status(400).json({ message: "All registration fields are required" });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (username, password, full_name, country, device_id, points)
       VALUES (?, ?, ?, ?, ?, 5000)`,
      [username, hashed, fullName, country, deviceId || ""],
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

      db.run(
        "INSERT INTO predictions (user_id, match_id, selected_team, points_used) VALUES (?, ?, ?, ?)",
        [req.user.id, matchId, selectedTeam, amount],
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
            if (result === "DRAW") reward = Math.floor(prediction.points_used * 1.5);
            else if (prediction.selected_team === result) reward = prediction.points_used * 2;

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
        const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

        const apiRes = await fetch(
          `https://api.football-data.org/v4/competitions/WC/matches?dateFrom=${yesterday}&dateTo=${today}&status=FINISHED`,
          { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
        );

        if (!apiRes.ok) {
          console.log("Auto-settle API error:", apiRes.status);
          return;
        }

        const apiData = await apiRes.json();
        const finishedMatches = apiData.matches || [];

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
    [teamA, teamB, stage || "Group Stage", venue || "TBA", matchDate.toISOString(), predictionOpen.toISOString(), predictionClose.toISOString()],
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Football Points League running on http://localhost:${PORT}`);
});
