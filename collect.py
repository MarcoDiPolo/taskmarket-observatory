"""Build a public read-only snapshot using Python 3.10+ and its standard library."""

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json
import os
import re
import tempfile
import time


API = 'https://api.taskmarket.dev/api/'
OUTPUT = Path(__file__).resolve().parent / 'data' / 'market.json'
NETWORKS = {'tempo': (4217, 'Tempo', 'OUSD'), 'base': (8453, 'Base', 'USDC')}
RANGES = ('7d', '30d', '90d', 'all')
HEADLINES = ('registeredWorkers', 'activeWorkers7d', 'activeAgents7d', 'openTasks', 'paidWorkers', 'activeWallets')
FEED_SIZE = 15
MAX_FEED_PAGES = 12


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def utc(iso):
    d = datetime.fromisoformat(iso.replace('Z', '+00:00'))
    if d.tzinfo is None:
        raise ValueError('Missing time zone')
    return d.astimezone(timezone.utc)


def integer(value):
    if type(value) is int and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r'[0-9]+', value):
        return int(value)
    raise ValueError('Expected nonnegative integer API value')


def tokens(value):
    return integer(value) / 1_000_000


def retry_delay(header, attempt):
    delay = 2 ** (attempt + 1)
    if header:
        try:
            delay = max(delay, int(header))
        except ValueError:
            delay = max(delay, (parsedate_to_datetime(header) - datetime.now(timezone.utc)).total_seconds())
    # An extended rate limit cancels this refresh. Keep serving the last complete snapshot.
    if delay > 60:
        raise RuntimeError('Source requested a longer cooldown; retry on the next refresh')
    return delay


def get(path, chain, **params):
    url = API + path + '?' + urlencode({'chainId': chain, **params})
    req = Request(url, headers={'User-Agent': 'Taskmarket-Market-Observatory/1.0', 'Accept': 'application/json'})
    for attempt in range(5):
        try:
            with urlopen(req, timeout=30) as response:
                result = json.load(response)
            if isinstance(result, dict) and result.get('error'):
                raise ValueError(f'API returned an error for {path}')
            return result
        except HTTPError as exc:
            if exc.code not in (408, 429, 500, 502, 503, 504) or attempt == 4:
                raise
            time.sleep(retry_delay(exc.headers.get('Retry-After'), attempt))
        except (TimeoutError, URLError):
            if attempt == 4:
                raise
            time.sleep(2 ** (attempt + 1))


def next_cursor(page, visited):
    cursor = page.get('nextCursor')
    if not cursor or cursor in visited:
        raise ValueError('Missing or repeated pagination cursor')
    visited.add(cursor)
    return cursor


def catalog(chain):
    references = {}
    daily_tasks, daily_reward, weekly_tasks = Counter(), Counter(), Counter()
    weekly_posters = defaultdict(set)
    statuses, modes = Counter(), Counter()
    cursor, visited = None, set()
    while True:
        page = get('tasks', chain, sort='newest', limit=100, **({'cursor': cursor} if cursor else {}))
        for task in page['tasks']:
            if task['chainId'] != chain:
                raise ValueError('Task page contains another chain')
            task_id = task['id'].lower()
            if task_id in references:
                continue
            reference = task.get('referenceCode') or ''
            references[task_id] = reference if re.fullmatch(r'TSK-[A-Z0-9]+', reference) else None
            day = utc(task['createdAt']).date()
            week = (day - timedelta(days=day.weekday())).isoformat()
            daily_tasks[day.isoformat()] += 1
            daily_reward[day.isoformat()] += integer(task['reward'])
            weekly_tasks[week] += 1
            address = task['requester']
            if not re.fullmatch(r'0x[0-9a-fA-F]{40}', address):
                raise ValueError('Invalid requester in a public task')
            weekly_posters[week].add(address.lower())
            statuses[task['status']] += 1
            modes[task['mode']] += 1
        if page['hasMore'] is False:
            break
        if page['hasMore'] is not True or not page['tasks']:
            raise ValueError('Incomplete task pagination')
        cursor = next_cursor(page, visited)

    weeks = []
    if weekly_tasks:
        week = date.fromisoformat(min(weekly_tasks))
        last = datetime.now(timezone.utc).date()
        while week <= last:
            key = week.isoformat()
            weeks.append({'week': key, 'posters': len(weekly_posters[key]), 'tasks': weekly_tasks[key]})
            week += timedelta(weeks=1)
    return references, daily_tasks, daily_reward, weeks, statuses, modes


