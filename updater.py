#!/usr/bin/env python3
"""
VNSR LABEL — SOFTWARE DI AGGIORNAMENTO AUTOMATICO E PUBBLICAZIONE DATABASE
==========================================================================
1. Modalità Pubblicazione (--publish):
   Impacchetta tutti i file aggiornati del gestionale VNSR, calcola l'hash SHA-256,
   incrementa la versione in version.json, salva release_bundle.json e carica
   automaticamente la nuova versione sul database Firebase Realtime Database
   (nodo /vnsr_app_release).

2. Modalità Auto-Update Pre-Apertura (--check-and-apply):
   Eseguita AUTOMATICAMENTE prima dell'apertura del gestionale (sia su macOS che su Windows).
   Controlla se sul database (o nel repository sorgente) è presente una nuova versione.
   Se rileva un aggiornamento, scarica e installa automaticamente i nuovi file
   senza richiedere alcun passaggio all'utente, preservando i dati (data/ e uploads/).
"""

import os
import sys
import io
import json
import time
import base64
import hashlib
import zipfile
import ssl
import urllib.request
import urllib.error
from datetime import datetime

SSL_CTX = ssl.create_default_context()
try:
    SSL_UNVERIFIED_CTX = ssl._create_unverified_context()
except Exception:
    SSL_UNVERIFIED_CTX = SSL_CTX


def urlopen_safe(req, timeout=5):
    try:
        return urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX)
    except Exception:
        return urllib.request.urlopen(req, timeout=timeout, context=SSL_UNVERIFIED_CTX)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FIREBASE_DB_URL = "https://vsnr-management-default-rtdb.europe-west1.firebasedatabase.app"
RELEASE_NODE_PATH = "/vnsr_app_release.json"
META_NODE_PATH = "/vnsr_app_release_meta.json"

VERSION_FILE = os.path.join(BASE_DIR, "version.json")
RELEASE_BUNDLE_FILE = os.path.join(BASE_DIR, "release_bundle.json")

# Percorso sorgente principale (per sincronizzazione diretta se sullo stesso computer di sviluppo)
DEV_SOURCE_DIR = "/Users/davidebilardi/.gemini/antigravity/scratch/etichetta-gestionale"

CORE_UPDATE_FILES = [
    "index.html",
    "styles.css",
    "main.js",
    "auth.js",
    "artists.js",
    "tracks.js",
    "calendar.js",
    "settings.js",
    "app.js",
    "server.py",
    "updater.py",
    "contract-template-data.js",
    "contratto-template-vnsr.pdf",
    "logo-vnsr.png",
    "logo-vnsr-wide.png",
    "Avvia_Gestionale.command"
]


def compute_workspace_sha256(directory=BASE_DIR):
    """Calcola l'impronta SHA-256 combinata dei file del programma per rilevare ogni modifica."""
    hasher = hashlib.sha256()
    for fname in [
        "index.html",
        "styles.css",
        "main.js",
        "auth.js",
        "artists.js",
        "tracks.js",
        "calendar.js",
        "settings.js",
        "app.js",
        "server.py",
        "updater.py",
        "logo-vnsr.png",
        "logo-vnsr-wide.png"
    ]:
        fpath = os.path.join(directory, fname)
        if os.path.exists(fpath):
            hasher.update(fname.encode("utf-8"))
            with open(fpath, "rb") as f:
                hasher.update(f.read())
    return hasher.hexdigest()


def load_local_version(directory=BASE_DIR):
    vfile = os.path.join(directory, "version.json")
    if os.path.exists(vfile):
        try:
            with open(vfile, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "versionId": 0,
        "versionString": "1.0.1",
        "sha256": "",
        "publishedAt": "",
        "firebaseUrl": DEFAULT_FIREBASE_DB_URL
    }


def bump_semver(ver_str):
    parts = (ver_str or "1.0.0").split(".")
    try:
        major = int(parts[0])
        minor = int(parts[1]) if len(parts) > 1 else 0
        patch = int(parts[2]) + 1 if len(parts) > 2 else 1
        return f"{major}.{minor}.{patch}"
    except Exception:
        return "1.0.1"


