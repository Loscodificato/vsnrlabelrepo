/**
 * settings.js — Modulo Cartella Impostazioni e Gestione dei 4 Profili Operatore VNSR
 * Gestisce l'apertura della Cartella Impostazioni, la navigazione tra le sottoviste
 * (`home`, `pinGate`, `editor`), la protezione tramite PIN per accedere a "Impostazione Profili"
 * e la modifica diretta di Nome, Ruolo e Codice PIN a 4 cifre per tutti i 4 profili.
 */

import {
  state,
  escapeHtml,
  showToast,
  recordActivity,
  saveApplicationData,
  renderAll
} from "./main.js";

import {
  DEFAULT_PROFILES,
  getProfilesList,
  saveProfilesList,
  getOperatorsMap,
  updateOperatorUI,
  stripPinCodes // IMPORTATO per coerenza
} from "./auth.js";

import { openAppleAuthModal } from "./calendar.js";

export function showSettingsSubView(viewName) {
  const settingsHomeView = document.getElementById("settingsHomeView");
  const settingsPinGateView = document.getElementById("settingsProfilesPinGateView");
  const settingsProfilesEditorView = document.getElementById("settingsProfilesEditorView");
  const settingsModalTitle = document.getElementById("settingsModalTitle");
  const settingsModalSubtitle = document.getElementById("settingsModalSubtitle");
  const settingsGatePinInput = document.getElementById("settingsGatePinInput");
  const settingsGatePinError = document.getElementById("settingsGatePinError");
  const profilesEditorError = document.getElementById("profilesEditorError");

  if (!settingsHomeView || !settingsPinGateView || !settingsProfilesEditorView) return;

  settingsHomeView.style.display = viewName === "home" ? "block" : "none";
  settingsPinGateView.style.display = viewName === "pinGate" ? "block" : "none";
  settingsProfilesEditorView.style.display = viewName === "editor" ? "block" : "none";

  if (viewName === "home") {
    if (settingsModalTitle) settingsModalTitle.textContent = "📁 Cartella Impostazioni";
    if (settingsModalSubtitle) {
      settingsModalSubtitle.textContent =
        "Pannello di configurazione generale e gestione profili operatore VNSR";
    }
  } else if (viewName === "pinGate") {
    if (settingsModalTitle) settingsModalTitle.textContent = "🔐 Accesso a Impostazione Profili";
    if (settingsModalSubtitle) {
      settingsModalSubtitle.textContent =
        "Inserisci uno dei 4 codici PIN abilitati per entrare nella gestione dei profili";
    }
    if (settingsGatePinInput) {
      settingsGatePinInput.value = "";
      setTimeout(() => settingsGatePinInput.focus(), 80);
    }
    if (settingsGatePinError) settingsGatePinError.textContent = "";
  } else if (viewName === "editor") {
    if (settingsModalTitle) settingsModalTitle.textContent = "👥 Impostazione Profili (4 Profili VNSR)";
    if (settingsModalSubtitle) {
      settingsModalSubtitle.textContent =
        "Modifica direttamente i 4 profili e i relativi codici PIN senza reinserire il codice attuale";
    }
    if (profilesEditorError) profilesEditorError.textContent = "";
    renderProfilesEditorCards();
  }
}
window.showSettingsSubView = showSettingsSubView;

