
function showSkeleton(boxId, count=3) {
  const box = document.getElementById(boxId);
  if (!box) return;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<div class="skeleton-card">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line-short"></div>
    </div>`;
  }
  box.innerHTML = html;
}

const API = "/api";

let lastKnownPoints = null;
let lastKnownRank = null;
let refreshInterval = null;

function showPending() {
  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("registerPage").classList.add("hidden");
  document.getElementById("pendingPage").classList.remove("hidden");
}

function showLogin() {
  document.getElementById("loginPage").classList.remove("hidden");
  document.getElementById("registerPage").classList.add("hidden");
  document.getElementById("dashboardPage").classList.add("hidden");
}

function showRegister() {

  document
    .getElementById("registerNoticeModal")
    .classList.remove("hidden");

}

function acceptRegisterNotice() {

  document
    .getElementById("registerNoticeModal")
    .classList.add("hidden");

  document
    .getElementById("loginPage")
    .classList.add("hidden");

  document
    .getElementById("registerPage")
    .classList.remove("hidden");

  document
    .getElementById("dashboardPage")
    .classList.add("hidden");
}
function showDashboard() {
  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("registerPage").classList.add("hidden");
  document.getElementById("dashboardPage").classList.remove("hidden");
  hideAllDashboardSections();
}

function enterDashboard() {
  showDashboard();
}


function showMatchesSection() {
  hideAllDashboardSections();

  const section = document.getElementById("matchesSection");
  section.classList.remove("hidden");

  loadMatches();
  section.scrollIntoView({ behavior: "smooth" });
}

function showNotification(message) {
  const box = document.getElementById("notificationBox");

  if (!box) return;

  box.innerText = message;
  box.classList.remove("hidden");

  setTimeout(() => {
    box.classList.add("hidden");
  }, 3500);
}

function showHistorySection() {
  hideAllDashboardSections();

  const section = document.getElementById("historySection");
  section.classList.remove("hidden");

  loadPredictionHistory();
  section.scrollIntoView({ behavior: "smooth" });
}

function getRank(points) {
  points = Number(points);

  if (points >= 50000) return "Legend 👑";
  if (points >= 20000) return "Champion 🟣";
  if (points >= 10000) return "Elite 🔵";
  if (points >= 5000) return "Semi Pro 🟢";

  return "Rookie ⚪";
}

function updateDashboardUser(username, points) {
  const rank = getRank(points);

  document.getElementById("dashboardUsername").innerText = username;
  document.getElementById("dashboardPoints").innerText = points;
  document.getElementById("dashboardRank").innerText = rank;

  document.getElementById("heroUsername").innerText = username;
  document.getElementById("heroPoints").innerText = points;
  document.getElementById("heroRank").innerText = rank;
  document.getElementById("quickRank").innerText = rank;
}

function getDeviceId() {
  let id = localStorage.getItem("deviceId");

  if (!id) {
    id = "device-" + Date.now() + "-" + Math.random().toString(36).substring(2, 15);
    localStorage.setItem("deviceId", id);
  }

  return id;
}

async function register() {
  const username = document.getElementById("registerUsername").value.trim();
  const password = document.getElementById("registerPassword").value.trim();
  const fullName = document.getElementById("registerFullName").value.trim();
  if (!username || !password || !fullName) {
    alert("Please fill all registration fields.");
    return;
  }

  try {
    const res = await fetch(`${API}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username,
        password,
        fullName,
        roomNumber,
        country,
        deviceId: getDeviceId()
      })
    });

    const data = await res.json();

    if (res.ok) {
      document.getElementById("registerUsername").value = "";
      document.getElementById("registerPassword").value = "";
      document.getElementById("registerFullName").value = "";

      showPending();
    } else {
      alert(data.message || "Registration failed.");
    }

  } catch (error) {
    console.log("REGISTER ERROR:", error);
    alert("Registration failed. Check server connection.");
  }
}

