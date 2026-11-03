#!/usr/bin/env python3
import os
import re
import json
import time
import uuid
import socket
import base64
import subprocess
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, urljoin
import updater

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
DB_FILE = os.path.join(DATA_DIR, "db.json")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(UPLOADS_DIR, exist_ok=True)

DEFAULT_DB = {
    "version": int(time.time() * 1000),
    "artists": [],
    "tracks": [],
    "appointments": [],
    "activityLog": [],
    "deletedIds": []
}


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def ping_google_8888(timeout_sec=2.5):
    """Effettua un controllo di raggiungibilità reale verso il server Google 8.8.8.8 (TCP 53/443 + ICMP ping cross-platform Windows/macOS)."""
    try:
        with socket.create_connection(("8.8.8.8", 53), timeout=timeout_sec):
            return True
    except Exception:
        pass
    try:
        if os.name == "nt":
            cmd = ["ping", "-n", "1", "-w", "2000", "8.8.8.8"]
        else:
            ping_bin = "/sbin/ping" if os.path.exists("/sbin/ping") else "ping"
            cmd = [ping_bin, "-c", "1", "-W", "2000", "8.8.8.8"]
        res = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_sec + 1
        )
        return res.returncode == 0
    except Exception:
        return False


def load_db():
    if not os.path.exists(DB_FILE):
        save_db(DEFAULT_DB)
        return dict(DEFAULT_DB)
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if "version" not in data:
                data["version"] = int(time.time() * 1000)
            if "appointments" not in data:
                data["appointments"] = []
            if "deletedIds" not in data:
                data["deletedIds"] = []
            return data
    except Exception:
        return dict(DEFAULT_DB)


def save_db(data):
    data["version"] = int(time.time() * 1000)
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return data


def merge_collection(existing_list, incoming_list, deleted_set):
    by_id = {}
    for item in existing_list:
        item_id = item.get("id")
        if item_id and item_id not in deleted_set:
            by_id[item_id] = item

    for item in incoming_list:
        item_id = item.get("id")
        if not item_id or item_id in deleted_set:
            continue
        prev = by_id.get(item_id)
        if not prev:
            by_id[item_id] = item
        else:
            prev_ts = prev.get("updatedAt") or prev.get("createdAt") or ""
            inc_ts = item.get("updatedAt") or item.get("createdAt") or ""
            if inc_ts >= prev_ts:
                by_id[item_id] = item

    merged = list(by_id.values())
    merged.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
    return merged


def merge_activity_logs(existing_logs, incoming_logs):
    by_id = {}
    for entry in existing_logs + incoming_logs:
        eid = entry.get("id")
        if eid:
            by_id[eid] = entry
    merged = list(by_id.values())
    merged.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    return merged[:250]


# ==================== APPLE CALENDAR (iCloud CalDAV & ICS) BRIDGE ====================
def _caldav_request(url, method, email, password, body=None, depth="0", content_type="application/xml; charset=utf-8"):
    auth_str = base64.b64encode(f"{email}:{password}".encode("utf-8")).decode("ascii")
    headers = {
        "Authorization": f"Basic {auth_str}",
        "Content-Type": content_type,
        "User-Agent": "VNSR-Label-Manager/1.0"
    }
    if depth is not None:
        headers["Depth"] = str(depth)
    data = body.encode("utf-8") if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read().decode("utf-8", errors="ignore"), resp.geturl()


