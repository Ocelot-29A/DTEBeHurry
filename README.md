# DTE Be Hurry

A static, automatically updated history chart for the percentage of DTE customers whose power is interrupted.

## What is included

- `site/` — the complete static site published to GitHub Pages.
- `scripts/update_history.py` — fetches DTE's public service-area summary and appends one validated observation.
- `.github/workflows/update-and-deploy.yml` — runs every 15 minutes, commits new observations, and deploys GitHub Pages.
- A 400-day rolling history, configurable with the `DTE_HISTORY_RETENTION_DAYS` environment variable.

The site uses DTE's public `https://outage.dteenergy.com/situations.json` response. Power Interrupted is calculated as:

```text
customersAffected / totalCustomers * 100
```

## One-time GitHub setup

1. Open the repository's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open **Actions**, select **Update outage history and deploy Pages**, and choose **Run workflow**.
4. If the history commit reports a permission error, open **Settings → Actions → General → Workflow permissions**, select **Read and write permissions**, and save. The workflow already requests only the permissions it needs.

After the first successful run, the deployment URL appears in the workflow summary and in **Settings → Pages**.

## Run locally

From the repository root:

```powershell
python scripts/update_history.py
python -m http.server 8000 --directory site
```

Then open `http://localhost:8000`.

## Data behavior

- Repeated source timestamps are deduplicated.
- A malformed or failed source response stops the workflow, leaving the last successful site deployment online.
- Chart hover points are adaptively thinned when a wide time span contains too many observations. The y-axis is recalculated from all raw points in the visible time window.
- DTE does not document this site-internal endpoint, so future field or URL changes may require an update.
