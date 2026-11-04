/**
 * auth.js — Modulo Autenticazione e Gestione Operatori VNSR
 */
import { state, recordActivity, saveApplicationData, renderAll, showToast } from "./main.js";

export const DEFAULT_PROFILES = [
  { id: "prof_1", code: "0070", name: "Losco", role: "Executive Label Manager" },
  { id: "prof_2", code: "0001", name: "Blacklord", role: "A&R & Produzione" },
  { id: "prof_3", code: "0002", name: "Riovale", role: "Direzione Artistica" },
  { id: "prof_4", code: "0003", name: "Operatore 0003", role: "Management & Catalogo" }
];

// LA FUNZIONE MANCANTE CHE CAUSAVA IL CRASH
export function stripPinCodes(text) {
  if (!text) return "";
  return String(text).replace(/\s*\(?#?\d{4}\)?/g, "").trim();
}

export function getProfilesList() {
  try {
    if (state && Array.isArray(state.operatorProfiles) && state.operatorProfiles.length === 4) return state.operatorProfiles;
    const saved = JSON.parse(localStorage.getItem("vnsr_operator_profiles_v2") || "null");
    if (Array.isArray(saved) && saved.length === 4) return saved;
    return DEFAULT_PROFILES;
  } catch (_) {
    return DEFAULT_PROFILES;
  }
}

export function saveProfilesList(profiles) {
  try {
    localStorage.setItem("vnsr_operator_profiles_v2", JSON.stringify(profiles));
  } catch (_) {}
  if (state) state.operatorProfiles = profiles;
  return profiles;
}

export function getOperatorsMap() {
  const map = {};
  getProfilesList().forEach(p => { map[p.code] = p; });
  return map;
}

export function initAuthGate() {
  const overlay = document.getElementById("authOverlay");
  const pinInput = document.getElementById("pinInput");
  const err = document.getElementById("pinError");
  
  if (!overlay || !pinInput) return;

  const checkPin = () => {
    try {
      const map = getOperatorsMap();
      const code = pinInput.value.trim();
      if (code.length < 4) return;
      
      if (map[code]) {
        state.currentOperator = map[code];
        sessionStorage.setItem("vnsr_active_operator_code", code);
        
        // Sblocco UI immediato e indipendente
        overlay.classList.add("hidden");
        updateOperatorUI();
        
        // Ritardo microscopico per evitare che errori di rendering blocchino il tastierino
        setTimeout(() => {
          try {
            renderAll();
          } catch (e) {
            console.error("Errore in renderAll:", e);
          }
        }, 50);

      } else {
        if (err) err.textContent = "Codice errato";
        pinInput.value = "";
      }
    } catch (error) {
      console.error("Errore sblocco PIN:", error);
      if (err) err.textContent = "Errore di sistema. Riavvia l'app.";
    }
  };

  pinInput.addEventListener("input", checkPin);
  
  document.querySelectorAll(".key-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.key === "clear") pinInput.value = "";
      else if (btn.dataset.key === "backspace") pinInput.value = pinInput.value.slice(0, -1);
      else pinInput.value += (btn.dataset.key || "");
      checkPin();
    });
  });

  try {
    const savedCode = sessionStorage.getItem("vnsr_active_operator_code");
    if (savedCode) {
      const map = getOperatorsMap();
      if (map[savedCode]) {
        state.currentOperator = map[savedCode];
        overlay.classList.add("hidden");
        updateOperatorUI();
      }
    }
  } catch (_) {}
}

export function updateOperatorUI() {
  const op = state.currentOperator;
  const nameEl = document.getElementById("activeOperatorName");
  if (nameEl) nameEl.textContent = op ? stripPinCodes(op.name) : "—";
}