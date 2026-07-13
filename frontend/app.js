
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

// ── Animation helpers (anime.js) ──────────────────────────────────────────────
// All wrapped so the app never breaks if the CDN is blocked — if `anime` isn't
// loaded, these fall back to instant/no-op behaviour.
// ALSO respect prefers-reduced-motion (Emil/A11y): if the user has opted out
// of motion, all animation helpers no-op — they still update final state, they
// just skip the animation itself.
const hasAnime = () => typeof anime === "function";
const prefersReducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const canAnimate = () => hasAnime() && !prefersReducedMotion();

// Count a number element up/down to a new value (used for balance changes).
function animateNumber(el, from, to, opts = {}) {
  if (!el) return;
  const fmt = opts.format || ((n) => Math.round(n).toLocaleString());
  if (!canAnimate()) { el.textContent = fmt(to); return; }
  const state = { v: from };
  anime({
    targets: state,
    v: to,
    round: 1,
    duration: opts.duration || 700,
    easing: opts.easing || "easeOutCubic",
    update: () => { el.textContent = fmt(state.v); },
  });
}

// Pop an element in (scale + fade) — used for reveals like win badges.
function animatePop(el, opts = {}) {
  if (!el || !canAnimate()) return;
  anime({
    targets: el,
    scale: [opts.from || 0.6, 1],
    opacity: [0, 1],
    duration: opts.duration || 420,
    easing: opts.easing || "easeOutBack",
  });
}

// Stagger a list of children into view (used for leaderboard / lists).
function animateStagger(els, opts = {}) {
  if (!els || !els.length || !canAnimate()) return;
  anime({
    targets: els,
    translateY: [opts.dy != null ? opts.dy : 12, 0],
    opacity: [0, 1],
    delay: anime.stagger(opts.stagger || 40),
    duration: opts.duration || 420,
    easing: "easeOutCubic",
  });
}

// Fade + slide a section IN when it's revealed. Sections use position:relative
// (no centering transform), so animating transform here is safe.
// Emil rule: no motion on frequent actions — animate only the FIRST time this
// section is revealed per page-load; snap on all subsequent tab switches.
function animateSectionIn(el) {
  if (!el || !canAnimate()) return;
  if (!window._sectionSeen) window._sectionSeen = {};
  if (window._sectionSeen[el.id]) return;   // already seen; snap
  window._sectionSeen[el.id] = true;
  anime.remove(el);
  anime({
    targets: el,
    translateY: [8, 0],
    opacity: [0, 1],
    duration: 280,
    easing: "cubicBezier(.16,1,.3,1)",
  });
}

// Bet-placed confirmation moment: a green checkmark pops in over the builder,
// holds briefly, then fades. Non-blocking — the rest of the flow keeps running.
function animateBetPlacedConfirm(matchId, count) {
  if (!canAnimate()) return;
  const anchor = document.getElementById(`bet-builder-${matchId}`) ||
                 document.getElementById(`match-${matchId}`) || document.body;
  const rect = anchor.getBoundingClientRect();
  const overlay = document.createElement("div");
  overlay.className = "bet-confirm-flash";
  overlay.innerHTML = `
    <svg class="bet-confirm-check" viewBox="0 0 52 52" aria-hidden="true">
      <circle class="bcc-ring" cx="26" cy="26" r="23" fill="none" stroke-width="3"/>
      <path class="bcc-tick" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"
            d="M14 27 l8 8 l16 -18"/>
    </svg>
    <div class="bet-confirm-label">${Lpn("live.betsCount", count, "bet")} ${L("conf.placed","placed")}</div>
  `;
  // anchor absolutely over the builder card (center)
  overlay.style.position = "fixed";
  overlay.style.top = `${rect.top + rect.height / 2}px`;
  overlay.style.left = `${rect.left + rect.width / 2}px`;
  overlay.style.transform = "translate(-50%, -50%)";
  overlay.style.zIndex = "9999";
  overlay.style.pointerEvents = "none";
  document.body.appendChild(overlay);

  const tl = anime.timeline({
    complete: () => overlay.remove(),
  });
  // ring & tick draw in
  tl.add({
    targets: overlay.querySelector(".bcc-ring"),
    strokeDashoffset: [anime.setDashoffset, 0],
    duration: 380, easing: "easeOutCubic",
  }).add({
    targets: overlay.querySelector(".bcc-tick"),
    strokeDashoffset: [anime.setDashoffset, 0],
    duration: 260, easing: "easeOutCubic",
  }, "-=180")
  .add({
    targets: overlay,
    scale: [{ value: 1.08, duration: 180, easing: "easeOutQuad" },
            { value: 1,    duration: 160, easing: "easeInOutQuad" }],
  }, "-=200")
  .add({
    targets: overlay,
    opacity: [1, 0],
    translateY: [0, -14],
    duration: 380,
    easing: "easeInCubic",
    delay: 520,     // hold moment before fading
  });
}

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

  // Small helper: pull a localized string with English fallback
  const L = (key, en) => {
    const lang = localStorage.getItem("aja_lang") || "en";
    const dict = (lang === "ar" && window.AJA_I18N && window.AJA_I18N.ar) ? window.AJA_I18N.ar : null;
    return (dict && dict[key]) || en;
  };

  // Match result / advance
  const mlReady = isKO
    ? (match.odds_a && match.odds_b && +match.odds_a > 0 && +match.odds_b > 0)
    : (match.odds_a && match.odds_draw && match.odds_b && +match.odds_a > 0 && +match.odds_draw > 0 && +match.odds_b > 0);
  if (mlReady) {
    const advance = L("bet.toAdvance", "to advance");
    const advSuffix = isKO ? ' ' + advance : '';
    const opts = [{ label: teamFullName(match.team_a) + advSuffix, val: match.team_a, odds: +match.odds_a }];
    if (!isKO) opts.push({ label: L("bet.draw", "Draw"), val: 'DRAW', odds: +match.odds_draw });
    opts.push({ label: teamFullName(match.team_b) + advSuffix, val: match.team_b, odds: +match.odds_b });
    const title = isKO ? L("market.advance", "To Advance") : L("market.result", "Match Result");
    markets.push({ key: 'moneyline', title, options: opts });
  }

  // Total goals (Over/Under)
  if (match.odds_over && match.odds_under && +match.odds_over > 0 && +match.odds_under > 0) {
    const line = match.total_line ? +match.total_line : 2.5;
    markets.push({
      key: 'total',
      title: L("market.total", "Total Goals"),
      subtitle: L("market.totalSub", "Over/Under ") + line,
      options: [
        { label: L("bet.totalOver", "Over") + ' ' + line, val: 'OVER', odds: +match.odds_over },
        { label: L("bet.totalUnder", "Under") + ' ' + line, val: 'UNDER', odds: +match.odds_under }
      ]
    });
  }

  // Both teams to score
  if (match.odds_btts_yes && match.odds_btts_no && +match.odds_btts_yes > 0 && +match.odds_btts_no > 0) {
    markets.push({
      key: 'btts',
      title: L("market.btts", "Both Teams To Score"),
      subtitle: L("bet.yes", "Yes") + '/' + L("bet.no", "No"),
      options: [
        { label: L("bet.yes", "Yes"), val: 'YES', odds: +match.odds_btts_yes },
        { label: L("bet.no", "No"),   val: 'NO',  odds: +match.odds_btts_no }
      ]
    });
  }
  return markets;
}

