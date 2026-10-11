# Gameout Driver

Desktop app that runs in the Windows tray, watches the game folders registered in Gameout and sends their backups to the server: it zips the folder and uploads it straight to MinIO through a presigned URL.

```
Gameout-Backend ──RabbitMQ commands──> Driver ──zip──> MinIO (presigned PUT)
       ^                                  │
       └──── RabbitMQ events / logs ──────┘   + WebSocket "drive" (presence)
```

Same layout as WSL-Vpn and WSL-Config. Version 2 replaces the .NET driver, kept in `legacy/` for reference.

## Structure

- **server/**: Express API (TypeScript run natively by Node 24) on `127.0.0.1:4314`, and the driver itself:
  - `driver.ts`: lifecycle, commands, folder watching and the backup queue;
  - `rabbit.ts`, `presence.ts`, `backend.ts`: RabbitMQ, the presence socket and the Gameout API;
  - `backup.ts`: scan, zip and upload.
  Settings live in `~/.gameout-driver/data.json` (override with `GAMEOUT_DRIVER_HOME`).
- **client/**: React + Vite UI on `127.0.0.1:5314` (proxies `/api`).
- **desktop/**: Electron shell (tray icon, start with Windows) and NSIS installer.

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

- **Server**: the API address and an API key generated on the Gameout site. With My-Personal-Compose: `http://localhost:8201`. With the backend running locally: `https://localhost:7000`. Node is set to trust the Windows certificate store, so the ASP.NET development certificate works once it is trusted (`dotnet dev-certs https --trust`).
- **RabbitMQ**: host, port, user and password. With My-Personal-Compose: `localhost:5672`, with `RABBITMQ_USER` and `RABBITMQ_PASSWORD` from its `.env`. The advanced names default to the backend's `appsettings.json`.
- **Start with Windows** (desktop app only): starts in the tray, without opening the window.

The API key and the RabbitMQ password are encrypted with Windows DPAPI for the current user; the window never receives them back. Saving reconnects everything.

## How it works

- **Identity**: `GET /driver-identity` returns the user that owns the API key. The command queue is `<prefix><userId>`, bound with the user id, which is the routing key the backend publishes with. No `UserId` setting is needed.
- **Commands** (RabbitMQ):
  - `RefreshWatchers` reloads the folders;
  - `StartBackup` queues a backup;
  - `ScanDirectories` is a status check: it compares the folder with the last backup's size and date, from `PayloadJson`. The .NET driver ran a full backup here.
- **Watching**: folders with *Observer* back up after a change; folders with *AutoValidateSync* are marked unsynced. A burst of changes counts once the folder has been quiet for 5 s.
- **Backups**: one at a time, a folder is never queued twice.
  1. Zip the folder in `%TEMP%`.
  2. Call `create-app-stored-file` with the original size and get the presigned URL.
  3. `PUT` the zip to that URL with `Content-Length`, since presigned uploads reject chunked encoding.
  4. Publish `Started`, `Progress` and `Completed` events, or `Error` if it fails.
  Missing folders report `PathNotFounded`; files held open by a game report `LockedFiles`.
- **Presence**: a WebSocket to `/ws` with the `type=drive` cookie and `X-API-Key`, which is what `driver-is-connected` looks at. The .NET driver registered it but never started it.
- **Logs**: the main steps are also sent to the backend's application log with the operation's trace id.

## Security

- The local API only accepts requests to `localhost`, and state-changing requests must carry the `x-gameout-driver` header, so other websites can't drive it.
- Secrets are encrypted with DPAPI, travel to PowerShell through stdin, and the window only learns whether they are set.
