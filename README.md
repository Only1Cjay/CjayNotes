# CjayNotes

A simple, installable notes app that runs entirely in the browser — no account, no server, no setup. Open it, write a note, and it is there when you come back.

Built by a PharmD student at the University of Benin for his own everyday note-taking — lecture notes, quick reminders, and anything else worth writing down — instead of reaching for a heavier notes app.

## Features

- **Notes with title, content, tags, and folders** — create a note from the pen button and give it a title, body text, comma-separated tags, and a folder. Notes are sorted most-recently-edited first, show a 100-character preview and a relative last-edited time ("just now", "5m ago", "yesterday", …), and untitled notes show as "Untitled".
- **Autosave** — typing in the title, content, tags, or folder field saves the note automatically (debounced); there is also a Save button in the editor.
- **Folders view** — folders are derived from the folder field on notes (there is no separate folder creation step). Browse them on the Folders screen or via folder pills on Home, with a count of notes in each folder.
- **Starred and archive** — star important notes, and archive notes you want out of the way without deleting them. Filter pills show All, Starred, and Archived, each with a live count.
- **Search** — search across note titles, content, tags, and folder names.
- **Delete with undo** — deleting a note shows an Undo toast for 5 seconds; after that the note's id is recorded for sync purposes.
- **Cloud sync** — notes sync through a Cloudflare Worker (`cjay-cloud.monaplayzsbackup.workers.dev`, `/v1/sync/cjaynotes`), automatically shortly after opening the app, when the tab becomes visible again, and a couple of seconds after a save. A sync token can be pasted in Settings, but `app.js` also contains a built-in default token, so sync is effectively on by default. The theme choice syncs with the notes.
- **Push notifications** — optional, via the same Worker (VAPID key fetched from the Worker); enable/disable from Settings. The service worker shows incoming push notifications and focuses the app when one is tapped.
- **Google Drive backup** — optional push/pull backup to a `CjayNotes` folder in Drive, using your own Google OAuth Client ID (Google Identity Services, `drive.file` scope). The backup file is `cjaynotes_backup.json`. After a push, older Drive backups in that folder are deleted.
- **JSON backup and restore** — export all notes as a dated JSON file (`cjaynotes_backup_YYYY-MM-DD.json`, including the theme choice and export time) and import it back. Importing replaces everything currently in the app, after a confirmation.
- **Reset all data** — deletes all notes and folders, after a confirmation; it cannot be undone.
- **Light and dark themes** — toggle from the header; dark is the default and your choice is remembered (`cjaynotes_mode`).
- **Installable as a PWA** — ships with `manifest.json` (standalone display, portrait orientation, `icon.svg` as both `any` and `maskable` icons), a service worker (`sw.js`, version `cjaynotes-v1.3.0`), and an app icon (`icon.svg`), so it can be added to a phone or desktop home screen. The service worker caches the app shell (page, CSS, JS, manifest, icon) for offline use, serves cached content first for same-origin requests, and shows an "update available" prompt when a new version is installed. An offline banner appears when the connection drops.
- **Local, on-device storage** — notes live in the browser's `localStorage` under `cjaynotes_data` (no server-side component in the repo). Related keys: `cjaynotes_mode`, `cjaynotes_sync_token`, `cjaynotes_google_client_id`, `cjaynotes_google_token`, `cjaynotes_last_sync`, `cjaynotes_push_enabled`.

## Getting started

No installation or build step is needed.

1. Open `index.html` in a modern browser, or serve the folder with any static file server.
2. Start writing notes.

To install it as an app: open the hosted version in a mobile or desktop browser and use the browser's "Add to Home screen" / "Install app" option.

## Tech stack

- HTML (`index.html`)
- CSS (`styles.css`)
- Vanilla JavaScript (`app.js`)
- Progressive Web App: Web App Manifest (`manifest.json`) + Service Worker (`sw.js`)

No frameworks, libraries, or build tools are present in the repository. The only external dependency is the Inter and JetBrains Mono fonts loaded from Google Fonts (cached by the service worker after the first load).

## Project structure

```text
CjayNotes/
├── README.md       # this file (previously a 28-byte placeholder)
├── index.html      # the app's single page
├── app.js          # application logic (~48 KB)
├── styles.css      # styling (~28 KB)
├── manifest.json   # PWA manifest (name, icons, display mode)
├── sw.js           # service worker (offline support)
└── icon.svg        # app icon
```

## Status

Working static app, based on the files present. The existing README in the repo was a 28-byte placeholder, so this file replaces it with a proper description. In-app features (note editing, autosave, folders, starred, archive, search, sync, Drive backup) are verified from the source code.