export function renderProfilesEditorCards() {
  const grid = document.getElementById("profilesEditorGrid");
  if (!grid) return;
  const profiles = getProfilesList();

  grid.innerHTML = profiles
    .map(
      (prof, idx) => `
      <div class="profile-editor-card">
        <div class="profile-editor-card-head">
          <span class="profile-slot-tag">Profilo 0${idx + 1}</span>
          <span style="font-size: 11.5px; color: var(--text-muted);">ID: <code>${escapeHtml(prof.id)}</code></span>
        </div>

        <div class="form-group" style="margin-bottom: 4px;">
          <label for="profNameInput_${idx}">Nome Profilo / Operatore *</label>
          <input
            type="text"
            id="profNameInput_${idx}"
            class="form-control"
            value="${escapeHtml(stripPinCodes(prof.name))}" 
            placeholder="Es. Losco"
            required
          />
        </div>

        <div class="form-group" style="margin-bottom: 4px;">
          <label for="profRoleInput_${idx}">Ruolo / Qualifica Etichetta</label>
          <input
            type="text"
            id="profRoleInput_${idx}"
            class="form-control"
            value="${escapeHtml(prof.role || "")}"
            placeholder="Es. Executive Label Manager"
          />
        </div>

        <div class="form-group" style="margin-bottom: 0;">
          <label for="profCodeInput_${idx}" style="color: #f3c4ff;">
            🔑 Codice PIN d'Accesso (4 Cifre) *
          </label>
          <input
            type="text"
            id="profCodeInput_${idx}"
            class="form-control profile-pin-input-field"
            maxlength="4"
            inputmode="numeric"
            pattern="[0-9]{4}"
            value="${escapeHtml(prof.code)}"
            placeholder="0000"
            required
          />
        </div>
      </div>
    `
    )
    .join("");
}

export function attemptUnlockProfilesSettings() {
  const settingsGatePinInput = document.getElementById("settingsGatePinInput");
  const settingsGatePinError = document.getElementById("settingsGatePinError");
  if (!settingsGatePinInput) return;

  const enteredPin = settingsGatePinInput.value.trim();
  const operatorsMap = getOperatorsMap();
  const matchedProfile = operatorsMap[enteredPin];

  if (!matchedProfile) {
    if (settingsGatePinError) {
      settingsGatePinError.textContent =
        "❌ Codice PIN negato. L'accesso a Impostazione Profili è consentito SOLO con uno dei 4 codici profilo attivi.";
    }
    settingsGatePinInput.value = "";
    settingsGatePinInput.focus();
    return;
  }

  if (settingsGatePinError) settingsGatePinError.textContent = "";
  settingsGatePinInput.value = "";
  showSettingsSubView("editor");
  showToast(`🔓 Impostazione Profili sbloccata con il codice di ${stripPinCodes(matchedProfile.name)}`);
}

