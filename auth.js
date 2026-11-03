/**
 * auth.js — Modulo Autenticazione e Gestione Operatori VNSR
 * Gestisce i 4 profili operatore predefiniti/personalizzati, la mappa dei codici PIN,
 * la schermata di blocco PIN all'avvio con verifica automatica a 4 cifre (`initAuthGate`)
 * e l'aggiornamento dell'indicatore operatore nell'header (`updateOperatorUI`).
 */

import {
  state,
  recordActivity,
  saveApplicationData,
  renderAll,
  showToast
} from "./main.js";

// ==================== PROFILI OPERATORE PREDEFINITI ====================
export const DEFAULT_PROFILES = [
  { id: "prof_1", code: "0070", name: "Losco", role: "Executive Label Manager" },
  { id: "prof_2", code: "0001", name: "Blacklord", role: "A&R & Produzione" },
  { id: "prof_3", code: "0002", name: "Riovale", role: "Direzione Artistica" },
  { id: "prof_4", code: "0003", name: "Operatore 0003", role: "Management & Catalogo" }
];

export const DEFAULT_OPERATORS = {
  "0070": { id: "prof_1", code: "0070", name: "Losco", role: "Executive Label Manager" },
  "0001": { id: "prof_2", code: "0001", name: "Blacklord", role: "A&R & Produzione" },
  "0002": { id: "prof_3", code: "0002", name: "Riovale", role: "Direzione Artistica" },
  "0003": { id: "prof_4", code: "0003", name: "Operatore 0003", role: "Management & Catalogo" }
};

/**
 * Restituisce la lista ordinata dei 4 profili operatore attivi (da state o localStorage)
 */
export function getProfilesList() {
  try {
    if (state && Array.isArray(state.operatorProfiles) && state.operatorProfiles.length === 4) {
      return state.operatorProfiles.map((p, idx) => ({
        id: p.id || DEFAULT_PROFILES[idx].id,
        code: String(p.code || DEFAULT_PROFILES[idx].code).trim(),
        name: String(p.name || DEFAULT_PROFILES[idx].name).trim(),
        role: String(p.role || DEFAULT_PROFILES[idx].role).trim(),
        updatedAt: p.updatedAt || ""
      }));
    }
    const savedV2 = JSON.parse(localStorage.getItem("vnsr_operator_profiles_v2") || "null");
    if (Array.isArray(savedV2) && savedV2.length === 4) {
      return savedV2.map((p, idx) => ({
        id: p.id || DEFAULT_PROFILES[idx].id,
        code: String(p.code || DEFAULT_PROFILES[idx].code).trim(),
        name: String(p.name || DEFAULT_PROFILES[idx].name).trim(),
        role: String(p.role || DEFAULT_PROFILES[idx].role).trim(),
        updatedAt: p.updatedAt || ""
      }));
    }
    const legacyCustom = JSON.parse(localStorage.getItem("vnsr_custom_operators") || "{}");
    return DEFAULT_PROFILES.map((def) => ({
      ...def,
      name: legacyCustom[def.code] && legacyCustom[def.code].trim() ? legacyCustom[def.code].trim() : def.name
    }));
  } catch (_) {
    return DEFAULT_PROFILES.map((d) => ({ ...d }));
  }
}

/**
 * Salva l'array dei 4 profili operatore in localStorage e nello stato condiviso
 */
export function saveProfilesList(profilesArray) {
  const nowIso = new Date().toISOString();
  const normalized = DEFAULT_PROFILES.map((def, idx) => {
    const incoming = (profilesArray && profilesArray[idx]) || {};
    return {
      id: def.id,
      code: String(incoming.code || def.code).trim(),
      name: String(incoming.name || def.name).trim(),
      role: String(incoming.role || def.role).trim(),
      updatedAt: incoming.updatedAt || nowIso
    };
  });
  localStorage.setItem("vnsr_operator_profiles_v2", JSON.stringify(normalized));
  if (state) {
    state.operatorProfiles = normalized;
  }
  return normalized;
}

/**
 * Costruisce una mappa { [codicePin]: profilo } per la verifica rapida del PIN
 */
export function getOperatorsMap() {
  try {
    const profiles = getProfilesList();
    const map = {};
    for (const p of profiles) {
      if (p && p.code) {
        map[p.code] = { ...p };
      }
    }
    return map;
  } catch (_) {
    return { ...DEFAULT_OPERATORS };
  }
}

// ==================== AUTENTICAZIONE CODICE OPERATORE (PIN GATE) ====================
/**
 * Inizializza la schermata di accesso con tastierino numerico e verifica automatica
 * non appena vengono inserite 4 cifre (cancellando automaticamente i caratteri se errato).
 */
