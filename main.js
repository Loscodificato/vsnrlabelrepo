/**
 * main.js — Entry Point Principale, Stato Condiviso, Notifiche Uscite e Sincronizzazione Cloud VNSR
 * Coordina lo stato globale dell'applicazione (`state`), l'inizializzazione di Firebase Realtime Database,
 * il motore di sincronizzazione ibrida (Cloud WebSocket + API Server Locale `/api/state` + IndexedDB),
 * il sistema di Notifiche Uscite (-7gg, -3gg, -1g, uscita esatta) per ogni operatore,
 * la navigazione tra le schede (Tabs), il registro attività e il bootstrap dei moduli ES6.
 */

import {
  DEFAULT_PROFILES,
  getProfilesList,
  saveProfilesList,
  getOperatorsMap,
  initAuthGate,
  updateOperatorUI
} from "./auth.js";

import {
  getPersonType,
  getPersonDisplayName,
  renderTwoFaNotifications,
  renderArtists,
  renderArtistSelectOptions,
  renderAnagraficaPreselectablePills,
  initArtistsEvents
} from "./artists.js";

import {
  renderTracks,
  initTracksEvents
} from "./tracks.js";

import {
  renderCalendar,
  openCalendarWindowModal,
  updateAppleAuthUI,
  syncFromAppleCalendar,
  initCalendarEvents
} from "./calendar.js";

import {
  initSettingsEvents
} from "./settings.js";

// Segnala che il modulo ES6 è stato caricato correttamente
if (typeof window !== "undefined") {
  window.__vnsrModuleLoaded = true;
}

// ==================== STORAGE & MULTI-DEVICE SYNC ENGINE ====================
export const IDB_NAME = "VNSR_Database_v1";
export const IDB_STORE = "kv_store";
export const syncChannel =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("vnsr_realtime_sync") : null;

export function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(key) {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return null;
  }
}

export async function idbSet(key, val) {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    return false;
  }
}

export const DEFAULT_FIREBASE_URL =
  "https://vsnr-management-default-rtdb.europe-west1.firebasedatabase.app";
export const AUTO_SYNC_INTERVAL_MS = 1200;
export const SYNC_TIMEOUT_MS = 3500;

