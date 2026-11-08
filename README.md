# PULSE — Attendance Intelligence Terminal

Offline, LAN-only attendance for a small office. One Windows PC runs the **PULSE** desktop app. Employees use their **own phones** (a normal browser page) to scan a rotating QR code shown on that PC. Everything stays on the office network: no cloud, no internet, no separate backend, no database server, no CDN.

* Desktop: Electron + Node.js + TypeScript + React + Vite
* Data: plain local files (`employees.json`, `devices.json`, `attendance-events.jsonl`, `audit-log.jsonl`, `settings.json`, …). Excel (`.xlsx`) is **export only**.
* Phone identity: a per-phone ECDSA P-256 key pair created by the phone's browser. The private key never leaves the phone.
* Sized for 22 employees, built for up to 500.

---

## 1. Requirements

| Where | What |
|---|---|
| Office PC | Windows 10/11 x64, Node.js **22 LTS or newer** (only to build/run from source), about 600 MB free disk, a wired or Wi-Fi LAN address |
| Phones | Any current Android (Chrome) or iPhone (Safari 16.4+) on the **same office Wi-Fi/LAN**. No app install. |
| Network | Phones and the PC on the same subnet; client isolation ("AP isolation") turned **off** on the Wi-Fi |

## 2. Install, build, run (PowerShell)

Open PowerShell in the project folder:

```powershell
# one time: installs dependencies and builds
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1

# opens the Windows Firewall for the two PULSE ports on the LOCAL SUBNET only (run as Administrator, one time)
powershell -ExecutionPolicy Bypass -File .\scripts\firewall.ps1

# start the app
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

Other scripts in `scripts\`:

| Script | Purpose |
|---|---|
| `build.ps1` | type-check + build |
| `test.ps1` | type-check, build, unit/integration tests, Electron end-to-end self-test (`-SkipSelfTest` to skip the last) |
| `package.ps1` | builds a Windows installer + portable exe into `release\` |
| `firewall.ps1` | create / `-Remove` the firewall rules (ports 8443 and 8081, local subnet, Private profile) |
| `network-info.ps1` | prints the phone URLs, checks the ports are listening and the rules exist |
| `backup.ps1 -Destination E:\backups` | verified copy of the data folder |

Equivalent npm commands: `npm run build`, `npm start`, `npm test`, `npm run selftest`, `npm run dist:win`.

## 3. First-time administrator setup

The first launch shows **Create the owner account**. There are no built-in or default credentials.

* Choose a username and a password of at least 12 characters with upper-case, lower-case and a digit.
* The owner can later add **admin** (manage people/attendance) and **auditor** (read + export only) accounts under *Settings → Administrator accounts*.
* Passwords are stored as salted scrypt hashes. Sign-in is rate-limited and locks after repeated failures. Sessions end after the idle timeout (default 15 min).
* **No backdoor / no reset email.** If the owner password is lost, someone with access to the PC's files can close PULSE and move `admins.json` out of the data folder (rename it, never delete it); the next launch offers first-time setup again (attendance and audit history are untouched; the new owner account creation is itself written to the audit log).

Then open *Settings* and set: organisation name, time zone, work hours, grace period, working days. Add employees (*Employees → Add employee*, or **Import CSV**: `employeeId, full name, phone, department`).

## 4. Making phones work: HTTPS and the certificate

Phone browsers only allow the **camera** and the **cryptographic key store** on a *secure context*. A plain `http://192.168…` address does **not** qualify, so PULSE serves the phone app over HTTPS and creates its own certificates:

1. On first start PULSE generates a private **local CA** ("PULSE Local CA (<pc name>)", valid 10 years) and a server certificate for the PC's LAN IP address (and any extra host names you list in Settings), valid ~2 years and renewed automatically when the IP or names change.
2. Each phone must trust the CA **once**. Phones open the small setup page that PULSE serves on plain HTTP, port **8081**, which offers *only* the CA download:

   `http://<PC LAN IP>:8081`  (shown in *QR terminal → Connection* and by `network-info.ps1`)

   * **Android:** download the certificate → Settings → Security (or Security & privacy) → *Encryption & credentials* → *Install a certificate* → **CA certificate** → pick the file.
   * **iPhone/iPad:** download → Settings → *Profile Downloaded* → Install → Settings → General → About → **Certificate Trust Settings** → enable full trust for *PULSE Local CA*.
   * Compare the **SHA-256 fingerprint** shown on the setup page with the one in *QR terminal → Connection* or *Settings → Phone certificate*. Install only if they match.
3. Open `https://<PC LAN IP>:8443` and use *Add to Home Screen*.