def discover_icloud_calendar_url(email, password):
    base_url = "https://caldav.icloud.com/"
    # 1. Discover current-user-principal
    propfind_principal = """<?xml version="1.0" encoding="utf-8"?>
    <d:propfind xmlns:d="DAV:">
      <d:prop><d:current-user-principal/></d:prop>
    </d:propfind>"""
    xml_resp, final_base = _caldav_request(base_url, "PROPFIND", email, password, propfind_principal, depth="0")
    root = ET.fromstring(xml_resp)
    principal_href = None
    for elem in root.iter():
        if elem.tag.endswith("current-user-principal"):
            for child in elem:
                if child.tag.endswith("href") and child.text:
                    principal_href = child.text.strip()
                    break
    if not principal_href:
        raise ValueError("Impossibile trovare il principal CalDAV per questo account Apple.")

    principal_url = urljoin(final_base, principal_href)

    # 2. Discover calendar-home-set
    propfind_home = """<?xml version="1.0" encoding="utf-8"?>
    <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:prop><c:calendar-home-set/></d:prop>
    </d:propfind>"""
    xml_home, final_principal = _caldav_request(principal_url, "PROPFIND", email, password, propfind_home, depth="0")
    root_home = ET.fromstring(xml_home)
    home_href = None
    for elem in root_home.iter():
        if elem.tag.endswith("calendar-home-set"):
            for child in elem:
                if child.tag.endswith("href") and child.text:
                    home_href = child.text.strip()
                    break
    if not home_href:
        raise ValueError("Impossibile trovare il calendar-home-set su iCloud.")

    home_url = urljoin(final_principal, home_href)

    # 3. List calendars in calendar-home-set
    propfind_cals = """<?xml version="1.0" encoding="utf-8"?>
    <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:prop>
        <d:displayname/>
        <d:resourcetype/>
      </d:prop>
    </d:propfind>"""
    xml_cals, final_home = _caldav_request(home_url, "PROPFIND", email, password, propfind_cals, depth="1")
    root_cals = ET.fromstring(xml_cals)

    chosen_cal_url = None
    chosen_cal_name = "Calendario Apple"

    for response_el in root_cals:
        if not response_el.tag.endswith("response"):
            continue
        href_el = None
        is_calendar = False
        is_special = False
        disp_name = ""
        for el in response_el.iter():
            if el.tag.endswith("href") and href_el is None and el.text:
                href_el = el.text.strip()
            if el.tag.endswith("calendar"):
                is_calendar = True
            if any(el.tag.endswith(x) for x in ("inbox", "outbox", "notification", "Trash")):
                is_special = True
            if el.tag.endswith("displayname") and el.text:
                disp_name = el.text.strip()
        if is_calendar and not is_special and href_el and href_el.rstrip("/") != urlparse(final_home).path.rstrip("/"):
            chosen_cal_url = urljoin(final_home, href_el)
            chosen_cal_name = disp_name or "iCloud Calendar"
            break

    if not chosen_cal_url:
        raise ValueError("Nessun calendario attivo trovato sull'account iCloud.")

    return chosen_cal_url, chosen_cal_name


def parse_ics_events(ics_text):
    events = []
    unfolded = re.sub(r"\r?\n[ \t]", "", ics_text)
    blocks = re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", unfolded, re.DOTALL)
    for b in blocks:
        uid = ""
        summary = "Appuntamento Apple Calendar"
        dtstart_raw = ""
        dtend_raw = ""
        location = ""
        description = ""
        for line in b.splitlines():
            line = line.strip()
            if not line or ":" not in line:
                continue
            key_part, val = line.split(":", 1)
            key = key_part.split(";")[0].upper()
            if key == "UID":
                uid = val.strip()
            elif key == "SUMMARY":
                summary = val.strip()
            elif key == "DTSTART":
                dtstart_raw = val.strip()
            elif key == "DTEND":
                dtend_raw = val.strip()
            elif key == "LOCATION":
                location = val.strip()
            elif key == "DESCRIPTION":
                description = val.replace("\\n", "\n").strip()

        date_str = ""
        start_time = "10:00"
        end_time = "11:00"

        m_dt = re.match(r"^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?", dtstart_raw)
        if m_dt:
            date_str = f"{m_dt.group(1)}-{m_dt.group(2)}-{m_dt.group(3)}"
            if m_dt.group(4) and m_dt.group(5):
                start_time = f"{m_dt.group(4)}:{m_dt.group(5)}"

        m_end = re.match(r"^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?", dtend_raw)
        if m_end and m_end.group(4) and m_end.group(5):
            end_time = f"{m_end.group(4)}:{m_end.group(5)}"

        if date_str:
            now_iso = datetime.utcnow().isoformat() + "Z"
            events.append({
                "id": f"appt_apple_{uid or uuid.uuid4().hex[:10]}",
                "appleUid": uid or uuid.uuid4().hex,
                "title": summary,
                "date": date_str,
                "startTime": start_time,
                "endTime": end_time,
                "category": "Apple Calendar",
                "location": location,
                "notes": description,
                "artistId": "",
                "operator": "Apple Calendar Sync",
                "source": "apple",
                "createdAt": now_iso,
                "updatedAt": now_iso
            })
    return events


