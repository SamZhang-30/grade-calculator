# Gradebook

A browser-only grade calculator extracted from Gamified Shovel. It keeps the original grade and prediction engine while presenting it as a focused, dark-mode app.

## Features

- Multiple classes with a sidebar selector and customizable colors
- Fixed or pooled category weighting
- Points-based or equal assignment weighting
- Returned, estimated, pending, and possible assignment states
- Bayesian grade predictions with configurable confidence intervals
- App, class, and category-level prediction settings
- Drag assignments within and between categories
- JSON import/export for each class
- Automatic browser-local persistence
- Static build with no API or database

## Development

Node.js 22.12 or newer is recommended.

    npm install
    npm run dev

Run the regression suite and production build:

    npm test
    npm run build

## GitHub Pages

The Vite build uses relative asset paths, so the generated site works at a GitHub project subpath. The included workflow builds and deploys the dist folder whenever main is pushed.

In the repository settings, open Pages, choose GitHub Actions as the source, then run the Deploy to GitHub Pages workflow.

Grade data is stored only in that browser's local storage. Use the gradebook's Export button before clearing browser data or switching devices.
