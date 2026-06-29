
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

// Returns true if a match's stage is a knockout round (two-way "to advance"
// market, no Draw button). Mirrors the backend isKnockoutStage().
function isKnockout(stage) {
  if (!stage) return false;
  const s = stage.toLowerCase();
  return s.includes("round of 32") || s.includes("round of 16") ||
         s.includes("quarter") || s.includes("semi") ||
         s.includes("final") || s.includes("third place") ||
         s.includes("3rd place") || s.includes("knockout");
}

// ─── BET BUILDER ─────────────────────────────────────────────────────────────
// A single match card lets a player tick any of the available markets
// (Match Result / To Advance, Total Goals, Both Teams To Score), enter an
// amount for each, see a live receipt, and place them all with one button.
// Each leg is an INDEPENDENT bet (no parlay) — fired sequentially to /api/predict.
// Editing = cancel ALL bets on the match and rebuild (rewards early lock-in).

// Build the list of markets available for a match, with their two options each.
function marketsFor(match) {
  const isKO = isKnockout(match.stage);
  const markets = [];

  // Match result / advance
  const mlReady = isKO
    ? (match.odds_a && match.odds_b && +match.odds_a > 0 && +match.odds_b > 0)
    : (match.odds_a && match.odds_draw && match.odds_b && +match.odds_a > 0 && +match.odds_draw > 0 && +match.odds_b > 0);
  if (mlReady) {
    const opts = [{ label: match.team_a + (isKO ? ' to advance' : ''), val: match.team_a, odds: +match.odds_a }];
    if (!isKO) opts.push({ label: 'Draw', val: 'DRAW', odds: +match.odds_draw });
    opts.push({ label: match.team_b + (isKO ? ' to advance' : ''), val: match.team_b, odds: +match.odds_b });
    markets.push({ key: 'moneyline', title: isKO ? 'To Advance' : 'Match Result', options: opts });
  }

  // Total goals (Over/Under)
  if (match.odds_over && match.odds_under && +match.odds_over > 0 && +match.odds_under > 0) {
    const line = match.total_line ? +match.total_line : 2.5;
    markets.push({
      key: 'total', title: 'Total Goals', subtitle: 'Over/Under ' + line,
      options: [
        { label: 'Over ' + line, val: 'OVER', odds: +match.odds_over },
        { label: 'Under ' + line, val: 'UNDER', odds: +match.odds_under }
      ]
    });
  }

  // Both teams to score
  if (match.odds_btts_yes && match.odds_btts_no && +match.odds_btts_yes > 0 && +match.odds_btts_no > 0) {
    markets.push({
      key: 'btts', title: 'Both Teams To Score', subtitle: 'Yes/No',
      options: [
        { label: 'Yes', val: 'YES', odds: +match.odds_btts_yes },
        { label: 'No', val: 'NO', odds: +match.odds_btts_no }
      ]
    });
  }
  return markets;
}

