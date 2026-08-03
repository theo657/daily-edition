# The Daily Edition

A single-URL morning paper assembled from feeds you chose, built once a day at
06:30 Rome time, with comment pages excluded by construction rather than by
willpower.

Nothing is fetched when you open the page. A scheduled job pulls every feed
server-side, clusters the same story across outlets, ranks what survives, and
writes `edition.json`. The page just reads that file, so it loads instantly on
a bad connection and there is no proxy, no API key, and no third-party service
in the path.

---

## Setup, about fifteen minutes

### 1. Create the repository

Sign in to GitHub, click **New repository**, name it `daily-edition`, and set it
to **Public**.

> **Why public.** GitHub Pages on a private repository requires a paid plan
> (GitHub Pro, currently around $4 a month). The repository contains no
> credentials and no personal data, but `feeds.json` does list the subjects you
> want promoted, which is mildly revealing about your interests. If that
> bothers you, two alternatives: pay for Pro and keep it private, or host the
> same files on Cloudflare Pages, which serves from a private repository at no
> cost. Say the word and I will write the Cloudflare variant.

### 2. Upload the files

On the empty repository page, click **uploading an existing file**, then drag in
everything from this folder, including the hidden `.github` directory. If the
browser will not accept the hidden folder, use the command line instead:

```bash
git init
git add .
git commit -m "Initial edition"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/daily-edition.git
git push -u origin main
```

### 3. Let the workflow write to the repository

**Settings → Actions → General → Workflow permissions** → select
**Read and write permissions** → **Save**.

The build commits `edition.json` each morning. Without this it will fail at the
last step every day.

### 4. Turn on Pages

**Settings → Pages → Build and deployment → Source: Deploy from a branch**,
branch `main`, folder `/ (root)` → **Save**.

Your URL will be `https://YOUR-USERNAME.github.io/daily-edition/`. It takes a
minute or two to go live the first time.

### 5. Build the first edition now

**Actions → Build the edition → Run workflow → Run workflow.**

Watch it run. The summary at the end tells you how many items each feed
returned and names any feed that failed. Expect one or two failures on the
first run: feeds move, and the list in `feeds.json` was validated in July 2026.

### 6. Put it on your devices

- **Mac**: bookmark the URL in Chrome, or set it as your new tab page.
- **iOS**: open the URL in Safari, tap Share, then **Add to Home Screen**. It
  launches full-screen without browser furniture and behaves like an app.

Read state is stored in the browser, so the Mac and the phone track separately.
That is deliberate: syncing would need a backend, an account, and a thing that
can break.

### How read state works

Opening a story marks it read. You do not tick anything: click the headline, it
opens in a new tab and greys out behind you, so if you come back at lunch you
can see where you got to. The circle beside each story is there for the other
case, where you have read the headline and do not need to open it.

**Hide read** collapses everything you have been through. Nothing disappears
while you are clicking it, only on the next reload, because a story vanishing
from under the cursor is disorienting.

---

## Living with it

### Tuning what gets promoted

Everything editorial lives in `feeds.json`. Edit it in the GitHub web interface
(click the file, then the pencil icon) and the next build picks it up. You can
do this from your phone when something annoys you at breakfast.

- **`promote`** — terms that push a story up, with a weight. Your Cirkular
  vocabulary is already in there: biochar, carbon removal, Colombia, Article 6.
- **`demote`** — terms that push a story down. `opinion:` and `comment:` carry a
  weight of 3.0, which is usually enough to bury a comment piece below the
  quota line. Royals, reality television, and shopping content are also down
  there. If something keeps appearing that you do not want, add a term.
- **`block`** — dropped before clustering, never reaching the edition at any
  score. Demoted items still sit in the pool and can surface on a quiet day;
  blocked items cannot. `unless` reprieves an item, which is how the serious
  version of a blocked subject still gets through. The royal block currently
  kills personality coverage outright while letting anything touching the
  sovereign grant, the duchies, parliament, tax, a court ruling, or a police
  investigation through.
- **`exceptFeeds`** — exempts named outlets from a demote rule. Carbon Brief
  prefixes its data explainers with "Analysis:", which is the opposite of
  comment-page filler, so it is exempt from that rule.
- **`quota`** — how many stories each section shows. Raise it if a section feels
  thin, lower it if you are not clearing the edition.
- **`weight`** on a feed — how much that outlet's word counts. The 42 sits at
  1.4 because you pay for it.

### When a feed dies

The page shows a note at the bottom naming any feed that failed, and the
Actions run summary says why. Feeds break for boring reasons: a publisher moves
a URL, or a redirect stops resolving. Fix it by editing that one line in
`feeds.json`. If a publisher drops RSS entirely, delete the line.

Known state at the time of building:

- **Associated Press** has no working public feed and is not included. Every
  route that search surfaces is a third-party scraper.
- **The 42** publishes no rugby-only feed, so the build takes their site-wide
  feed, keeps anything with `/rugby/` in the URL for the rugby section, and
  sends the rest to Other sport. Their paid pieces arrive as headline and link;
  clicking through works on a device where you are signed in.
- **Carbon Herald** could not be verified and is flagged `unverified` in the
  config. If it fails on the first run, delete the line.

### Reading the meta line

`BBC World · 2 hours ago · 3 outlets · France 24, Al Jazeera` means three
separate newsrooms filed this story, and the other two are one click away. A
story carried by one outlet and nobody else is not necessarily wrong, but it is
worth knowing which it is. That is the corroboration signal doing the work an
editor's news judgement used to do for you.

---

## What it does not do

There is no written editor's note. The ranking is arithmetic: corroboration
across outlets, source weight, recency decay with a fourteen-hour half life,
and your promote and demote terms. Every score is visible in `edition.json`
under `reasons`, so you can always see why something ranked where it did.

A genuine written brief would need a language model in the build step, which
means an API key and a running cost of a few cents a day. The hook is already
in place if you decide you want it.

---

## Files

| File | What it is |
|---|---|
| `feeds.json` | Sources, sections, quotas, promote and demote terms. The editorial policy |
| `build.mjs` | Fetch, parse, cluster, score, rank. No dependencies |
| `index.html` | The page. Read state, progress, long-form shelf |
| `edition.json` | Today's edition, rewritten each morning by the build |
| `.github/workflows/build.yml` | The daily schedule |
| `test/fixtures/` | Sample feeds for testing changes without hitting the network |

To test a change to the scoring without waiting for tomorrow:

```bash
node build.mjs --offline test/fixtures --dry --now 2026-07-31T10:00:00Z
```

The fixtures carry fixed dates, so `--now` pins the clock to keep them inside
the freshness window however long from now you run the test. Drop `--dry` and
add `--force` to write a real `edition.json` you can open locally.