def build_release_bundle(directory=BASE_DIR, force_bump=False, explicit_version=None):
    """Costruisce il pacchetto di aggiornamento completo pronto per l'upload sul database."""
    current_ver = load_local_version(directory)
    current_sha = compute_workspace_sha256(directory)

    if not force_bump and not explicit_version and current_ver.get("sha256") == current_sha and os.path.exists(RELEASE_BUNDLE_FILE):
        try:
            with open(RELEASE_BUNDLE_FILE, "r", encoding="utf-8") as f:
                existing_bundle = json.load(f)
                if existing_bundle.get("sha256") == current_sha:
                    return existing_bundle, False
        except Exception:
            pass

    new_version_id = int(time.time() * 1000)
    if explicit_version:
        new_version_str = explicit_version
    else:
        new_version_str = bump_semver(current_ver.get("versionString", "0.0.0"))
    now_iso = datetime.utcnow().isoformat() + "Z"

    version_manifest = {
        "versionId": new_version_id,
        "versionString": new_version_str,
        "sha256": current_sha,
        "publishedAt": now_iso,
        "firebaseUrl": current_ver.get("firebaseUrl") or DEFAULT_FIREBASE_DB_URL
    }

    with open(os.path.join(directory, "version.json"), "w", encoding="utf-8") as f:
        json.dump(version_manifest, f, ensure_ascii=False, indent=2)

    # Crea archivio ZIP compresso in memoria con tutti i file core + version.json
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for fname in CORE_UPDATE_FILES + ["version.json"]:
            fpath = os.path.join(directory, fname)
            if os.path.exists(fpath):
                zf.write(fpath, arcname=fname)

    bundle_b64 = base64.b64encode(zip_buffer.getvalue()).decode("ascii")

    release_payload = {
        "versionId": new_version_id,
        "versionString": new_version_str,
        "sha256": current_sha,
        "publishedAt": now_iso,
        "bundleZipB64": bundle_b64
    }

    with open(os.path.join(directory, "release_bundle.json"), "w", encoding="utf-8") as f:
        json.dump(release_payload, f, ensure_ascii=False, indent=2)

    return release_payload, True


