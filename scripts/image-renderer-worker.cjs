// Synthetic fixture runner only. Never launch the Desktop application or use its profile.
const {app, BrowserWindow, session, protocol} = require('electron');
const {readFileSync, writeFileSync, mkdirSync} = require('node:fs');
const {join} = require('node:path');
const [requestFile, outputFile, profile] = process.argv.slice(2);
const request = JSON.parse(readFileSync(requestFile, 'utf8'));
if (request.secureContext === true)
    protocol.registerSchemesAsPrivileged([
        {scheme: 'fixture', privileges: {standard: true, secure: true}},
    ]);
mkdirSync(profile, {recursive: true, mode: 0o700});
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.setPath('logs', join(profile, 'logs'));
app.setPath('crashDumps', join(profile, 'crashes'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
const timeout = setTimeout(() => app.exit(1), 30000);
app.whenReady()
    .then(async () => {
        const isolated = session.fromPartition('temporary-image-fixtures');
        isolated.webRequest.onBeforeRequest(
            {urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']},
            (_details, callback) => callback({cancel: true}),
        );
        isolated.setPermissionRequestHandler((_webContents, _permission, callback) =>
            callback(false),
        );
        const window = new BrowserWindow({
            show: false,
            webPreferences: {
                session: isolated,
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
            },
        });
        window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
        if (request.secureContext === true) {
            isolated.protocol.handle(
                'fixture',
                () =>
                    new Response('<meta charset="utf-8"><title>Synthetic media fixtures</title>', {
                        headers: {'content-type': 'text/html'},
                    }),
            );
            await window.loadURL('fixture://synthetic/');
        } else {
            await window.loadURL(
                'data:text/html,<meta charset="utf-8"><title>Synthetic image fixtures</title>',
            );
        }
        const results = await window.webContents.executeJavaScript(request.code);
        writeFileSync(
            outputFile,
            JSON.stringify({
                electron: process.versions.electron,
                chromium: process.versions.chrome,
                results,
            }),
            {mode: 0o600},
        );
        window.destroy();
        clearTimeout(timeout);
        app.quit();
    })
    .catch(() => {
        clearTimeout(timeout);
        app.exit(1);
    });