async function login() {
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value.trim();

  if (!username || !password) {
    alert("Please enter login details.");
    return;
  }

  try {
    const res = await fetch(`${API}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username,
        password
      })
    });

    const data = await res.json();

    if (!data.token) {
      alert(data.message || "Login failed.");
      return;
    }

    localStorage.setItem("token", data.token);
    localStorage.setItem("isAdmin", data.isAdmin ? "true" : "false");

    lastKnownPoints = data.points;
    lastKnownRank = getRank(data.points);

    updateDashboardUser(data.username, data.points);

    showDashboard();
    loadLeaderboard();
    loadProfileStats();
hideAllDashboardSections();

    if (refreshInterval) {
      clearInterval(refreshInterval);
    }

  } catch (error) {
    alert("Login failed. Please check server/IP connection.");
    console.log(error);
  }
}

let previousRanks = {};

async function loadLeaderboard() {
  showSkeleton("leaderboard", 5);
  try {
    const res = await fetch(`${API}/leaderboard`);
    const data = await res.json();

    const box = document.getElementById("leaderboard");
    box.innerHTML = "";

    if (!data || data.length === 0) {
      box.innerHTML = "<p>No players yet.</p>";
      return;
    }

    const newRanks = {};
    data.forEach((user, index) => { newRanks[user.username] = index + 1; });

    data.forEach((user, index) => {
      let badge = "⚽";
      if (index === 0) badge = "👑";
      if (index === 1) badge = "🥈";
      if (index === 2) badge = "🥉";

      const currentRank = index + 1;
      const prevRank = previousRanks[user.username];
      let rankArrow = "";
      if (prevRank && prevRank !== currentRank) {
        if (prevRank > currentRank) {
          rankArrow = `<span style="color:#22c55e;font-size:0.75rem;margin-left:4px">▲${prevRank - currentRank}</span>`;
        } else {
          rankArrow = `<span style="color:#ef4444;font-size:0.75rem;margin-left:4px">▼${currentRank - prevRank}</span>`;
        }
      }

      box.innerHTML += `
        <div class="leaderboard-item rank-${currentRank}" onclick="showUserHistory('${user.username}')" style="cursor:pointer" title="View ${user.full_name || user.username}'s bet history">
          <span class="leader-badge">${badge}</span>

          <div class="leader-info">
            <strong>#${currentRank} ${user.full_name || user.username}</strong>${rankArrow}
            <small>${getRank(user.points)}</small>
          </div>

          <div class="leader-points">
            ${user.points.toLocaleString()}
            <span>pts</span>
          </div>
        </div>
      `;
    });

    previousRanks = newRanks;

  } catch (error) {
    console.log("Leaderboard failed", error);
  }
}

function getCountdown(closeTime) {

  const now = new Date();

  const diff = closeTime - now;

  if (diff <= 0) {
    return "00h 00m 00s";
  }

  const hours = Math.floor(diff / (1000 * 60 * 60));

  const minutes = Math.floor(
    (diff % (1000 * 60 * 60)) / (1000 * 60)
  );

  const seconds = Math.floor(
    (diff % (1000 * 60)) / 1000
  );

  return `
    ${String(hours).padStart(2, "0")}h
    ${String(minutes).padStart(2, "0")}m
    ${String(seconds).padStart(2, "0")}s
  `;
}

async function loadMatches() {
  showSkeleton("matches", 3);
  try {
    const res = await fetch(`${API}/matches`);
    const data = await res.json();

    const token = localStorage.getItem("token");
    let predictedMatches = [];

    if (token) {
      const predictedRes = await fetch(`${API}/my-predicted-matches`, {
        headers: {
          "Authorization": token
        }
      });

      predictedMatches = await predictedRes.json();
    }

    const box = document.getElementById("matches");
    box.innerHTML = "";

    if (!data || data.length === 0) {
      box.innerHTML = "<p>No matches available.</p>";
      return;
    }

    const groupedByDate = {};

    const now36 = new Date();
    const cutoff = new Date(now36.getTime() + 36 * 60 * 60 * 1000); // 36 hours from now

    data.forEach(match => {
      // Skip settled matches entirely
      if (match.result || match.status === 'settled') return;

      const matchTime = new Date(match.match_time);

      // Only show matches starting within the next 36 hours
      if (matchTime > cutoff) return;

      const dateKey = matchTime.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "long",
        year: "numeric",
        timeZone: "Asia/Dubai"
      });

      if (!groupedByDate[dateKey]) {
        groupedByDate[dateKey] = [];
      }

      groupedByDate[dateKey].push(match);
    });

    Object.keys(groupedByDate).forEach(date => {
      let matchesHtml = "";

      groupedByDate[date].forEach(match => {
        const now = new Date();

        const openTime = new Date(match.prediction_open);
        const matchTime = new Date(match.match_time);
        const closeTime = new Date(matchTime.getTime() - 5 * 60 * 1000);

        const userPrediction = predictedMatches.find(
          prediction => prediction.match_id === match.id
        );

        const timeText = matchTime.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "Asia/Dubai"
        });

        let actionHtml = "";

if (match.result) {

  let predictionText = "";

  if (userPrediction) {
    predictionText = `
      Your prediction: ${userPrediction.selected_team}
      <br>
      Points used: ${userPrediction.points_used}
      <br>
    `;
  }

  actionHtml = `
    <p class="locked-text">
      ${predictionText}
      Result: ${match.result}
      <br>
      Match settled.
    </p>
  `;

} else if (userPrediction && now >= openTime && now <= closeTime) {

  // Calculate 5-minute window
  const betPlacedAt = new Date(userPrediction.created_at);
  const cooldownEnd = new Date(betPlacedAt.getTime() + 5 * 60 * 1000);
  const inCooldown = now < cooldownEnd;
  const secondsLeft = Math.max(0, Math.floor((cooldownEnd - now) / 1000));
  const cooldownMins = Math.floor(secondsLeft / 60);
  const cooldownSecs = secondsLeft % 60;
  const cooldownStr = inCooldown ? `${cooldownMins}:${String(cooldownSecs).padStart(2,'0')}` : null;

  actionHtml = `
  <div class="countdown-box">
    <span>Predictions close in:</span>
    <strong id="timer-${match.id}">${getCountdown(closeTime)}</strong>
  </div>

  <div class="prediction-box">
    <div class="bet-status-bar">
      <p>✅ Current bet: <strong>${userPrediction.selected_team}</strong> · <strong>${userPrediction.points_used.toLocaleString()} pts</strong></p>
      <p class="cooldown-notice" id="cooldown-label-${match.id}">
        ${inCooldown
          ? `⏱ Cancel/reduce window: <strong id="cooldown-${match.id}">${cooldownStr}</strong>`
          : `🔒 Can only increase bet now`
        }
      </p>
      ${inCooldown
        ? `<button class="cancel-btn" id="cancel-btn-${match.id}" onclick="cancelBet(${match.id})">✕ Cancel Bet</button>`
        : ''
      }
    </div>
    <div class="bet-options">
      <button class="bet-btn ${userPrediction.selected_team === match.team_a ? 'bet-btn-active' : (!inCooldown ? 'bet-btn-locked' : '')}"
        ${!inCooldown && userPrediction.selected_team !== match.team_a ? 'disabled title="Can only change pick within 5 minutes"' : ''}
        onclick="selectBet(${match.id}, '${match.team_a}', ${match.odds_a || 2})">
        <span class="bet-team">${match.team_a}</span>
        <span class="bet-odds">${match.odds_a ? parseFloat(match.odds_a).toFixed(2) + 'x' : '2.00x'}</span>
      </button>
      <button class="bet-btn draw-btn ${userPrediction.selected_team === 'DRAW' ? 'bet-btn-active' : (!inCooldown ? 'bet-btn-locked' : '')}"
        ${!inCooldown && userPrediction.selected_team !== 'DRAW' ? 'disabled title="Can only change pick within 5 minutes"' : ''}
        onclick="selectBet(${match.id}, 'DRAW', ${match.odds_draw || 1.5})">
        <span class="bet-team">Draw</span>
        <span class="bet-odds">${match.odds_draw ? parseFloat(match.odds_draw).toFixed(2) + 'x' : '1.50x'}</span>
      </button>
      <button class="bet-btn ${userPrediction.selected_team === match.team_b ? 'bet-btn-active' : (!inCooldown ? 'bet-btn-locked' : '')}"
        ${!inCooldown && userPrediction.selected_team !== match.team_b ? 'disabled title="Can only change pick within 5 minutes"' : ''}
        onclick="selectBet(${match.id}, '${match.team_b}', ${match.odds_b || 2})">
        <span class="bet-team">${match.team_b}</span>
        <span class="bet-odds">${match.odds_b ? parseFloat(match.odds_b).toFixed(2) + 'x' : '2.00x'}</span>
      </button>
    </div>
    <div id="bet-slip-${match.id}" class="bet-slip hidden">
      <p class="bet-slip-preview" id="bet-preview-${match.id}"></p>
      <input type="number" id="points-${match.id}" placeholder="Points to bet (multiples of 5)" min="5" step="5"
        oninput="updateBetPreview(${match.id})" value="${userPrediction.points_used}">
      <button class="confirm-btn" onclick="confirmBet(${match.id}, true)">Update Bet</button>
    </div>
  </div>
  `;

} else if (userPrediction) {

  actionHtml = `
    <p class="locked-text">
      ✅ Bet placed: <strong>${userPrediction.selected_team}</strong> · ${userPrediction.points_used.toLocaleString()} pts
      <br><span style="font-size:0.8rem;opacity:0.7;">Waiting for result.</span>
    </p>
  `;

} else if (now >= openTime && now <= closeTime) {

  actionHtml = `

  <div class="countdown-box">

    <span>
      Predictions close in:
    </span>

    <strong id="timer-${match.id}">
      ${getCountdown(closeTime)}
    </strong>

  </div>

  <div class="prediction-box">

    <div class="bet-options">
      <button class="bet-btn" onclick="selectBet(${match.id}, '${match.team_a}', ${match.odds_a || 2})">
        <span class="bet-team">${match.team_a}</span>
        <span class="bet-odds">${match.odds_a ? match.odds_a + 'x' : '2.00x'}</span>
      </button>
      <button class="bet-btn draw-btn" onclick="selectBet(${match.id}, 'DRAW', ${match.odds_draw || 1.5})">
        <span class="bet-team">Draw</span>
        <span class="bet-odds">${match.odds_draw ? parseFloat(match.odds_draw).toFixed(2) + 'x' : '1.50x'}</span>
      </button>
      <button class="bet-btn" onclick="selectBet(${match.id}, '${match.team_b}', ${match.odds_b || 2})">
        <span class="bet-team">${match.team_b}</span>
        <span class="bet-odds">${match.odds_b ? match.odds_b + 'x' : '2.00x'}</span>
      </button>
    </div>
    <div id="bet-slip-${match.id}" class="bet-slip hidden">
      <p class="bet-slip-preview" id="bet-preview-${match.id}"></p>
      <input type="number" id="points-${match.id}" placeholder="Points to bet (multiples of 5)" min="5" step="5"
        oninput="updateBetPreview(${match.id})">
      <button class="confirm-btn" onclick="confirmBet(${match.id})">Confirm Bet</button>
    </div>

  </div>
`;

} else if (now < openTime) {

  const openDate = openTime.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Dubai"
  });

  const openClock = openTime.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Dubai"
  });

  const msUntilOpen = openTime - now;
  const hoursUntil = Math.floor(msUntilOpen / (1000 * 60 * 60));
  const minsUntil = Math.floor((msUntilOpen % (1000 * 60 * 60)) / (1000 * 60));
  const countdownStr = hoursUntil > 0 ? `${hoursUntil}h ${minsUntil}m` : `${minsUntil}m`;

  actionHtml = `
    <p class="locked-text">
      Betting opens in <strong>${countdownStr}</strong> (${openDate} ${openClock} UAE)
      <br>
      <span style="font-size:0.8rem;opacity:0.7;">Closes 5 min before kickoff</span>
    </p>
  `;

} else {

  actionHtml = `
    <p class="locked-text">
      Prediction closed
    </p>
  `;
}

        matchesHtml += `
          <div class="match-item">
            <h4>${match.team_a} vs ${match.team_b}</h4>

            <p>
              Stage: ${match.stage}
              ${match.group_name ? " - " + match.group_name : ""}
            </p>

            <p>
              Venue: ${match.venue || "TBA"}
            </p>

            <p>
              Time: ${timeText} UAE
            </p>

            ${actionHtml}
          </div>
        `;
        setInterval(() => {
  const timerElement = document.getElementById(`timer-${match.id}`);
  if (timerElement) {
    timerElement.innerHTML = getCountdown(closeTime);
  }

  // Update cooldown timer if exists
  const cooldownEl = document.getElementById(`cooldown-${match.id}`);
  const cooldownLabel = document.getElementById(`cooldown-label-${match.id}`);
  if (cooldownEl && cooldownLabel) {
    const betPlaced = userPrediction ? new Date(userPrediction.created_at) : null;
    if (betPlaced) {
      const coolEnd = new Date(betPlaced.getTime() + 5 * 60 * 1000);
      const secsLeft = Math.max(0, Math.floor((coolEnd - new Date()) / 1000));
      if (secsLeft > 0) {
        const m = Math.floor(secsLeft / 60);
        const s = secsLeft % 60;
        cooldownEl.innerHTML = `${m}:${String(s).padStart(2,'0')}`;
      } else {
        // Window expired — update label and hide cancel button
        cooldownLabel.innerHTML = '🔒 Can only increase bet now';
        cooldownLabel.className = 'cooldown-notice cooldown-expired';
        const cancelBtn = document.getElementById(`cancel-btn-${match.id}`);
        if (cancelBtn) cancelBtn.style.display = 'none';
      }
    }
  }
}, 1000);
      });

      box.innerHTML += `
        <details class="date-dropdown">
          <summary>${date}</summary>

          <div class="date-matches">
            ${matchesHtml}
          </div>
        </details>
      `;
    });

  } catch (error) {
    console.log("Matches failed", error);
  }
}

async function loadPredictionHistory() {
  showSkeleton("predictionHistory", 3);
  const token = localStorage.getItem("token");

  try {
    const res = await fetch(`${API}/my-predictions`, {
      headers: {
        "Authorization": token
      }
    });

    const data = await res.json();
    const box = document.getElementById("predictionHistory");

    box.innerHTML = "";

    if (!data || data.length === 0) {
      box.innerHTML = "<p>No predictions yet.</p>";
      return;
    }

    data.forEach(item => {
      let statusColor = "#facc15";
      let resultText = item.result || "Pending";
      let payoutText = "";
      let payoutColor = "#facc15";

      if (item.result === "DRAW") {
        statusColor = "#22c55e";
        resultText = "Draw";
        if (item.settled) {
          const odds = item.odds_used || 1.5;
          const payout = Math.floor(item.points_used * odds);
          payoutText = `Won ${payout.toLocaleString()} pts (${odds}x odds)`;
          payoutColor = "#22c55e";
        }
      } else if (item.result && item.selected_team === item.result) {
        statusColor = "#22c55e";
        if (item.settled) {
          const odds = item.odds_used || 2;
          const payout = Math.floor(item.points_used * odds);
          payoutText = `Won ${payout.toLocaleString()} pts (${odds}x odds)`;
          payoutColor = "#22c55e";
        }
      } else if (item.result && item.selected_team !== item.result) {
        statusColor = "#ef4444";
        if (item.settled) {
          payoutText = `Lost ${item.points_used.toLocaleString()} pts`;
          payoutColor = "#ef4444";
        }
      }

      const matchDate = new Date(item.match_time).toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Dubai"
      });

      box.innerHTML += `
        <div class="match-item">
          <h4>${item.team_a} vs ${item.team_b}</h4>

          <p>
            ${item.stage}${item.group_name ? " · " + item.group_name : ""} · ${matchDate}
          </p>

          <p>
            Picked: <strong>${item.selected_team}</strong> · Staked: <strong>${item.points_used.toLocaleString()} pts</strong>
          </p>

          ${payoutText ? `<p style="color:${payoutColor}; font-weight:bold;">${payoutText}</p>` : ""}

          <p style="color:${statusColor}; font-weight:bold;">
            ${item.settled ? resultText : "⏳ Pending result"}
          </p>
        </div>
      `;
    });

  } catch (error) {
    console.log("History failed", error);
  }
}

async function refreshUserData() {
  const token = localStorage.getItem("token");

  if (!token) return;

  try {
    const res = await fetch(`${API}/me`, {
      headers: {
        "Authorization": token
      }
    });

    const data = await res.json();

    if (data.points !== undefined) {
      const newRank = getRank(data.points);

      if (lastKnownPoints !== null && data.points > lastKnownPoints) {
        showNotification(`+${data.points - lastKnownPoints} points added!`);
      }

      if (lastKnownPoints !== null && data.points < lastKnownPoints) {
        showNotification(`${lastKnownPoints - data.points} points used.`);
      }

      if (lastKnownRank !== null && newRank !== lastKnownRank) {
        showNotification(`Rank updated: ${newRank}`);
      }

      lastKnownPoints = data.points;
      lastKnownRank = newRank;

      updateDashboardUser(data.username, data.points);
    }

  } catch (err) {
    console.log("Refresh failed");
  }
}

function playSound(id) {

  const sound = document.getElementById(id);

  if (!sound) {
    console.log("Sound not found:", id);
    return;
  }

  sound.currentTime = 0;
  sound.volume = 0.4;

  sound.play().catch(err => {
    console.log("Sound blocked:", err);
  });
}

async function submitPrediction(matchId, selectedTeam) {
  const input = document.getElementById(`points-${matchId}`);
  const pointsUsed = Number(input.value);

  if (!pointsUsed || pointsUsed <= 0) {
    alert("Please enter points.");
    return;
  }

  if (pointsUsed % 5 !== 0) {
    alert("Points must be multiple of 5.");
    return;
  }

  const confirmChoice = confirm(
    `Are you sure you want to use ${pointsUsed} points on ${selectedTeam}?`
  );

  if (!confirmChoice) return;

  const token = localStorage.getItem("token");

  try {
    const res = await fetch(`${API}/predict`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": token
      },
      body: JSON.stringify({
        matchId,
        selectedTeam,
        pointsUsed
      })
    });

    const data = await res.json();

    alert(data.message);

    if (res.ok) {
      playSound("predictSound");
      input.value = "";

      await refreshUserData();
      await loadLeaderboard();
      await loadMatches();

      const historySection = document.getElementById("historySection");
      if (historySection && !historySection.classList.contains("hidden")) {
        await loadPredictionHistory();
      }

      const statsSection = document.getElementById("statsSection");
      if (statsSection && !statsSection.classList.contains("hidden")) {
        await loadProfileStats();
      }
    }

} catch (error) {

  console.log("Prediction frontend error:", error);

  try {

    await refreshUserData();
    await loadLeaderboard();
    await loadMatches();

  } catch (refreshError) {

    console.log("Refresh failed:", refreshError);

  }

  
}
}


function showStatsSection() {
  hideAllDashboardSections();

  const section = document.getElementById("statsSection");
  section.classList.remove("hidden");

  loadProfileStats();
  section.scrollIntoView({ behavior: "smooth" });
}

async function loadProfileStats() {
  const token = localStorage.getItem("token");

  const res = await fetch(`${API}/my-stats`, {
    headers: {
      "Authorization": token
    }
  });

  const data = await res.json();

  document.getElementById("quickTotalPredictions").innerText = data.totalPredictions;
document.getElementById("quickWins").innerText = data.wins;
document.getElementById("quickSuccessRate").innerText = `${data.successRate}%`;

  const box = document.getElementById("profileStats");

  box.innerHTML = `
    <div class="dashboard-grid">
      <div class="dash-card">
        <h3>Total Predictions</h3>
        <p>${data.totalPredictions}</p>
      </div>

      <div class="dash-card">
        <h3>Wins</h3>
        <p>${data.wins}</p>
      </div>

      <div class="dash-card">
        <h3>Losses</h3>
        <p>${data.losses}</p>
      </div>

      <div class="dash-card">
        <h3>Draw Results</h3>
        <p>${data.draws}</p>
      </div>

      <div class="dash-card">
        <h3>Pending</h3>
        <p>${data.pending}</p>
      </div>

      <div class="dash-card">
        <h3>Success Rate</h3>
        <p>${data.successRate}%</p>
      </div>

      <div class="dash-card">
        <h3>Total Points Used</h3>
        <p>${data.totalPointsUsed}</p>
      </div>
    </div>
  `;
}


function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("isAdmin");

  lastKnownPoints = null;
  lastKnownRank = null;

  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }

  showLogin();
}

function hideAllDashboardSections() {
  document.getElementById("leaderboardSection").classList.add("hidden");
  document.getElementById("matchesSection").classList.add("hidden");
  document.getElementById("historySection").classList.add("hidden");
  document.getElementById("activeBetsSection") && document.getElementById("activeBetsSection").classList.add("hidden");
  document.getElementById("statsSection").classList.add("hidden");
}

function showLeaderboardSection() {
  hideAllDashboardSections();

  const section = document.getElementById("leaderboardSection");
  section.classList.remove("hidden");

  loadLeaderboard();
  section.scrollIntoView({ behavior: "smooth" });
}


// ─── USER HISTORY MODAL ──────────────────────────────────────────────────────

async function showUserHistory(username) {
  const token = localStorage.getItem("token");
  const modal = document.getElementById("userHistoryModal");
  const title = document.getElementById("userHistoryTitle");
  const statBox = document.getElementById("userHistoryStats");
  const listBox = document.getElementById("userHistoryList");

  title.innerText = "Loading...";
  statBox.innerHTML = "";
  listBox.innerHTML = "<p>Loading history...</p>";
  modal.classList.remove("hidden");

  try {
    const res = await fetch(`${API}/user-history/${encodeURIComponent(username)}`, {
      headers: { "Authorization": token }
    });
    const data = await res.json();

    if (!res.ok) {
      listBox.innerHTML = `<p>${data.message || "Could not load history."}</p>`;
      return;
    }

    const { user, history } = data;
    title.innerText = `${user.fullName || user.username}'s Bet History`;

    // Stats summary
    let wins = 0, losses = 0, draws = 0;
    history.forEach(h => {
      if (h.result === "DRAW") draws++;
      else if (h.selected_team === h.result) wins++;
      else losses++;
    });
    const settled = wins + losses + draws;
    const rate = settled > 0 ? Math.round((wins / settled) * 100) : 0;

    statBox.innerHTML = `
      <div class="user-history-summary">
        <span>🏆 ${wins} wins</span>
        <span>❌ ${losses} losses</span>
        <span>🤝 ${draws} draws</span>
        <span>🎯 ${rate}% success</span>
        <span>💰 ${user.points} pts</span>
      </div>
    `;

    if (history.length === 0) {
      listBox.innerHTML = "<p>No settled bets yet.</p>";
      return;
    }

    listBox.innerHTML = history.map(item => {
      let color = "#ef4444";
      let label = "Lost";
      if (item.result === "DRAW") { color = "#22c55e"; label = "Draw ✓"; }
      else if (item.selected_team === item.result) { color = "#22c55e"; label = "Won ✓"; }

      const matchDate = new Date(item.match_time).toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Dubai"
      });

      return `
        <div class="match-item">
          <h4>${item.team_a} vs ${item.team_b}</h4>
          <p>Stage: ${item.stage}${item.group_name ? " - " + item.group_name : ""}</p>
          <p>Date: ${matchDate}</p>
          <p>Picked: <strong>${item.selected_team}</strong> · ${item.points_used} pts</p>
          <p style="color:${color}; font-weight:bold;">${label} (Result: ${item.result})</p>
        </div>
      `;
    }).join("");

  } catch (err) {
    listBox.innerHTML = "<p>Failed to load history.</p>";
    console.log("User history error:", err);
  }
}

