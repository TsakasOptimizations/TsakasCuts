const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const { buildArgs } = require('./export');
// ffmpeg ships with the app so friends don't need it installed; asar can't hold executables
const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

let win;
const PROJECT = [{ name: 'TsakasCuts project', extensions: ['tcut', 'valo'] }];
const thumbDir = path.join(app.getPath('temp'), 'tsakascuts-thumbs');
app.setAppUserModelId('com.tsakas.tsakascuts'); // own taskbar identity + icon
nativeTheme.themeSource = 'dark'; // dark title bar, dialogs and menus
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1500, height: 940, backgroundColor: '#0f1923', autoHideMenuBar: true, title: 'TsakasCuts', icon: path.join(__dirname, 'icon.ico'),
    // webSecurity off so Web Audio can boost local files above 0 dB in preview; the app loads no remote content
    webPreferences: { preload: path.join(__dirname, 'preload.js'), webSecurity: false },
  });
  win.loadFile('index.html');
  // renderer blocks unload when there are unsaved changes; ask before throwing them away
  win.webContents.on('will-prevent-unload', e => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Close without saving', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'You have unsaved changes.',
    });
    if (choice === 0) e.preventDefault();
  });
});
app.on('window-all-closed', () => app.quit());

ipcMain.handle('saveProject', async (_, file, data) => {
  if (!file) {
    const r = await dialog.showSaveDialog(win, { defaultPath: 'montage.tcut', filters: PROJECT });
    if (r.canceled) return null;
    file = r.filePath;
  }
  fs.writeFileSync(file, data);
  return file;
});
ipcMain.handle('openProject', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: PROJECT });
  if (r.canceled) return null;
  return { path: r.filePaths[0], data: fs.readFileSync(r.filePaths[0], 'utf8') };
});

// one filmstrip jpg per source file: n frames tiled side by side, keyframes only so it's fast
ipcMain.handle('thumbs', async (_, file, duration) => {
  const n = Math.min(100, Math.max(1, Math.ceil(duration)));
  const key = crypto.createHash('md5').update(file + fs.statSync(file).mtimeMs).digest('hex');
  const out = path.join(thumbDir, key + '.jpg');
  if (!fs.existsSync(out)) {
    fs.mkdirSync(thumbDir, { recursive: true });
    await new Promise((resolve, reject) => execFile(ffmpeg, ['-v', 'error', '-y', '-skip_frame', 'nokey', '-i', file,
      '-vf', `fps=${n}/${duration},scale=-2:76,tile=${n}x1`, '-frames:v', '1', '-q:v', '4', out],
      err => err ? reject(err) : resolve()));
  }
  return { url: pathToFileURL(out).href, n };
});

// `ffmpeg -i file` with no output prints stream info to stderr (and exits non-zero, expected);
// saves shipping ffprobe too. Unreadable files and images (no duration) resolve to null
function probe(file) {
  return new Promise(resolve => execFile(ffmpeg, ['-hide_banner', '-i', file], (_, __, info) => {
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
    const duration = d ? d[1] * 3600 + d[2] * 60 + +d[3] : 0;
    resolve(duration > 0.1 ? {
      path: file, url: pathToFileURL(file).href, name: path.basename(file), duration,
      hasAudio: /Stream #.*: Audio:/.test(info),
    } : null);
  }));
}
const probeAll = files => Promise.all(files.map(probe)).then(a => a.filter(Boolean));

ipcMain.handle('open', async (_, kind) => {
  const music = kind === 'music';
  const r = await dialog.showOpenDialog(win, {
    properties: music ? ['openFile'] : ['openFile', 'multiSelections'],
    filters: music ? [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'ogg'] }]
      : [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }],
  });
  return probeAll(r.filePaths);
});
ipcMain.handle('probe', (_, files) => probeAll(files));

// encode one tiny frame with NVENC once; fails fast on PCs without an NVIDIA GPU/driver
let hasNvenc;
const nvenc = () => hasNvenc ??= new Promise(resolve => execFile(ffmpeg,
  ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.1', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'],
  err => resolve(!err)));

ipcMain.handle('export', async (_, project) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: 'montage.mp4', filters: [{ name: 'MP4', extensions: ['mp4'] }] });
  if (r.canceled) return null;
  const gpu = await nvenc();
  win.webContents.send('encoder', gpu ? 'GPU' : 'CPU');
  const { args, total } = buildArgs(project, r.filePath, gpu);
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args);
    let log = '';
    p.stdout.on('data', d => {
      const m = /out_time_us=(\d+)/.exec(d);
      if (m) win.webContents.send('progress', Math.min(1, m[1] / 1e6 / total));
    });
    p.stderr.on('data', d => { log = (log + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(log));
      shell.showItemInFolder(r.filePath);
      resolve(r.filePath);
    });
  });
});

// updates come from GitHub Releases (see "publish" in package.json); we ask before downloading/installing
autoUpdater.autoDownload = false;
ipcMain.handle('version', () => app.getVersion());
ipcMain.handle('checkUpdates', async () => {
  const info = msg => dialog.showMessageBox(win, { type: 'info', message: msg });
  if (!app.isPackaged) return info('Updates only work in the installed app.');
  let r;
  try { r = await autoUpdater.checkForUpdates(); } catch (e) { return info('Could not check for updates:\n' + e.message.split('\n')[0]); }
  const v = r?.updateInfo.version;
  if (!r?.isUpdateAvailable) return info(`You're on the latest version (${app.getVersion()}).`);
  const go = await dialog.showMessageBox(win, { type: 'question', buttons: ['Download', 'Later'], message: `Version ${v} is available. Download it now?` });
  if (go.response !== 0) return;
  autoUpdater.on('download-progress', p => win.webContents.send('progress', p.percent / 100));
  await autoUpdater.downloadUpdate();
  const restart = await dialog.showMessageBox(win, { type: 'question', buttons: ['Restart now', 'Later'], message: `Version ${v} downloaded. Restart to install?` });
  if (restart.response === 0) autoUpdater.quitAndInstall();
});
