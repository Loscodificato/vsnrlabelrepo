#!/bin/zsh
cd "$(dirname "$0")"
# Controlla e installa automaticamente eventuali nuovi aggiornamenti dal database SOLO PRIMA dell'apertura del gestionale
/usr/bin/python3 updater.py --check-and-apply 2>/dev/null || python3 updater.py --check-and-apply 2>/dev/null || true
(sleep 1 && open "http://127.0.0.1:8080") &
/usr/bin/python3 server.py || python3 server.py