def series(chain, period, daily_tasks, daily_reward):
    points = []
    seen = set()
    for item in get('stats/platform-time-series', chain, range=period, bucket='day'):
        key = date.fromisoformat(item['bucket']).isoformat()
        if key in seen:
            raise ValueError('Repeated daily bucket')
        seen.add(key)
        points.append({'date': key, 'activeAgents': integer(item['activeAgents']),
                       'tasks': integer(item['tasksCreated']), 'rewards': tokens(item['rewardVolume']),
                       'paid': tokens(item['paidVolume']), 'completed': integer(item['completedTasks']),
                       'settlements': integer(item['settlements']), 'newAgents': integer(item['newAgents']),
                       'ratings': integer(item['ratings']), 'chainTasks': daily_tasks[key],
                       'chainRewards': tokens(daily_reward[key])})
    return sorted(points, key=lambda p: p['date'])


def heatmap(chain, period):
    raw = get('stats/activity-heatmap', chain, range=period, dimension='hourOfWeek')
    if set(map(int, raw['rowKeys'])) != set(range(7)) or set(map(int, raw['colKeys'])) != set(range(24)):
        raise ValueError('Unrecognized heatmap dimensions')
    grid = [[0] * 24 for _ in range(7)]
    seen = set()
    for cell in raw['cells']:
        index = row, col = int(cell['row']), int(cell['col'])
        if not 0 <= row < 7 or not 0 <= col < 24 or index in seen:
            raise ValueError('Invalid or repeated heatmap cell')
        seen.add(index)
        grid[row][col] = integer(cell['count'])
    return grid


def feed(chain, references):
    result, visited = [], set()
    cursor = None
    for _ in range(MAX_FEED_PAGES):
        page = get('stats/activity-feed', chain, limit=50, **({'cursor': cursor} if cursor else {}))
        for event in page['items']:
            if event.get('chainId') != chain:
                continue
            task_id = (event.get('taskId') or '').lower()
            kind = event['type']
            # Only include structured market fields. Never publish free-text titles or actor addresses.
            if not re.fullmatch(r'[a-z0-9_]+', kind):
                raise ValueError('Unexpected feed event type')
            timestamp = utc(event['timestamp']).isoformat().replace('+00:00', 'Z')
            amount = event.get('amount')
            result.append({'type': kind, 'at': timestamp, 'title': references.get(task_id),
                           'amount': tokens(amount) if amount is not None else None})
            if len(result) == FEED_SIZE:
                return result
        if not page.get('nextCursor') or not page['items']:
            break
        cursor = next_cursor(page, visited)
    return result


def breakdown(counter, key):
    return [{key: k, 'count': v} for k, v in sorted(counter.items(), key=lambda pair: (-pair[1], pair[0]))]


def collect_chain(chain, name, token):
    refs, tasks, reward, weeks, statuses, modes = catalog(chain)
    stats = get('market/stats', chain)
    reported = get('stats/breakdowns', chain)
    official = {key: [{key: r[key], 'count': integer(r['count'])} for r in reported[key]]
                for key in ('status', 'mode', 'actorType')}
    ranges = {r: {'series': series(chain, r, tasks, reward), 'heatmap': heatmap(chain, r)} for r in RANGES}
    return {'id': chain, 'name': name, 'token': token, 'stats': {k: integer(stats[k]) for k in HEADLINES},
            'breakdowns': {'status': breakdown(statuses, 'status'), 'mode': breakdown(modes, 'mode'),
                           'actorType': official['actorType']}, 'reportedBreakdowns': official,
            'ranges': ranges, 'feed': feed(chain, refs), 'weeks': weeks, 'taskCount': len(refs)}


def main():
    started_at = now()
    chains = {key: collect_chain(*network) for key, network in NETWORKS.items()}
    output = {'startedAt': started_at, 'asOf': now(), 'chains': chains}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=OUTPUT.parent, delete=False, mode='w', encoding='utf-8') as tmp:
        tmpfile = Path(tmp.name)
        try:
            json.dump(output, tmp, ensure_ascii=True, allow_nan=False, separators=(',', ':'))
            tmp.close()
            os.replace(tmpfile, OUTPUT)
        finally:
            tmpfile.unlink(missing_ok=True)
    for chain in chains.values():
        print(f"{chain['name']}: {chain['taskCount']} public tasks; {len(chain['feed'])} activity events")
    print(f"Complete snapshot: {output['asOf']}")


if __name__ == '__main__':
    main()