def pull_events_from_apple(email, password, webcal_url=""):
    if webcal_url and not (email and password):
        http_url = re.sub(r"^webcal://", "https://", webcal_url.strip(), flags=re.IGNORECASE)
        req = urllib.request.Request(http_url, headers={"User-Agent": "VNSR-Label-Manager/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            ics_data = resp.read().decode("utf-8", errors="ignore")
        return parse_ics_events(ics_data), "Calendario Webcal Apple"

    cal_url, cal_name = discover_icloud_calendar_url(email, password)
    report_body = """<?xml version="1.0" encoding="utf-8"?>
    <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:prop>
        <d:getetag/>
        <c:calendar-data/>
      </d:prop>
      <c:filter>
        <c:comp-filter name="VCALENDAR">
          <c:comp-filter name="VEVENT"/>
        </c:comp-filter>
      </c:filter>
    </c:calendar-query>"""
    xml_events, _ = _caldav_request(cal_url, "REPORT", email, password, report_body, depth="1")
    events = parse_ics_events(xml_events)
    return events, cal_name


def push_event_to_apple(email, password, appt):
    cal_url, cal_name = discover_icloud_calendar_url(email, password)
    uid = appt.get("appleUid") or appt.get("id") or f"vnsr-{uuid.uuid4().hex}"
    date_clean = (appt.get("date") or datetime.now().strftime("%Y-%m-%d")).replace("-", "")
    st_clean = (appt.get("startTime") or "10:00").replace(":", "") + "00"
    et_clean = (appt.get("endTime") or "11:00").replace(":", "") + "00"
    dtstamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")

    title = (appt.get("title") or "Appuntamento VNSR").replace("\n", " ")
    location = (appt.get("location") or "VNSR Studio").replace("\n", " ")
    notes = (appt.get("notes") or "").replace("\n", "\\n")

    ics_payload = "\r\n".join([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//VNSR Record Label Management//IT",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"DTSTAMP:{dtstamp}",
        f"DTSTART:{date_clean}T{st_clean}",
        f"DTEND:{date_clean}T{et_clean}",
        f"SUMMARY:{title}",
        f"LOCATION:{location}",
        f"DESCRIPTION:{notes}",
        "END:VEVENT",
        "END:VCALENDAR",
        ""
    ])

    target_url = cal_url.rstrip("/") + f"/{uid}.ics"
    _caldav_request(
        target_url,
        "PUT",
        email,
        password,
        ics_payload,
        depth=None,
        content_type="text/calendar; charset=utf-8"
    )
    return uid, cal_name


class VNSRRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _send_json(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        parsed = urlparse(self.path)
        port = self.server.server_address[1]
        lan_ip = get_local_ip()

        if parsed.path == "/api/ping":
            db = load_db()
            google_ok = ping_google_8888()
            return self._send_json({
                "ok": True,
                "googlePingOk": google_ok,
                "pingTarget": "8.8.8.8",
                "version": db.get("version", 0),
                "lanUrl": f"http://{lan_ip}:{port}"
            })

        if parsed.path == "/api/state":
            db = load_db()
            return self._send_json({
                "ok": True,
                "db": db,
                "lanUrl": f"http://{lan_ip}:{port}"
            })

        if parsed.path == "/api/auto-update/status":
            try:
                # 1. Controlla prima se esiste un aggiornamento sul database da scaricare/installare
                updated, ver_str = updater.check_and_apply_update_before_launch(BASE_DIR)
                local_ver = updater.load_local_version(BASE_DIR)
                bundle_data = None
                bundle_file = os.path.join(BASE_DIR, "release_bundle.json")
                if os.path.exists(bundle_file):
                    try:
                        with open(bundle_file, "r", encoding="utf-8") as bf:
                            bundle_data = json.load(bf)
                    except Exception:
                        bundle_data = None
                return self._send_json({
                    "ok": True,
                    "updated": updated,
                    "version": local_ver,
                    "releaseBundle": bundle_data
                })
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)}, status=400)

        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length) if length > 0 else b"{}"

        if parsed.path == "/api/state":
            try:
                body = json.loads(raw_body.decode("utf-8"))
                current_db = load_db()

                incoming_deleted = set(body.get("deletedIds", []))
                existing_deleted = set(current_db.get("deletedIds", []))
                all_deleted = list(existing_deleted.union(incoming_deleted))[-500:]
                deleted_set = set(all_deleted)

                merged_artists = merge_collection(
                    current_db.get("artists", []),
                    body.get("artists", []),
                    deleted_set
                )
                merged_tracks = merge_collection(
                    current_db.get("tracks", []),
                    body.get("tracks", []),
                    deleted_set
                )
                merged_appointments = merge_collection(
                    current_db.get("appointments", []),
                    body.get("appointments", []),
                    deleted_set
                )
                merged_logs = merge_activity_logs(
                    current_db.get("activityLog", []),
                    body.get("activityLog", [])
                )

                incoming_profiles = body.get("operatorProfiles")
                existing_profiles = current_db.get("operatorProfiles")
                merged_profiles = existing_profiles
                if isinstance(incoming_profiles, list) and len(incoming_profiles) == 4:
                    if isinstance(existing_profiles, list) and len(existing_profiles) == 4:
                        merged_profiles = []
                        for idx in range(4):
                            ep = existing_profiles[idx] or {}
                            ip = incoming_profiles[idx] or {}
                            if (ip.get("updatedAt") or "") >= (ep.get("updatedAt") or ""):
                                merged_profiles.append(ip)
                            else:
                                merged_profiles.append(ep)
                    else:
                        merged_profiles = incoming_profiles

                incoming_dismissed = set(body.get("dismissedNotificationIds", []))
                existing_dismissed = set(current_db.get("dismissedNotificationIds", []))
                all_dismissed = list(existing_dismissed.union(incoming_dismissed))[-1000:]
                dismissed_set = set(all_dismissed)

                merged_notifications = merge_collection(
                    current_db.get("notifications", []),
                    body.get("notifications", []),
                    dismissed_set
                )

                new_db = {
                    "operatorProfiles": merged_profiles,
                    "artists": merged_artists,
                    "tracks": merged_tracks,
                    "appointments": merged_appointments,
                    "notifications": merged_notifications,
                    "dismissedNotificationIds": all_dismissed,
                    "activityLog": merged_logs,
                    "deletedIds": all_deleted
                }
                saved = save_db(new_db)
                return self._send_json({"ok": True, "db": saved})
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)}, status=400)

        if parsed.path == "/api/apple-calendar/sync":
            try:
                body = json.loads(raw_body.decode("utf-8"))
                email = (body.get("email") or "").strip()
                password = (body.get("password") or "").strip()
                webcal_url = (body.get("webcalUrl") or "").strip()

                events, cal_name = pull_events_from_apple(email, password, webcal_url)
                return self._send_json({
                    "ok": True,
                    "calendarName": cal_name,
                    "events": events
                })
            except urllib.error.HTTPError as he:
                msg = f"Autenticazione Apple CalDAV fallita (HTTP {he.code}). Assicurati di usare la Password Specifica per App di iCloud (generabile su account.apple.com)."
                return self._send_json({"ok": False, "error": msg}, status=400)
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)}, status=400)

        if parsed.path == "/api/apple-calendar/upload-event":
            try:
                body = json.loads(raw_body.decode("utf-8"))
                email = (body.get("email") or "").strip()
                password = (body.get("password") or "").strip()
                appointment = body.get("appointment") or {}

                if not email or not password:
                    return self._send_json({
                        "ok": False,
                        "error": "Credenziali Apple ID (Email + Password per App) necessarie per la scrittura in upload su iCloud Calendar."
                    }, status=400)

                uid, cal_name = push_event_to_apple(email, password, appointment)
                return self._send_json({
                    "ok": True,
                    "appleUid": uid,
                    "calendarName": cal_name
                })
            except urllib.error.HTTPError as he:
                msg = f"Errore upload su Apple Calendar (HTTP {he.code}). Verifica Email e Password per App iCloud."
                return self._send_json({"ok": False, "error": msg}, status=400)
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)}, status=400)

        if parsed.path == "/api/upload":
            try:
                body = json.loads(raw_body.decode("utf-8"))
                filename = body.get("filename", "file.bin")
                data_url = body.get("dataUrl", "")
                folder = body.get("folder", "misc")

                if "," in data_url:
                    _, b64data = data_url.split(",", 1)
                else:
                    b64data = data_url

                file_bytes = base64.b64decode(b64data)
                ext = os.path.splitext(filename)[1].lower() or ".bin"
                safe_folder = "".join(c for c in folder if c.isalnum() or c in ("-", "_")) or "misc"
                target_dir = os.path.join(UPLOADS_DIR, safe_folder)
                os.makedirs(target_dir, exist_ok=True)

                unique_name = f"{uuid.uuid4().hex}{ext}"
                file_path = os.path.join(target_dir, unique_name)
                with open(file_path, "wb") as f:
                    f.write(file_bytes)

                rel_url = f"/uploads/{safe_folder}/{unique_name}"
                return self._send_json({
                    "ok": True,
                    "url": rel_url,
                    "originalName": filename,
                    "size": len(file_bytes)
                })
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)}, status=400)

        if parsed.path == "/api/auto-update/apply-bundle":
            try:
                body = json.loads(raw_body.decode("utf-8"))
                release_payload = body.get("releasePayload") or body
                applied = updater.apply_release_payload_to_directory(release_payload, BASE_DIR)
                if applied:
                    return self._send_json({
                        "ok": True,
                        "versionString": release_payload.get("versionString", "2.8.0"),
                        "versionId": release_payload.get("versionId", 0)
                    })
                return self._send_json({"ok": False, "error": "Pacchetto di aggiornamento non valido"}, status=400)
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)}, status=400)

        if parsed.path == "/api/auto-update/publish":
            try:
                bundle, changed = updater.build_release_bundle(BASE_DIR, force_bump=True)
                uploaded = updater.upload_release_to_database(bundle)
                return self._send_json({
                    "ok": True,
                    "changed": changed,
                    "uploadedViaRest": uploaded,
                    "releaseBundle": bundle
                })
            except Exception as e:
                return self._send_json({"ok": False, "error": str(e)}, status=400)

        return self._send_json({"ok": False, "error": "Endpoint non trovato"}, status=404)