// Renders the interactive builder for a match with no bets yet on it.
function renderBetBuilder(match) {
  const markets = marketsFor(match);
  if (markets.length === 0) return '';

  // Max a slider can reach = the user's current balance (rounded down to a
  // multiple of 5). Fallback to a sane default if balance isn't known yet.
  const bal = (typeof lastKnownPoints === 'number' && lastKnownPoints > 0)
    ? Math.floor(lastKnownPoints / 5) * 5 : 0;
  // Slider step scales with balance so big balances stay draggable, but never
  // below 5 (the betting increment). Typing in the number box gives fine control.
  const sliderStep = bal > 100000 ? 500 : bal > 20000 ? 100 : bal > 2000 ? 25 : 5;

  const marketHtml = markets.map(mkt => {
    const optButtons = mkt.options.map(o =>
      `<button type="button" class="bb-opt" data-odds="${o.odds}" data-val="${o.val.replace(/"/g, '&quot;')}"
         onclick="bbPick(${match.id}, '${mkt.key}', this)">
         <span class="bb-opt-label">${o.label}</span>
         <span class="bb-opt-odds">${o.odds.toFixed(2)}x</span>
       </button>`
    ).join('');

    return `
    <div class="bb-market" data-market="${mkt.key}">
      <label class="bb-market-head">
        <input type="checkbox" class="bb-tick" onchange="bbToggle(${match.id}, '${mkt.key}', this.checked)">
        <span class="bb-market-title">${mkt.title}${mkt.subtitle ? ` <span class="bb-sub">${mkt.subtitle}</span>` : ''}</span>
      </label>
      <div class="bb-market-body hidden" id="bb-body-${match.id}-${mkt.key}">
        <div class="bb-opts">${optButtons}</div>
        <div class="bb-stake">
          <input type="range" class="bb-slider" id="bb-slider-${match.id}-${mkt.key}"
            min="0" max="${bal}" step="${sliderStep}" value="0"
            oninput="bbSlide(${match.id}, '${mkt.key}', this.value)">
          <div class="bb-stake-readout">
            <input type="number" class="bb-amount" id="bb-amt-${match.id}-${mkt.key}"
              placeholder="0" min="0" max="${bal}" step="5" value=""
              oninput="bbType(${match.id}, '${mkt.key}', this.value)">
            <span class="bb-stake-pts">pts</span>
            <button type="button" class="bb-max-btn" onclick="bbMax(${match.id}, '${mkt.key}')">Max</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="bet-builder" id="bet-builder-${match.id}" data-balance="${bal}">
    <p class="bb-intro">Tick the bets you want, set an amount for each, then place them all at once.</p>
    ${marketHtml}
    <div class="bb-receipt hidden" id="bb-receipt-${match.id}">
      <div class="bb-receipt-title">📋 Your slip</div>
      <div id="bb-receipt-lines-${match.id}"></div>
      <div class="bb-receipt-total" id="bb-receipt-total-${match.id}"></div>
      <div class="bb-receipt-warn hidden" id="bb-receipt-warn-${match.id}"></div>
      <p class="bb-receipt-note">Each bet wins or loses on its own — this isn't a combo.</p>
    </div>
    <button class="confirm-btn bb-place-btn" id="bb-place-${match.id}" onclick="bbPlace(${match.id})" disabled>Place Bets</button>
  </div>`;
}

// Per-match builder state: { matchId: { marketKey: {pick, odds, label, amount} } }
const builderState = {};

function bbToggle(matchId, marketKey, checked) {
  const body = document.getElementById(`bb-body-${matchId}-${marketKey}`);
  if (body) body.classList.toggle('hidden', !checked);
  if (!builderState[matchId]) builderState[matchId] = {};
  if (checked) {
    if (!builderState[matchId][marketKey]) builderState[matchId][marketKey] = { pick: null, odds: null, label: null, amount: 0 };
    // Paint the slider's initial (empty) fill when the market is revealed.
    const slider = document.getElementById(`bb-slider-${matchId}-${marketKey}`);
    if (slider) bbPaintSlider(slider);
  } else {
    delete builderState[matchId][marketKey];
    // Reset the controls so re-ticking starts clean.
    const slider = document.getElementById(`bb-slider-${matchId}-${marketKey}`);
    const num = document.getElementById(`bb-amt-${matchId}-${marketKey}`);
    if (slider) { slider.value = 0; bbPaintSlider(slider); }
    if (num) num.value = '';
  }
  bbRecalc(matchId);
}

function bbPick(matchId, marketKey, btn) {
  // Highlight the chosen option within this market
  const market = btn.closest('.bb-market');
  market.querySelectorAll('.bb-opt').forEach(b => b.classList.remove('bb-opt-active'));
  btn.classList.add('bb-opt-active');

  if (!builderState[matchId]) builderState[matchId] = {};
  if (!builderState[matchId][marketKey]) builderState[matchId][marketKey] = { amount: 0 };
  builderState[matchId][marketKey].pick = btn.dataset.val;
  builderState[matchId][marketKey].odds = parseFloat(btn.dataset.odds);
  builderState[matchId][marketKey].label = btn.querySelector('.bb-opt-label').innerText;
  bbRecalc(matchId);
}

// Snap any value to the nearest valid bet increment (multiple of 5), clamped to balance.
function bbSnap(matchId, raw) {
  const builder = document.getElementById(`bet-builder-${matchId}`);
  const bal = builder ? parseInt(builder.dataset.balance) || 0 : 0;
  let v = Math.round((parseInt(raw) || 0) / 5) * 5;
  if (v < 0) v = 0;
  if (v > bal) v = Math.floor(bal / 5) * 5;
  return v;
}

// Write a value into BOTH the slider and the number box for a market, then recalc.
function bbSetStake(matchId, marketKey, value) {
  const v = bbSnap(matchId, value);
  const slider = document.getElementById(`bb-slider-${matchId}-${marketKey}`);
  const num = document.getElementById(`bb-amt-${matchId}-${marketKey}`);
  if (slider) { slider.value = v; bbPaintSlider(slider); }
  if (num) num.value = v === 0 ? '' : v;
  bbRecalc(matchId);
}

// Slider dragged → sync number box.
function bbSlide(matchId, marketKey, value) {
  bbSetStake(matchId, marketKey, value);
}
// Number typed → sync slider. (Don't snap mid-type to allow free entry; snap on recalc.)
function bbType(matchId, marketKey, value) {
  const v = bbSnap(matchId, value);
  const slider = document.getElementById(`bb-slider-${matchId}-${marketKey}`);
  if (slider) { slider.value = v; bbPaintSlider(slider); }
  bbRecalc(matchId);
}
// "Max" → set this market's stake to the full current balance.
function bbMax(matchId, marketKey) {
  const builder = document.getElementById(`bet-builder-${matchId}`);
  const bal = builder ? parseInt(builder.dataset.balance) || 0 : 0;
  bbSetStake(matchId, marketKey, bal);
}
// Paint the slider's filled portion (visual progress) via a CSS gradient.
function bbPaintSlider(slider) {
  const max = parseFloat(slider.max) || 1;
  const pct = max > 0 ? (parseFloat(slider.value) / max) * 100 : 0;
  slider.style.background =
    `linear-gradient(to right, #ffd600 0%, #ffd600 ${pct}%, rgba(255,255,255,0.12) ${pct}%, rgba(255,255,255,0.12) 100%)`;
}

function bbRecalc(matchId) {
  const state = builderState[matchId] || {};
  const builder = document.getElementById(`bet-builder-${matchId}`);
  const balance = builder ? parseInt(builder.dataset.balance) || 0 : 0;
  const lines = [];
  let totalStake = 0, totalReturn = 0, anyInvalid = false, anyLeg = false;

  Object.keys(state).forEach(key => {
    const leg = state[key];
    const amtEl = document.getElementById(`bb-amt-${matchId}-${key}`);
    const amt = amtEl ? parseInt(amtEl.value) || 0 : 0;
    leg.amount = amt;
    if (leg.pick && amt > 0) {
      anyLeg = true;
      if (amt % 5 !== 0) anyInvalid = true;
      const ret = Math.floor(amt * leg.odds);
      totalStake += amt;
      totalReturn += ret;
      lines.push(`<div class="bb-rcpt-line"><span>${leg.label} @ ${leg.odds.toFixed(2)}x · ${amt.toLocaleString()} pts</span><span class="bb-rcpt-win">→ ${ret.toLocaleString()}</span></div>`);
    } else if (leg.pick && amt === 0) {
      anyInvalid = true; // ticked + picked but no amount yet
    } else if (!leg.pick) {
      anyInvalid = true; // ticked but no pick chosen
    }
  });

  // Combined stake across all ticked markets can't exceed the balance.
  const overBalance = totalStake > balance;

  const receipt = document.getElementById(`bb-receipt-${matchId}`);
  const linesEl = document.getElementById(`bb-receipt-lines-${matchId}`);
  const totalEl = document.getElementById(`bb-receipt-total-${matchId}`);
  const warnEl = document.getElementById(`bb-receipt-warn-${matchId}`);
  const placeBtn = document.getElementById(`bb-place-${matchId}`);

  if (anyLeg && linesEl) {
    receipt.classList.remove('hidden');
    linesEl.innerHTML = lines.join('');
    totalEl.innerHTML = `<span>Total staked: <strong>${totalStake.toLocaleString()}</strong> pts</span><span>If all win: <strong class="bb-rcpt-win">${totalReturn.toLocaleString()}</strong> pts</span>`;
    if (warnEl) {
      if (overBalance) {
        warnEl.classList.remove('hidden');
        warnEl.innerHTML = `⚠ Total staked (${totalStake.toLocaleString()}) is more than your balance (${balance.toLocaleString()}). Lower an amount to place these bets.`;
      } else {
        warnEl.classList.add('hidden');
      }
    }
  } else if (receipt) {
    receipt.classList.add('hidden');
  }

  // Enable place button only when there's at least one fully-valid leg,
  // nothing half-filled, and the combined stake fits the balance.
  if (placeBtn) placeBtn.disabled = !(anyLeg && !anyInvalid && !overBalance);
}

async function bbPlace(matchId) {
  const state = builderState[matchId] || {};
  const legs = Object.keys(state)
    .map(key => ({ betType: key, ...state[key] }))
    .filter(l => l.pick && l.amount > 0);

  if (legs.length === 0) { alert('Tick at least one bet and enter an amount.'); return; }
  for (const l of legs) {
    if (l.amount % 5 !== 0) { alert('All amounts must be multiples of 5.'); return; }
  }

  const totalStake = legs.reduce((s, l) => s + l.amount, 0);
  const totalReturn = legs.reduce((s, l) => s + Math.floor(l.amount * l.odds), 0);
  // Final safety: never let the combined stake exceed the known balance.
  if (typeof lastKnownPoints === 'number' && totalStake > lastKnownPoints) {
    alert(`Total staked (${totalStake.toLocaleString()}) is more than your balance (${lastKnownPoints.toLocaleString()}). Lower an amount.`);
    return;
  }
  const summary = legs.map(l => `• ${l.label} @ ${l.odds.toFixed(2)}x — ${l.amount.toLocaleString()} pts`).join('\n');
  if (!confirm(`⚠️ Confirm ${legs.length} bet${legs.length > 1 ? 's' : ''}\n\n${summary}\n\nTotal staked: ${totalStake.toLocaleString()} pts\nIf all win: ${totalReturn.toLocaleString()} pts\n\nEach bet settles independently. Place them?`)) return;

  const token = localStorage.getItem('token');
  showLoadingOverlay(`Placing ${legs.length} bet${legs.length > 1 ? 's' : ''}...`);

  // Fire each leg sequentially. Track results so partial failures are reported clearly.
  const placed = [], failed = [];
  for (const l of legs) {
    try {
      const res = await fetch(`${API}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': token },
        body: JSON.stringify({ matchId, selectedTeam: l.pick, pointsUsed: l.amount, betType: l.betType })
      });
      const data = await res.json();
      if (res.ok) placed.push(l); else failed.push({ l, msg: data.message });
    } catch (e) {
      failed.push({ l, msg: 'Network error' });
    }
  }

  hideLoadingOverlay();
  delete builderState[matchId];

  if (placed.length > 0) playSound('predictSound');
  if (failed.length === 0) {
    showNotification(`${placed.length} bet${placed.length > 1 ? 's' : ''} placed on this match!`);
  } else if (placed.length > 0) {
    showNotification(`${placed.length} placed, ${failed.length} failed: ${failed[0].msg}`);
  } else {
    alert('Bets failed: ' + failed[0].msg);
  }

  // Refresh authoritative state from the server (covers the multi-bet case cleanly).
  if (lastKnownPoints !== null && placed.length > 0) {
    const staked = placed.reduce((s, l) => s + l.amount, 0);
    lastKnownPoints = Math.max(0, lastKnownPoints - staked);
    setPointsDisplay(lastKnownPoints);
  }
  suppressNextPointsNotification = true;
  setTimeout(() => { refreshUserData(); loadMatches(true); loadLeaderboard(); }, 1000);
}

// Renders the "you already have bets on this match" receipt + rebuild button.
function renderPlacedBets(match, userBets) {
  const line = match.total_line ? +match.total_line : 2.5;
  const labelFor = (b) => {
    const t = (b.bet_type || 'moneyline').toLowerCase();
    if (t === 'total') return `Total Goals: ${b.selected_team === 'OVER' ? 'Over' : 'Under'} ${line}`;
    if (t === 'btts') return `Both Teams To Score: ${b.selected_team === 'YES' ? 'Yes' : 'No'}`;
    return `${isKnockout(match.stage) && b.selected_team !== 'DRAW' ? b.selected_team + ' to advance' : b.selected_team}`;
  };
  let totalStake = 0, totalReturn = 0;
  const rows = userBets.map(b => {
    const odds = b.odds_used ? parseFloat(b.odds_used) : null;
    const ret = odds ? Math.floor(b.points_used * odds) : b.points_used;
    totalStake += b.points_used; totalReturn += ret;
    return `<div class="placed-leg">
      <span class="placed-leg-pick">${labelFor(b)}</span>
      <span class="placed-leg-num">${b.points_used.toLocaleString()} @ ${odds ? odds.toFixed(2) + 'x' : '—'}</span>
      <span class="placed-leg-win">→ ${ret.toLocaleString()}</span>
    </div>`;
  }).join('');

  return `
  <div class="placed-bets">
    <div class="placed-title">✅ Your bets on this match (${userBets.length})</div>
    ${rows}
    <div class="placed-total"><span>Staked: <strong>${totalStake.toLocaleString()}</strong></span><span>If all win: <strong class="bb-rcpt-win">${totalReturn.toLocaleString()}</strong></span></div>
    <p class="placed-note">To change anything, cancel all bets on this match and rebuild. Your stake is fully refunded — but you'll rebuild at the current odds, so locking in early pays off.</p>
    <button class="cancel-btn" onclick="cancelBet(${match.id})">✕ Cancel all &amp; rebuild</button>
  </div>`;
}

let lastKnownPoints = null;
let lastKnownRank = null;
let predictedMatches = []; // module-level so confirmBet can update it immediately
let suppressNextPointsNotification = false;
let cachedMatches = [];    // cached match list for re-renders without re-fetching
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
  const pending = document.getElementById("pendingPage");
  if (pending) pending.classList.add("hidden");
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

let leaderboardPoints = []; // populated when leaderboard loads

function getRank(points) {
  points = Number(points);
  if (!leaderboardPoints.length) {
    // Fallback to points-based if no leaderboard data yet
    if (points >= 50000) return "Legend 👑";
    if (points >= 20000) return "Elite ⭐";
    if (points >= 10000) return "Pro 🔵";
    if (points >= 5000) return "Contender 🟢";
    if (points >= 2000) return "Amateur 🟡";
    return "Rookie ⚪";
  }

  const total = leaderboardPoints.length;
  // Find how many players this person beats (rank from bottom)
  const beatenBy = leaderboardPoints.filter(p => p > points).length;
  const percentile = (beatenBy / total) * 100; // % of players above you

  if (percentile < 5)   return "Legend 👑";
  if (percentile < 15)  return "Elite ⭐";
  if (percentile < 30)  return "Pro 🔵";
  if (percentile < 50)  return "Contender 🟢";
  if (percentile < 75)  return "Amateur 🟡";
  return "Rookie ⚪";
}

function updateDashboardUser(username, points) {
  // Updates name + points. Rank is set separately by loadLeaderboard() using
  // net worth (cash + staked) so it matches the leaderboard standing.
  const fmtPoints = Number(points).toLocaleString();

  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };

  if (username) {
    setEl("dashboardUsername", username);
    setEl("heroUsername", username);
  }
  setEl("dashboardPoints", fmtPoints);
  setEl("heroPoints", fmtPoints);

  // Set a provisional rank from current points as a fallback (refined by leaderboard)
  if (leaderboardPoints.length) {
    const rank = getRank(points);
    setEl("dashboardRank", rank);
    setEl("heroRank", rank);
    setEl("quickRank", rank);
  }
}

// Updates just the points number everywhere, no username needed
function setPointsDisplay(points) {
  // Updates only the points NUMBER, not the rank tier.
  // Rank is based on net worth (cash + staked), which doesn't change when betting —
  // money just moves from cash to stake. Rank refreshes when the leaderboard reloads.
  const fmtPoints = Number(points).toLocaleString();
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
  setEl("dashboardPoints", fmtPoints);
  setEl("heroPoints", fmtPoints);
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
  const firstName = document.getElementById("registerFirstName").value.trim();
  const lastName = document.getElementById("registerLastName").value.trim();
  if (!username || !password || !firstName || !lastName) {
    alert("Please fill all registration fields.");
    return;
  }

  // No spaces allowed in username or names
  if (/\s/.test(username)) {
    alert("Display name cannot contain spaces.");
    return;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) {
    alert("Display name can only contain letters, numbers, and . _ -");
    return;
  }
  if (/\s/.test(firstName) || /\s/.test(lastName)) {
    alert("First and last name cannot contain spaces.");
    return;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(firstName) || !/^[A-Za-z0-9_.-]+$/.test(lastName)) {
    alert("Names can only contain letters, numbers, and . _ -");
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
        firstName,
        lastName,
        deviceId: getDeviceId()
      })
    });

    const data = await res.json();

    if (res.ok) {
      document.getElementById("registerUsername").value = "";
      document.getElementById("registerPassword").value = "";
      document.getElementById("registerFirstName").value = "";
      document.getElementById("registerLastName").value = "";

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
    localStorage.setItem("currentUsername", data.username);
    sessionStorage.removeItem("resultsShownThisSession"); // allow results to show on fresh login

    lastKnownPoints = data.points;

    showDashboard();

    // Load leaderboard first so leaderboardPoints is populated before rank renders
    await loadLeaderboard();
    updateDashboardUser(data.username, data.points);
    lastKnownRank = getRank(data.points);

    loadProfileStats();
    hideAllDashboardSections();
    showRecentResults();

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
    const [res, houseRes] = await Promise.all([
      fetch(`${API}/leaderboard`),
      fetch(`${API}/house-total`)
    ]);
    const data = await res.json();
    const houseData = await houseRes.json();

    const box = document.getElementById("leaderboard");
    box.innerHTML = "";

    if (!data || data.length === 0) {
      box.innerHTML = "<p>No players yet.</p>";
      return;
    }

    // Pin house entry at top
    const houseTotal = houseData.houseTotal || 0;
    const houseSign = houseTotal >= 0 ? "+" : "";
    box.innerHTML += `
      <div class="leaderboard-item house-entry">
        <span class="leader-badge">🏦</span>
        <div class="leader-info">
          <strong>The AJA House</strong>
          <small>Always watching</small>
        </div>
        <div class="leader-points house-points">
          ${houseSign}${houseTotal.toLocaleString()}
          <span>pts</span>
        </div>
      </div>
    `;

    // Update percentile rank data
    leaderboardPoints = data.map(u => Number(u.points)).sort((a, b) => b - a);

    // Sync the logged-in user's dashboard rank to their NET WORTH (cash + staked)
    // so it matches what the leaderboard shows, not their cash-only rank.
    const myUsername = localStorage.getItem("currentUsername");
    if (myUsername) {
      const myEntry = data.find(u => u.username === myUsername);
      if (myEntry) {
        const myRank = getRank(Number(myEntry.points));
        const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
        setEl("dashboardRank", myRank);
        setEl("heroRank", myRank);
        setEl("quickRank", myRank);
        lastKnownRank = myRank;
      }
    }

    // Build current standings signature: username -> rank, plus a points fingerprint.
    // The rank-change arrows compare against a PERSISTENT snapshot saved in localStorage.
    // That snapshot only updates when the standings actually change (a match settled),
    // so arrows stay constant between matches instead of resetting on every refresh.
    const newRanks = {};
    data.forEach((user, index) => { newRanks[user.username] = index + 1; });

    // Fingerprint = each player's points. If this differs from last saved, standings moved.
    const currentFingerprint = data.map(u => `${u.username}:${u.points}`).join("|");
    const savedFingerprint = localStorage.getItem("leaderboardFingerprint") || "";

    // The baseline we compare against (the standings before the last settlement)
    let baselineRanks = {};
    try { baselineRanks = JSON.parse(localStorage.getItem("baselineRanks") || "{}"); } catch(e) { baselineRanks = {}; }

    if (currentFingerprint !== savedFingerprint) {
      // Standings changed since last snapshot — the OLD ranks become the new baseline.
      // On very first load (no saved fingerprint), seed baseline = current (no arrows yet).
      if (savedFingerprint === "") {
        baselineRanks = newRanks;
      } else {
        let oldRanks = {};
        try { oldRanks = JSON.parse(localStorage.getItem("lastRanks") || "{}"); } catch(e) { oldRanks = {}; }
        baselineRanks = oldRanks;
      }
      localStorage.setItem("baselineRanks", JSON.stringify(baselineRanks));
      localStorage.setItem("lastRanks", JSON.stringify(newRanks));
      localStorage.setItem("leaderboardFingerprint", currentFingerprint);
    }

    data.forEach((user, index) => {
      let badge = "⚽";
      if (index === 0) badge = "👑";
      if (index === 1) badge = "🥈";
      if (index === 2) badge = "🥉";

      const currentRank = index + 1;
      const prevRank = baselineRanks[user.username];
      let rankArrow = "";
      if (prevRank && prevRank !== currentRank) {
        if (prevRank > currentRank) {
          rankArrow = `<span style="color:#22c55e;font-size:0.75rem;margin-left:4px">▲${prevRank - currentRank}</span>`;
        } else {
          rankArrow = `<span style="color:#ef4444;font-size:0.75rem;margin-left:4px">▼${currentRank - prevRank}</span>`;
        }
      }

      box.innerHTML += `
        <div class="leaderboard-item rank-${currentRank}" onclick="showUserHistory('${user.username}')" style="cursor:pointer" title="View ${user.username}'s bet history">
          <span class="leader-badge">${badge}</span>

          <div class="leader-info">
            <strong>#${currentRank} ${user.username}</strong>${rankArrow}
            <small>${getRank(user.points)}${Number(user.staked_points) > 0 ? ` · ${Number(user.staked_points).toLocaleString()} in play` : ''}</small>
          </div>

          <div class="cash-badge-slot">${user.cash_eligible === 1 ? '<span class="cash-badge" title="Eligible for cash prizes">$</span>' : ''}</div>

          <div class="leader-points">
            ${Number(user.points).toLocaleString()}
            <span>pts</span>
          </div>
        </div>
      `;
    });

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

async function loadMatches(bustCache = false) {
  showSkeleton("matches", 3);
  try {
    const cacheBust = bustCache ? `?t=${Date.now()}` : '';

    // Always fetch fresh match list and predictions in parallel
    const token = localStorage.getItem("token");
    const fetches = [fetch(`${API}/matches${cacheBust}`)];
    if (token) fetches.push(fetch(`${API}/my-predicted-matches?t=${Date.now()}`, { headers: { "Authorization": token } }));

    const results = await Promise.all(fetches);
    const data = await results[0].json();
    if (results[1]) predictedMatches = await results[1].json();

    cachedMatches = data;

    renderMatchCards(data);

  } catch (error) {
    const box = document.getElementById("matches");
    if (box) box.innerHTML = "<p>Could not load matches. Please try again.</p>";
  }
}

function renderMatchCards(data) {
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

        // ALL of this user's bets on this match (moneyline + any sidebets)
        const userBets = predictedMatches.filter(
          prediction => prediction.match_id === match.id
        );
        const hasBets = userBets.length > 0;

        const timeText = matchTime.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "Asia/Dubai"
        });

        // A match is bettable once REAL odds exist for at least the match result.
        const isKO = isKnockout(match.stage);
        const oddsReady = isKO
          ? (match.odds_a && match.odds_b && parseFloat(match.odds_a) > 0 && parseFloat(match.odds_b) > 0)
          : (match.odds_a && match.odds_draw && match.odds_b
             && parseFloat(match.odds_a) > 0 && parseFloat(match.odds_draw) > 0 && parseFloat(match.odds_b) > 0);

        let actionHtml = "";

if (match.result) {

  // Settled — show the user's bets and the result.
  let predictionText = "";
  if (hasBets) {
    const line = match.total_line ? +match.total_line : 2.5;
    const lab = (b) => {
      const t = (b.bet_type || 'moneyline').toLowerCase();
      if (t === 'total') return `Total ${b.selected_team === 'OVER' ? 'Over' : 'Under'} ${line}`;
      if (t === 'btts') return `BTTS ${b.selected_team === 'YES' ? 'Yes' : 'No'}`;
      return b.selected_team;
    };
    predictionText = `Your bets: ${userBets.map(lab).join(', ')}<br>`;
  }
  actionHtml = `
    <p class="locked-text">
      ${predictionText}
      Result: ${match.result}
      <br>
      Match settled.
    </p>
  `;

} else if (hasBets && now >= openTime && now <= closeTime) {

  // Has bets and window still open → show placed-bets receipt + cancel/rebuild.
  actionHtml = `
  <div class="countdown-box">
    <span>Predictions close in:</span>
    <strong id="timer-${match.id}">${getCountdown(closeTime)}</strong>
  </div>
  <div class="prediction-box">
    ${renderPlacedBets(match, userBets)}
  </div>
  `;

} else if (hasBets) {

  // Has bets but window closed → locked, waiting for result.
  const line = match.total_line ? +match.total_line : 2.5;
  const lab = (b) => {
    const t = (b.bet_type || 'moneyline').toLowerCase();
    if (t === 'total') return `Total ${b.selected_team === 'OVER' ? 'Over' : 'Under'} ${line}`;
    if (t === 'btts') return `BTTS ${b.selected_team === 'YES' ? 'Yes' : 'No'}`;
    return b.selected_team;
  };
  actionHtml = `
    <p class="locked-text">
      ✅ ${userBets.length} bet${userBets.length > 1 ? 's' : ''} placed: <strong>${userBets.map(lab).join(', ')}</strong>
      <br><span style="font-size:0.8rem;opacity:0.7;">Waiting for result.</span>
    </p>
  `;

} else if (now >= openTime && now <= closeTime && !oddsReady) {

  // Match is open by time, but odds haven't been set yet — don't allow betting on placeholders
  actionHtml = `
  <div class="countdown-box">
    <span>Predictions close in:</span>
    <strong id="timer-${match.id}">${getCountdown(closeTime)}</strong>
  </div>
  <div class="odds-pending-box">
    <p>⏳ Odds not available yet</p>
    <small>Betting opens for this match once odds are set. Check back soon.</small>
  </div>
  `;

} else if (now >= openTime && now <= closeTime) {

  // Open, odds ready, no bets yet → the BET BUILDER.
  actionHtml = `
  <div class="countdown-box">
    <span>Predictions close in:</span>
    <strong id="timer-${match.id}">${getCountdown(closeTime)}</strong>
  </div>
  <div class="prediction-box">
    ${renderBetBuilder(match)}
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
}, 1000);
      });

      box.innerHTML += `
        <details class="date-dropdown" open>
          <summary>${date}</summary>

          <div class="date-matches">
            ${matchesHtml}
          </div>
        </details>
      `;
    });

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
      const matchDate = new Date(item.match_time).toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Dubai"
      });

      const isPending = !item.settled || !item.result;
      // Outcome comes from the server (correct per market: moneyline/total/btts).
      const isCorrect = item.settled && item.won === true;
      const isRefund = item.settled && item.won === null && item.result;
      const isWrong = item.settled && item.won === false;

      const odds = item.odds_used ? parseFloat(item.odds_used) : null;
      const payout = item.payout || 0;
      const profit = item.profit || 0;

      // Friendly pick + result labels for sidebets.
      const type = (item.bet_type || "moneyline").toLowerCase();
      const line = item.total_line ? parseFloat(item.total_line) : 2.5;
      let pickLabel = item.selected_team;
      if (type === "total") pickLabel = `Total ${item.selected_team === "OVER" ? "Over" : "Under"} ${line}`;
      else if (type === "btts") pickLabel = `BTTS ${item.selected_team === "YES" ? "Yes" : "No"}`;
      let resultText = item.result;
      if (type !== "moneyline" && item.result) {
        const m = item.settlement_message && item.settlement_message.match(/\((\d+)\s*-\s*(\d+)\)/);
        resultText = m ? `${m[1]}-${m[2]}` : item.result;
      }

      let statusColor = "#facc15";
      let statusText = "⏳ Pending";
      let payoutLine = "";

      if (isCorrect) {
        statusColor = "#22c55e";
        statusText = "✅ Correct";
        const oddsStr = odds ? ` @ ${odds.toFixed(2)}x` : "";
        payoutLine = `<p style="color:#22c55e;font-weight:bold;">Won ${payout.toLocaleString()} pts (+${profit.toLocaleString()} profit${oddsStr})</p>`;
      } else if (isRefund) {
        statusColor = "#facc15";
        statusText = "↩ Refunded";
        payoutLine = `<p style="color:#facc15;font-weight:bold;">Stake refunded: ${item.points_used.toLocaleString()} pts</p>`;
      } else if (isWrong) {
        statusColor = "#ef4444";
        statusText = "❌ Wrong";
        const oddsStr = odds ? ` @ ${odds.toFixed(2)}x` : "";
        payoutLine = `<p style="color:#ef4444;font-weight:bold;">Lost ${item.points_used.toLocaleString()} pts${oddsStr}</p>`;
      }

      box.innerHTML += `
        <div class="match-item">
          <h4>${item.team_a} vs ${item.team_b}</h4>
          <p style="font-size:0.82rem;color:#aaa;">${item.stage}${item.group_name ? " · " + item.group_name : ""} · ${matchDate}</p>
          <p>Pick: <strong>${pickLabel}</strong> · Staked: <strong>${item.points_used.toLocaleString()} pts</strong>${odds ? ` · Odds: <strong>${odds.toFixed(2)}x</strong>` : ""}</p>
          ${item.result ? `<p style="color:#aaa;font-size:0.82rem;">Result: ${resultText}</p>` : ""}
          ${payoutLine}
          <p style="color:${statusColor};font-weight:bold;">${statusText}</p>
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

      if (!suppressNextPointsNotification && lastKnownPoints !== null && data.points > lastKnownPoints) {
        showNotification(`+${data.points - lastKnownPoints} points added!`);
      }

      if (!suppressNextPointsNotification && lastKnownPoints !== null && data.points < lastKnownPoints) {
        showNotification(`${lastKnownPoints - data.points} points used.`);
      }
      suppressNextPointsNotification = false;

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
      await Promise.all([loadMatches(true), loadLeaderboard()]);

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
    await Promise.all([loadMatches(true), loadLeaderboard()]);

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
document.getElementById("quickWins").innerText = data.correct !== undefined ? data.correct : data.wins;
document.getElementById("quickSuccessRate").innerText = `${data.successRate}%`;

  const box = document.getElementById("profileStats");

  box.innerHTML = `
    <div class="dashboard-grid">
      <div class="dash-card">
        <h3>Total Predictions</h3>
        <p>${data.totalPredictions}</p>
      </div>

      <div class="dash-card">
        <h3>Correct Predictions</h3>
        <p>${data.correct}</p>
      </div>

      <div class="dash-card">
        <h3>Wrong Predictions</h3>
        <p>${data.losses}</p>
      </div>

      <div class="dash-card">
        <h3>Risk:Reward</h3>
        <p>${data.rrRatio !== null ? data.rrRatio + ':1' : '—'}</p>
      </div>

      <div class="dash-card">
        <h3>ROI</h3>
        <p style="color:${data.roi !== null ? (parseFloat(data.roi) >= 0 ? '#22c55e' : '#ef4444') : '#aaa'}">${data.roi !== null ? (parseFloat(data.roi) >= 0 ? '+' : '') + data.roi + '%' : '—'}</p>
      </div>

      <div class="dash-card">
        <h3>Pending</h3>
        <p>${data.pending}</p>
      </div>

      <div class="dash-card">
        <h3>Accuracy</h3>
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
    title.innerText = `${user.username}'s Bet History`;

    // Stats summary — use the server-computed outcome (correct per market type).
    let wins = 0, losses = 0, draws = 0, refunds = 0;
    let totalPotProfit = 0, totalStakeRR = 0;
    history.forEach(h => {
      if (h.won === true) {
        wins++;
        if (h.result === "DRAW") draws++;
      } else if (h.won === false) {
        losses++;
      } else {
        refunds++; // push/refund — counts as neither win nor loss
      }
      if (h.odds_used && parseFloat(h.odds_used) > 0) {
        totalPotProfit += (h.points_used * parseFloat(h.odds_used)) - h.points_used;
        totalStakeRR += h.points_used;
      }
    });
    const settled = wins + losses;
    const rate = settled > 0 ? Math.round((wins / settled) * 100) : 0;
    const rrRatio = totalStakeRR > 0 ? (totalPotProfit / totalStakeRR).toFixed(2) : null;

    // ROI from settled bets — use the actual payout the server computed.
    let totalReturned = 0, totalSettledStake = 0;
    history.forEach(h => {
      totalSettledStake += h.points_used;
      totalReturned += (h.payout || 0);
    });
    const roiVal = totalSettledStake > 0
      ? ((totalReturned - totalSettledStake) / totalSettledStake * 100).toFixed(1)
      : null;

    statBox.innerHTML = `
      <div class="user-history-summary">
        <span>✅ ${wins} correct</span>
        <span>❌ ${losses} wrong</span>
        <span>📊 R:R ${rrRatio ? rrRatio + ':1' : '—'}</span>
        <span style="color:${roiVal !== null ? (parseFloat(roiVal) >= 0 ? '#22c55e' : '#ef4444') : '#aaa'}">💹 ROI ${roiVal !== null ? (parseFloat(roiVal) >= 0 ? '+' : '') + roiVal + '%' : '—'}</span>
        <span>🎯 ${rate}% accuracy</span>
        <span>💰 ${Number(user.points).toLocaleString()} pts</span>
      </div>
    `;

    if (history.length === 0) {
      listBox.innerHTML = "<p>No settled bets yet.</p>";
      return;
    }

    listBox.innerHTML = history.map(item => {
      const isCorrect = item.won === true;
      const isRefund = item.won === null;
      const isDraw = item.result === "DRAW";

      const type = (item.bet_type || "moneyline").toLowerCase();
      const line = item.total_line ? parseFloat(item.total_line) : 2.5;
      let pickLabel = item.selected_team;
      if (type === "total") pickLabel = `Total ${item.selected_team === "OVER" ? "Over" : "Under"} ${line}`;
      else if (type === "btts") pickLabel = `BTTS ${item.selected_team === "YES" ? "Yes" : "No"}`;
      let resultText = item.result;
      if (type !== "moneyline" && item.result) {
        const m = item.settlement_message && item.settlement_message.match(/\((\d+)\s*-\s*(\d+)\)/);
        resultText = m ? `${m[1]}-${m[2]}` : item.result;
      }

      let color = "#ef4444";
      let label = "❌ Wrong";
      if (isCorrect) {
        color = "#22c55e";
        label = isDraw ? "✅ Correct (Draw)" : "✅ Correct";
      } else if (isRefund) {
        color = "#facc15";
        label = "↩ Refunded";
      }

      const odds = item.odds_used ? parseFloat(item.odds_used) : null;
      const payout = item.payout || 0;
      const profit = item.profit || 0;

      const matchDate = new Date(item.match_time).toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Dubai"
      });

      let outcomeLine;
      if (isCorrect) outcomeLine = `<p style="color:#22c55e;font-weight:bold;">Won ${payout.toLocaleString()} pts (+${profit.toLocaleString()} profit)</p>`;
      else if (isRefund) outcomeLine = `<p style="color:#facc15;font-weight:bold;">Refunded ${item.points_used.toLocaleString()} pts</p>`;
      else outcomeLine = `<p style="color:#ef4444;font-weight:bold;">Lost ${item.points_used.toLocaleString()} pts</p>`;

      return `
        <div class="match-item">
          <h4>${item.team_a} vs ${item.team_b}</h4>
          <p style="font-size:0.82rem;color:#aaa;">${item.stage}${item.group_name ? " · " + item.group_name : ""} · ${matchDate}</p>
          <p>Pick: <strong>${pickLabel}</strong> · ${item.points_used.toLocaleString()} pts${odds ? ` @ ${odds.toFixed(2)}x` : ""}</p>
          <p style="color:#aaa;font-size:0.82rem;">Result: ${resultText}</p>
          ${outcomeLine}
          <p style="color:${color};font-weight:bold;">${label}</p>
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

// activeBet is keyed by a slip key = matchId for moneyline, or matchId + ":" + betType
// for sidebets, so a user can have all three markets staged independently on one match.
function slipKey(matchId, betType) {
  return betType && betType !== "moneyline" ? matchId + ":" + betType : String(matchId);
}

function selectBet(matchId, pick, odds, betType) {
  betType = betType || "moneyline";
  const key = slipKey(matchId, betType);
  activeBet[key] = { pick, odds, betType, matchId };

  const slip = document.getElementById("bet-slip-" + key);
  if (slip) slip.classList.remove("hidden");

  const pointsInput = document.getElementById("points-" + key);
  const preview = document.getElementById("bet-preview-" + key);
  if (pointsInput && pointsInput.value && parseInt(pointsInput.value) > 0) {
    updateBetPreview(matchId, betType);
  } else if (preview) {
    preview.innerText = "Pick: " + pick + " @ " + odds + "x — enter points to see payout";
  }
}

function updateBetPreview(matchId, betType) {
  betType = betType || "moneyline";
  const key = slipKey(matchId, betType);
  const bet = activeBet[key];
  if (!bet) return;

  const pts = parseInt(document.getElementById("points-" + key).value) || 0;
  const payout = Math.floor(pts * bet.odds);
  const profit = payout - pts;

  const preview = document.getElementById("bet-preview-" + key);
  if (!preview) return;
  if (pts <= 0) {
    preview.innerText = "Pick: " + bet.pick + " @ " + bet.odds + "x";
  } else {
    preview.innerText = "Pick: " + bet.pick + " @ " + bet.odds + "x — Bet " + pts.toLocaleString() + " pts → Win " + payout.toLocaleString() + " pts (+" + profit.toLocaleString() + " profit)";
  }
}

async function confirmBet(matchId, isUpdate = false, betType = "moneyline") {
  const token = localStorage.getItem("token");
  const key = slipKey(matchId, betType);
  const bet = activeBet[key];
  if (!bet) { alert("Make a selection first."); return; }

  const pts = parseInt(document.getElementById("points-" + key).value);
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

  showLoadingOverlay(isUpdate ? "Updating bet..." : "Placing bet...");

  const endpoint = isUpdate ? `${API}/update-predict` : `${API}/predict`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token },
    body: JSON.stringify({ matchId, selectedTeam: bet.pick, pointsUsed: pts, oddsUsed: bet.odds, betType: bet.betType })
  });

  const data = await res.json();
  hideLoadingOverlay();
  if (res.ok) {
    playSound("predictSound");
    const betMsg = isUpdate ? "Bet updated!" : "Bet placed!";
    showNotification(betMsg + " " + bet.pick + " @ " + bet.odds + "x for " + pts.toLocaleString() + " pts");

    // Clear bet slip state immediately
    const slip = document.getElementById("bet-slip-" + key);
    if (slip) slip.classList.add("hidden");
    const input = document.getElementById("points-" + key);
    if (input) input.value = "";
    delete activeBet[key];

    // ── OPTIMISTIC UI UPDATE (moneyline only) ──────────────────────────────
    // predictedMatches is keyed by match_id, which only models one bet per match
    // (the moneyline). For sidebets we instead just deduct points and refresh
    // from the server, so the multiple-bets-per-match state stays correct.
    if (bet.betType === "moneyline") {
      // 1. Capture old stake BEFORE overwriting predictedMatches
      const existingIdx = predictedMatches.findIndex(p => p.match_id === matchId);
      const oldStake = (isUpdate && existingIdx >= 0) ? predictedMatches[existingIdx].points_used : 0;

      // 2. Update points display immediately using the captured old stake
      if (lastKnownPoints !== null) {
        const newPoints = lastKnownPoints + oldStake - pts;
        lastKnownPoints = Math.max(0, newPoints);
        setPointsDisplay(lastKnownPoints);
      }

      // 3. Now update predictedMatches in memory so re-render shows the new bet
      const newPrediction = { match_id: matchId, selected_team: bet.pick, points_used: pts, odds_used: bet.odds, created_at: new Date().toISOString() };
      if (existingIdx >= 0) predictedMatches[existingIdx] = newPrediction;
      else predictedMatches.push(newPrediction);

      // 4. Re-render match cards from cached data + updated predictedMatches (no fetch)
      renderMatchCards(cachedMatches);

      // 5. Sync leaderboard immediately, delay points sync so DB write can commit first
      loadLeaderboard();
      suppressNextPointsNotification = true;
      setTimeout(refreshUserData, 1500);
    } else {
      // Sidebet: deduct stake from display, then refresh authoritative state.
      if (lastKnownPoints !== null) {
        lastKnownPoints = Math.max(0, lastKnownPoints - pts);
        setPointsDisplay(lastKnownPoints);
      }
      loadLeaderboard();
      suppressNextPointsNotification = true;
      setTimeout(() => { refreshUserData(); loadMatches(); }, 1200);
    }

  } else {
    alert(data.message || "Bet failed.");
  }
}


async function adjustOdds(matchId, pick, newOdds, stake) {
  const token = localStorage.getItem("token");
  const newPayout = Math.floor(stake * newOdds);
  if (!confirm(`Move your ${stake.toLocaleString()} pts to ${newOdds.toFixed(2)}x odds?\n\nNew payout if correct: ${newPayout.toLocaleString()} pts`)) return;

  const res = await fetch(`${API}/update-predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token },
    body: JSON.stringify({ matchId, selectedTeam: pick, pointsUsed: stake, oddsUsed: newOdds })
  });

  const data = await res.json();
  if (res.ok) {
    showNotification("Odds updated to " + newOdds.toFixed(2) + "x");
    // Optimistic: odds changed but stake stays same, so no balance change
    const adjIdx = predictedMatches.findIndex(p => p.match_id === matchId);
    if (adjIdx >= 0) predictedMatches[adjIdx].odds_used = newOdds;
    renderMatchCards(cachedMatches);
    loadLeaderboard();
    setTimeout(refreshUserData, 1500);
  } else {
    alert(data.message || "Could not adjust odds.");
  }
}

