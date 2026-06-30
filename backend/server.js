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

// Maps your DB team names <-> football-data.org team names
const TEAM_NAME_MAP = {
  "United States": "USA",
  "South Korea": "Korea Republic",
  "Turkey": "Turkiye",
  "Türkiye": "Turkiye",
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
  const { username, password, firstName, lastName, deviceId } = req.body;

  if (!username || !password || !firstName || !lastName) {
    return res.status(400).json({ message: "All registration fields are required" });
  }

  if (/\s/.test(username)) {
    return res.status(400).json({ message: "Display name cannot contain spaces" });
  }
  // Only allow safe characters in username (prevents HTML injection and broken click handlers)
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) {
    return res.status(400).json({ message: "Display name can only contain letters, numbers, and . _ -" });
  }
  if (/\s/.test(firstName) || /\s/.test(lastName)) {
    return res.status(400).json({ message: "First and last name cannot contain spaces" });
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(firstName) || !/^[A-Za-z0-9_.-]+$/.test(lastName)) {
    return res.status(400).json({ message: "Names can only contain letters, numbers, and . _ -" });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);
    const fullName = `${firstName} ${lastName}`;
    db.run(
      `INSERT INTO users (username, password, full_name, first_name, last_name, country, device_id, points, is_active)
       VALUES (?, ?, ?, ?, ?, 'N/A', ?, 5000, 0)`,
      [username, hashed, fullName, firstName, lastName, deviceId || ""],
      function (err) {
        if (err) return res.status(400).json({ message: "Account could not be created" });
        return res.json({ message: "Account created successfully", pending: true });
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
          return res.status(403).json({ message: "Your account is not yet active. Please contact +966 50 347 5147." });
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
  res.set("Cache-Control", "public, max-age=30");
  // Total = current points + stakes locked in pending (unsettled) bets.
  // This shows a player's full net worth: cash on hand plus money in play.
  db.all(
    `SELECT u.username, u.cash_eligible,
            u.points + COALESCE(SUM(CASE WHEN p.settled = 0 THEN p.points_used ELSE 0 END), 0) AS points,
            u.points AS cash_points,
            COALESCE(SUM(CASE WHEN p.settled = 0 THEN p.points_used ELSE 0 END), 0) AS staked_points
     FROM users u
     LEFT JOIN predictions p ON u.id = p.user_id
     WHERE u.is_active = 1 AND u.is_admin = 0
     GROUP BY u.id, u.username, u.points, u.cash_eligible
     ORDER BY points DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Could not load leaderboard" });
      return res.json(rows);
    }
  );
});

// ─── MATCHES ─────────────────────────────────────────────────────────────────

app.get("/api/matches", (req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  db.all("SELECT * FROM matches WHERE status != 'settled' ORDER BY match_time ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ message: "Could not load matches" });
    return res.json(rows);
  });
});

// ─── PREDICT ─────────────────────────────────────────────────────────────────

app.post("/api/predict", auth, (req, res) => {
  const { matchId, selectedTeam, pointsUsed } = req.body;
  // betType defaults to moneyline so existing clients keep working unchanged.
  const betType = (req.body.betType || "moneyline").toLowerCase();
  const amount = Number(pointsUsed);

  if (!matchId || !selectedTeam || !amount) return res.status(400).json({ message: "Prediction details missing" });
  if (amount <= 0) return res.status(400).json({ message: "Points must be greater than 0" });
  if (amount % 5 !== 0) return res.status(400).json({ message: "Points must be multiple of 5" });
  if (!["moneyline", "total", "btts"].includes(betType)) {
    return res.status(400).json({ message: "Invalid bet type" });
  }

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

      const knockout = isKnockoutStage(match.stage);

      // Resolve the correct, server-side odds for the chosen market + selection.
      // selectedTeam carries the selection: team name / "DRAW" / "OVER" / "UNDER" / "YES" / "NO".
      let correctOdds;
      const sel = String(selectedTeam).toUpperCase();

      if (betType === "moneyline") {
        if (knockout) {
          if (!match.odds_a || !match.odds_b) return res.status(400).json({ message: "Odds are not available for this match yet" });
        } else {
          if (!match.odds_a || !match.odds_draw || !match.odds_b) return res.status(400).json({ message: "Odds are not available for this match yet" });
        }
        if (selectedTeam === match.team_a) correctOdds = parseFloat(match.odds_a);
        else if (selectedTeam === match.team_b) correctOdds = parseFloat(match.odds_b);
        else if (selectedTeam === "DRAW") {
          if (knockout) return res.status(400).json({ message: "No draw option in knockout matches — pick a team to advance" });
          correctOdds = parseFloat(match.odds_draw);
        }
        else return res.status(400).json({ message: "Invalid selection" });

      } else if (betType === "total") {
        if (!match.odds_over || !match.odds_under) {
          return res.status(400).json({ message: "Over/Under odds are not available for this match yet" });
        }
        if (sel === "OVER") correctOdds = parseFloat(match.odds_over);
        else if (sel === "UNDER") correctOdds = parseFloat(match.odds_under);
        else return res.status(400).json({ message: "Invalid Over/Under selection" });

      } else if (betType === "btts") {
        if (!match.odds_btts_yes || !match.odds_btts_no) {
          return res.status(400).json({ message: "Both Teams To Score odds are not available for this match yet" });
        }
        if (sel === "YES") correctOdds = parseFloat(match.odds_btts_yes);
        else if (sel === "NO") correctOdds = parseFloat(match.odds_btts_no);
        else return res.status(400).json({ message: "Invalid BTTS selection" });
      }

      // Normalize the stored selection so settlement can match it reliably.
      const storedSelection = (betType === "moneyline") ? selectedTeam : sel;

      // Lock in the odds from the DB, not whatever the client sent (prevents odds tampering)
      const oddsUsed = correctOdds;
      db.run(
        "INSERT INTO predictions (user_id, match_id, selected_team, points_used, odds_used, bet_type) VALUES (?, ?, ?, ?, ?, ?)",
        [req.user.id, matchId, storedSelection, amount, oddsUsed, betType],
        function (err) {
          if (err) return res.status(400).json({ message: "You already placed this bet on this match" });
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
        predictions.odds_used,
        predictions.settled,
        predictions.bet_type,
        matches.team_a,
        matches.team_b,
        matches.match_time,
        matches.result,
        matches.stage,
        matches.group_name,
        matches.settlement_message,
        matches.total_line
       FROM predictions
       JOIN matches ON predictions.match_id = matches.id
       WHERE predictions.user_id = ? AND predictions.settled = 1
       ORDER BY predictions.created_at DESC`,
      [user.id],
      (err, rows) => {
        if (err) return res.status(500).json({ message: "Could not load history" });
        const history = rows.map(r => {
          const o = settledOutcome(r);
          return { ...r, won: o.won, payout: o.payout, profit: o.profit };
        });
        return res.json({ user: { username: user.username, fullName: user.full_name, points: user.points }, history });
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
      predictions.odds_used,
      predictions.settled,
      predictions.bet_type,
      predictions.created_at,
      matches.team_a,
      matches.team_b,
      matches.match_time,
      matches.result,
      matches.stage,
      matches.group_name,
      matches.settlement_message,
      matches.total_line
     FROM predictions
     JOIN matches ON predictions.match_id = matches.id
     WHERE predictions.user_id = ?
     ORDER BY predictions.created_at DESC`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Could not load prediction history" });
      // Attach correct per-market outcome for settled bets.
      const out = rows.map(r => {
        if (r.settled && r.result) {
          const o = settledOutcome(r);
          return { ...r, won: o.won, payout: o.payout, profit: o.profit };
        }
        return { ...r, won: null, payout: 0, profit: 0 };
      });
      return res.json(out);
    }
  );
});

app.get("/api/my-predicted-matches", auth, (req, res) => {
  res.set("Cache-Control", "no-store");
  db.all(
    "SELECT id, match_id, selected_team, points_used, odds_used, bet_type, settled FROM predictions WHERE user_id = ?",
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Could not load predicted matches" });
      res.json(rows);
    }
  );
});

app.get("/api/my-stats", auth, (req, res) => {
  db.all(
    `SELECT predictions.selected_team, predictions.points_used, predictions.odds_used,
            predictions.settled, predictions.bet_type,
            matches.result, matches.settlement_message, matches.total_line
     FROM predictions
     JOIN matches ON predictions.match_id = matches.id
     WHERE predictions.user_id = ?`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Could not load stats" });

      let totalPredictions = rows.length, correct = 0, losses = 0, pending = 0, totalPointsUsed = 0;
      let totalPotentialProfit = 0, totalStakeForRR = 0;
      let totalReturned = 0, totalSettledStake = 0;

      rows.forEach((item) => {
        totalPointsUsed += item.points_used;

        // R:R — potential profit vs stake, across ALL bets (not just settled)
        if (item.odds_used && item.odds_used > 0) {
          const potentialProfit = (item.points_used * parseFloat(item.odds_used)) - item.points_used;
          totalPotentialProfit += potentialProfit;
          totalStakeForRR += item.points_used;
        }

        if (!item.settled || !item.result) {
          pending++;
        } else {
          const o = settledOutcome(item);
          if (o.won === true) correct++;
          else if (o.won === false) losses++;
          // o.won === null → refund, counts as neither
          totalSettledStake += item.points_used;
          totalReturned += o.payout; // payout already correct (incl. refund = stake)
        }
      });

      const settled = correct + losses;
      const successRate = settled > 0 ? Math.round((correct / settled) * 100) : 0;

      const rrRatio = totalStakeForRR > 0
        ? (totalPotentialProfit / totalStakeForRR).toFixed(2)
        : null;

      const roi = totalSettledStake > 0
        ? ((totalReturned - totalSettledStake) / totalSettledStake * 100).toFixed(1)
        : null;

      res.json({ totalPredictions, correct, wins: correct, losses, pending, totalPointsUsed, successRate, rrRatio, roi });
    }
  );
});

// ─── SETTLE LOGIC (shared between admin manual + auto) ───────────────────────

// settleMatch settles all open predictions on a match.
//   result      = moneyline outcome (team name or "DRAW")
//   homeGoals/awayGoals = full-time goals (optional). When provided, sidebet
//                 markets (total, btts) settle too. When absent (e.g. a manual
//                 result with no score), sidebets are REFUNDED rather than lost.
function settleMatch(matchId, result, callback, homeGoals, awayGoals) {
  db.get("SELECT * FROM matches WHERE id = ?", [matchId], (err, match) => {
    if (err || !match) return callback(new Error("Match not found"));
    if (match.status === "settled") return callback(null, "already_settled");

    const haveScores = (typeof homeGoals === "number" && typeof awayGoals === "number");
    const totalGoals = haveScores ? homeGoals + awayGoals : null;
    const bothScored = haveScores ? (homeGoals > 0 && awayGoals > 0) : null;

    db.run(
      "UPDATE matches SET result = ?, status = 'settled', settled_at = CURRENT_TIMESTAMP WHERE id = ?",
      [result, matchId],
      function (err) {
        if (err) return callback(err);

        db.all("SELECT * FROM predictions WHERE match_id = ? AND settled = 0", [matchId], (err, predictions) => {
          if (err) return callback(err);

          const writeMsg = (cb) => {
            const ko = isKnockoutStage(match.stage);
            let msg = result === "DRAW"
              ? `${match.team_a} drew with ${match.team_b}`
              : ko
                ? `${result} advanced past ${result === match.team_a ? match.team_b : match.team_a}`
                : `${result} defeated ${result === match.team_a ? match.team_b : match.team_a}`;
            if (haveScores) msg += ` (${homeGoals}-${awayGoals})`;
            db.run("UPDATE matches SET settlement_message = ? WHERE id = ?", [msg, matchId], cb);
          };

          if (predictions.length === 0) {
            writeMsg(() => callback(null, `settled_no_predictions`));
            return;
          }

          let completed = 0;
          predictions.forEach((prediction) => {
            const type = (prediction.bet_type || "moneyline").toLowerCase();
            const odds = prediction.odds_used ? parseFloat(prediction.odds_used) : null;
            const sel = String(prediction.selected_team).toUpperCase();
            let reward = 0;

            if (type === "moneyline") {
              // Pay only if the pick exactly matches the result.
              if (prediction.selected_team === result) {
                reward = odds ? Math.floor(prediction.points_used * odds) : prediction.points_used;
              }
            } else if (type === "total") {
              if (!haveScores) {
                reward = prediction.points_used; // can't settle without a score → refund
              } else {
                const line = match.total_line ? parseFloat(match.total_line) : 2.5;
                const isOver = totalGoals > line;
                const win = (sel === "OVER" && isOver) || (sel === "UNDER" && !isOver);
                if (win) reward = odds ? Math.floor(prediction.points_used * odds) : prediction.points_used;
              }
            } else if (type === "btts") {
              if (!haveScores) {
                reward = prediction.points_used; // refund if unsettleable
              } else {
                const win = (sel === "YES" && bothScored) || (sel === "NO" && !bothScored);
                if (win) reward = odds ? Math.floor(prediction.points_used * odds) : prediction.points_used;
              }
            }

            db.run("UPDATE users SET points = points + ? WHERE id = ?", [reward, prediction.user_id], () => {
              db.run("UPDATE predictions SET settled = 1 WHERE id = ?", [prediction.id], () => {
                completed++;
                if (completed === predictions.length) {
                  writeMsg(() => callback(null, "settled"));
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

  // Optional full-time goals so the admin can settle Over/Under + BTTS sidebets too.
  // If omitted, sidebets on this match are refunded (can't be settled without a score).
  const hg = (req.body.homeGoals === undefined || req.body.homeGoals === null || req.body.homeGoals === "")
    ? undefined : Number(req.body.homeGoals);
  const ag = (req.body.awayGoals === undefined || req.body.awayGoals === null || req.body.awayGoals === "")
    ? undefined : Number(req.body.awayGoals);
  const validGoals = (typeof hg === "number" && !isNaN(hg) && typeof ag === "number" && !isNaN(ag));

  db.get("SELECT status FROM matches WHERE id = ?", [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ message: "Match not found" });
    if (match.status === "settled") return res.status(400).json({ message: "This match has already been settled" });

    settleMatch(matchId, result, (err, status) => {
      if (err) return res.status(500).json({ message: "Settlement failed" });
      res.json({ message: `Result settled successfully: ${result}` + (validGoals ? ` (${hg}-${ag})` : " — no score given, sidebets refunded") });
    }, validGoals ? hg : undefined, validGoals ? ag : undefined);
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
          const homeTeam = normalizeTeam(apiMatch.homeTeam.name);
          const awayTeam = normalizeTeam(apiMatch.awayTeam.name);
          const sc = apiMatch.score || {};
          const isPenaltyMatch = sc.duration === "PENALTY_SHOOTOUT";

          // ── Two DIFFERENT scores matter here, and conflating them is a bug: ──
          //
          // 1) WINNER / who-advanced: football-data's `fullTime` INCLUDES the
          //    shootout (e.g. a 1-1 that went to pens 4-5 shows fullTime 4-5),
          //    so `fullTime` reliably gives the advancer. `winner` itself is
          //    null for shootouts, so we don't depend on it.
          //
          // 2) GOALS for sidebets (Over/Under, BTTS): these must EXCLUDE the
          //    shootout. The real match goals are `regularTime` + `extraTime`.
          //    For a normal match those aren't present, so we use `fullTime`
          //    (which then contains no penalties anyway).
          const ft  = sc.fullTime    || {};
          const rt  = sc.regularTime || {};
          const et  = sc.extraTime   || {};

          // Winner score (penalty-inclusive when a shootout happened).
          const winHome = ft.home;
          const winAway = ft.away;

          // True match goals, penalty-EXCLUSIVE.
          let goalHome, goalAway;
          if (isPenaltyMatch && typeof rt.home === "number" && typeof rt.away === "number") {
            // regularTime + extraTime (extraTime may be 0s or absent)
            goalHome = rt.home + (typeof et.home === "number" ? et.home : 0);
            goalAway = rt.away + (typeof et.away === "number" ? et.away : 0);
          } else {
            // Non-shootout: fullTime already excludes penalties.
            goalHome = ft.home;
            goalAway = ft.away;
          }

          // Find the matching DB row by team names (order-independent)
          const dbMatch = pendingMatches.find(m =>
            (normalizeTeam(m.team_a) === homeTeam && normalizeTeam(m.team_b) === awayTeam) ||
            (normalizeTeam(m.team_a) === awayTeam && normalizeTeam(m.team_b) === homeTeam)
          );

          let result;
          if (dbMatch && isKnockoutStage(dbMatch.stage)) {
            // KNOCKOUT: who ADVANCED. Use the winner field if set; otherwise the
            // penalty-inclusive fullTime is decisive (shootouts always produce a
            // non-draw fullTime). Penalty tally is a last-resort tiebreak.
            const w = sc.winner;
            const pens = sc.penalties || {};
            const penHome = (typeof pens.home === "number") ? pens.home : null;
            const penAway = (typeof pens.away === "number") ? pens.away : null;

            if (w === "HOME_TEAM") {
              result = homeTeam;
            } else if (w === "AWAY_TEAM") {
              result = awayTeam;
            } else if (typeof winHome === "number" && typeof winAway === "number" && winHome !== winAway) {
              // Decisive fullTime (includes shootout for pen matches) → advancer.
              result = winHome > winAway ? homeTeam : awayTeam;
              if (isPenaltyMatch) console.log(`Knockout ${homeTeam} v ${awayTeam}: shootout → fullTime ${winHome}-${winAway} → ${result}`);
            } else if (penHome !== null && penAway !== null && penHome !== penAway) {
              result = penHome > penAway ? homeTeam : awayTeam;
              console.log(`Knockout ${homeTeam} v ${awayTeam}: decided on penalties ${penHome}-${penAway} → ${result}`);
            } else {
              console.log(`Knockout ${homeTeam} v ${awayTeam}: winner undeterminable, skipping. score=${JSON.stringify(sc)}`);
              continue;
            }
          } else {
            // GROUP STAGE: 90-minute result, draw is a valid outcome.
            if (goalHome === undefined || goalHome === null ||
                goalAway === undefined || goalAway === null) {
              console.log(`${homeTeam} v ${awayTeam}: full-time score missing, skipping`);
              continue;
            }
            if (goalHome === goalAway) result = "DRAW";
            else if (goalHome > goalAway) result = homeTeam;
            else result = awayTeam;
          }

          if (dbMatch) {
            // Map the PENALTY-EXCLUSIVE match goals onto the DB's team_a/team_b
            // orientation so Over/Under + BTTS settle on real goals only.
            let goalsA, goalsB;
            if (typeof goalHome === "number" && typeof goalAway === "number") {
              if (normalizeTeam(dbMatch.team_a) === homeTeam) {
                goalsA = goalHome; goalsB = goalAway;
              } else {
                goalsA = goalAway; goalsB = goalHome;
              }
            }
            settleMatch(dbMatch.id, result, (err, status) => {
              if (err) console.log(`Auto-settle error for match ${dbMatch.id}:`, err.message);
              else if (status === "settled") console.log(`Auto-settled: ${homeTeam} vs ${awayTeam} → ${result}` + (goalsA !== undefined ? ` (${goalsA}-${goalsB})` : ""));
            }, goalsA, goalsB);
          }
        }
      }
    );
  } catch (err) {
    console.log("Auto-settle fetch error:", err.message);
  }
}


// ─── ODDS FETCHING ────────────────────────────────────────────────────────────

// ─── OVERROUND NORMALIZATION ─────────────────────────────────────────────────
// Takes raw average odds and re-scales them so the implied probabilities sum to
// the target book (e.g. 1.03 = 103%). This guarantees a fixed house margin and
// eliminates arbitrage (where the fair odds would sum under 100%).
function applyOverround(oddsHome, oddsDraw, oddsAway, targetBook = 1.03) {
  // If any odds missing, return as-is (can't normalize a partial book)
  if (!oddsHome || !oddsDraw || !oddsAway) {
    return { home: oddsHome, draw: oddsDraw, away: oddsAway };
  }

  // Convert to implied probabilities
  const pHome = 1 / oddsHome;
  const pDraw = 1 / oddsDraw;
  const pAway = 1 / oddsAway;
  const currentBook = pHome + pDraw + pAway;

  // Scale each probability so they sum to targetBook
  const scale = targetBook / currentBook;
  const newPHome = pHome * scale;
  const newPDraw = pDraw * scale;
  const newPAway = pAway * scale;

  // Convert back to odds, round to 2 decimals
  return {
    home: Math.round((1 / newPHome) * 100) / 100,
    draw: Math.round((1 / newPDraw) * 100) / 100,
    away: Math.round((1 / newPAway) * 100) / 100
  };
}

// ─── KNOCKOUT "TO ADVANCE" ODDS DERIVATION ───────────────────────────────────
// The Odds API free WC tier only exposes the 3-way h2h market (with a Draw),
// even for knockout fixtures. For a knockout we need a two-way "to advance"
// market. We derive it: strip the overround from the 3-way book to get true
// probabilities, then a team's probability to ADVANCE = its win probability
// plus half the draw probability (a drawn match goes to ET/penalties, modelled
// as a coin flip). Convert back to odds with a fixed house margin.
function deriveAdvanceOdds(oddsHome, oddsDraw, oddsAway, margin = 1.05) {
  if (!oddsHome || !oddsDraw || !oddsAway) {
    return { home: oddsHome, away: oddsAway };
  }
  const pHome = 1 / oddsHome;
  const pDraw = 1 / oddsDraw;
  const pAway = 1 / oddsAway;
  const tot = pHome + pDraw + pAway;          // remove overround
  const advHome = (pHome + pDraw * 0.5) / tot;
  const advAway = (pAway + pDraw * 0.5) / tot;
  return {
    home: Math.round((1 / (advHome * margin)) * 100) / 100,
    away: Math.round((1 / (advAway * margin)) * 100) / 100
  };
}

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

        if (isKnockoutStage(dbMatch.stage)) {
          // ── KNOCKOUT: derive two-way "to advance" odds, no draw ──────────
          const adv = deriveAdvanceOdds(oddsHome, oddsDraw, oddsAway, 1.05);
          db.run(
            "UPDATE matches SET odds_a = ?, odds_draw = NULL, odds_b = ? WHERE id = ?",
            [adv.home, adv.away, dbMatch.id],
            () => console.log(`Advance odds: ${dbMatch.team_a} vs ${dbMatch.team_b} | ${adv.home} / ${adv.away} (to advance)`)
          );
          return;
        }

        // ── OVERROUND NORMALIZATION (target 103% book) ──────────────────────
        // Re-scale odds so implied probabilities sum to exactly 1.03, giving a
        // consistent 3% house margin and removing any arbitrage opportunity.
        const normalized = applyOverround(oddsHome, oddsDraw, oddsAway, 1.03);

        db.run(
          "UPDATE matches SET odds_a = ?, odds_draw = ?, odds_b = ? WHERE id = ?",
          [normalized.home, normalized.draw, normalized.away, dbMatch.id],
          () => console.log(`Odds updated: ${dbMatch.team_a} vs ${dbMatch.team_b} | ${normalized.home} / ${normalized.draw} / ${normalized.away}`)
        );
      });
    });
  } catch (err) {
    console.log("Odds fetch error:", err.message);
  }
}

// ─── SIDEBET ODDS (Over/Under 2.5 + BTTS) ────────────────────────────────────
// These markets live on the per-event endpoint (/events/{id}/odds), so this
// costs ONE API call per unsettled match. To respect the monthly quota, run
// this on a SLOW cron (once or twice a day) — knockout sidebet lines barely
// move. Pins the totals line to 2.5 for consistency.
function applyTwoWayMargin(oddsA, oddsB, margin = 1.05) {
  if (!oddsA || !oddsB) return { a: null, b: null };
  const pa = 1 / oddsA, pb = 1 / oddsB;
  const tot = pa + pb;
  return {
    a: Math.round((1 / ((pa / tot) * margin)) * 100) / 100,
    b: Math.round((1 / ((pb / tot) * margin)) * 100) / 100
  };
}

async function fetchAndStoreSidebets() {
  try {
    const fetch = require("node-fetch");

    // 1. Lightweight events list (cheap) to map fixtures → event IDs.
    const evRes = await fetch(
      `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/events?apiKey=${ODDS_API_KEY}`,
      { headers: { "Accept": "application/json" } }
    );
    if (!evRes.ok) { console.log("Sidebet events error:", evRes.status); return; }
    const events = await evRes.json();

    // 2. Which DB matches still NEED sidebet odds — i.e. don't have a full set
    //    yet. Each per-event call costs 2 credits (totals + btts = 2 markets),
    //    so refetching matches that already have good odds every day is what
    //    blew through the monthly quota. Now: fetch once per match (when it's
    //    first added), and rely on /api/admin/refresh-sidebets for a manual
    //    top-up close to kickoff if you want fresher numbers.
    db.all(
      `SELECT * FROM matches
       WHERE status != 'settled'
         AND (odds_over IS NULL OR odds_under IS NULL OR odds_btts_yes IS NULL OR odds_btts_no IS NULL)`,
      [],
      async (err, matches) => {
      if (err || !matches || matches.length === 0) return;

      for (const dbMatch of matches) {
        const ev = events.find(e =>
          (normalizeTeam(e.home_team) === normalizeTeam(dbMatch.team_a) && normalizeTeam(e.away_team) === normalizeTeam(dbMatch.team_b)) ||
          (normalizeTeam(e.home_team) === normalizeTeam(dbMatch.team_b) && normalizeTeam(e.away_team) === normalizeTeam(dbMatch.team_a))
        );
        if (!ev) continue;

        // 3. One per-event call for totals + btts. (Counts against quota.)
        let evtOdds;
        try {
          const r = await fetch(
            `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/events/${ev.id}/odds?regions=us&markets=totals,btts&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`,
            { headers: { "Accept": "application/json" } }
          );
          if (!r.ok) { console.log(`Sidebet odds ${dbMatch.team_a} v ${dbMatch.team_b}: ${r.status}`); continue; }
          evtOdds = await r.json();
        } catch (e) { console.log("Sidebet per-event fetch error:", e.message); continue; }

        if (!evtOdds.bookmakers || evtOdds.bookmakers.length === 0) continue;

        // 4. Group totals outcomes by their ACTUAL line, across all books —
        //    don't assume every book quotes 2.5. BTTS is line-independent.
        const linesMap = {}; // { "2.5": { point: 2.5, over: [...], under: [...] } }
        const yes = [], no = [];
        evtOdds.bookmakers.forEach(bk => {
          (bk.markets || []).forEach(mk => {
            if (mk.key === "totals") {
              mk.outcomes.forEach(o => {
                const k = String(o.point);
                if (!linesMap[k]) linesMap[k] = { point: o.point, over: [], under: [] };
                if (o.name === "Over") linesMap[k].over.push(o.price);
                if (o.name === "Under") linesMap[k].under.push(o.price);
              });
            } else if (mk.key === "btts") {
              mk.outcomes.forEach(o => {
                if (o.name === "Yes") yes.push(o.price);
                if (o.name === "No") no.push(o.price);
              });
            }
          });
        });

        // 4b. Prefer 2.5 if any book quotes BOTH sides of it (the standard,
        //     most-recognizable line). Otherwise fall back to whichever line
        //     has the most combined bookmaker coverage — the most consensus,
        //     so a thin one-off alt line doesn't get picked over a popular one.
        //     The chosen line is what gets STORED and DISPLAYED, so the label
        //     ("Over 1.5") and the odds always match what was actually priced —
        //     never a hardcoded 2.5 next to odds for a different line.
        let chosenLine = null;
        if (linesMap["2.5"] && linesMap["2.5"].over.length > 0 && linesMap["2.5"].under.length > 0) {
          chosenLine = linesMap["2.5"];
        } else {
          let best = null;
          Object.values(linesMap).forEach(l => {
            if (l.over.length === 0 || l.under.length === 0) return; // need both sides priced
            const coverage = l.over.length + l.under.length;
            if (!best || coverage > best.coverage) best = { ...l, coverage };
          });
          chosenLine = best;
        }

        const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null;

        let ou = { a: null, b: null };
        let lineUsed = null;
        if (chosenLine) {
          ou = applyTwoWayMargin(avg(chosenLine.over), avg(chosenLine.under), 1.05);
          lineUsed = chosenLine.point;
        }
        const bt = applyTwoWayMargin(avg(yes), avg(no), 1.05);

        // 5. Store whatever we got (only overwrite columns we have data for).
        //    total_line is the REAL line that was priced — never hardcoded —
        //    so the UI label, the odds, and settlement always agree.
        const sets = [], vals = [];
        if (ou.a && ou.b && lineUsed !== null) { sets.push("total_line = ?", "odds_over = ?", "odds_under = ?"); vals.push(lineUsed, ou.a, ou.b); }
        if (bt.a && bt.b) { sets.push("odds_btts_yes = ?", "odds_btts_no = ?"); vals.push(bt.a, bt.b); }
        if (sets.length === 0) continue;
        vals.push(dbMatch.id);
        db.run(`UPDATE matches SET ${sets.join(", ")} WHERE id = ?`, vals,
          () => {
            const note = (lineUsed !== null && lineUsed !== 2.5) ? " [non-standard line, no 2.5 quoted]" : "";
            console.log(`Sidebets: ${dbMatch.team_a} v ${dbMatch.team_b} | O/U${lineUsed !== null ? lineUsed : "—"} ${ou.a}/${ou.b}${note} | BTTS ${bt.a}/${bt.b}`);
          });
      }
    });
  } catch (err) {
    console.log("Sidebet fetch error:", err.message);
  }
}

// Returns true if a match's stage is a knockout round (no draws; settle on
// who advances). Group-stage matches return false and keep 3-way settlement.
function isKnockoutStage(stage) {
  if (!stage) return false;
  const s = stage.toLowerCase();
  return s.includes("round of 32") || s.includes("round of 16") ||
         s.includes("quarter") || s.includes("semi") ||
         s.includes("final") || s.includes("third place") ||
         s.includes("3rd place") || s.includes("knockout");
}

// Determine whether a SETTLED bet won, correctly per market type.
// Sidebets (total/btts) need the full-time score, which settlement appends to
// settlement_message as "(a-b)". Returns true (won), false (lost), or null
// (can't determine — e.g. a sidebet refunded with no score recorded).
function evaluateBet(betType, selectedTeam, result, settlementMessage, totalLine) {
  const type = (betType || "moneyline").toLowerCase();
  if (type === "moneyline") {
    return selectedTeam === result;
  }
  const m = settlementMessage && settlementMessage.match(/\((\d+)\s*-\s*(\d+)\)/);
  if (!m) return null;
  const ga = parseInt(m[1], 10), gb = parseInt(m[2], 10);
  const sel = String(selectedTeam).toUpperCase();
  if (type === "total") {
    const line = totalLine ? parseFloat(totalLine) : 2.5;
    const isOver = (ga + gb) > line;
    return (sel === "OVER" && isOver) || (sel === "UNDER" && !isOver);
  }
  if (type === "btts") {
    const both = ga > 0 && gb > 0;
    return (sel === "YES" && both) || (sel === "NO" && !both);
  }
  return null;
}

// Given a settled prediction + match context, return {won, payout, profit}.
// Encapsulates the won/refund/loss money logic so every endpoint agrees.
function settledOutcome(row) {
  const won = evaluateBet(row.bet_type, row.selected_team, row.result, row.settlement_message, row.total_line);
  const odds = row.odds_used ? parseFloat(row.odds_used) : null;
  if (won === true) {
    const payout = odds ? Math.floor(row.points_used * odds) : row.points_used;
    return { won: true, payout, profit: payout - row.points_used };
  }
  if (won === false) {
    return { won: false, payout: 0, profit: -row.points_used };
  }
  // null → refund/push (sidebet with no recorded score)
  return { won: null, payout: row.points_used, profit: 0 };
}


function normalizeTeam(name) {
  if (!name) return "";
  // Strip accents and normalize whitespace so "México" === "Mexico", etc.
  let n = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

  const map = {
    "United States": "USA", "USA": "USA", "US": "USA",
    "South Korea": "Korea Republic", "Korea Republic": "Korea Republic", "Korea": "Korea Republic",
    "Turkey": "Turkiye", "Turkiye": "Turkiye",
    "Bosnia-Herzegovina": "Bosnia and Herzegovina",
    "Bosnia & Herzegovina": "Bosnia and Herzegovina",
    "Bosnia and Herzegovina": "Bosnia and Herzegovina",
    "Bosnia": "Bosnia and Herzegovina",
    "Cape Verde Islands": "Cabo Verde", "Cape Verde": "Cabo Verde", "Cabo Verde": "Cabo Verde",
    "Curacao": "Curacao",
    "IR Iran": "Iran", "Iran": "Iran",
    "Cote d'Ivoire": "Ivory Coast", "Ivory Coast": "Ivory Coast",
    "Congo DR": "Congo DR", "DR Congo": "Congo DR", "Congo": "Congo DR",
    "Czech Republic": "Czechia", "Czechia": "Czechia",
    "Mexico": "Mexico",
    "Republic of Ireland": "Ireland", "Ireland": "Ireland",
    "South Africa": "South Africa",
    "Saudi Arabia": "Saudi Arabia"
  };
  return map[n] || n;
}

// Fetch odds every 2 hours
cron.schedule("0 */2 * * *", () => {
  console.log("Fetching odds (2h cycle)...");
  fetchAndStoreOdds();
});

// Also fetch on startup
setTimeout(fetchAndStoreOdds, 5000);

// Fetch SIDEBET odds (Over/Under + BTTS) once a day at 06:00.
// These use per-event API calls, so a daily cadence keeps us well under the
// monthly request quota. Lines barely move once set; refresh manually via the
// admin panel if a fixture is added mid-day.
cron.schedule("0 6 * * *", () => {
  console.log("Fetching sidebet odds (daily cycle)...");
  fetchAndStoreSidebets();
});
// One sidebet fetch shortly after startup so newly-added matches get lines.
setTimeout(fetchAndStoreSidebets, 12000);

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
  db.all("SELECT id, username, first_name, last_name, full_name, points, is_active, is_admin, cash_eligible FROM users ORDER BY points DESC", [], (err, rows) => {
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


app.post("/api/admin/toggle-cash-eligible", auth, adminOnly, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ message: "User ID required" });

  db.get("SELECT cash_eligible FROM users WHERE id = ?", [userId], (err, user) => {
    if (err || !user) return res.status(404).json({ message: "User not found" });
    const newStatus = user.cash_eligible === 1 ? 0 : 1;
    db.run("UPDATE users SET cash_eligible = ? WHERE id = ?", [newStatus, userId], function (err) {
      if (err) return res.status(500).json({ message: "Could not update cash eligibility" });
      res.json({ message: newStatus === 1 ? "Marked as cash-prize eligible" : "Removed cash-prize eligibility", cash_eligible: newStatus });
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
        `SELECT predictions.selected_team, predictions.bet_type, predictions.settled,
                matches.result, matches.settlement_message, matches.total_line
         FROM predictions JOIN matches ON predictions.match_id = matches.id
         WHERE predictions.user_id = ?`,
        [user.id],
        (err, predictions) => {
          if (err) return res.status(500).json({ message: "Could not load profile stats" });

          let wins = 0, settledCount = 0;
          predictions.forEach((p) => {
            if (!p.result) return;
            const won = evaluateBet(p.bet_type, p.selected_team, p.result, p.settlement_message, p.total_line);
            if (won === true) { wins++; settledCount++; }
            else if (won === false) { settledCount++; }
            // null → refund, not counted
          });

          const successRate = settledCount > 0 ? Math.round((wins / settledCount) * 100) : 0;
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
  const { username, password, fullName, country, startingPoints, cashEligible } = req.body;

  if (!username || !password || !fullName || !country) {
    return res.status(400).json({ message: "Username, password, full name and country are required" });
  }

  const points = Number(startingPoints) || 5000;
  const eligible = cashEligible ? 1 : 0;

  try {
    const hashed = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (username, password, full_name, country, device_id, points, cash_eligible, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [username, hashed, fullName, country, "", points, eligible],
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
    [oddsA || null, oddsDraw || null, oddsB || null, matchId],
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

// Manually refresh sidebet (Over/Under + BTTS) odds. Uses per-event API calls,
// so use sparingly to preserve quota.
app.post("/api/admin/refresh-sidebets", auth, adminOnly, (req, res) => {
  fetchAndStoreSidebets();
  res.json({ message: "Sidebet odds refresh triggered (Over/Under + BTTS)" });
});


// ─── SECRET BETS VIEW (AYYOOB ONLY) ─────────────────────────────────────────

app.get("/api/AyyoobOnly/bets", (req, res) => {
  db.all(
    `SELECT u.username, u.full_name, m.team_a, m.team_b, m.match_time, m.stage, p.selected_team, p.points_used
     FROM predictions p
     JOIN users u ON p.user_id = u.id
     JOIN matches m ON p.match_id = m.id
     WHERE p.settled = 0
     ORDER BY m.match_time, u.username`,
    [],
    (err, rows) => {
      if (err) return res.status(500).send("Error loading bets");

      const grouped = {};
      rows.forEach(r => {
        const key = r.team_a + " vs " + r.team_b;
        if (!grouped[key]) grouped[key] = { match: key, time: r.match_time, stage: r.stage, bets: [] };
        grouped[key].bets.push({ user: r.username, name: r.full_name, pick: r.selected_team, points: r.points_used });
      });

      let html = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#0a0800;color:#fff;padding:1rem;}h1{color:#ffd600;font-size:1.2rem;}.match{background:#1a1500;border:1px solid rgba(255,214,0,0.3);border-radius:10px;padding:1rem;margin-bottom:1rem;}.match h2{color:#ffd600;font-size:1rem;margin:0 0 0.5rem;}p{margin:0.2rem 0;font-size:0.85rem;color:#aaa;}table{width:100%;border-collapse:collapse;margin-top:0.5rem;}th{text-align:left;color:#ffd600;font-size:0.8rem;border-bottom:1px solid rgba(255,214,0,0.2);padding:4px 0;}td{font-size:0.85rem;padding:4px 0;border-bottom:1px solid #222;}.total{color:#ffd600;font-size:0.8rem;margin-top:0.5rem;}</style></head><body><h1>AJA League — Current Bets</h1>';

      if (Object.keys(grouped).length === 0) {
        html += '<p>No unsettled bets at the moment.</p>';
      }

      Object.values(grouped).forEach(function(g) {
        const uaeTime = new Date(new Date(g.time).getTime() + 4 * 3600000)
          .toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
        const total = g.bets.reduce(function(s, b) { return s + b.points; }, 0);
        html += '<div class="match"><h2>' + g.match + '</h2><p>' + g.stage + ' · ' + uaeTime + ' UAE</p><p class="total">Total at stake: ' + total.toLocaleString() + ' pts · ' + g.bets.length + ' bets</p><table><tr><th>User</th><th>Name</th><th>Pick</th><th>Points</th></tr>';
        g.bets.forEach(function(b) {
          html += '<tr><td>' + b.user + '</td><td>' + (b.name || '—') + '</td><td>' + b.pick + '</td><td>' + b.points.toLocaleString() + '</td></tr>';
        });
        html += '</table></div>';
      });

      html += '</body></html>';
      res.send(html);
    }
  );
});


// ─── UPDATE PREDICTION ────────────────────────────────────────────────────────

app.post("/api/update-predict", auth, (req, res) => {
  const { matchId, selectedTeam, pointsUsed } = req.body;
  const amount = Number(pointsUsed);

  if (!matchId || !selectedTeam || !amount) return res.status(400).json({ message: "Prediction details missing" });
  if (amount <= 0) return res.status(400).json({ message: "Points must be greater than 0" });
  if (amount % 5 !== 0) return res.status(400).json({ message: "Points must be multiple of 5" });

  db.get("SELECT * FROM matches WHERE id = ?", [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ message: "Match not found" });

    const now = new Date();
    const closeTime = new Date(match.prediction_close);
    if (now > closeTime) return res.status(400).json({ message: "Prediction window has closed" });

    // Find existing prediction
    db.get("SELECT * FROM predictions WHERE user_id = ? AND match_id = ?", [req.user.id, matchId], (err, existing) => {
      if (err || !existing) return res.status(404).json({ message: "No existing prediction found" });
      if (existing.settled) return res.status(400).json({ message: "Prediction already settled" });

      const oldAmount = existing.points_used;
      const knockout = isKnockoutStage(match.stage);

      // Reject if odds aren't available (knockouts are two-way, no draw odds)
      if (knockout) {
        if (!match.odds_a || !match.odds_b) {
          return res.status(400).json({ message: "Odds are not available for this match yet" });
        }
      } else {
        if (!match.odds_a || !match.odds_draw || !match.odds_b) {
          return res.status(400).json({ message: "Odds are not available for this match yet" });
        }
      }
      // Lock odds from the DB for the selected outcome (not client-supplied)
      let correctOdds;
      if (selectedTeam === match.team_a) correctOdds = parseFloat(match.odds_a);
      else if (selectedTeam === match.team_b) correctOdds = parseFloat(match.odds_b);
      else if (selectedTeam === "DRAW") {
        if (knockout) return res.status(400).json({ message: "No draw option in knockout matches — pick a team to advance" });
        correctOdds = parseFloat(match.odds_draw);
      }
      else return res.status(400).json({ message: "Invalid selection" });
      const oddsUsed = correctOdds;

      // Free editing allowed until prediction window closes — no cooldown.
      // The window-closed check above (now > closeTime) already prevents late edits.

      db.get("SELECT points FROM users WHERE id = ?", [req.user.id], (err, user) => {
        if (err || !user) return res.status(404).json({ message: "User not found" });

        const available = user.points + oldAmount;
        if (available < amount) return res.status(400).json({ message: "Not enough points" });

        const pointsDiff = amount - oldAmount;
        db.run(
          "UPDATE predictions SET selected_team = ?, points_used = ?, odds_used = ? WHERE id = ?",
          [selectedTeam, amount, oddsUsed, existing.id],
          (err) => {
            if (err) return res.status(500).json({ message: "Could not update prediction" });
            db.run("UPDATE users SET points = points - ? WHERE id = ?", [pointsDiff, req.user.id], (err) => {
              if (err) return res.status(500).json({ message: "Prediction updated but points could not be adjusted" });
              return res.json({ message: "Prediction updated successfully" });
            });
          }
        );
      });
    });
  });
});


// ─── CANCEL PREDICTION (within 5 min window) ─────────────────────────────────

app.post("/api/cancel-predict", auth, (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ message: "Match ID required" });

  // Cancel ALL unsettled bets this user has on the match (moneyline + sidebets)
  // and refund the full total. This powers the "cancel all & rebuild" flow.
  db.all(
    "SELECT * FROM predictions WHERE user_id = ? AND match_id = ? AND settled = 0",
    [req.user.id, matchId],
    (err, predictions) => {
      if (err) return res.status(500).json({ message: "Could not look up bets" });
      if (!predictions || predictions.length === 0) {
        return res.status(404).json({ message: "No bets found on this match" });
      }

      db.get("SELECT prediction_close FROM matches WHERE id = ?", [matchId], (err, match) => {
        if (err || !match) return res.status(404).json({ message: "Match not found" });
        if (new Date() > new Date(match.prediction_close)) {
          return res.status(400).json({ message: "Prediction window is closed" });
        }

        const totalRefund = predictions.reduce((sum, p) => sum + p.points_used, 0);

        db.run(
          "DELETE FROM predictions WHERE user_id = ? AND match_id = ? AND settled = 0",
          [req.user.id, matchId],
          (err) => {
            if (err) return res.status(500).json({ message: "Could not cancel bets" });
            db.run("UPDATE users SET points = points + ? WHERE id = ?", [totalRefund, req.user.id], (err) => {
              if (err) return res.status(500).json({ message: "Bets cancelled but refund failed" });
              return res.json({
                message: `Cancelled ${predictions.length} bet(s), refunded ${totalRefund.toLocaleString()} points`,
                refunded: totalRefund,
                count: predictions.length
              });
            });
          }
        );
      });
    }
  );
});


// ─── ACTIVE BETS (public — unsettled only, no amounts hidden) ────────────────

app.get("/api/active-bets", auth, (req, res) => {
  db.all(
    `SELECT
      users.username,
      matches.id AS match_id,
      matches.team_a,
      matches.team_b,
      matches.match_time,
      matches.stage,
      matches.group_name,
      matches.total_line,
      predictions.selected_team,
      predictions.points_used,
      predictions.odds_used,
      predictions.bet_type,
      predictions.created_at
     FROM predictions
     JOIN users ON predictions.user_id = users.id
     JOIN matches ON predictions.match_id = matches.id
     WHERE predictions.settled = 0
     ORDER BY matches.match_time ASC, users.username ASC, predictions.created_at ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Could not load active bets" });
      return res.json(rows);
    }
  );
});


