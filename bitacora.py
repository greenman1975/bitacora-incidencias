#!/usr/bin/env python3
# Bitácora de Incidencias - Lanzador de Escritorio
# Abre el servidor y una ventana nativa con la bitácora

import subprocess, os, signal, sys, time, webbrowser

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_SCRIPT = os.path.join(SERVER_DIR, "server.js")
PID_FILE = os.path.join(SERVER_DIR, ".bitacora.pid")

def is_running():
    if os.path.exists(PID_FILE):
        with open(PID_FILE) as f:
            try:
                pid = int(f.read().strip())
                os.kill(pid, 0)
                return True
            except: pass
    return False

def start_server():
    if is_running(): return True
    try:
        proc = subprocess.Popen(["node", SERVER_SCRIPT], cwd=SERVER_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(PID_FILE, "w") as f: f.write(str(proc.pid))
        time.sleep(2)
        return True
    except: return False

def stop_server():
    if os.path.exists(PID_FILE):
        with open(PID_FILE) as f:
            try:
                pid = int(f.read().strip())
                os.kill(pid, signal.SIGTERM)
            except: pass
        os.remove(PID_FILE)

if __name__ == "__main__":
    if start_server():
        webbrowser.open("http://localhost:3000")
        print("✅ Bitácora abierta en el navegador")
        print("   Presiona Ctrl+C para cerrar el servidor")
        try:
            while True: time.sleep(1)
        except KeyboardInterrupt:
            stop_server()
            print("Servidor detenido")
    else:
        print("❌ Error al iniciar el servidor")
        sys.exit(1)