function closeUserHistory() {
  document.getElementById("userHistoryModal").classList.add("hidden");
}

// Close modal on backdrop click
document.addEventListener("click", function(e) {
  const modal = document.getElementById("userHistoryModal");
  if (e.target === modal) closeUserHistory();
});


// ─── ODDS-BASED BETTING ──────────────────────────────────────────────────────

const activeBet = {}; // { matchId: { pick, odds } }

function selectBet(matchId, pick, odds) {
  activeBet[matchId] = { pick, odds };

  const slip = document.getElementById("bet-slip-" + matchId);
  slip.classList.remove("hidden");

  const pointsInput = document.getElementById("points-" + matchId);
  pointsInput.value = "";

  const preview = document.getElementById("bet-preview-" + matchId);
  preview.innerText = "Pick: " + pick + " @ " + odds + "x — enter points to see payout";
}

function updateBetPreview(matchId) {
  const bet = activeBet[matchId];
  if (!bet) return;

  const pts = parseInt(document.getElementById("points-" + matchId).value) || 0;
  const payout = Math.floor(pts * bet.odds);
  const profit = payout - pts;

  const preview = document.getElementById("bet-preview-" + matchId);
  if (pts <= 0) {
    preview.innerText = "Pick: " + bet.pick + " @ " + bet.odds + "x";
  } else {
    preview.innerText = "Pick: " + bet.pick + " @ " + bet.odds + "x — Bet " + pts + " pts → Win " + payout + " pts (+" + profit + " profit)";
  }
}

