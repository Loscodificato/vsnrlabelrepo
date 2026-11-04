/**
 * VSNR GESTIONALE — ELECTRON MAIN PROCESS & EMBEDDED NODE.JS SERVER
 * =================================================================
 * - Avvia silenziosamente in background il server Node.js locale su 127.0.0.1:8080
 *   mantenendo intatte tutte le rotte (/api/state, /api/upload, /api/ping,
 *   /api/auto-update/status, /api/auto-update/apply-bundle, /api/auto-update/publish,
 *   /api/apple-calendar/*) e l'architettura di sync/auto-update su Firebase.
 * - Apre una BrowserWindow nativa dedicata che carica http://127.0.0.1:8080.
 */

const { app, BrowserWindow, shell } = require("electron");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

let AdmZip = null;
try {
  AdmZip = require("adm-zip");
} catch (_) {}

// Configurazione Sicura Asar-Friendly (userData)
const safeDataPath = path.join(app.getPath('userData'), 'data');
if (!fs.existsSync(safeDataPath)) {
  fs.mkdirSync(safeDataPath, { recursive: true });
}
const safeUploadsPath = path.join(app.getPath('userData'), 'uploads');
if (!fs.existsSync(safeUploadsPath)) {
  fs.mkdirSync(safeUploadsPath, { recursive: true });
}

const PORT = Number(process.env.PORT) || 8080;
const HOST = "127.0.0.1";
const BASE_DIR = __dirname;
const DB_FILE = path.join(safeDataPath, "db.json");
const VERSION_FILE = path.join(safeDataPath, "version.json");
const RELEASE_BUNDLE_FILE = path.join(safeDataPath, "release_bundle.json");
const DEFAULT_FIREBASE_DB_URL =
  "https://vsnr-management-default-rtdb.europe-west1.firebasedatabase.app";

const CORE_UPDATE_FILES = [
  "index.html",
  "styles.css",
  "main.js",
  "auth.js",
  "artists.js",
  "tracks.js",
  "calendar.js",
  "settings.js",
  "app.js",
  "logo-vnsr.png"
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ics": "text/calendar; charset=utf-8"
};

let mainWindow = null;
let localServer = null;

// ==================== UTILITY RETE & DATABASE LOCALE ====================

function getLocalLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return HOST;
}

function pingGoogle8888(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(ok);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(53, "8.8.8.8");
  });
}

function loadDb() {
  const defaultDb = {
    version: Date.now(),
    artists: [],
    tracks: [],
    appointments: [],
    notifications: [],
    dismissedNotificationIds: [],
    activityLog: [],
    deletedIds: []
  };
  if (!fs.existsSync(DB_FILE)) {
    saveDb(defaultDb);
    return defaultDb;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      ...defaultDb,
      ...parsed,
      version: parsed.version || Date.now()
    };
  } catch (_) {
    return defaultDb;
  }
}

function saveDb(data) {
  data.version = Date.now();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf-8");
  return data;
}