export function initAuthGate() {
  const overlay = document.getElementById("authOverlay");
  const pinInput = document.getElementById("pinInput");
  const pinError = document.getElementById("pinError");
  const submitBtn = document.getElementById("loginSubmitBtn");
  const switchBtn = document.getElementById("switchOperatorBtn");
  let autoCheckTimer = null;

  function triggerPinErrorShake() {
    pinInput.classList.remove("pin-input-shake");
    void pinInput.offsetWidth;
    pinInput.classList.add("pin-input-shake");
  }

  function attemptLogin() {
    if (autoCheckTimer) {
      clearTimeout(autoCheckTimer);
      autoCheckTimer = null;
    }
    const code = pinInput.value.trim();
    if (code.length < 4) return;

    const operators = getOperatorsMap();
    const matched = operators[code];

    if (!matched) {
      pinError.textContent = "Codice PIN errato. Inserisci un codice operatore valido.";
      triggerPinErrorShake();
      // Cancella automaticamente i 4 caratteri errati per permettere subito il reinserimento
      pinInput.value = "";
      pinInput.focus();
      return;
    }

    state.currentOperator = matched;
    sessionStorage.setItem("vnsr_active_operator_code", code);
    pinError.textContent = "";
    pinInput.value = "";
    overlay.classList.add("hidden");

    updateOperatorUI();
    recordActivity(`Accesso effettuato in VNSR da ${matched.name}`);
    renderAll();
    showToast(`Benvenuto in VNSR, ${matched.name} (${matched.code})`);
    saveApplicationData();
  }

  function scheduleAutoVerifyIfFourDigits() {
    if (autoCheckTimer) {
      clearTimeout(autoCheckTimer);
      autoCheckTimer = null;
    }
    if (pinInput.value.length === 4) {
      autoCheckTimer = setTimeout(() => {
        attemptLogin();
      }, 90);
    }
  }

  overlay.querySelectorAll(".key-btn[data-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      pinError.textContent = "";
      if (key === "clear") {
        pinInput.value = "";
      } else if (key === "backspace") {
        pinInput.value = pinInput.value.slice(0, -1);
      } else if (key === "enter") {
        attemptLogin();
      } else if (pinInput.value.length < 4) {
        pinInput.value += key;
        scheduleAutoVerifyIfFourDigits();
      }
      pinInput.focus();
    });
  });

  // Verifica automatica immediata appena vengono digitate 4 cifre da tastiera
  pinInput.addEventListener("input", () => {
    const cleanDigits = pinInput.value.replace(/\D/g, "").slice(0, 4);
    if (pinInput.value !== cleanDigits) {
      pinInput.value = cleanDigits;
    }
    if (cleanDigits.length > 0 && cleanDigits.length < 4) {
      pinError.textContent = "";
    }
    scheduleAutoVerifyIfFourDigits();
  });

  // Permette di digitare le 4 cifre da tastiera anche senza aver prima cliccato nella casella PIN
  document.addEventListener("keydown", (e) => {
    if (overlay.classList.contains("hidden")) return;
    if (document.activeElement === pinInput) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      pinError.textContent = "";
      if (pinInput.value.length < 4) {
        pinInput.value += e.key;
        pinInput.focus();
        scheduleAutoVerifyIfFourDigits();
      }
    } else if (e.key === "Backspace") {
      e.preventDefault();
      pinInput.value = pinInput.value.slice(0, -1);
      pinInput.focus();
    }
  });

  if (submitBtn) {
    submitBtn.addEventListener("click", attemptLogin);
  }

  switchBtn.addEventListener("click", () => {
    sessionStorage.removeItem("vnsr_active_operator_code");
    state.currentOperator = null;
    pinError.textContent = "";
    pinInput.value = "";
    overlay.classList.remove("hidden");
    setTimeout(() => pinInput.focus(), 80);
  });

  const savedCode = sessionStorage.getItem("vnsr_active_operator_code");
  const operators = getOperatorsMap();
  if (savedCode && operators[savedCode]) {
    state.currentOperator = operators[savedCode];
    overlay.classList.add("hidden");
    updateOperatorUI();
  } else {
    setTimeout(() => pinInput.focus(), 80);
  }
}

/**
 * Aggiorna i badge del nome e del codice operatore attivo nella barra superiore
 */
export function updateOperatorUI() {
  const op = state.currentOperator;
  const nameEl = document.getElementById("activeOperatorName");
  const codeEl = document.getElementById("activeOperatorCode");
  if (!nameEl || !codeEl) return;

  if (op) {
    nameEl.textContent = op.name;
    codeEl.textContent = `#${op.code}`;
  } else {
    nameEl.textContent = "—";
    codeEl.textContent = "----";
  }
}
