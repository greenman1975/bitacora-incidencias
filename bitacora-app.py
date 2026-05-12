#!/usr/bin/env python3
# Bitácora de Incidencias - Aplicación de Escritorio Nativa

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Notify', '0.7')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib, Notify
import subprocess, os, signal, sys, time, threading, json
from urllib.request import urlopen

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_SCRIPT = os.path.join(SERVER_DIR, "server.js")
server_proc = None

def is_server_running():
    try:
        with urlopen("http://127.0.0.1:3000/api/server-info", timeout=1) as response:
            return response.getcode() == 200
    except:
        return False

def start_server():
    global server_proc
    if is_server_running():
        return True
    try:
        server_proc = subprocess.Popen(["node", SERVER_SCRIPT], cwd=SERVER_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(10):
            time.sleep(0.5)
            if is_server_running(): return True
        return False
    except: return False

def stop_server():
    global server_proc
    if server_proc:
        server_proc.terminate()
        server_proc = None

class BitacoraApp:
    def __init__(self):
        Notify.init("Bitácora")
        self.window = Gtk.Window(title="Bitácora de Incidencias")
        self.window.set_default_size(1000, 700)
        self.window.connect("destroy", self.on_destroy)

        header = Gtk.HeaderBar(title="Bitácora de Incidencias", show_close_button=True)
        self.window.set_titlebar(header)

        btn_refresh = Gtk.Button()
        btn_refresh.set_image(Gtk.Image.new_from_icon_name("view-refresh-symbolic", Gtk.IconSize.BUTTON))
        btn_refresh.connect("clicked", lambda x: self.webview.reload())
        header.pack_start(btn_refresh)

        self.btn_toggle = Gtk.Button(label="📋 Historial")
        self.btn_toggle.connect("clicked", self.on_toggle)
        header.pack_start(self.btn_toggle)

        self.webview = WebKit2.WebView()
        self.webview.load_uri("http://localhost:3000")
        self.is_admin = False

        scroll = Gtk.ScrolledWindow()
        scroll.add(self.webview)
        self.window.add(scroll)

    def on_toggle(self, btn):
        self.is_admin = not self.is_admin
        uri = "http://localhost:3000/admin.html" if self.is_admin else "http://localhost:3000"
        self.webview.load_uri(uri)
        self.btn_toggle.set_label("📋 Reporte" if self.is_admin else "📋 Historial")

    def on_destroy(self, window):
        stop_server()
        Gtk.main_quit()

    def run(self):
        self.window.show_all()
        Gtk.main()

if __name__ == "__main__":
    start_server()
    app = BitacoraApp()
    app.run()