async function confirmBet(matchId, isUpdate = false) {
  const token = localStorage.getItem("token");
  const bet = activeBet[matchId];
  if (!bet) { alert("Select a team first."); return; }

  const pts = parseInt(document.getElementById("points-" + matchId).value);
  if (!pts || pts <= 0) { alert("Enter points to bet."); return; }
  if (pts % 5 !== 0) { alert("Points must be a multiple of 5."); return; }

  const potentialWin = Math.floor(pts * bet.odds);
  const profit = potentialWin - pts;
  const action = isUpdate ? "update your bet to" : "place a bet of";
  const confirmed = confirm(
    `⚠️ Confirm Bet\n\n` +
    `You are about to ${action} ${pts.toLocaleString()} pts on ${bet.pick} at ${bet.odds}x odds.\n\n` +
    `✅ If correct: you win ${potentialWin.toLocaleString()} pts (+${profit.toLocaleString()} profit)\n` +
    `❌ If wrong: you lose ${pts.toLocaleString()} pts\n\n` +
    `Are you sure?`
  );
  if (!confirmed) return;

  const endpoint = isUpdate ? `${API}/update-predict` : `${API}/predict`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token },
    body: JSON.stringify({ matchId, selectedTeam: bet.pick, pointsUsed: pts, oddsUsed: bet.odds })
  });

  const data = await res.json();
  if (res.ok) {
    playPredictSound();
    const action = isUpdate ? "Bet updated!" : "Bet placed!";
    showNotification(action + " " + bet.pick + " @ " + bet.odds + "x for " + pts.toLocaleString() + " pts");

    // Clear bet slip state
    const slip = document.getElementById("bet-slip-" + matchId);
    if (slip) slip.classList.add("hidden");
    const input = document.getElementById("points-" + matchId);
    if (input) input.value = "";
    delete activeBet[matchId];

    // Suppress the notification from refreshUserData since we already showed one
    const savedPoints = lastKnownPoints;
    await refreshUserData();
    lastKnownPoints = savedPoints; // prevent double notification

    // Run matches and leaderboard in parallel
    await Promise.all([loadMatches(), loadLeaderboard()]);

  } else {
    alert(data.message || "Bet failed.");
  }
}

