#!/bin/bash
# Bitácora de Incidencias - Iniciar servidor y abrir navegador
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Matar servidor anterior si existe
kill $(lsof -ti:3000) 2>/dev/null

# Iniciar servidor
node server.js &
SERVER_PID=$!

# Esperar a que esté listo
sleep 2

# Abrir navegador
xdg-open http://localhost:3000 2>/dev/null || true

# Esperar y limpiar al cerrar
trap "kill $SERVER_PID 2>/dev/null; exit" INT TERM
wait $SERVER_PID
