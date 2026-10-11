# Gameout Driver

Desktop app that runs in the Windows tray. It decides which folder of this PC feeds each Gameout group, watches those folders and sends their backups to the server: it zips the folder and uploads it straight to MinIO through a presigned URL.

```
Driver ──HTTP + X-API-Key──> Gameout-Backend      (groups, upload urls, status, logs)
   └────zip, presigned PUT──> MinIO
```

Every exchange starts on the driver; the backend never calls it. There is no RabbitMQ or WebSocket.

Same layout as WSL-Vpn and WSL-Config. Version 2 replaces the .NET driver.

## Structure

- **server/**: Express API (TypeScript run natively by Node 24) on `127.0.0.1:4314`, and the driver itself:
  - `driver.ts`: lifecycle, groups and their local folders, folder watching and the backup queue;
  - `backend.ts`: the Gameout API;
  - `backup.ts`: scan, zip, upload and the comparison with the latest version.
  Settings and the folder of each group live in `~/.gameout-driver/data.json` (override with `GAMEOUT_DRIVER_HOME`).
- **client/**: React + Vite UI on `127.0.0.1:5314` (proxies `/api`), with the same palette as the Gameout web app.
- **desktop/**: Electron shell (tray icon, start with Windows, native folder picker) and NSIS installer.

## Usage

```sh
npm install
npm run dev       # API + Vite, open http://localhost:5314
npm test          # server unit tests
npm run typecheck
npm run desktop   # build and open in an Electron window
npm run dist      # Windows installer: release/Gameout-Driver-Setup-<version>.exe
```

The installer is unsigned, so SmartScreen warns on first run ("More info" → "Run anyway").

## Setup

In **Configurações**:

- **Server**: the API address and an API key generated on the Gameout site (Config). With My-Personal-Compose: `http://localhost:8201`. With the backend running locally: `https://localhost:7000`. Node is set to trust the Windows certificate store, so the ASP.NET development certificate works once it is trusted (`dotnet dev-certs https --trust`).
- **Start with Windows** (desktop app only): starts in the tray, without opening the window.

The API key is encrypted with Windows DPAPI for the current user; the window never receives it back. Saving reconnects.

## Groups and folders

A group (an `AppFile` on the backend) only has a name and its versioning, set on the web. Everything about the folder is per PC and lives here:

- **Folder**: where the saves are on this PC. Two PCs can feed the same group, each with its own folder. Groups without a folder here are listed under *Sem pasta neste PC*.
- **Enviar sozinho quando a pasta mudar**: a change starts a backup.
- **Marcar como desatualizado quando a pasta mudar**: a change reports the group as unsynced; the folder is also compared with the latest version when the driver starts and when a problem goes away.

A burst of changes counts once the folder has been quiet for 5 s. **Novo grupo** creates the group on the backend from a folder chosen here; groups created on the web show up within a minute (or with the refresh button).

## How it works

- **Groups**: `GET /get-files` every minute. Besides picking up changes made on the web, these calls are what the web shows as the driver's last contact.
- **Backups**: one at a time, a group is never queued twice.
  1. Zip the folder in `%TEMP%`.
  2. `create-app-stored-file` with the original size returns the presigned URL.
  3. `PUT` the zip to that URL with `Content-Length`, since presigned uploads reject chunked encoding.
  4. `complete-app-stored-file` turns it into a version (without versioning, it replaces the previous one). If anything fails, `cancel-app-stored-file` drops the record.
- **Status**: `update-appfile-status` reports what the driver finds: `Synced`/`Unsynced` from the comparison with the latest version (folder size and modification dates), `PathNotFounded` for a missing folder, `LockedFiles` for files held open by a game.
- **Logs**: the main steps are sent to the backend's application log with the operation's trace id. The **Logs** tab shows that log a page at a time, with search.

## Security

- The local API only accepts requests to `localhost`, and state-changing requests must carry the `x-gameout-driver` header, so other websites can't drive it.
- The API key is encrypted with DPAPI, travels to PowerShell through stdin, and the window only learns whether it is set.
- The driver holds no broker or storage credentials: it only has the user's API key, and MinIO access comes as short-lived presigned URLs.
