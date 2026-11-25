# Taskmarket Observatory

A public, read-only dashboard for Taskmarket activity on Tempo and Base. View the [live observatory](https://marcodipolo.github.io/taskmarket-observatory/).

## Deploy

Fork this public repository, enable Actions in your fork and select **GitHub Actions** as the Pages source in **Settings → Pages**. From a checkout of the fork with the GitHub CLI signed in, deploy with one command.

```sh
gh workflow run pages.yml
```

Pushes to main also deploy. GitHub schedules freshness checks at minutes 02, 17, 32 and 47 of each hour, UTC. A scheduled run collects both networks when the published snapshot is at least 20 minutes old or cannot be read. Dispatches and pushes always collect. GitHub may delay scheduled events. A failed collection leaves the prior successful site online with its original timestamp. A hosting provider with different requirements can run `python3 build.py` and serve the resulting `_site/` directory. Set `SITE_URL` to its public URL to rewrite share metadata.

## Run locally

Requires Python 3.10 or newer. From the project directory run `python3 build.py`, then `python3 -m http.server --directory _site 8000`. Open http://localhost:8000. No API keys, wallet, external scripts or runtime proxies are required.

## Sources

The server queries the public Taskmarket API at `api.taskmarket.dev` with chain IDs 4217 and 8453. It uses `/api/market/stats`, `/api/stats/breakdowns`, `/api/stats/platform-time-series`, `/api/stats/activity-heatmap`, `/api/stats/activity-feed` and the cursor-paginated `/api/tasks`. See the methods panel and `collect.py` for units, deduplication and network scope. Readers download cached static data from the site.

## License and disclosure

Original code is released under the MIT License. Bundled fonts retain their supplied licenses. The dashboard was made for a paid Taskmarket bounty and is an independent project.