function mergeCollection(existingList = [], incomingList = [], deletedSet = new Set()) {
  const byId = new Map();
  for (const item of existingList) {
    if (item && item.id && !deletedSet.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  for (const item of incomingList) {
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
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
}

function mergeActivityLogs(existingLogs = [], incomingLogs = []) {
  const byId = new Map();
  for (const entry of [...existingLogs, ...incomingLogs]) {
    if (entry && entry.id) {
      byId.set(entry.id, entry);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, 250);
}

// ==================== AUTO-UPDATE & PUBLISH ENGINE ====================

function computeWorkspaceSha256() {
  const hash = crypto.createHash("sha256");
  for (const fname of [...CORE_UPDATE_FILES].sort()) {
    const fpath = path.join(BASE_DIR, fname);
    if (fs.existsSync(fpath) && fs.statSync(fpath).isFile()) {
      hash.update(`${fname}:`);
      hash.update(fs.readFileSync(fpath));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

function loadLocalVersion() {
  const fallback = {
    versionId: 0,
    versionString: app.getVersion() || "1.0.7",
    sha256: computeWorkspaceSha256(),
    publishedAt: "",
    firebaseUrl: DEFAULT_FIREBASE_DB_URL
  };
  if (!fs.existsSync(VERSION_FILE)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8")) };
  } catch (_) {
    return fallback;
  }
}

function bumpSemver(verStr) {
  const parts = String(verStr || "1.0.7").split(".");
  if (parts.length !== 3) return "1.0.8";
  const patch = (parseInt(parts[2], 10) || 0) + 1;
  return `${parts[0]}.${parts[1]}.${patch}`;
}

function buildReleaseBundleNode(forceBump = false) {
  const currentSha = computeWorkspaceSha256();
  const localVer = loadLocalVersion();
  const oldSha = localVer.sha256 || "";
  const oldVid = Number(localVer.versionId || 0);

  if (!forceBump && currentSha === oldSha && fs.existsSync(RELEASE_BUNDLE_FILE)) {
    try {
      return {
        bundle: JSON.parse(fs.readFileSync(RELEASE_BUNDLE_FILE, "utf-8")),
        changed: false
      };
    } catch (_) {}
  }

  const newVid = Math.max(Date.now(), oldVid + 1);
  const newVerStr = oldVid > 0 ? bumpSemver(localVer.versionString || "1.0.7") : "1.0.7";
  const nowIso = new Date().toISOString();

  let bundleZipB64 = "";
  if (AdmZip) {
    const zip = new AdmZip();
    for (const fname of CORE_UPDATE_FILES) {
      const fpath = path.join(BASE_DIR, fname);
      if (fs.existsSync(fpath) && fs.statSync(fpath).isFile()) {
        zip.addLocalFile(fpath);
      }
    }
    bundleZipB64 = zip.toBuffer().toString("base64");
  }

  const versionManifest = {
    versionId: newVid,
    versionString: newVerStr,
    sha256: currentSha,
    publishedAt: nowIso,
    firebaseUrl: localVer.firebaseUrl || DEFAULT_FIREBASE_DB_URL
  };
  fs.writeFileSync(VERSION_FILE, JSON.stringify(versionManifest, null, 2), "utf-8");

  const releasePayload = {
    versionId: newVid,
    versionString: newVerStr,
    sha256: currentSha,
    publishedAt: nowIso,
    bundleZipB64,
    filesIncluded: CORE_UPDATE_FILES.filter((f) => fs.existsSync(path.join(BASE_DIR, f)))
  };
  fs.writeFileSync(RELEASE_BUNDLE_FILE, JSON.stringify(releasePayload, null, 2), "utf-8");

  return { bundle: releasePayload, changed: true };
}

function applyReleasePayloadNode(releasePayload) {
  if (!releasePayload || !releasePayload.bundleZipB64) return false;
  try {
    if (AdmZip) {
      const zipBuffer = Buffer.from(releasePayload.bundleZipB64, "base64");
      const zip = new AdmZip(zipBuffer);
      for (const entry of zip.getEntries()) {
        const entryName = entry.entryName;
        if (
          entryName.includes("..") ||
          entryName.startsWith("/") ||
          entryName.startsWith("data/") ||
          entryName.startsWith("uploads/")
        ) {
          continue;
        }
        zip.extractEntryTo(entry, BASE_DIR, true, true);
      }
    } else if (fs.existsSync(path.join(BASE_DIR, "updater.py"))) {
      fs.writeFileSync(RELEASE_BUNDLE_FILE, JSON.stringify(releasePayload, null, 2), "utf-8");
      execFileSync("python3", [path.join(BASE_DIR, "updater.py"), "--check-and-apply"], {
        cwd: BASE_DIR,
        timeout: 8000
      });
    }

    const versionManifest = {
      versionId: releasePayload.versionId || Date.now(),
      versionString: releasePayload.versionString || "1.0.7",
      sha256: releasePayload.sha256 || computeWorkspaceSha256(),
      publishedAt: releasePayload.publishedAt || new Date().toISOString(),
      firebaseUrl: DEFAULT_FIREBASE_DB_URL
    };
    fs.writeFileSync(VERSION_FILE, JSON.stringify(versionManifest, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.warn("[VSNR Auto-Update] Errore applicazione bundle:", err);
    return false;
  }
}

// ==================== SERVER HTTP LOCALE IN BACKGROUND ====================

function sendJson(res, data, status = 200) {
  const payload = Buffer.from(JSON.stringify(data), "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
  });
  res.end(payload);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function startBackgroundServer() {
  return new Promise((resolve, reject) => {
    const customServerPath = path.join(BASE_DIR, "server.js");
    if (fs.existsSync(customServerPath)) {
      try {
        require(customServerPath);
        return setTimeout(resolve, 350);
      } catch (err) {
        console.warn("Avvio fallback server integrato:", err);
      }
    }

    localServer = http.createServer(async (req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        });
        return res.end();
      }

      const parsedUrl = new URL(req.url, `http://${HOST}:${PORT}`);
      const pathname = parsedUrl.pathname;
      const lanIp = getLocalLanIp();

      // --- ROTTE GET ---
      if (req.method === "GET") {
        if (pathname === "/api/ping") {
          const db = loadDb();
          const googleOk = await pingGoogle8888();
          return sendJson(res, {
            ok: true,
            googlePingOk: googleOk,
            pingTarget: "8.8.8.8",
            version: db.version || 0,
            lanUrl: `http://${lanIp}:${PORT}`
          });
        }

        if (pathname === "/api/state") {
          const db = loadDb();
          return sendJson(res, {
            ok: true,
            db,
            lanUrl: `http://${lanIp}:${PORT}`
          });
        }

        if (pathname === "/api/auto-update/status") {
          const localVer = loadLocalVersion();
          let releaseBundle = null;
          if (fs.existsSync(RELEASE_BUNDLE_FILE)) {
            try {
              releaseBundle = JSON.parse(fs.readFileSync(RELEASE_BUNDLE_FILE, "utf-8"));
            } catch (_) {}
          }
          return sendJson(res, {
            ok: true,
            updated: false,
            version: localVer,
            releaseBundle
          });
        }

        // Static file serving (index.html, main.js, styles.css, ecc.)
        let relPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
        relPath = relPath.replace(/^\/+/, "");
        
        // Risoluzione dinamica dei file caricati (uploads) verso cartella sicura
        let targetFile = "";
        if (relPath.startsWith("uploads/")) {
            targetFile = path.normalize(path.join(safeUploadsPath, relPath.replace(/^uploads\//, "")));
            if (!targetFile.startsWith(safeUploadsPath)) {
                res.writeHead(403);
                return res.end("Forbidden");
            }
        } else {
            targetFile = path.normalize(path.join(BASE_DIR, relPath));
            if (!targetFile.startsWith(BASE_DIR)) {
                res.writeHead(403);
                return res.end("Forbidden");
            }
        }

        if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
          const ext = path.extname(targetFile).toLowerCase();
          const contentType = MIME_TYPES[ext] || "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
          });
          return fs.createReadStream(targetFile).pipe(res);
        }

        res.writeHead(404);
        return res.end("Not Found");
      }

      // --- ROTTE POST ---
      if (req.method === "POST") {
        try {
          const body = await readRequestBody(req);

          if (pathname === "/api/state") {
            const currentDb = loadDb();
            const allDeleted = Array.from(
              new Set([...(currentDb.deletedIds || []), ...(body.deletedIds || [])])
            ).slice(-500);
            const deletedSet = new Set(allDeleted);

            const allDismissed = Array.from(
              new Set([
                ...(currentDb.dismissedNotificationIds || []),
                ...(body.dismissedNotificationIds || [])
              ])
            ).slice(-1000);
            const dismissedSet = new Set(allDismissed);

            let mergedProfiles = currentDb.operatorProfiles;
            if (Array.isArray(body.operatorProfiles) && body.operatorProfiles.length === 4) {
              if (Array.isArray(currentDb.operatorProfiles) && currentDb.operatorProfiles.length === 4) {
                mergedProfiles = body.operatorProfiles.map((incProf, idx) => {
                  const exProf = currentDb.operatorProfiles[idx] || {};
                  return (incProf?.updatedAt || "") >= (exProf?.updatedAt || "") ? incProf : exProf;
                });
              } else {
                mergedProfiles = body.operatorProfiles;
              }
            }

            const saved = saveDb({
              operatorProfiles: mergedProfiles,
              artists: mergeCollection(currentDb.artists, body.artists, deletedSet),
              tracks: mergeCollection(currentDb.tracks, body.tracks, deletedSet),
              appointments: mergeCollection(currentDb.appointments, body.appointments, deletedSet),
              notifications: mergeCollection(currentDb.notifications, body.notifications, dismissedSet),
              dismissedNotificationIds: allDismissed,
              activityLog: mergeActivityLogs(currentDb.activityLog, body.activityLog),
              deletedIds: allDeleted
            });

            return sendJson(res, { ok: true, db: saved });
          }

          if (pathname === "/api/upload") {
            const filename = body.filename || "file.bin";
            const dataUrl = body.dataUrl || "";
            const folder = String(body.folder || "misc").replace(/[^a-zA-Z0-9_-]/g, "") || "misc";
            const b64Data = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
            const fileBuffer = Buffer.from(b64Data, "base64");
            const ext = path.extname(filename).toLowerCase() || ".bin";

            const targetDir = path.join(safeUploadsPath, folder);
            fs.mkdirSync(targetDir, { recursive: true });

            const uniqueName = `${crypto.randomUUID().replace(/-/g, "")}${ext}`;
            fs.writeFileSync(path.join(targetDir, uniqueName), fileBuffer);

            return sendJson(res, {
              ok: true,
              url: `/uploads/${folder}/${uniqueName}`,
              originalName: filename,
              size: fileBuffer.length
            });
          }

          if (pathname === "/api/auto-update/apply-bundle") {
            const releasePayload = body.releasePayload || body;
            const applied = applyReleasePayloadNode(releasePayload);
            if (applied) {
              return sendJson(res, {
                ok: true,
                versionString: releasePayload.versionString || "1.0.7",
                versionId: releasePayload.versionId || 0
              });
            }
            return sendJson(res, { ok: false, error: "Pacchetto di aggiornamento non valido" }, 400);
          }

          if (pathname === "/api/auto-update/publish") {
            const { bundle, changed } = buildReleaseBundleNode(true);
            return sendJson(res, {
              ok: true,
              changed,
              uploadedViaRest: false,
              releaseBundle: bundle
            });
          }

          return sendJson(res, { ok: false, error: "Endpoint non trovato" }, 404);
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message || String(err) }, 400);
        }
      }
    });

    localServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve();
      } else {
        reject(err);
      }
    });

    localServer.listen(PORT, "0.0.0.0", () => {
      resolve();
    });
  });
}

// ==================== FINESTRA NATIVA ELECTRON ====================

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: "VSNR — Gestionale Etichetta Discografica",
    backgroundColor: "#090b10",
    autoHideMenuBar: true,
    icon: path.join(BASE_DIR, "logo-vnsr.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(`http://${HOST}:${PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://${HOST}:${PORT}`)) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await startBackgroundServer();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (localServer) {
    try {
      localServer.close();
    } catch (_) {}
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});