def get_firebase_auth_token(timeout_sec=5):
    """Ottiene un idToken Firebase Auth valido per server@vnsr.it per accedere al DB blindato con auth.uid."""
    api_key = "AIzaSyAzl2DTe2vcMFtFTSGWyMVD3rQwdxgbwYM"
    payload = {
        "email": "server@vnsr.it",
        "password": "VnsrSicurezza2026!",
        "returnSecureToken": True
    }
    for endpoint in ["accounts:signInWithPassword", "accounts:signUp"]:
        auth_url = f"https://identitytoolkit.googleapis.com/v1/{endpoint}?key={api_key}"
        try:
            req = urllib.request.Request(
                auth_url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urlopen_safe(req, timeout=timeout_sec) as resp:
                if 200 <= resp.status < 300:
                    data = json.loads(resp.read().decode("utf-8"))
                    token = data.get("idToken", "")
                    if token:
                        return token
        except Exception:
            continue
    return ""


def upload_release_to_database(release_payload, firebase_url=DEFAULT_FIREBASE_DB_URL, timeout_sec=8):
    """Carica la nuova versione e il relativo pacchetto sul database Firebase Realtime Database."""
    clean_base = (firebase_url or DEFAULT_FIREBASE_DB_URL).rstrip("/")
    if "console.firebase.google.com" in clean_base or not clean_base:
        clean_base = DEFAULT_FIREBASE_DB_URL

    meta_payload = {
        "versionId": release_payload["versionId"],
        "versionString": release_payload["versionString"],
        "sha256": release_payload["sha256"],
        "publishedAt": release_payload["publishedAt"]
    }

    id_token = get_firebase_auth_token(timeout_sec=5)
    auth_query = f"?auth={id_token}" if id_token else ""

    uploaded_remote = False
    for meta_path, rel_path in [
        (META_NODE_PATH, RELEASE_NODE_PATH),
        ("/vnsr_state/vnsr_app_release_meta.json", "/vnsr_state/vnsr_app_release.json")
    ]:
        try:
            meta_req = urllib.request.Request(
                f"{clean_base}{meta_path}{auth_query}",
                data=json.dumps(meta_payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="PUT"
            )
            with urlopen_safe(meta_req, timeout=timeout_sec) as resp:
                if 200 <= resp.status < 300:
                    uploaded_remote = True

            bundle_req = urllib.request.Request(
                f"{clean_base}{rel_path}{auth_query}",
                data=json.dumps(release_payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="PUT"
            )
            with urlopen_safe(bundle_req, timeout=timeout_sec + 4) as resp:
                if 200 <= resp.status < 300:
                    uploaded_remote = True
            if uploaded_remote:
                break
        except Exception:
            continue

    return uploaded_remote


def apply_release_payload_to_directory(release_payload, target_dir=BASE_DIR):
    """Estrae e installa automaticamente il pacchetto di aggiornamento nella cartella del programma."""
    if not release_payload or not release_payload.get("bundleZipB64"):
        return False

    try:
        zip_bytes = base64.b64decode(release_payload["bundleZipB64"])
        with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
            for member in zf.namelist():
                # Sicurezza: evita path traversal e non sovrascrivere mai data/ o uploads/
                if ".." in member or member.startswith("/") or member.startswith("data/") or member.startswith("uploads/"):
                    continue
                zf.extract(member, path=target_dir)

        # Salva anche version.json aggiornato
        version_manifest = {
            "versionId": release_payload.get("versionId", int(time.time() * 1000)),
            "versionString": release_payload.get("versionString", "2.8.0"),
            "sha256": release_payload.get("sha256", ""),
            "publishedAt": release_payload.get("publishedAt", datetime.utcnow().isoformat() + "Z"),
            "firebaseUrl": DEFAULT_FIREBASE_DB_URL
        }
        with open(os.path.join(target_dir, "version.json"), "w", encoding="utf-8") as f:
            json.dump(version_manifest, f, ensure_ascii=False, indent=2)

        # Assicura permessi di esecuzione su macOS/Linux
        if os.name != "nt":
            for exec_name in ["server.py", "updater.py", "Avvia_Gestionale.command"]:
                epath = os.path.join(target_dir, exec_name)
                if os.path.exists(epath):
                    try:
                        os.chmod(epath, 0o755)
                    except Exception:
                        pass
        return True
    except Exception as e:
        print(f"[VNSR Auto-Updater] Errore durante l'installazione dell'aggiornamento: {e}")
        return False


def check_and_apply_update_before_launch(target_dir=BASE_DIR, timeout_sec=3.5):
    """
    Controlla automaticamente PRIMA dell'apertura del gestionale se esiste una nuova versione
    sul database Firebase (o nella cartella di sviluppo) e la scarica/installa senza chiedere conferme.
    """
    local_ver = load_local_version(target_dir)
    disk_sha = compute_workspace_sha256(target_dir)
    missing_core = any(
        not os.path.exists(os.path.join(target_dir, fname))
        for fname in ["main.js", "auth.js", "artists.js", "tracks.js", "calendar.js", "settings.js"]
    )
    local_sha = "" if missing_core else disk_sha
    local_vid = 0 if missing_core else int(local_ver.get("versionId") or 0)

    clean_base = (local_ver.get("firebaseUrl") or DEFAULT_FIREBASE_DB_URL).rstrip("/")
    if "console.firebase.google.com" in clean_base or not clean_base:
        clean_base = DEFAULT_FIREBASE_DB_URL

    # 1. Controlla il database remoto Firebase Realtime Database
    id_token = get_firebase_auth_token(timeout_sec=timeout_sec)
    auth_query = f"?auth={id_token}" if id_token else ""
    for meta_path, rel_path in [
        (META_NODE_PATH, RELEASE_NODE_PATH),
        ("/vnsr_state/vnsr_app_release_meta.json", "/vnsr_state/vnsr_app_release.json")
    ]:
        try:
            meta_url = f"{clean_base}{meta_path}{auth_query}"
            req = urllib.request.Request(meta_url, headers={"Cache-Control": "no-cache"}, method="GET")
            with urlopen_safe(req, timeout=timeout_sec) as resp:
                if resp.status == 200:
                    remote_meta = json.loads(resp.read().decode("utf-8"))
                    if isinstance(remote_meta, dict):
                        remote_vid = int(remote_meta.get("versionId") or 0)
                        remote_sha = remote_meta.get("sha256") or ""
                        if (remote_vid > local_vid and remote_sha != local_sha) or (remote_sha and remote_sha != local_sha and remote_vid >= local_vid):
                            print(f"⬇️ [VNSR Auto-Updater] Nuova versione {remote_meta.get('versionString')} rilevata sul database! Download e installazione automatica in corso...")
                            bundle_req = urllib.request.Request(
                                f"{clean_base}{rel_path}{auth_query}",
                                headers={"Cache-Control": "no-cache"},
                                method="GET"
                            )
                            with urlopen_safe(bundle_req, timeout=timeout_sec + 5) as bresp:
                                if bresp.status == 200:
                                    bundle_data = json.loads(bresp.read().decode("utf-8"))
                                    if apply_release_payload_to_directory(bundle_data, target_dir):
                                        print(f"✅ [VNSR Auto-Updater] Aggiornamento alla versione {bundle_data.get('versionString')} installato automaticamente!")
                                        return True, bundle_data.get("versionString")
        except Exception:
            continue

    # 2. Fallback: se non ancora alcanzabile via REST o su macchina locale, controlla il bundle sorgente
    if os.path.abspath(target_dir) != os.path.abspath(DEV_SOURCE_DIR) and os.path.exists(DEV_SOURCE_DIR):
        dev_bundle_path = os.path.join(DEV_SOURCE_DIR, "release_bundle.json")
        if os.path.exists(dev_bundle_path):
            try:
                with open(dev_bundle_path, "r", encoding="utf-8") as f:
                    dev_bundle = json.load(f)
                dev_vid = int(dev_bundle.get("versionId") or 0)
                dev_sha = dev_bundle.get("sha256") or ""
                if dev_sha and dev_sha != local_sha and dev_vid >= local_vid:
                    print(f"⬇️ [VNSR Auto-Updater] Nuova versione {dev_bundle.get('versionString')} rilevata! Installazione automatica in corso...")
                    if apply_release_payload_to_directory(dev_bundle, target_dir):
                        print(f"✅ [VNSR Auto-Updater] Aggiornamento alla versione {dev_bundle.get('versionString')} installato automaticamente!")
                        return True, dev_bundle.get("versionString")
            except Exception:
                pass

    return False, local_ver.get("versionString", "2.8.0")


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--publish" in args:
        force = "--force" in args
        bundle, changed = build_release_bundle(BASE_DIR, force_bump=force)
        uploaded = upload_release_to_database(bundle)
        status_db = "Caricato su Firebase Database" if uploaded else "Salvato in release_bundle.json (pronto per sync automatico Firebase SDK)"
        print(f"✅ [VNSR Publisher] Versione {bundle['versionString']} (ID: {bundle['versionId']}, SHA-256: {bundle['sha256'][:12]}...) — {status_db}")
    else:
        updated, ver = check_and_apply_update_before_launch(BASE_DIR)
        if updated:
            print(f"✅ [VNSR Auto-Updater] Programma aggiornato automaticamente alla versione {ver}.")
        else:
            print(f"ℹ️ [VNSR Auto-Updater] Il programma è già aggiornato all'ultima versione ({ver}).")
