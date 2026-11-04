/**
 * tracks.js — Modulo Catalogo Tracce, Data/Ora di Uscita, Crediti, UPC/ISRC e Player Audio Globale
 * Gestisce il rendering delle card delle tracce (`renderTracks`), l'apertura e compilazione
 * del modale di creazione/modifica traccia (con Data e Ora di Uscita del Singolo/Album),
 * l'upload di copertine e master MP3, la copia rapida di UPC/ISRC e il player audio globale.
 */

import {
  state,
  escapeHtml,
  showToast,
  recordActivity,
  saveApplicationData,
  uploadOrStoreFile,
  renderAll,
  evaluateTrackReleaseNotifications
} from "./main.js";

import {
  getPersonType,
  getPersonDisplayName,
  renderArtistSelectOptions,
  renderAnagraficaPreselectablePills
} from "./artists.js";

import { stripPinCodes } from "./auth.js"; // AGGIUNTO

// ==================== STATO LOCALE DEL MODULO TRACCE ====================
let pendingCoverFile = null;
let pendingAudioFile = null;

function formatReleaseDateTimeDisplay(releaseDate, releaseTime) {
  if (!releaseDate) return "";
  try {
    const [y, m, d] = releaseDate.split("-").map(Number);
    const timeStr = releaseTime || "00:00";
    const dt = new Date(y, m - 1, d);
    const formattedDay = dt.toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
    return `${formattedDay} • ore ${timeStr}`;
  } catch (_) {
    return `${releaseDate} ${releaseTime || "00:00"}`;
  }
}

