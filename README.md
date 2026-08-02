# Family Parcheesi Score Tracker

A no-build static website for GitHub Pages. Scores are loaded from a Google Sheet published as CSV.

## Files

- `index.html` — page structure
- `styles.css` — mobile-first design and automatic light/dark mode
- `config.js` — paste the published CSV URL here
- `script.js` — CSV loading, validation, calculations, caching, and rendering
- `sheet-template.csv` — import this into Google Sheets for the correct headers
- `.nojekyll` — tells GitHub Pages to serve the files directly

## Quick setup

1. Create a Google Sheet with these exact headers: `Date`, `Winner`, `NathanPlayed`, `Notes`.
2. Publish the score worksheet to the web as **Comma-separated values (.csv)**.
3. Copy the published URL.
4. Open `config.js` and replace `PASTE_YOUR_PUBLISHED_CSV_URL_HERE` with that URL.
5. Upload every file in this folder to the root of a public GitHub repository.
6. In the repository, open **Settings → Pages**, choose **Deploy from a branch**, then select `main` and `/ (root)`.

Use dates such as `2026-01-03`. Winner names must be Ben, Andrew, Nathan, Mom, or Dad. Use Yes or No for NathanPlayed.

Nathan's win percentage is calculated from only the games he played. Everyone else's game count includes every valid row.
