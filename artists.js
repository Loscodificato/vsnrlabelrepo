/**
 * artists.js — Modulo Anagrafica (Artisti & Collaboratori), Preselezione e Contratto 2FA PDF
 * Gestisce la creazione/modifica di artisti e collaboratori (con mutua esclusione rigorosa
 * tra Nome d'Arte e Nome/Cognome), il rendering delle card e dei filtri UI, le pillole di
 * preselezione rapida in tutto il software e la procedura Contratto a Due Fattori (PDFLib + Upload).
 */

import {
  state,
  escapeHtml,
  showToast,
  recordActivity,
  saveApplicationData,
  uploadOrStoreFile,
  switchTab,
  renderAll
} from "./main.js";

import { stripPinCodes } from "./auth.js"; // AGGIUNTO
import { renderTracks } from "./tracks.js";

// ==================== STATO LOCALE DEL MODULO ANAGRAFICA & CONTRATTI ====================
let activeAnagraficaTypeFilter = "ALL";
let pendingContractFile = null;
let pendingContractFormData = null;
let pendingGeneratedPdfDataUrl = "";
let pendingGeneratedPdfName = "";

// ==================== HELPERS ANAGRAFICA (ARTISTI & COLLABORATORI) ====================
export function getPersonType(person) {
  if (!person) return "Artista";
  return person.personType === "Collaboratore" ? "Collaboratore" : "Artista";
}

export function getPersonDisplayName(person) {
  if (!person) return "Senza Nome";
  const stage = (person.stageName || "").trim();
  const legal = `${(person.firstName || "").trim()} ${(person.lastName || "").trim()}`.trim();
  if (person.nameMode === "legal" && legal) return legal;
  if (person.nameMode === "stage" && stage) return stage;
  return stage || legal || "Senza Nome";
}

export function getPersonNameMode(person) {
  if (!person) return "stage";
  if (person.nameMode === "legal" || person.nameMode === "stage") return person.nameMode;
  const hasStage = Boolean((person.stageName || "").trim());
  const hasLegal = Boolean(`${(person.firstName || "").trim()} ${(person.lastName || "").trim()}`.trim());
  if (hasLegal && !hasStage) return "legal";
  return "stage";
}

