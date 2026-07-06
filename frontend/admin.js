const API = "/api";

// Knockout stages use a two-way "advance" result (no Draw button).
function adminIsKnockout(stage) {
  if (!stage) return false;
  const s = stage.toLowerCase();
  return s.includes("round of 32") || s.includes("round of 16") ||
         s.includes("quarter") || s.includes("semi") ||
         s.includes("final") || s.includes("third place") ||
         s.includes("3rd place") || s.includes("knockout");
}

function goHome() {
  window.location.href = "/";
}

function checkAdminAccess() {
  const token = localStorage.getItem("token");
  const isAdmin = localStorage.getItem("isAdmin");

  if (!token || isAdmin !== "true") {
    alert("Access denied. Admin only.");
    window.location.href = "/";
    return false;
  }

  return true;
}

async function verifyAdminWithServer() {
  const token = localStorage.getItem("token");

  const res = await fetch(`${API}/me`, {
    headers: {
      "Authorization": token
    }
  });

  const data = await res.json();

  if (!data || data.is_admin !== 1) {
    alert("Access denied. Admin only.");
    window.location.href = "/";
    return false;
  }

  return true;
}

async function loadAdminUsers() {
  const token = localStorage.getItem("token");

  const res = await fetch(`${API}/admin/users`, {
    headers: {
      "Authorization": token
    }
  });

  const allData = await res.json();

  const box = document.getElementById("adminUsers");

  box.innerHTML = "";

  if (!allData || allData.length === 0) {
    box.innerHTML = "<p>No users found.</p>";
    return;
  }

  // Exclude pending (inactive non-admin) accounts — they show in the Pending Approvals section
  const data = allData.filter(u => !(u.is_active === 0 && u.is_admin !== 1));

  if (data.length === 0) {
    box.innerHTML = "<p>No active users.</p>";
    return;
  }

  data.forEach(user => {
    const realName = (user.first_name || user.last_name)
      ? `${user.first_name || ""} ${user.last_name || ""}`.trim()
      : (user.full_name || "—");
    const cashOn = user.cash_eligible === 1;
    const active = user.is_active === 1;
    box.innerHTML += `
      <div class="admin-list-row">
        <div class="admin-row-head">
          <div class="admin-row-title">
            <strong>${user.username}</strong>
            ${user.is_admin === 1 ? '<span class="admin-tag tag-admin">ADMIN</span>' : ''}
            ${cashOn ? '<span class="admin-tag tag-cash">$ ELIGIBLE</span>' : ''}
            ${!active ? '<span class="admin-tag tag-disabled">DISABLED</span>' : ''}
          </div>
          <div class="admin-row-points mono">${Number(user.points).toLocaleString()}</div>
        </div>
        <div class="admin-row-meta">${realName}</div>

        <div class="admin-row-actions">
          <input type="number" id="points-${user.id}" placeholder="+500 or -500" class="admin-inline-input">
          <button class="btn-primary btn-sm" onclick="updateUserPoints(${user.id})">Adjust</button>
          <button class="btn-ghost btn-sm" onclick="toggleUser(${user.id})">${active ? "Disable" : "Activate"}</button>
          <button class="btn-ghost btn-sm" onclick="toggleCashEligible(${user.id})">${cashOn ? "Remove $" : "Mark $"}</button>
          <button class="btn-danger btn-sm" onclick="deleteUser(${user.id})">Delete</button>
        </div>
      </div>
    `;
  });
}
async function toggleCashEligible(userId) {
  const token = localStorage.getItem("token");
  const res = await fetch(`${API}/admin/toggle-cash-eligible`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token },
    body: JSON.stringify({ userId })
  });
  const data = await res.json();
  alert(data.message);
  loadAdminUsers();
}

async function deleteUser(userId) {
  const token = localStorage.getItem("token");

  const confirmDelete = confirm(
    "Are you sure you want to delete this user permanently? This cannot be undone."
  );

  if (!confirmDelete) return;

  const res = await fetch(`${API}/admin/delete-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": token
    },
    body: JSON.stringify({
      userId
    })
  });

  const data = await res.json();

  alert(data.message);

  if (res.ok) {
    await loadAdminUsers();
  }
}


async function updateUserPoints(userId) {
  const token = localStorage.getItem("token");

  const input = document.getElementById(`points-${userId}`);
  const amount = Number(input.value);

  if (!amount) {
    alert("Enter points amount first.");
    return;
  }

  const confirmUpdate = confirm(
    `Are you sure you want to update this user by ${amount} points?`
  );

  if (!confirmUpdate) return;

  const res = await fetch(`${API}/admin/user-points`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": token
    },
    body: JSON.stringify({
      userId,
      amount
    })
  });

  const data = await res.json();

  alert(data.message);

  loadAdminUsers();
}

async function toggleUser(userId) {
  const token = localStorage.getItem("token");

  const confirmToggle = confirm("Are you sure you want to change this user's status?");

  if (!confirmToggle) return;

  const res = await fetch(`${API}/admin/toggle-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": token
    },
    body: JSON.stringify({
      userId
    })
  });

  const data = await res.json();

  alert(data.message);

  loadAdminUsers();
}

