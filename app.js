/**
 * VNSR — Gestionale Etichetta Discografica
 * Sincronizzazione Multi-Dispositivo in Tempo Reale, Codici Operatore, Artisti, Contratti, Tracce & Master MP3
 */

const DEFAULT_PROFILES = [
  { id: "prof_1", code: "0070", name: "Losco", role: "Executive Label Manager" },
  { id: "prof_2", code: "0001", name: "Blacklord", role: "A&R & Produzione" },
  { id: "prof_3", code: "0002", name: "Riovale", role: "Direzione Artistica" },
  { id: "prof_4", code: "0003", name: "Operatore 0003", role: "Management & Catalogo" }
];

const DEFAULT_OPERATORS = {
  "0070": { id: "prof_1", code: "0070", name: "Losco", role: "Executive Label Manager" },
  "0001": { id: "prof_2", code: "0001", name: "Blacklord", role: "A&R & Produzione" },
  "0002": { id: "prof_3", code: "0002", name: "Riovale", role: "Direzione Artistica" },
  "0003": { id: "prof_4", code: "0003", name: "Operatore 0003", role: "Management & Catalogo" }
};

function getProfilesList() {
  try {
    if (typeof state !== "undefined" && Array.isArray(state.operatorProfiles) && state.operatorProfiles.length === 4) {
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

function saveProfilesList(profilesArray) {
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
  if (typeof state !== "undefined") {
    state.operatorProfiles = normalized;
  }
  return normalized;
}

function getOperatorsMap() {
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

// ==================== STORAGE & MULTI-DEVICE SYNC ENGINE ====================
const IDB_NAME = "VNSR_Database_v1";
const IDB_STORE = "kv_store";
const syncChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("vnsr_realtime_sync") : null;

function openIndexedDB() {
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

async function idbGet(key) {
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

async function idbSet(key, val) {
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

const DEFAULT_FIREBASE_URL = "https://vsnr-management-default-rtdb.europe-west1.firebasedatabase.app";
const AUTO_SYNC_INTERVAL_MS = 1200; // Sincronizzazione continua istantanea in tempo reale (1.2s)
const SYNC_TIMEOUT_MS = 3500; // Timeout rapido immediato per le operazioni di sincronizzazione

/**
 * Normalizza l'URL di Firebase, sostituendo eventuali link della Console di Amministrazione
 * ("https://console.firebase.google.com/u/0/project/vsnr-management/database/vsnr-management-default-rtdb/data/~2F")
 * con l'endpoint effettivo del Realtime Database.
 */
function sanitizeFirebaseUrl(rawUrl) {
  const trimmed = (rawUrl || "").trim();
  if (
    !trimmed ||
    trimmed.includes("console.firebase.google.com") ||
    trimmed === "https://console.firebase.google.com/u/0/project/vsnr-management/database/vsnr-management-default-rtdb/data/~2F"
  ) {
    localStorage.setItem("vnsr_remote_sync_url", DEFAULT_FIREBASE_URL);
    return DEFAULT_FIREBASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

/**
 * Esegue una fetch con timeout rigoroso di 10 secondi tramite AbortController
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = SYNC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Applica un timeout di 10 secondi a una Promise (es. operazioni Firebase SDK)
 */
function withTimeout(promise, timeoutMs = SYNC_TIMEOUT_MS, errorMessage = "Timeout sincronizzazione (10s superati)") {
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

let state = {
  currentOperator: null,
  version: 0,
  operatorProfiles: null,
  artists: [],
  tracks: [],
  appointments: [],
  activityLog: [],
  deletedIds: [],
  serverAvailable: false,
  lanUrl: window.location.origin,
  remoteSyncEndpoint: sanitizeFirebaseUrl(localStorage.getItem("vnsr_remote_sync_url") || DEFAULT_FIREBASE_URL)
};

// ==================== FIREBASE REALTIME DATABASE SDK INITIALIZATION ====================
let firebaseApp = null;
let firebaseDb = null;

function initFirebaseSDK(databaseURL = state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL) {
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

    // Login invisibile Firebase Auth + Sottoscrizione real-time WebSocket ai dati del gestionale VNSR
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
              updateSyncStatusUI(true, "Firebase Cloud Live");
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

/**
 * Operazione di prova di Scrittura e Lettura su Firebase Realtime Database
 * Nodo di test: /vnsr_test_connection
 */
async function testFirebaseReadWrite() {
  const outputEl = document.getElementById("firebaseTestOutput");
  if (outputEl) {
    outputEl.style.display = "block";
    outputEl.textContent = "⏳ Connessione a Firebase Realtime Database in corso...";
  }

  const inputEl = document.getElementById("remoteSyncEndpointInput");
  const candidateUrl = inputEl && inputEl.value.trim() ? inputEl.value.trim() : state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL;
  const dbUrl = sanitizeFirebaseUrl(candidateUrl);
  state.remoteSyncEndpoint = dbUrl;
  if (inputEl) inputEl.value = dbUrl;
  const testPayload = {
    progetto: "VNSR Gestionale Discografico",
    messaggio: "Test di scrittura e lettura completato con successo!",
    operatoreAttivo: state.currentOperator ? `${state.currentOperator.name} (${state.currentOperator.code})` : "Terminale VNSR",
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
        // 1. Scrittura tramite Firebase Realtime Database SDK (con timeout di 10s)
        const testRef = firebaseDb.ref("vnsr_test_connection");
        await withTimeout(testRef.set(testPayload), SYNC_TIMEOUT_MS, "Timeout scrittura Firebase (10s)");

        // 2. Lettura tramite Firebase Realtime Database SDK (con timeout di 10s)
        const snapshot = await withTimeout(testRef.once("value"), SYNC_TIMEOUT_MS, "Timeout lettura Firebase (10s)");
        readBackData = snapshot.val();
      } catch (_) {
        readBackData = null;
      }
    }

    if (!readBackData) {
      // Fallback via Firebase REST API (.json) con timeout di 10s
      methodUsed = "Firebase REST API (HTTPS - Timeout 10s)";
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

      const readRes = await fetchWithTimeout(`${dbUrl}/vnsr_test_connection.json`, { cache: "no-store" }, SYNC_TIMEOUT_MS);
      if (!readRes.ok) throw new Error(`HTTP Read Error: ${readRes.status}`);
      readBackData = await readRes.json();
    }

    console.log("✅ [Firebase Test] Scrittura e lettura completate:", readBackData);
    updateSyncStatusUI(true, "Online • Ping 8.8.8.8 OK");

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
    console.error("❌ [Firebase Test] Errore:", err);
    updateSyncStatusUI(false, "Offline / Errore Sync");
    if (outputEl) {
      outputEl.textContent = `❌ Errore durante il test Firebase:\n${err.message}`;
    }
    showToast("❌ Errore connessione Firebase: " + err.message);
    return null;
  }
}
window.testFirebaseReadWrite = testFirebaseReadWrite;

// Pending files selected inside modals
let pendingContractFile = null;
let pendingCoverFile = null;
let pendingAudioFile = null;
let pendingContractFormData = null;
let pendingGeneratedPdfDataUrl = "";
let pendingGeneratedPdfName = "";

// ==================== MOTORE COMPILAZIONE AUTOMATICA CONTRATTO PDF (4 PAGINE) ====================
function getSavedLabelDefaults() {
  try {
    const saved = JSON.parse(localStorage.getItem("vnsr_label_defaults") || "{}");
    return {
      labelName: saved.labelName || "VNSR",
      labelVat: saved.labelVat || "",
      labelRep: saved.labelRep || "",
      labelCity: saved.labelCity || "",
      labelAddress: saved.labelAddress || "",
      labelEmail: saved.labelEmail || ""
    };
  } catch (_) {
    return {
      labelName: "VNSR",
      labelVat: "",
      labelRep: "",
      labelCity: "",
      labelAddress: "",
      labelEmail: ""
    };
  }
}

function saveLabelDefaults(data) {
  try {
    localStorage.setItem(
      "vnsr_label_defaults",
      JSON.stringify({
        labelName: data.labelName || "VNSR",
        labelVat: data.labelVat || "",
        labelRep: data.labelRep || "",
        labelCity: data.labelCity || "",
        labelAddress: data.labelAddress || "",
        labelEmail: data.labelEmail || ""
      })
    );
  } catch (_) {}
}

/**
 * Compila il PDF originale di 4 pagine (contratto-template-vnsr.pdf)
 * scrivendo i valori esatti sulle righe di compilazione tramite PDFLib.
 */
async function generateFilledContractPdf(fd) {
  if (typeof window.PDFLib === "undefined") {
    throw new Error("Libreria PDFLib non caricata.");
  }

  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  let pdfBytes = null;

  if (window.VNSR_CONTRACT_TEMPLATE_B64) {
    const binStr = atob(window.VNSR_CONTRACT_TEMPLATE_B64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    pdfBytes = bytes;
  } else {
    const res = await fetch("contratto-template-vnsr.pdf");
    pdfBytes = await res.arrayBuffer();
  }

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pages = pdfDoc.getPages();
  const page1 = pages[0];
  const page2 = pages[1];
  const page3 = pages[2];
  const page4 = pages[3];

  const textDark = rgb(0.06, 0.09, 0.16);
  const boxBg = rgb(0.973, 0.98, 0.988);
  const whiteBg = rgb(1, 1, 1);

  const drawField = (page, text, x, y, size = 8.8, bold = true, maxWidth = 150) => {
    if (!text) return;
    const clean = String(text).trim();
    if (!clean) return;
    page.drawText(clean, {
      x,
      y,
      size,
      font: bold ? fontBold : fontRegular,
      color: textDark,
      maxWidth
    });
  };

  // ==================== PAGINA 1 ====================
  // PARTE 1: L'ETICHETTA DISCOGRAFICA
  drawField(page1, fd.labelName, 124, 594.3, 8.8, true, 150);
  drawField(page1, fd.labelVat, 102, 578.6, 8.8, false, 155);
  drawField(page1, fd.labelRep, 151, 562.8, 8.8, false, 126);
  drawField(page1, fd.labelCity, 152, 547.1, 8.8, false, 125);
  drawField(page1, fd.labelAddress, 133, 531.4, 8.5, false, 147);
  drawField(page1, fd.labelEmail, 109, 515.6, 8.5, false, 168);

  // PARTE 2: L'ARTISTA
  drawField(page1, fd.artistFirstName, 336, 606.2, 8.8, true, 85);
  drawField(page1, fd.artistLastName, 468, 604.6, 8.8, true, 72);
  drawField(page1, fd.artistStageName, 400, 578.6, 9.0, true, 124);
  drawField(page1, fd.artistBirthPlace, 345, 562.8, 8.5, false, 100);
  drawField(page1, fd.artistBirthDate, 460, 562.8, 8.5, false, 58);
  drawField(page1, fd.artistCf, 370, 547.1, 8.8, true, 155);
  drawField(page1, fd.artistCity, 397, 531.4, 8.5, false, 128);
  drawField(page1, fd.artistAddress, 385, 515.6, 8.5, false, 146);
  drawField(page1, fd.artistContact, 358, 500.0, 8.3, false, 164);
  drawField(page1, fd.artistDocId, 373, 484.2, 8.5, false, 152);

  // DATI IDENTIFICATIVI DELL'OPERA / MASTER FONOGRAFICO
  drawField(page1, fd.trackTitle, 155, 425.2, 9.2, true, 212);
  drawField(page1, fd.trackIsrc, 446, 425.2, 8.8, true, 92);

  // Versione Checkboxes: [ ] Original [ ] Remix [ ] Acoustic [ ] Extended
  page1.drawRectangle({ x: 154, y: 407, width: 215, height: 13, color: boxBg });
  const ver = fd.trackVersion || "Original";
  const verString =
    `${ver === "Original" ? "[X]" : "[ ]"} Original   ` +
    `${ver === "Remix" ? "[X]" : "[ ]"} Remix   ` +
    `${ver === "Acoustic" ? "[X]" : "[ ]"} Acoustic   ` +
    `${ver === "Extended" ? "[X]" : "[ ]"} Extended`;
  drawField(page1, verString, 156, 411.2, 8.5, true, 212);

  // Data Consegna
  page1.drawRectangle({ x: 444, y: 407, width: 96, height: 13, color: boxBg });
  drawField(page1, fd.deliveryDate, 452, 410.2, 8.8, true, 88);

  // ==================== PAGINA 2 ====================
  // ART. 4 - RIPARTIZIONE ECONOMICA DEI PROVENTI (ROYALTIES)
  const drawRoyaltyPair = (yPos, artPct, lblPct) => {
    page2.drawRectangle({ x: 304, y: yPos - 3, width: 52, height: 14, color: whiteBg });
    page2.drawRectangle({ x: 445, y: yPos - 3, width: 52, height: 14, color: whiteBg });
    drawField(page2, `[ ${artPct}% ]`, 310, yPos, 9.5, true, 50);
    drawField(page2, `[ ${lblPct}% ]`, 451, yPos, 9.5, true, 50);
  };

  drawRoyaltyPair(565.0, fd.royaltyStreamArtist || "50", fd.royaltyStreamLabel || "50");
  drawRoyaltyPair(500.2, fd.royaltyPhysArtist || "50", fd.royaltyPhysLabel || "50");
  drawRoyaltyPair(467.8, fd.royaltySocialArtist || "50", fd.royaltySocialLabel || "50");

  // Art. 4.2 - Spese Recuperabili
  page2.drawRectangle({ x: 65, y: 328, width: 460, height: 13, color: boxBg });
  drawField(page2, fd.recoupableCosts || "NESSUNA", 66.5, 331.5, 8.8, true, 455);

  // Art. 5.1 - Periodicità di Rendiconto
  page2.drawRectangle({ x: 65, y: 110, width: 470, height: 13, color: whiteBg });
  const isTrimestrale = fd.statementPeriod === "Trimestrale";
  const periodStr =
    `${!isTrimestrale ? "[X]" : "[ ]"} Semestrale (30 Giugno e 31 Dicembre)       ` +
    `${isTrimestrale ? "[X]" : "[ ]"} Trimestrale (Marzo, Giugno, Settembre, Dicembre)`;
  drawField(page2, periodStr, 66.5, 113.7, 8.6, true, 465);

  // ==================== PAGINA 3 ====================
  // Coordinate Bancarie IBAN Artista
  drawField(page3, fd.artistIban, 255, 789.8, 8.8, true, 280);

  // Art. 7.2 - Dichiarazione Samples
  page3.drawRectangle({ x: 65, y: 530, width: 460, height: 13, color: boxBg });
  drawField(page3, fd.samplesDeclaration || "NESSUN CAMPIONE DI TERZI UTILIZZATO", 66.5, 533.2, 8.5, true, 455);

  // Art. 10 - Foro esclusivo
  drawField(page3, fd.courtCity || "Roma", 357, 231.0, 9.0, true, 100);

  // ==================== PAGINA 4 ====================
  // Luogo e Data di sottoscrizione
  drawField(page4, fd.signPlace || "Roma", 356, 772.2, 9.0, true, 80);
  page4.drawRectangle({ x: 460, y: 767, width: 92, height: 14, color: whiteBg });
  drawField(page4, fd.signDate, 463, 770.5, 9.0, true, 88);

  const pdfDataUri = await pdfDoc.saveAsDataUri();
  const savedBytes = await pdfDoc.save();
  return { pdfDataUri, savedBytes };
}

function mergeCollectionClient(existingList, incomingList, deletedSet) {
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
      const prevTs = prev.updatedAt || prev.createdAt || "";
      const incTs = item.updatedAt || item.createdAt || "";
      if (incTs >= prevTs) {
        byId.set(item.id, item);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || "")
  );
}

function mergeLogsClient(existingLogs, incomingLogs) {
  const byId = new Map();
  for (const l of [...(existingLogs || []), ...(incomingLogs || [])]) {
    if (l && l.id) byId.set(l.id, l);
  }
  return Array.from(byId.values())
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
    .slice(0, 250);
}

function applyIncomingSnapshot(incomingDb) {
  if (!incomingDb) return false;
  const allDeleted = Array.from(
    new Set([...(state.deletedIds || []), ...(incomingDb.deletedIds || [])])
  );
  const deletedSet = new Set(allDeleted);

  state.deletedIds = allDeleted;
  if (Array.isArray(incomingDb.operatorProfiles) && incomingDb.operatorProfiles.length === 4) {
    const localProfiles = getProfilesList();
    const mergedProfiles = DEFAULT_PROFILES.map((def, idx) => {
      const loc = localProfiles[idx] || def;
      const inc = incomingDb.operatorProfiles[idx] || def;
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
  state.appointments = mergeCollectionClient(state.appointments, incomingDb.appointments || [], deletedSet);
  state.activityLog = mergeLogsClient(state.activityLog, incomingDb.activityLog || []);
  state.version = Math.max(state.version || 0, incomingDb.version || Date.now());
  return true;
}

function getBaseApiUrl() {
  const custom = (state.remoteSyncEndpoint || "").trim().replace(/\/+$/, "");
  if (custom && !custom.includes("firebaseio.com") && !custom.includes("firebasedatabase.app")) {
    return custom;
  }
  return "";
}

function isFirebaseEndpoint() {
  const custom = sanitizeFirebaseUrl(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);
  return custom.includes("firebaseio.com") || custom.includes("firebasedatabase.app");
}

function getFirebaseJsonUrl() {
  const custom = sanitizeFirebaseUrl(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);
  return custom.endsWith(".json") ? custom : `${custom}/vnsr_state.json`;
}

async function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadOrStoreFile(file, folder) {
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
        const finalUrl = baseUrl && data.url.startsWith("/") ? `${baseUrl}${data.url}` : data.url;
        return { url: finalUrl, name: file.name, size: file.size };
      }
    } catch (_) {
      // Fallback to dataUrl (syncs inline across all devices!)
    }
  }
  return { url: dataUrl, name: file.name, size: file.size };
}

function updateSyncStatusUI(online) {
  const pill = document.getElementById("openSyncModalBtn");
  const textEl = document.getElementById("syncStatusText");
  if (!pill || !textEl) return;
  pill.classList.toggle("offline", !online);
  pill.classList.toggle("online", Boolean(online));
  textEl.textContent = online ? "Online" : "Offline";
}

/**
 * Effettua un ping di rete reale verso il server DNS di Google (8.8.8.8) ogni 10 secondi
 * e durante lo scambio dati.
 * Combina il controllo diretto a https://8.8.8.8/resolve (DNS-over-HTTPS ufficiale su 8.8.8.8)
 * e, se il server locale Python è attivo, il test socket/ICMP verso 8.8.8.8.
 */
async function pingGoogleServer8888() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return false;
  }

  const PING_TIMEOUT_MS = 4500;

  // 1. Test diretto dal browser verso l'IP 8.8.8.8 di Google
  try {
    const res = await fetchWithTimeout(
      `https://8.8.8.8/resolve?name=google.com&_t=${Date.now()}`,
      { method: "GET", cache: "no-store" },
      PING_TIMEOUT_MS
    );
    if (res.ok) {
      return true;
    }
  } catch (_) {}

  // 2. Fallback no-cors diretto verso 8.8.8.8 (nel caso di restrizioni CORS sul browser)
  try {
    await fetchWithTimeout(
      `https://8.8.8.8/?_t=${Date.now()}`,
      { method: "HEAD", mode: "no-cors", cache: "no-store" },
      PING_TIMEOUT_MS
    );
    return true;
  } catch (_) {}

  // 3. Controllo tramite il server locale VNSR (che esegue ping ICMP / socket su 8.8.8.8)
  const baseUrl = getBaseApiUrl();
  try {
    const pingRes = await fetchWithTimeout(`${baseUrl}/api/ping`, { cache: "no-store" }, PING_TIMEOUT_MS);
    if (pingRes.ok) {
      const pingData = await pingRes.json();
      if (pingData && pingData.googlePingOk === true) {
        return true;
      }
    }
  } catch (_) {}

  return false;
}

async function loadApplicationData() {
  // 1. Load local IndexedDB cache first
  const localSaved = await idbGet("vnsr_state");
  if (localSaved) {
    applyIncomingSnapshot(localSaved);
  }

  let dataSyncOk = false;
  const googlePingOk = await pingGoogleServer8888();

  // 2. Try Firebase Cloud DB if configured (con timeout di 10 secondi)
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
        const res = await fetchWithTimeout(getFirebaseJsonUrl(), { cache: "no-store" }, SYNC_TIMEOUT_MS);
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

  // 3. Try VNSR Server (local or remote) con timeout di 10 secondi
  const baseUrl = getBaseApiUrl();
  try {
    const res = await fetchWithTimeout(`${baseUrl}/api/state`, { cache: "no-store" }, SYNC_TIMEOUT_MS);
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

  // Aggiorna la lampadina di stato: Verde solo se Ping 8.8.8.8 OK + Scambio Dati OK
  if (googlePingOk && dataSyncOk) {
    updateSyncStatusUI(true, "Online • Ping 8.8.8.8 OK");
  } else if (!googlePingOk) {
    updateSyncStatusUI(false, "Offline • Ping 8.8.8.8 Fallito");
  } else {
    updateSyncStatusUI(false, "Errore Sync Dati");
  }

  // 4. Seed demo data on very first launch if empty
  const alreadySeeded = localStorage.getItem("vnsr_seeded_v1");
  if (!alreadySeeded && state.artists.length === 0 && state.tracks.length === 0) {
    const nowIso = new Date().toISOString();
    const sampleArtistId = "art_vnsr_demo1";
    state.artists = [
      {
        id: sampleArtistId,
        firstName: "Lorenzo",
        lastName: "Valenti",
        stageName: "KRYPTO",
        contractStatus: "Firmato e Attivo",
        contractDate: "2026-10-15",
        contractDetails: "Contratto Discografico Esclusivo VNSR 360° — Royalty Master 70% VNSR / 30% Artista.",
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
    await saveApplicationData();
  }
}

let isPollingInProgress = false;

async function saveApplicationData() {
  state.version = Date.now();
  const dbSnapshot = {
    version: state.version,
    operatorProfiles: getProfilesList(),
    artists: state.artists,
    tracks: state.tracks,
    appointments: state.appointments,
    activityLog: state.activityLog,
    deletedIds: state.deletedIds
  };

  // 1. Salvataggio locale istantaneo (IndexedDB + BroadcastChannel + Storage Event per tutte le finestre aperte)
  idbSet("vnsr_state", dbSnapshot);
  if (syncChannel) {
    syncChannel.postMessage({ type: "STATE_UPDATED", db: dbSnapshot });
  }
  try {
    localStorage.setItem("vnsr_instant_sync_signal", String(state.version));
  } catch (_) {}

  const baseUrl = getBaseApiUrl();

  // 2. Upload istantaneo in parallelo verso Server Locale VNSR + Firebase Realtime Database + Ping Google 8.8.8.8
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
        if (res.ok) {
          fbOk = true;
        }
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

  // Esito positivo dell'upload dei dati E test ping server Google 8.8.8.8 -> Lampadina Verde
  // Esito negativo dell'upload dei dati E/O test ping server Google 8.8.8.8 -> Lampadina Rossa Lampeggiante
  if (uploadSuccess && googlePingOk) {
    updateSyncStatusUI(true);
  } else {
    updateSyncStatusUI(false);
  }
}

// Sincronizzazione continua istantanea in tempo reale (bidirezionale) + Ping Google 8.8.8.8
async function pollMultiDeviceUpdates() {
  if (isPollingInProgress) return;
  isPollingInProgress = true;

  try {
    const baseUrl = getBaseApiUrl();
    const dbUrl = sanitizeFirebaseUrl(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);

    // Esegue in parallelo il controllo server locale, il controllo Firebase Cloud e il ping 8.8.8.8
    const googlePingTask = pingGoogleServer8888();

    const firebaseCheckTask = (async () => {
      try {
        if (firebaseDb) {
          const snap = await withTimeout(firebaseDb.ref("vnsr_state").once("value"), SYNC_TIMEOUT_MS);
          const cloudDb = snap.val();
          if (cloudDb) {
            if (cloudDb.version && cloudDb.version !== (state.version || 0) && cloudDb.version > (state.version || 0)) {
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
          // Controllo ultra-rapido della versione su Firebase REST per reattività immediata
          const verRes = await fetchWithTimeout(`${dbUrl}/vnsr_state/version.json`, { cache: "no-store" }, 2200);
          if (verRes.ok) {
            const remoteVer = await verRes.json();
            if (remoteVer && Number(remoteVer) > (state.version || 0)) {
              const fullRes = await fetchWithTimeout(getFirebaseJsonUrl(), { cache: "no-store" }, SYNC_TIMEOUT_MS);
              if (fullRes.ok) {
                const cloudDb = await fullRes.json();
                if (cloudDb) {
                  applyIncomingSnapshot(cloudDb);
                  await idbSet("vnsr_state", cloudDb);
                  renderAll();
                }
              }
            } else if (remoteVer === null && (state.artists.length > 0 || state.tracks.length > 0 || state.appointments.length > 0)) {
              await fetchWithTimeout(
                getFirebaseJsonUrl(),
                {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    version: state.version || Date.now(),
                    operatorProfiles: getProfilesList(),
                    artists: state.artists,
                    tracks: state.tracks,
                    appointments: state.appointments,
                    activityLog: state.activityLog,
                    deletedIds: state.deletedIds
                  })
                },
                SYNC_TIMEOUT_MS
              );
            }
            return true;
          }
        } catch (_) {}
      }
      return false;
    })();

    const serverCheckTask = (async () => {
      try {
        const pingRes = await fetchWithTimeout(`${baseUrl}/api/ping`, { cache: "no-store" }, 2200);
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
            const stateRes = await fetchWithTimeout(`${baseUrl}/api/state`, { cache: "no-store" }, SYNC_TIMEOUT_MS);
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

    const syncDataOk = Boolean(fbSyncOk || srvSyncOk);

    if (googlePingOk && syncDataOk) {
      updateSyncStatusUI(true);
    } else {
      updateSyncStatusUI(false);
    }
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

// Reattività istantanea tra schede/finestre e al ritorno in primo piano
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

function recordActivity(actionText) {
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

// ==================== AUTENTICAZIONE CODICE OPERATORE ====================
function initAuthGate() {
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
    saveApplicationData();
    renderAll();
    showToast(`Benvenuto in VNSR, ${matched.name} (${matched.code})`);
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

function updateOperatorUI() {
  const op = state.currentOperator;
  const nameEl = document.getElementById("activeOperatorName");
  const codeEl = document.getElementById("activeOperatorCode");
  if (op) {
    nameEl.textContent = op.name;
    codeEl.textContent = `#${op.code}`;
  } else {
    nameEl.textContent = "—";
    codeEl.textContent = "----";
  }
}

// ==================== NAVIGAZIONE TABS ====================
function switchTab(tabName) {
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-view").forEach((sec) => {
    const isTarget = sec.id === `view-${tabName}`;
    sec.style.display = isTarget ? "flex" : "none";
    if (isTarget) {
      sec.style.animation = "none";
      void sec.offsetWidth; // Reflow per riavviare l'animazione Framer reveal
      sec.style.animation = "";
    }
  });
  if (tabName === "appointments") {
    renderCalendar();
    openCalendarWindowModal();
  }
}

// Blocco totale dello scroll della schermata principale (sia gesture trackpad macOS sia rotella mouse Windows)
window.addEventListener(
  "wheel",
  (e) => {
    const inModal = e.target && e.target.closest && e.target.closest(".modal-backdrop.open .modal-dialog");
    if (inModal) {
      // Nelle finestre modali blocca comunque lo scorrimento orizzontale
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
    const inModal = e.target && e.target.closest && e.target.closest(".modal-backdrop.open .modal-dialog");
    if (!inModal) {
      e.preventDefault();
    }
  },
  { passive: false }
);

// ==================== RENDERING INTERFACCIA ====================
function renderAll() {
  renderTwoFaNotifications();
  renderStats();
  renderArtistSelectOptions();
  renderArtists();
  renderTracks();
  renderCalendar();
  renderActivityLog();
}

/**
 * Controllo a 2 Fattori Contratto: mostra una notifica persistente in alto per ogni
 * artista il cui PDF precompilato è stato generato (Passaggio 1/2) ma è ancora in attesa
 * dell'upload del contratto scannerizzato con la firma (Passaggio 2/2).
 */
function renderTwoFaNotifications() {
  const container = document.getElementById("twoFaNotificationsContainer");
  if (!container) return;

  const pendingArtists = state.artists.filter((a) => {
    const hasStep1 = Boolean(a.generatedContractPdfUrl || a.contractFormData || a.contract2FAState === "pending_step2");
    const hasStep2 = Boolean(a.contractFileUrl);
    return hasStep1 && !hasStep2;
  });

  if (pendingArtists.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = pendingArtists
    .map(
      (artist) => `
      <div class="twofa-alert-banner">
        <div style="display: flex; align-items: center; gap: 14px;">
          <div style="font-size: 28px;">🔐</div>
          <div>
            <div style="font-size: 13.5px; font-weight: 800; color: var(--accent-gold); text-transform: uppercase;">
              Controllo a 2 Fattori Contratto — In Attesa del Passaggio 2/2 (Ultimo Passaggio)
            </div>
            <div style="font-size: 13.5px; color: var(--text-primary); margin-top: 3px;">
              Artista: <strong>${escapeHtml(artist.stageName)}</strong> (${escapeHtml(artist.firstName)} ${escapeHtml(artist.lastName)}) —
              <span style="color: #34d399;">✅ Passaggio 1/2: PDF Compilato Generato</span> •
              <span style="color: var(--accent-gold); font-weight: 700;">⏳ Passaggio 2/2: Carica il contratto scannerizzato con la firma</span>
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          ${
            artist.generatedContractPdfUrl
              ? `<a class="btn btn-secondary btn-sm" href="${artist.generatedContractPdfUrl}" download="${escapeHtml(artist.generatedContractPdfName || `Contratto_VNSR_${artist.stageName}_Da_Firmare.pdf`)}" target="_blank">
                  🖨️ Ristampa PDF (Step 1/2)
                 </a>`
              : ""
          }
          <label class="btn btn-primary btn-sm" style="cursor: pointer;">
            📤 Carica Contratto Firmato (Completa Step 2/2)
            <input type="file" accept=".pdf,.png,.jpg,.jpeg" style="display: none;" onchange="quickUploadSignedContract('${artist.id}', this.files[0])" />
          </label>
        </div>
      </div>
    `
    )
    .join("");
}

window.quickUploadSignedContract = async function (artistId, file) {
  if (!file) return;
  const artist = state.artists.find((a) => a.id === artistId);
  if (!artist) return;

  showToast("⏳ Caricamento scansione contratto firmato in corso...");
  const uploaded = await uploadOrStoreFile(file, "contracts");
  const nowIso = new Date().toISOString();
  const todayDate = nowIso.slice(0, 10);

  state.artists = state.artists.map((a) =>
    a.id === artistId
      ? {
          ...a,
          contractFileUrl: uploaded.url,
          contractFileName: uploaded.name,
          contractStatus: "Firmato e Attivo",
          contractDate: a.contractDate || todayDate,
          contract2FAState: "verified_2fa",
          updatedAt: nowIso
        }
      : a
  );

  recordActivity(`Completato Passaggio 2/2 (2FA): caricato contratto firmato scannerizzato per "${artist.stageName}"`);
  await saveApplicationData();
  renderAll();
  showToast(`✅ Controllo a 2 Fattori completato per ${artist.stageName}! Contratto firmato registrato.`);
};

function renderStats() {
  document.getElementById("statArtistsCount").textContent = state.artists.length;
  document.getElementById("statTracksCount").textContent = state.tracks.length;
  const withContracts = state.artists.filter(
    (a) => a.contractStatus === "Firmato e Attivo" || a.contractFileUrl || a.contractFileName
  ).length;
  document.getElementById("statContractsCount").textContent = withContracts;
  const withAudio = state.tracks.filter((t) => Boolean(t.audioUrl)).length;
  document.getElementById("statAudioCount").textContent = withAudio;
}

// ==================== HELPERS ANAGRAFICA (ARTISTI & COLLABORATORI) ====================
let activeAnagraficaTypeFilter = "ALL";

function getPersonType(person) {
  if (!person) return "Artista";
  return person.personType === "Collaboratore" ? "Collaboratore" : "Artista";
}

function getPersonDisplayName(person) {
  if (!person) return "Senza Nome";
  const stage = (person.stageName || "").trim();
  const legal = `${(person.firstName || "").trim()} ${(person.lastName || "").trim()}`.trim();
  if (person.nameMode === "legal" && legal) return legal;
  if (person.nameMode === "stage" && stage) return stage;
  return stage || legal || "Senza Nome";
}

function getPersonNameMode(person) {
  if (!person) return "stage";
  if (person.nameMode === "legal" || person.nameMode === "stage") return person.nameMode;
  const hasStage = Boolean((person.stageName || "").trim());
  const hasLegal = Boolean(`${(person.firstName || "").trim()} ${(person.lastName || "").trim()}`.trim());
  if (hasLegal && !hasStage) return "legal";
  return "stage";
}

function renderAnagraficaPreselectablePills() {
  const allPeople = state.artists || [];
  const artistsList = allPeople.filter((p) => getPersonType(p) === "Artista");
  const collabsList = allPeople.filter((p) => getPersonType(p) === "Collaboratore");

  // 1. Datalist globale per tutti i campi di input con autocompletamento
  const datalistEl = document.getElementById("anagraficaAllNamesList");
  if (datalistEl) {
    datalistEl.innerHTML = allPeople
      .map((p) => {
        const name = getPersonDisplayName(p);
        const pType = getPersonType(p);
        return `<option value="${escapeHtml(name)}">${pType === "Collaboratore" ? "🤝 Collaboratore" : "🎤 Artista"} — ${escapeHtml(name)}</option>`;
      })
      .join("");
  }

  // 2. Pillole preselezionabili per Artista Principale in Traccia (#trackMainArtistQuickPills)
  const mainArtistPillsEl = document.getElementById("trackMainArtistQuickPills");
  if (mainArtistPillsEl) {
    const orderedForMain = [...artistsList, ...collabsList];
    const currentMainVal = (document.getElementById("trackMainArtistDisplay")?.value || "").trim().toLowerCase();
    mainArtistPillsEl.innerHTML =
      orderedForMain.length > 0
        ? orderedForMain
            .map((p) => {
              const name = getPersonDisplayName(p);
              const isCollab = getPersonType(p) === "Collaboratore";
              const isSelected = currentMainVal === name.toLowerCase();
              return `<button type="button" class="preselect-person-pill ${isCollab ? "pill-collab" : ""} ${isSelected ? "selected" : ""}" onclick="selectAnagraficaForMainArtist('${p.id}')">${isCollab ? "🤝" : "🎤"} ${escapeHtml(name)}</button>`;
            })
            .join("")
        : `<span style="font-size: 11px; color: var(--text-muted);">Nessun nominativo in Anagrafica</span>`;
  }

  // 3. Pillole preselezionabili per Producer in Traccia (#trackProducerQuickPills)
  const producerPillsEl = document.getElementById("trackProducerQuickPills");
  if (producerPillsEl) {
    const orderedForProd = [...collabsList, ...artistsList];
    const currentProdVal = (document.getElementById("trackProducerInput")?.value || "").trim().toLowerCase();
    producerPillsEl.innerHTML =
      orderedForProd.length > 0
        ? orderedForProd
            .map((p) => {
              const name = getPersonDisplayName(p);
              const isCollab = getPersonType(p) === "Collaboratore";
              const isSelected = currentProdVal
                .split(",")
                .map((s) => s.trim())
                .includes(name.toLowerCase());
              return `<button type="button" class="preselect-person-pill ${isCollab ? "pill-collab" : ""} ${isSelected ? "selected" : ""}" onclick="selectAnagraficaForProducer('${p.id}')">${isCollab ? "🤝" : "🎤"} ${escapeHtml(name)}</button>`;
            })
            .join("")
        : `<span style="font-size: 11px; color: var(--text-muted);">Nessun collaboratore/producer in Anagrafica</span>`;
  }

  // 4. Pillole preselezionabili per Featuring o Diritti in Traccia (#trackFeaturedQuickPills)
  const featPillsEl = document.getElementById("trackFeaturedQuickPills");
  if (featPillsEl) {
    const orderedForFeat = [...collabsList, ...artistsList];
    const currentFeatRaw = (document.getElementById("trackFeaturedInput")?.value || "").toLowerCase();
    featPillsEl.innerHTML =
      orderedForFeat.length > 0
        ? orderedForFeat
            .map((p) => {
              const name = getPersonDisplayName(p);
              const isCollab = getPersonType(p) === "Collaboratore";
              const isSelected = currentFeatRaw.includes(name.toLowerCase());
              return `<button type="button" class="preselect-person-pill ${isCollab ? "pill-collab" : ""} ${isSelected ? "selected" : ""}" onclick="toggleAnagraficaInFeatured('${p.id}')">${isCollab ? "🤝 Collab:" : "🎤 Feat:"} ${escapeHtml(name)}</button>`;
            })
            .join("")
        : `<span style="font-size: 11px; color: var(--text-muted);">Aggiungi Collaboratori o Artisti in Anagrafica per ritrovarli qui preselezionabili</span>`;
  }

  // 5. Pillole preselezionabili in Contratto PDF — Parte 2 Titolare Diritti (#cbPreselectAnagraficaPills)
  const cbParte2PillsEl = document.getElementById("cbPreselectAnagraficaPills");
  if (cbParte2PillsEl) {
    cbParte2PillsEl.innerHTML =
      allPeople.length > 0
        ? allPeople
            .map((p) => {
              const name = getPersonDisplayName(p);
              const isCollab = getPersonType(p) === "Collaboratore";
              return `<button type="button" class="preselect-person-pill ${isCollab ? "pill-collab" : ""}" onclick="selectAnagraficaForContractParty2('${p.id}')">${isCollab ? "🤝 Collaboratore:" : "🎤 Artista:"} ${escapeHtml(name)}</button>`;
            })
            .join("")
        : `<span style="font-size: 11px; color: var(--text-muted);">Nessun nominativo in Anagrafica</span>`;
  }

  // 6. Pillole preselezionabili in Contratto PDF — Art. 7.2 Collaboratori Diritti / Samples (#cbRightsCollaboratorsPills)
  const cbRightsPillsEl = document.getElementById("cbRightsCollaboratorsPills");
  if (cbRightsPillsEl) {
    const orderedForRights = [...collabsList, ...artistsList];
    const currentSamplesVal = (document.getElementById("cbSamplesDeclaration")?.value || "").toLowerCase();
    cbRightsPillsEl.innerHTML =
      orderedForRights.length > 0
        ? orderedForRights
            .map((p) => {
              const name = getPersonDisplayName(p);
              const isCollab = getPersonType(p) === "Collaboratore";
              const isSelected = currentSamplesVal.includes(name.toLowerCase());
              return `<button type="button" class="preselect-person-pill ${isCollab ? "pill-collab" : ""} ${isSelected ? "selected" : ""}" onclick="toggleAnagraficaInContractRights('${p.id}')">${isCollab ? "🤝 Diritti Collab:" : "🎤 Feat/Diritti:"} ${escapeHtml(name)}</button>`;
            })
            .join("")
        : `<span style="font-size: 11px; color: var(--text-muted);">Nessun collaboratore in Anagrafica</span>`;
  }
}

window.selectAnagraficaForMainArtist = function (personId) {
  const person = state.artists.find((a) => a.id === personId);
  if (!person) return;
  const displayName = getPersonDisplayName(person);
  const mainInput = document.getElementById("trackMainArtistDisplay");
  const selectEl = document.getElementById("trackArtistSelect");
  if (mainInput) mainInput.value = displayName;
  if (selectEl) selectEl.value = person.id;
  renderAnagraficaPreselectablePills();
};

window.selectAnagraficaForProducer = function (personId) {
  const person = state.artists.find((a) => a.id === personId);
  if (!person) return;
  const displayName = getPersonDisplayName(person);
  const prodInput = document.getElementById("trackProducerInput");
  if (!prodInput) return;

  const currentParts = prodInput.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const existingIdx = currentParts.findIndex((p) => p.toLowerCase() === displayName.toLowerCase());
  if (existingIdx >= 0) {
    currentParts.splice(existingIdx, 1);
  } else {
    currentParts.push(displayName);
  }
  prodInput.value = currentParts.join(", ");
  renderAnagraficaPreselectablePills();
};

window.toggleAnagraficaInFeatured = function (personId) {
  const person = state.artists.find((a) => a.id === personId);
  if (!person) return;
  const displayName = getPersonDisplayName(person);
  const isCollab = getPersonType(person) === "Collaboratore";
  const featInput = document.getElementById("trackFeaturedInput");
  if (!featInput) return;

  const parts = featInput.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const matchIdx = parts.findIndex((item) => item.toLowerCase().includes(displayName.toLowerCase()));
  if (matchIdx >= 0) {
    parts.splice(matchIdx, 1);
  } else {
    const tag = isCollab ? `Collab/Diritti: ${displayName}` : `Feat. ${displayName}`;
    parts.push(tag);
  }
  featInput.value = parts.join(", ");
  renderAnagraficaPreselectablePills();
};

window.selectAnagraficaForContractParty2 = function (personId) {
  const person = state.artists.find((a) => a.id === personId);
  if (!person) return;
  const displayName = getPersonDisplayName(person);
  const fnEl = document.getElementById("cbArtistFirstName");
  const lnEl = document.getElementById("cbArtistLastName");
  const stEl = document.getElementById("cbArtistStageName");

  if (fnEl) fnEl.value = person.firstName || "";
  if (lnEl) lnEl.value = person.lastName || "";
  if (stEl) stEl.value = person.stageName || "";

  showToast(`⚡ Preselezionato da Anagrafica: ${displayName} (${getPersonType(person)})`);
};

window.toggleAnagraficaInContractRights = function (personId) {
  const person = state.artists.find((a) => a.id === personId);
  if (!person) return;
  const displayName = getPersonDisplayName(person);
  const roleLabel = getPersonType(person) === "Collaboratore" ? "Collaboratore Diritti" : "Artista Feat./Diritti";
  const inputEl = document.getElementById("cbSamplesDeclaration");
  if (!inputEl) return;

  const defaultText = "NESSUN CAMPIONE DI TERZI UTILIZZATO";
  let current = inputEl.value.trim();
  if (current.toUpperCase() === defaultText) {
    current = "";
  }

  const parts = current
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const idx = parts.findIndex((item) => item.toLowerCase().includes(displayName.toLowerCase()));
  if (idx >= 0) {
    parts.splice(idx, 1);
  } else {
    parts.push(`${roleLabel}: ${displayName}`);
  }

  inputEl.value = parts.length > 0 ? parts.join("; ") : defaultText;
  renderAnagraficaPreselectablePills();
};

function renderArtistSelectOptions() {
  const filterSelect = document.getElementById("trackArtistFilter");
  const modalSelect = document.getElementById("trackArtistSelect");
  const apptArtistSelect = document.getElementById("apptArtistSelect");
  const currentFilter = filterSelect.value || "ALL";
  const currentApptArtist = apptArtistSelect ? apptArtistSelect.value : "";

  filterSelect.innerHTML = `<option value="ALL">Tutti in Anagrafica VNSR (${state.artists.length})</option>`;
  modalSelect.innerHTML = "";
  if (apptArtistSelect) {
    apptArtistSelect.innerHTML = `<option value="">— Nessun Soggetto Specifico (Generale Etichetta) —</option>`;
  }

  state.artists.forEach((artist) => {
    const displayName = getPersonDisplayName(artist);
    const pType = getPersonType(artist);
    const roleIcon = pType === "Collaboratore" ? "🤝" : "🎤";

    const opt1 = document.createElement("option");
    opt1.value = artist.id;
    opt1.textContent = `${roleIcon} ${displayName} (${pType})`;
    filterSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = artist.id;
    opt2.textContent = `${roleIcon} ${displayName} — ${pType}`;
    modalSelect.appendChild(opt2);

    if (apptArtistSelect) {
      const opt3 = document.createElement("option");
      opt3.value = displayName;
      opt3.textContent = `${roleIcon} ${displayName} (${pType})`;
      apptArtistSelect.appendChild(opt3);
    }
  });

  if ([...filterSelect.options].some((o) => o.value === currentFilter)) {
    filterSelect.value = currentFilter;
  }
  if (apptArtistSelect && [...apptArtistSelect.options].some((o) => o.value === currentApptArtist)) {
    apptArtistSelect.value = currentApptArtist;
  }

  renderAnagraficaPreselectablePills();
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderArtists() {
  const container = document.getElementById("artistsContainer");
  const query = (document.getElementById("artistSearchInput").value || "").toLowerCase().trim();

  const filtered = state.artists.filter((a) => {
    const pType = getPersonType(a);
    if (activeAnagraficaTypeFilter !== "ALL" && pType !== activeAnagraficaTypeFilter) {
      return false;
    }
    const displayName = getPersonDisplayName(a);
    const hay = `${displayName} ${a.stageName || ""} ${a.firstName || ""} ${a.lastName || ""} ${pType} ${a.contractDetails || ""}`.toLowerCase();
    return hay.includes(query);
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div style="font-size: 40px;">🎤🤝</div>
        <h3>Nessuna scheda in Anagrafica</h3>
        <p>Aggiungi un <strong>Artista</strong> o un <strong>Collaboratore</strong> (compilando Nome d'Arte oppure Nome e Cognome) per averlo sempre preselezionabile in tracce, featuring e diritti.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((artist, idx) => {
      const displayName = getPersonDisplayName(artist);
      const pType = getPersonType(artist);
      const isCollab = pType === "Collaboratore";
      const nameMode = getPersonNameMode(artist);
      const artistTracks = state.tracks.filter(
        (t) =>
          t.artistId === artist.id ||
          (t.mainArtist || "").toLowerCase() === displayName.toLowerCase() ||
          (t.producer || "").toLowerCase().includes(displayName.toLowerCase()) ||
          (Array.isArray(t.featuredArtists) ? t.featuredArtists.join(" ") : t.featuredArtists || "")
            .toLowerCase()
            .includes(displayName.toLowerCase())
      );
      const initials = displayName.slice(0, 2).toUpperCase();
      const hasStep1 = Boolean(artist.generatedContractPdfUrl || artist.contractFormData || artist.contract2FAState === "pending_step2" || artist.contract2FAState === "verified_2fa");
      const hasStep2 = Boolean(artist.contractFileUrl);
      const isSigned = hasStep2 || artist.contractStatus === "Firmato e Attivo";

      return `
        <article class="artist-card" style="animation-delay: ${Math.min(idx * 55, 350)}ms;">
          <div class="artist-card-header">
            <div class="artist-avatar">${escapeHtml(initials)}</div>
            <div class="artist-identity">
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span class="person-role-pill ${isCollab ? "role-collaboratore" : "role-artista"}">
                  ${isCollab ? "🤝 Collaboratore" : "🎤 Artista"}
                </span>
                <span style="font-size: 10.5px; color: var(--text-muted);">
                  ${nameMode === "legal" ? "🪪 Nome e Cognome" : "✨ Nome d'Arte"}
                </span>
              </div>
              <div class="artist-stage-name" style="margin-top: 3px;">
                ${escapeHtml(displayName)}
              </div>
            </div>
            <span class="badge ${hasStep2 ? "badge-signed" : hasStep1 ? "badge-pending" : isSigned ? "badge-signed" : "badge-pending"}">
              ${hasStep1 && !hasStep2 ? "⏳ In Attesa Firma (Step 2/2)" : escapeHtml(artist.contractStatus)}
            </span>
          </div>

          <div class="contract-box">
            <div class="contract-top">
              <strong style="font-size: 12px; color: var(--text-primary); text-transform: uppercase;">
                🔐 Contratto & Diritti VNSR (Controllo 2 Fattori)
              </strong>
              ${
                artist.contractDate
                  ? `<span style="font-size: 11.5px; color: var(--text-muted);">Data: ${escapeHtml(artist.contractDate)}</span>`
                  : ""
              }
            </div>
            <div class="contract-notes">
              ${escapeHtml(artist.contractDetails || "Disponibile in preselezione rapida per Featuring, Produzione e Diritti.")}
            </div>

            <!-- 2FA STEPPER SULLA CARD ANAGRAFICA -->
            <div class="twofa-stepper">
              <div class="twofa-step ${hasStep1 ? "done" : ""}">
                <span>${hasStep1 ? "✅" : "1️⃣"}</span>
                <div style="min-width: 0;">
                  <strong>Step 1/2: PDF Compilato</strong>
                  <div style="font-size: 11px;">
                    ${
                      artist.generatedContractPdfUrl
                        ? `<a href="${artist.generatedContractPdfUrl}" download="${escapeHtml(artist.generatedContractPdfName || `Contratto_VNSR_${displayName}_Da_Firmare.pdf`)}" style="color: inherit; text-decoration: underline;">🖨️ Scarica/Stampa PDF</a>`
                        : hasStep1
                        ? "Generato"
                        : "Da compilare"
                    }
                  </div>
                </div>
              </div>

              <div class="twofa-step ${hasStep2 ? "done" : hasStep1 ? "waiting" : ""}">
                <span>${hasStep2 ? "✅" : hasStep1 ? "⚠️" : "2️⃣"}</span>
                <div style="min-width: 0;">
                  <strong>Step 2/2: Scansione Firmata</strong>
                  <div style="font-size: 11px;">
                    ${
                      hasStep2
                        ? `<a href="${artist.contractFileUrl}" download="${escapeHtml(artist.contractFileName || "contratto_firmato.pdf")}" target="_blank" style="color: inherit; text-decoration: underline;">📎 Apri Firmato</a>`
                        : hasStep1
                        ? `<label style="cursor: pointer; text-decoration: underline; font-weight: 700;">📤 Carica Scansione Ora<input type="file" accept=".pdf,.png,.jpg,.jpeg" style="display:none;" onchange="quickUploadSignedContract('${artist.id}', this.files[0])" /></label>`
                        : "In attesa Step 1"
                    }
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="filterTracksByArtist('${artist.id}')">
              🎵 Tracce / Crediti (${artistTracks.length})
            </button>
            <button type="button" class="btn btn-primary btn-sm" onclick="openTrackModalForArtist('${artist.id}')">
              ➕ Usa in Traccia
            </button>
          </div>

          <div class="artist-card-footer">
            <span style="font-size: 11px; color: var(--text-muted);">
              Operatore: <strong>${escapeHtml(artist.createdBy || "VNSR")}</strong>
            </span>
            <div style="display: flex; gap: 6px;">
              <button type="button" class="btn btn-secondary btn-sm" onclick="openEditArtistModal('${artist.id}')">
                ✏️ Modifica
              </button>
              <button type="button" class="btn btn-danger btn-sm" onclick="deleteArtist('${artist.id}')">
                🗑️
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderTracks() {
  const container = document.getElementById("tracksContainer");
  const query = (document.getElementById("trackSearchInput").value || "").toLowerCase().trim();
  const artistFilter = document.getElementById("trackArtistFilter").value || "ALL";

  const filtered = state.tracks.filter((t) => {
    if (artistFilter !== "ALL" && t.artistId !== artistFilter) return false;
    const feats = Array.isArray(t.featuredArtists) ? t.featuredArtists.join(" ") : t.featuredArtists || "";
    const hay = `${t.title} ${t.mainArtist} ${t.producer} ${feats} ${t.upc} ${t.isrc}`.toLowerCase();
    return hay.includes(query);
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div style="font-size: 40px;">💿</div>
        <h3>Nessuna traccia trovata</h3>
        <p>Aggiungi una nuova canzone con grafica Artista/Producer, codice UPC, ISRC, copertina e file MP3.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((track, idx) => {
      const feats = Array.isArray(track.featuredArtists)
        ? track.featuredArtists.filter(Boolean)
        : (track.featuredArtists || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

      return `
        <article class="track-card" style="animation-delay: ${Math.min(idx * 55, 350)}ms;">
          <div class="track-top">
            <div class="track-cover-wrap">
              ${
                track.coverUrl
                  ? `<img src="${track.coverUrl}" alt="${escapeHtml(track.title)}" />`
                  : `<div class="track-cover-placeholder"><img src="logo-vnsr-wide.png" alt="VNSR" /></div>`
              }
              ${
                track.audioUrl
                  ? `<button type="button" class="track-play-overlay" onclick="playTrackInGlobalPlayer('${track.id}')" title="Riproduci Master MP3">▶</button>`
                  : ""
              }
            </div>

            <div class="track-title-area">
              <div class="track-title">${escapeHtml(track.title)}</div>

              <div class="track-codes-row">
                <span class="code-chip" onclick="copyCode('${escapeHtml(track.upc)}', 'UPC')" title="Clicca per copiare il codice UPC">
                  <strong>UPC:</strong> ${escapeHtml(track.upc)} 📋
                </span>
                <span class="code-chip" onclick="copyCode('${escapeHtml(track.isrc)}', 'ISRC')" title="Clicca per copiare il codice ISRC">
                  <strong>ISRC:</strong> ${escapeHtml(track.isrc)} 📋
                </span>
              </div>
            </div>
          </div>

          <!-- GRAFICA DI RILIEVO PER ARTISTA E PRODUCER -->
          <div class="spotlight-credits-grid">
            <div class="spotlight-badge spotlight-artist">
              <div class="spotlight-icon">🎤</div>
              <div class="spotlight-meta">
                <span class="spotlight-role">★ Main Artist</span>
                <div class="spotlight-name" title="${escapeHtml(track.mainArtist)}">
                  ${escapeHtml(track.mainArtist)}
                </div>
              </div>
            </div>

            <div class="spotlight-badge spotlight-producer">
              <div class="spotlight-icon">🎛️</div>
              <div class="spotlight-meta">
                <span class="spotlight-role">⚡ Prod. By (Producer)</span>
                <div class="spotlight-name" title="${escapeHtml(track.producer)}">
                  ${escapeHtml(track.producer)}
                </div>
              </div>
            </div>
          </div>

          <!-- ALTRI ARTISTI MENZIONATI O CHE HANNO PARTECIPATO -->
          <div class="featuring-row">
            <span style="font-weight: 700;">Partecipazioni / Menzioni:</span>
            ${
              feats.length > 0
                ? feats.map((f) => `<span class="feat-pill">${escapeHtml(f)}</span>`).join("")
                : `<span style="color: var(--text-muted);">Nessun altro partecipante menzionato</span>`
            }
          </div>

          <!-- PLAYER MP3 DELLA TRACCIA -->
          <div class="track-audio-bar">
            ${
              track.audioUrl
                ? `
                  <button type="button" class="btn btn-primary btn-sm" onclick="playTrackInGlobalPlayer('${track.id}')">
                    ▶ Ascolta nel Player VNSR
                  </button>
                  <a class="btn btn-secondary btn-sm" href="${track.audioUrl}" download="${escapeHtml(track.audioFileName || track.title + ".mp3")}">
                    ⬇️ Scarica MP3
                  </a>
                `
                : `<span style="font-size: 12.5px; color: var(--text-muted);">🔇 Nessun file MP3 caricato (clicca Modifica per caricare l'MP3)</span>`
            }
          </div>

          <div class="track-footer-meta">
            <span>Operatore: <strong>${escapeHtml(track.createdBy || "VNSR")}</strong></span>
            <div style="display: flex; gap: 6px;">
              <button type="button" class="btn btn-secondary btn-sm" onclick="openEditTrackModal('${track.id}')">
                ✏️ Modifica
              </button>
              <button type="button" class="btn btn-danger btn-sm" onclick="deleteTrack('${track.id}')">
                🗑️
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderActivityLog() {
  const container = document.getElementById("activityContainer");
  if (state.activityLog.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>Nessuna operazione registrata.</p></div>`;
    return;
  }

  container.innerHTML = state.activityLog
    .map((item) => {
      const dateStr = new Date(item.timestamp).toLocaleString("it-IT");
      return `
        <div style="background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; gap: 14px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="operator-code">#${escapeHtml(item.operatorCode)}</span>
            <strong style="color: var(--accent-gold);">${escapeHtml(item.operatorName)}</strong>
            <span style="color: var(--text-primary); font-size: 14px;">${escapeHtml(item.action)}</span>
          </div>
          <span style="font-size: 12px; color: var(--text-muted); white-space: nowrap;">${escapeHtml(dateStr)}</span>
        </div>
      `;
    })
    .join("");
}

// ==================== AZIONI ARTISTI ====================
window.filterTracksByArtist = function (artistId) {
  const filterSelect = document.getElementById("trackArtistFilter");
  filterSelect.value = artistId;
  switchTab("tracks");
  renderTracks();
};

function updateModalTwoFaUI(step1Done, step2Done, genFileName = "", signedFileName = "") {
  const step1Box = document.getElementById("modalStep1Box");
  const step2Box = document.getElementById("modalStep2Box");
  const step1Status = document.getElementById("modalStep1Status");
  const step2Status = document.getElementById("modalStep2Status");

  if (!step1Box || !step2Box) return;

  step1Box.className = `twofa-step ${step1Done ? "done" : ""}`;
  step1Status.innerHTML = step1Done
    ? `✅ Generato (${escapeHtml(genFileName || "PDF Pronto da Stampare")})`
    : "Non ancora generato";

  if (step2Done) {
    step2Box.className = "twofa-step done";
    step2Status.innerHTML = `✅ Verificato 2/2 (${escapeHtml(signedFileName || "Scansione Firmata")})`;
  } else if (step1Done) {
    step2Box.className = "twofa-step waiting";
    step2Status.innerHTML = "⚠️ IN ATTESA: Carica scansione firmata!";
  } else {
    step2Box.className = "twofa-step";
    step2Status.textContent = "In attesa del Passaggio 1";
  }
}

function setAnagraficaPersonType(pType) {
  const normalized = pType === "Collaboratore" ? "Collaboratore" : "Artista";
  const hiddenInput = document.getElementById("artistPersonTypeInput");
  const artBtn = document.getElementById("personTypeArtistaBtn");
  const colBtn = document.getElementById("personTypeCollabBtn");
  const submitBtn = document.getElementById("artistFormSubmitBtn");

  if (hiddenInput) hiddenInput.value = normalized;
  if (artBtn) artBtn.classList.toggle("active", normalized === "Artista");
  if (colBtn) colBtn.classList.toggle("active", normalized === "Collaboratore");
  if (submitBtn) {
    submitBtn.innerHTML =
      normalized === "Collaboratore"
        ? "💾 Salva Collaboratore in Anagrafica"
        : "💾 Salva Artista in Anagrafica";
  }
}

function setAnagraficaNameMode(mode) {
  const normalized = mode === "legal" ? "legal" : "stage";
  const stageBtn = document.getElementById("nameModeStageBtn");
  const legalBtn = document.getElementById("nameModeLegalBtn");
  const stageWrap = document.getElementById("stageNameFieldWrap");
  const legalWrap = document.getElementById("legalNameFieldsWrap");
  const stageInput = document.getElementById("artistStageName");
  const firstInput = document.getElementById("artistFirstName");
  const lastInput = document.getElementById("artistLastName");
  const errEl = document.getElementById("artistIdentityError");

  if (errEl) errEl.textContent = "";
  if (stageBtn) stageBtn.classList.toggle("active", normalized === "stage");
  if (legalBtn) legalBtn.classList.toggle("active", normalized === "legal");

  if (normalized === "stage") {
    if (stageWrap) {
      stageWrap.classList.add("active-mode");
      stageWrap.classList.remove("disabled-mode");
    }
    if (legalWrap) {
      legalWrap.classList.add("disabled-mode");
      legalWrap.classList.remove("active-mode");
    }
    if (stageInput) stageInput.disabled = false;
    if (firstInput) {
      firstInput.value = "";
      firstInput.disabled = true;
    }
    if (lastInput) {
      lastInput.value = "";
      lastInput.disabled = true;
    }
  } else {
    if (legalWrap) {
      legalWrap.classList.add("active-mode");
      legalWrap.classList.remove("disabled-mode");
    }
    if (stageWrap) {
      stageWrap.classList.add("disabled-mode");
      stageWrap.classList.remove("active-mode");
    }
    if (firstInput) firstInput.disabled = false;
    if (lastInput) lastInput.disabled = false;
    if (stageInput) {
      stageInput.value = "";
      stageInput.disabled = true;
    }
  }
}

window.openNewAnagraficaModal = function (defaultPersonType = "Artista") {
  pendingContractFile = null;
  pendingContractFormData = null;
  pendingGeneratedPdfDataUrl = "";
  pendingGeneratedPdfName = "";
  document.getElementById("artistForm").reset();
  document.getElementById("artistIdInput").value = "";
  setAnagraficaPersonType(defaultPersonType);
  setAnagraficaNameMode("stage");

  if (defaultPersonType === "Collaboratore") {
    document.getElementById("artistContractStatus").value = "Collaboratore Esterno / Diritti";
    document.getElementById("artistModalTitle").textContent = "🤝 Aggiungi Collaboratore in Anagrafica";
  } else {
    document.getElementById("artistContractStatus").value = "Firmato e Attivo";
    document.getElementById("artistModalTitle").textContent = "🎤 Nuovo Artista in Anagrafica";
  }

  updateModalTwoFaUI(false, false);
  document.getElementById("artistContractFileLabel").innerHTML =
    `📄 <strong>Clicca per caricare il Contratto Scannerizzato con Firma</strong> (Completa Passaggio 2/2)`;
  document.getElementById("artistModal").classList.add("open");
};

window.openEditArtistModal = function (artistId) {
  const artist = state.artists.find((a) => a.id === artistId);
  if (!artist) return;

  pendingContractFile = null;
  pendingContractFormData = artist.contractFormData || null;
  pendingGeneratedPdfDataUrl = artist.generatedContractPdfUrl || "";
  pendingGeneratedPdfName = artist.generatedContractPdfName || "";

  const pType = getPersonType(artist);
  const nMode = getPersonNameMode(artist);
  const displayName = getPersonDisplayName(artist);

  setAnagraficaPersonType(pType);
  setAnagraficaNameMode(nMode);

  document.getElementById("artistModalTitle").textContent = `Modifica ${pType}: ${displayName}`;
  document.getElementById("artistIdInput").value = artist.id;
  if (nMode === "stage") {
    document.getElementById("artistStageName").value = artist.stageName || displayName;
    document.getElementById("artistFirstName").value = "";
    document.getElementById("artistLastName").value = "";
  } else {
    document.getElementById("artistStageName").value = "";
    document.getElementById("artistFirstName").value = artist.firstName || "";
    document.getElementById("artistLastName").value = artist.lastName || "";
  }
  document.getElementById("artistContractStatus").value = artist.contractStatus || "Firmato e Attivo";
  document.getElementById("artistContractDate").value = artist.contractDate || "";
  document.getElementById("artistContractDetails").value = artist.contractDetails || "";

  const hasStep1 = Boolean(pendingGeneratedPdfDataUrl || pendingContractFormData || artist.contract2FAState === "pending_step2" || artist.contract2FAState === "verified_2fa");
  const hasStep2 = Boolean(artist.contractFileUrl);
  updateModalTwoFaUI(hasStep1, hasStep2, pendingGeneratedPdfName, artist.contractFileName);

  document.getElementById("artistContractFileLabel").innerHTML = artist.contractFileName
    ? `✅ Scansione Firmata presente: <strong>${escapeHtml(artist.contractFileName)}</strong> (clicca per sostituire)`
    : `📄 <strong>Clicca per caricare il Contratto Scannerizzato con Firma</strong> (Completa Passaggio 2/2)`;

  document.getElementById("artistModal").classList.add("open");
};

window.deleteArtist = async function (artistId) {
  const artist = state.artists.find((a) => a.id === artistId);
  if (!artist) return;
  const displayName = getPersonDisplayName(artist);
  const pType = getPersonType(artist);
  if (!confirm(`Vuoi davvero eliminare ${pType.toLowerCase()} "${displayName}" da tutti i dispositivi?`)) return;

  const removedTrackIds = state.tracks.filter((t) => t.artistId === artistId).map((t) => t.id);
  state.deletedIds = Array.from(new Set([...(state.deletedIds || []), artistId, ...removedTrackIds]));
  state.artists = state.artists.filter((a) => a.id !== artistId);
  state.tracks = state.tracks.filter((t) => t.artistId !== artistId);

  recordActivity(`Eliminata scheda anagrafica ${pType.toLowerCase()} "${displayName}"`);
  await saveApplicationData();
  renderAll();
  showToast(`${pType} ${displayName} rimosso e sincronizzato`);
};

// ==================== AZIONI TRACCE ====================
window.openTrackModalForArtist = function (artistId) {
  if (state.artists.length === 0) {
    showToast("Aggiungi prima almeno un Artista o Collaboratore in Anagrafica!");
    return;
  }
  pendingCoverFile = null;
  pendingAudioFile = null;
  document.getElementById("trackForm").reset();
  document.getElementById("trackIdInput").value = "";
  document.getElementById("trackModalTitle").textContent = "Aggiungi Nuova Traccia VNSR";

  renderArtistSelectOptions();
  const select = document.getElementById("trackArtistSelect");
  if (artistId) select.value = artistId;

  const chosenArtist = state.artists.find((a) => a.id === select.value);
  if (chosenArtist) {
    const disp = getPersonDisplayName(chosenArtist);
    if (getPersonType(chosenArtist) === "Collaboratore") {
      document.getElementById("trackProducerInput").value = disp;
    } else {
      document.getElementById("trackMainArtistDisplay").value = disp;
    }
  }
  renderAnagraficaPreselectablePills();

  document.getElementById("trackCoverFileLabel").innerHTML = `🖼️ <strong>Carica Copertina</strong> (JPG, PNG, WebP)`;
  document.getElementById("trackAudioFileLabel").innerHTML = `🎵 <strong>Carica File MP3</strong> della traccia`;
  document.getElementById("trackModal").classList.add("open");
};

window.openEditTrackModal = function (trackId) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;

  pendingCoverFile = null;
  pendingAudioFile = null;
  renderArtistSelectOptions();

  document.getElementById("trackModalTitle").textContent = `Modifica Traccia: ${track.title}`;
  document.getElementById("trackIdInput").value = track.id;
  document.getElementById("trackArtistSelect").value = track.artistId;
  document.getElementById("trackTitleInput").value = track.title;
  document.getElementById("trackMainArtistDisplay").value = track.mainArtist;
  document.getElementById("trackProducerInput").value = track.producer;
  document.getElementById("trackFeaturedInput").value = Array.isArray(track.featuredArtists)
    ? track.featuredArtists.join(", ")
    : track.featuredArtists || "";
  document.getElementById("trackUpcInput").value = track.upc;
  document.getElementById("trackIsrcInput").value = track.isrc;

  document.getElementById("trackCoverFileLabel").innerHTML = track.coverUrl
    ? `🖼️ <strong>Copertina presente</strong> (clicca per sostituire)`
    : `🖼️ <strong>Carica Copertina</strong>`;

  document.getElementById("trackAudioFileLabel").innerHTML = track.audioUrl
    ? `🎵 <strong>MP3 presente (${escapeHtml(track.audioFileName || "master.mp3")})</strong>`
    : `🎵 <strong>Carica File MP3</strong> della traccia`;

  document.getElementById("trackModal").classList.add("open");
};

window.deleteTrack = async function (trackId) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  if (!confirm(`Vuoi eliminare la traccia "${track.title}" da tutti i dispositivi?`)) return;

  state.deletedIds = Array.from(new Set([...(state.deletedIds || []), trackId]));
  state.tracks = state.tracks.filter((t) => t.id !== trackId);
  recordActivity(`Eliminata traccia "${track.title}" (${track.mainArtist})`);
  await saveApplicationData();
  renderAll();
  showToast(`Traccia "${track.title}" eliminata e sincronizzata`);
};

window.playTrackInGlobalPlayer = function (trackId) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track || !track.audioUrl) {
    showToast("Nessun file MP3 caricato per questa traccia.");
    return;
  }

  const playerBar = document.getElementById("globalPlayer");
  const audioEl = document.getElementById("globalAudioElement");
  const coverEl = document.getElementById("playerCover");

  document.getElementById("playerTitle").textContent = track.title;
  document.getElementById("playerArtist").textContent = `🎤 ${track.mainArtist}`;
  document.getElementById("playerProducer").textContent = `🎛️ Prod. ${track.producer}`;

  coverEl.src = track.coverUrl || "logo-vnsr.png";
  audioEl.src = track.audioUrl;
  playerBar.classList.add("visible");
  audioEl.play().catch(() => {});
};

window.copyCode = function (code, label) {
  if (!code) return;
  navigator.clipboard?.writeText(code);
  showToast(`Codice ${label} (${code}) copiato negli appunti!`);
};

// ==================== SEZIONE APPUNTAMENTI & INTEGRAZIONE APPLE CALENDAR (iCloud CalDAV) ====================
const ITALIAN_MONTHS = [
  "Gennaio",
  "Febbraio",
  "Marzo",
  "Aprile",
  "Maggio",
  "Giugno",
  "Luglio",
  "Agosto",
  "Settembre",
  "Ottobre",
  "Novembre",
  "Dicembre"
];

let currentCalendarYear = new Date().getFullYear();
let currentCalendarMonth = new Date().getMonth();
let selectedCalendarDate = formatLocalIsoDate(new Date());

function formatLocalIsoDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getAppleCalAuth() {
  try {
    return JSON.parse(localStorage.getItem("vnsr_apple_cal_auth") || "null");
  } catch (_) {
    return null;
  }
}

function saveAppleCalAuth(authObj) {
  if (!authObj) {
    localStorage.removeItem("vnsr_apple_cal_auth");
  } else {
    localStorage.setItem("vnsr_apple_cal_auth", JSON.stringify(authObj));
  }
  updateAppleAuthUI();
}

function updateAppleAuthUI() {
  const auth = getAppleCalAuth();
  const isConnected = Boolean(auth && (auth.email || auth.webcalUrl));

  const badge = document.getElementById("appleConnectionBadge");
  const sidebarEmail = document.getElementById("sidebarAppleEmail");
  const popupEmail = document.getElementById("popupAppleStatusText");

  if (badge) {
    badge.classList.toggle("connected", isConnected);
    badge.innerHTML = isConnected
      ? `🍎 Apple ID Connesso: <strong>${escapeHtml(auth.email || "Calendario Webcal")}</strong>`
      : `🍎 Apple Calendar: Non connesso`;
  }
  if (sidebarEmail) {
    sidebarEmail.textContent = isConnected
      ? `Connesso come: ${auth.email || auth.webcalUrl} (Sync bidirezionale attivo)`
      : "Nessun account collegato";
  }
  if (popupEmail) {
    popupEmail.textContent = isConnected
      ? `Sincronizzazione attiva con ${auth.email || "Webcal Apple"}`
      : "Effettua l'accesso alla mail Apple ID per ricevere e caricare eventi su iCloud";
  }
}

window.openAppleAuthModal = function () {
  const auth = getAppleCalAuth() || {};
  const emailInput = document.getElementById("appleCalEmailInput");
  const passInput = document.getElementById("appleCalAppPasswordInput");
  const webcalInput = document.getElementById("appleCalWebcalInput");
  const statusBox = document.getElementById("appleCalStatusBox");

  if (emailInput) emailInput.value = auth.email || "";
  if (passInput) passInput.value = auth.password || "";
  if (webcalInput) webcalInput.value = auth.webcalUrl || "";
  if (statusBox) statusBox.style.display = "none";

  document.getElementById("appleCalendarAuthModal").classList.add("open");
};

window.openCalendarWindowModal = function () {
  renderCalendar();
  document.getElementById("calendarWindowModal").classList.add("open");
};

window.changeCalendarMonth = function (delta) {
  currentCalendarMonth += delta;
  if (currentCalendarMonth > 11) {
    currentCalendarMonth = 0;
    currentCalendarYear += 1;
  } else if (currentCalendarMonth < 0) {
    currentCalendarMonth = 11;
    currentCalendarYear -= 1;
  }
  renderCalendar();
};

window.resetCalendarToToday = function () {
  const now = new Date();
  currentCalendarYear = now.getFullYear();
  currentCalendarMonth = now.getMonth();
  selectedCalendarDate = formatLocalIsoDate(now);
  renderCalendar();
};

window.selectCalendarDate = function (dateStr, openNewOnDoubleClick = false) {
  selectedCalendarDate = dateStr;
  renderCalendar();
  if (openNewOnDoubleClick) {
    openNewAppointmentModal(dateStr);
  }
};

function getCategoryStyleClass(appt) {
  if (appt.source === "apple_calendar") return "cat-apple";
  const cat = (appt.category || "").toLowerCase();
  if (cat.includes("studio")) return "cat-studio";
  if (cat.includes("release")) return "cat-release";
  if (cat.includes("live")) return "cat-live";
  return "";
}

function renderCalendar() {
  updateAppleAuthUI();

  const monthTitle = `${ITALIAN_MONTHS[currentCalendarMonth]} ${currentCalendarYear}`;
  const inlineTitleEl = document.getElementById("inlineCalendarMonthTitle");
  const popupTitleEl = document.getElementById("popupCalendarMonthTitle");
  if (inlineTitleEl) inlineTitleEl.textContent = monthTitle;
  if (popupTitleEl) popupTitleEl.textContent = monthTitle;

  const firstDayOfMonth = new Date(currentCalendarYear, currentCalendarMonth, 1);
  const daysInMonth = new Date(currentCalendarYear, currentCalendarMonth + 1, 0).getDate();
  const prevMonthDays = new Date(currentCalendarYear, currentCalendarMonth, 0).getDate();

  // Lunedì = 0 ... Domenica = 6
  const startOffset = (firstDayOfMonth.getDay() + 6) % 7;
  const todayIso = formatLocalIsoDate(new Date());

  const apptsByDate = new Map();
  for (const appt of state.appointments || []) {
    if (!appt || !appt.date) continue;
    if (!apptsByDate.has(appt.date)) {
      apptsByDate.set(appt.date, []);
    }
    apptsByDate.get(appt.date).push(appt);
  }
  for (const list of apptsByDate.values()) {
    list.sort((a, b) => (a.startTime || "00:00").localeCompare(b.startTime || "00:00"));
  }

  const cells = [];
  const totalCells = 42; // 6 settimane x 7 giorni

  for (let i = 0; i < totalCells; i++) {
    let cellYear = currentCalendarYear;
    let cellMonth = currentCalendarMonth;
    let dayNum = 1;
    let isOtherMonth = false;

    if (i < startOffset) {
      isOtherMonth = true;
      dayNum = prevMonthDays - startOffset + i + 1;
      cellMonth -= 1;
      if (cellMonth < 0) {
        cellMonth = 11;
        cellYear -= 1;
      }
    } else if (i >= startOffset + daysInMonth) {
      isOtherMonth = true;
      dayNum = i - (startOffset + daysInMonth) + 1;
      cellMonth += 1;
      if (cellMonth > 11) {
        cellMonth = 0;
        cellYear += 1;
      }
    } else {
      dayNum = i - startOffset + 1;
    }

    const isoDate = `${cellYear}-${String(cellMonth + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    const dayEvents = apptsByDate.get(isoDate) || [];
    const isToday = isoDate === todayIso;
    const isSelected = isoDate === selectedCalendarDate;

    const eventsHtml = dayEvents
      .slice(0, 3)
      .map((ev) => {
        const cls = getCategoryStyleClass(ev);
        const icon = ev.source === "apple_calendar" || ev.syncedToApple ? "🍎 " : "";
        return `
          <div class="cal-event-chip ${cls}" onclick="event.stopPropagation(); openEditAppointmentModal('${ev.id}')" title="${escapeHtml(ev.startTime || "")} ${escapeHtml(ev.title)}">
            <span class="time">${escapeHtml(ev.startTime || "")}</span>${icon}${escapeHtml(ev.title)}
          </div>
        `;
      })
      .join("");

    const moreBadge =
      dayEvents.length > 3
        ? `<div style="font-size: 10.5px; color: var(--accent-gold); font-weight: 700; padding-left: 4px;">+${dayEvents.length - 3} altri...</div>`
        : "";

    cells.push(`
      <div class="calendar-day-cell ${isOtherMonth ? "other-month" : ""} ${isToday ? "today" : ""} ${isSelected ? "selected" : ""}"
           onclick="selectCalendarDate('${isoDate}')"
           ondblclick="selectCalendarDate('${isoDate}', true)">
        <div class="calendar-day-number">
          <span>${dayNum}</span>
          ${dayEvents.length > 0 ? `<span class="day-count-dot" title="${dayEvents.length} appuntamenti"></span>` : ""}
        </div>
        <div class="calendar-day-events">
          ${eventsHtml}
          ${moreBadge}
        </div>
      </div>
    `);
  }

  const gridHtml = cells.join("");
  const inlineGrid = document.getElementById("inlineCalendarDaysGrid");
  const popupGrid = document.getElementById("popupCalendarDaysGrid");
  if (inlineGrid) inlineGrid.innerHTML = gridHtml;
  if (popupGrid) popupGrid.innerHTML = gridHtml;

  renderSelectedDaySidebar();
}

function renderSelectedDaySidebar() {
  const inlineLabel = document.getElementById("selectedDayLabel");
  const popupLabel = document.getElementById("popupSelectedDayLabel");
  const inlineList = document.getElementById("selectedDayAppointmentsList");
  const popupList = document.getElementById("popupSelectedDayAppointmentsList");

  let formattedDate = selectedCalendarDate;
  try {
    const [y, m, d] = selectedCalendarDate.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    formattedDate = dt.toLocaleDateString("it-IT", {
      weekday: "short",
      day: "numeric",
      month: "long",
      year: "numeric"
    });
  } catch (_) {}

  if (inlineLabel) inlineLabel.textContent = formattedDate;
  if (popupLabel) popupLabel.textContent = formattedDate;

  const dayEvents = (state.appointments || [])
    .filter((a) => a && a.date === selectedCalendarDate)
    .sort((a, b) => (a.startTime || "00:00").localeCompare(b.startTime || "00:00"));

  if (dayEvents.length === 0) {
    const emptyHtml = `
      <div class="empty-state" style="padding: 22px 14px;">
        <div style="font-size: 28px;">📅</div>
        <p style="font-size: 12.5px; margin-top: 6px;">Nessun appuntamento per questa data.</p>
        <button type="button" class="btn btn-primary btn-sm" style="margin-top: 10px;" onclick="openNewAppointmentModal('${selectedCalendarDate}')">
          ➕ Aggiungi Evento Qui
        </button>
      </div>
    `;
    if (inlineList) inlineList.innerHTML = emptyHtml;
    if (popupList) popupList.innerHTML = emptyHtml;
    return;
  }

  const listHtml = dayEvents
    .map((ev) => {
      const isApple = ev.source === "apple_calendar" || ev.syncedToApple;
      return `
        <div class="appt-item-card">
          <div class="appt-item-top">
            <span class="appt-time-badge">🕒 ${escapeHtml(ev.startTime || "09:00")} — ${escapeHtml(ev.endTime || "10:00")}</span>
            <span class="badge ${isApple ? "badge-signed" : "badge-pending"}" style="font-size: 10px;">
              ${isApple ? "🍎 Apple Cal" : escapeHtml(ev.category || "VNSR")}
            </span>
          </div>
          <div class="appt-title">${escapeHtml(ev.title)}</div>
          <div class="appt-meta">
            ${ev.artistName ? `<div>🎤 Artista: <strong>${escapeHtml(ev.artistName)}</strong></div>` : ""}
            ${ev.location ? `<div>📍 Luogo: ${escapeHtml(ev.location)}</div>` : ""}
            ${ev.notes ? `<div>📝 ${escapeHtml(ev.notes)}</div>` : ""}
          </div>
          <div class="appt-actions">
            <button type="button" class="btn btn-secondary btn-sm" style="padding: 4px 8px; font-size: 11px;" onclick="pushSingleAppointmentToApple('${ev.id}')" title="Invia in Upload ad Apple Calendar">
              🍎 Upload su Apple
            </button>
            <button type="button" class="btn btn-secondary btn-sm" style="padding: 4px 8px; font-size: 11px;" onclick="downloadAppointmentIcs('${ev.id}')" title="Scarica file .ics per Calendario Apple">
              📲 .ICS
            </button>
            <button type="button" class="btn btn-secondary btn-sm" style="padding: 4px 8px; font-size: 11px;" onclick="openEditAppointmentModal('${ev.id}')">
              ✏️
            </button>
            <button type="button" class="btn btn-danger btn-sm" style="padding: 4px 8px; font-size: 11px;" onclick="deleteAppointment('${ev.id}')">
              🗑️
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  if (inlineList) inlineList.innerHTML = listHtml;
  if (popupList) popupList.innerHTML = listHtml;
}

window.openNewAppointmentModal = function (dateStr = selectedCalendarDate) {
  renderArtistSelectOptions();
  document.getElementById("appointmentForm").reset();
  document.getElementById("apptIdInput").value = "";
  document.getElementById("appointmentModalTitle").textContent = "➕ Nuovo Appuntamento VNSR";
  document.getElementById("apptDateInput").value = dateStr || formatLocalIsoDate(new Date());
  document.getElementById("apptStartTimeInput").value = "15:00";
  document.getElementById("apptEndTimeInput").value = "17:00";
  document.getElementById("apptCategorySelect").value = "Studio Session";
  document.getElementById("apptPushToAppleCheckbox").checked = true;
  document.getElementById("appointmentFormModal").classList.add("open");
};

window.openEditAppointmentModal = function (apptId) {
  const appt = (state.appointments || []).find((a) => a.id === apptId);
  if (!appt) return;

  renderArtistSelectOptions();
  document.getElementById("appointmentModalTitle").textContent = `✏️ Modifica Appuntamento: ${appt.title}`;
  document.getElementById("apptIdInput").value = appt.id;
  document.getElementById("apptTitleInput").value = appt.title || "";
  document.getElementById("apptDateInput").value = appt.date || selectedCalendarDate;
  document.getElementById("apptStartTimeInput").value = appt.startTime || "15:00";
  document.getElementById("apptEndTimeInput").value = appt.endTime || "16:00";
  document.getElementById("apptCategorySelect").value = appt.category || "Studio Session";
  document.getElementById("apptArtistSelect").value = appt.artistName || "";
  document.getElementById("apptLocationInput").value = appt.location || "";
  document.getElementById("apptNotesInput").value = appt.notes || "";
  document.getElementById("apptPushToAppleCheckbox").checked = true;

  document.getElementById("appointmentFormModal").classList.add("open");
};

window.deleteAppointment = async function (apptId) {
  const appt = (state.appointments || []).find((a) => a.id === apptId);
  if (!appt) return;
  if (!confirm(`Vuoi eliminare l'appuntamento "${appt.title}" dal calendario VNSR?`)) return;

  state.deletedIds = Array.from(new Set([...(state.deletedIds || []), apptId]));
  state.appointments = (state.appointments || []).filter((a) => a.id !== apptId);
  recordActivity(`Eliminato appuntamento "${appt.title}" (${appt.date})`);
  await saveApplicationData();
  renderAll();
  showToast(`Appuntamento "${appt.title}" eliminato.`);
};

/**
 * Riceve e sincronizza gli appuntamenti dal Calendario Apple (iCloud CalDAV / Webcal)
 * dopo aver effettuato l'accesso alla mail Apple ID.
 */
window.syncFromAppleCalendar = async function (silent = false) {
  const auth = getAppleCalAuth();
  if (!auth || (!auth.email && !auth.webcalUrl)) {
    if (!silent) {
      showToast("🍎 Effettua prima l'accesso con la tua mail Apple ID per ricevere gli appuntamenti.");
      openAppleAuthModal();
    }
    return false;
  }

  if (!silent) {
    showToast("⏳ Connessione a Apple Calendar (iCloud) in corso...");
  }

  const baseUrl = getBaseApiUrl();
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/apple-calendar/sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: auth.email || "",
          password: auth.password || "",
          webcalUrl: auth.webcalUrl || ""
        })
      },
      SYNC_TIMEOUT_MS
    );
    const data = await res.json();

    if (!data.ok) {
      if (!silent) {
        showToast(`❌ Apple Calendar: ${data.error || "Errore di autenticazione"}`);
      }
      return false;
    }

    const incomingEvents = data.events || [];
    const deletedSet = new Set(state.deletedIds || []);
    state.appointments = mergeCollectionClient(state.appointments || [], incomingEvents, deletedSet);

    recordActivity(
      `Sincronizzati ${incomingEvents.length} appuntamenti da Apple Calendar (${auth.email || "Webcal"})`
    );
    await saveApplicationData();
    renderAll();

    if (!silent) {
      showToast(`✅ Ricevuti ${incomingEvents.length} appuntamenti da Apple Calendar (${data.calendarName || "iCloud"})!`);
    }
    return true;
  } catch (err) {
    if (!silent) {
      showToast(
        "⚠️ Impossibile contattare il bridge CalDAV locale. Avvia Avvia_Gestionale.command o usa Importa .ICS."
      );
    }
    return false;
  }
};

/**
 * Scrive in upload un evento creato nel gestionale direttamente sul Calendario Apple (CalDAV PUT)
 */
async function uploadEventToAppleCalendar(appt, showFeedback = true) {
  const auth = getAppleCalAuth();
  if (!auth || !auth.email || !auth.password) {
    if (showFeedback) {
      showToast("📲 Scarico il file .ICS per aggiungerlo con un clic al tuo Apple Calendar!");
      downloadAppointmentIcs(appt.id);
    }
    return false;
  }

  const baseUrl = getBaseApiUrl();
  try {
    if (showFeedback) {
      showToast(`⏳ Upload di "${appt.title}" su Apple Calendar (${auth.email})...`);
    }
    const res = await fetchWithTimeout(
      `${baseUrl}/api/apple-calendar/upload-event`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: auth.email,
          password: auth.password,
          event: appt
        })
      },
      SYNC_TIMEOUT_MS
    );
    const data = await res.json();
    if (data.ok) {
      state.appointments = (state.appointments || []).map((a) =>
        a.id === appt.id ? { ...a, syncedToApple: true, updatedAt: new Date().toISOString() } : a
      );
      await saveApplicationData();
      renderCalendar();
      if (showFeedback) {
        showToast(`✅ Evento "${appt.title}" scritto in upload su Apple Calendar (${auth.email})!`);
      }
      return true;
    } else {
      if (showFeedback) {
        showToast(`⚠️ Upload CalDAV: ${data.error || "Errore"}. Scarico file .ICS per Apple Calendar.`);
        downloadAppointmentIcs(appt.id);
      }
      return false;
    }
  } catch (_) {
    if (showFeedback) {
      showToast("📲 Apertura file .ICS per inserimento immediato in Apple Calendar...");
      downloadAppointmentIcs(appt.id);
    }
    return false;
  }
}

window.pushSingleAppointmentToApple = async function (apptId) {
  const appt = (state.appointments || []).find((a) => a.id === apptId);
  if (!appt) return;
  await uploadEventToAppleCalendar(appt, true);
};

/**
 * Genera e scarica un file standard iCalendar (.ics) compatibile con Apple Calendar su Mac/iPhone
 */
window.downloadAppointmentIcs = function (apptId) {
  const appt = (state.appointments || []).find((a) => a.id === apptId);
  if (!appt) return;

  const dateClean = (appt.date || formatLocalIsoDate(new Date())).replace(/-/g, "");
  const startClean = (appt.startTime || "15:00").replace(":", "") + "00";
  const endClean = (appt.endTime || "16:00").replace(":", "") + "00";
  const uid = appt.appleUid || `vnsr-${appt.id}@vnsr-label.com`;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  const summary = appt.artistName ? `${appt.title} [${appt.artistName}]` : appt.title;
  const desc = [
    appt.category ? `Categoria: ${appt.category}` : "",
    appt.artistName ? `Artista VNSR: ${appt.artistName}` : "",
    appt.notes || ""
  ]
    .filter(Boolean)
    .join("\\n");

  const icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//VNSR Label Management//IT",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dateClean}T${startClean}`,
    `DTEND:${dateClean}T${endClean}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${desc}`,
    `LOCATION:${appt.location || "VNSR Studio"}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ];

  const blob = new Blob([icsLines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `VNSR_${(appt.title || "Evento").replace(/[^a-zA-Z0-9_-]/g, "_")}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

/**
 * Parser client-side per importare direttamente un file .ics esportato da Apple Calendar
 */
function parseIcsTextClient(icsText) {
  const unfolded = (icsText || "").replace(/\r?\n[ \t]/g, "");
  const blocks = unfolded.split("BEGIN:VEVENT");
  const parsed = [];
  const nowIso = new Date().toISOString();

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split("END:VEVENT")[0];
    const lines = block.split(/\r?\n/);
    const fields = {};
    for (const line of lines) {
      if (!line.includes(":")) continue;
      const [rawKey, ...rest] = line.split(":");
      const val = rest.join(":").trim();
      const baseKey = rawKey.split(";")[0].toUpperCase();
      fields[baseKey] = val;
    }

    const uid = fields.UID || `ics_${Date.now()}_${i}`;
    const summary = (fields.SUMMARY || "Evento Apple Calendar").replace(/\\,/g, ",").replace(/\\n/g, " ");
    const location = (fields.LOCATION || "").replace(/\\,/g, ",");
    const description = (fields.DESCRIPTION || "").replace(/\\n/g, "\n").replace(/\\,/g, ",");
    const dtstart = (fields.DTSTART || "").replace("Z", "");
    const dtend = (fields.DTEND || "").replace("Z", "");

    if (dtstart.length >= 8) {
      const dateStr = `${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6, 8)}`;
      const startTime = dtstart.includes("T") && dtstart.length >= 13 ? `${dtstart.slice(9, 11)}:${dtstart.slice(11, 13)}` : "09:00";
      const endTime = dtend.includes("T") && dtend.length >= 13 ? `${dtend.slice(9, 11)}:${dtend.slice(11, 13)}` : "10:00";
      const safeId = "appt_apple_" + uid.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 36);

      parsed.push({
        id: safeId,
        appleUid: uid,
        title: summary,
        date: dateStr,
        startTime,
        endTime,
        category: "Apple Calendar",
        artistName: "",
        location,
        notes: description,
        source: "apple_calendar",
        syncedToApple: true,
        createdBy: "Apple Calendar (.ics)",
        createdAt: nowIso,
        updatedAt: nowIso
      });
    }
  }
  return parsed;
}

function showToast(message) {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3200);
}

/**
 * SOFTWARE DI AGGIORNAMENTO AUTOMATICO PRE-APERTURA GESTIONALE
 * - Viene eseguito esclusivamente PRIMA dell'apertura del gestionale.
 * - Controlla se sul database (nodo /vnsr_app_release) è presente una nuova versione.
 * - Se rileva un nuovo aggiornamento sul database, lo scarica e lo installa in automatico
 *   senza richiedere ulteriori passaggi all'utente, ricaricando il gestionale aggiornato.
 * - Se invece la copia locale ha una nuova modifica (release_bundle.json più recente),
 *   la carica automaticamente sul database per renderla disponibile a tutti.
 */
async function runAutoUpdateBeforeOpen() {
  const AUTO_UPDATE_TIMEOUT_MS = 3800;
  const baseUrl = getBaseApiUrl();
  const dbUrl = sanitizeFirebaseUrl(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);
  const badgeEl = document.getElementById("currentAppVersionBadge");
  const bottomVerEl = document.getElementById("bottomRightVersionLabel");

  let localVersion = { versionId: 0, versionString: "1.0.1", sha256: "" };
  let localBundle = null;

  // 1. Recupera stato versione locale tramite il server locale VNSR o version.json
  try {
    const statusRes = await fetchWithTimeout(`${baseUrl}/api/auto-update/status`, { cache: "no-store" }, AUTO_UPDATE_TIMEOUT_MS);
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

  const displayVer = localVersion.versionString || "1.0.1";
  if (badgeEl) {
    badgeEl.textContent = `Versione v${displayVer} • Auto-Update Attivo`;
  }
  if (bottomVerEl) {
    bottomVerEl.textContent = `v${displayVer}`;
  }

  // 2. Controlla la versione presente sul Database Firebase (SDK WebSocket o REST API)
  let remoteMeta = null;
  if (firebaseDb) {
    try {
      const snap = await withTimeout(firebaseDb.ref("vnsr_app_release_meta").once("value"), AUTO_UPDATE_TIMEOUT_MS);
      remoteMeta = snap.val();
    } catch (_) {}
  }
  if (!remoteMeta && isFirebaseEndpoint()) {
    try {
      const res = await fetchWithTimeout(`${dbUrl}/vnsr_app_release_meta.json`, { cache: "no-store" }, AUTO_UPDATE_TIMEOUT_MS);
      if (res.ok) {
        remoteMeta = await res.json();
      }
    } catch (_) {}
  }

  const localVid = Number(localVersion.versionId || 0);
  const localSha = String(localVersion.sha256 || "");
  const remoteVid = Number((remoteMeta && remoteMeta.versionId) || 0);
  const remoteSha = String((remoteMeta && remoteMeta.sha256) || "");

  // CASO A: Sul database c'è una versione più recente -> Scarica e installa in automatico PRIMA dell'apertura!
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
            const bSnap = await withTimeout(firebaseDb.ref("vnsr_app_release").once("value"), 7000);
            fullReleaseBundle = bSnap.val();
          } catch (_) {}
        }
        if (!fullReleaseBundle && isFirebaseEndpoint()) {
          const bRes = await fetchWithTimeout(`${dbUrl}/vnsr_app_release.json`, { cache: "no-store" }, 7000);
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
  if (localBundle && localBundle.bundleZipB64 && (!remoteMeta || localVid > remoteVid || (localSha && localSha !== remoteSha && localVid >= remoteVid))) {
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

// ==================== EVENT LISTENERS PRINCIPALI ====================
document.addEventListener("DOMContentLoaded", async () => {
  initFirebaseSDK(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);
  // Controllo e installazione automatica aggiornamenti SOLO PRIMA dell'apertura del gestionale
  const reloadingForUpdate = await runAutoUpdateBeforeOpen();
  if (reloadingForUpdate) return;
  await loadApplicationData();
  initAuthGate();
  renderAll();

  // Avvia la sincronizzazione automatica ogni 10 secondi (con timeout di 10s + Ping Google 8.8.8.8)
  setInterval(pollMultiDeviceUpdates, AUTO_SYNC_INTERVAL_MS);

  // Rilevamento immediato caduta/ripristino rete + verifica Ping 8.8.8.8
  window.addEventListener("offline", () => {
    updateSyncStatusUI(false, "Offline • Ping 8.8.8.8 Fallito");
  });
  window.addEventListener("online", () => {
    pollMultiDeviceUpdates();
  });

  // Tabs
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Search & filters
  document.getElementById("artistSearchInput").addEventListener("input", renderArtists);
  document.getElementById("trackSearchInput").addEventListener("input", renderTracks);
  document.getElementById("trackArtistFilter").addEventListener("change", renderTracks);

  // Close modals
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById(btn.dataset.close).classList.remove("open");
    });
  });

  // Open Sync Modal
  document.getElementById("openSyncModalBtn").addEventListener("click", () => {
    const cleanEndpoint = sanitizeFirebaseUrl(state.remoteSyncEndpoint || DEFAULT_FIREBASE_URL);
    state.remoteSyncEndpoint = cleanEndpoint;
    document.getElementById("remoteSyncEndpointInput").value = cleanEndpoint;
    document.getElementById("lanSyncUrlDisplay").value = state.lanUrl || window.location.origin;
    document.getElementById("syncModal").classList.add("open");
  });

  document.getElementById("copyLanUrlBtn").addEventListener("click", () => {
    const val = document.getElementById("lanSyncUrlDisplay").value;
    navigator.clipboard?.writeText(val);
    showToast(`Link multi-dispositivo copiato: ${val}`);
  });

  document.getElementById("saveSyncConfigBtn").addEventListener("click", async () => {
    const rawUrl = document.getElementById("remoteSyncEndpointInput").value.trim();
    const url = sanitizeFirebaseUrl(rawUrl);
    document.getElementById("remoteSyncEndpointInput").value = url;
    state.remoteSyncEndpoint = url;
    localStorage.setItem("vnsr_remote_sync_url", url);
    initFirebaseSDK(url);
    await loadApplicationData();
    await saveApplicationData();
    renderAll();
    showToast("Configurazione Cloud Sync salvata e sincronizzata!");
  });

  document.getElementById("forceSyncNowBtn").addEventListener("click", async () => {
    await loadApplicationData();
    await saveApplicationData();
    renderAll();
    showToast("Sincronizzazione completata con tutti i dispositivi!");
  });

  const testFbBtn = document.getElementById("testFirebaseBtn");
  if (testFbBtn) {
    testFbBtn.addEventListener("click", () => {
      testFirebaseReadWrite();
    });
  }

  document.getElementById("importBackupInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      applyIncomingSnapshot(parsed);
      recordActivity("Importato backup JSON nel catalogo condiviso VNSR");
      await saveApplicationData();
      renderAll();
      document.getElementById("syncModal").classList.remove("open");
      showToast("Backup importato e sincronizzato su tutti i dispositivi!");
    } catch (_) {
      showToast("File JSON non valido.");
    }
  });

  // Open new Artist / Collaborator Modal
  document.getElementById("openAddArtistBtn").addEventListener("click", () => {
    window.openNewAnagraficaModal("Artista");
  });

  const openAddCollabBtn = document.getElementById("openAddCollaboratorBtn");
  if (openAddCollabBtn) {
    openAddCollabBtn.addEventListener("click", () => {
      window.openNewAnagraficaModal("Collaboratore");
    });
  }

  // Filtri Comparto Anagrafica (Tutti / Artisti / Collaboratori)
  document.querySelectorAll("#anagraficaTypeFilterGroup .anagrafica-filter-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#anagraficaTypeFilterGroup .anagrafica-filter-pill").forEach((b) => b.classList.remove("active"));
      pill.classList.add("active");
      activeAnagraficaTypeFilter = pill.dataset.typeFilter || "ALL";
      renderArtists();
    });
  });

  // Selettore Artista vs Collaboratore nel form Anagrafica
  document.querySelectorAll(".person-type-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      setAnagraficaPersonType(btn.dataset.ptype);
    });
  });

  // Mutua esclusione rigorosa: Nome d'Arte OPPURE Nome e Cognome (mai entrambi)
  const modeStageBtn = document.getElementById("nameModeStageBtn");
  const modeLegalBtn = document.getElementById("nameModeLegalBtn");
  const stageNameInput = document.getElementById("artistStageName");
  const firstNameInput = document.getElementById("artistFirstName");
  const lastNameInput = document.getElementById("artistLastName");

  if (modeStageBtn) {
    modeStageBtn.addEventListener("click", () => {
      setAnagraficaNameMode("stage");
      stageNameInput?.focus();
    });
  }
  if (modeLegalBtn) {
    modeLegalBtn.addEventListener("click", () => {
      setAnagraficaNameMode("legal");
      firstNameInput?.focus();
    });
  }
  if (stageNameInput) {
    stageNameInput.addEventListener("input", () => {
      if (stageNameInput.value.trim().length > 0) {
        if (firstNameInput) {
          firstNameInput.value = "";
          firstNameInput.disabled = true;
        }
        if (lastNameInput) {
          lastNameInput.value = "";
          lastNameInput.disabled = true;
        }
      }
    });
  }
  [firstNameInput, lastNameInput].forEach((inp) => {
    if (!inp) return;
    inp.addEventListener("input", () => {
      if ((firstNameInput?.value.trim() || "") || (lastNameInput?.value.trim() || "")) {
        if (stageNameInput) {
          stageNameInput.value = "";
          stageNameInput.disabled = true;
        }
      }
    });
  });

  // Open Contract PDF Builder Modal (Step 1/2)
  document.getElementById("openContractBuilderBtn").addEventListener("click", () => {
    const lblDefaults = getSavedLabelDefaults();
    const existingFd = pendingContractFormData || {};
    const todayFormatted = new Date().toLocaleDateString("it-IT");

    renderAnagraficaPreselectablePills();

    document.getElementById("cbLabelName").value = existingFd.labelName || lblDefaults.labelName || "VNSR";
    document.getElementById("cbLabelVat").value = existingFd.labelVat || lblDefaults.labelVat || "";
    document.getElementById("cbLabelRep").value = existingFd.labelRep || lblDefaults.labelRep || "";
    document.getElementById("cbLabelCity").value = existingFd.labelCity || lblDefaults.labelCity || "";
    document.getElementById("cbLabelAddress").value = existingFd.labelAddress || lblDefaults.labelAddress || "";
    document.getElementById("cbLabelEmail").value = existingFd.labelEmail || lblDefaults.labelEmail || "";

    document.getElementById("cbArtistFirstName").value =
      document.getElementById("artistFirstName").value.trim() || existingFd.artistFirstName || "";
    document.getElementById("cbArtistLastName").value =
      document.getElementById("artistLastName").value.trim() || existingFd.artistLastName || "";
    document.getElementById("cbArtistStageName").value =
      document.getElementById("artistStageName").value.trim() || existingFd.artistStageName || "";

    document.getElementById("cbArtistBirthPlace").value = existingFd.artistBirthPlace || "";
    document.getElementById("cbArtistBirthDate").value = existingFd.artistBirthDate || "";
    document.getElementById("cbArtistCf").value = existingFd.artistCf || "";
    document.getElementById("cbArtistCity").value = existingFd.artistCity || "";
    document.getElementById("cbArtistAddress").value = existingFd.artistAddress || "";
    document.getElementById("cbArtistContact").value = existingFd.artistContact || "";
    document.getElementById("cbArtistDocId").value = existingFd.artistDocId || "";

    document.getElementById("cbTrackTitle").value = existingFd.trackTitle || "";
    document.getElementById("cbTrackIsrc").value = existingFd.trackIsrc || "";
    document.getElementById("cbTrackVersion").value = existingFd.trackVersion || "Original";
    document.getElementById("cbDeliveryDate").value = existingFd.deliveryDate || todayFormatted;

    document.getElementById("cbRoyaltyStreamArtist").value = existingFd.royaltyStreamArtist || "50";
    document.getElementById("cbRoyaltyStreamLabel").value = existingFd.royaltyStreamLabel || "50";
    document.getElementById("cbRoyaltyPhysArtist").value = existingFd.royaltyPhysArtist || "50";
    document.getElementById("cbRoyaltyPhysLabel").value = existingFd.royaltyPhysLabel || "50";
    document.getElementById("cbRoyaltySocialArtist").value = existingFd.royaltySocialArtist || "50";
    document.getElementById("cbRoyaltySocialLabel").value = existingFd.royaltySocialLabel || "50";
    document.getElementById("cbRecoupableCosts").value = existingFd.recoupableCosts || "NESSUNA";
    document.getElementById("cbStatementPeriod").value = existingFd.statementPeriod || "Semestrale";

    document.getElementById("cbArtistIban").value = existingFd.artistIban || "";
    document.getElementById("cbSamplesDeclaration").value =
      existingFd.samplesDeclaration || "NESSUN CAMPIONE DI TERZI UTILIZZATO";
    document.getElementById("cbCourtCity").value = existingFd.courtCity || "Roma";
    document.getElementById("cbSignPlace").value = existingFd.signPlace || "Roma";
    document.getElementById("cbSignDate").value = existingFd.signDate || todayFormatted;

    document.getElementById("contractBuilderModal").classList.add("open");
  });

  // Submit Contract Builder Form -> Compiles 4-page PDF & activates 2FA Step 1/2
  document.getElementById("contractBuilderForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = {
      labelName: document.getElementById("cbLabelName").value.trim(),
      labelVat: document.getElementById("cbLabelVat").value.trim(),
      labelRep: document.getElementById("cbLabelRep").value.trim(),
      labelCity: document.getElementById("cbLabelCity").value.trim(),
      labelAddress: document.getElementById("cbLabelAddress").value.trim(),
      labelEmail: document.getElementById("cbLabelEmail").value.trim(),
      artistFirstName: document.getElementById("cbArtistFirstName").value.trim(),
      artistLastName: document.getElementById("cbArtistLastName").value.trim(),
      artistStageName: document.getElementById("cbArtistStageName").value.trim(),
      artistBirthPlace: document.getElementById("cbArtistBirthPlace").value.trim(),
      artistBirthDate: document.getElementById("cbArtistBirthDate").value.trim(),
      artistCf: document.getElementById("cbArtistCf").value.trim().toUpperCase(),
      artistCity: document.getElementById("cbArtistCity").value.trim(),
      artistAddress: document.getElementById("cbArtistAddress").value.trim(),
      artistContact: document.getElementById("cbArtistContact").value.trim(),
      artistDocId: document.getElementById("cbArtistDocId").value.trim(),
      trackTitle: document.getElementById("cbTrackTitle").value.trim(),
      trackIsrc: document.getElementById("cbTrackIsrc").value.trim(),
      trackVersion: document.getElementById("cbTrackVersion").value,
      deliveryDate: document.getElementById("cbDeliveryDate").value.trim(),
      royaltyStreamArtist: document.getElementById("cbRoyaltyStreamArtist").value.trim(),
      royaltyStreamLabel: document.getElementById("cbRoyaltyStreamLabel").value.trim(),
      royaltyPhysArtist: document.getElementById("cbRoyaltyPhysArtist").value.trim(),
      royaltyPhysLabel: document.getElementById("cbRoyaltyPhysLabel").value.trim(),
      royaltySocialArtist: document.getElementById("cbRoyaltySocialArtist").value.trim(),
      royaltySocialLabel: document.getElementById("cbRoyaltySocialLabel").value.trim(),
      recoupableCosts: document.getElementById("cbRecoupableCosts").value.trim(),
      statementPeriod: document.getElementById("cbStatementPeriod").value,
      artistIban: document.getElementById("cbArtistIban").value.trim(),
      samplesDeclaration: document.getElementById("cbSamplesDeclaration").value.trim(),
      courtCity: document.getElementById("cbCourtCity").value.trim(),
      signPlace: document.getElementById("cbSignPlace").value.trim(),
      signDate: document.getElementById("cbSignDate").value.trim()
    };

    saveLabelDefaults(fd);
    pendingContractFormData = fd;

    // Sync main artist fields back to Anagrafica form (respecting mutual exclusion between Stage Name and Legal Name)
    if (fd.artistStageName && !fd.artistFirstName && !fd.artistLastName) {
      setAnagraficaNameMode("stage");
      document.getElementById("artistStageName").value = fd.artistStageName;
    } else if ((fd.artistFirstName || fd.artistLastName) && !fd.artistStageName) {
      setAnagraficaNameMode("legal");
      document.getElementById("artistFirstName").value = fd.artistFirstName;
      document.getElementById("artistLastName").value = fd.artistLastName;
    } else if (fd.artistStageName) {
      setAnagraficaNameMode("stage");
      document.getElementById("artistStageName").value = fd.artistStageName;
    }
    if (!document.getElementById("artistContractDetails").value.trim()) {
      document.getElementById("artistContractDetails").value =
        `Accordo Co-Produzione Master "${fd.trackTitle}" (ISRC: ${fd.trackIsrc}) — Streaming ${fd.royaltyStreamArtist}%/${fd.royaltyStreamLabel}% — Rendiconto ${fd.statementPeriod}.`;
    }

    try {
      showToast("⏳ Generazione PDF Contratto VNSR in corso...");
      const { pdfDataUri, savedBytes } = await generateFilledContractPdf(fd);
      const chosenIdent = fd.artistStageName || `${fd.artistFirstName} ${fd.artistLastName}`.trim() || "Artista";
      const safeStage = chosenIdent.replace(/[^a-zA-Z0-9_-]/g, "_") || "Artista";
      const fileName = `Contratto_VNSR_${safeStage}_Da_Firmare.pdf`;

      pendingGeneratedPdfDataUrl = pdfDataUri;
      pendingGeneratedPdfName = fileName;

      // Download automatico del PDF pronto per la stampa e firma
      const blob = new Blob([savedBytes], { type: "application/pdf" });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

      const hasStep2 = Boolean(pendingContractFile);
      if (!hasStep2) {
        document.getElementById("artistContractStatus").value = "In Negoziazione / Firma";
      }
      updateModalTwoFaUI(true, hasStep2, fileName, pendingContractFile ? pendingContractFile.name : "");

      document.getElementById("contractBuilderModal").classList.remove("open");
      showToast("✅ Passaggio 1/2 completato: PDF scaricato! Ora stampa, firma e carica la scansione (Passaggio 2/2).");
    } catch (err) {
      console.error("Errore compilazione PDF:", err);
      showToast("❌ Errore nella compilazione del PDF: " + err.message);
    }
  });

  // Open new Track Modal
  document.getElementById("openAddTrackBtn").addEventListener("click", () => {
    window.openTrackModalForArtist(state.artists[0]?.id || "");
  });

  // Auto-update Main Artist badge input when changing artist dropdown
  document.getElementById("trackArtistSelect").addEventListener("change", (e) => {
    const art = state.artists.find((a) => a.id === e.target.value);
    if (art) {
      document.getElementById("trackMainArtistDisplay").value = getPersonDisplayName(art);
      renderAnagraficaPreselectablePills();
    }
  });

  ["trackMainArtistDisplay", "trackProducerInput", "trackFeaturedInput", "cbSamplesDeclaration"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", () => renderAnagraficaPreselectablePills());
    }
  });

  // File input listeners
  document.getElementById("artistContractFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      pendingContractFile = file;
      document.getElementById("artistContractStatus").value = "Firmato e Attivo";
      const hasStep1 = Boolean(pendingGeneratedPdfDataUrl || pendingContractFormData);
      updateModalTwoFaUI(hasStep1, true, pendingGeneratedPdfName, file.name);
      document.getElementById("artistContractFileLabel").innerHTML =
        `✅ Passaggio 2/2 Completato — Scansione Firmata: <strong>${escapeHtml(file.name)}</strong>`;
    }
  });

  document.getElementById("trackCoverFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      pendingCoverFile = file;
      document.getElementById("trackCoverFileLabel").innerHTML =
        `✅ Copertina selezionata: <strong>${escapeHtml(file.name)}</strong>`;
    }
  });

  document.getElementById("trackAudioFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      pendingAudioFile = file;
      document.getElementById("trackAudioFileLabel").innerHTML =
        `✅ Master MP3 selezionato: <strong>${escapeHtml(file.name)}</strong>`;
    }
  });

  // Save Artist / Collaborator Form (Anagrafica)
  document.getElementById("artistForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const existingId = document.getElementById("artistIdInput").value;
    const personType = document.getElementById("artistPersonTypeInput")?.value === "Collaboratore" ? "Collaboratore" : "Artista";
    const isLegalMode = document.getElementById("nameModeLegalBtn")?.classList.contains("active");
    const rawStage = document.getElementById("artistStageName").value.trim();
    const rawFirst = document.getElementById("artistFirstName").value.trim();
    const rawLast = document.getElementById("artistLastName").value.trim();
    const errEl = document.getElementById("artistIdentityError");
    if (errEl) errEl.textContent = "";

    // Regola rigorosa richiesta dall'utente:
    // Deve essere compilato Nome d'Arte OPPURE Nome e Cognome. Non è possibile compilare entrambi.
    if (rawStage && (rawFirst || rawLast)) {
      if (errEl) {
        errEl.textContent = "⚠️ Non è possibile compilare sia Nome/Cognome che Nome d'Arte. Compila solo uno dei due.";
      }
      return;
    }

    let stageName = "";
    let firstName = "";
    let lastName = "";
    let nameMode = isLegalMode ? "legal" : "stage";

    if (rawStage) {
      nameMode = "stage";
      stageName = rawStage;
      firstName = "";
      lastName = "";
    } else if (rawFirst || rawLast) {
      nameMode = "legal";
      stageName = "";
      firstName = rawFirst;
      lastName = rawLast;
    } else {
      if (errEl) {
        errEl.textContent = "⚠️ Compila il Nome d'Arte oppure il Nome (e Cognome) per salvare la scheda in Anagrafica.";
      }
      return;
    }

    const displayName = stageName || `${firstName} ${lastName}`.trim();
    let contractStatus = document.getElementById("artistContractStatus").value;
    const contractDate = document.getElementById("artistContractDate").value;
    const contractDetails = document.getElementById("artistContractDetails").value.trim();

    const op = state.currentOperator || { name: "Operatore", code: "----" };
    const opTag = `${op.name} (${op.code})`;
    const nowIso = new Date().toISOString();

    let contractFileUrl = "";
    let contractFileName = "";
    let generatedContractPdfUrl = pendingGeneratedPdfDataUrl || "";
    let generatedContractPdfName = pendingGeneratedPdfName || "";
    let contractFormData = pendingContractFormData || null;

    if (existingId) {
      const old = state.artists.find((a) => a.id === existingId);
      if (old) {
        contractFileUrl = old.contractFileUrl || "";
        contractFileName = old.contractFileName || "";
        if (!generatedContractPdfUrl) generatedContractPdfUrl = old.generatedContractPdfUrl || "";
        if (!generatedContractPdfName) generatedContractPdfName = old.generatedContractPdfName || "";
        if (!contractFormData) contractFormData = old.contractFormData || null;
      }
    }

    if (pendingContractFile) {
      const uploaded = await uploadOrStoreFile(pendingContractFile, "contracts");
      contractFileUrl = uploaded.url;
      contractFileName = uploaded.name;
      contractStatus = "Firmato e Attivo";
    }

    const contract2FAState = contractFileUrl
      ? "verified_2fa"
      : generatedContractPdfUrl || contractFormData
      ? "pending_step2"
      : "none";

    if (contract2FAState === "pending_step2" && !contractFileUrl) {
      contractStatus = "In Negoziazione / Firma";
    }

    if (existingId) {
      state.artists = state.artists.map((a) =>
        a.id === existingId
          ? {
              ...a,
              personType,
              nameMode,
              stageName: stageName || displayName,
              firstName,
              lastName,
              contractStatus,
              contractDate,
              contractDetails,
              contractFileUrl,
              contractFileName,
              generatedContractPdfUrl,
              generatedContractPdfName,
              contractFormData,
              contract2FAState,
              updatedAt: nowIso
            }
          : a
      );
      recordActivity(
        contract2FAState === "pending_step2"
          ? `Generato contratto PDF per ${personType.toLowerCase()} "${displayName}" (In attesa Passaggio 2/2: upload scansione firmata)`
          : `Aggiornata scheda in Anagrafica (${personType}): "${displayName}"`
      );
      showToast(
        contract2FAState === "pending_step2"
          ? `⚠️ ${displayName} salvato: resta in attesa il Passaggio 2/2 (upload contratto scannerizzato firmato)`
          : `${personType} "${displayName}" aggiornato e già preselezionabile in tutto il software!`
      );
    } else {
      const newArtist = {
        id: "art_" + Date.now() + "_" + Math.random().toString(36).slice(2, 5),
        personType,
        nameMode,
        stageName: stageName || displayName,
        firstName,
        lastName,
        contractStatus,
        contractDate,
        contractDetails,
        contractFileUrl,
        contractFileName,
        generatedContractPdfUrl,
        generatedContractPdfName,
        contractFormData,
        contract2FAState,
        createdBy: opTag,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      state.artists.unshift(newArtist);
      recordActivity(
        contract2FAState === "pending_step2"
          ? `Creato ${personType.toLowerCase()} "${displayName}" con PDF generato (Passaggio 1/2) — In attesa scansione firmata (Passaggio 2/2)`
          : `Aggiunto ${personType.toLowerCase()} in Anagrafica VNSR: "${displayName}"`
      );
      showToast(
        contract2FAState === "pending_step2"
          ? `⚠️ ${displayName} creato! Passaggio 1/2 completato, resta notificato l'upload del contratto firmato (Passaggio 2/2)`
          : `✅ ${personType} "${displayName}" aggiunto in Anagrafica e preselezionabile ovunque!`
      );
    }

    document.getElementById("artistModal").classList.remove("open");
    renderAll();
    saveApplicationData();
  });

  // Save Track Form
  document.getElementById("trackForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const existingId = document.getElementById("trackIdInput").value;
    const artistId = document.getElementById("trackArtistSelect").value;
    const title = document.getElementById("trackTitleInput").value.trim();
    const mainArtist = document.getElementById("trackMainArtistDisplay").value.trim();
    const producer = document.getElementById("trackProducerInput").value.trim();
    const featuredRaw = document.getElementById("trackFeaturedInput").value.trim();
    const upc = document.getElementById("trackUpcInput").value.trim();
    const isrc = document.getElementById("trackIsrcInput").value.trim();

    const featuredArtists = featuredRaw
      ? featuredRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const op = state.currentOperator || { name: "Operatore", code: "----" };
    const opTag = `${op.name} (${op.code})`;
    const nowIso = new Date().toISOString();

    let coverUrl = "";
    let audioUrl = "";
    let audioFileName = "";

    if (existingId) {
      const old = state.tracks.find((t) => t.id === existingId);
      if (old) {
        coverUrl = old.coverUrl || "";
        audioUrl = old.audioUrl || "";
        audioFileName = old.audioFileName || "";
      }
    }

    if (pendingCoverFile) {
      const uploadedCover = await uploadOrStoreFile(pendingCoverFile, "covers");
      coverUrl = uploadedCover.url;
    }

    if (pendingAudioFile) {
      const uploadedAudio = await uploadOrStoreFile(pendingAudioFile, "audio");
      audioUrl = uploadedAudio.url;
      audioFileName = uploadedAudio.name;
    }

    if (existingId) {
      state.tracks = state.tracks.map((t) =>
        t.id === existingId
          ? {
              ...t,
              artistId,
              title,
              mainArtist,
              producer,
              featuredArtists,
              upc,
              isrc,
              coverUrl,
              audioUrl,
              audioFileName,
              updatedAt: nowIso
            }
          : t
      );
      recordActivity(`Aggiornata traccia "${title}" (${mainArtist} — Prod. ${producer})`);
      showToast(`Traccia "${title}" aggiornata e sincronizzata!`);
    } else {
      const newTrack = {
        id: "trk_" + Date.now() + "_" + Math.random().toString(36).slice(2, 5),
        artistId,
        title,
        mainArtist,
        producer,
        featuredArtists,
        upc,
        isrc,
        coverUrl,
        audioUrl,
        audioFileName,
        createdBy: opTag,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      state.tracks.unshift(newTrack);
      recordActivity(`Pubblicata nuova traccia "${title}" di ${mainArtist} (Prod. ${producer})`);
      showToast(`Traccia "${title}" aggiunta e sincronizzata!`);
    }

    document.getElementById("trackModal").classList.remove("open");
    renderAll();
    saveApplicationData();
  });

  // ==================== LISTENERS APPUNTAMENTI & APPLE CALENDAR ====================
  const openCalWinBtn = document.getElementById("openCalendarWindowBtn");
  if (openCalWinBtn) {
    openCalWinBtn.addEventListener("click", () => openCalendarWindowModal());
  }

  const openAppleAuthBtn = document.getElementById("openAppleAuthBtn");
  if (openAppleAuthBtn) {
    openAppleAuthBtn.addEventListener("click", () => openAppleAuthModal());
  }

  const pullAppleBtn = document.getElementById("pullAppleCalendarBtn");
  if (pullAppleBtn) {
    pullAppleBtn.addEventListener("click", () => syncFromAppleCalendar(false));
  }

  const openNewApptBtn = document.getElementById("openNewAppointmentBtn");
  if (openNewApptBtn) {
    openNewApptBtn.addEventListener("click", () => openNewAppointmentModal(selectedCalendarDate));
  }

  const appleAuthForm = document.getElementById("appleCalendarAuthForm");
  if (appleAuthForm) {
    appleAuthForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("appleCalEmailInput").value.trim();
      const password = document.getElementById("appleCalAppPasswordInput").value.trim();
      const webcalUrl = document.getElementById("appleCalWebcalInput").value.trim();
      const statusBox = document.getElementById("appleCalStatusBox");

      saveAppleCalAuth({ email, password, webcalUrl, connectedAt: new Date().toISOString() });

      if (statusBox) {
        statusBox.style.display = "block";
        statusBox.style.color = "var(--accent-gold)";
        statusBox.textContent = "⏳ Accesso a Apple Calendar (iCloud CalDAV) e download appuntamenti in corso...";
      }

      const ok = await syncFromAppleCalendar(false);
      if (ok) {
        document.getElementById("appleCalendarAuthModal").classList.remove("open");
      } else if (statusBox) {
        statusBox.style.color = "#f87171";
        statusBox.textContent =
          "⚠️ Credenziali salvate. Verifica che il server locale VNSR sia attivo (Avvia_Gestionale.command) e che la Password Specifica per App iCloud sia corretta.";
      }
    });
  }

  const disconnectAppleBtn = document.getElementById("disconnectAppleCalBtn");
  if (disconnectAppleBtn) {
    disconnectAppleBtn.addEventListener("click", () => {
      saveAppleCalAuth(null);
      document.getElementById("appleCalendarAuthModal").classList.remove("open");
      showToast("Account Apple Calendar scollegato.");
    });
  }

  const apptForm = document.getElementById("appointmentForm");
  if (apptForm) {
    apptForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const existingId = document.getElementById("apptIdInput").value;
      const title = document.getElementById("apptTitleInput").value.trim();
      const date = document.getElementById("apptDateInput").value;
      const startTime = document.getElementById("apptStartTimeInput").value || "15:00";
      const endTime = document.getElementById("apptEndTimeInput").value || "16:00";
      const category = document.getElementById("apptCategorySelect").value;
      const artistName = document.getElementById("apptArtistSelect").value;
      const location = document.getElementById("apptLocationInput").value.trim();
      const notes = document.getElementById("apptNotesInput").value.trim();
      const pushToApple = document.getElementById("apptPushToAppleCheckbox").checked;

      const op = state.currentOperator || { name: "Operatore", code: "----" };
      const opTag = `${op.name} (${op.code})`;
      const nowIso = new Date().toISOString();

      let savedAppt = null;

      if (existingId) {
        state.appointments = (state.appointments || []).map((a) => {
          if (a.id === existingId) {
            savedAppt = {
              ...a,
              title,
              date,
              startTime,
              endTime,
              category,
              artistName,
              location,
              notes,
              updatedAt: nowIso
            };
            return savedAppt;
          }
          return a;
        });
        recordActivity(`Aggiornato appuntamento "${title}" (${date} ${startTime})`);
      } else {
        const newId = "appt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
        savedAppt = {
          id: newId,
          appleUid: `vnsr-${newId}@vnsr-label.com`,
          title,
          date,
          startTime,
          endTime,
          category,
          artistName,
          location,
          notes,
          source: "vnsr",
          syncedToApple: false,
          createdBy: opTag,
          createdAt: nowIso,
          updatedAt: nowIso
        };
        state.appointments = [savedAppt, ...(state.appointments || [])];
        recordActivity(`Creato appuntamento "${title}" per il ${date} alle ${startTime}`);
      }

      selectedCalendarDate = date;
      const [y, m] = date.split("-").map(Number);
      if (y && m) {
        currentCalendarYear = y;
        currentCalendarMonth = m - 1;
      }

      document.getElementById("appointmentFormModal").classList.remove("open");
      renderAll();
      showToast(`✅ Appuntamento "${title}" salvato nel calendario VNSR!`);
      saveApplicationData();

      if (pushToApple && savedAppt) {
        uploadEventToAppleCalendar(savedAppt, true);
      }
    });
  }

  const importIcsInput = document.getElementById("importIcsFileInput");
  if (importIcsInput) {
    importIcsInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const events = parseIcsTextClient(text);
        if (events.length === 0) {
          showToast("⚠️ Nessun evento trovato nel file .ICS selezionato.");
          return;
        }
        const deletedSet = new Set(state.deletedIds || []);
        state.appointments = mergeCollectionClient(state.appointments || [], events, deletedSet);
        recordActivity(`Importati ${events.length} eventi da file .ICS Apple Calendar`);
        await saveApplicationData();
        renderAll();
        showToast(`✅ Importati ${events.length} appuntamenti dal file .ICS di Apple Calendar!`);
      } catch (_) {
        showToast("❌ Errore durante la lettura del file .ICS.");
      }
      e.target.value = "";
    });
  }

  // Close player bar
  document.getElementById("closePlayerBtn").addEventListener("click", () => {
    const audioEl = document.getElementById("globalAudioElement");
    audioEl.pause();
    document.getElementById("globalPlayer").classList.remove("visible");
  });

  // Export JSON backup
  document.getElementById("exportBackupBtn").addEventListener("click", () => {
    const dataStr = JSON.stringify(
      {
        version: state.version,
        exportedAt: new Date().toISOString(),
        operatorProfiles: getProfilesList(),
        artists: state.artists,
        tracks: state.tracks,
        appointments: state.appointments,
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

  // ==================== CARTELLA IMPOSTAZIONI & IMPOSTAZIONE PROFILI (4 PROFILI) ====================
  const settingsModal = document.getElementById("settingsModal");
  const settingsHomeView = document.getElementById("settingsHomeView");
  const settingsPinGateView = document.getElementById("settingsProfilesPinGateView");
  const settingsProfilesEditorView = document.getElementById("settingsProfilesEditorView");
  const settingsModalTitle = document.getElementById("settingsModalTitle");
  const settingsModalSubtitle = document.getElementById("settingsModalSubtitle");
  const settingsGatePinInput = document.getElementById("settingsGatePinInput");
  const settingsGatePinError = document.getElementById("settingsGatePinError");
  const profilesEditorError = document.getElementById("profilesEditorError");

  function showSettingsSubView(viewName) {
    if (!settingsHomeView || !settingsPinGateView || !settingsProfilesEditorView) return;
    settingsHomeView.style.display = viewName === "home" ? "block" : "none";
    settingsPinGateView.style.display = viewName === "pinGate" ? "block" : "none";
    settingsProfilesEditorView.style.display = viewName === "editor" ? "block" : "none";

    if (viewName === "home") {
      settingsModalTitle.textContent = "📁 Cartella Impostazioni";
      settingsModalSubtitle.textContent = "Pannello di configurazione generale e gestione profili operatore VNSR";
    } else if (viewName === "pinGate") {
      settingsModalTitle.textContent = "🔐 Accesso a Impostazione Profili";
      settingsModalSubtitle.textContent = "Inserisci uno dei 4 codici PIN abilitati per entrare nella gestione dei profili";
      if (settingsGatePinInput) {
        settingsGatePinInput.value = "";
        setTimeout(() => settingsGatePinInput.focus(), 80);
      }
      if (settingsGatePinError) settingsGatePinError.textContent = "";
    } else if (viewName === "editor") {
      settingsModalTitle.textContent = "👥 Impostazione Profili (4 Profili VNSR)";
      settingsModalSubtitle.textContent = "Modifica direttamente i 4 profili e i relativi codici PIN senza reinserire il codice attuale";
      if (profilesEditorError) profilesEditorError.textContent = "";
      renderProfilesEditorCards();
    }
  }

  function renderProfilesEditorCards() {
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
              value="${escapeHtml(prof.name)}"
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

  function attemptUnlockProfilesSettings() {
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
    showToast(`🔓 Impostazione Profili sbloccata con il codice di ${matchedProfile.name} (#${matchedProfile.code})`);
  }

  const openSettingsBtn = document.getElementById("openSettingsBtn");
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener("click", () => {
      showSettingsSubView("home");
      settingsModal.classList.add("open");
    });
  }

  const openProfileSettingsItemBtn = document.getElementById("openProfileSettingsItemBtn");
  if (openProfileSettingsItemBtn) {
    openProfileSettingsItemBtn.addEventListener("click", () => {
      // Richiede SEMPRE il PIN quando si vuole entrare nella voce "Impostazione Profili"
      showSettingsSubView("pinGate");
    });
  }

  const settingsOpenSyncBtn = document.getElementById("settingsOpenSyncBtn");
  if (settingsOpenSyncBtn) {
    settingsOpenSyncBtn.addEventListener("click", () => {
      settingsModal.classList.remove("open");
      document.getElementById("openSyncModalBtn")?.click();
    });
  }

  const settingsOpenAppleCalBtn = document.getElementById("settingsOpenAppleCalBtn");
  if (settingsOpenAppleCalBtn) {
    settingsOpenAppleCalBtn.addEventListener("click", () => {
      settingsModal.classList.remove("open");
      openAppleAuthModal();
    });
  }

  const backFromGateBtn = document.getElementById("backToSettingsHomeFromGateBtn");
  if (backFromGateBtn) {
    backFromGateBtn.addEventListener("click", () => showSettingsSubView("home"));
  }

  const backFromEditorBtn = document.getElementById("backToSettingsHomeFromEditorBtn");
  if (backFromEditorBtn) {
    backFromEditorBtn.addEventListener("click", () => showSettingsSubView("home"));
  }

  const unlockProfilesBtn = document.getElementById("unlockProfilesSettingsBtn");
  if (unlockProfilesBtn) {
    unlockProfilesBtn.addEventListener("click", attemptUnlockProfilesSettings);
  }

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
    profilesManagementForm.addEventListener("submit", async (e) => {
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

      // Salva direttamente i 4 profili e i nuovi codici senza richiedere il codice attuale
      const savedList = saveProfilesList(updatedProfiles);

      // Se l'operatore attivo in sessione è uno dei 4 profili, aggiorna immediatamente i suoi dati in header
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
          .map((p) => `${p.name} (#${p.code})`)
          .join(", ")}`
      );
      settingsModal.classList.remove("open");
      renderAll();
      showToast("✅ I 4 profili e i nuovi codici PIN sono stati salvati e sincronizzati!");
      saveApplicationData();
    });
  }

  const resetDefaultProfilesBtn = document.getElementById("resetDefaultProfilesBtn");
  if (resetDefaultProfilesBtn) {
    resetDefaultProfilesBtn.addEventListener("click", () => {
      const defaultsCopy = DEFAULT_PROFILES.map((d) => ({ ...d, updatedAt: new Date().toISOString() }));
      saveProfilesList(defaultsCopy);
      renderProfilesEditorCards();
      showToast("↺ Campi ripristinati ai 4 profili e codici predefiniti (clicca Salva per confermare).");
    });
  }
});