// Renders the interactive builder for a match with no bets yet on it.
function renderBetBuilder(match) {
  const markets = marketsFor(match);
  if (markets.length === 0) return '';

  // Balance caps the combined stake across all legs (elastic max logic below).
  const bal = (typeof lastKnownPoints === 'number' && lastKnownPoints > 0)
    ? Math.floor(lastKnownPoints / 5) * 5 : 0;

  const marketHtml = markets.map(mkt => {
    const optButtons = mkt.options.map(o =>
      `<button type="button" class="bb-opt" data-odds="${o.odds}" data-val="${o.val.replace(/"/g, '&quot;')}"
         onclick="bbPick(${match.id}, '${mkt.key}', this)">
         <span class="bb-opt-label">${o.label}</span>
         <span class="bb-opt-odds">${o.odds.toFixed(2)}x</span>
       </button>`
    ).join('');

    // Show settlement note on goals-based markets (Total, BTTS) — extra time
    // counts, penalty shootouts don't. Doesn't apply to moneyline / to-advance.
    const showRule = (mkt.key === 'total' || mkt.key === 'btts');
    const ruleNote = showRule ? `
      <div class="bb-rule-note" title="${L('bb.ruleTip','Goals scored in regulation and extra time both count toward this bet. Penalty shootout goals do not count.')}">
        <span class="bb-rule-icon" aria-hidden="true">ⓘ</span>
        <span>${L('bb.rule','Extra time counts, penalty shootouts don\'t')}</span>
      </div>` : '';

    return `
    <div class="bb-market" data-market="${mkt.key}">
      <label class="bb-market-head">
        <input type="checkbox" class="bb-tick" onchange="bbToggle(${match.id}, '${mkt.key}', this.checked)">
        <span class="bb-market-title">${mkt.title}${mkt.subtitle ? ` <span class="bb-sub">${mkt.subtitle}</span>` : ''}</span>
      </label>
      <div class="bb-market-body hidden" id="bb-body-${match.id}-${mkt.key}">
        ${ruleNote}
        <div class="bb-opts">${optButtons}</div>
        <div class="bb-stake">
          <div class="bb-stake-top">
            <span class="bb-stake-label">Stake</span>
            <span class="bb-stake-val" id="bb-val-${match.id}-${mkt.key}">0 pts</span>
          </div>
          <input type="range" class="bb-slider" id="bb-slider-${match.id}-${mkt.key}"
            min="0" max="${bal}" step="1" value="0"
            oninput="bbSlide(${match.id}, '${mkt.key}', this.value)">
          <div class="bb-stake-row">
            <input type="number" class="bb-amount" id="bb-amt-${match.id}-${mkt.key}"
              placeholder="0" min="0" max="${bal}" step="1" value=""
              inputmode="numeric" autocomplete="off"
              oninput="bbType(${match.id}, '${mkt.key}', this.value)">
            <div class="bb-quick-row">
              <button type="button" class="bb-quick" onclick="bbQuick(${match.id}, '${mkt.key}', 10)">10%</button>
              <button type="button" class="bb-quick" onclick="bbQuick(${match.id}, '${mkt.key}', 50)">50%</button>
              <button type="button" class="bb-quick" onclick="bbQuick(${match.id}, '${mkt.key}', 100)">100%</button>
            </div>
          </div>
          <div class="bb-leg-payout" id="bb-pay-${match.id}-${mkt.key}"></div>
        </div>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="bet-builder" id="bet-builder-${match.id}" data-balance="${bal}">
    <p class="bb-intro">${L("bb.intro", "Tick the bets you want, set an amount for each, then place them all at once.")}</p>
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
  } else {
    delete builderState[matchId][marketKey];
    const slider = document.getElementById(`bb-slider-${matchId}-${marketKey}`);
    const num = document.getElementById(`bb-amt-${matchId}-${marketKey}`);
    if (slider) slider.value = 0;
    if (num) num.value = '';
  }
  // Unticking frees this leg's stake back to the others immediately (elastic).
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

// Round to the nearest valid bet increment (multiple of 5), clamped to a max.
function bbSnapVal(raw, max) {
  // Historically this rounded stakes to multiples of 5, but that made typing
  // impossible (each keystroke would snap the value and rewrite the input,
  // erasing what you tried to type). Now just clamps to [0, max] as an integer.
  let v = Math.floor(parseFloat(raw) || 0);
  if (v < 0) v = 0;
  const m = Math.floor(max || 0);
  if (v > m) v = m;
  return v;
}

// Paint the slider's filled portion using its OWN current value/max — used
// both mid-drag (raw, pixel-exact) and after a deliberate jump (snapped).
function bbPaintSlider(slider) {
  const max = parseFloat(slider.max) || 0;
  const pct = max > 0 ? (parseFloat(slider.value) / max) * 100 : 0;
  // A hair of blend at the fill boundary (instead of one hard color-stop)
  // kills the jagged/blocky edge — imperceptible as a fade, just smoother.
  const p0 = Math.max(0, pct - 0.6);
  const p1 = Math.min(100, pct + 0.6);
  slider.style.background =
    `linear-gradient(to right, #ffd600 0%, #ffd600 ${p0}%, rgba(255,255,255,0.14) ${p1}%, rgba(255,255,255,0.14) 100%)`;
}

// Deliberate stake set (typing, quick-stake buttons, elastic auto-clamp).
// Repositions the slider thumb — fine here since it's not a live drag.
function bbCommitStake(matchId, marketKey, v) {
  if (!builderState[matchId]) builderState[matchId] = {};
  if (!builderState[matchId][marketKey]) builderState[matchId][marketKey] = { amount: 0 };
  builderState[matchId][marketKey].amount = v;
  const slider = document.getElementById(`bb-slider-${matchId}-${marketKey}`);
  const num = document.getElementById(`bb-amt-${matchId}-${marketKey}`);
  if (slider) slider.value = v;
  if (num) num.value = v === 0 ? '' : v;
  bbRecalc(matchId);
}

// Slider dragged — LIVE, buttery: never overwrite slider.value mid-drag
// (the native thumb tracks the pointer exactly, step=1, zero jagged jumps).
// Uses requestAnimationFrame to coalesce rapid input events into one paint
// per frame — the input event fires ~100/sec on desktop, ~60/sec on mobile,
// but we only need to update the DOM once per animation frame (~16ms).
const _bbSlideRaf = {};
function bbSlide(matchId, marketKey, rawValue) {
  const key = `${matchId}-${marketKey}`;
  // Immediately paint the slider fill — this is a cheap style write that
  // needs to feel 1:1 with the pointer, no rAF gate.
  const slider = document.getElementById(`bb-slider-${matchId}-${marketKey}`);
  if (!slider) return;
  bbPaintSlider(slider);

  // The rest (state sync, recalc other legs, receipt update) is heavier.
  // Coalesce to one call per frame — subsequent oninput events during the
  // same frame just overwrite the pending value.
  _bbSlideRaf[key] = rawValue;
  if (_bbSlideRaf[key + ":scheduled"]) return;
  _bbSlideRaf[key + ":scheduled"] = true;
  requestAnimationFrame(() => {
    _bbSlideRaf[key + ":scheduled"] = false;
    const pendingRaw = _bbSlideRaf[key];
    const max = parseFloat(slider.max) || 0;
    const v = bbSnapVal(pendingRaw, max);
    const num = document.getElementById(`bb-amt-${matchId}-${marketKey}`);
    if (num) num.value = v === 0 ? '' : v;
    if (!builderState[matchId]) builderState[matchId] = {};
    if (!builderState[matchId][marketKey]) builderState[matchId][marketKey] = { amount: 0 };
    builderState[matchId][marketKey].amount = v;
    // Recalc elastic maxes for the OTHER legs live, but never reposition THIS
    // slider while it's being actively dragged (bbRecalc protects activeKey).
    bbRecalc(matchId, marketKey);
  });
}

// Number box typed.
function bbType(matchId, marketKey, typed) {
  const slider = document.getElementById(`bb-slider-${matchId}-${marketKey}`);
  const max = slider ? (parseFloat(slider.max) || 0) : 0;
  const v = bbSnapVal(typed, max);
  bbCommitStake(matchId, marketKey, v);
}

// 10% / 50% / 100% quick-stake — percentage of THIS leg's current elastic max.
function bbQuick(matchId, marketKey, pct) {
  const slider = document.getElementById(`bb-slider-${matchId}-${marketKey}`);
  const max = slider ? (parseFloat(slider.max) || 0) : 0;
  const raw = Math.floor((max * pct) / 100);
  const v = bbSnapVal(raw, max);
  bbCommitStake(matchId, marketKey, v);
}

function bbRecalc(matchId, activeKey) {
  const state = builderState[matchId] || {};
  const builder = document.getElementById(`bet-builder-${matchId}`);
  const balance = builder ? parseInt(builder.dataset.balance) || 0 : 0;
  const tickedKeys = Object.keys(state);

  // Sync amounts from each leg's number box, EXCEPT the actively-dragged leg
  // (bbSlide already wrote its precise snapped amount straight into state).
  tickedKeys.forEach(key => {
    if (key === activeKey) return;
    const amtEl = document.getElementById(`bb-amt-${matchId}-${key}`);
    state[key].amount = amtEl ? (parseInt(amtEl.value) || 0) : 0;
  });

  // ── ELASTIC MAX ── each leg's ceiling = balance minus what's currently
  // committed to every OTHER ticked leg. Two passes settle up to 3 markets.
  for (let pass = 0; pass < 2; pass++) {
    tickedKeys.forEach(key => {
      const othersSum = tickedKeys.filter(k => k !== key).reduce((s, k) => s + (state[k].amount || 0), 0);
      const thisMax = Math.max(0, balance - othersSum);
      state[key]._max = thisMax;
      if ((state[key].amount || 0) > thisMax) {
        state[key].amount = thisMax;
        const numEl = document.getElementById(`bb-amt-${matchId}-${key}`);
        if (numEl) numEl.value = thisMax === 0 ? '' : thisMax;
        // Don't yank the slider the user is actively dragging out from under them.
        if (key !== activeKey) {
          const sliderEl = document.getElementById(`bb-slider-${matchId}-${key}`);
          if (sliderEl) sliderEl.value = thisMax;
        }
      }
    });
  }

  // Apply the (possibly shrunk) ceiling, repaint, and update per-leg displays.
  const lines = [];
  let totalStake = 0, totalReturn = 0, anyInvalid = false, anyLeg = false;

  tickedKeys.forEach(key => {
    const leg = state[key];
    const amt = leg.amount || 0;

    const sliderEl = document.getElementById(`bb-slider-${matchId}-${key}`);
    if (sliderEl) {
      // Never rewrite the max on the slider the user is CURRENTLY dragging —
      // browsers reposition the thumb to fit the new range, which shows up as
      // the thumb "skipping" or lurching to a different position. Only touch
      // maxes on inactive legs.
      if (key !== activeKey) {
        sliderEl.max = leg._max;
      }
      bbPaintSlider(sliderEl);
    }

    const valEl = document.getElementById(`bb-val-${matchId}-${key}`);
    if (valEl) valEl.textContent = `${amt.toLocaleString()} ${L("unit.pts","pts")}`;

    const payEl = document.getElementById(`bb-pay-${matchId}-${key}`);
    if (payEl) {
      if (leg.pick && amt > 0) {
        const legRet = Math.floor(amt * leg.odds);
        payEl.innerHTML = `${leg.label} @ ${leg.odds.toFixed(2)}x → <strong>${legRet.toLocaleString()} ${L("unit.pts","pts")}</strong>`;
        payEl.style.display = 'block';
      } else if (amt > 0 && !leg.pick) {
        payEl.innerHTML = `Pick an option above`;
        payEl.style.display = 'block';
      } else {
        payEl.style.display = 'none';
      }
    }

    if (leg.pick && amt > 0) {
      anyLeg = true;
      // Any integer stake is valid now — the old %5 check was left over from
      // when stakes were forced to multiples of 5 and became a silent blocker.
      const ret = Math.floor(amt * leg.odds);
      totalStake += amt;
      totalReturn += ret;
      lines.push(`<div class="bb-rcpt-line"><span>${leg.label} @ ${leg.odds.toFixed(2)}x · ${amt.toLocaleString()} ${L("unit.pts","pts")}</span><span class="bb-rcpt-win">→ ${ret.toLocaleString()}</span></div>`);
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
    totalEl.innerHTML = `<span>Total staked: <strong>${totalStake.toLocaleString()}</strong> pts</span><span class="bb-total-win">If all win: <strong>${totalReturn.toLocaleString()}</strong> pts</span>`;
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
  // Any positive integer stake is valid — the old "multiple of 5" rule was
  // dropped when we made typed and slider entry granular. Keeping this here
  // would silently block slider-produced values like 183 that come from
  // pixel-granularity on narrow screens.

  const totalStake = legs.reduce((s, l) => s + l.amount, 0);
  const totalReturn = legs.reduce((s, l) => s + Math.floor(l.amount * l.odds), 0);
  // Final safety: never let the combined stake exceed the known balance.
  if (typeof lastKnownPoints === 'number' && totalStake > lastKnownPoints) {
    alert(`Total staked (${totalStake.toLocaleString()}) is more than your balance (${lastKnownPoints.toLocaleString()}). Lower an amount.`);
    return;
  }
  // No confirmation dialog — bets are cancellable up to prediction close, so the
  // dialog is friction without safety benefit. The bet-placed check + easy
  // cancel from the match card is the safety net.
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
    animateBetPlacedConfirm(matchId, placed.length);
    showNotification(`${placed.length} bet${placed.length > 1 ? 's' : ''} placed on this match!`);
  } else if (placed.length > 0) {
    animateBetPlacedConfirm(matchId, placed.length);
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
    if (t === 'total') return `${L("bet.total","Total")} ${b.selected_team === 'OVER' ? L("bet.totalOver","Over") : L("bet.totalUnder","Under")} ${line}`;
    if (t === 'btts') return `${L("bet.btts","BTTS")} ${b.selected_team === 'YES' ? L("bet.yes","Yes") : L("bet.no","No")}`;
    if (b.selected_team === 'DRAW') return L("bet.draw","Draw");
    const nm = teamFullName(b.selected_team);
    return isKnockout(match.stage) ? `${nm} ${L("bet.toAdvance","to advance")}` : nm;
  };
  let totalStake = 0, totalReturn = 0;
  const rows = userBets.map(b => {
    const odds = b.odds_used ? parseFloat(b.odds_used) : null;
    const ret = odds ? Math.floor(b.points_used * odds) : b.points_used;
    totalStake += b.points_used; totalReturn += ret;
    return `<div class="placed-leg">
      <div class="placed-leg-main">
        <span class="placed-leg-pick">${labelFor(b)}</span>
        <span class="placed-leg-odds">${b.points_used.toLocaleString()} @ ${odds ? odds.toFixed(2) + 'x' : '—'}</span>
      </div>
      <span class="placed-leg-win">${ret.toLocaleString()}</span>
    </div>`;
  }).join('');

  return `
  <div class="placed-bets">
    <div class="placed-title">
      <span class="placed-title-check">✓</span>
      <span>${L("placed.title","Your bets")}</span>
      <span class="placed-count">${userBets.length}</span>
    </div>
    <div class="placed-legs">${rows}</div>
    <div class="placed-total">
      <div class="placed-total-cell">
        <span class="placed-total-label">${L("placed.staked","Staked")}</span>
        <span class="placed-total-val">${totalStake.toLocaleString()}</span>
      </div>
      <div class="placed-total-cell placed-total-right">
        <span class="placed-total-label">${L("placed.ifWin","If all win")}</span>
        <span class="placed-total-val win">${totalReturn.toLocaleString()}</span>
      </div>
    </div>
    <p class="placed-note">${L("placed.note","Cancelling refunds your full stake. Rebuilding uses current odds.")}</p>
    <button class="cancel-btn" onclick="cancelBet(${match.id})">${L("placed.cancel","Cancel all & rebuild")}</button>
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
  // Default landing view: leaderboard. Otherwise the dashboard opens with only
  // the balance card visible and empty space below it.
  const lb = document.getElementById("leaderboardSection");
  if (lb) lb.classList.remove("hidden");
  // Kick off the activity feed poll so the ticker + Activity tab stay live.
  startActivityPolling();
}

function enterDashboard() {
  showDashboard();
}


function showMatchesSection() {
  hideAllDashboardSections();

  const section = document.getElementById("matchesSection");
  section.classList.remove("hidden");

  animateSectionIn(section);
  loadMatches();
  section.scrollIntoView({ behavior: "smooth" });
}

// ─── ROULETTE MINI-GAME (frontend) ──────────────────────────────────────────
// All the money logic lives on the server (/api/roulette/spin). This UI only
// collects a colour + stake, plays the spin animation, then shows the result
// the SERVER returns — it never decides win/lose itself.
let rState = { color: null, amount: 0, spinning: false };

function showRouletteSection() {
  hideAllDashboardSections();
  const section = document.getElementById("rouletteSection");
  section.classList.remove("hidden");
  animateSectionIn(section);
  rResetControls();
  section.scrollIntoView({ behavior: "smooth" });
}

function rResetControls() {
  rState = { color: null, amount: 0, spinning: false };
  const bal = (typeof lastKnownPoints === 'number' && lastKnownPoints > 0)
    ? Math.floor(lastKnownPoints / 5) * 5 : 0;
  const slider = document.getElementById("rSlider");
  const amt = document.getElementById("rAmount");
  if (slider) { slider.max = bal; slider.value = 0; rPaintSlider(slider); }
  if (amt) amt.value = "";
  document.querySelectorAll(".rcolor").forEach(b => b.classList.remove("rcolor-active"));
  const out = document.getElementById("rOutcome");
  if (out) out.classList.add("hidden");
  document.getElementById("rStakeVal").textContent = "0 pts";
  rUpdateSpinBtn();
}

function rPaintSlider(slider) {
  const max = parseFloat(slider.max) || 0;
  const pct = max > 0 ? (parseFloat(slider.value) / max) * 100 : 0;
  slider.style.background =
    `linear-gradient(to right, #ffd600 0%, #ffd600 ${pct}%, rgba(255,255,255,0.14) ${pct}%, rgba(255,255,255,0.14) 100%)`;
}

function rSnap(raw, max) {
  let v = Math.round((parseFloat(raw) || 0) / 5) * 5;
  if (v < 0) v = 0;
  const m = Math.floor((max || 0) / 5) * 5;
  if (v > m) v = m;
  return v;
}

function rSelectColor(color, btn) {
  if (rState.spinning) return;
  rState.color = color;
  document.querySelectorAll(".rcolor").forEach(b => b.classList.remove("rcolor-active"));
  btn.classList.add("rcolor-active");
  rUpdateSpinBtn();
}

function rSlide(v) {
  const slider = document.getElementById("rSlider");
  rPaintSlider(slider);
  const max = parseFloat(slider.max) || 0;
  const val = rSnap(v, max);
  rState.amount = val;
  document.getElementById("rAmount").value = val === 0 ? "" : val;
  document.getElementById("rStakeVal").textContent = `${val.toLocaleString()} ${L("unit.pts","pts")}`;
  rUpdateSpinBtn();
}

function rType(v) {
  const slider = document.getElementById("rSlider");
  const max = parseFloat(slider.max) || 0;
  const val = rSnap(v, max);
  rState.amount = val;
  slider.value = val;
  rPaintSlider(slider);
  document.getElementById("rStakeVal").textContent = `${val.toLocaleString()} ${L("unit.pts","pts")}`;
  rUpdateSpinBtn();
}

function rAdd(inc) {
  const slider = document.getElementById("rSlider");
  const max = parseFloat(slider.max) || 0;
  const val = rSnap(rState.amount + inc, max);
  rState.amount = val;
  slider.value = val;
  rPaintSlider(slider);
  document.getElementById("rAmount").value = val === 0 ? "" : val;
  document.getElementById("rStakeVal").textContent = `${val.toLocaleString()} ${L("unit.pts","pts")}`;
  rUpdateSpinBtn();
}

function rClear() {
  const slider = document.getElementById("rSlider");
  rState.amount = 0;
  slider.value = 0;
  rPaintSlider(slider);
  document.getElementById("rAmount").value = "";
  document.getElementById("rStakeVal").textContent = "0 pts";
  rUpdateSpinBtn();
}

function rUpdateSpinBtn() {
  const btn = document.getElementById("rSpinBtn");
  if (!btn) return;
  if (rState.spinning) { btn.disabled = true; btn.textContent = "Spinning…"; return; }
  if (!rState.color) { btn.disabled = true; btn.textContent = "Pick a colour"; return; }
  if (rState.amount < 5) { btn.disabled = true; btn.textContent = "Set a stake (min 5)"; return; }
  btn.disabled = false;
  btn.textContent = `Spin for ${rState.amount.toLocaleString()} ${L("unit.pts","pts")}`;
}

// ── Web Audio sound (no external files — synthesised) ──
let rAudioCtx = null;
function rAudio() {
  if (!rAudioCtx) {
    try { rAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { rAudioCtx = null; }
  }
  return rAudioCtx;
}
function rTick(when, freq = 900, vol = 0.06) {
  const ctx = rAudio(); if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "square"; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  o.connect(g); g.connect(ctx.destination);
  o.start(when); o.stop(when + 0.05);
}
function rPlaySpinTicks(durationMs) {
  const ctx = rAudio(); if (!ctx) return;
  const now = ctx.currentTime;
  const dur = durationMs / 1000;
  // ticks that space out as the wheel "slows" (ease-out cadence)
  let t = 0, gap = 0.05;
  while (t < dur) {
    rTick(now + t, 800 + Math.random() * 200, 0.05);
    gap *= 1.12;              // each gap a bit longer → decelerating clicks
    t += gap;
  }
}
function rPlayWin() {
  const ctx = rAudio(); if (!ctx) return;
  const now = ctx.currentTime;
  [523, 659, 784, 1047].forEach((f, i) => rTick(now + i * 0.1, f, 0.12)); // ascending arpeggio
}
function rPlayLose() {
  const ctx = rAudio(); if (!ctx) return;
  const now = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "sawtooth"; o.frequency.setValueAtTime(300, now);
  o.frequency.exponentialRampToValueAtTime(90, now + 0.4); // descending "womp"
  g.gain.setValueAtTime(0.12, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
  o.connect(g); g.connect(ctx.destination);
  o.start(now); o.stop(now + 0.42);
}

// Center angle (degrees) of each colour band on the wheel gradient, so the
// wheel can LAND pointing at the real result rather than a fixed spin.
// Gradient: red 0-40, black 40-80, red 80-120, black 120-160, GREEN 160-200,
// red 200-240, black 240-280, red 280-320, black 320-360.
const R_LAND = {
  green: 180,                          // the single green band centre
  red:   [20, 100, 220, 300],          // red band centres
  black: [60, 140, 260, 340],          // black band centres
};
function rLandingAngle(result) {
  if (result === "green") return R_LAND.green;
  const opts = R_LAND[result];
  return opts[Math.floor(Math.random() * opts.length)];
}

async function rSpin() {
  if (rState.spinning || !rState.color || rState.amount < 5) return;
  rState.spinning = true;
  rUpdateSpinBtn();
  const out = document.getElementById("rOutcome");
  out.classList.add("hidden");

  const wheel = document.getElementById("rouletteWheel");
  const badge = document.getElementById("rouletteResultBadge");
  badge.textContent = "…";
  badge.className = "roulette-hub";

  const token = localStorage.getItem("token");
  try {
    const res = await fetch(`${API}/roulette/spin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": token },
      body: JSON.stringify({ color: rState.color, amount: rState.amount }),
    });
    const data = await res.json();

    if (!res.ok) {
      out.className = "roulette-outcome roulette-lose";
      out.textContent = data.message || "Spin failed.";
      out.classList.remove("hidden");
      rState.spinning = false;
      rUpdateSpinBtn();
      return;
    }

    // ── Polished landing spin: rotate several full turns, then settle so the
    //    pointer sits over the ACTUAL result band. Longer, eased, with ticks. ──
    const SPIN_MS = 3400;
    const turns = 5 + Math.floor(Math.random() * 2);          // 5–6 full turns
    const land = rLandingAngle(data.result);
    // pointer is at top (0deg). We rotate the wheel so `land` ends up at top:
    // final rotation = whole turns + (360 - land) to bring that band under the pointer.
    const prev = rState._rot || 0;
    const target = prev + turns * 360 + (360 - land) - (prev % 360);
    rState._rot = target;

    wheel.style.transition = `transform ${SPIN_MS}ms cubic-bezier(.12,.62,.12,1)`;
    wheel.style.transform = `rotate(${target}deg)`;
    rPlaySpinTicks(SPIN_MS);

    await new Promise(r => setTimeout(r, SPIN_MS + 120));

    // reveal result in the centre badge
    badge.textContent = data.result.toUpperCase();
    badge.classList.add(`result-${data.result}`);
    // The hub is centered via translate(-50%,-50%); animating its transform with
    // anime.js would wipe that and pop off-center. Instead animate a CSS var-free
    // pulse via a class that scales from the center (transform-origin center).
    badge.classList.remove("hub-pop");
    void badge.offsetWidth;        // reflow so re-adding the class restarts it
    badge.classList.add("hub-pop");

    if (data.won) {
      rPlayWin();
      out.className = "roulette-outcome roulette-win";
      out.innerHTML = `🎉 <strong>${data.result.toUpperCase()}</strong> — you won <strong>${data.payout.toLocaleString()}</strong> pts (net +${data.net.toLocaleString()})`;
    } else {
      rPlayLose();
      out.className = "roulette-outcome roulette-lose";
      out.innerHTML = `Landed <strong>${data.result.toUpperCase()}</strong> — lost ${rState.amount.toLocaleString()} ${L("unit.pts","pts")}. Try again!`;
    }
    out.classList.remove("hidden");
    animatePop(out, { from: 0.9, duration: 300 });

    if (typeof data.newBalance === "number") {
      lastKnownPoints = data.newBalance;
      setPointsDisplay(lastKnownPoints);
    }

    rState.spinning = false;
    rState.amount = 0;
    const slider = document.getElementById("rSlider");
    const bal = (typeof lastKnownPoints === 'number' && lastKnownPoints > 0)
      ? Math.floor(lastKnownPoints / 5) * 5 : 0;
    slider.max = bal; slider.value = 0; rPaintSlider(slider);
    document.getElementById("rAmount").value = "";
    document.getElementById("rStakeVal").textContent = "0 pts";
    rUpdateSpinBtn();
  } catch (e) {
    out.className = "roulette-outcome roulette-lose";
    out.textContent = "Network error — your balance was not charged.";
    out.classList.remove("hidden");
    rState.spinning = false;
    rUpdateSpinBtn();
  }
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

  animateSectionIn(section);
  loadPredictionHistory();
  section.scrollIntoView({ behavior: "smooth" });
}

let leaderboardPoints = []; // populated when leaderboard loads

function getRank(points) {
  points = Number(points);
  // Rank labels are keyed for i18n; the emoji is the same in both languages.
  const label = (key, en) => {
    const lang = localStorage.getItem("aja_lang") || "en";
    const dict = (lang === "ar" && window.AJA_I18N && window.AJA_I18N.ar) ? window.AJA_I18N.ar : null;
    return (dict && dict[key]) || en;
  };
  if (!leaderboardPoints.length) {
    if (points >= 50000) return label("rank.legend", "Legend 👑");
    if (points >= 20000) return label("rank.elite", "Elite ⭐");
    if (points >= 10000) return label("rank.pro", "Pro 🔵");
    if (points >= 5000)  return label("rank.contender", "Contender 🟢");
    if (points >= 2000)  return label("rank.amateur", "Amateur 🟡");
    return label("rank.rookie", "Rookie ⚪");
  }

  const total = leaderboardPoints.length;
  const beatenBy = leaderboardPoints.filter(p => p > points).length;
  const percentile = (beatenBy / total) * 100;

  if (percentile < 5)   return label("rank.legend", "Legend 👑");
  if (percentile < 15)  return label("rank.elite", "Elite ⭐");
  if (percentile < 30)  return label("rank.pro", "Pro 🔵");
  if (percentile < 50)  return label("rank.contender", "Contender 🟢");
  if (percentile < 75)  return label("rank.amateur", "Amateur 🟡");
  return label("rank.rookie", "Rookie ⚪");
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
  const to = Number(points) || 0;
  ["dashboardPoints", "heroPoints"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    // parse the currently-shown number so we can count from it to the new value
    const from = Number(String(el.innerText).replace(/[^0-9.-]/g, "")) || 0;
    // Snap instantly if unchanged (avoids needless work on background refreshes).
    if (from === to) { el.innerText = to.toLocaleString(); return; }
    animateNumber(el, from, to, { duration: 500 });
  });
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
  const rememberEl = document.getElementById("rememberMe");
  const remember = rememberEl ? rememberEl.checked : false;

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

    // Remember-me: persist the username (never the password) if opted in.
    // Token itself is always stored — separate concern.
    if (remember) {
      localStorage.setItem("rememberedUsername", username);
      localStorage.setItem("rememberMe", "1");
    } else {
      localStorage.removeItem("rememberedUsername");
      localStorage.removeItem("rememberMe");
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

    // Pin house entry at top. Coerce to Number — the API value can arrive as a
    // string, and .toLocaleString() on a string like "135796-1495" would print junk.
    const houseTotal = Number(houseData.houseTotal) || 0;
    const houseSign = houseTotal >= 0 ? "+" : "";
    const predHouse = Number(houseData.predictionHouse) || 0;
    const rouletteHouse = Number(houseData.rouletteHouse) || 0;
    const fmtSigned = (n) => `${n >= 0 ? "+" : ""}${n.toLocaleString()}`;
    box.innerHTML += `
      <div class="leaderboard-item house-entry">
        <span class="leader-badge">🏦</span>
        <div class="leader-info">
          <strong>The AJA House</strong>
          <small>Always watching</small>
          <div class="house-breakdown">
            <span class="house-src">⚽ Wagers <b class="${predHouse >= 0 ? 'pos' : 'neg'}">${fmtSigned(predHouse)}</b></span>
            <span class="house-src">🎰 Roulette <b class="${rouletteHouse >= 0 ? 'pos' : 'neg'}">${fmtSigned(rouletteHouse)}</b></span>
          </div>
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
        <div class="leaderboard-item rank-${currentRank}" onclick="showUserHistory('${user.username}')" style="cursor:pointer" title="${L('lb.viewHistory','View')} ${user.username}">
          <span class="leader-badge">${badge}</span>

          <div class="leader-info">
            <strong>#${currentRank} ${user.username}</strong>${rankArrow}
            <small>${getRank(user.points)}${Number(user.staked_points) > 0 ? ` · ${Number(user.staked_points).toLocaleString()} ${L('lb.inPlay','in play')}` : ''}</small>
          </div>

          <div class="cash-badge-slot">${user.cash_eligible === 1 ? `<span class="cash-badge" title="${L('lb.cashEligible','Eligible for cash prizes')}">$</span>` : ''}</div>

          <div class="leader-points">
            ${Number(user.points).toLocaleString()}
            <span>${L('unit.pts','pts')}</span>
          </div>
        </div>
      `;
    });

    // Only animate rows in on the FIRST render or when standings actually changed —
    // not on every background refresh (that caused repeated jank/lag).
    if (!window._lbAnimatedOnce || currentFingerprint !== savedFingerprint) {
      animateStagger(box.querySelectorAll(".leaderboard-item"), { stagger: 35, dy: 10 });
      window._lbAnimatedOnce = true;
    }

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
    const cutoff = new Date(now36.getTime() + 96 * 60 * 60 * 1000); // 96 hours (4 days) from now

    data.forEach(match => {
      // Skip settled matches entirely
      if (match.result || match.status === 'settled') return;

      const matchTime = new Date(match.match_time);

      // Only show matches starting within the next 96 hours (4 days)
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
        // The user asked for "no lockout" — betting stays open as long as odds are
        // there, right up until kickoff. This drops the older 5-min-before-kickoff
        // cutoff and the pre-open lockout entirely.
        const closeTime = matchTime;

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

} else if (hasBets && now < closeTime) {

  // Has bets and kickoff hasn't happened → show placed-bets receipt + cancel/rebuild.
  actionHtml = `
  <div class="countdown-box">
    <span>${L("card.closesIn", "Predictions close in")}:</span>
    <strong id="timer-${match.id}">${getCountdown(closeTime)}</strong>
  </div>
  <div class="prediction-box">
    ${renderPlacedBets(match, userBets)}
  </div>
  `;

} else if (hasBets) {

  // Has bets but kickoff has happened → locked, waiting for result.
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

} else if (!oddsReady && now < closeTime) {

  // No odds yet and kickoff hasn't happened → tell them odds are still being set.
  actionHtml = `
  <div class="odds-pending-box">
    <p>⏳ ${L("card.oddsPending","Odds not available yet")}</p>
    <small>${L("card.oddsPendingSub","Betting opens for this match once odds are set. Check back soon.")}</small>
  </div>
  `;

} else if (oddsReady && now < closeTime) {

  // Odds ready, no bets yet, kickoff hasn't happened → the BET BUILDER. No pre-open
  // gate — the moment odds are set, betting is available.
  actionHtml = `
  <div class="countdown-box">
    <span>${L("card.closesIn", "Predictions close in")}:</span>
    <strong id="timer-${match.id}">${getCountdown(closeTime)}</strong>
  </div>
  <div class="prediction-box">
    ${renderBetBuilder(match)}
  </div>
`;

} else {

  // Past kickoff, no bets placed — betting window is over.
  actionHtml = `
    <p class="locked-text">
      Prediction closed
    </p>
  `;
}

        matchesHtml += `
          <div class="match-item">
            <h4>${teamPair(match.team_a, match.team_b)}</h4>

            <p>
              ${L("card.stage", "Stage")}: ${match.stage}
              ${match.group_name ? " - " + match.group_name : ""}
            </p>

            <p>
              ${L("card.time", "Time")}: ${timeText} ${L("card.uae", "UAE")}
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

    // Stagger cards in — but only when the list actually changes (not on
    // background refreshes), same pattern as leaderboard to avoid lag.
    const currentFp = data.map(m => `${m.id}:${m.status}:${m.result || ''}`).join("|");
    if (window._matchesFp !== currentFp) {
      window._matchesFp = currentFp;
      animateStagger(box.querySelectorAll(".match-item"), { stagger: 40, dy: 12 });
    }

}

async function loadPredictionHistory() {
  showSkeleton("predictionHistory", 3);
  const token = localStorage.getItem("token");

  try {
    // Fetch prediction history and the player's roulette P&L in parallel.
    const [res, rStatsRes] = await Promise.all([
      fetch(`${API}/my-predictions`, { headers: { "Authorization": token } }),
      fetch(`${API}/roulette/my-stats`, { headers: { "Authorization": token } })
    ]);

    const data = await res.json();
    const box = document.getElementById("predictionHistory");

    box.innerHTML = "";

    // Roulette P&L card — only shown once the player has actually spun.
    try {
      const rs = await rStatsRes.json();
      if (rs && rs.spins > 0) {
        const net = Number(rs.net) || 0;
        const cls = net > 0 ? "roulette-up" : (net < 0 ? "roulette-down" : "roulette-even");
        const sign = net > 0 ? "+" : "";
        const verbKey = net > 0 ? "rpnl.up" : (net < 0 ? "rpnl.down" : "rpnl.even");
        const verbFallback = net > 0 ? "up" : (net < 0 ? "down" : "even");
        box.innerHTML += `
          <div class="roulette-pnl-card ${cls}">
            <div class="rpnl-left">
              <span class="rpnl-icon">🎰</span>
              <div>
                <div class="rpnl-title">${L("rou.title","Roulette")}</div>
                <div class="rpnl-sub">${Lpn("rpnl.spins", rs.spins, "spin")} · ${rs.wins} ${L("rpnl.won","won")} · ${rs.wagered.toLocaleString()} ${L("rpnl.wagered","wagered")}</div>
              </div>
            </div>
            <div class="rpnl-net">
              <div class="rpnl-amount">${sign}${net.toLocaleString()}</div>
              <div class="rpnl-label">${L("unit.pts","pts")} ${L(verbKey, verbFallback)}</div>
            </div>
          </div>
        `;
      }
    } catch (e) { /* roulette stats are non-critical; skip card on error */ }

    if (!data || data.length === 0) {
      box.innerHTML += `<p class="empty-state">${L("empty.history","No predictions yet.")}</p>`;
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
      let pickLabel = teamFullName(item.selected_team);
      if (type === "total") pickLabel = `${L("bet.total","Total")} ${item.selected_team === "OVER" ? L("bet.totalOver","Over") : L("bet.totalUnder","Under")} ${line}`;
      else if (type === "btts") pickLabel = `${L("bet.btts","BTTS")} ${item.selected_team === "YES" ? L("bet.yes","Yes") : L("bet.no","No")}`;
      else if (item.selected_team === "DRAW") pickLabel = L("bet.draw","Draw");
      let resultText = item.result;
      if (type !== "moneyline" && item.result) {
        const m = item.settlement_message && item.settlement_message.match(/\((\d+)\s*-\s*(\d+)\)/);
        resultText = m ? `${m[1]}-${m[2]}` : item.result;
      }

      let statusColor = "#facc15";
      let statusText = `⏳ ${L("bet.pending","Pending")}`;
      let payoutLine = "";

      if (isCorrect) {
        statusColor = "#22c55e";
        statusText = `✅ ${L("hist.correct","Correct")}`;
        const oddsStr = odds ? ` @ ${odds.toFixed(2)}x` : "";
        payoutLine = `<p style="color:#22c55e;font-weight:bold;">${L("hist.won","Won")} ${payout.toLocaleString()} ${L("unit.pts","pts")} (+${profit.toLocaleString()} ${L("hist.profit","profit")}${oddsStr})</p>`;
      } else if (isRefund) {
        statusColor = "#facc15";
        statusText = `↩ ${L("bet.refund","Refunded")}`;
        payoutLine = `<p style="color:#facc15;font-weight:bold;">${L("hist.refunded","Stake refunded")}: ${item.points_used.toLocaleString()} ${L("unit.pts","pts")}</p>`;
      } else if (isWrong) {
        statusColor = "#ef4444";
        statusText = `❌ ${L("hist.wrong","Wrong")}`;
        const oddsStr = odds ? ` @ ${odds.toFixed(2)}x` : "";
        payoutLine = `<p style="color:#ef4444;font-weight:bold;">${L("hist.lost","Lost")} ${item.points_used.toLocaleString()} ${L("unit.pts","pts")}${oddsStr}</p>`;
      }

      box.innerHTML += `
        <div class="match-item">
          <h4>${teamPair(item.team_a, item.team_b)}</h4>
          <p style="font-size:0.82rem;color:#aaa;">${item.stage}${item.group_name ? " · " + item.group_name : ""} · ${matchDate}</p>
          <p>${L("hist.pick","Pick")}: <strong>${pickLabel}</strong> · ${L("hist.staked","Staked")}: <strong>${item.points_used.toLocaleString()} ${L("unit.pts","pts")}</strong>${odds ? ` · ${L("hist.odds","Odds")}: <strong>${odds.toFixed(2)}x</strong>` : ""}</p>
          ${item.result ? `<p style="color:#aaa;font-size:0.82rem;">${L("card.result","Result")}: ${resultText}</p>` : ""}
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

  animateSectionIn(section);
  loadProfileStats();
  loadActivityFeed(); // populate the "League activity" list under stats
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
  // Do NOT clear seenResultIds:<uname> — that key is user-scoped and needs to
  // persist so the SAME user doesn't re-see notifications after logout+login.
  // But do clear currentUsername + session flag so the next user starts clean.
  localStorage.removeItem("currentUsername");
  sessionStorage.removeItem("resultsShownThisSession");
  // Kill activity polling — otherwise it'd keep firing with a stale token.
  stopActivityPolling();

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
  document.getElementById("rouletteSection") && document.getElementById("rouletteSection").classList.add("hidden");
}

function showLeaderboardSection() {
  hideAllDashboardSections();

  const section = document.getElementById("leaderboardSection");
  section.classList.remove("hidden");

  animateSectionIn(section);
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
  // Push a history state so the browser/phone back button closes the modal
  // instead of exiting the app entirely. The popstate handler below unhides.
  if (!history.state || history.state.modal !== "userHistory") {
    history.pushState({ modal: "userHistory" }, "", location.href);
  }

  try {
    const res = await fetch(`${API}/user-history/${encodeURIComponent(username)}`, {
      headers: { "Authorization": token }
    });
    const data = await res.json();

    if (!res.ok) {
      listBox.innerHTML = `<p>${data.message || "Could not load history."}</p>`;
      return;
    }

    const { user, history, roulette } = data;
    // Title uses "X's history" pattern in English but Arabic reads better as "سجل X",
    // so build it via the i18n key to avoid awkward grammar in either language.
    title.innerText = L("history.titleFor", `${user.username}'s Bet History`).replace("{user}", user.username);

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

    // Roulette P&L line — shown publicly so everyone can see anyone's wheel record.
    let rouletteLine = "";
    if (roulette && roulette.spins > 0) {
      const rnet = Number(roulette.net) || 0;
      const rcolor = rnet > 0 ? "#22c55e" : (rnet < 0 ? "#ef4444" : "#aaa");
      const rsign = rnet > 0 ? "+" : "";
      rouletteLine = `<span style="color:${rcolor}">🎰 ${L("rou.title","Roulette")} ${rsign}${rnet.toLocaleString()} (${Lpn("rpnl.spins", roulette.spins, "spin")})</span>`;
    }

    statBox.innerHTML = `
      <div class="user-history-summary">
        <span>✅ ${wins} ${L("hist.correct","correct")}</span>
        <span>❌ ${losses} ${L("hist.wrong","wrong")}</span>
        <span>📊 ${L("hist.rr","R:R")} ${rrRatio ? rrRatio + ':1' : '—'}</span>
        <span style="color:${roiVal !== null ? (parseFloat(roiVal) >= 0 ? '#22c55e' : '#ef4444') : '#aaa'}">💹 ${L("hist.roi","ROI")} ${roiVal !== null ? (parseFloat(roiVal) >= 0 ? '+' : '') + roiVal + '%' : '—'}</span>
        <span>🎯 ${rate}% ${L("hist.accuracy","accuracy")}</span>
        <span>💰 ${Number(user.points).toLocaleString()} ${L("unit.pts","pts")}</span>
        ${rouletteLine}
      </div>
    `;

    if (history.length === 0 && (!roulette || roulette.spins === 0)) {
      listBox.innerHTML = `<p class="empty-state">${L("empty.settledBets","No settled bets yet.")}</p>`;
      return;
    }

    listBox.innerHTML = history.map(item => {
      const isCorrect = item.won === true;
      const isRefund = item.won === null;
      const isDraw = item.result === "DRAW";

      const type = (item.bet_type || "moneyline").toLowerCase();
      const line = item.total_line ? parseFloat(item.total_line) : 2.5;
      let pickLabel = teamFullName(item.selected_team);
      if (type === "total") pickLabel = `${L("bet.total","Total")} ${item.selected_team === "OVER" ? L("bet.totalOver","Over") : L("bet.totalUnder","Under")} ${line}`;
      else if (type === "btts") pickLabel = `${L("bet.btts","BTTS")} ${item.selected_team === "YES" ? L("bet.yes","Yes") : L("bet.no","No")}`;
      else if (item.selected_team === "DRAW") pickLabel = L("bet.draw","Draw");
      let resultText = item.result;
      if (type !== "moneyline" && item.result) {
        const m = item.settlement_message && item.settlement_message.match(/\((\d+)\s*-\s*(\d+)\)/);
        resultText = m ? `${m[1]}-${m[2]}` : item.result;
      }

      let color = "#ef4444";
      let label = `❌ ${L("hist.wrong","Wrong")}`;
      if (isCorrect) {
        color = "#22c55e";
        label = isDraw ? `✅ ${L("hist.correctDraw","Correct (Draw)")}` : `✅ ${L("hist.correct","Correct")}`;
      } else if (isRefund) {
        color = "#facc15";
        label = `↩ ${L("bet.refund","Refunded")}`;
      }

      const odds = item.odds_used ? parseFloat(item.odds_used) : null;
      const payout = item.payout || 0;
      const profit = item.profit || 0;

      const matchDate = new Date(item.match_time).toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Dubai"
      });

      let outcomeLine;
      if (isCorrect) outcomeLine = `<p style="color:#22c55e;font-weight:bold;">${L("hist.won","Won")} ${payout.toLocaleString()} ${L("unit.pts","pts")} (+${profit.toLocaleString()} ${L("hist.profit","profit")})</p>`;
      else if (isRefund) outcomeLine = `<p style="color:#facc15;font-weight:bold;">${L("bet.refund","Refunded")} ${item.points_used.toLocaleString()} ${L("unit.pts","pts")}</p>`;
      else outcomeLine = `<p style="color:#ef4444;font-weight:bold;">${L("hist.lost","Lost")} ${item.points_used.toLocaleString()} ${L("unit.pts","pts")}</p>`;

      return `
        <div class="match-item">
          <h4>${teamPair(item.team_a, item.team_b)}</h4>
          <p style="font-size:0.82rem;color:#aaa;">${item.stage}${item.group_name ? " · " + item.group_name : ""} · ${matchDate}</p>
          <p>${L("hist.pick","Pick")}: <strong>${pickLabel}</strong> · ${item.points_used.toLocaleString()} ${L("unit.pts","pts")}${odds ? ` @ ${odds.toFixed(2)}x` : ""}</p>
          <p style="color:#aaa;font-size:0.82rem;">${L("card.result","Result")}: ${resultText}</p>
          ${outcomeLine}
          <p style="color:${color};font-weight:bold;">${label}</p>
        </div>
      `;
    }).join("");

  } catch (err) {
    listBox.innerHTML = `<p class="empty-state">${L("empty.historyFail","Failed to load history.")}</p>`;
    console.log("User history error:", err);
  }
}

function closeUserHistory(fromPopstate) {
  document.getElementById("userHistoryModal").classList.add("hidden");
  // If the user closed via X or backdrop, pop the pushed history state so
  // hitting back doesn't try to reopen it. If we got here FROM popstate
  // (browser back), the state is already popped — don't touch it.
  if (!fromPopstate && history.state && history.state.modal === "userHistory") {
    history.back();
  }
}

// Close modal on backdrop click
document.addEventListener("click", function(e) {
  const modal = document.getElementById("userHistoryModal");
  if (e.target === modal) closeUserHistory();
});

// Browser/phone back button closes the modal instead of leaving the app.
window.addEventListener("popstate", function(e) {
  const uhm = document.getElementById("userHistoryModal");
  if (uhm && !uhm.classList.contains("hidden")) {
    closeUserHistory(true); // true = came from popstate, don't re-pop
  }
});

// Tap OR drag on the pill closes the modal.
// - Tap (little/no movement): closes immediately on release.
// - Drag down: modal-content follows finger; released past threshold OR with
//   fast downward velocity closes it. Otherwise it springs back to 0.
// Uses Pointer Events so it works uniformly across touch, mouse, and pen.
(function wireModalDragToDismiss() {
  const handle = document.querySelector("#userHistoryModal .modal-drag-handle");
  const content = document.querySelector("#userHistoryModal .modal-content");
  if (!handle || !content) return;

  // Thresholds
  const DISTANCE_TO_CLOSE = 100;     // px dragged past which we close on release
  const VELOCITY_TO_CLOSE = 0.6;     // px/ms downward velocity that triggers close
  const TAP_MAX_MOVE      = 6;       // total move under this = tap
  const TAP_MAX_TIME      = 350;     // ms

  let startY = 0;
  let startTime = 0;
  let currentY = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let dragging = false;

  handle.addEventListener("pointerdown", (e) => {
    // Only primary button / first touch
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    startY = lastY = e.clientY;
    startTime = lastT = performance.now();
    currentY = 0;
    velocity = 0;
    content.classList.add("dragging");
    // Capture pointer so we keep receiving events even if finger leaves handle
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    // Only allow downward drag; upward is treated as 0 (no rubber-band up)
    currentY = Math.max(0, dy);
    content.style.transform = `translateY(${currentY}px)`;
    // Track velocity from the last frame
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = now;
    e.preventDefault();
  });

  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    content.classList.remove("dragging");
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}

    const elapsed = performance.now() - startTime;
    const totalMove = Math.abs((e.clientY || 0) - startY);
    const isTap = totalMove < TAP_MAX_MOVE && elapsed < TAP_MAX_TIME;
    const dragClose = currentY > DISTANCE_TO_CLOSE || velocity > VELOCITY_TO_CLOSE;

    if (isTap || dragClose) {
      // Slide the modal off before hiding for a nicer feel — matches iOS behavior.
      // The modal will already be translated; extend the slide-off.
      const target = Math.max(currentY + 200, 400);
      content.style.transform = `translateY(${target}px)`;
      setTimeout(() => {
        content.style.transform = "";
        closeUserHistory();
      }, 180);
    } else {
      // Spring back to origin. The CSS transform-transition handles the ease.
      content.style.transform = "";
    }
  };

  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);

  // Keyboard access: Enter / Space on focused handle closes too.
  handle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      closeUserHistory();
    }
  });
})();

// ESC key closes any open modal — a hard-earned keyboard-user convention.
document.addEventListener("keydown", function(e) {
  if (e.key === "Escape" || e.key === "Esc") {
    const uhm = document.getElementById("userHistoryModal");
    if (uhm && !uhm.classList.contains("hidden")) closeUserHistory();
    const rm = document.getElementById("resultsModal");
    if (rm) rm.remove(); // results modal removes itself rather than hiding
  }
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
    `You are about to ${action} ${pts.toLocaleString()} ${L("unit.pts","pts")} on ${bet.pick} at ${bet.odds}x odds.\n\n` +
    `✅ If correct: you win ${potentialWin.toLocaleString()} ${L("unit.pts","pts")} (+${profit.toLocaleString()} profit)\n` +
    `❌ If wrong: you lose ${pts.toLocaleString()} ${L("unit.pts","pts")}\n\n` +
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
  if (!confirm(`Move your ${stake.toLocaleString()} ${L("unit.pts","pts")} to ${newOdds.toFixed(2)}x odds?\n\nNew payout if correct: ${newPayout.toLocaleString()} ${L("unit.pts","pts")}`)) return;

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
    showNotification(`Cancelled ${n} bet${n > 1 ? "s" : ""} — ${refund.toLocaleString()} ${L("unit.pts","pts")} refunded!`);
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

    // Human label for a bet leg — uses localBetType() for i18n on sidebets.
    const legLabel = (b, isKO, line) => {
      const t = (b.bet_type || "moneyline").toLowerCase();
      if (t === "total") {
        const side = b.selected_team === "OVER" ? localBetType("total","OVER") : localBetType("total","UNDER");
        return `${side} ${line}`;
      }
      if (t === "btts") return localBetType("btts", b.selected_team);
      if (b.selected_team === "DRAW") return localBetType("moneyline","DRAW");
      // Moneyline — show team pill + "to advance" if knockout
      const lang = localStorage.getItem("aja_lang") || "en";
      const dict = (lang === "ar" && window.AJA_I18N && window.AJA_I18N.ar) ? window.AJA_I18N.ar : null;
      const advance = (dict && dict["bet.toAdvance"]) || "to advance";
      const nm = teamFullName(b.selected_team) + " " + (isKO ? advance : "");
      return `${teamFlag(b.selected_team)} <b>${teamCode(b.selected_team)}</b> <span class="leg-full">${nm}</span>`;
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
            <span class="abet-leg-pick">${isSide ? '<span class="abet-side-arrow">↳</span> ' : ""}${legLabel(b, isKO, line)}</span>
            <span class="abet-leg-stake">${b.points_used.toLocaleString()} @ ${odds}</span>
            <span class="abet-leg-win">→ ${b.odds_used ? payout.toLocaleString() : "—"}${b.odds_used ? `<span class="abet-profit"> (+${profit.toLocaleString()})</span>` : ""}</span>
          </div>`;
        }).join("");

        return `<div class="abet-player-block">
          <div class="abet-player-head"><strong>${username}</strong>
            <span class="abet-player-meta">${Lpn("live.betsCount", legs.length, "bet")} · ${playerStake.toLocaleString()} ${L("unit.pts","pts")}</span>
          </div>
          ${legRows}
        </div>`;
      }).join("");

      const totalStake = Object.values(g.players).flat().reduce((s, b) => s + b.points_used, 0);
      const betCount = Object.values(g.players).flat().length;

      return `
        <div class="match-item live-bets-match">
          <div class="live-match-head">
            ${teamPair(g.team_a, g.team_b)}
            <div class="live-match-meta">${g.stage}${g.group_name ? " · " + g.group_name : ""} · ${matchDate} UAE</div>
          </div>
          <div class="live-match-summary">
            <span class="live-summary-label">${t('live.staked', 'Total staked')}</span>
            <span class="live-summary-val mono">${totalStake.toLocaleString()} ${L("unit.pts","pts")}</span>
            <span class="live-summary-count">${Lpn("live.betsCount", betCount, "bet")}</span>
          </div>
          <div class="abet-players">${playerBlocks}</div>
        </div>
      `;
    }).join("");

  } catch (err) {
    document.getElementById("activeBetsList").innerHTML = `<p class="empty-state">${t('empty.matches', 'Could not load bets.')}</p>`;
  }
}

// Small i18n helper reused by the render above (defined inline so the async fn owns it).
function t(key, fallback) {
  const lang = localStorage.getItem("aja_lang") || "en";
  const dict = (lang === "ar" && window.AJA_I18N && window.AJA_I18N.ar) ? window.AJA_I18N.ar : null;
  return (dict && dict[key]) || fallback;
}
// L is an alias for t — used interchangeably in template literals.
// Both are hoisted function declarations so they work in any render context.
function L(key, fallback) { return t(key, fallback); }

// Plural helper: pick the right noun form based on count.
// English: singular for 1, plural for everything else (auto "s" via en fallback).
// Arabic: 5 forms per CLDR — we handle the four that matter in practice:
//   1        → base key (رهان)
//   2        → key + ".2" (رهانان)  — dual
//   3–10     → key + ".few" (رهانات) — plural of paucity
//   11+ / 0  → key + ".many" (رهان) — singular tamyiz form
// If a variant isn't in the dict, falls back to the base key.
function Lp(key, count, fallbackBase, fallbackPlural) {
  const lang = localStorage.getItem("aja_lang") || "en";
  if (lang !== "ar") {
    // English: 1 = singular, everything else = plural.
    return count === 1 ? fallbackBase : (fallbackPlural || (fallbackBase + "s"));
  }
  const dict = (window.AJA_I18N && window.AJA_I18N.ar) || null;
  if (!dict) return fallbackBase;
  const n = Math.abs(count) % 100;
  let suffix = "";
  if (n === 1)       suffix = "";      // singular
  else if (n === 2)  suffix = ".2";    // dual
  else if (n >= 3 && n <= 10) suffix = ".few";  // 3-10 plural
  else               suffix = ".many"; // 0, 11+ (falls back to singular form in tamyiz)
  return dict[key + suffix] || dict[key] || fallbackBase;
}

// Full phrase helper: returns "<count> <noun>" together, but in Arabic the
// count is OMITTED for 1 and 2 because the noun form itself signals the count
// (singular = 1, dual = 2). English always keeps the number.
//   English: "1 bet",   "2 bets",  "3 bets",   "11 bets"
//   Arabic:  "رهان",     "رهانان",  "٣ رهانات",  "١١ رهان" — but numerals we
// keep in Western digits since you asked for that globally.
function Lpn(key, count, fallbackBase, fallbackPlural) {
  const lang = localStorage.getItem("aja_lang") || "en";
  const noun = Lp(key, count, fallbackBase, fallbackPlural);
  if (lang === "ar" && (count === 1 || count === 2)) {
    // In Arabic, the noun form alone conveys the count for 1 and 2.
    return noun;
  }
  return count + " " + noun;
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

  // Load already-seen match IDs. Scope the storage key BY USER so that when a
  // different account signs in on this browser (or the same one after clearing
  // storage), they don't inherit or miss notifications belonging to someone else.
  // Legacy unscoped key ("seenResultIds") is honored once then migrated.
  const uname = localStorage.getItem("currentUsername") || "";
  const seenKey = `seenResultIds:${uname.toLowerCase()}`;
  let seenRaw = localStorage.getItem(seenKey);
  if (seenRaw === null) {
    // First run under new scoped key — migrate legacy list once so users don't
    // get a wave of old notifications the first time this ships.
    const legacy = localStorage.getItem("seenResultIds");
    if (legacy) {
      seenRaw = legacy;
      localStorage.setItem(seenKey, legacy);
    } else {
      seenRaw = "[]";
    }
  }
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
      localStorage.setItem(seenKey, JSON.stringify(newIds));
    }

    const totalProfit = results.reduce((s, r) => s + r.profit, 0);
    const wins = results.filter(r => r.won).length;
    const totalStaked = results.reduce((s, r) => s + r.stake, 0);
    const currentBalance = lastKnownPoints;
    const netPositive = totalProfit >= 0;
    const netSign = netPositive ? "+" : "";

    let betsHtml = "";
    results.forEach(r => {
      const isRefund = r.refunded === true;
      const amountStr = isRefund
        ? `${r.stake.toLocaleString()} refunded`
        : (r.won ? `+${r.payout.toLocaleString()}` : `${r.profit.toLocaleString()}`);
      const badgeClass = isRefund ? "badge-refund" : (r.won ? "badge-won" : "badge-lost");
      const badgeText  = isRefund ? "REFUND" : (r.won ? "WON" : "LOST");
      const amtClass   = isRefund ? "" : (r.won ? "amount-won" : "amount-lost");
      const itemClass  = isRefund ? "" : (r.won ? "won" : "lost");
      const oddsStr    = r.odds ? ` · ${parseFloat(r.odds).toFixed(2)}×` : "";
      betsHtml += `
        <div class="result-item ${itemClass}">
          <div class="result-match-row">
            <span class="result-match-name">${r.match}</span>
            <span class="result-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div class="result-detail">
            <span><strong>${r.pick}</strong>${oddsStr} → <strong>${r.result}</strong></span>
            <span class="result-amount ${amtClass}">${amountStr}</span>
          </div>
          <div class="result-stake">Stake ${r.stake.toLocaleString()} ${L("unit.pts","pts")}</div>
        </div>
      `;
    });

    const html = `
      <div class="results-modal-overlay" id="resultsModal">
        <div class="results-modal">
          <div class="results-header">
            <h2>While you were away</h2>
            <p class="results-subtitle">${Lpn("live.betsCount", results.length, "bet")} ${L("results.subtitleTail","settled since your last visit")}</p>
          </div>
          <div class="results-net-bar ${netPositive ? 'net-pos' : 'net-neg'}">
            <div class="results-net-row">
              <span class="results-net-label">Net result</span>
              <span class="results-net-total ${netPositive ? 'pos' : 'neg'}">${netSign}${totalProfit.toLocaleString()} ${L("unit.pts","pts")}</span>
            </div>
            <div class="results-net-row results-net-sub">
              <span><b>${wins}</b>/<b>${results.length}</b> correct · <b>${totalStaked.toLocaleString()}</b> staked</span>
              ${currentBalance ? `<span>Balance <b>${currentBalance.toLocaleString()}</b></span>` : ""}
            </div>
          </div>
          <div class="results-list">${betsHtml}</div>
          <button class="btn-primary" onclick="closeResultsModal()">Continue</button>
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

// ─── SIGNAL: bottom-nav active state, i18n toggle, remember-me, micro-motions ─
// These append at the end so they can wrap/override existing behaviour without
// touching earlier logic.

// Update the bottom nav's active state whenever a section is shown.
// Called from each showXSection() by observing DOM changes on the section list.
(function wireNavActiveState() {
  function updateNavFromVisibleSection() {
    const sections = ["leaderboardSection","matchesSection","activeBetsSection","historySection","statsSection","rouletteSection"];
    let visibleId = null;
    for (const id of sections) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains("hidden")) { visibleId = id; break; }
    }
    document.querySelectorAll(".bottom-nav .nav-btn").forEach(btn => {
      btn.classList.toggle("active", btn.getAttribute("data-section") === visibleId);
    });
  }
  // Poll on interval — cheap, guarantees correctness even if a show function
  // is called externally without an obvious hook.
  setInterval(updateNavFromVisibleSection, 300);
})();

// Countdown urgency — toggle .urgent class on timer elements when <10 min.
// Runs alongside the existing setInterval that updates timer text.
(function wireCountdownUrgency() {
  setInterval(() => {
    document.querySelectorAll('[id^="timer-"]').forEach(el => {
      const text = (el.textContent || "").trim();
      // Existing format: "00h 09m 43s". Parse total seconds.
      const m = text.match(/(\d+)h\s*(\d+)m\s*(\d+)s/);
      if (!m) { el.classList.remove("urgent"); return; }
      const totalSec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
      el.classList.toggle("urgent", totalSec > 0 && totalSec < 600);
    });
  }, 1000);
})();

// Rank number roll — play a subtle slot-flip when dashboardRank changes.
(function wireRankRoll() {
  const el = document.getElementById("dashboardRank");
  if (!el) return;
  let lastVal = el.textContent;
  const observer = new MutationObserver(() => {
    const v = el.textContent;
    if (v !== lastVal && lastVal && v && v !== "—") {
      el.classList.remove("rank-rolled");
      // Force reflow so re-adding the class restarts the animation.
      void el.offsetWidth;
      el.classList.add("rank-rolled");
    }
    lastVal = v;
  });
  observer.observe(el, { childList: true, characterData: true, subtree: true });
})();

// Remember-me pre-fill on page load.
(function wireRememberMe() {
  document.addEventListener("DOMContentLoaded", () => {
    const remembered = localStorage.getItem("rememberedUsername");
    const on = localStorage.getItem("rememberMe") === "1";
    if (remembered) {
      const u = document.getElementById("loginUsername");
      const c = document.getElementById("rememberMe");
      if (u) u.value = remembered;
      if (c) c.checked = on;
    }
  });
})();

// ─── i18n: EN / AR toggle ────────────────────────────────────────────────
// Wire the top-left toggle. English is the source of truth; Arabic strings
// go in the AJA_I18N map — currently empty (English falls back where missing).
// When you have translations, drop them in and they'll take effect immediately.
window.AJA_I18N = {
  ar: {
    // ─── Login ────────────────────────────────────────────────────────
    "login.title":       "تسجيل الدخول",
    "login.tag":         "بالتوفيق 😘",
    "login.username":    "اسم المستخدم",
    "login.password":    "كلمة المرور",
    "login.remember":    "تذكرني",
    "login.submit":      "دخول",
    "login.switch":      "ليس لديك حساب؟ <span onclick=\"showRegister()\">سجّل من هنا</span>",
    "login.register":    "سجّل من هنا",
    "login.notice":      "استعادة كلمة المرور غير متاحة. احتفظ بكلمة مرورك في مكان آمن.<br>للاستفسار: 5147 347 50 966+",

    // ─── Register ─────────────────────────────────────────────────────
    "register.title":         "التسجيل",
    "register.tag":           "إنشاء حساب",
    "register.username":      "اسم المستخدم",
    "register.username.hint": "الاسم الذي يراه الجميع في قائمة الترتيب",
    "register.password":      "كلمة المرور",
    "register.first":         "الاسم الأول",
    "register.last":          "اسم العائلة",
    "register.real.hint":     "الاسم الحقيقي — يظهر للمشرف فقط",
    "register.submit":        "إنشاء حساب",
    "register.back":          "العودة لتسجيل الدخول",

    // ─── Agreement modal ──────────────────────────────────────────────
    "agreement.title":    "مرحباً بك في دوري AJA للتوقعات",
    "agreement.intro":    "قبل إنشاء حسابك، يُرجى قراءة الشروط التالية والموافقة عليها:",
    "agreement.bullet.1": "هذه ليست منصة رهانات ولا تتضمن مقامرة بأموال حقيقية.",
    "agreement.bullet.2": "النقاط للترفيه والترتيب والمشاركة المجتمعية فقط.",
    "agreement.bullet.3": "بانضمامك، فأنت توافق على قواعد وشروط دوري AJA.",
    "agreement.bullet.4": "AJA reserves the right to disqualify any participant found engaging in cheating, unfair play, or misuse of the platform. All decisions are final.",
    "agreement.accept":   "أوافق وأتفهم",

    // ─── Pending approval ─────────────────────────────────────────────
    "pending.tag":     "في انتظار الموافقة",
    "pending.title":   "الحساب قيد المراجعة",
    "pending.body":    "تم إنشاء حسابك وهو في انتظار موافقة المشرف.",
    "pending.contact": "للتفعيل، تواصل معنا:",
    "pending.back":    "العودة لتسجيل الدخول",

    // ─── Dashboard / stats ────────────────────────────────────────────
    "balance.label": "الرصيد",
    "stats.rank":    "الترتيب",
    "stats.bets":    "رهانات مفتوحة",
    "stats.rate":    "معدل النجاح",
    "stats.title":   "الإحصائيات",

    // ─── Section headers ──────────────────────────────────────────────
    "lb.title":      "قائمة الترتيب",
    "matches.title": "المباريات",
    "live.title":    "الرهانات المفتوحة",
    "history.title": "سجل الرهانات",

    // ─── Roulette ─────────────────────────────────────────────────────
    "rou.title": "روليت",
    "rou.tag":   "اختر لوناً، حدّد الرهان، ثم أدر العجلة. الأحمر أو الأسود ٢× والأخضر ١٤×.",
    "rou.stake": "الرهان",
    "rou.pick":  "اختر لوناً",

    // ─── Bottom nav ───────────────────────────────────────────────────
    "nav.leader":  "الترتيب",
    "nav.matches": "المباريات",
    "nav.live":    "نشط",
    "nav.history": "السجل",
    "nav.stats":   "الإحصائيات",
    "nav.rou":     "روليت",
  }
};

function setLang(lang) {
  if (lang !== "en" && lang !== "ar") lang = "en";
  localStorage.setItem("aja_lang", lang);

  // Flip document direction; numbers stay LTR via CSS (unicode-bidi: embed).
  document.documentElement.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  document.documentElement.setAttribute("lang", lang);

  // Update lang toggle button state.
  document.querySelectorAll(".lang-toggle button").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-lang") === lang);
  });

  // Apply translations. If lang=en OR the key is missing, leave the element's
  // baked-in English content alone (that's the source of truth).
  const dict = (lang === "ar" && window.AJA_I18N.ar) ? window.AJA_I18N.ar : null;

  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    const orig = el.getAttribute("data-i18n-orig");
    // Cache original English on first pass.
    if (!orig) el.setAttribute("data-i18n-orig", el.textContent);
    if (dict && dict[key]) {
      el.textContent = dict[key];
    } else if (orig) {
      el.textContent = orig;
    }
  });

  document.querySelectorAll("[data-i18n-html]").forEach(el => {
    const key = el.getAttribute("data-i18n-html");
    const orig = el.getAttribute("data-i18n-orig-html");
    if (!orig) el.setAttribute("data-i18n-orig-html", el.innerHTML);
    if (dict && dict[key]) {
      el.innerHTML = dict[key];
    } else if (orig) {
      el.innerHTML = orig;
    }
  });

  // Re-render dynamic views so their JS-generated strings pick up the new lang.
  // Only fires after initial dashboard load (skipped during login page).
  if (document.getElementById("dashboardPage") &&
      !document.getElementById("dashboardPage").classList.contains("hidden")) {
    try { if (typeof loadLeaderboard === "function") loadLeaderboard(); } catch (e) {}
    try { if (typeof loadMatches === "function") loadMatches(true); } catch (e) {}
    try { if (typeof loadPredictionHistory === "function") loadPredictionHistory(); } catch (e) {}
    // Live bets / stats / roulette outcome pill get refreshed the next time
    // they're opened; re-fetching them all here would thrash the API.
  }
}