The CA private key stays on the office PC (protected with Windows DPAPI via Electron `safeStorage` when available; the Overview/Settings pages show whether secrets are OS-protected or file-permission-only). Do not copy the CA key anywhere.

> A fixed IP for the PC is strongly recommended (DHCP reservation in the router). If the IP changes, the certificate is re-issued automatically; the *CA* stays the same, so phones do not need to re-install anything.

## 5. LAN setup checklist

1. Give the PC a **DHCP reservation / static IP**.
2. Wi-Fi *client isolation* off, phones and PC on the same subnet.
3. Run `scripts\firewall.ps1` as Administrator (TCP 8443 and 8081, local subnet only). If Windows classifies the office network as *Public*, either set it to *Private* or re-run with `-AllProfiles`.
4. PULSE binds to the **LAN address only** (auto-detected private IPv4, or the one you pick in *Settings → Network*) — never `0.0.0.0`, never a public address. The admin interface is reachable only through the desktop app (Electron IPC) and a loopback-only live channel.
5. Requests from outside the allowed networks (default: private ranges `10/8`, `172.16/12`, `192.168/16`) are refused and logged.
6. Phone attendance uses host-header validation and rate limits; the admin interface is never exposed to the LAN.

## 6. Registering a phone

1. *QR terminal → Registration QR* (or *Employees → Enroll phone* for a one-time code tied to one employee). The code is one-time and expires (default 5 min).
2. The employee scans it with the phone camera (or scans from inside the PULSE page) and enters full name, employee ID and phone number. The phone creates its key pair.
3. The request appears under **Requests** (badge in the sidebar) with automatic checks (name/phone differ from the directory, unknown employee ID). The administrator confirms *in person* and clicks **Approve** or **Reject**.
4. The phone screen updates by itself. Only the **public key** is stored on the host.

**Lost / replaced phone:** *Phones → Revoke* (takes effect immediately, the old phone is told it was revoked). Then *Employees → Replace phone* issues a one-time QR; the new phone registers and an administrator approves it explicitly. Approving a replacement revokes the previous phone. Everything is audited. **Deactivating** an employee blocks their phone at once without deleting history.

## 7. Daily use

* Show **QR terminal** (or open the **Reception display** on a second monitor/TV; F11 for full screen). The code changes every 3 s with a countdown. A scan is accepted for about 10 s after a code was displayed.
* Employee opens PULSE on their phone → *Scan to check in / out* (or scans with the camera app). The phone signs the code with its private key. The host verifies the signature, the one-time challenge and replay protection, stamps the **host's own clock** (office time zone), applies rules (check-in/out sequencing, duplicate prevention, grace/late, early-leave) and writes the event durably **before** replying. The phone shows success only after the save.
* **Overview** updates live via WebSockets. *Attendance* has filters and detail per day. **Corrections** (add / amend / void) require a reason, are saved as **new attributed events**, and never rewrite the original.

### QR code modes (QR terminal → *QR code mode*)

Exactly one mode is active at any time; activating one deactivates the other. The choice, and the permanent code, are stored in `qr-mode.json` in the data folder, so they survive page refreshes, closing the window and restarting PULSE. A fresh install (or an upgrade from an earlier version) starts in **Timer-Based** mode, which behaves exactly as before.

* **Timer-Based QR Code** — the rotating code (default every 3 seconds, interval and acceptance window in *Settings*). Unchanged rules: host-signed, expires within seconds, bound to this process run, one use per phone.
* **Permanent QR Code** — one fixed code that never changes until an owner/admin presses *Regenerate permanent code* (the old code stops working immediately). It contains only the office ID and a random identifier, signed with a host-only key; it carries no employee data. Because it never expires, each scan additionally has to include a one-time nonce issued by the host (single use, 30 seconds), signed by the registered phone, so a captured request cannot be replayed.
* Codes of the inactive mode are refused by the server (`QR_INACTIVE`), so a leftover rotating code cannot be used while Permanent mode is on, and a printed permanent code cannot be used while Timer-Based mode is on.
* Two administrators changing the mode at the same moment cannot produce a mixed state: changes are serialized, and the dashboard sends the revision it was showing, so the second, stale change is refused with a clear message and the screen refreshes.
* If you print the permanent code, set a stable host name under *Settings → Network → Extra host names* first: the printed QR also holds the phone address, which would otherwise change with the PC's IP address.

## 8. Data folder, backup and recovery

Default location: `%APPDATA%\PULSE\data` (override with the `PULSE_DATA_DIR` environment variable).