async function cancelBet(matchId) {
  const token = localStorage.getItem("token");
  // Count this user's bets on the match so the prompt is honest about "all".
  const myLegs = predictedMatches.filter(p => p.match_id === matchId);
  const legWord = myLegs.length > 1 ? `all ${myLegs.length} bets` : "your bet";
  if (!confirm(`Cancel ${legWord} on this match and get your points back?\n\nYou can then rebuild — but at the current odds.`)) return;

  showLoadingOverlay("Cancelling bets...");

  const res = await fetch(`${API}/cancel-predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token },
    body: JSON.stringify({ matchId })
  });

  const data = await res.json();
  hideLoadingOverlay();
  if (res.ok) {
    // Optimistic: refund the FULL total of all legs on this match, and drop them
    // all from memory. Prefer the server's authoritative refunded amount.
    const localTotal = myLegs.reduce((s, p) => s + p.points_used, 0);
    const refund = (typeof data.refunded === "number") ? data.refunded : localTotal;
    if (lastKnownPoints !== null && refund > 0) {
      lastKnownPoints = lastKnownPoints + refund;
      setPointsDisplay(lastKnownPoints);
    }
    // Remove every leg for this match from the in-memory list.
    for (let i = predictedMatches.length - 1; i >= 0; i--) {
      if (predictedMatches[i].match_id === matchId) predictedMatches.splice(i, 1);
    }
    const n = (typeof data.count === "number") ? data.count : myLegs.length;
    showNotification(`Cancelled ${n} bet${n > 1 ? "s" : ""} — ${refund.toLocaleString()} pts refunded!`);
    renderMatchCards(cachedMatches);
    loadLeaderboard();
    suppressNextPointsNotification = true;
    setTimeout(refreshUserData, 1500);
  } else {
    alert(data.message || "Could not cancel bets.");
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

    // Human label for a bet leg, e.g. "Brazil to advance", "Total Over 2.5", "BTTS Yes".
    const legLabel = (b, isKO, line) => {
      const t = (b.bet_type || "moneyline").toLowerCase();
      if (t === "total") return `Total Goals: ${b.selected_team === "OVER" ? "Over" : "Under"} ${line}`;
      if (t === "btts") return `Both Teams To Score: ${b.selected_team === "YES" ? "Yes" : "No"}`;
      if (b.selected_team === "DRAW") return "Draw";
      return isKO ? `${b.selected_team} to advance` : b.selected_team;
    };
    // moneyline first, then total, then btts
    const typeOrder = t => ({ moneyline: 0, total: 1, btts: 2 }[(t || "moneyline").toLowerCase()] ?? 9);

    // Two-level group: match → player → that player's legs.
    const matches = {};
    data.forEach(b => {
      const mKey = b.match_id;
      if (!matches[mKey]) matches[mKey] = {
        team_a: b.team_a, team_b: b.team_b, match_time: b.match_time,
        stage: b.stage, group_name: b.group_name, total_line: b.total_line,
        players: {}
      };
      const p = matches[mKey].players;
      if (!p[b.username]) p[b.username] = [];
      p[b.username].push(b);
    });

    box.innerHTML = Object.values(matches).map(g => {
      const isKO = isKnockout(g.stage);
      const line = g.total_line ? +g.total_line : 2.5;
      const matchDate = new Date(g.match_time).toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
        timeZone: "Asia/Dubai", hour12: false
      });

      // Build each player's block: their main bet, then sidebets indented under it.
      const playerBlocks = Object.keys(g.players).map(username => {
        const legs = g.players[username].slice().sort((a, b) => typeOrder(a.bet_type) - typeOrder(b.bet_type));
        const playerStake = legs.reduce((s, b) => s + b.points_used, 0);

        const legRows = legs.map(b => {
          const t = (b.bet_type || "moneyline").toLowerCase();
          const isSide = t !== "moneyline";
          const odds = b.odds_used ? parseFloat(b.odds_used).toFixed(2) + "x" : "—";
          const payout = b.odds_used ? Math.floor(b.points_used * b.odds_used) : 0;
          const profit = payout - b.points_used;
          return `<div class="abet-leg ${isSide ? "abet-leg-side" : "abet-leg-main"}">
            <span class="abet-leg-pick">${isSide ? "↳ " : ""}${legLabel(b, isKO, line)}</span>
            <span class="abet-leg-stake">${b.points_used.toLocaleString()} @ ${odds}</span>
            <span class="abet-leg-win">→ ${b.odds_used ? payout.toLocaleString() : "—"}${b.odds_used ? `<span class="abet-profit"> (+${profit.toLocaleString()})</span>` : ""}</span>
          </div>`;
        }).join("");

        return `<div class="abet-player-block">
          <div class="abet-player-head"><strong>${username}</strong>
            <span class="abet-player-meta">${legs.length} bet${legs.length > 1 ? "s" : ""} · ${playerStake.toLocaleString()} pts</span>
          </div>
          ${legRows}
        </div>`;
      }).join("");

      const totalStake = Object.values(g.players).flat().reduce((s, b) => s + b.points_used, 0);
      const betCount = Object.values(g.players).flat().length;

      return `
        <div class="match-item">
          <h4>${g.team_a} vs ${g.team_b}</h4>
          <p>${g.stage}${g.group_name ? " · " + g.group_name : ""} · ${matchDate} UAE</p>
          <p style="color:#ffd600;font-size:0.85rem;">Total staked: ${totalStake.toLocaleString()} pts · ${betCount} bet${betCount > 1 ? "s" : ""}</p>
          <div class="abet-players">${playerBlocks}</div>
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
    if (data.is_admin === 1) {
      document.getElementById("adminButton") && 
        document.getElementById("adminButton").classList.remove("hidden");
    }

    showDashboard();
    // Load leaderboard first so percentile ranks are accurate
    await loadLeaderboard();
    updateDashboardUser(data.username, data.points);
    loadProfileStats();
    refreshUserData();
    showRecentResults();

  } catch (err) {
    showLogin();
  }
});