// Apply saved language preference on load.
document.addEventListener("DOMContentLoaded", () => {
  const saved = localStorage.getItem("aja_lang") || "en";
  setLang(saved);
});

// Set the avatar text to the current user's initials if we know them.
(function wireAvatarInitials() {
  setInterval(() => {
    const avatar = document.getElementById("topbarAvatar");
    if (!avatar) return;
    const uname = localStorage.getItem("currentUsername");
    if (!uname) return;
    const initials = uname.slice(0, 2).toUpperCase();
    if (avatar.textContent !== initials) avatar.textContent = initials;
  }, 1000);
})();

// ─── SIGNAL: Team lookup (short code + flag + Arabic name) ────────────────────
// Full name (as stored in DB) → { code, flag, ar } lookup.
// If a team isn't in this map, the raw name renders — safe fallback.
// Grouped by regional confederation for maintenance.
window.AJA_TEAMS = {
  // ── UEFA ────────────────────────────────────────────────
  "France":            { code: "FRA", flag: "🇫🇷", ar: "فرنسا" },
  "Spain":             { code: "ESP", flag: "🇪🇸", ar: "إسبانيا" },
  "Portugal":          { code: "POR", flag: "🇵🇹", ar: "البرتغال" },
  "England":           { code: "ENG", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", ar: "إنجلترا" },
  "Germany":           { code: "GER", flag: "🇩🇪", ar: "ألمانيا" },
  "Netherlands":       { code: "NED", flag: "🇳🇱", ar: "هولندا" },
  "Belgium":           { code: "BEL", flag: "🇧🇪", ar: "بلجيكا" },
  "Italy":             { code: "ITA", flag: "🇮🇹", ar: "إيطاليا" },
  "Croatia":           { code: "CRO", flag: "🇭🇷", ar: "كرواتيا" },
  "Switzerland":       { code: "SUI", flag: "🇨🇭", ar: "سويسرا" },
  "Denmark":           { code: "DEN", flag: "🇩🇰", ar: "الدنمارك" },
  "Sweden":            { code: "SWE", flag: "🇸🇪", ar: "السويد" },
  "Norway":            { code: "NOR", flag: "🇳🇴", ar: "النرويج" },
  "Poland":            { code: "POL", flag: "🇵🇱", ar: "بولندا" },
  "Austria":           { code: "AUT", flag: "🇦🇹", ar: "النمسا" },
  "Czechia":           { code: "CZE", flag: "🇨🇿", ar: "التشيك" },
  "Scotland":          { code: "SCO", flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", ar: "اسكتلندا" },
  "Turkiye":           { code: "TUR", flag: "🇹🇷", ar: "تركيا" },
  "Turkey":            { code: "TUR", flag: "🇹🇷", ar: "تركيا" },
  "BosniaHerzegovina": { code: "BIH", flag: "🇧🇦", ar: "البوسنة والهرسك" },
  "Bosnia":            { code: "BIH", flag: "🇧🇦", ar: "البوسنة" },
  // ── CONMEBOL ────────────────────────────────────────────
  "Argentina":  { code: "ARG", flag: "🇦🇷", ar: "الأرجنتين" },
  "Brazil":     { code: "BRA", flag: "🇧🇷", ar: "البرازيل" },
  "Uruguay":    { code: "URU", flag: "🇺🇾", ar: "الأوروغواي" },
  "Colombia":   { code: "COL", flag: "🇨🇴", ar: "كولومبيا" },
  "Paraguay":   { code: "PAR", flag: "🇵🇾", ar: "باراغواي" },
  "Ecuador":    { code: "ECU", flag: "🇪🇨", ar: "الإكوادور" },
  // ── CONCACAF ────────────────────────────────────────────
  "USA":        { code: "USA", flag: "🇺🇸", ar: "أمريكا" },
  "Mexico":     { code: "MEX", flag: "🇲🇽", ar: "المكسيك" },
  "Canada":     { code: "CAN", flag: "🇨🇦", ar: "كندا" },
  "Panama":     { code: "PAN", flag: "🇵🇦", ar: "بنما" },
  "Haiti":      { code: "HAI", flag: "🇭🇹", ar: "هايتي" },
  "Curacao":    { code: "CUR", flag: "🇨🇼", ar: "كوراساو" },
  // ── CAF ─────────────────────────────────────────────────
  "Morocco":    { code: "MAR", flag: "🇲🇦", ar: "المغرب" },
  "Senegal":    { code: "SEN", flag: "🇸🇳", ar: "السنغال" },
  "Egypt":      { code: "EGY", flag: "🇪🇬", ar: "مصر" },
  "Algeria":    { code: "ALG", flag: "🇩🇿", ar: "الجزائر" },
  "Tunisia":    { code: "TUN", flag: "🇹🇳", ar: "تونس" },
  "Ghana":      { code: "GHA", flag: "🇬🇭", ar: "غانا" },
  "IvoryCoast": { code: "CIV", flag: "🇨🇮", ar: "ساحل العاج" },
  "CongoDR":    { code: "COD", flag: "🇨🇩", ar: "الكونغو الديمقراطية" },
  "DR Congo":   { code: "COD", flag: "🇨🇩", ar: "الكونغو الديمقراطية" },
  "SouthAfrica":{ code: "RSA", flag: "🇿🇦", ar: "جنوب أفريقيا" },
  "CaboVerde":  { code: "CPV", flag: "🇨🇻", ar: "الرأس الأخضر" },
  // ── AFC ─────────────────────────────────────────────────
  "Japan":         { code: "JPN", flag: "🇯🇵", ar: "اليابان" },
  "KoreaRepublic": { code: "KOR", flag: "🇰🇷", ar: "كوريا الجنوبية" },
  "South Korea":   { code: "KOR", flag: "🇰🇷", ar: "كوريا الجنوبية" },
  "Iran":          { code: "IRN", flag: "🇮🇷", ar: "إيران" },
  "SaudiArabia":   { code: "KSA", flag: "🇸🇦", ar: "السعودية" },
  "Saudi Arabia":  { code: "KSA", flag: "🇸🇦", ar: "السعودية" },
  "Qatar":         { code: "QAT", flag: "🇶🇦", ar: "قطر" },
  "Iraq":          { code: "IRQ", flag: "🇮🇶", ar: "العراق" },
  "Jordan":        { code: "JOR", flag: "🇯🇴", ar: "الأردن" },
  "Uzbekistan":    { code: "UZB", flag: "🇺🇿", ar: "أوزبكستان" },
  "Australia":     { code: "AUS", flag: "🇦🇺", ar: "أستراليا" },
  // ── OFC ─────────────────────────────────────────────────
  "NewZealand":  { code: "NZL", flag: "🇳🇿", ar: "نيوزيلندا" },
  "New Zealand": { code: "NZL", flag: "🇳🇿", ar: "نيوزيلندا" },
  // ── Special ─────────────────────────────────────────────
  "DRAW":        { code: "DRAW", flag: "🤝", ar: "تعادل" },
};

// Return the short code for a team — safe fallback to first 3 letters uppercased.
function teamCode(name) {
  if (!name) return "";
  const t = window.AJA_TEAMS[name];
  return t ? t.code : name.slice(0, 3).toUpperCase();
}

// Return the flag emoji for a team — safe fallback to a placeholder ⚽.
function teamFlag(name) {
  if (!name) return "";
  const t = window.AJA_TEAMS[name];
  return t ? t.flag : "⚽";
}

// Return the localized full name — Arabic if lang=ar and mapped, else English.
function teamFullName(name) {
  if (!name) return "";
  const lang = localStorage.getItem("aja_lang") || "en";
  if (lang !== "ar") return name;
  const t = window.AJA_TEAMS[name];
  return (t && t.ar) ? t.ar : name;
}

// Render a team as a two-line pill: FLAG CODE / small full-name
// className optional, e.g. "team-pill-lg" for larger version
function teamPill(name, opts = {}) {
  const code = teamCode(name);
  const flag = teamFlag(name);
  const full = teamFullName(name);
  const cls  = opts.className || "team-pill";
  return `<span class="${cls}">
    <span class="team-pill-top"><span class="team-flag">${flag}</span><span class="team-code">${code}</span></span>
    <span class="team-pill-full">${full}</span>
  </span>`;
}

// Render "TeamA · TeamB" as two pills separated by a divider
function teamPair(a, b) {
  return `<span class="team-pair">
    ${teamPill(a)}
    <span class="team-pair-sep">·</span>
    ${teamPill(b)}
  </span>`;
}

// ─── SIGNAL: extend Arabic dictionary with bet types + market names ─────────
if (window.AJA_I18N && window.AJA_I18N.ar) {
  Object.assign(window.AJA_I18N.ar, {
    // ── Rank tiers (used across leaderboard, balance card, stats) ────
    "rank.legend":       "أسطورة 👑",
    "rank.elite":        "نخبة ⭐",
    "rank.pro":          "محترف 🔵",
    "rank.contender":    "منافس 🟢",
    "rank.amateur":      "هاوٍ 🟡",
    "rank.rookie":       "مبتدئ ⚪",

    // ── Leaderboard row extras ───────────────────────────────────────
    "lb.inPlay":         "في اللعب",
    "lb.viewHistory":    "عرض سجل",
    "lb.cashEligible":   "مؤهل لجوائز نقدية",

    // ── History (own + user modal) ───────────────────────────────────
    "history.title":     "سجل اللاعب",
    "history.titleFor":  "سجل {user}",
    "hist.pick":         "الاختيار",
    "hist.staked":       "المُراهن",
    "hist.odds":         "الاحتمالات",
    "hist.won":          "ربح",
    "hist.lost":         "خسر",
    "hist.correct":      "صحيح",
    "hist.wrong":        "خاطئ",
    "hist.correctDraw":  "صحيح (تعادل)",
    "hist.profit":       "ربح",
    "hist.refunded":     "استرداد الرهان",
    "hist.rr":           "المخاطرة:العائد",
    "hist.roi":          "العائد",
    "hist.accuracy":     "الدقة",

    // ── Card labels used across screens ──────────────────────────────
    "card.result":       "النتيجة",

    // ── Roulette P&L card ────────────────────────────────────────────
    "rpnl.spins":        "دورة",
    "rpnl.spins.2":      "دورتان",
    "rpnl.spins.few":    "دورات",
    "rpnl.spins.many":   "دورة",
    "rpnl.won":          "فائزة",
    "rpnl.wagered":      "مُراهن",
    "rpnl.up":           "ربح",
    "rpnl.down":         "خسارة",
    "rpnl.even":         "متعادل",

    // ── Confirmation label ("N bet(s) placed") ────────────────────────
    "conf.placed":       "تم وضعها",

    // ── Results modal subtitle tail ("...settled since your last visit") ─
    "results.subtitleTail": "سُوّيت منذ آخر زيارة",

    // ── Empty / failure states ───────────────────────────────────────
    "empty.settledBets": "لا توجد رهانات مسواة بعد.",
    "empty.historyFail": "تعذّر تحميل السجل.",

    // ── Bet-builder markets & intro ──────────────────────────────────
    "bb.intro":          "اختر الرهانات، وحدّد المبلغ لكل واحد، ثم قم بوضعها جميعاً.",
    "bb.rule":           "الوقت الإضافي يُحتسب، ركلات الترجيح لا",
    "bb.ruleTip":        "الأهداف المسجلة في الوقت الأصلي والوقت الإضافي تُحتسب في هذا الرهان. أهداف ركلات الترجيح لا تُحتسب.",

    // ── Activity feed (merged with old Stats tab) ────────────────────
    "nav.stats":         "النشاط",
    "activity.title":    "النشاط",
    "activity.feed":     "نشاط الدوري",
    "activity.empty":    "لا يوجد نشاط بعد. ضع رهاناً أو أدر العجلة.",
    "time.now":          "الآن",

    // ── Placed-bets receipt ──────────────────────────────────────────
    "placed.title":      "رهاناتك",
    "placed.staked":     "الرهان الإجمالي",
    "placed.ifWin":      "إذا فازت جميعها",
    "placed.note":       "الإلغاء يعيد رهانك كاملاً. إعادة البناء تستخدم الاحتمالات الحالية.",
    "placed.cancel":     "إلغاء الكل وإعادة البناء",
    "market.result":     "نتيجة المباراة",
    "market.advance":    "التأهل",
    "market.total":      "مجموع الأهداف",
    "market.totalSub":   "أكثر / أقل من ",
    "market.btts":       "الفريقان يسجلان",

    // ── Match card labels (Stage / Time / Predictions close in) ──────
    "card.stage":        "المرحلة",
    "card.time":         "الوقت",
    "card.closesIn":     "إغلاق التوقعات خلال",
    "card.uae":          "بتوقيت الإمارات",
    "card.opensIn":      "يفتح الرهان خلال",
    "card.closesBefore": "يغلق قبل ٥ دقائق من بداية المباراة",
    "card.oddsPending":  "الاحتمالات غير متاحة بعد",
    "card.oddsPendingSub": "يفتح الرهان لهذه المباراة بمجرد تحديد الاحتمالات. تحقق قريباً.",

    // ── The dreaded "pts" ────────────────────────────────────────────
    // Kept short deliberately — long words like "نقاط" break narrow columns.
    // Using "نقطة" (singular, functional) for all counts, matches conventions
    // in Arabic scoring apps and fits in the same visual space.
    "unit.pts":          "نقطة",

    // Bet types & markets (used in live-bets, history, results)
    "bet.matchWinner":   "الفائز بالمباراة",
    "bet.toAdvance":     "التأهل",
    "bet.total":         "مجموع الأهداف",
    "bet.totalOver":     "أكثر من",
    "bet.totalUnder":    "أقل من",
    "bet.btts":          "الفريقان يسجلان",
    "bet.yes":           "نعم",
    "bet.no":            "لا",
    "bet.draw":          "تعادل",
    "bet.stake":         "الرهان",
    "bet.payout":        "الأرباح",
    "bet.profit":        "الربح",
    "bet.won":           "فوز",
    "bet.lost":          "خسارة",
    "bet.pending":       "معلّق",
    "bet.refund":        "استرداد",
    // Results modal
    "results.title":     "بينما كنت غائباً",
    "results.subtitle":  "رهانات تمّت تسويتها منذ آخر زيارة",
    "results.net":       "الصافي",
    "results.correct":   "صحيح",
    "results.staked":    "الرهان الإجمالي",
    "results.balance":   "الرصيد",
    "results.continue":  "متابعة",
    // Live bets
    "live.empty":        "لا توجد رهانات مفتوحة حالياً.",
    "live.staked":       "الرهان الإجمالي",
    "live.betsCount":    "رهان",
    "live.betsCount.2":  "رهانان",
    "live.betsCount.few": "رهانات",
    "live.betsCount.many": "رهان",
    "live.legMain":      "رهان أساسي",
    "live.legSide":      "رهان جانبي",
    "live.will":         "الأرباح المتوقعة",
    // Match card labels
    "match.stage":       "المرحلة",
    "match.venue":       "الملعب",
    "match.starts":      "الانطلاق",
    "match.closes":      "إغلاق التوقعات",
    "match.result":      "النتيجة",
    // Common
    "common.total":      "الإجمالي",
    "common.balance":    "الرصيد",
    "common.at":         "@",
    "common.vs":         "ضد",
    "common.cancel":     "إلغاء",
    "common.close":      "إغلاق",
    "common.yes":        "نعم",
    "common.no":         "لا",
    // Empty / loading states
    "empty.history":     "لا توجد رهانات بعد.",
    "empty.leaderboard": "لا يوجد لاعبون بعد.",
    "empty.matches":     "لا توجد مباريات متاحة.",
  });
}

// Helper: localized bet type label (uses i18n keys or falls back to English).
function localBetType(betType, selected) {
  const lang = localStorage.getItem("aja_lang") || "en";
  const dict = (lang === "ar" && window.AJA_I18N && window.AJA_I18N.ar) ? window.AJA_I18N.ar : null;
  const tr = (key, fallback) => (dict && dict[key]) || fallback;
  const t = (betType || "moneyline").toLowerCase();
  if (t === "total") {
    const side = selected === "OVER" ? tr("bet.totalOver", "Over") : tr("bet.totalUnder", "Under");
    return `${tr("bet.total", "Total Goals")}: ${side}`;
  }
  if (t === "btts") {
    const side = selected === "YES" ? tr("bet.yes", "Yes") : tr("bet.no", "No");
    return `${tr("bet.btts", "Both Teams To Score")}: ${side}`;
  }
  if (selected === "DRAW") return tr("bet.draw", "Draw");
  return null; // caller handles moneyline (team name) case
}


// ═════════════════════════════════════════════════════════════════════════════
// ACTIVITY FEED + LIVE TICKER (v2)
//   • Feed:   48h of RAW events, newest first — the league's full receipts.
//   • Ticker: 24h COLLAPSED — one item per (user, match) with settlement
//             superseding placement, and roulette runs clustered per user
//             ("Ayyoob spun 23× · net −15k"). Distance-based marquee speed.
// Polls every 8s with an id cursor; single buffer feeds both views.
// ═════════════════════════════════════════════════════════════════════════════

let activityBuffer = [];      // raw events, newest first, capped
let activityLastId = 0;
let activityPollTimer = null;

// ─── Number abbreviation for the ticker (feed shows full numbers) ────────────
function abbrevNum(n) {
  const abs = Math.abs(n);
  if (abs >= 1e15) return (n / 1e15).toFixed(1).replace(/\.0$/, "") + "Q";
  if (abs >= 1e12) return (n / 1e12).toFixed(1).replace(/\.0$/, "") + "T";
  if (abs >= 1e9)  return (n / 1e9).toFixed(1).replace(/\.0$/, "")  + "B";
  if (abs >= 1e6)  return (n / 1e6).toFixed(1).replace(/\.0$/, "")  + "M";
  if (abs >= 1e4)  return (n / 1e3).toFixed(1).replace(/\.0$/, "")  + "k";
  return n.toLocaleString();
}

// ─── Collapse reducer for the ticker ─────────────────────────────────────────
// Rules:
//  • Bet events group by (username, matchId). If the group contains a
//    settlement (WON/LOST/REFUND), only the settlement shows. Otherwise the
//    latest placement state shows. Cancel-with-nothing-after vanishes.
//  • Roulette groups by username: 1 spin → normal item; 2+ spins → cluster
//    "spun N× · net ±X".
//  • Output ordered by each group's most recent event, newest first.
function collapseForTicker(events) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = events.filter(e => {
    const t = new Date(e.createdAt).getTime();
    return !isNaN(t) && t >= cutoff;
  });

  const betGroups = new Map();   // "user|matchId" → events[]
  const rouGroups = new Map();   // "user" → events[]

  recent.forEach(ev => {
    if (ev.reason === "ROULETTE_SPIN") {
      const k = ev.username;
      if (!rouGroups.has(k)) rouGroups.set(k, []);
      rouGroups.get(k).push(ev);
    } else {
      const mid = (ev.meta && ev.meta.matchId) || "?";
      const k = `${ev.username}|${mid}`;
      if (!betGroups.has(k)) betGroups.set(k, []);
      betGroups.get(k).push(ev);
    }
  });

  const items = [];

  betGroups.forEach(group => {
    // newest first already (buffer order); collect ALL settlements if present
    const settles = group.filter(e => e.reason === "BET_WON" || e.reason === "BET_LOST" || e.reason === "BET_REFUND");
    if (settles.length === 1) {
      items.push({ ev: settles[0], at: new Date(group[0].createdAt).getTime() });
      return;
    }
    if (settles.length > 1) {
      // Merge into one line: components + net. e.g. 2 wins + 1 loss on the
      // same match reads "won +10.6k +6.2k −8.2k · net +8.6k" instead of
      // three separate ticker items (or worse, only one of them).
      const net = settles.reduce((s, e) => s + (e.delta || 0), 0);
      const parts = settles.map(e => e.delta || 0).sort((a, b) => b - a); // wins first
      const m = settles[0].meta || {};
      items.push({
        ev: {
          reason: "SETTLE_GROUP",
          username: settles[0].username,
          delta: net,
          meta: { team_a: m.team_a, team_b: m.team_b, matchId: m.matchId, parts }
        },
        at: new Date(group[0].createdAt).getTime()
      });
      return;
    }
    // No settlement: latest placement wins; if the chain ends in a cancel → skip
    const latest = group[0];
    if (latest.reason === "BET_CANCELLED") return;
    items.push({ ev: latest, at: new Date(latest.createdAt).getTime() });
  });

  rouGroups.forEach((group, user) => {
    const at = new Date(group[0].createdAt).getTime();
    if (group.length === 1) { items.push({ ev: group[0], at }); return; }
    const net = group.reduce((s, e) => s + (e.delta || 0), 0);
    items.push({ ev: { reason: "ROULETTE_CLUSTER", username: user, delta: net, meta: { spins: group.length } }, at });
  });

  items.sort((a, b) => b.at - a.at);
  return items.map(i => i.ev);
}

// ─── Event → display text ────────────────────────────────────────────────────
function formatActivityEvent(ev, opts = {}) {
  const short = opts.short === true;
  const num = short ? abbrevNum : (n) => Math.abs(n).toLocaleString();
  const meta = ev.meta || {};
  const name = ev.username || "?";
  const pair = (meta.team_a && meta.team_b) ? `${teamCode(meta.team_a)}-${teamCode(meta.team_b)}` : "";

  let icon = "•", cls = "neutral", text = "";

  switch (ev.reason) {
    case "BET_PLACED": {
      icon = "⚽"; cls = "neutral";
      const stake = num(Math.abs(ev.delta));
      text = short
        ? `<b>${name}</b> bet <b>${stake}</b> on ${pickDisplay(meta)}`
        : `<b>${name}</b> placed a bet on <b>${pair}</b> — ${pickDisplay(meta)} · ${Math.abs(ev.delta).toLocaleString()} pts${meta.odds ? " @ " + Number(meta.odds).toFixed(2) + "x" : ""}`;
      break;
    }
    case "BET_WON": {
      icon = "✅"; cls = "up";
      text = short
        ? `<b>${name}</b> won <b>+${num(ev.delta)}</b> on ${pair}`
        : `<b>${name}</b> won <b>+${ev.delta.toLocaleString()} pts</b> on <b>${pair}</b> — picked ${pickDisplay(meta)}${meta.odds ? " @ " + Number(meta.odds).toFixed(2) + "x" : ""}`;
      break;
    }
    case "BET_LOST": {
      icon = "❌"; cls = "down";
      text = short
        ? `<b>${name}</b> lost <b>${num(Math.abs(ev.delta))}</b> on ${pair}`
        : `<b>${name}</b> lost <b>${Math.abs(ev.delta).toLocaleString()} pts</b> on <b>${pair}</b> — picked ${pickDisplay(meta)}${meta.result ? " · result " + meta.result : ""}`;
      break;
    }
    case "BET_REFUND": {
      icon = "↩"; cls = "neutral";
      const back = meta.stake || 0;
      text = short
        ? `<b>${name}</b> refunded <b>${num(back)}</b>`
        : `<b>${name}</b> was refunded <b>${back.toLocaleString()} pts</b> on <b>${pair}</b>`;
      break;
    }
    case "BET_CANCELLED": {
      icon = "↺"; cls = "neutral";
      const cnt = meta.count || 1;
      text = short
        ? `<b>${name}</b> cancelled ${cnt} on ${pair}`
        : `<b>${name}</b> cancelled ${cnt} bet${cnt > 1 ? "s" : ""} on <b>${pair}</b> — refunded ${ev.delta.toLocaleString()} pts`;
      break;
    }
    case "ROULETTE_SPIN": {
      icon = "🎰"; cls = ev.delta > 0 ? "up" : (ev.delta < 0 ? "down" : "neutral");
      const sign = ev.delta > 0 ? "+" : (ev.delta < 0 ? "−" : "±");
      text = short
        ? `<b>${name}</b> spun <b>${sign}${num(Math.abs(ev.delta))}</b>`
        : `<b>${name}</b> ${ev.delta >= 0 ? "won" : "lost"} <b>${sign}${Math.abs(ev.delta).toLocaleString()} pts</b> on roulette — picked ${meta.pick || "?"}, landed on ${meta.result || "?"}`;
      break;
    }
    case "SETTLE_GROUP": {
      // Multiple bets on one match settled together — one merged line:
      // components (wins first, then losses) followed by the net.
      // With a single part, skip the redundant breakdown.
      const net = ev.delta || 0;
      icon = net > 0 ? "✅" : (net < 0 ? "❌" : "↩");
      cls = net > 0 ? "up" : (net < 0 ? "down" : "neutral");
      const verb = net > 0 ? "won" : (net < 0 ? "lost" : "broke even");
      const netSign = net > 0 ? "+" : (net < 0 ? "−" : "");
      const partList = meta.parts || [];
      const parts = partList.map(p => {
        const s = p > 0 ? "+" : (p < 0 ? "−" : "±");
        return `${s}${num(Math.abs(p))}`;
      }).join(" ");
      const showParts = partList.length > 1;
      text = short
        ? `<b>${name}</b> ${verb} <b>${netSign}${num(Math.abs(net))}</b> on ${pair}${showParts ? ` (${parts})` : ""}`
        : `<b>${name}</b> ${verb} <b>${netSign}${Math.abs(net).toLocaleString()} pts</b> on <b>${pair}</b>${showParts ? ` — ${parts} · net ${netSign}${Math.abs(net).toLocaleString()}` : ""}`;
      break;
    }
    case "ROULETTE_CLUSTER": {
      icon = "🎰"; cls = ev.delta > 0 ? "up" : (ev.delta < 0 ? "down" : "neutral");
      const sign = ev.delta > 0 ? "+" : (ev.delta < 0 ? "−" : "±");
      text = `<b>${name}</b> spun ${meta.spins}× · net <b>${sign}${num(Math.abs(ev.delta))}</b>`;
      break;
    }
    default:
      text = `<b>${name}</b> — ${ev.reason}`;
  }
  return { icon, cls, text };
}

function pickDisplay(meta) {
  if (!meta || !meta.pick) return "?";
  const type = (meta.betType || "moneyline").toLowerCase();
  if (type === "total") return `Total ${meta.pick}`;
  if (type === "btts") return `BTTS ${meta.pick}`;
  if (meta.pick === "DRAW") return "Draw";
  return `${teamCode(meta.pick)}`;
}

// ─── Polling ─────────────────────────────────────────────────────────────────
async function pollActivityFeed() {
  const token = localStorage.getItem("token");
  if (!token) return;
  // Skip network work while the tab is hidden — resumes on visibilitychange.
  if (document.hidden) return;
  try {
    const url = activityLastId > 0
      ? `${API}/activity-feed?since=${activityLastId}&hours=48&limit=200`
      : `${API}/activity-feed?hours=48&limit=200`;
    const res = await fetch(url, { headers: { "Authorization": token } });
    if (!res.ok) return;
    const events = await res.json();
    if (!Array.isArray(events) || events.length === 0) return;

    // Normalize timestamps: Postgres TIMESTAMP (no tz) serializes as
    // "2026-07-07 20:00:00.123" which JS parses as LOCAL time — on a UAE
    // phone that's 4h wrong. Tag it as UTC before it enters the buffer.
    events.forEach(e => {
      if (e.createdAt && typeof e.createdAt === "string" &&
          !/Z$|[+-]\d\d:?\d\d$/.test(e.createdAt)) {
        e.createdAt = e.createdAt.replace(" ", "T") + "Z";
      }
    });

    // Merge, dedupe by id (poll overlap safety), and hard-sort newest-first.
    // Relying on append order alone let interleaved polls scramble the feed.
    const byId = new Map();
    [...activityBuffer, ...events].forEach(e => byId.set(e.id, e));
    // Second pass: content-signature dedupe. Protects against the same event
    // existing under two different ids (double-logged rows, backfill overlap).
    // Signature = who + what + how much + when-TO-THE-SECOND. Duplicate rows
    // from a backfill carry the same event time but differ by milliseconds,
    // so the timestamp is truncated to the second before comparison.
    const bySig = new Map();
    byId.forEach(e => {
      const ts = (e.createdAt || "").slice(0, 19); // "2026-07-12T19:34:12" — drop ms
      const sig = `${e.username}|${e.reason}|${e.delta}|${ts}`;
      const prev = bySig.get(sig);
      if (!prev || e.id < prev.id) bySig.set(sig, e); // keep the earliest row
    });
    activityBuffer = [...bySig.values()].sort((a, b) => b.id - a.id).slice(0, 400);
    activityLastId = Math.max(activityLastId, ...events.map(e => e.id));

    renderActivityTicker();
    const stats = document.getElementById("statsSection");
    if (stats && !stats.classList.contains("hidden")) renderActivityFeed();
  } catch (_) { /* transient, retry next tick */ }
}

function startActivityPolling() {
  if (activityPollTimer) return;
  pollActivityFeed();
  activityPollTimer = setInterval(pollActivityFeed, 8000);
}
function stopActivityPolling() {
  if (activityPollTimer) { clearInterval(activityPollTimer); activityPollTimer = null; }
  activityBuffer = [];
  activityLastId = 0;
}
// Immediate refresh when the tab comes back into focus.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && activityPollTimer) pollActivityFeed();
});