// ==================== MOTORE COMPILAZIONE AUTOMATICA CONTRATTO PDF (4 PAGINE) ====================
export function getSavedLabelDefaults() {
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

export function saveLabelDefaults(data) {
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

export async function generateFilledContractPdf(fd) {
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

  // PAGINA 1
  drawField(page1, fd.labelName, 124, 594.3, 8.8, true, 150);
  drawField(page1, fd.labelVat, 102, 578.6, 8.8, false, 155);
  drawField(page1, fd.labelRep, 151, 562.8, 8.8, false, 126);
  drawField(page1, fd.labelCity, 152, 547.1, 8.8, false, 125);
  drawField(page1, fd.labelAddress, 133, 531.4, 8.5, false, 147);
  drawField(page1, fd.labelEmail, 109, 515.6, 8.5, false, 168);

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

  drawField(page1, fd.trackTitle, 155, 425.2, 9.2, true, 212);
  drawField(page1, fd.trackIsrc, 446, 425.2, 8.8, true, 92);

  page1.drawRectangle({ x: 154, y: 407, width: 215, height: 13, color: boxBg });
  const ver = fd.trackVersion || "Original";
  const verString =
    `${ver === "Original" ? "[X]" : "[ ]"} Original   ` +
    `${ver === "Remix" ? "[X]" : "[ ]"} Remix   ` +
    `${ver === "Acoustic" ? "[X]" : "[ ]"} Acoustic   ` +
    `${ver === "Extended" ? "[X]" : "[ ]"} Extended`;
  drawField(page1, verString, 156, 411.2, 8.5, true, 212);

  page1.drawRectangle({ x: 444, y: 407, width: 96, height: 13, color: boxBg });
  drawField(page1, fd.deliveryDate, 452, 410.2, 8.8, true, 88);

  // PAGINA 2
  const drawRoyaltyPair = (yPos, artPct, lblPct) => {
    page2.drawRectangle({ x: 304, y: yPos - 3, width: 52, height: 14, color: whiteBg });
    page2.drawRectangle({ x: 445, y: yPos - 3, width: 52, height: 14, color: whiteBg });
    drawField(page2, `[ ${artPct}% ]`, 310, yPos, 9.5, true, 50);
    drawField(page2, `[ ${lblPct}% ]`, 451, yPos, 9.5, true, 50);
  };

  drawRoyaltyPair(565.0, fd.royaltyStreamArtist || "50", fd.royaltyStreamLabel || "50");
  drawRoyaltyPair(500.2, fd.royaltyPhysArtist || "50", fd.royaltyPhysLabel || "50");
  drawRoyaltyPair(467.8, fd.royaltySocialArtist || "50", fd.royaltySocialLabel || "50");

  page2.drawRectangle({ x: 65, y: 328, width: 460, height: 13, color: boxBg });
  drawField(page2, fd.recoupableCosts || "NESSUNA", 66.5, 331.5, 8.8, true, 455);

  page2.drawRectangle({ x: 65, y: 110, width: 470, height: 13, color: whiteBg });
  const isTrimestrale = fd.statementPeriod === "Trimestrale";
  const periodStr =
    `${!isTrimestrale ? "[X]" : "[ ]"} Semestrale (30 Giugno e 31 Dicembre)       ` +
    `${isTrimestrale ? "[X]" : "[ ]"} Trimestrale (Marzo, Giugno, Settembre, Dicembre)`;
  drawField(page2, periodStr, 66.5, 113.7, 8.6, true, 465);

  // PAGINA 3
  drawField(page3, fd.artistIban, 255, 789.8, 8.8, true, 280);
  page3.drawRectangle({ x: 65, y: 530, width: 460, height: 13, color: boxBg });
  drawField(page3, fd.samplesDeclaration || "NESSUN CAMPIONE DI TERZI UTILIZZATO", 66.5, 533.2, 8.5, true, 455);
  drawField(page3, fd.courtCity || "Roma", 357, 231.0, 9.0, true, 100);

  // PAGINA 4
  drawField(page4, fd.signPlace || "Roma", 356, 772.2, 9.0, true, 80);
  page4.drawRectangle({ x: 460, y: 767, width: 92, height: 14, color: whiteBg });
  drawField(page4, fd.signDate, 463, 770.5, 9.0, true, 88);

  const pdfDataUri = await pdfDoc.saveAsDataUri();
  const savedBytes = await pdfDoc.save();
  return { pdfDataUri, savedBytes };
}

// ==================== CONTROLLO A 2 FATTORI CONTRATTO (BANNER & STEPPER) ====================
export function renderTwoFaNotifications() {
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
    .map((artist) => {
      const displayName = getPersonDisplayName(artist);
      return `
      <div class="twofa-alert-banner">
        <div style="display: flex; align-items: center; gap: 14px;">
          <div style="font-size: 28px;">🔐</div>
          <div>
            <div style="font-size: 13.5px; font-weight: 800; color: var(--accent-gold); text-transform: uppercase;">
              Controllo a 2 Fattori Contratto — In Attesa del Passaggio 2/2 (Ultimo Passaggio)
            </div>
            <div style="font-size: 13.5px; color: var(--text-primary); margin-top: 3px;">
              Soggetto: <strong>${escapeHtml(displayName)}</strong> (${escapeHtml(getPersonType(artist))}) —
              <span style="color: #34d399;">✅ Passaggio 1/2: PDF Compilato Generato</span> •
              <span style="color: var(--accent-gold); font-weight: 700;">⏳ Passaggio 2/2: Carica il contratto scannerizzato con la firma</span>
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          ${
            artist.generatedContractPdfUrl
              ? `<a class="btn btn-secondary btn-sm" href="${artist.generatedContractPdfUrl}" download="${escapeHtml(artist.generatedContractPdfName || `Contratto_VNSR_${displayName}_Da_Firmare.pdf`)}" target="_blank">
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
    `;
    })
    .join("");
}

export function quickUploadSignedContract(artistId, file) {
  if (!file) return;
  const artist = state.artists.find((a) => a.id === artistId);
  if (!artist) return;
  const displayName = getPersonDisplayName(artist);
  const nowIso = new Date().toISOString();
  const todayDate = nowIso.slice(0, 10);
  const tempUrl = URL.createObjectURL(file);

  // 1. Aggiorna subito lo stato locale (Optimistic UI)
  state.artists = state.artists.map((a) =>
    a.id === artistId
      ? {
          ...a,
          contractFileUrl: tempUrl,
          contractFileName: file.name,
          contractStatus: "Firmato e Attivo",
          contractDate: a.contractDate || todayDate,
          contract2FAState: "verified_2fa",
          updatedAt: nowIso
        }
      : a
  );

  recordActivity(`Completato Passaggio 2/2 (2FA): caricato contratto firmato scannerizzato per "${displayName}"`);

  // 2. Renderizza subito la UI e mostra il Toast
  renderAll();
  showToast(`✅ Controllo a 2 Fattori completato per ${displayName}! Contratto firmato registrato.`);

  // 3. Esegui upload e saveApplicationData() SENZA await in background
  uploadOrStoreFile(file, "contracts")
    .then((uploaded) => {
      if (uploaded && uploaded.url) {
        state.artists = state.artists.map((a) =>
          a.id === artistId
            ? { ...a, contractFileUrl: uploaded.url, contractFileName: uploaded.name || file.name }
            : a
        );
      }
      saveApplicationData();
    })
    .catch(() => {
      saveApplicationData();
    });
}
window.quickUploadSignedContract = quickUploadSignedContract;

export function updateModalTwoFaUI(step1Done, step2Done, genFileName = "", signedFileName = "") {
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

// ==================== PILLOLE DI PRESELEZIONE GLOBALE DA ANAGRAFICA ====================
export function renderAnagraficaPreselectablePills() {
  const allPeople = state.artists || [];
  const artistsList = allPeople.filter((p) => getPersonType(p) === "Artista");
  const collabsList = allPeople.filter((p) => getPersonType(p) === "Collaboratore");

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

export function selectAnagraficaForMainArtist(personId) {
  const person = state.artists.find((a) => a.id === personId);
  if (!person) return;
  const displayName = getPersonDisplayName(person);
  const mainInput = document.getElementById("trackMainArtistDisplay");
  const selectEl = document.getElementById("trackArtistSelect");
  if (mainInput) mainInput.value = displayName;
  if (selectEl) selectEl.value = person.id;
  renderAnagraficaPreselectablePills();
}
window.selectAnagraficaForMainArtist = selectAnagraficaForMainArtist;

export function selectAnagraficaForProducer(personId) {
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
}
window.selectAnagraficaForProducer = selectAnagraficaForProducer;

export function toggleAnagraficaInFeatured(personId) {
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
}
window.toggleAnagraficaInFeatured = toggleAnagraficaInFeatured;

export function selectAnagraficaForContractParty2(personId) {
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
}
window.selectAnagraficaForContractParty2 = selectAnagraficaForContractParty2;

export function toggleAnagraficaInContractRights(personId) {
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
}
window.toggleAnagraficaInContractRights = toggleAnagraficaInContractRights;

// ==================== OPZIONI SELECT & RENDERING CARD ANAGRAFICA ====================
export function renderArtistSelectOptions() {
  const filterSelect = document.getElementById("trackArtistFilter");
  const modalSelect = document.getElementById("trackArtistSelect");
  const apptArtistSelect = document.getElementById("apptArtistSelect");
  if (!filterSelect || !modalSelect) return;

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

export function renderArtists() {
  const container = document.getElementById("artistsContainer");
  if (!container) return;
  const query = (document.getElementById("artistSearchInput")?.value || "").toLowerCase().trim();

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

      // MODIFICATO: Rimozione di "(Controllo 2 Fattori)" dal titolo e stripPinCodes() per il creatore
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
                🔐 Contratto & Diritti VNSR
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
              Operatore: <strong>${escapeHtml(stripPinCodes(artist.createdBy || "VNSR"))}</strong>
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

// ==================== AZIONI MODALI E MUTUA ESCLUSIONE ANAGRAFICA ====================
export function filterTracksByArtist(artistId) {
  const filterSelect = document.getElementById("trackArtistFilter");
  if (filterSelect) filterSelect.value = artistId;
  switchTab("tracks");
  renderTracks();
}
window.filterTracksByArtist = filterTracksByArtist;

export function setAnagraficaPersonType(pType) {
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

export function setAnagraficaNameMode(mode) {
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

export function openNewAnagraficaModal(defaultPersonType = "Artista") {
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
}
window.openNewAnagraficaModal = openNewAnagraficaModal;

export function openEditArtistModal(artistId) {
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
}
window.openEditArtistModal = openEditArtistModal;

export function deleteArtist(artistId) {
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
  renderAll();
  showToast(`${pType} ${displayName} rimosso e sincronizzato`);
  saveApplicationData();
}
window.deleteArtist = deleteArtist;

// ==================== EVENT LISTENERS DEL MODULO ANAGRAFICA & CONTRATTI ====================
export function initArtistsEvents() {
  document.getElementById("artistSearchInput")?.addEventListener("input", renderArtists);

  document.getElementById("openAddArtistBtn")?.addEventListener("click", () => {
    openNewAnagraficaModal("Artista");
  });

  document.getElementById("openAddCollaboratorBtn")?.addEventListener("click", () => {
    openNewAnagraficaModal("Collaboratore");
  });

  document.querySelectorAll("#anagraficaTypeFilterGroup .anagrafica-filter-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document
        .querySelectorAll("#anagraficaTypeFilterGroup .anagrafica-filter-pill")
        .forEach((b) => b.classList.remove("active"));
      pill.classList.add("active");
      activeAnagraficaTypeFilter = pill.dataset.typeFilter || "ALL";
      renderArtists();
    });
  });

  document.querySelectorAll(".person-type-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      setAnagraficaPersonType(btn.dataset.ptype);
    });
  });

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

  document.getElementById("artistContractFile")?.addEventListener("change", (e) => {
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

  document.getElementById("openContractBuilderBtn")?.addEventListener("click", () => {
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

  document.getElementById("cbSamplesDeclaration")?.addEventListener("input", () => {
    renderAnagraficaPreselectablePills();
  });

  document.getElementById("contractBuilderForm")?.addEventListener("submit", async (e) => {
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

  // Optimistic UI sul salvataggio Anagrafica (zero freeze)
  document.getElementById("artistForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const existingId = document.getElementById("artistIdInput").value;
    const personType =
      document.getElementById("artistPersonTypeInput")?.value === "Collaboratore"
        ? "Collaboratore"
        : "Artista";
    const isLegalMode = document.getElementById("nameModeLegalBtn")?.classList.contains("active");
    const rawStage = document.getElementById("artistStageName").value.trim();
    const rawFirst = document.getElementById("artistFirstName").value.trim();
    const rawLast = document.getElementById("artistLastName").value.trim();
    const errEl = document.getElementById("artistIdentityError");
    if (errEl) errEl.textContent = "";

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

    const contractFileToUpload = pendingContractFile;
    pendingContractFile = null;

    if (contractFileToUpload) {
      contractFileUrl = URL.createObjectURL(contractFileToUpload);
      contractFileName = contractFileToUpload.name;
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

    let toastMsg = "";
    const targetArtistId =
      existingId || "art_" + Date.now() + "_" + Math.random().toString(36).slice(2, 5);

    // 1. Aggiorna lo stato locale
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
      toastMsg =
        contract2FAState === "pending_step2"
          ? `⚠️ ${displayName} salvato: resta in attesa il Passaggio 2/2 (upload contratto scannerizzato firmato)`
          : `${personType} "${displayName}" aggiornato e già preselezionabile in tutto il software!`;
    } else {
      const newArtist = {
        id: targetArtistId,
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
      toastMsg =
        contract2FAState === "pending_step2"
          ? `⚠️ ${displayName} creato! Passaggio 1/2 completato, resta notificato l'upload del contratto firmato (Passaggio 2/2)`
          : `✅ ${personType} "${displayName}" aggiunto in Anagrafica e preselezionabile ovunque!`;
    }

    // 2. Chiudi subito il modale
    document.getElementById("artistModal")?.classList.remove("open");

    // 3. Esegui renderAll() e mostra il Toast
    renderAll();
    showToast(toastMsg);

    // 4. Lancia saveApplicationData() SENZA "await" (esecuzione asincrona in background)
    if (contractFileToUpload) {
      uploadOrStoreFile(contractFileToUpload, "contracts")
        .then((uploaded) => {
          if (uploaded && uploaded.url) {
            state.artists = state.artists.map((a) =>
              a.id === targetArtistId
                ? {
                    ...a,
                    contractFileUrl: uploaded.url,
                    contractFileName: uploaded.name || contractFileToUpload.name
                  }
                : a
            );
          }
          saveApplicationData();
        })
        .catch(() => {
          saveApplicationData();
        });
    } else {
      saveApplicationData();
    }
  });
}