async function loadAdminMatches() {
  const token = localStorage.getItem("token");

  const res = await fetch(`${API}/matches`);
  const data = await res.json();

  const box = document.getElementById("adminMatches");

  box.innerHTML = "";

  if (!data || data.length === 0) {
    box.innerHTML = "<p>No matches found.</p>";
    return;
  }

  data.forEach(match => {
    const isKO = adminIsKnockout(match.stage);
    const settled = !!match.result;
    box.innerHTML += `
      <div class="admin-list-row ${settled ? 'row-settled' : ''}">
        <div class="admin-row-head">
          <div class="admin-row-title">
            <strong>${match.team_a} · ${match.team_b}</strong>
            ${settled ? `<span class="admin-tag tag-settled">${match.result}</span>` : ''}
          </div>
          <div class="admin-row-meta mono">${match.match_time}</div>
        </div>
        <div class="admin-row-meta">${match.stage}${match.group_name ? " · " + match.group_name : ""} · <span class="mono">${match.status}</span></div>

        <div class="admin-row-actions">
          <button class="btn-primary btn-sm" onclick="setResult(${match.id}, '${match.team_a}')">${match.team_a} ${isKO ? "advances" : "wins"}</button>
          ${isKO ? "" : `<button class="btn-ghost btn-sm" onclick="setResult(${match.id}, 'DRAW')">Draw</button>`}
          <button class="btn-primary btn-sm" onclick="setResult(${match.id}, '${match.team_b}')">${match.team_b} ${isKO ? "advances" : "wins"}</button>
        </div>
      </div>
    `;
  });
}

async function setResult(matchId, result) {
  const token = localStorage.getItem("token");

  const confirmResult = confirm(
    `Set result as ${result}? This will settle all predictions for this match.`
  );

  if (!confirmResult) return;

  const res = await fetch(`${API}/admin/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": token
    },
    body: JSON.stringify({
      matchId,
      result
    })
  });

  const data = await res.json();

  alert(data.message);

  loadAdminMatches();
}

async function addNewMatch() {
  const token = localStorage.getItem("token");

  const teamA = document.getElementById("newTeamA").value.trim();
  const teamB = document.getElementById("newTeamB").value.trim();
  const stage = document.getElementById("newStage").value.trim();
  const venue = document.getElementById("newVenue").value.trim();
  const matchTime = document.getElementById("newMatchTime").value;

  if (!teamA || !teamB || !matchTime) {
    alert("Please enter Team A, Team B and match time.");
    return;
  }

  const confirmAdd = confirm(
    `Add match: ${teamA} vs ${teamB}?`
  );

  if (!confirmAdd) return;

  const res = await fetch(`${API}/admin/add-match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": token
    },
    body: JSON.stringify({
      teamA,
      teamB,
      stage,
      venue,
      matchTime
    })
  });

  const data = await res.json();

  alert(data.message);

  if (res.ok) {
    document.getElementById("newTeamA").value = "";
    document.getElementById("newTeamB").value = "";
    document.getElementById("newStage").value = "";
    document.getElementById("newVenue").value = "";
    document.getElementById("newMatchTime").value = "";

    loadAdminMatches();
  }
}

async function initAdmin() {
  if (!checkAdminAccess()) return;

  const ok = await verifyAdminWithServer();

  if (!ok) return;

  loadAdminUsers();
  loadAdminMatches();
}

initAdmin();

async function addUserWithPoints() {
  const token = localStorage.getItem("token");

  const username = document.getElementById("newUserUsername").value.trim();
  const password = document.getElementById("newUserPassword").value.trim();
  const fullName = document.getElementById("newUserFullName").value.trim();
  const country = document.getElementById("newUserCountry").value.trim();
  const startingPoints = document.getElementById("newUserPoints").value.trim();
  const cashEligible = document.getElementById("newUserCashEligible").checked;

  if (!username || !password || !fullName || !country) {
    alert("Please fill all fields.");
    return;
  }

  const confirmAdd = confirm(`Add user "${username}" with ${startingPoints || 5000} points?`);
  if (!confirmAdd) return;

  const res = await fetch(`${API}/admin/add-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": token
    },
    body: JSON.stringify({ username, password, fullName, country, startingPoints, cashEligible })
  });

  const data = await res.json();
  alert(data.message);

  if (res.ok) {
    const cb = document.getElementById("newUserCashEligible");
    if (cb) cb.checked = false;
    document.getElementById("newUserUsername").value = "";
    document.getElementById("newUserPassword").value = "";
    document.getElementById("newUserFullName").value = "";
    document.getElementById("newUserCountry").value = "";
    document.getElementById("newUserPoints").value = "";
    loadAdminUsers();
  }
}


async function loadPendingUsers() {
  const token = localStorage.getItem("token");
  const res = await fetch(`${API}/admin/users`, {
    headers: { "Authorization": token }
  });
  const users = await res.json();
  const pending = users.filter(u => u.is_active === 0 && u.is_admin !== 1);
  const box = document.getElementById("pendingUsers");

  if (!pending || pending.length === 0) {
    box.innerHTML = "<p>No pending accounts.</p>";
    return;
  }

  box.innerHTML = pending.map(u => {
    const realName = (u.first_name || u.last_name)
      ? `${u.first_name || ""} ${u.last_name || ""}`.trim()
      : (u.full_name || "—");
    return `
      <div class="admin-list-row">
        <div class="admin-row-head">
          <div class="admin-row-title"><strong>${u.username}</strong></div>
        </div>
        <div class="admin-row-meta">${realName}</div>
        <div class="admin-row-actions">
          <button class="btn-primary btn-sm" onclick="approveUser(${u.id})">Approve</button>
        </div>
      </div>
    `;
  }).join('');
}

async function approveUser(userId) {
  const token = localStorage.getItem("token");
  const res = await fetch(`${API}/admin/toggle-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token },
    body: JSON.stringify({ userId })
  });
  const data = await res.json();
  alert(data.message);
  loadPendingUsers();
  loadAdminUsers();
}

// Load pending users once DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", loadPendingUsers);
} else {
  loadPendingUsers();
}