// ─── LOADING OVERLAY ─────────────────────────────────────────────────────────
function showLoadingOverlay(text) {
  let overlay = document.getElementById("loadingOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "loadingOverlay";
    overlay.innerHTML = `
      <div class="loading-spinner"></div>
      <p id="loadingText">${text || "Loading..."}</p>
    `;
    document.body.appendChild(overlay);
  } else {
    document.getElementById("loadingText").innerText = text || "Loading...";
    overlay.style.display = "flex";
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById("loadingOverlay");
  if (overlay) overlay.style.display = "none";
}


// ─── LOGIN RESULTS SUMMARY ───────────────────────────────────────────────────
async function showRecentResults() {
  const token = localStorage.getItem("token");
  if (!token) return;

  // Don't show again if already shown in this browser session (prevents refresh re-trigger)
  if (sessionStorage.getItem("resultsShownThisSession")) return;

  // Load already-seen match IDs
  const seenRaw = localStorage.getItem("seenResultIds") || "[]";
  let seenIds = [];
  try { seenIds = JSON.parse(seenRaw).filter(id => typeof id === "number" && id > 0); } catch(e) { seenIds = []; }

  const seenParam = seenIds.length > 0 ? `?seen=${seenIds.join(",")}` : "";

  try {
    const res = await fetch(`${API}/my-recent-results${seenParam}`, {
      headers: { "Authorization": token }
    });
    const results = await res.json();
    if (!results || results.length === 0) {
      sessionStorage.setItem("resultsShownThisSession", "1");
      return;
    }

    // Mark as shown for this session
    sessionStorage.setItem("resultsShownThisSession", "1");

    // Save match IDs immediately — use both matchId and match_id defensively
    const newMatchIds = results.map(r => r.matchId || r.match_id).filter(id => id && id > 0);
    if (newMatchIds.length > 0) {
      const newIds = [...new Set([...seenIds, ...newMatchIds])];
      localStorage.setItem("seenResultIds", JSON.stringify(newIds));
    }

    const totalProfit = results.reduce((s, r) => s + r.profit, 0);
    const wins = results.filter(r => r.won).length;
    const totalStaked = results.reduce((s, r) => s + r.stake, 0);
    const currentBalance = lastKnownPoints;
    const netColor = totalProfit >= 0 ? "#22c55e" : "#ef4444";
    const netSign = totalProfit >= 0 ? "+" : "";

    let betsHtml = "";
    results.forEach(r => {
      const isRefund = r.refunded === true;
      const state = isRefund ? "refund" : (r.won ? "won" : "lost");
      const amountStr = isRefund
        ? `${r.stake.toLocaleString()} pts back`
        : (r.won ? `+${r.payout.toLocaleString()} pts` : `${r.profit.toLocaleString()} pts`);
      const badgeClass = isRefund ? "badge-lost" : (r.won ? "badge-won" : "badge-lost");
      const badgeText = isRefund ? "↩ REFUND" : (r.won ? "✅ WON" : "❌ LOST");
      const amtClass = isRefund ? "" : (r.won ? "amount-won" : "amount-lost");
      const itemClass = isRefund ? "" : (r.won ? "won" : "lost");
      const oddsStr = r.odds ? ` @ ${parseFloat(r.odds).toFixed(2)}x` : "";
      betsHtml += `
        <div class="result-item ${itemClass}">
          <div class="result-match-row">
            <span class="result-match-name">${r.match}</span>
            <span class="result-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div class="result-detail">
            <span>Picked <strong>${r.pick}</strong>${oddsStr} · Result: <strong>${r.result}</strong></span>
            <span class="result-amount ${amtClass}">${amountStr}</span>
          </div>
          <div class="result-stake">Stake: ${r.stake.toLocaleString()} pts</div>
        </div>
      `;
    });

    const html = `
      <div class="results-modal-overlay" id="resultsModal">
        <div class="results-modal">
          <div class="results-header">
            <h2>👋 Welcome back!</h2>
            <p class="results-subtitle">${results.length} bet${results.length > 1 ? "s" : ""} settled while you were away</p>
          </div>
          <div class="results-net-bar" style="border-color:${netColor};background:${totalProfit >= 0 ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)"};">
            <div class="results-net-row">
              <span style="color:#aaa;">Net result</span>
              <span style="color:${netColor};font-size:1.3rem;font-weight:900;">${netSign}${totalProfit.toLocaleString()} pts</span>
            </div>
            <div class="results-net-row" style="font-size:0.82rem;margin-top:4px;">
              <span style="color:#aaa;">${wins}/${results.length} correct · ${totalStaked.toLocaleString()} staked</span>
              ${currentBalance ? `<span style="color:#ffd600;">Balance: ${currentBalance.toLocaleString()} pts</span>` : ""}
            </div>
          </div>
          <div class="results-list">${betsHtml}</div>
          <button class="confirm-btn" onclick="closeResultsModal()">Got it!</button>
        </div>
      </div>
    `;

    const div = document.createElement("div");
    div.innerHTML = html.trim();
    document.body.appendChild(div.firstElementChild);

  } catch (err) {
    console.log("Could not load recent results", err);
  }
}

function closeResultsModal() {
  const modal = document.getElementById("resultsModal");
  if (modal) modal.remove();
}
