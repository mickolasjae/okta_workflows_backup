# Okta Workflows Dump (Node.js)

## Demo
https://www.youtube.com/watch?v=7q3skWvd_nk

A Node.js tool to **export Okta Workflows** flows and data at scale.  
It fetches `.folder` bundles per group, dumps stash tables into CSVs, and writes a manifest JSON for easy auditing, backup, and migration.

---

## Features

- **Auth detection**:
  - Uses `WF_AUTH_TOKEN` env var (if provided)
  - Or Chrome cookies (`chrome-cookies-secure`)
  - Or Playwright (headless/interactive login)

- **Exports per group**:
  - `.folder` bundle for flows
  - CSVs for all stash tables
  - Manifest JSON (`workflows_dump.json`)

- **Resilience**:
  - Timeout handling
  - Rate limiting between requests
  - Concurrency with a small promise pool

---

## Requirements

### Core
- **Node.js 18+**
  - Needed for built-in `fetch` API and `AbortController`.
  - [Download here](https://nodejs.org/).

- **npm** (comes with Node.js)

### Dependencies
Install required libraries:
```bash
npm install playwright chrome-cookies-secure
```

Then install the Playwright Chromium browser binary:
```bash
npx playwright install chromium
```

### OS Notes

#### macOS
- If you want Chrome cookie extraction (`chrome-cookies-secure`), you may need to grant your terminal **Full Disk Access** in `System Settings → Privacy & Security`.
- Playwright interactive login works without extra permissions.
- Xcode command line tools may be required for native builds:
  ```bash
  xcode-select --install
  ```

#### Windows
- Works out of the box with Node.js + Playwright.
- Chrome cookies are read from `%LOCALAPPDATA%\Google\Chrome\User Data\`.
- No extra permissions required for most setups.

#### Linux
- Playwright requires some system libraries:
  ```bash
  sudo apt-get install -y libgbm-dev libx11-dev libxcomposite-dev \
    libxrandr-dev libxss-dev libasound2 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libnss3 libxdamage1
  ```
- Chrome cookie access may fail if cookies are encrypted differently on your distro.

---

## Usage

```bash
# Example run (with auto-auth via Playwright or Chrome cookies)
node workflows_dump.js

# Provide an explicit base URL
WF_BASE="https://ooo.workflows.oktapreview.com" node workflows_dump.js

# If you already have a token, skip Playwright and Chrome:
WF_AUTH_TOKEN="your_auth_token_here" node workflows_dump.js
```

Outputs:
- `exports/<group_name>/<group_name>.folder` → Flow bundles
- `exports/<group_name>/<stash_name>.csv` → Stash table exports
- `workflows_dump.json` → Manifest with org and export metadata

---

## Environment Variables

| Variable            | Description                              | Default |
|---------------------|------------------------------------------|---------|
| `WF_BASE`           | Okta Workflows base URL                  | `https://ooo.workflows.oktapreview.com` |
| `WF_HOST`           | Alternate hostname                       | —       |
| `WF_AUTH_TOKEN`     | Use a known `auth_token` directly        | —       |
| `WF_OUT_JSON`       | Path to manifest JSON                    | `workflows_dump.json` |
| `WF_OUT_DIR`        | Export root directory                    | `exports` |
| `WF_TIMEOUT`        | Request timeout (seconds)                | `60`    |
| `WF_SLEEP`          | Delay between requests (seconds)         | `0.15`  |
| `WF_GROUP_FILTER`   | Filter groups by substring (case-insens) | —       |
| `WF_DEBUG`          | Debug logging (`1` = on)                 | `0`     |
| `WF_USE_PLAYWRIGHT` | Enable Playwright fallback               | `1`     |
| `WF_MAX_WORKERS`    | Max concurrent workers                   | `8`     |

---

## Example Workflow

1. Run `node workflows_dump.js`  
2. Playwright launches a browser for login/MFA the first time  
3. Script collects `auth_token`, exports flows and tables  
4. Manifest written to `workflows_dump.json`

On subsequent runs, the saved Playwright profile allows **headless export** without login.

---

## Summary

This tool helps Okta admins:
- Back up Workflows for compliance
- Safely experiment with flows knowing they’re recoverable
- Migrate flows between tenants
