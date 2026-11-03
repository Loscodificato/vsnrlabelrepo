#!/usr/bin/env python3
"""
Script di test di Scrittura e Lettura su Firebase Realtime Database per il gestionale VNSR.
URL Database: https://vsnr-management-default-rtdb.europe-west1.firebasedatabase.app
"""
import json
import time
import urllib.request

FIREBASE_DB_URL = "https://vsnr-management-default-rtdb.europe-west1.firebasedatabase.app"
TEST_NODE_URL = f"{FIREBASE_DB_URL}/vnsr_test_connection.json"


def test_firebase_read_write():
    payload = {
        "progetto": "VNSR Gestionale Etichetta Discografica",
        "stato": "Connesso",
        "messaggio": "Operazione di scrittura e lettura di prova completata!",
        "timestamp": int(time.time() * 1000)
    }

    print(f"1️⃣ Scrittura dati di prova su: {TEST_NODE_URL}")
    data_bytes = json.dumps(payload).encode("utf-8")
    put_req = urllib.request.Request(
        TEST_NODE_URL,
        data=data_bytes,
        headers={"Content-Type": "application/json"},
        method="PUT"
    )
    with urllib.request.urlopen(put_req, timeout=10) as response:
        write_result = json.loads(response.read().decode("utf-8"))
        print("✅ Scrittura completata:", json.dumps(write_result, indent=2, ensure_ascii=False))

    print(f"\n2️⃣ Lettura dati da: {TEST_NODE_URL}")
    get_req = urllib.request.Request(TEST_NODE_URL, method="GET")
    with urllib.request.urlopen(get_req, timeout=10) as response:
        read_result = json.loads(response.read().decode("utf-8"))
        print("✅ Dati letti da Firebase:", json.dumps(read_result, indent=2, ensure_ascii=False))

    return read_result


if __name__ == "__main__":
    test_firebase_read_write()