// ─── Ticker (24h collapsed, distance-based marquee speed) ────────────────────
const TICKER_SPEED_PX_S = 55; // higher = faster scroll

function renderActivityTicker() {
  const el = document.getElementById("feedTicker");
  const track = document.getElementById("feedTickerTrack");
  if (!el || !track) return;

  const collapsed = collapseForTicker(activityBuffer).slice(0, 14);
  if (collapsed.length === 0) { el.hidden = true; return; }
  el.hidden = false;

  const items = collapsed.map(ev => {
    const f = formatActivityEvent(ev, { short: true });
    return `<span class="feed-ticker-item feed-${f.cls}"><span class="feed-icon">${f.icon}</span>${f.text}</span>`;
  }).join("");

  // Cache-check on the RAW items (before any padding) so unchanged content
  // doesn't restart the animation.
  if (track.dataset.content === items) return;
  track.dataset.content = items;

  // Measure: render one copy invisibly to get its width, then repeat it enough
  // times to exceed the viewport width. This guarantees the two loop-copies
  // never both fit on screen — otherwise a single short item visibly doubles.
  track.style.animation = "none";
  track.innerHTML = `<span class="feed-ticker-copy">${items}</span>`;
  requestAnimationFrame(() => {
    const oneCopyWidth = track.scrollWidth;
    const minWidth = Math.max(el.clientWidth * 1.2, 1); // fill at least 120% of strip
    const repeats = Math.max(1, Math.ceil(minWidth / Math.max(oneCopyWidth, 1)));
    const padded = items.repeat(repeats);
    // EXACTLY two copy-wrappers. Each wrapper carries its own inter-item gap
    // and a trailing pad equal to that gap, so the seam between copy 2 and the
    // wrapped-around copy 1 is indistinguishable from any other gap. The
    // -50% keyframe then lands precisely on one copy width — no visible reset.
    track.innerHTML =
      `<span class="feed-ticker-copy">${padded}</span>` +
      `<span class="feed-ticker-copy">${padded}</span>`;

    requestAnimationFrame(() => {
      const distance = track.scrollWidth / 2;
      const secs = Math.max(12, distance / TICKER_SPEED_PX_S);
      track.style.animation = `feedMarquee ${secs}s linear infinite`;
    });
  });
}

