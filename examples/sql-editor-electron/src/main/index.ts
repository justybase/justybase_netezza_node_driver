import { app, dialog, shell, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { registerIpc } from './ipc';
import { disconnect } from './db';

const isDev = !app.isPackaged;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#020617',
    title: 'Netezza SQL Editor',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // The renderer uses beforeunload to protect unsaved SQL. Electron silently
  // cancels the close when that handler prevents unload, so give the user an
  // explicit choice and allow the unload only after they choose to discard.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Unsaved SQL changes',
      message: 'There are unsaved SQL changes.',
      detail: 'Do you want to discard them and close the editor?',
      buttons: ['Discard changes', 'Keep editing'],
      defaultId: 1,
      cancelId: 1
    });

    if (choice === 0) {
      // Electron's will-prevent-unload event is inverted: preventing this
      // event ignores the renderer's beforeunload veto and permits closing.
      event.preventDefault();
    }
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void disconnect();
});
