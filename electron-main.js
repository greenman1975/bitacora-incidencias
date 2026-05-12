const { app, BrowserWindow, Menu, dialog } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

let serverProcess = null;
let mainWindow = null;

function startServer() {
  const serverPath = path.join(__dirname, 'server.js');
  serverProcess = fork(serverPath, [], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });
  serverProcess.stdout.on('data', d => console.log(d.toString()));
  serverProcess.stderr.on('data', d => console.error(d.toString()));
  return new Promise(resolve => {
    const check = setInterval(() => {
      const http = require('http');
      const req = http.get('http://localhost:3000', () => {
        clearInterval(check);
        resolve();
      });
      req.on('error', () => {});
      req.setTimeout(500, () => { req.destroy(); });
    }, 300);
    setTimeout(() => { clearInterval(check); resolve(); }, 10000);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Bitácora de Incidencias',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL('http://localhost:3000');
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createMenu() {
  const template = [
    {
      label: 'Bitácora',
      submenu: [
        { label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: () => { if (mainWindow) mainWindow.reload(); } },
        { type: 'separator' },
        { label: 'Panel Admin', accelerator: 'CmdOrCtrl+A', click: () => { if (mainWindow) mainWindow.loadURL('http://localhost:3000/admin.html'); } },
        { label: 'Reporte', accelerator: 'CmdOrCtrl+R', click: () => { if (mainWindow) mainWindow.loadURL('http://localhost:3000'); } },
        { type: 'separator' },
        { role: 'quit', label: 'Salir' }
      ]
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload', label: 'Actualizar' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  createMenu();
  await startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
  app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
});