// ─── Feed (48h raw, newest first) ────────────────────────────────────────────
// Feed-specific reducer: keep every event (placements, cancels, spins) but
// merge SETTLEMENTS of the same user+match into one SETTLE_GROUP row — the
// win and the loss on one match reading as separate rows was confusing.
function mergeFeedSettlements(events) {
  const out = [];
  const grouped = new Map(); // "user|matchId" → index in out[] of the group row

  events.forEach(ev => {
    const isSettle = ev.reason === "BET_WON" || ev.reason === "BET_LOST" || ev.reason === "BET_REFUND";
    if (!isSettle) { out.push(ev); return; }

    const mid = (ev.meta && ev.meta.matchId) || "?";
    const key = `${ev.username}|${mid}`;

    if (!grouped.has(key)) {
      // First settlement seen for this user+match: start a group in place.
      const groupEv = {
        reason: "SETTLE_GROUP",
        username: ev.username,
        delta: ev.delta || 0,
        createdAt: ev.createdAt,
        meta: {
          team_a: ev.meta && ev.meta.team_a,
          team_b: ev.meta && ev.meta.team_b,
          matchId: mid,
          parts: [ev.delta || 0]
        }
      };
      grouped.set(key, out.length);
      out.push(groupEv);
    } else {
      // Fold into the existing group row.
      const g = out[grouped.get(key)];
      g.delta += (ev.delta || 0);
      g.meta.parts.push(ev.delta || 0);
      g.meta.parts.sort((a, b) => b - a); // wins first
    }
  });

  // Single-settlement groups: unwrap back to the original single-reason look
  // by leaving them as SETTLE_GROUP with one part — the formatter reads fine
  // either way, but net == the single delta so nothing is lost.
  return out;
}