| File / folder | Content |
|---|---|
| `settings.json`, `employees.json`, `devices.json`, `admins.json`, `qr-mode.json` | JSON, schema-versioned, written atomically (temp file → fsync → rename) with a `.bak` of the previous good copy |
| `attendance-events.jsonl` | append-only attendance + correction events, hash-chained, each line fsynced |
| `audit-log.jsonl` | append-only audit log, hash-chained |
| `host-secrets.json`, `tls/` | signing key, CA and server certificates (secrets protected by Windows when available) |
| `exports/` | generated `.xlsx` files |
| `backups/` | one automatic backup per day (14 kept) and manual backups |
| `*.corrupt-<timestamp>` | a corrupt JSON file is renamed (never silently deleted) before PULSE restores the last good `.bak` |

**On startup** PULSE verifies every file: a torn last log line (power cut) is trimmed and reported; a corrupt JSON file is renamed `*.corrupt-<timestamp>` and restored from its `.bak`; a log whose hash chain does not verify raises a prominent warning. *Audit & security → Run check* repeats the verification on demand.

**Backups:** *Settings → Data & backups → Back up now*, plus `scripts\backup.ps1 -Destination <drive or share>`. Copy backups off the PC regularly (USB, NAS).

**Restoring:** close PULSE, copy the files from a backup folder into the data folder, start PULSE (same Windows user, same PC): everything continues, including enrolled phones.

**Restoring on a different PC or Windows user:** `host-secrets.json` is encrypted for the Windows user that created it, so PULSE refuses to start and says so. To proceed, delete `host-secrets.json` and the `tls\` folder from the restored copy and start PULSE. It creates new secrets and a **new local CA**. Consequences, in plain terms: (1) phones must install/trust the new CA again (section 4) — their registrations stay valid because only public keys are stored on the host; (2) the integrity check will report the *older* log records as "modified after writing", because they were chained with the old key. That report is indistinguishable from tampering, so write down the date of the restore. Plan for this in your disaster-recovery notes.

**Failure behaviour:** if the disk is full or a write fails, the phone is told **"Attendance was NOT recorded"** (HTTP 507 `STORAGE_FULL` / `STORAGE_ERROR`) and nothing is partially saved. If the PC clock moves **backwards**, attendance is blocked and an administrator must acknowledge the warning; forward jumps and drifts are flagged in the audit log.

## 9. Excel exports

*Exports*: **Daily**, **Monthly** (with a day-by-day grid), **Date range**, **Single employee**, **Complete** (day records plus the employee directory, devices, audit log and raw events/corrections on separate sheets). Files are formatted `.xlsx` (frozen header row, filters, hours worked, attendance status with late/early minutes, check-in/out times, verification status, device and event IDs, correction history) and saved to `exports\`. Exporting only *reads* the source records; it never changes or deletes them. Phone numbers can be left out (*Settings → QR code timing & privacy*).

## 10. Security model — what is and is not protected

**Prevented by design**
* Identity comes only from a per-phone private key (non-extractable WebCrypto key in IndexedDB). No localStorage IDs, fingerprints, IP or MAC addresses are trusted.
* Each attendance request is an ECDSA signature over a canonical message (`PULSE/1`, host ID, device ID, one-time rotating challenge, intent, client nonce). Challenges are host-signed (HMAC), expire in seconds, are bound to this process run, and each `(challenge, device)` pair and client nonce works once. Many phones can scan the same displayed code; a photo of the code cannot be used by a phone that is not registered, and a registered phone still has to be on the office network (CIDR policy).
* Electron: sandbox, context isolation, no Node in renderers, strict CSP on a custom `app://` protocol, locked-down permissions, outbound requests blocked, IPC allow-list with sender check, role-based permissions (owner / admin / auditor).
* Admin API is not network-reachable; the live channel is loopback-only with Origin + token checks.

**Detected but not prevented**
* The audit log and event log are **tamper-evident** (hash chain keyed by a host secret), not tamper-proof. Anyone with full file-system access to the PC can edit or delete files; the integrity check will reveal broken chains, but cannot stop it. Protect the PC (Windows account, BitLocker) and keep off-PC backups.