export function sanitizeFirebaseUrl(rawUrl) {
  const trimmed = (rawUrl || "").trim();
  if (
    !trimmed ||
    trimmed.includes("console.firebase.google.com") ||
    trimmed ===
      "https://console.firebase.google.com/u/0/project/vsnr-management/database/vsnr-management-default-rtdb/data/~2F"
  ) {
    localStorage.setItem("vnsr_remote_sync_url", DEFAULT_FIREBASE_URL);
    return DEFAULT_FIREBASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = SYNC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export function withTimeout(
  promise,
  timeoutMs = SYNC_TIMEOUT_MS,
  errorMessage = "Timeout sincronizzazione"
) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ==================== STATO CONDIVISO DELL'APPLICAZIONE ====================
export const state = {
  currentOperator: null,
  version: 0,
  operatorProfiles: null,
  artists: [],
  tracks: [],
  appointments: [],
  notifications: [],
  dismissedNotificationIds: [],
  activityLog: [],
  deletedIds: [],
  serverAvailable: false,
  lanUrl: typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8080",
  remoteSyncEndpoint: sanitizeFirebaseUrl(
    (typeof localStorage !== "undefined" && localStorage.getItem("vnsr_remote_sync_url")) ||
      DEFAULT_FIREBASE_URL
  )
};

// ==================== UTILITY CONDIVISE ====================
export function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function showToast(message) {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3200);
}

// ==================== SISTEMA NOTIFICHE USCITE SINGOLI / ALBUM ====================
export const RELEASE_NOTIFICATION_MILESTONES = [
  {
    key: "minus_7d",
    offsetMs: -7 * 24 * 60 * 60 * 1000,
    badgeLabel: "Tra 7 Giorni",
    buildMessage: (track, artistName, relType) =>
      `Manca 1 settimana all'uscita del ${relType.toLowerCase()} "${track.title}" di ${artistName} (${track.releaseDate} ore ${track.releaseTime || "00:00"}).`
  },
  {
    key: "minus_3d",
    offsetMs: -3 * 24 * 60 * 60 * 1000,
    badgeLabel: "Tra 3 Giorni",
    buildMessage: (track, artistName, relType) =>
      `Mancano 3 giorni all'uscita del ${relType.toLowerCase()} "${track.title}" di ${artistName} (${track.releaseDate} ore ${track.releaseTime || "00:00"}).`
  },
  {
    key: "minus_1d",
    offsetMs: -1 * 24 * 60 * 60 * 1000,
    badgeLabel: "Domani (-1 Giorno)",
    buildMessage: (track, artistName, relType) =>
      `Manca 1 giorno all'uscita del ${relType.toLowerCase()} "${track.title}" di ${artistName} (${track.releaseDate} ore ${track.releaseTime || "00:00"}).`
  },
  {
    key: "release_now",
    offsetMs: 0,
    badgeLabel: "USCITA ORA!",
    buildMessage: (track, artistName, relType) =>
      `È il momento esatto dell'uscita! Il ${relType.toLowerCase()} "${track.title}" di ${artistName} è ufficialmente fuori ora!`
  }
];

function parseTrackReleaseTimestampMs(releaseDate, releaseTime) {
  if (!releaseDate) return null;
  const parts = String(releaseDate).split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [year, month, day] = parts;
  const timeParts = String(releaseTime || "00:00").split(":").map(Number);
  const hour = !isNaN(timeParts[0]) ? timeParts[0] : 0;
  const minute = !isNaN(timeParts[1]) ? timeParts[1] : 0;
  const dt = new Date(year, month - 1, day, hour, minute, 0, 0);
  const ms = dt.getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * Valuta tutte le tracce con data/ora di uscita e genera notifiche per OGNI operatore
 * agli step: -7 giorni, -3 giorni, -1 giorno e momento esatto dell'uscita.
 */
export function evaluateTrackReleaseNotifications(silent = false) {
  if (!Array.isArray(state.tracks)) return false;
  if (!Array.isArray(state.notifications)) state.notifications = [];
  if (!Array.isArray(state.dismissedNotificationIds)) state.dismissedNotificationIds = [];

  const nowMs = Date.now();
  const profiles = getProfilesList();
  let newlyCreatedCount = 0;
  let lastCreatedForCurrentOp = null;

  for (const track of state.tracks) {
    if (!track || !track.id || !track.releaseDate) continue;
    const releaseMs = parseTrackReleaseTimestampMs(track.releaseDate, track.releaseTime || "00:00");
    if (!releaseMs) continue;

    const artistObj = state.artists.find((a) => a.id === track.artistId);
    const artistName =
      track.mainArtist || (artistObj ? getPersonDisplayName(artistObj) : "Artista VNSR");
    const relType = track.releaseType || "Singolo";

    for (const milestone of RELEASE_NOTIFICATION_MILESTONES) {
      const triggerMs = releaseMs + milestone.offsetMs;
      if (nowMs >= triggerMs) {
        for (const prof of profiles) {
          const opId = prof.id || prof.code;
          const notifId = `relnotif_${track.id}_${milestone.key}_${opId}`;

          if (state.dismissedNotificationIds.includes(notifId)) continue;
          const alreadyExists = state.notifications.some((n) => n && n.id === notifId);
          if (alreadyExists) continue;

          const newNotif = {
            id: notifId,
            trackId: track.id,
            trackTitle: track.title || "Traccia",
            artistName,
            releaseType: relType,
            releaseDate: track.releaseDate,
            releaseTime: track.releaseTime || "00:00",
            milestoneKey: milestone.key,
            badgeLabel: milestone.badgeLabel,
            message: milestone.buildMessage(track, artistName, relType),
            targetOperatorId: opId,
            targetOperatorCode: prof.code,
            targetOperatorName: prof.name,
            triggeredAt: nowMs,
            createdAt: new Date(nowMs).toISOString(),
            updatedAt: new Date(nowMs).toISOString()
          };

          state.notifications.unshift(newNotif);
          newlyCreatedCount++;

          if (
            state.currentOperator &&
            (state.currentOperator.id === opId || state.currentOperator.code === prof.code)
          ) {
            lastCreatedForCurrentOp = newNotif;
          }
        }
      }
    }
  }

  if (newlyCreatedCount > 0) {
    renderNotificationsUI();
    if (!silent && lastCreatedForCurrentOp) {
      showToast(`🔔 ${lastCreatedForCurrentOp.badgeLabel}: ${lastCreatedForCurrentOp.trackTitle}`);
    }
    saveApplicationData();
    return true;
  }

  renderNotificationsUI();
  return false;
}

export function getActiveOperatorNotifications() {
  if (!Array.isArray(state.notifications)) return [];
  const dismissed = new Set(state.dismissedNotificationIds || []);
  const currentOpId = state.currentOperator ? state.currentOperator.id : null;
  const currentOpCode = state.currentOperator ? state.currentOperator.code : null;

  return state.notifications
    .filter((n) => {
      if (!n || !n.id || dismissed.has(n.id)) return false;
      if (!currentOpId && !currentOpCode) {
        return n.targetOperatorId === "prof_1" || n.targetOperatorCode === "0070";
      }
      return n.targetOperatorId === currentOpId || n.targetOperatorCode === currentOpCode;
    })
    .sort((a, b) => (b.triggeredAt || 0) - (a.triggeredAt || 0));
}

export function renderNotificationsUI() {
  const badgeEl = document.getElementById("notificationsCountBadge");
  const listContainer = document.getElementById("notificationsListContainer");
  const clearAllBtn = document.getElementById("clearAllNotificationsBtn");
  const bellBtn = document.getElementById("notificationsBellBtn");
  const subEl = document.getElementById("notificationsOperatorSub");

  if (subEl) {
    if (state.currentOperator) {
      subEl.textContent = `Operatore: ${state.currentOperator.name} (#${state.currentOperator.code}) • Avvisi: -7gg, -3gg, -1g e uscita`;
    } else {
      subEl.textContent = "Avvisi uscite (-7gg, -3gg, -1g e orario esatto di uscita)";
    }
  }

  const activeNotifs = getActiveOperatorNotifications();
  const count = activeNotifs.length;

  if (badgeEl) {
    if (count > 0) {
      badgeEl.textContent = count > 99 ? "99+" : String(count);
      badgeEl.style.display = "inline-flex";
    } else {
      badgeEl.textContent = "0";
      badgeEl.style.display = "none";
    }
  }

  if (bellBtn) {
    bellBtn.classList.toggle("has-unread", count > 0);
  }

  if (clearAllBtn) {
    clearAllBtn.style.display = "inline-flex";
    clearAllBtn.disabled = count === 0;
    clearAllBtn.style.opacity = count > 0 ? "1" : "0.45";
    clearAllBtn.style.cursor = count > 0 ? "pointer" : "default";
  }

  if (!listContainer) return;

  if (count === 0) {
    listContainer.innerHTML = `
      <div class="notifications-empty-state">
        <span class="notifications-empty-icon">🔔</span>
        <p>Nessuna notifica attiva al momento</p>
        <small>Riceverai avvisi automatici a -7gg, -3gg, -1g e all'orario esatto di uscita di ogni traccia.</small>
      </div>
    `;
    return;
  }

  listContainer.innerHTML = activeNotifs
    .map((n) => {
      const isNow = n.milestoneKey === "release_now";
      const timeFormatted = n.triggeredAt
        ? new Date(n.triggeredAt).toLocaleString("it-IT", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          })
        : "";

      return `
        <div class="notification-item ${isNow ? "notification-item-urgent" : ""}">
          <div class="notification-item-content">
            <div class="notification-item-top">
              <span class="notification-milestone-pill ${isNow ? "urgent" : ""}">
                ${isNow ? "🚀 " : "📅 "}${escapeHtml(n.badgeLabel || "Avviso Uscita")}
              </span>
              <span class="notification-time-label">${escapeHtml(timeFormatted)}</span>
            </div>
            <div class="notification-item-title">
              ${escapeHtml(n.trackTitle)} <span style="color: var(--text-muted); font-weight: 500;">— ${escapeHtml(n.artistName)}</span>
            </div>
            <div class="notification-item-message">
              ${escapeHtml(n.message)}
            </div>
          </div>
          <button type="button" class="notification-delete-btn" onclick="deleteSingleNotification('${n.id}')" title="Cancella questa notifica">
            ✕
          </button>
        </div>
      `;
    })
    .join("");
}

export function deleteSingleNotification(notifId) {
  if (!notifId) return;
  if (!Array.isArray(state.dismissedNotificationIds)) {
    state.dismissedNotificationIds = [];
  }
  if (!state.dismissedNotificationIds.includes(notifId)) {
    state.dismissedNotificationIds.push(notifId);
  }
  state.notifications = (state.notifications || []).filter((n) => n && n.id !== notifId);
  renderNotificationsUI();
  saveApplicationData();
}

export function clearAllOperatorNotifications() {
  const activeNotifs = getActiveOperatorNotifications();
  if (activeNotifs.length === 0) return;

  if (!Array.isArray(state.dismissedNotificationIds)) {
    state.dismissedNotificationIds = [];
  }
  const idsToRemove = new Set(activeNotifs.map((n) => n.id));
  for (const id of idsToRemove) {
    if (!state.dismissedNotificationIds.includes(id)) {
      state.dismissedNotificationIds.push(id);
    }
  }
  state.notifications = (state.notifications || []).filter((n) => n && !idsToRemove.has(n.id));
  renderNotificationsUI();
  showToast("Tutte le notifiche sono state cancellate.");
  saveApplicationData();
}

let notificationsTimerId = null;

export function initNotificationsEvents() {
  const bellBtn = document.getElementById("notificationsBellBtn");
  const dropdownPanel = document.getElementById("notificationsDropdownPanel");
  const clearAllBtn = document.getElementById("clearAllNotificationsBtn");
  const wrapper = document.getElementById("notificationsBellWrapper");

  if (bellBtn && dropdownPanel && bellBtn.dataset.bound !== "1") {
    bellBtn.dataset.bound = "1";
    bellBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = dropdownPanel.classList.contains("open");
      if (isOpen) {
        dropdownPanel.classList.remove("open");
        bellBtn.setAttribute("aria-expanded", "false");
      } else {
        evaluateTrackReleaseNotifications(true);
        renderNotificationsUI();
        dropdownPanel.classList.add("open");
        bellBtn.setAttribute("aria-expanded", "true");
      }
    });
  }

  if (clearAllBtn && clearAllBtn.dataset.bound !== "1") {
    clearAllBtn.dataset.bound = "1";
    clearAllBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearAllOperatorNotifications();
    });
  }

  if (!window.__vnsrNotifDocClickBound) {
    window.__vnsrNotifDocClickBound = true;
    document.addEventListener("click", (e) => {
      if (!dropdownPanel || !dropdownPanel.classList.contains("open")) return;
      if (wrapper && !wrapper.contains(e.target)) {
        dropdownPanel.classList.remove("open");
        if (bellBtn) bellBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  if (notificationsTimerId) clearInterval(notificationsTimerId);
  notificationsTimerId = setInterval(() => {
    evaluateTrackReleaseNotifications(false);
  }, 1000);
}

window.deleteSingleNotification = deleteSingleNotification;
window.clearAllOperatorNotifications = clearAllOperatorNotifications;

// ==================== FIREBASE REALTIME DATABASE SDK INITIALIZATION ====================
let firebaseApp = null;
let firebaseDb = null;

export function initFirebaseSDK(databaseURL = state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL) {
  if (typeof window.firebase === "undefined") return null;
  try {
    const cleanUrl = sanitizeFirebaseUrl(databaseURL);
    state.remoteSyncEndpoint = cleanUrl;

    const firebaseConfig = {
      apiKey: "AIzaSyAzl2DTe2vcMFtFTSGWyMVD3rQwdxgbwYM",
      authDomain: "vsnr-management.firebaseapp.com",
      databaseURL: cleanUrl,
      projectId: "vsnr-management",
      storageBucket: "vsnr-management.firebasestorage.app",
      messagingSenderId: "I146033126580",
      appId: "1:146033126580:web:90a7f2fd6d389d85cefbe1"
    };

    if (!firebaseApp) {
      firebaseApp = window.firebase.initializeApp(firebaseConfig);
    }
    firebaseDb = window.firebase.database(firebaseApp);

    window.firebase
      .auth()
      .signInWithEmailAndPassword("server@vnsr.it", "VnsrSicurezza2026!")
      .then(() => {
        firebaseDb.ref("vnsr_state").on(
          "value",
          (snapshot) => {
            const cloudData = snapshot.val();
            if (cloudData && cloudData.version && cloudData.version > (state.version || 0)) {
              applyIncomingSnapshot(cloudData);
              idbSet("vnsr_state", cloudData);
              renderAll();
              updateSyncStatusUI(true);
            }
          },
          (err) => {
            console.warn("Firebase realtime listener error:", err);
          }
        );
      })
      .catch((authErr) => {
        console.warn("Errore autenticazione invisibile Firebase Auth:", authErr);
      });

    return firebaseDb;
  } catch (err) {
    console.warn("Errore inizializzazione Firebase SDK:", err);
    return null;
  }
}

export async function testFirebaseReadWrite() {
  const outputEl = document.getElementById("firebaseTestOutput");
  if (outputEl) {
    outputEl.style.display = "block";
    outputEl.textContent = "⏳ Connessione a Firebase Realtime Database in corso...";
  }

  const inputEl = document.getElementById("remoteSyncEndpointInput");
  const candidateUrl =
    inputEl && inputEl.value.trim()
      ? inputEl.value.trim()
      : state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL;
  const dbUrl = sanitizeFirebaseUrl(candidateUrl);
  state.remoteSyncEndpoint = dbUrl;
  if (inputEl) inputEl.value = dbUrl;

  const testPayload = {
    progetto: "VNSR Gestionale Discografico",
    messaggio: "Test di scrittura e lettura completato con successo!",
    operatoreAttivo: state.currentOperator
      ? `${state.currentOperator.name} (${state.currentOperator.code})`
      : "Terminale VNSR",
    timestamp: new Date().toISOString(),
    testId: Math.floor(Math.random() * 100000)
  };

  try {
    const googlePingOk = await pingGoogleServer8888();
    if (!googlePingOk) {
      throw new Error("Ping al server Google 8.8.8.8 fallito (Connessione Internet assente).");
    }

    let readBackData = null;
    let methodUsed = "Firebase Web SDK (WebSocket)";

    if (firebaseDb) {
      try {
        const testRef = firebaseDb.ref("vnsr_test_connection");
        await withTimeout(testRef.set(testPayload), SYNC_TIMEOUT_MS);
        const snapshot = await withTimeout(testRef.once("value"), SYNC_TIMEOUT_MS);
        readBackData = snapshot.val();
      } catch (_) {
        readBackData = null;
      }
    }

    if (!readBackData) {
      methodUsed = "Firebase REST API (HTTPS)";
      const writeRes = await fetchWithTimeout(
        `${dbUrl}/vnsr_test_connection.json`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(testPayload)
        },
        SYNC_TIMEOUT_MS
      );
      if (!writeRes.ok) throw new Error(`HTTP Write Error: ${writeRes.status}`);

      const readRes = await fetchWithTimeout(
        `${dbUrl}/vnsr_test_connection.json`,
        { cache: "no-store" },
        SYNC_TIMEOUT_MS
      );
      if (!readRes.ok) throw new Error(`HTTP Read Error: ${readRes.status}`);
      readBackData = await readRes.json();
    }

    updateSyncStatusUI(true);
    if (outputEl) {
      outputEl.textContent =
        `✅ TEST FIREBASE + PING 8.8.8.8 SUPERATO (${methodUsed})\n` +
        `🔗 URL: ${dbUrl}/vnsr_test_connection\n` +
        `📥 Dati riletti dal database:\n` +
        JSON.stringify(readBackData, null, 2);
    }
    showToast("✅ Test Lettura/Scrittura Firebase e Ping 8.8.8.8 riusciti!");
    return readBackData;
  } catch (err) {
    updateSyncStatusUI(false);
    if (outputEl) {
      outputEl.textContent = `❌ Errore durante il test Firebase:\n${err.message}`;
    }
    showToast("❌ Errore connessione Firebase: " + err.message);
    return null;
  }
}
window.testFirebaseReadWrite = testFirebaseReadWrite;

// ==================== FUNZIONI DI MERGE & SINCRONIZZAZIONE ====================
export function mergeCollectionClient(existingList, incomingList, deletedSet) {
  const byId = new Map();
  for (const item of existingList || []) {
    if (item && item.id && !deletedSet.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  for (const item of incomingList || []) {
    if (!item || !item.id || deletedSet.has(item.id)) continue;
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, item);
    } else {
      const prevTs = String(prev.updatedAt || prev.createdAt || "");
      const incTs = String(item.updatedAt || item.createdAt || "");
      if (incTs >= prevTs) {
        byId.set(item.id, item);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
}

export function mergeLogsClient(existingLogs, incomingLogs) {
  const byId = new Map();
  for (const l of [...(existingLogs || []), ...(incomingLogs || [])]) {
    if (l && l.id) byId.set(l.id, l);
  }
  return Array.from(byId.values())
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, 250);
}

export function applyIncomingSnapshot(incomingDb) {
  if (!incomingDb) return false;
  const allDeleted = Array.from(
    new Set([...(state.deletedIds || []), ...(incomingDb.deletedIds || [])])
  );
  const deletedSet = new Set(allDeleted);

  state.deletedIds = allDeleted;
  const incomingProfiles = incomingDb.operatorProfiles || incomingDb.profiles;
  if (Array.isArray(incomingProfiles) && incomingProfiles.length === 4) {
    const localProfiles = getProfilesList();
    const mergedProfiles = DEFAULT_PROFILES.map((def, idx) => {
      const loc = localProfiles[idx] || def;
      const inc = incomingProfiles[idx] || def;
      const locTs = loc.updatedAt || "";
      const incTs = inc.updatedAt || "";
      return incTs >= locTs ? { ...def, ...inc, id: def.id } : { ...def, ...loc, id: def.id };
    });
    state.operatorProfiles = mergedProfiles;
    localStorage.setItem("vnsr_operator_profiles_v2", JSON.stringify(mergedProfiles));
    if (state.currentOperator && state.currentOperator.id) {
      const updatedActive = mergedProfiles.find((p) => p.id === state.currentOperator.id);
      if (updatedActive) {
        state.currentOperator = updatedActive;
        sessionStorage.setItem("vnsr_active_operator_code", updatedActive.code);
        updateOperatorUI();
      }
    }
  }

  state.artists = mergeCollectionClient(state.artists, incomingDb.artists || [], deletedSet);
  state.tracks = mergeCollectionClient(state.tracks, incomingDb.tracks || [], deletedSet);
  state.appointments = mergeCollectionClient(
    state.appointments,
    incomingDb.appointments || [],
    deletedSet
  );

  // Merge notifiche uscite e notifiche cancellate
  const allDismissed = Array.from(
    new Set([
      ...(state.dismissedNotificationIds || []),
      ...(incomingDb.dismissedNotificationIds || [])
    ])
  ).slice(-1000);
  const dismissedSet = new Set(allDismissed);
  state.dismissedNotificationIds = allDismissed;
  state.notifications = mergeCollectionClient(
    state.notifications || [],
    incomingDb.notifications || [],
    dismissedSet
  );

  state.activityLog = mergeLogsClient(state.activityLog, incomingDb.activityLog || []);
  state.version = Math.max(
    state.version || 0,
    incomingDb.version || incomingDb.lastUpdated || Date.now()
  );
  return true;
}

export function getBaseApiUrl() {
  const custom = (state.remoteSyncEndpoint || "").trim().replace(/\/+$/, "");
  if (custom && !custom.includes("firebaseio.com") && !custom.includes("firebasedatabase.app")) {
    return custom;
  }
  return "";
}

export function isFirebaseEndpoint() {
  const custom = sanitizeFirebaseUrl(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);
  return custom.includes("firebaseio.com") || custom.includes("firebasedatabase.app");
}

export function getFirebaseJsonUrl() {
  const custom = sanitizeFirebaseUrl(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);
  return custom.endsWith(".json") ? custom : `${custom}/vnsr_state.json`;
}

export async function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function uploadOrStoreFile(file, folder) {
  const dataUrl = await readFileAsDataUrl(file);
  const baseUrl = getBaseApiUrl();
  if (state.serverAvailable || baseUrl) {
    try {
      const res = await fetch(`${baseUrl}/api/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          dataUrl,
          folder
        })
      });
      const data = await res.json();
      if (data.ok && data.url) {
        const finalUrl =
          baseUrl && data.url.startsWith("/") ? `${baseUrl}${data.url}` : data.url;
        return { url: finalUrl, name: file.name, size: file.size };
      }
    } catch (_) {
      // Fallback to inline dataUrl
    }
  }
  return { url: dataUrl, name: file.name, size: file.size };
}

export function updateSyncStatusUI(online) {
  const pill = document.getElementById("openSyncModalBtn");
  const textEl = document.getElementById("syncStatusText");
  if (!pill || !textEl) return;
  pill.classList.toggle("offline", !online);
  pill.classList.toggle("online", Boolean(online));
  textEl.textContent = online ? "Online" : "Offline";
}

export async function pingGoogleServer8888() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return false;
  }

  const PING_TIMEOUT_MS = 4500;

  try {
    const res = await fetchWithTimeout(
      `https://8.8.8.8/resolve?name=google.com&_t=${Date.now()}`,
      { method: "GET", cache: "no-store" },
      PING_TIMEOUT_MS
    );
    if (res.ok) return true;
  } catch (_) {}

  try {
    await fetchWithTimeout(
      `https://8.8.8.8/?_t=${Date.now()}`,
      { method: "HEAD", mode: "no-cors", cache: "no-store" },
      PING_TIMEOUT_MS
    );
    return true;
  } catch (_) {}

  const baseUrl = getBaseApiUrl();
  try {
    const pingRes = await fetchWithTimeout(
      `${baseUrl}/api/ping`,
      { cache: "no-store" },
      PING_TIMEOUT_MS
    );
    if (pingRes.ok) {
      const pingData = await pingRes.json();
      if (pingData && pingData.googlePingOk === true) {
        return true;
      }
    }
  } catch (_) {}

  return false;
}

export async function loadApplicationData() {
  const localSaved = await idbGet("vnsr_state");
  if (localSaved) {
    applyIncomingSnapshot(localSaved);
    renderAll();
  }

  let dataSyncOk = false;
  const googlePingOk = await pingGoogleServer8888();

  if (googlePingOk) {
    if (firebaseDb) {
      try {
        const snap = await withTimeout(firebaseDb.ref("vnsr_state").once("value"), SYNC_TIMEOUT_MS);
        const cloudDb = snap.val();
        dataSyncOk = true;
        if (cloudDb) {
          applyIncomingSnapshot(cloudDb);
        }
      } catch (_) {}
    }

    if (!dataSyncOk && isFirebaseEndpoint()) {
      try {
        const res = await fetchWithTimeout(
          getFirebaseJsonUrl(),
          { cache: "no-store" },
          SYNC_TIMEOUT_MS
        );
        if (res.ok) {
          const cloudDb = await res.json();
          dataSyncOk = true;
          if (cloudDb) {
            applyIncomingSnapshot(cloudDb);
          }
        }
      } catch (_) {}
    }
  }

  const baseUrl = getBaseApiUrl();
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/state`,
      { cache: "no-store" },
      SYNC_TIMEOUT_MS
    );
    if (res.ok) {
      const payload = await res.json();
      if (payload.ok && payload.db) {
        state.serverAvailable = true;
        dataSyncOk = true;
        if (payload.lanUrl) {
          state.lanUrl = payload.lanUrl;
          const lanInput = document.getElementById("lanSyncUrlDisplay");
          if (lanInput) lanInput.value = payload.lanUrl;
        }
        applyIncomingSnapshot(payload.db);
      }
    }
  } catch (_) {
    if (!isFirebaseEndpoint()) {
      state.serverAvailable = false;
    }
  }

  updateSyncStatusUI(Boolean(googlePingOk && dataSyncOk));

  const alreadySeeded = localStorage.getItem("vnsr_seeded_v1");
  if (!alreadySeeded && state.artists.length === 0 && state.tracks.length === 0) {
    const nowIso = new Date().toISOString();
    const sampleArtistId = "art_vnsr_demo1";
    state.artists = [
      {
        id: sampleArtistId,
        personType: "Artista",
        nameMode: "stage",
        firstName: "Lorenzo",
        lastName: "Valenti",
        stageName: "KRYPTO",
        contractStatus: "Firmato e Attivo",
        contractDate: "2026-10-15",
        contractDetails:
          "Contratto Discografico Esclusivo VNSR 360° — Royalty Master 70% VNSR / 30% Artista.",
        contractFileUrl: "",
        contractFileName: "Contratto_VNSR_KRYPTO_Firmato.pdf",
        createdBy: "Losco (0070)",
        createdAt: nowIso,
        updatedAt: nowIso
      }
    ];
    state.tracks = [
      {
        id: "trk_vnsr_demo1",
        artistId: sampleArtistId,
        title: "Notte di Cristallo",
        mainArtist: "KRYPTO",
        producer: "Blacklord",
        featuredArtists: ["Riovale", "Mix & Master: VNSR Studio"],
        upc: "8059401200701",
        isrc: "IT-VNS-26-00001",
        coverUrl: "",
        audioUrl: "",
        audioFileName: "",
        createdBy: "Losco (0070)",
        createdAt: nowIso,
        updatedAt: nowIso
      }
    ];
    state.activityLog = [
      {
        id: "log_vnsr_init",
        operatorName: "VNSR System",
        operatorCode: "SYNC",
        action: "Inizializzato gestionale sincronizzato VNSR",
        timestamp: nowIso
      }
    ];
    localStorage.setItem("vnsr_seeded_v1", "1");
    saveApplicationData();
  }
}

let isPollingInProgress = false;

export async function saveApplicationData() {
  state.version = Date.now();
  const dbSnapshot = {
    version: state.version,
    operatorProfiles: getProfilesList(),
    artists: state.artists,
    tracks: state.tracks,
    appointments: state.appointments,
    notifications: state.notifications || [],
    dismissedNotificationIds: state.dismissedNotificationIds || [],
    activityLog: state.activityLog,
    deletedIds: state.deletedIds
  };

  idbSet("vnsr_state", dbSnapshot);
  if (syncChannel) {
    syncChannel.postMessage({ type: "STATE_UPDATED", db: dbSnapshot });
  }
  try {
    localStorage.setItem("vnsr_instant_sync_signal", String(state.version));
  } catch (_) {}

  const baseUrl = getBaseApiUrl();

  const serverPushTask = (async () => {
    try {
      const res = await fetchWithTimeout(
        `${baseUrl}/api/state`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dbSnapshot)
        },
        SYNC_TIMEOUT_MS
      );
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.db) {
          state.serverAvailable = true;
          applyIncomingSnapshot(data.db);
          await idbSet("vnsr_state", data.db);
          return true;
        }
      }
    } catch (_) {}
    return false;
  })();

  const firebasePushTask = (async () => {
    let fbOk = false;
    if (firebaseDb) {
      try {
        await withTimeout(firebaseDb.ref("vnsr_state").set(dbSnapshot), SYNC_TIMEOUT_MS);
        fbOk = true;
      } catch (_) {}
    }
    if (!fbOk && isFirebaseEndpoint()) {
      try {
        const res = await fetchWithTimeout(
          getFirebaseJsonUrl(),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(dbSnapshot)
          },
          SYNC_TIMEOUT_MS
        );
        if (res.ok) fbOk = true;
      } catch (_) {}
    }
    return fbOk;
  })();

  const googlePingTask = pingGoogleServer8888();

  const [serverUploadOk, firebaseUploadOk, googlePingOk] = await Promise.all([
    serverPushTask,
    firebasePushTask,
    googlePingTask
  ]);

  const uploadSuccess = Boolean(serverUploadOk || firebaseUploadOk);
  updateSyncStatusUI(Boolean(uploadSuccess && googlePingOk));
}

export async function pollMultiDeviceUpdates() {
  if (isPollingInProgress) return;
  isPollingInProgress = true;

  try {
    const baseUrl = getBaseApiUrl();
    const dbUrl = sanitizeFirebaseUrl(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);

    const googlePingTask = pingGoogleServer8888();

    const firebaseCheckTask = (async () => {
      try {
        if (firebaseDb) {
          const snap = await withTimeout(
            firebaseDb.ref("vnsr_state").once("value"),
            SYNC_TIMEOUT_MS
          );
          const cloudDb = snap.val();
          if (cloudDb) {
            if (
              cloudDb.version &&
              cloudDb.version !== (state.version || 0) &&
              cloudDb.version > (state.version || 0)
            ) {
              applyIncomingSnapshot(cloudDb);
              await idbSet("vnsr_state", cloudDb);
              renderAll();
            }
            return true;
          }
        }
      } catch (_) {}

      if (isFirebaseEndpoint()) {
        try {
          const verRes = await fetchWithTimeout(
            `${dbUrl}/vnsr_state/version.json`,
            { cache: "no-store" },
            2200
          );
          if (verRes.ok) {
            const remoteVer = await verRes.json();
            if (remoteVer && Number(remoteVer) > (state.version || 0)) {
              const fullRes = await fetchWithTimeout(
                getFirebaseJsonUrl(),
                { cache: "no-store" },
                SYNC_TIMEOUT_MS
              );
              if (fullRes.ok) {
                const cloudDb = await fullRes.json();
                if (cloudDb) {
                  applyIncomingSnapshot(cloudDb);
                  await idbSet("vnsr_state", cloudDb);
                  renderAll();
                }
              }
            }
            return true;
          }
        } catch (_) {}
      }
      return false;
    })();

    const serverCheckTask = (async () => {
      try {
        const pingRes = await fetchWithTimeout(
          `${baseUrl}/api/ping`,
          { cache: "no-store" },
          2200
        );
        if (pingRes.ok) {
          const pingData = await pingRes.json();
          state.serverAvailable = true;
          if (pingData.lanUrl) {
            state.lanUrl = pingData.lanUrl;
            const lanInput = document.getElementById("lanSyncUrlDisplay");
            if (lanInput && lanInput.value !== pingData.lanUrl) {
              lanInput.value = pingData.lanUrl;
            }
          }

          if (pingData.version && pingData.version > (state.version || 0)) {
            const stateRes = await fetchWithTimeout(
              `${baseUrl}/api/state`,
              { cache: "no-store" },
              SYNC_TIMEOUT_MS
            );
            if (stateRes.ok) {
              const payload = await stateRes.json();
              if (payload.ok && payload.db) {
                applyIncomingSnapshot(payload.db);
                await idbSet("vnsr_state", payload.db);
                renderAll();
              }
            }
          }
          return true;
        }
      } catch (_) {}
      return false;
    })();

    const [googlePingOk, fbSyncOk, srvSyncOk] = await Promise.all([
      googlePingTask,
      firebaseCheckTask,
      serverCheckTask
    ]);

    updateSyncStatusUI(Boolean(googlePingOk && (fbSyncOk || srvSyncOk)));
  } finally {
    isPollingInProgress = false;
  }
}

if (syncChannel) {
  syncChannel.onmessage = (event) => {
    if (event.data && event.data.type === "STATE_UPDATED" && event.data.db) {
      applyIncomingSnapshot(event.data.db);
      renderAll();
    }
  };
}

window.addEventListener("storage", async (e) => {
  if (e.key === "vnsr_instant_sync_signal" || e.key === "vnsr_operator_profiles_v2") {
    const localSaved = await idbGet("vnsr_state");
    if (localSaved) {
      applyIncomingSnapshot(localSaved);
      renderAll();
    }
  }
});
window.addEventListener("focus", () => {
  pollMultiDeviceUpdates();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    pollMultiDeviceUpdates();
  }
});

// ==================== REGISTRO ATTIVITÀ & STATISTICHE ====================
export function recordActivity(actionText) {
  const op = state.currentOperator || { name: "Operatore", code: "----" };
  state.activityLog.unshift({
    id: "log_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    operatorName: op.name,
    operatorCode: op.code,
    action: actionText,
    timestamp: new Date().toISOString()
  });
  if (state.activityLog.length > 250) {
    state.activityLog = state.activityLog.slice(0, 250);
  }
}

export function renderStats() {
  const statArtistsEl = document.getElementById("statArtistsCount");
  const statTracksEl = document.getElementById("statTracksCount");
  const statContractsEl = document.getElementById("statContractsCount");
  const statAudioEl = document.getElementById("statAudioCount");

  if (statArtistsEl) statArtistsEl.textContent = state.artists.length;
  if (statTracksEl) statTracksEl.textContent = state.tracks.length;

  const withContracts = state.artists.filter(
    (a) => a.contractStatus === "Firmato e Attivo" || a.contractFileUrl || a.contractFileName
  ).length;
  if (statContractsEl) statContractsEl.textContent = withContracts;

  const withAudio = state.tracks.filter((t) => Boolean(t.audioUrl)).length;
  if (statAudioEl) statAudioEl.textContent = withAudio;
}

export function renderActivityLog() {
  const container = document.getElementById("activityContainer");
  if (!container) return;
  if (!state.activityLog || state.activityLog.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>Nessuna operazione registrata.</p></div>`;
    return;
  }

  container.innerHTML = state.activityLog
    .map((item) => {
      const dateStr = item.timestamp ? new Date(item.timestamp).toLocaleString("it-IT") : "";
      const opCode = item.operatorCode || "SYNC";
      const opName = item.operatorName || item.operator || "Operatore";
      const actText = item.action || item.text || "";
      return `
        <div style="background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; gap: 14px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="operator-code">#${escapeHtml(opCode)}</span>
            <strong style="color: var(--accent-gold);">${escapeHtml(opName)}</strong>
            <span style="color: var(--text-primary); font-size: 14px;">${escapeHtml(actText)}</span>
          </div>
          <span style="font-size: 12px; color: var(--text-muted); white-space: nowrap;">${escapeHtml(dateStr)}</span>
        </div>
      `;
    })
    .join("");
}

// ==================== NAVIGAZIONE TABS & BLOCCO SCROLL ====================
export function switchTab(tabName) {
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-view").forEach((sec) => {
    const isTarget = sec.id === `view-${tabName}`;
    sec.style.display = isTarget ? "flex" : "none";
    if (isTarget) {
      sec.style.animation = "none";
      void sec.offsetWidth;
      sec.style.animation = "";
    }
  });
  if (tabName === "appointments") {
    renderCalendar();
    openCalendarWindowModal();
  }
}

window.addEventListener(
  "wheel",
  (e) => {
    const inModal =
      e.target && e.target.closest && e.target.closest(".modal-backdrop.open .modal-dialog");
    if (inModal) {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
      }
      return;
    }
    e.preventDefault();
  },
  { passive: false }
);

window.addEventListener(
  "touchmove",
  (e) => {
    const inModal =
      e.target && e.target.closest && e.target.closest(".modal-backdrop.open .modal-dialog");
    if (!inModal) {
      e.preventDefault();
    }
  },
  { passive: false }
);

// ==================== RENDERING INTERFACCIA GLOBALE ====================
export function renderAll() {
  renderTwoFaNotifications();
  renderStats();
  renderArtistSelectOptions();
  renderAnagraficaPreselectablePills();
  renderArtists();
  renderTracks();
  renderCalendar();
  renderActivityLog();
  evaluateTrackReleaseNotifications(true);
  renderNotificationsUI();
}

// ==================== AUTO-UPDATER PRE-APERTURA ====================
export async function runAutoUpdateBeforeOpen() {
  const AUTO_UPDATE_TIMEOUT_MS = 3800;
  const baseUrl = getBaseApiUrl();
  const dbUrl = sanitizeFirebaseUrl(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);
  const badgeEl = document.getElementById("currentAppVersionBadge");
  const bottomVerEl = document.getElementById("bottomRightVersionLabel");

  let localVersion = { versionId: 0, versionString: "1.0.7", sha256: "" };
  let localBundle = null;

  try {
    const statusRes = await fetchWithTimeout(
      `${baseUrl}/api/auto-update/status`,
      { cache: "no-store" },
      AUTO_UPDATE_TIMEOUT_MS
    );
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (statusData && statusData.version) {
        localVersion = statusData.version;
      }
      if (statusData && statusData.releaseBundle) {
        localBundle = statusData.releaseBundle;
      }
      if (statusData && statusData.updated && localVersion.sha256) {
        const prevReloadedSha = sessionStorage.getItem("vnsr_applied_sha");
        if (prevReloadedSha !== localVersion.sha256) {
          sessionStorage.setItem("vnsr_applied_sha", localVersion.sha256);
          window.location.reload();
          return true;
        }
      }
    }
  } catch (_) {
    try {
      const vRes = await fetchWithTimeout("version.json", { cache: "no-store" }, 2000);
      if (vRes.ok) {
        localVersion = await vRes.json();
      }
    } catch (_) {}
  }

  const displayVer = localVersion.versionString || "1.0.7";
  if (badgeEl) {
    badgeEl.textContent = `Versione v${displayVer} • Auto-Update Attivo`;
  }
  if (bottomVerEl) {
    bottomVerEl.textContent = `v${displayVer}`;
  }

  let remoteMeta = null;
  if (firebaseDb) {
    try {
      const snap = await withTimeout(
        firebaseDb.ref("vnsr_app_release_meta").once("value"),
        AUTO_UPDATE_TIMEOUT_MS
      );
      remoteMeta = snap.val();
    } catch (_) {}
  }
  if (!remoteMeta && isFirebaseEndpoint()) {
    try {
      const res = await fetchWithTimeout(
        `${dbUrl}/vnsr_app_release_meta.json`,
        { cache: "no-store" },
        AUTO_UPDATE_TIMEOUT_MS
      );
      if (res.ok) {
        remoteMeta = await res.json();
      }
    } catch (_) {}
  }

  const localVid = Number(localVersion.versionId || 0);
  const localSha = String(localVersion.sha256 || "");
  const remoteVid = Number((remoteMeta && remoteMeta.versionId) || 0);
  const remoteSha = String((remoteMeta && remoteMeta.sha256) || "");

  if (remoteMeta && remoteSha && remoteSha !== localSha && remoteVid > localVid) {
    const alreadyApplied = sessionStorage.getItem("vnsr_applied_sha");
    if (alreadyApplied !== remoteSha) {
      const bootOverlay = document.getElementById("autoUpdateBootOverlay");
      const bootMsg = document.getElementById("autoUpdateBootMessage");
      const progressBar = document.getElementById("autoUpdateProgressBar");
      if (bootOverlay) bootOverlay.style.display = "flex";
      if (bootMsg) {
        bootMsg.textContent = `Nuova versione v${remoteMeta.versionString || "Nuova"} rilevata sul database. Download e installazione automatica in corso...`;
      }

      try {
        let fullReleaseBundle = null;
        if (firebaseDb) {
          try {
            const bSnap = await withTimeout(
              firebaseDb.ref("vnsr_app_release").once("value"),
              7000
            );
            fullReleaseBundle = bSnap.val();
          } catch (_) {}
        }
        if (!fullReleaseBundle && isFirebaseEndpoint()) {
          const bRes = await fetchWithTimeout(
            `${dbUrl}/vnsr_app_release.json`,
            { cache: "no-store" },
            7000
          );
          if (bRes.ok) {
            fullReleaseBundle = await bRes.json();
          }
        }

        if (fullReleaseBundle && fullReleaseBundle.bundleZipB64) {
          if (progressBar) progressBar.style.width = "100%";
          const applyRes = await fetchWithTimeout(
            `${baseUrl}/api/auto-update/apply-bundle`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ releasePayload: fullReleaseBundle })
            },
            7000
          );
          sessionStorage.setItem("vnsr_applied_sha", remoteSha);
          if (applyRes.ok) {
            window.location.reload();
            return true;
          }
        }
      } catch (_) {}
      if (bootOverlay) bootOverlay.style.display = "none";
    }
  }

  // CASO B: La versione locale ha una nuova modifica non ancora sul database -> Caricala automaticamente sul database!
  if (
    localBundle &&
    localBundle.bundleZipB64 &&
    (!remoteMeta || localVid > remoteVid || (localSha && localSha !== remoteSha && localVid >= remoteVid))
  ) {
    const metaPayload = {
      versionId: localBundle.versionId,
      versionString: localBundle.versionString,
      sha256: localBundle.sha256,
      publishedAt: localBundle.publishedAt
    };
    (async () => {
      try {
        if (firebaseDb) {
          await withTimeout(firebaseDb.ref("vnsr_app_release_meta").set(metaPayload), 6000);
          await withTimeout(firebaseDb.ref("vnsr_app_release").set(localBundle), 9000);
        } else if (isFirebaseEndpoint()) {
          await fetchWithTimeout(
            `${dbUrl}/vnsr_app_release_meta.json`,
            { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metaPayload) },
            6000
          );
          await fetchWithTimeout(
            `${dbUrl}/vnsr_app_release.json`,
            { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(localBundle) },
            9000
          );
        }
      } catch (_) {}
    })();
  }

  return false;
}