function renderActivityFeed() {
  const list = document.getElementById("activityFeed");
  if (!list) return;
  if (activityBuffer.length === 0) {
    list.innerHTML = `<div class="feed-empty">${L("activity.empty","No activity yet. Place a bet or spin the wheel.")}</div>`;
    return;
  }
  const merged = mergeFeedSettlements(activityBuffer);
  list.innerHTML = merged.map((ev, i) => {
    const f = formatActivityEvent(ev, { short: false });
    const when = feedWhen(ev.createdAt);
    // Stagger-in animation only for the first 10 rows on initial paint.
    const delay = i < 10 ? ` style="animation-delay:${i * 30}ms"` : "";
    return `
      <div class="feed-row feed-${f.cls} feed-enter"${delay} onclick="showUserHistory('${(ev.username || '').replace(/'/g,"\\'")}')">
        <div class="feed-row-icon">${f.icon}</div>
        <div class="feed-row-body">
          <div class="feed-row-text">${f.text}</div>
          <div class="feed-row-when">${when}</div>
        </div>
      </div>
    `;
  }).join("");
}

function loadActivityFeed() { renderActivityFeed(); }

function timeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 30)     return L("time.now","now");
  if (secs < 60)     return `${secs}s`;
  if (secs < 3600)   return `${Math.floor(secs / 60)}m`;
  if (secs < 86400)  return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

// Full feed timestamp: relative + exact UAE clock time.
// <24h old:  "2h · 21:43"   ·   older: "07 Jul · 21:43"
function feedWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const clock = d.toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Dubai"
  });
  const ageSecs = (Date.now() - d.getTime()) / 1000;
  if (ageSecs < 86400) return `${timeAgo(iso)} · ${clock}`;
  const day = d.toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", timeZone: "Asia/Dubai"
  });
  return `${day} · ${clock}`;
}
