# Finance App V4

V4 rebuild with a modular TypeScript architecture, Bootstrap-first UI, IndexedDB storage, and Apps Script cloud sync.

## Stack
- Vite + TypeScript
- Bootstrap 5
- IndexedDB via `idb`

## Run locally
```bash
npm install
npm run dev
```

## Configure Apps Script URL
Create an `.env.local` file in the project root:
```bash
VITE_APPS_SCRIPT_URL="YOUR_PRIVATE_WEB_APP_URL"
```
This URL is still visible in the client bundle at runtime, so keep it private and do not publish it in the repo.

## Admin setup
In the Apps Script editor, run this helper once to create your admin user:
```text
createAdminDirect("Your Name", "your_login_id", "your_password", "your@email.com")
```
Approve or reject new users from the admin screen once it is added in V4.

## Apps Script setup
1. Open your Google Sheet and Apps Script editor.
2. Paste `docs/apps-script.gs` into the editor and save.
3. In **Project Settings** → **Script Properties**, add `SPREADSHEET_ID` with your sheet ID.
4. Deploy as Web App:
   - Execute as: `Me`
   - Who has access: `Anyone`
5. Run `createAdminDirect(...)` once to seed the admin user (only one admin can be created this way).

## Google Sheets format
Create these sheet tabs with the exact headers:

**Users**
```
userId | name | loginId | email | passwordHash | salt | role | status | createdAt | approvedAt | approvedBy
```

**PendingUsers**
```
requestId | name | loginId | email | passwordHash | salt | status | requestedAt | reviewedAt | reviewedBy | reviewNote
```

**AdminSessions**
```
sessionId | adminUserId | tokenHash | issuedAt | expiresAt | status
```

**AdminConfig**
```
key | value
```
Config keys used:
```
maxSnapshots
livePriceRefreshSec
cloudSyncIntervalMin
```

**Snapshots**
```
timestamp | userId | payloadJson
```

**TickerRegistry**
```
ticker | synonyms | updatedAt | updatedBy
```

**TickerRequests**
```
requestId | userId | userName | rawSymbol | status | requestedAt | resolvedAt | resolvedBy | resolvedTicker | note
```

**NSEMaster**
```
symbol | name | isin | updatedAt | updatedBy
```