// ─── HOUSE TOTAL ──────────────────────────────────────────────────────────────

app.get("/api/house-total", (req, res) => {
  db.all(
    `SELECT predictions.points_used, predictions.odds_used, predictions.settled,
            predictions.selected_team, predictions.bet_type,
            matches.result, matches.settlement_message, matches.total_line
     FROM predictions
     JOIN matches ON predictions.match_id = matches.id
     WHERE predictions.settled = 1`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Could not load house total" });

      let houseTotal = 0;
      rows.forEach(p => {
        const o = settledOutcome(p);
        // House keeps the stake and pays out the (correct) payout. A refund
        // (payout === stake) nets zero for the house, which is right.
        houseTotal += p.points_used - o.payout;
      });

      res.json({ houseTotal });
    }
  );
});


// ─── RECENT SETTLED BETS (for login notifications) ───────────────────────────

app.get("/api/my-recent-results", auth, (req, res) => {
  res.set("Cache-Control", "no-store");

  // `seen` = comma-separated match IDs the user has already been shown. Exclude them.
  const seenIds = req.query.seen
    ? req.query.seen.split(",").map(Number).filter(n => n > 0)
    : [];
  const excludeClause = seenIds.length > 0 ? `AND matches.id NOT IN (${seenIds.join(",")})` : "";

  db.all(
    `SELECT predictions.selected_team, predictions.points_used, predictions.odds_used, predictions.bet_type,
            matches.id AS match_id, matches.team_a, matches.team_b, matches.result,
            matches.settled_at, matches.settlement_message, matches.total_line
     FROM predictions
     JOIN matches ON predictions.match_id = matches.id
     WHERE predictions.user_id = ? AND predictions.settled = 1
       AND matches.settled_at::timestamptz > NOW() - INTERVAL '36 hours'
       ${excludeClause}
     ORDER BY matches.settled_at DESC`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Could not load recent results" });

      const results = rows.map(r => {
        const o = settledOutcome(r);
        const type = (r.bet_type || "moneyline").toLowerCase();
        const line = r.total_line ? parseFloat(r.total_line) : 2.5;
        // Friendly pick label per market.
        let pickLabel = r.selected_team;
        if (type === "total") pickLabel = `Total ${r.selected_team === "OVER" ? "Over" : "Under"} ${line}`;
        else if (type === "btts") pickLabel = `BTTS ${r.selected_team === "YES" ? "Yes" : "No"}`;
        // For sidebets, the meaningful "result" is the score, not the match winner.
        let resultText = r.result;
        if (type !== "moneyline") {
          const m = r.settlement_message && r.settlement_message.match(/\((\d+)\s*-\s*(\d+)\)/);
          resultText = m ? `${m[1]}-${m[2]}` : (r.result || "settled");
        }
        return {
          matchId: r.match_id,
          match: `${r.team_a} vs ${r.team_b}`,
          pick: pickLabel,
          betType: type,
          odds: r.odds_used,
          result: resultText,
          stake: r.points_used,
          won: o.won === true,
          refunded: o.won === null,
          payout: o.payout,
          profit: o.profit
        };
      });

      res.json(results);
    }
  );
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`Football Points League running on http://localhost:${PORT}`);
});
