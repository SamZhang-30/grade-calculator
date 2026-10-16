# Optional cross-device sync

The frontend still runs on GitHub Pages. Firebase Authentication and Cloud
Firestore provide the optional account and private data store. No custom server,
Firebase Hosting deployment, service-account key, or Cloud Function is required.
Without the four build variables below, the app stays local-only and does not
initialize Firebase or make Firebase requests.

## 1. Create the Firebase project

1. Open the [Firebase console](https://console.firebase.google.com/), create a
   project, and register a **Web** app from Project settings. Analytics is optional;
   this app does not use it. You do not need to enable Firebase Hosting.
2. Copy the public web config: `apiKey`, `authDomain`, `projectId`, and `appId`.
3. Under **Authentication → Sign-in method**, enable **Google** and set the
   support email requested by Firebase.
4. Under **Authentication → Settings → Authorized domains**, add:
   - Your Pages hostname, e.g. `yourname.github.io` (no protocol or repository path).
   - Your custom hostname too, if you use one.
   - `localhost` and `127.0.0.1` for local testing; add them explicitly.
5. Under **Firestore Database**, create the **default database** using the
   standard/native Firestore mode. Choose production mode and your desired region.
6. In Firestore's **Rules** tab, paste the complete contents of
   [`firestore.rules`](../firestore.rules) and publish. Do not use public/test rules.

The rules restrict every read and write to `/users/<your-auth-uid>/gradebook/*`.
This deployment additionally requires the **verified** email
`sam.zhang.official@gmail.com` and a Google sign-in token. Every other email,
unverified identity, and non-Google provider is denied, including in its own
namespace. Record changes also require an atomic revision advance.
[Firebase rules documentation](https://firebase.google.com/docs/firestore/security/rules-conditions)

The app checks the same allowlist before opening a sync session, but that is
only a UX safeguard: the published Firestore rules enforce the actual security
even if someone modifies the public JavaScript or calls Firestore directly.

Firebase web config is public and will be included in the browser build. It is
**not** an admin credential. Privacy depends on the security rules and sign-in,
not on hiding that config. Never upload a service-account JSON/private key.
[Firebase API key guidance](https://firebase.google.com/docs/projects/api-keys)

## 2. Configure local development

Create `.env.local` using [`.env.example`](../.env.example) as the template:

```dotenv
VITE_FIREBASE_API_KEY=your-public-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_APP_ID=1:your-project-number:web:your-app-id
```

Use Node.js **24.12 or newer** (the Firebase 13 SDK's supported runtime). Restart
`npm run dev` after editing environment variables. The `.env.local` file is ignored
by Git. There is no runtime settings field for these deployment-wide values.

Click the header's course icon → **Cloud sync** → **Sign in with Google**.
Allow the sign-in popup. The popup flow is intentional: Pages cannot provide the
same-origin auth proxy needed by some redirect flows on browsers that block
third-party storage. On mobile, use a normal Safari/Chrome tab, not an embedded
in-app browser. Physical-device popup behavior still needs live verification.
[Firebase redirect considerations](https://firebase.google.com/docs/auth/web/redirect-best-practices)

## 3. Configure GitHub Pages

In the GitHub repository, go to **Settings → Secrets and variables → Actions →
Variables**. Add the four repository variables with exactly these names:

| Variable | Firebase web-config field |
| --- | --- |
| `VITE_FIREBASE_API_KEY` | `apiKey` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `VITE_FIREBASE_PROJECT_ID` | `projectId` |
| `VITE_FIREBASE_APP_ID` | `appId` |

The included Pages workflow passes those variables to the build. Run the
**Deploy to GitHub Pages** workflow again after setting them. Leaving them blank
produces a working local-only deployment. If you deploy with `npm run deploy`
instead, the values must be set in the local build environment / `.env.local`.
GitHub does not deploy the Firestore rules; publish them separately in Firebase.

## 4. Connect your devices safely

1. Export important existing gradebooks before connecting.
2. On your first device, sign in and select **Upload this device's gradebook**.
   Authentication alone does not upload grades.
3. On your second device, sign in with the **same Google account** and select
   **Use cloud gradebook**. If you have separate data there, **Add this device's
   classes** imports copies with new IDs and keeps the cloud account's global
   defaults. This can intentionally create duplicates, so do it only once.
4. Wait for **Up to date**, change a score, and confirm it appears on the other
   device. Repeat with a GPA course and a global setting.

The original local-only gradebook and each account's cached gradebook have
separate storage keys. Signing out returns to the original local-only data.
Account data is still cached in the browser after sign-out, so use a trusted
device. Clearing browser data deletes any unsynced queue. If signing out with
queued changes, sign back into that account on the same browser to resume them.
Different site origins (localhost / Pages / custom hostname) have separate caches.

## Conflict and offline behavior

- Assignments, categories, courses, GPA terms/courses, and global settings are
  independent Firestore documents. Only changed records are written.
- Concurrent changes to different fields merge, including two different fields
  of the same assignment. Two different changes to the same field pause uploads
  and show both values in Cloud sync. Choose this device or cloud for the listed
  conflicts; unrelated edits are retained.
- Deleting a category/course while another device edits or adds descendants is
  a conflict, not a silent deletion of the other device's work.
- Offline edits persist in the local gradebook and a durable, account-scoped
  outbox. They retry when the open page reconnects. This is not a service worker:
  background sync while the page is closed and loading the site from scratch
  without a cached page are not promised.
- Transactions use a revision fence and re-read on races. They deliberately do
  not use blind offline Firestore writes (which could overwrite another device).
  [Firestore transaction behavior](https://firebase.google.com/docs/firestore/manage-data/transactions)
- Undo/redo reverse your local changes. They retain unrelated remote changes and
  refuse overlapping changes. History is session-only and resets on account
  changes/reload. Conflict-resolution decisions themselves are not undoable.
- One syncing tab per account/browser is allowed via Web Locks. A second tab
  remains local-only and asks you to close the first syncing tab before retrying.
- A single atomic queued change may touch at most **499 records**, plus the
  revision document. Larger initial uploads/imports/deletions stay local with an
  explicit error; reduce the pending operation before retrying. Small edits to
  already-synced large gradebooks are unaffected.

Cloud storage is not an encrypted backup or a university transcript. Firebase
administrators can access project data. Review Firebase quotas, pricing, and
usage before enabling it for other users; this implementation does not enforce
a per-user quota or configure App Check. Avoid opening unrelated billing plans.
The personal email allowlist prevents other accounts from accessing or creating
Firestore gradebooks, but does not prevent Firebase Authentication sign-up/sign-in
attempts or all quota abuse. Blocking account creation is a separate server-side
authentication control, not something a public frontend or Firestore rules can
enforce. Do not broaden `owner()` or remove email verification to fix login errors.
To change the allowed owner later, update both `firestore.rules` and
`src/sync/access.ts`, then publish the rules and rebuild the frontend.

## Saving, undo, and recovery

An edit commits when its control saves (for text fields, usually on blur or Enter).
It is written to the active browser-local gradebook first, then captured in the
account's durable outbox. A connected client merges against the latest cloud
state and atomically writes changed records with a new revision. **Up to date**
means that client has no queued changes; other devices receive updates while
their pages are open. Closing a page with queued changes is not a server save.

### Undo and redo

- Undo/redo is an in-memory, per-session stack of up to 100 edits, not a shared
  timeline. Reloading or switching accounts clears it. Another device has its
  own history, not your history stack.
- Undoing a synced edit creates a new compensating edit. It goes through the same
  queue, merge, rules, and transaction process, and propagates to connected
  devices. Redo works the same way. Neither decreases the cloud revision.
- Unrelated remote edits are preserved. If the same field/subtree has changed
  remotely, undo refuses to overwrite it. Resolve that deliberately rather than
  treating undo as a force-reset of the whole account.
- Offline undo changes the queued desired state; if the original edit has not
  uploaded, both may collapse into no net cloud change. In-flight uploads are
  followed by the compensating edit, not cancelled retroactively.

### Whole-app backups

Open the course icon → **Backups & data** → **Download whole-app backup**. The file
includes every class, assignment, notes/curves, GPA term/course, and global
setting in the currently displayed profile, including unsynced edits. It does
not include authentication credentials, another profile's data, the outbox, or
undo/redo history. Treat this plain JSON file as private. Export regularly and
before clearing site data, changing accounts, or making large imports.

To restore, choose a whole-app JSON backup, review its date and counts, then
confirm replacement. The app validates the complete file (maximum 10 MB), starts
a download of the current gradebook, and restores the backup as **one undoable
edit**. Allow/verify that pre-restore download; the browser cannot guarantee that
an automatically initiated download was retained. Single-course exports still
use the existing course import, not this full replacement flow.

Restoring while connected replaces the active account's data and syncs that
replacement to other devices. It is not a private local view of the past.
Concurrent remote edits still use normal conflict handling. A restore that
changes more than 499 records remains local with an explicit sync error; export
your data and reduce the change before retrying. The original local-only profile
is separate and is not replaced when restoring an account profile.

### Version history and deployment rollbacks

There is **no automatic cloud version history, scheduled backup, or point-in-time
recovery configured by this app**. Firestore's `_meta.revision` is only a
concurrency fence, not an archive. Do not manually reduce it or overwrite live
Firestore documents with an old snapshot while clients remain connected.

A Git/GitHub Pages deployment rollback restores application code, not browser
storage or Firestore grades. Old code must remain compatible with the stored
schema; unsupported cloud schemas pause sync rather than silently overwrite it.
To recover grades, import a downloaded whole-app backup as a new current state.
An administrative database-level disaster recovery workflow would require
separate setup, coordination of all clients/outboxes, and potentially paid
Firebase features; none has been enabled here.

## Verify before relying on sync

The local automated tests cover merges, offline queuing/reload, in-flight edits,
conflicts, revision races, scoped undo, and account-cache isolation with a fake
transport. They do not prove your Firebase project is configured correctly.

The included owner-isolation and transaction-rules tests can run against a
disposable local emulator (Node 24.12+ and Java 21 required):

```sh
npm exec --yes --package firebase-tools@15.33.0 -- firebase emulators:exec --project demo-gradebook-sync --only firestore 'npm run test:rules'
```

This uses the explicit `demo-` project and `127.0.0.1:8085`, not your live project.
Regular `npm test` skips those integration tests when that emulator is absent.
The Pages workflow also runs these emulator tests before deployment.

After configuring the real project:

1. Test sign-in on laptop and physical phone, then realtime updates both ways.
2. Go offline on one device, edit different fields on each device, reconnect,
   and verify both edits remain.
3. Edit the same field differently offline, reconnect, and verify the conflict
   panel appears before choosing a winner.
4. Test delete-vs-edit, offline edit + reload, sign-out/sign-in, and undo after a
   remote edit.
5. In Firebase's Rules Playground, confirm unauthenticated access, other verified
   Google emails (even on their own paths), unverified emails, non-Google tokens,
   and another UID cannot read/write your path. Confirm your own UID with the
   allowed verified Google email can read. Single-record writes without a
   revision advance should be denied.
   Transaction write rules should also be tested with the Firestore emulator or
   a configured staging project before sharing the site publicly.
6. Download a whole-app backup, make a disposable edit, restore it, and check
   undo/redo. Repeat for GPA data and global settings. Confirm that restoring
   while connected propagates to the second device; do not test on real grades
   without keeping an independent backup first.
7. On a physical phone, check Google popup sign-in and reopen persistence,
   soft-keyboard editing, course switching, table horizontal scrolling, grade
   selection, touch row dragging/autofill, and backup download/file selection.
   A desktop phone-sized viewport does not establish mobile Safari/Chrome support.
8. Keyboard-check each dialog: Tab and Shift+Tab stay inside, Escape closes only
   the current dialog, and focus returns to its opener. Check grade-picker arrow
   keys and the OS's reduced-motion setting. A full screen-reader audit remains
   separate from these keyboard and responsive-layout checks.

Common issues: `auth/unauthorized-domain` means add the actual hostname; popup
blocked means allow popups and press Sign in again; `permission-denied` means
check that the complete rules were published in the correct default database.
Don't “fix” permission errors by making the database public.