export function initSettingsEvents() {
  const settingsModal = document.getElementById("settingsModal");
  const settingsGatePinInput = document.getElementById("settingsGatePinInput");
  const settingsGatePinError = document.getElementById("settingsGatePinError");
  const profilesEditorError = document.getElementById("profilesEditorError");

  document.getElementById("openSettingsBtn")?.addEventListener("click", () => {
    showSettingsSubView("home");
    settingsModal?.classList.add("open");
  });

  document.getElementById("openProfileSettingsItemBtn")?.addEventListener("click", () => {
    showSettingsSubView("pinGate");
  });

  document.getElementById("settingsOpenSyncBtn")?.addEventListener("click", () => {
    settingsModal?.classList.remove("open");
    document.getElementById("openSyncModalBtn")?.click();
  });

  document.getElementById("settingsOpenAppleCalBtn")?.addEventListener("click", () => {
    settingsModal?.classList.remove("open");
    openAppleAuthModal();
  });

  document.getElementById("backToSettingsHomeFromGateBtn")?.addEventListener("click", () => {
    showSettingsSubView("home");
  });

  document.getElementById("backToSettingsHomeFromEditorBtn")?.addEventListener("click", () => {
    showSettingsSubView("home");
  });

  document.getElementById("unlockProfilesSettingsBtn")?.addEventListener("click", attemptUnlockProfilesSettings);

  if (settingsGatePinInput) {
    settingsGatePinInput.addEventListener("input", () => {
      const cleanDigits = settingsGatePinInput.value.replace(/\D/g, "").slice(0, 4);
      if (settingsGatePinInput.value !== cleanDigits) {
        settingsGatePinInput.value = cleanDigits;
      }
      if (cleanDigits.length > 0 && cleanDigits.length < 4 && settingsGatePinError) {
        settingsGatePinError.textContent = "";
      }
      if (cleanDigits.length === 4) {
        setTimeout(attemptUnlockProfilesSettings, 90);
      }
    });

    settingsGatePinInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        attemptUnlockProfilesSettings();
      }
    });
  }

  document.querySelectorAll(".settings-gate-key").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!settingsGatePinInput) return;
      const key = btn.dataset.skey;
      if (settingsGatePinError) settingsGatePinError.textContent = "";
      if (key === "clear") {
        settingsGatePinInput.value = "";
      } else if (key === "enter") {
        attemptUnlockProfilesSettings();
      } else if (settingsGatePinInput.value.length < 4) {
        settingsGatePinInput.value += key;
        if (settingsGatePinInput.value.length === 4) {
          setTimeout(attemptUnlockProfilesSettings, 120);
        }
      }
    });
  });

  const profilesManagementForm = document.getElementById("profilesManagementForm");
  if (profilesManagementForm) {
    profilesManagementForm.addEventListener("submit", (e) => {
      e.preventDefault();
      if (profilesEditorError) profilesEditorError.textContent = "";

      const currentProfiles = getProfilesList();
      const updatedProfiles = [];
      const seenCodes = new Set();
      const nowIso = new Date().toISOString();

      for (let i = 0; i < 4; i++) {
        const nameVal = (document.getElementById(`profNameInput_${i}`)?.value || "").trim();
        const roleVal = (document.getElementById(`profRoleInput_${i}`)?.value || "").trim();
        const codeVal = (document.getElementById(`profCodeInput_${i}`)?.value || "").trim();

        if (!nameVal) {
          if (profilesEditorError) {
            profilesEditorError.textContent = `⚠️ Inserisci il nome per il Profilo 0${i + 1}.`;
          }
          return;
        }
        if (!/^\d{4}$/.test(codeVal)) {
          if (profilesEditorError) {
            profilesEditorError.textContent = `⚠️ Il codice PIN del Profilo 0${i + 1} (${nameVal}) deve essere composto esattamente da 4 cifre numeriche.`;
          }
          return;
        }
        if (seenCodes.has(codeVal)) {
          if (profilesEditorError) {
            profilesEditorError.textContent = `⚠️ Il codice PIN "${codeVal}" è duplicato. Ogni profilo deve avere un codice a 4 cifre unico.`;
          }
          return;
        }
        seenCodes.add(codeVal);

        updatedProfiles.push({
          id: currentProfiles[i]?.id || DEFAULT_PROFILES[i].id,
          name: nameVal,
          role: roleVal || DEFAULT_PROFILES[i].role,
          code: codeVal,
          updatedAt: nowIso
        });
      }

      const savedList = saveProfilesList(updatedProfiles);

      if (state.currentOperator) {
        const activeMatch =
          savedList.find((p) => p.id && p.id === state.currentOperator.id) ||
          savedList.find((p) => p.code === state.currentOperator.code);
        if (activeMatch) {
          state.currentOperator = activeMatch;
          sessionStorage.setItem("vnsr_active_operator_code", activeMatch.code);
          updateOperatorUI();
        }
      }

      recordActivity(
        `Aggiornati i 4 profili operatore e codici PIN in Impostazione Profili: ${savedList
          .map((p) => `${stripPinCodes(p.name)}`)
          .join(", ")}`
      );

      settingsModal?.classList.remove("open");
      renderAll();
      showToast("✅ I 4 profili e i nuovi codici PIN sono stati salvati e sincronizzati!");
      saveApplicationData();
    });
  }

  document.getElementById("resetDefaultProfilesBtn")?.addEventListener("click", () => {
    const defaultsCopy = DEFAULT_PROFILES.map((d) => ({ ...d, updatedAt: new Date().toISOString() }));
    saveProfilesList(defaultsCopy);
    renderProfilesEditorCards();
    showToast("↺ Campi ripristinati ai 4 profili e codici predefiniti (clicca Salva per confermare).");
  });
}