// ==================== BOOTSTRAP IMMEDIATO APPLICAZIONE ====================
async function bootstrapApplication() {
  if (typeof window !== "undefined") {
    if (window.__vnsrBootstrapped) return;
    window.__vnsrBootstrapped = true;
  }

  // 1. Inizializza SUBITO a 0ms il tastierino PIN e tutti i listener UI (senza attendere la rete!)
  initAuthGate();
  initNotificationsEvents();
  initArtistsEvents();
  initTracksEvents();
  initCalendarEvents();
  initSettingsEvents();

  // Tabs
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Chiusura modali
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById(btn.dataset.close)?.classList.remove("open");
    });
  });

  // Sync Modal
  document.getElementById("openSyncModalBtn")?.addEventListener("click", () => {
    const cleanEndpoint = sanitizeFirebaseUrl(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);
    state.remoteSyncEndpoint = cleanEndpoint;
    const epInput = document.getElementById("remoteSyncEndpointInput");
    const lanInput = document.getElementById("lanSyncUrlDisplay");
    if (epInput) epInput.value = cleanEndpoint;
    if (lanInput) lanInput.value = state.lanUrl || window.location.origin;
    document.getElementById("syncModal")?.classList.add("open");
  });

  document.getElementById("copyLanUrlBtn")?.addEventListener("click", () => {
    const val = document.getElementById("lanSyncUrlDisplay")?.value || "";
    navigator.clipboard?.writeText(val);
    showToast(`Link multi-dispositivo copiato: ${val}`);
  });

  document.getElementById("saveSyncConfigBtn")?.addEventListener("click", async () => {
    const rawUrl = document.getElementById("remoteSyncEndpointInput")?.value.trim() || "";
    const url = sanitizeFirebaseUrl(rawUrl);
    const epInput = document.getElementById("remoteSyncEndpointInput");
    if (epInput) epInput.value = url;
    state.remoteSyncEndpoint = url;
    localStorage.setItem("vnsr_remote_sync_url", url);
    initFirebaseSDK(url);
    await loadApplicationData();
    await saveApplicationData();
    renderAll();
    showToast("Configurazione Cloud Sync salvata e sincronizzata!");
  });

  document.getElementById("forceSyncNowBtn")?.addEventListener("click", async () => {
    await loadApplicationData();
    await saveApplicationData();
    renderAll();
    showToast("Sincronizzazione completata con tutti i dispositivi!");
  });

  document.getElementById("testFirebaseBtn")?.addEventListener("click", () => {
    testFirebaseReadWrite();
  });

  document.getElementById("importBackupInput")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      applyIncomingSnapshot(parsed);
      recordActivity("Importato backup JSON nel catalogo condiviso VNSR");
      saveApplicationData();
      renderAll();
      document.getElementById("syncModal")?.classList.remove("open");
      showToast("Backup importato e sincronizzato su tutti i dispositivi!");
    } catch (_) {
      showToast("File JSON non valido.");
    }
  });

  document.getElementById("exportBackupBtn")?.addEventListener("click", () => {
    const dataStr = JSON.stringify(
      {
        version: state.version,
        exportedAt: new Date().toISOString(),
        operatorProfiles: getProfilesList(),
        artists: state.artists,
        tracks: state.tracks,
        appointments: state.appointments,
        notifications: state.notifications,
        dismissedNotificationIds: state.dismissedNotificationIds,
        activityLog: state.activityLog,
        deletedIds: state.deletedIds
      },
      null,
      2
    );
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `VNSR_Backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Backup VNSR esportato!");
  });

  // 2. Renderizza subito la UI iniziale
  renderAll();

  // 3. Connetti Firebase, verifica auto-update e carica dati in background senza bloccare il PIN!
  initFirebaseSDK(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);
  const reloadingForUpdate = await runAutoUpdateBeforeOpen();
  if (reloadingForUpdate) return;
  await loadApplicationData();
  renderAll();

  setInterval(pollMultiDeviceUpdates, AUTO_SYNC_INTERVAL_MS);

  window.addEventListener("offline", () => {
    updateSyncStatusUI(false);
  });
  window.addEventListener("online", () => {
    pollMultiDeviceUpdates();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrapApplication);
} else {
  bootstrapApplication();
}