**Known limits (be aware)**
* A registered employee could hand their unlocked phone to a colleague who is physically in the office; a QR system cannot tell. Revocation, audit and the displayed name on the reception screen are the controls. Treat it as accountability, not biometrics.
* Wiping browser data or "Clear site data" removes the phone's key. The phone then needs a replacement approval. On iPhone, add PULSE to the Home Screen to avoid Safari's inactivity cleanup.
* The system is only as trustworthy as the **host PC clock**; backwards jumps are blocked and flagged, small drifts are only flagged.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Phone says "secure connection needed" / camera never asks | Install and trust the certificate (section 4), then open the **https** address. A browser warning page means the CA is not trusted yet. |
| Phone cannot open the page at all | Same Wi-Fi/subnet? Wi-Fi client isolation off? Run `scripts\network-info.ps1`; run `scripts\firewall.ps1` as Administrator; check the network profile is *Private*. |
| Sidebar says *Phones cannot connect* | The configured LAN address is not on this PC or only loopback is available (no network). Pick the right address in *Settings → Network* and restart PULSE. |
| "Attendance can only be recorded from the office network" | The phone is on mobile data/VPN or outside *allowed phone networks* (Settings). |
| "QR code expired" | Scan the code **currently** shown; keep the phone steady; the clock difference is not an issue (the host decides). |
| "Phone not recognized" | The host data was restored/reset or the registration was removed. Ask an admin for a registration/replacement QR. |
| Camera black or denied | Browser Settings → Site settings → Camera → allow for the PULSE address; close other camera apps. |
| Banner "Storage notice" | Free disk space (warning threshold in Settings) or follow the message; attendance is refused with an explicit message when saving is impossible. |
| Banner "Clock changed backwards" | Fix the Windows clock, then *Overview → Acknowledge*. |
| App will not start ("could not start") | The data-folder error is shown; check disk and permissions. Corrupt files are set aside automatically as `*.corrupt-<timestamp>` in the data folder. |
| Port in use | Change the ports in *Settings → Network* (and re-run `firewall.ps1 -HttpsPort … -SetupPort …`). |

## 12. Tests

```powershell
.\scripts\test.ps1
```

* `tests\storage.test.ts` — atomic writes, torn-write recovery, `.corrupt-*`/`.bak` recovery, hash chains, ENOSPC rollback, serialized concurrent writes.
* `tests\protocol.test.ts` — signing messages, tokens, replay guard, signatures (incl. wrong/foreign keys).
* `tests\flow.test.ts` — full flows against the **real HTTPS server and WebSockets** with a generated CA: registration, approval/rejection, 22-phone concurrency, replay, expired/forged QR, revoked/deactivated devices, replacement, sequencing, late/grace, corrections, exports read back with ExcelJS, restart persistence, tamper/torn-log detection, disk-full, clock-change.
* `tests\qr.test.ts` — QR generation decoded again with the same decoder the phone uses.
* `npm run selftest` — **inside the real Electron app**: drives the admin UI (first-time setup, every page, screenshots), and a second Chromium session loads the phone page over HTTPS, reads the registration QR from a (fake) camera device with real WebCrypto and jsQR, gets approved, checks in, checks out, is refused a third scan, and is revoked while connected. Screenshots land in `selftest-output\`.

### Real-device checklist (not automatable here — please do once on site)
1. Install the CA on one Android and one iPhone; confirm the fingerprint check.
2. Register each phone with the **real camera**, approve, check in and out from the office Wi-Fi.
3. Confirm a phone on mobile data is refused.
4. Revoke a phone and confirm it is rejected within seconds; enroll a replacement.
5. Pull the network cable/Wi-Fi during a scan: the phone must say *NOT recorded*, and the dashboard must not show the event.
6. Reboot the PC mid-day: data and enrolled phones persist; scans work again after PULSE starts.
7. Open an export in Excel.
8. Switch to Permanent mode, scan the permanent code on a registered phone (check in and out), switch back to Timer-Based and confirm the permanent code is refused.

## 13. Project layout

```
src/shared     types + wire protocol shared by host and phone
src/server     host service: storage, domain rules, crypto, TLS, HTTPS/WS servers, admin API, exports
src/main       Electron main process, preload bridge, self-test
src/renderer   admin dashboard (React) and phone app (React)
assets         source logo ("Pulse icon.png"); public/ holds the derived app icons
tests          vitest suites
scripts        PowerShell scripts
```


## Shift attendance rules and data protection

For every shift (including overnight), windows are calculated from the shift's own start and end in the configured time zone (default Asia/Kathmandu). Defaults for a 06:00–12:00 shift:

| Window | Time | Result |
|---|---|---|
| Check-in opens | 05:00 | 1 hour before start |
| On time | to 06:10 | on-time |
| Late | to 06:30 | late |
| Very late | to 07:00 | very late |
| After 07:00 | until shift end | needs administrator approval with a reason (*Approvals* page) |
| Check-out opens | 11:00 | 1 hour before end |
| Before 12:00 | | early leave (red) |
| 12:00–13:00 | | on time |
| After 13:00 | | overtime, needs administrator approval |

Approved overtime keeps the actual check-out time and records overtime hours; rejected or pending overtime counts hours only up to the shift end. Approval status, approving administrator and reason are appended to the attendance log. Each window is adjustable per shift under *Shifts*.

Nothing is permanently deleted: employees, phones and shifts are archived (with status indicators and restore), attendance corrections and approvals are appended records, and old automatic backups move to `backups/archive`.
