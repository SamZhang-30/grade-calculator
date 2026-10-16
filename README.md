# Gradebook

A browser-only grade calculator extracted from Gamified Shovel. It keeps the original grade and prediction engine while presenting it as a focused, dark-mode app.

## Features

- Multiple classes with a header-icon switcher and customizable icons and colors in course settings
- Fixed or pooled category weighting
- Points-based or equal assignment weighting
- Final-assignment current weighting that accounts for pending work, with legacy category-progress weighting available
- Returned, estimated, pending, and possible assignment states
- Bayesian grade predictions with configurable confidence intervals
- App, class, and category-level prediction settings
- Drag assignments within and between categories
- Spreadsheet-style autofill for names, scores, point values, and statuses
- JSON import/export for each class
- Whole-app JSON backups with validated, previewed, undoable restore (all classes, GPA terms, and global settings)
- Automatic browser-local persistence
- Optional Google sign-in and private cross-device Firebase sync, with offline queues and conflict choices
- Static GitHub Pages frontend; no backend required for local-only use

## Development

Node.js 24.12 or newer is required by the Firebase SDK.

    npm install
    npm run dev

Run the regression suite and production build:

    npm test
    npm run build

## GitHub Pages

The Vite build uses relative asset paths, so the generated site works at a GitHub project subpath. The included workflow builds and deploys the dist folder whenever main is pushed.

In the repository settings, open Pages, choose GitHub Actions as the source, then run the Deploy to GitHub Pages workflow.

Without Firebase configuration, grade data is stored only in that browser's local storage. Use Export before clearing browser data.

Public visitors can use the calculator locally without signing in. Cloud sync is
currently restricted to the site owner's verified Google account. Open the
course icon → **Backups & data** to download a lasting whole-app backup.
Cloud sync stores the latest state, not version history; undo/redo is session-only.
See [saving and recovery](docs/cloud-sync.md#saving-undo-and-recovery).

To sync across phone and laptop while keeping GitHub Pages hosting, follow
[Cloud sync setup](docs/cloud-sync.md). Setup includes private Firestore rules,
Google authentication, authorized domains, and four public build variables.
The course switcher contains **Cloud sync**; signing in asks which data to use
before uploading or adopting the account gradebook.
