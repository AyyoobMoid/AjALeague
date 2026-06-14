const db = require("./database");
const matches = require("./matches.json");

function addHours(date, hours) {
  const d = new Date(date);
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

function addMinutes(date, minutes) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

db.serialize(() => {
  db.run("DELETE FROM matches", [], (err) => {
    if (err) console.log("Delete error:", err.message);
    else console.log("Old matches deleted");
  });

  const stmt = db.prepare(`
    INSERT INTO matches 
    (stage, group_name, team_a, team_b, venue, match_time, prediction_open, prediction_close, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `);

  matches.forEach((match) => {
    const predictionOpen = addHours(match.matchTime, -24);
    const predictionClose = addMinutes(match.matchTime, -5);

    stmt.run(
      match.stage,
      match.group,
      match.teamA,
      match.teamB,
      match.venue,
      match.matchTime,
      predictionOpen,
      predictionClose
    );
  });

  stmt.finalize(() => {
    console.log(`${matches.length} World Cup 2026 matches added successfully`);
    db.close();
  });
});