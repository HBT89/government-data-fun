# Hooking a consumer up

Two tiers, two very different contracts. A consumer reads the public index
without asking anyone, and reads the curated tier only if it has been given a
token.

| | Public index | Curated tier |
|---|---|---|
| What | person, org, filing entities; shards; reverse lookup | parsed filing contents |
| Origin | GitHub Pages, fronted by `/xref` | `/curated`, from the private repo |
| Auth | none | `Authorization: Bearer <token>` |
| CORS | any origin | configured origins only |
| Cached | one hour at the edge | never, `private, no-store` |

## Public index

```
VITE_XREF_BASE_URL=https://hbt89.github.io/government-data-fun/data
```

or through the Worker, same files with an edge cache in front:

```
VITE_XREF_BASE_URL=https://opengov-proxy.psjs.workers.dev/xref
```

Resolve, then dereference. The consumer never searches:

```js
const xref = await fetch(`${BASE}/index/xref.json`).then((r) => r.json());
const ref = xref.xref['congress:A000379'];              // "p:A000379"
const person = await fetch(`${BASE}/person/${ref.slice(2)}.json`).then((r) => r.json());
```

Fetch the shard, not the whole file. `person.json` and `filing.json` are 888KB
between them; the largest shard is 7.2KB.

## Curated tier

Free of charge and without expiry, but not public. It carries the contents of
financial disclosure reports, and 5 U.S.C. app. 105(c) binds each person who
obtains or uses one, independently of anyone else.

```
VITE_CURATED_BASE_URL=https://opengov-proxy.psjs.workers.dev/curated
VITE_CURATED_TOKEN=<the token>
```

```js
async function curated(path = 'transactions.json') {
  const res = await fetch(`${import.meta.env.VITE_CURATED_BASE_URL}/${path}`, {
    headers: { Authorization: `Bearer ${import.meta.env.VITE_CURATED_TOKEN}` },
  });
  if (res.status === 401) throw new Error('curated: token rejected');
  if (res.status === 503) throw new Error('curated: server not configured');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`curated: ${res.status}`);
  return res.json();
}
```

### A token in a Vite build is not a secret

Anything prefixed `VITE_` is inlined into the bundle and shipped to the
browser, so a browser-side consumer cannot hold this token confidentially.
Whoever can load the app can read it and replay it.

That is tolerable only if the consumer is a server, or if you accept that the
curated tier is effectively readable by anyone who visits. If the intent is
that only the application reads it, the call belongs behind the consumer's own
backend, with the token held there and never sent to the browser:

```
CURATED_TOKEN=<the token>          # no VITE_ prefix: server-side only
```

This is the one place the authenticated design can be undone by how it is
wired, so it is worth deciding deliberately rather than by default.

## Serving side

```
wrangler secret put CURATED_TOKEN     # what the consumer presents
wrangler secret put GITHUB_TOKEN      # read-only PAT for the curated repo
```

Then add the consumer's origin to `CURATED_ALLOWED_ORIGINS` in
`wrangler.toml` and deploy. With `CURATED_TOKEN` unset the route answers 503
rather than serving anything, so a half-configured deploy cannot expose the
tier.

Rotation is one `wrangler secret put` and one consumer redeploy. There is no
token list and no revocation beyond rotating, which is the right shape for a
handful of named consumers and the wrong one for many.

`node proxy/test-curated-route.mjs` covers the refusals: unauthenticated
requests never reach the private repository, an unset secret fails closed, the
GitHub credential never appears in a response, and no origin outside the
configured list can read one.
