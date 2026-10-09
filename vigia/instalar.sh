#!/bin/bash
# Instala o vigia pra LIGAR SOZINHO com o Mac (LaunchAgent), mesmo depois de reiniciar.
# Copia o vigia pra ~/.agcentral/vigia (fora de Documentos, onde o macOS pode bloquear
# programas em segundo plano) e registra o agente em ~/Library/LaunchAgents.
# Pra atualizar depois de mudar o código do vigia: rode este script de novo.
set -e
ORIGEM="$(cd "$(dirname "$0")" && pwd)"
DESTINO="$HOME/.agcentral/vigia"
NODE="$HOME/.local/node/bin/node"
LABEL="br.com.agcentral.vigia"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$DESTINO" "$HOME/Library/LaunchAgents"
cp "$ORIGEM/vigia.js" "$ORIGEM/treino.js" "$ORIGEM/package.json" "$ORIGEM/package-lock.json" "$DESTINO/"
rm -rf "$DESTINO/node_modules" && cp -R "$ORIGEM/node_modules" "$DESTINO/node_modules"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DESTINO/vigia.js</string></array>
  <key>WorkingDirectory</key><string>$DESTINO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$HOME/.agcentral/vigia.log</string>
  <key>StandardErrorPath</key><string>$HOME/.agcentral/vigia.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Vigia instalado e ligado. Log: $HOME/.agcentral/vigia.log"
