#!/bin/zsh
# ==============================================================================
# VNSR LABEL — DISINSTALLATORE UFFICIALE PER MACOS (COMPATIBILE CON MACOS 27)
# Rimuove l'applicazione VNSR Label, il server locale e i collegamenti.
# ==============================================================================

clear
echo "=================================================================="
echo " 🗑️  VNSR LABEL — DISINSTALLAZIONE PROGRAMMA (macOS / macOS 27)"
echo "=================================================================="
echo ""

INSTALL_DIR="$HOME/Applications/VNSR_Gestionale"
APP_BUNDLE_USER="$HOME/Applications/VNSR Label.app"
APP_BUNDLE_SYS="/Applications/VNSR Label.app"
DESKTOP_APP="$HOME/Desktop/VNSR Label.app"
DESKTOP_UNINSTALL="$HOME/Desktop/Disinstalla_VNSR_macOS.command"

echo "⏳ 1/4 Arresto di eventuali processi server VNSR attivi..."
pkill -f "VNSR_Gestionale/server.py" 2>/dev/null || true
lsof -ti:8080 | xargs kill -9 2>/dev/null || true

echo "⏳ 2/4 Rimozione applicazione e collegamenti Desktop..."
if [ -d "$APP_BUNDLE_USER" ]; then
  rm -rf "$APP_BUNDLE_USER"
  echo "   ✔ Rimosso: $APP_BUNDLE_USER"
fi

if [ -d "$APP_BUNDLE_SYS" ]; then
  rm -rf "$APP_BUNDLE_SYS" 2>/dev/null || true
  echo "   ✔ Rimosso: $APP_BUNDLE_SYS"
fi

if [ -e "$DESKTOP_APP" ] || [ -L "$DESKTOP_APP" ]; then
  rm -rf "$DESKTOP_APP"
  echo "   ✔ Rimosso collegamento Desktop: $DESKTOP_APP"
fi

echo "⏳ 3/4 Rimozione file di programma in $INSTALL_DIR..."
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "   ✔ Rimossa cartella di installazione: $INSTALL_DIR"
else
  echo "   ℹ Cartella $INSTALL_DIR già rimossa."
fi

echo "⏳ 4/4 Pulizia completata."
if [ -f "$DESKTOP_UNINSTALL" ] && [ "$0" != "$DESKTOP_UNINSTALL" ]; then
  rm -f "$DESKTOP_UNINSTALL"
fi

osascript -e 'display notification "VNSR Label è stato disinstallato correttamente dal tuo Mac." with title "VNSR Disinstallato"' 2>/dev/null || true

echo ""
echo "=================================================================="
echo " ✅ DISINSTALLAZIONE COMPLETATA CON SUCCESSO!"
echo " Tutti i file di VNSR Label sono stati rimossi dal tuo Mac."
echo "=================================================================="
echo ""
read -t 5 "?Chiusura automatica tra 5 secondi (premi Invio per chiudere subito)..." || true
exit 0
