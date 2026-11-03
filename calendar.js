/**
 * calendar.js — Modulo Calendario Appuntamenti e Integrazione Apple Calendar (iCloud CalDAV & .ICS)
 * Gestisce la griglia mensile del calendario, la sidebar degli eventi del giorno selezionato,
 * i modali di creazione/modifica appuntamento e la sincronizzazione bidirezionale (Lettura/Upload)
 * con Apple Calendar tramite protocollo iCloud CalDAV, link Webcal e file standard .ICS.
 */

import {
  state,
  SYNC_TIMEOUT_MS,
  escapeHtml,
  showToast,
  recordActivity,
  saveApplicationData,
  fetchWithTimeout,
  getBaseApiUrl,
  mergeCollectionClient,
  renderAll
} from "./main.js";

import { renderArtistSelectOptions } from "./artists.js";

export const ITALIAN_MONTHS = [
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

export function formatLocalIsoDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getAppleCalAuth() {
  try {
    return JSON.parse(localStorage.getItem("vnsr_apple_cal_auth") || "null");
  } catch (_) {
    return null;
  }
}

export function saveAppleCalAuth(authObj) {
  if (!authObj) {
    localStorage.removeItem("vnsr_apple_cal_auth");
  } else {
    localStorage.setItem("vnsr_apple_cal_auth", JSON.stringify(authObj));
  }
  updateAppleAuthUI();
}

export function updateAppleAuthUI() {
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

export function openAppleAuthModal() {
  const auth = getAppleCalAuth() || {};
  const emailInput = document.getElementById("appleCalEmailInput");
  const passInput = document.getElementById("appleCalAppPasswordInput");
  const webcalInput = document.getElementById("appleCalWebcalInput");
  const statusBox = document.getElementById("appleCalStatusBox");

  if (emailInput) emailInput.value = auth.email || "";
  if (passInput) passInput.value = auth.password || "";
  if (webcalInput) webcalInput.value = auth.webcalUrl || "";
  if (statusBox) statusBox.style.display = "none";

  document.getElementById("appleCalendarAuthModal")?.classList.add("open");
}
window.openAppleAuthModal = openAppleAuthModal;

export function openCalendarWindowModal() {
  renderCalendar();
  document.getElementById("calendarWindowModal")?.classList.add("open");
}
window.openCalendarWindowModal = openCalendarWindowModal;

export function changeCalendarMonth(delta) {
  currentCalendarMonth += delta;
  if (currentCalendarMonth > 11) {
    currentCalendarMonth = 0;
    currentCalendarYear += 1;
  } else if (currentCalendarMonth < 0) {
    currentCalendarMonth = 11;
    currentCalendarYear -= 1;
  }
  renderCalendar();
}
window.changeCalendarMonth = changeCalendarMonth;

export function resetCalendarToToday() {
  const now = new Date();
  currentCalendarYear = now.getFullYear();
  currentCalendarMonth = now.getMonth();
  selectedCalendarDate = formatLocalIsoDate(now);
  renderCalendar();
}
window.resetCalendarToToday = resetCalendarToToday;

export function selectCalendarDate(dateStr, openNewOnDoubleClick = false) {
  selectedCalendarDate = dateStr;
  renderCalendar();
  if (openNewOnDoubleClick) {
    openNewAppointmentModal(dateStr);
  }
}
window.selectCalendarDate = selectCalendarDate;

function getCategoryStyleClass(appt) {
  if (appt.source === "apple_calendar") return "cat-apple";
  const cat = (appt.category || "").toLowerCase();
  if (cat.includes("studio")) return "cat-studio";
  if (cat.includes("release")) return "cat-release";
  if (cat.includes("live")) return "cat-live";
  return "";
}

export function renderCalendar() {
  updateAppleAuthUI();

  const monthTitle = `${ITALIAN_MONTHS[currentCalendarMonth]} ${currentCalendarYear}`;
  const inlineTitleEl = document.getElementById("inlineCalendarMonthTitle");
  const popupTitleEl = document.getElementById("popupCalendarMonthTitle");
  if (inlineTitleEl) inlineTitleEl.textContent = monthTitle;
  if (popupTitleEl) popupTitleEl.textContent = monthTitle;

  const firstDayOfMonth = new Date(currentCalendarYear, currentCalendarMonth, 1);
  const daysInMonth = new Date(currentCalendarYear, currentCalendarMonth + 1, 0).getDate();
  const prevMonthDays = new Date(currentCalendarYear, currentCalendarMonth, 0).getDate();

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
  const totalCells = 42;

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

export function renderSelectedDaySidebar() {
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

export function openNewAppointmentModal(dateStr = selectedCalendarDate) {
  renderArtistSelectOptions();
  document.getElementById("appointmentForm")?.reset();
  document.getElementById("apptIdInput").value = "";
  document.getElementById("appointmentModalTitle").textContent = "➕ Nuovo Appuntamento VNSR";
  document.getElementById("apptDateInput").value = dateStr || formatLocalIsoDate(new Date());
  document.getElementById("apptStartTimeInput").value = "15:00";
  document.getElementById("apptEndTimeInput").value = "17:00";
  document.getElementById("apptCategorySelect").value = "Studio & Rec";
  document.getElementById("apptPushToAppleCheckbox").checked = true;
  document.getElementById("appointmentFormModal")?.classList.add("open");
}
window.openNewAppointmentModal = openNewAppointmentModal;

export function openAppointmentModalForSelectedDate() {
  openNewAppointmentModal(selectedCalendarDate);
}
window.openAppointmentModalForSelectedDate = openAppointmentModalForSelectedDate;

export function openEditAppointmentModal(apptId) {
  const appt = (state.appointments || []).find((a) => a.id === apptId);
  if (!appt) return;

  renderArtistSelectOptions();
  document.getElementById("appointmentModalTitle").textContent = `✏️ Modifica Appuntamento: ${appt.title}`;
  document.getElementById("apptIdInput").value = appt.id;
  document.getElementById("apptTitleInput").value = appt.title || "";
  document.getElementById("apptDateInput").value = appt.date || selectedCalendarDate;
  document.getElementById("apptStartTimeInput").value = appt.startTime || "15:00";
  document.getElementById("apptEndTimeInput").value = appt.endTime || "16:00";
  document.getElementById("apptCategorySelect").value = appt.category || "Studio & Rec";
  document.getElementById("apptArtistSelect").value = appt.artistName || "";
  document.getElementById("apptLocationInput").value = appt.location || "";
  document.getElementById("apptNotesInput").value = appt.notes || "";
  document.getElementById("apptPushToAppleCheckbox").checked = true;

  document.getElementById("appointmentFormModal")?.classList.add("open");
}
window.openEditAppointmentModal = openEditAppointmentModal;

export function deleteAppointment(apptId) {
  const appt = (state.appointments || []).find((a) => a.id === apptId);
  if (!appt) return;
  if (!confirm(`Vuoi eliminare l'appuntamento "${appt.title}" dal calendario VNSR?`)) return;

  state.deletedIds = Array.from(new Set([...(state.deletedIds || []), apptId]));
  state.appointments = (state.appointments || []).filter((a) => a.id !== apptId);
  recordActivity(`Eliminato appuntamento "${appt.title}" (${appt.date})`);

  renderCalendar();
  renderAll();
  showToast(`Appuntamento "${appt.title}" eliminato.`);
  saveApplicationData();
}
window.deleteAppointment = deleteAppointment;

export async function syncFromAppleCalendar(silent = false) {
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

    renderCalendar();
    renderAll();
    if (!silent) {
      showToast(`✅ Ricevuti ${incomingEvents.length} appuntamenti da Apple Calendar (${data.calendarName || "iCloud"})!`);
    }
    saveApplicationData();
    return true;
  } catch (err) {
    if (!silent) {
      showToast(
        "⚠️ Impossibile contattare il bridge CalDAV locale. Avvia Avvia_Gestionale.command o usa Importa .ICS."
      );
    }
    return false;
  }
}
window.syncFromAppleCalendar = syncFromAppleCalendar;

export async function uploadEventToAppleCalendar(appt, showFeedback = true) {
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
      renderCalendar();
      saveApplicationData();
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

export function pushSingleAppointmentToApple(apptId) {
  const appt = (state.appointments || []).find((a) => a.id === apptId);
  if (!appt) return;
  uploadEventToAppleCalendar(appt, true);
}
window.pushSingleAppointmentToApple = pushSingleAppointmentToApple;

export function downloadAppointmentIcs(apptId) {
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
}
window.downloadAppointmentIcs = downloadAppointmentIcs;

export function parseIcsTextClient(icsText) {
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

export function initCalendarEvents() {
  document.getElementById("openCalendarWindowBtn")?.addEventListener("click", () => {
    openCalendarWindowModal();
  });

  document.getElementById("openAppleAuthBtn")?.addEventListener("click", () => {
    openAppleAuthModal();
  });

  document.getElementById("pullAppleCalendarBtn")?.addEventListener("click", () => {
    syncFromAppleCalendar(false);
  });

  document.getElementById("openNewAppointmentBtn")?.addEventListener("click", () => {
    openNewAppointmentModal(selectedCalendarDate);
  });

  const appleAuthForm = document.getElementById("appleCalendarAuthForm");
  if (appleAuthForm) {
    appleAuthForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const email = document.getElementById("appleCalEmailInput").value.trim();
      const password = document.getElementById("appleCalAppPasswordInput").value.trim();
      const webcalUrl = document.getElementById("appleCalWebcalInput").value.trim();

      // 1. Aggiorna lo stato locale
      saveAppleCalAuth({ email, password, webcalUrl, connectedAt: new Date().toISOString() });

      // 2. Chiudi subito il modale
      document.getElementById("appleCalendarAuthModal")?.classList.remove("open");

      // 3. Esegui renderAll() e mostra il Toast
      renderAll();
      showToast("🍎 Credenziali Apple Calendar salvate! Sincronizzazione in corso in background...");

      // 4. Lancia sync e saveApplicationData() SENZA "await" (esecuzione asincrona in background)
      saveApplicationData();
      syncFromAppleCalendar(false);
    });
  }

  document.getElementById("disconnectAppleCalBtn")?.addEventListener("click", () => {
    saveAppleCalAuth(null);
    document.getElementById("appleCalendarAuthModal")?.classList.remove("open");
    showToast("Account Apple Calendar scollegato.");
  });

  const apptForm = document.getElementById("appointmentForm");
  if (apptForm) {
    apptForm.addEventListener("submit", (e) => {
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

      document.getElementById("appointmentFormModal")?.classList.remove("open");
      renderCalendar();
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

        renderCalendar();
        renderAll();
        showToast(`✅ Importati ${events.length} appuntamenti dal file .ICS di Apple Calendar!`);
        saveApplicationData();
      } catch (_) {
        showToast("❌ Errore durante la lettura del file .ICS.");
      }
      e.target.value = "";
    });
  }
}