async function cancelBet(matchId) {
  const token = localStorage.getItem("token");
  if (!confirm("Cancel your bet and get your points back?")) return;

  const res = await fetch(`${API}/cancel-predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token },
    body: JSON.stringify({ matchId })
  });

  const data = await res.json();
  if (res.ok) {
    const savedPoints = lastKnownPoints;
    await refreshUserData();
    lastKnownPoints = savedPoints;
    showNotification("Bet cancelled — points refunded!");
    await Promise.all([loadMatches(), loadLeaderboard()]);
  } else {
    alert(data.message || "Could not cancel bet.");
  }
}


async function showActiveBetsSection() {
  hideAllDashboardSections();
  document.getElementById("activeBetsSection").classList.remove("hidden");
  await loadActiveBets();
}

async function loadActiveBets() {
  const token = localStorage.getItem("token");
  showSkeleton("activeBetsList", 3);

  try {
    const res = await fetch(`${API}/active-bets`, {
      headers: { "Authorization": token }
    });
    const data = await res.json();
    const box = document.getElementById("activeBetsList");

    if (!data || data.length === 0) {
      box.innerHTML = "<p>No active bets at the moment.</p>";
      return;
    }

    // Group by match
    const grouped = {};
    data.forEach(b => {
      const key = b.team_a + " vs " + b.team_b;
      if (!grouped[key]) grouped[key] = {
        team_a: b.team_a,
        team_b: b.team_b,
        match_time: b.match_time,
        stage: b.stage,
        group_name: b.group_name,
        bets: []
      };
      grouped[key].bets.push(b);
    });

    box.innerHTML = Object.values(grouped).map(g => {
      const matchDate = new Date(g.match_time).toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
        timeZone: "Asia/Dubai", hour12: false
      });
      const totalStake = g.bets.reduce((s, b) => s + b.points_used, 0);

      const rows = g.bets.map(b => {
        const odds = b.odds_used ? parseFloat(b.odds_used).toFixed(2) + "x" : "—";
        const potWin = b.odds_used ? Math.floor(b.points_used * b.odds_used).toLocaleString() : "—";
        return `<tr>
          <td><strong>${b.username}</strong></td>
          <td>${b.selected_team}</td>
          <td>${b.points_used.toLocaleString()}</td>
          <td>${odds}</td>
          <td>${potWin}</td>
        </tr>`;
      }).join("");

      return `
        <div class="match-item">
          <h4>${g.team_a} vs ${g.team_b}</h4>
          <p>${g.stage}${g.group_name ? " · " + g.group_name : ""} · ${matchDate} UAE</p>
          <p style="color:#ffd600;font-size:0.85rem;">Total staked: ${totalStake.toLocaleString()} pts · ${g.bets.length} bets</p>
          <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:0.82rem;">
            <tr style="color:#ffd600;border-bottom:1px solid rgba(255,214,0,0.2);">
              <th style="padding:4px 0;text-align:left;">Player</th>
              <th style="text-align:left;">Pick</th>
              <th style="text-align:right;">Stake</th>
              <th style="text-align:right;">Odds</th>
              <th style="text-align:right;">To Win</th>
            </tr>
            ${rows}
          </table>
        </div>
      `;
    }).join("");

  } catch (err) {
    document.getElementById("activeBetsList").innerHTML = "<p>Could not load bets.</p>";
  }
}


// ─── AUTO LOGIN ON PAGE LOAD ─────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", async () => {
  const token = localStorage.getItem("token");
  if (!token) {
    showLogin();
    return;
  }

  try {
    const res = await fetch(`${API}/me`, {
      headers: { "Authorization": token }
    });

    if (!res.ok) {
      localStorage.removeItem("token");
      localStorage.removeItem("isAdmin");
      showLogin();
      return;
    }

    const data = await res.json();
    updateDashboardUser(data.username, data.points);

    if (data.is_admin === 1) {
      document.getElementById("adminButton") && 
        document.getElementById("adminButton").classList.remove("hidden");
    }

    showDashboard();
    refreshUserData();

  } catch (err) {
    showLogin();
  }
});