// ==================== RENDERING CATALOGO TRACCE ====================
export function renderTracks() {
  const container = document.getElementById("tracksContainer");
  if (!container) return;

  const query = (document.getElementById("trackSearchInput")?.value || "").toLowerCase().trim();
  const artistFilter = document.getElementById("trackArtistFilter")?.value || "ALL";

  const filtered = state.tracks.filter((t) => {
    if (artistFilter !== "ALL" && t.artistId !== artistFilter) return false;
    const feats = Array.isArray(t.featuredArtists) ? t.featuredArtists.join(" ") : t.featuredArtists || "";
    const hay = `${t.title} ${t.mainArtist} ${t.producer} ${feats} ${t.upc} ${t.isrc} ${t.releaseDate || ""}`.toLowerCase();
    return hay.includes(query);
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div style="font-size: 40px;">💿</div>
        <h3>Nessuna traccia trovata</h3>
        <p>Aggiungi una nuova canzone con Data e Ora di Uscita, grafica Artista/Producer, codice UPC, ISRC, copertina e file MP3.</p>
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

      const relFormatted = formatReleaseDateTimeDisplay(track.releaseDate, track.releaseTime);
      const relType = track.releaseType || "Singolo";

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
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <div class="track-title">${escapeHtml(track.title)}</div>
                ${
                  relFormatted
                    ? `<span class="track-release-badge" title="Data e ora di uscita programmata (${escapeHtml(relType)})">🚀 ${escapeHtml(relType)}: ${escapeHtml(relFormatted)}</span>`
                    : ""
                }
              </div>

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

          <div class="featuring-row">
            <span style="font-weight: 700;">Partecipazioni / Menzioni:</span>
            ${
              feats.length > 0
                ? feats.map((f) => `<span class="feat-pill">${escapeHtml(f)}</span>`).join("")
                : `<span style="color: var(--text-muted);">Nessun altro partecipante menzionato</span>`
            }
          </div>

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
            <span>Operatore: <strong>${escapeHtml(stripPinCodes(track.createdBy || "VNSR"))}</strong></span>
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

// ==================== AZIONI MODALI TRACCIA & PLAYER GLOBALE ====================
export function openTrackModalForArtist(artistId) {
  if (state.artists.length === 0) {
    showToast("Aggiungi prima almeno un Artista o Collaboratore in Anagrafica!");
    return;
  }
  pendingCoverFile = null;
  pendingAudioFile = null;
  document.getElementById("trackForm").reset();
  document.getElementById("trackIdInput").value = "";
  document.getElementById("trackModalTitle").textContent = "Aggiungi Nuova Traccia VNSR";

  const todayIso = new Date().toISOString().slice(0, 10);
  const relTypeEl = document.getElementById("trackReleaseTypeSelect");
  const relDateEl = document.getElementById("trackReleaseDateInput");
  const relTimeEl = document.getElementById("trackReleaseTimeInput");
  if (relTypeEl) relTypeEl.value = "Singolo";
  if (relDateEl) relDateEl.value = todayIso;
  if (relTimeEl) relTimeEl.value = "00:00";

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
}
window.openTrackModalForArtist = openTrackModalForArtist;

export function openEditTrackModal(trackId) {
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

  const relTypeEl = document.getElementById("trackReleaseTypeSelect");
  const relDateEl = document.getElementById("trackReleaseDateInput");
  const relTimeEl = document.getElementById("trackReleaseTimeInput");
  if (relTypeEl) relTypeEl.value = track.releaseType || "Singolo";
  if (relDateEl) relDateEl.value = track.releaseDate || "";
  if (relTimeEl) relTimeEl.value = track.releaseTime || "00:00";

  renderAnagraficaPreselectablePills();

  document.getElementById("trackCoverFileLabel").innerHTML = track.coverUrl
    ? `🖼️ <strong>Copertina presente</strong> (clicca per sostituire)`
    : `🖼️ <strong>Carica Copertina</strong>`;

  document.getElementById("trackAudioFileLabel").innerHTML = track.audioUrl
    ? `🎵 <strong>MP3 presente (${escapeHtml(track.audioFileName || "master.mp3")})</strong>`
    : `🎵 <strong>Carica File MP3</strong> della traccia`;

  document.getElementById("trackModal").classList.add("open");
}
window.openEditTrackModal = openEditTrackModal;

export function deleteTrack(trackId) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  if (!confirm(`Vuoi eliminare la traccia "${track.title}" da tutti i dispositivi?`)) return;

  const relatedNotifIds = (state.notifications || [])
    .filter((n) => n && n.trackId === trackId)
    .map((n) => n.id);
  state.deletedIds = Array.from(
    new Set([...(state.deletedIds || []), trackId, ...relatedNotifIds])
  );
  state.dismissedNotificationIds = Array.from(
    new Set([...(state.dismissedNotificationIds || []), ...relatedNotifIds])
  );
  state.notifications = (state.notifications || []).filter((n) => n && n.trackId !== trackId);
  state.tracks = state.tracks.filter((t) => t.id !== trackId);
  recordActivity(`Eliminata traccia "${track.title}" (${track.mainArtist})`);

  renderAll();
  showToast(`Traccia "${track.title}" eliminata e sincronizzata`);
  saveApplicationData();
}
window.deleteTrack = deleteTrack;

export function playTrackInGlobalPlayer(trackId) {
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
}
window.playTrackInGlobalPlayer = playTrackInGlobalPlayer;

export function copyCode(code, label) {
  if (!code) return;
  navigator.clipboard?.writeText(code);
  showToast(`Codice ${label} (${code}) copiato negli appunti!`);
}
window.copyCode = copyCode;

// ==================== EVENT LISTENERS DEL MODULO TRACCE ====================
export function initTracksEvents() {
  document.getElementById("trackSearchInput")?.addEventListener("input", renderTracks);
  document.getElementById("trackArtistFilter")?.addEventListener("change", renderTracks);

  document.getElementById("openAddTrackBtn")?.addEventListener("click", () => {
    openTrackModalForArtist(state.artists[0]?.id || "");
  });

  document.getElementById("trackArtistSelect")?.addEventListener("change", (e) => {
    const art = state.artists.find((a) => a.id === e.target.value);
    if (art) {
      document.getElementById("trackMainArtistDisplay").value = getPersonDisplayName(art);
      renderAnagraficaPreselectablePills();
    }
  });

  ["trackMainArtistDisplay", "trackProducerInput", "trackFeaturedInput"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", () => renderAnagraficaPreselectablePills());
    }
  });

  document.getElementById("trackCoverFile")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      pendingCoverFile = file;
      document.getElementById("trackCoverFileLabel").innerHTML =
        `✅ Copertina selezionata: <strong>${escapeHtml(file.name)}</strong>`;
    }
  });

  document.getElementById("trackAudioFile")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      pendingAudioFile = file;
      document.getElementById("trackAudioFileLabel").innerHTML =
        `✅ Master MP3 selezionato: <strong>${escapeHtml(file.name)}</strong>`;
    }
  });

  document.getElementById("closePlayerBtn")?.addEventListener("click", () => {
    const audioEl = document.getElementById("globalAudioElement");
    if (audioEl) audioEl.pause();
    document.getElementById("globalPlayer")?.classList.remove("visible");
  });

  // Salvataggio Form Traccia con Optimistic UI (zero freeze) + Programmazione Notifiche Uscita
  document.getElementById("trackForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const existingId = document.getElementById("trackIdInput").value;
    const artistId = document.getElementById("trackArtistSelect").value;
    const title = document.getElementById("trackTitleInput").value.trim();
    const mainArtist = document.getElementById("trackMainArtistDisplay").value.trim();
    const producer = document.getElementById("trackProducerInput").value.trim();
    const featuredRaw = document.getElementById("trackFeaturedInput").value.trim();
    const upc = document.getElementById("trackUpcInput").value.trim();
    const isrc = document.getElementById("trackIsrcInput").value.trim();
    const releaseType = document.getElementById("trackReleaseTypeSelect")?.value || "Singolo";
    const releaseDate = document.getElementById("trackReleaseDateInput")?.value || "";
    const releaseTime = document.getElementById("trackReleaseTimeInput")?.value || "00:00";

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

    const coverFileToUpload = pendingCoverFile;
    const audioFileToUpload = pendingAudioFile;
    pendingCoverFile = null;
    pendingAudioFile = null;

    if (coverFileToUpload) {
      coverUrl = URL.createObjectURL(coverFileToUpload);
    }

    if (audioFileToUpload) {
      audioUrl = URL.createObjectURL(audioFileToUpload);
      audioFileName = audioFileToUpload.name;
    }

    let toastMsg = "";
    const targetTrackId =
      existingId || "trk_" + Date.now() + "_" + Math.random().toString(36).slice(2, 5);

    // 1. Aggiorna lo stato locale
    if (existingId) {
      // Rimuove eventuali vecchie notifiche della traccia così vengono ricalcolate sulla nuova data/ora
      state.notifications = (state.notifications || []).filter(
        (n) => n && n.trackId !== existingId
      );
      state.dismissedNotificationIds = (state.dismissedNotificationIds || []).filter(
        (id) => !String(id).startsWith(`relnotif_${existingId}_`)
      );

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
              releaseType,
              releaseDate,
              releaseTime,
              coverUrl,
              audioUrl,
              audioFileName,
              updatedAt: nowIso
            }
          : t
      );
      recordActivity(`Aggiornata traccia "${title}" (${mainArtist} — Uscita: ${releaseDate} ${releaseTime})`);
      toastMsg = `Traccia "${title}" aggiornata e sincronizzata!`;
    } else {
      const newTrack = {
        id: targetTrackId,
        artistId,
        title,
        mainArtist,
        producer,
        featuredArtists,
        upc,
        isrc,
        releaseType,
        releaseDate,
        releaseTime,
        coverUrl,
        audioUrl,
        audioFileName,
        createdBy: opTag,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      state.tracks.unshift(newTrack);
      recordActivity(`Programmato ${releaseType.toLowerCase()} "${title}" di ${mainArtist} (Uscita: ${releaseDate} ore ${releaseTime})`);
      toastMsg = `🚀 ${releaseType} "${title}" salvato! Notifiche programmate (-7gg, -3gg, -1g e uscita).`;
    }

    // 2. Chiudi subito il modale
    document.getElementById("trackModal")?.classList.remove("open");

    // 3. Esegui renderAll() (e valutazione notifiche) e mostra il Toast
    if (typeof evaluateTrackReleaseNotifications === "function") {
      evaluateTrackReleaseNotifications(false);
    }
    renderAll();
    showToast(toastMsg);

    // 4. Lancia saveApplicationData() SENZA "await" (esecuzione asincrona in background)
    if (coverFileToUpload || audioFileToUpload) {
      Promise.all([
        coverFileToUpload ? uploadOrStoreFile(coverFileToUpload, "covers") : Promise.resolve(null),
        audioFileToUpload ? uploadOrStoreFile(audioFileToUpload, "audio") : Promise.resolve(null)
      ])
        .then(([uploadedCover, uploadedAudio]) => {
          state.tracks = state.tracks.map((t) => {
            if (t.id !== targetTrackId) return t;
            return {
              ...t,
              coverUrl: uploadedCover && uploadedCover.url ? uploadedCover.url : t.coverUrl,
              audioUrl: uploadedAudio && uploadedAudio.url ? uploadedAudio.url : t.audioUrl,
              audioFileName:
                uploadedAudio && uploadedAudio.name ? uploadedAudio.name : t.audioFileName
            };
          });
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
