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
    box.innerHTML += `
      <div class="match-item">
        <h4>${user.username}</h4>
        <p style="color:#ffd600;font-size:0.85rem;">Real name: ${user.first_name || ""} ${user.last_name || ""}${(!user.first_name && !user.last_name) ? (user.full_name || "—") : ""}</p>

        <p>Points: ${user.points}</p>
        <p>Status: ${user.is_active === 1 ? "Active" : "Disabled"}</p>
        <p>Admin: ${user.is_admin === 1 ? "Yes" : "No"}</p>
        <p>Cash prize eligible: ${user.cash_eligible === 1 ? '<span style="color:#22c55e;font-weight:bold;">✓ Yes</span>' : '<span style="color:#888;">No</span>'}</p>

        <input
          type="number"
          id="points-${user.id}"
          placeholder="Add/remove points e.g. 500 or -500"
        >

        <button onclick="updateUserPoints(${user.id})">
          Update Points
        </button>

        <button onclick="toggleUser(${user.id})">
          ${user.is_active === 1 ? "Disable User" : "Activate User"}
        </button>

        <button onclick="toggleCashEligible(${user.id})" style="background:${user.cash_eligible === 1 ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.05)'};border:1px solid rgba(34,197,94,0.4);color:#22c55e;">
          ${user.cash_eligible === 1 ? "Remove $ Prize Flag" : "Mark $ Prize Eligible"}
        </button>

        <button onclick="deleteUser(${user.id})">
  Delete User
</button>
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
    box.innerHTML += `
      <div class="match-item">

        <h3>${match.team_a} vs ${match.team_b}</h3>

        <p>
          Stage: ${match.stage}
          ${match.group_name ? " - " + match.group_name : ""}
        </p>

        <p>Time: ${match.match_time}</p>
        <p>Status: ${match.status}</p>
        <p>Result: ${match.result || "Not set"}</p>

        <button onclick="setResult(${match.id}, '${match.team_a}')">
          ${match.team_a} ${adminIsKnockout(match.stage) ? "Advanced" : "Won"}
        </button>

        <button onclick="setResult(${match.id}, '${match.team_b}')">
          ${match.team_b} ${adminIsKnockout(match.stage) ? "Advanced" : "Won"}
        </button>

        ${adminIsKnockout(match.stage) ? "" : `<button onclick="setResult(${match.id}, 'DRAW')">
          Draw
        </button>`}

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


async function importUsers() {
  const token = localStorage.getItem("token");
  const raw = document.getElementById("importJson").value.trim();
  const resultEl = document.getElementById("importResult");

  if (!raw) {
    resultEl.innerText = "Paste JSON data first.";
    return;
  }

  let users;
  try {
    users = JSON.parse(raw);
    if (!Array.isArray(users)) throw new Error("Must be an array");
  } catch (e) {
    resultEl.innerText = "Invalid JSON. Must be an array of user objects.";
    return;
  }

  const confirmed = confirm(`Import ${users.length} users? Existing users will have their points updated.`);
  if (!confirmed) return;

  resultEl.innerText = "Importing...";

  const res = await fetch(`${API}/admin/import-users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": token
    },
    body: JSON.stringify({ users })
  });

  const data = await res.json();

  if (res.ok) {
    resultEl.innerText = `Done. ${data.imported} new users added, ${data.updated} updated, ${data.failed} failed.`;
    document.getElementById("importJson").value = "";
    loadAdminUsers();
  } else {
    resultEl.innerText = data.message || "Import failed.";
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

  box.innerHTML = pending.map(u => `
    <div class="match-item" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <div>
        <strong>${u.username}</strong>
        <p style="margin:2px 0;font-size:0.85rem;color:#aaa;">${u.first_name || ""} ${u.last_name || ""}${(!u.first_name && !u.last_name) ? (u.full_name || '—') : ""}</p>
      </div>
      <button onclick="approveUser(${u.id})" style="background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.4);color:#22c55e;padding:6px 16px;border-radius:8px;cursor:pointer;">
        ✓ Approve
      </button>
    </div>
  `).join('');
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