if __name__ == "__main__":
    import webbrowser
    import threading

    os.chdir(BASE_DIR)

    # ==========================================================================
    # CONTROLLO E INSTALLAZIONE AUTOMATICA AGGIORNAMENTI PRIMA DELL'APERTURA
    # ==========================================================================
    print("🔄 [VNSR Auto-Updater] Verifica nuovi aggiornamenti sul database in corso...")
    try:
        was_updated, active_ver = updater.check_and_apply_update_before_launch(BASE_DIR)
        if was_updated:
            print(f"✅ [VNSR Auto-Updater] Nuova versione ({active_ver}) scaricata e installata automaticamente!")
        else:
            print(f"✅ [VNSR Auto-Updater] Versione attuale verificata ({active_ver}). Avvio del gestionale...")
    except Exception as e:
        print(f"ℹ️ [VNSR Auto-Updater] Avvio con versione locale ({e})")

    port = int(os.environ.get("PORT", 8080))
    lan_ip = get_local_ip()
    server = ThreadingHTTPServer(("0.0.0.0", port), VNSRRequestHandler)
    print("============================================================")
    print(" 💿 VNSR — GESTIONALE ETICHETTA DISCOGRAFICA (MULTI-DEVICE)")
    print(f" 💻 Su questo computer:      http://127.0.0.1:{port}")
    print(f" 📱 Sugli altri dispositivi: http://{lan_ip}:{port}")
    print("============================================================")
    if os.environ.get("VNSR_OPEN_BROWSER", "0") == "1":
        threading.Timer(0.8, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nChiusura server VNSR in corso...")
        server.server_close()
