/**
 * Open signup via GitHub OAuth.
 *
 * The store is keyed on (provider, provider_id), so signup only has to prove
 * "this is GitHub account N" and hand back a token. GitHub rather than an
 * email form on purpose: an open edge shares an IP with whatever else the box
 * serves, so abuse needs to point at an account that can be blocked and that
 * cost something to create.
 *
 * No new dependencies — global fetch, node:crypto, and hand-rolled cookie
 * handling, so deploying stays "rsync a dist/ and npm ci".
 */
import crypto from 'crypto';
import express from 'express';
import type { Express, Request, Response } from 'express';
import { Store } from './store';

// Overridable so the flow can be exercised end-to-end against a stub; unset,
// these are GitHub's real endpoints.
const OAUTH_BASE = process.env.GITHUB_OAUTH_BASE || 'https://github.com';
const API_BASE = process.env.GITHUB_API_BASE || 'https://api.github.com';

const AUTHORIZE_URL = `${OAUTH_BASE}/login/oauth/authorize`;
const TOKEN_URL = `${OAUTH_BASE}/login/oauth/access_token`;
const USER_URL = `${API_BASE}/user`;

// Cloudflare Turnstile. The GitHub handoff below is one redirect away from
// minting a real account, so it is the surface a bot would drive; siteverify
// runs here, server side, because a browser-side check proves nothing.
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Must match `data-action` on the widget; verified in the response. */
const TURNSTILE_ACTION = 'signup';
const TURNSTILE_TIMEOUT_MS = 10_000;
/** Real tokens run a few hundred bytes; the cap just bounds the parse. */
const TURNSTILE_MAX_TOKEN = 2048;
/** Turnstile tokens are small — the form carries nothing else of size. */
const SIGNUP_BODY_LIMIT = '8kb';

/** Signups allowed from one IP inside the window. */
const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

const STATE_COOKIE = 'pse_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;

export interface TurnstileConfig {
  sitekey: string;
  secret: string;
  /**
   * Frontend hostnames siteverify is allowed to report back. One widget covers
   * localhost and production, so this — not the widget — is what stops a token
   * minted on a laptop from being replayed against the public edge. A
   * production value must never contain localhost or 127.0.0.1.
   */
  hostnames: Set<string>;
}

/**
 * `null` is "deliberately off". `'invalid'` is "half-configured", which is the
 * dangerous shape: the page would look protected while verifying nothing.
 */
export type TurnstileSetup = TurnstileConfig | null | 'invalid';

export interface SignupConfig {
  clientId: string;
  clientSecret: string;
  /** Public origin, e.g. `https://portscanner.kreativekorna.com`. */
  baseUrl: string;
  /** Shown on the signup page so people know where to report abuse. */
  abuseContact?: string;
  turnstile: TurnstileSetup;
}

function turnstileFromEnv(): TurnstileSetup {
  const sitekey = process.env.TURNSTILE_SITEKEY?.trim();
  const secret = process.env.TURNSTILE_SECRET?.trim();
  const hostnames = new Set(
    (process.env.TURNSTILE_HOSTNAMES ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
  );

  // Nothing set at all: a self-hoster who has no Cloudflare account still gets
  // a working signup, exactly as before Turnstile existed.
  if (!sitekey && !secret && hostnames.size === 0) return null;

  if (!sitekey || !secret || hostnames.size === 0) {
    console.error(
      'turnstile: half-configured — set TURNSTILE_SITEKEY, TURNSTILE_SECRET and ' +
        'TURNSTILE_HOSTNAMES together, or none of them. Signup is disabled until ' +
        'this is fixed; tunnels are unaffected.'
    );
    return 'invalid';
  }
  return { sitekey, secret, hostnames };
}

export function signupConfigFromEnv(baseUrl: string): SignupConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    baseUrl,
    abuseContact: process.env.ABUSE_CONTACT,
    turnstile: turnstileFromEnv(),
  };
}

/** Route names that must never be treated as tunnel ids. */
export const SIGNUP_ROUTES = ['signup', 'auth'];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Signed, self-contained CSRF state: `<nonce>.<issuedAt>.<hmac>`. Carrying the
 * signature means no server-side session table just to survive a redirect.
 */
function makeState(secret: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const issued = Date.now().toString(36);
  const body = `${nonce}.${issued}`;
  const mac = crypto.createHmac('sha256', secret).update(body).digest('hex').slice(0, 32);
  return `${body}.${mac}`;
}

function stateIsValid(state: string, secret: string): boolean {
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, issued, mac] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${nonce}.${issued}`)
    .digest('hex')
    .slice(0, 32);
  // Constant-time — a timing oracle on the MAC would let state be forged.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const at = parseInt(issued, 36);
  return Number.isFinite(at) && Date.now() - at < STATE_TTL_MS;
}

const signupHits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (signupHits.get(ip) ?? []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  if (hits.length >= SIGNUP_LIMIT) {
    signupHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  signupHits.set(ip, hits);
  return false;
}

// Unbounded maps are a slow leak on a public endpoint; drop cold IPs.
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of signupHits) {
    const live = hits.filter((t) => now - t < SIGNUP_WINDOW_MS);
    if (live.length === 0) signupHits.delete(ip);
    else signupHits.set(ip, live);
  }
}, SIGNUP_WINDOW_MS).unref();

interface SiteverifyResult {
  success?: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
}

/**
 * Canonical server-side siteverify. Returns true only for a token that
 * Cloudflare accepts, that was minted for this action, and that was minted on
 * a hostname we serve. Every other outcome — including "Cloudflare is
 * unreachable" — is false: an edge that cannot check is an edge that cannot
 * tell a person from a script, and it should not be issuing tokens.
 *
 * Tokens are single-use. Cloudflare redeems one here, so a replay of the same
 * token comes back `success: false` with `timeout-or-duplicate`.
 */
async function verifyTurnstile(
  cfg: TurnstileConfig,
  token: unknown,
  clientIp: string | undefined
): Promise<boolean> {
  if (typeof token !== 'string' || token.length === 0 || token.length > TURNSTILE_MAX_TOKEN) {
    return false;
  }

  const body = new URLSearchParams({ secret: cfg.secret, response: token });
  if (clientIp) body.set('remoteip', clientIp);

  let result: SiteverifyResult;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
      body,
    });
    if (!res.ok) throw new Error(`siteverify returned ${res.status}`);
    result = (await res.json()) as SiteverifyResult;
  } catch (err) {
    console.warn(`turnstile: ${(err as Error).message} — failing closed`);
    return false;
  }

  if (
    result.success !== true ||
    result.action !== TURNSTILE_ACTION ||
    !cfg.hostnames.has(result.hostname ?? '')
  ) {
    console.warn(
      `turnstile: rejected (success=${result.success} action=${result.action} ` +
        `hostname=${result.hostname} codes=${(result['error-codes'] ?? []).join(',') || 'none'})`
    );
    return false;
  }
  return true;
}

function page(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 42rem;
         margin: 4rem auto; padding: 0 1.5rem; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  pre { background: color-mix(in srgb, currentColor 8%, transparent); padding: 1rem;
        border-radius: 4px; overflow-x: auto; }
  .btn { display: inline-block; padding: .6rem 1.1rem; border-radius: 4px;
         background: #24292f; color: #fff; text-decoration: none; font-weight: 600;
         border: 0; font-family: inherit; font-size: 1rem; cursor: pointer; }
  .muted { opacity: .7; font-size: .9em; }
  .warn { border-left: 3px solid #d97706; padding-left: 1rem; }
  .cf-turnstile { margin: 1.25rem 0 1rem; }
</style>${head}</head><body>${body}</body></html>`;
}

export function mountSignup(app: Express, store: Store, config: SignupConfig | null, wsUrl: string): void {
  const callbackUrl = config ? `${config.baseUrl}/auth/github/callback` : '';
  // Ties the CSRF state to this process's lifetime and to the client secret,
  // so states cannot be replayed across a credential rotation.
  const stateSecret = crypto
    .createHash('sha256')
    .update((config?.clientSecret ?? 'disabled') + crypto.randomBytes(8).toString('hex'))
    .digest('hex');

  const disabled = (res: Response) =>
    res
      .status(503)
      .type('html')
      .send(
        page(
          'Signup unavailable',
          `<h1>Signup is not configured</h1>
           <p>This edge has no GitHub OAuth credentials, so it cannot issue tokens yet.</p>
           <p class="muted">Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code>
           in <code>/etc/portscanner-edge.env</code> and restart the service.</p>`
        )
      );

  // Half-configured Turnstile takes signup offline rather than serving a page
  // that looks challenged and verifies nothing. Tunnels keep running.
  const misconfigured = (res: Response) =>
    res
      .status(503)
      .type('html')
      .send(
        page(
          'Signup unavailable',
          `<h1>Signup is temporarily closed</h1>
           <p>The bot check on this edge is misconfigured, so signup is disabled
           until an operator fixes it. Existing tunnels are unaffected.</p>`
        )
      );

  /**
   * Every signup route funnels through here first. Returns the config so the
   * handler body can use it without re-checking that it exists.
   */
  const ready = (res: Response): SignupConfig | null => {
    if (!config) { disabled(res); return null; }
    if (config.turnstile === 'invalid') { misconfigured(res); return null; }
    return config;
  };

  const turnstile = config && config.turnstile !== 'invalid' ? config.turnstile : null;
  const turnstileHead = turnstile
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : '';

  app.get('/signup', (_req: Request, res: Response) => {
    const cfg = ready(res);
    if (!cfg) return;
    res.type('html').send(
      page(
        'Get a tunnel token',
        `<h1>Port Scanner tunnels</h1>
         <p>Expose a port on your machine at a public URL. Sign in with GitHub and
         you'll get a token to paste into the app.</p>
         <form method="POST" action="/auth/github">${
           turnstile
             ? `<div class="cf-turnstile" data-sitekey="${esc(turnstile.sitekey)}"
                     data-action="${TURNSTILE_ACTION}"></div>`
             : ''
         }
           <button class="btn" type="submit">Continue with GitHub</button>
         </form>
         <p class="muted">Read-only access to your public profile — no scopes requested.
         Your GitHub id is stored so an account can be blocked if it is abused.</p>
         <div class="warn">
           <p class="muted">Tunnels are public to anyone holding the URL. Don't expose
           anything you wouldn't put on the open internet.${
             cfg.abuseContact
               ? ` Report abuse: <code>${esc(cfg.abuseContact)}</code>.`
               : ''
           }</p>
         </div>`,
        turnstileHead
      )
    );
  });

  // The Turnstile token has to ride in a body, so this is a POST and the
  // signup page posts a form to it. A bare GET can no longer start the flow;
  // send anyone holding an old link back to the page that can.
  app.get('/auth/github', (_req: Request, res: Response) => res.redirect(303, '/signup'));

  // Scoped to this one route on purpose. Mounting a body parser globally would
  // put it in front of the tunnel catch-all in server.ts, which proxies request
  // bodies through untouched — consuming them here would break every tunnel.
  const parseForm = express.urlencoded({ extended: false, limit: SIGNUP_BODY_LIMIT });

  app.post('/auth/github', parseForm, async (req: Request, res: Response) => {
    const cfg = ready(res);
    if (!cfg) return;

    const ip = req.ip;

    // Turnstile first, then the rate limiter. A human who fails the challenge
    // and retries shouldn't burn their five signups an hour on the attempts.
    if (turnstile) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ok = await verifyTurnstile(turnstile, body['cf-turnstile-response'], ip);
      if (!ok) {
        return res.status(403).type('html').send(
          page(
            'Verification failed',
            `<h1>Couldn't verify that you're human</h1>
             <p>The bot check didn't pass, or it expired before you submitted.</p>
             <p><a href="/signup">Try again</a></p>`
          )
        );
      }
    }

    if (rateLimited(ip || 'unknown')) {
      return res.status(429).type('html').send(
        page('Slow down', `<h1>Too many signups</h1><p>Try again later.</p>`)
      );
    }

    const state = makeState(stateSecret);
    const secure = cfg.baseUrl.startsWith('https://') ? ' Secure;' : '';
    res.setHeader(
      'Set-Cookie',
      `${STATE_COOKIE}=${state}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=600`
    );

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('state', state);
    // No scope: the default grant already exposes the public profile, which is
    // all we need to identify the account.
    res.redirect(url.toString());
  });

  app.get('/auth/github/callback', async (req: Request, res: Response) => {
    const cfg = ready(res);
    if (!cfg) return;

    const fail = (status: number, msg: string) =>
      res.status(status).type('html').send(
        page('Signup failed', `<h1>Signup failed</h1><p>${esc(msg)}</p>
             <p><a href="/signup">Start over</a></p>`)
      );

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const cookie = parseCookies(req.headers.cookie)[STATE_COOKIE];

    // Clear the state cookie either way — it is single-use.
    res.setHeader('Set-Cookie', `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);

    if (!code) return fail(400, 'GitHub did not send an authorization code.');
    if (!state || !cookie || state !== cookie || !stateIsValid(state, stateSecret)) {
      return fail(400, 'This signup link expired or did not start here. Try again.');
    }

    let login: string;
    let githubId: string;
    try {
      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code,
          redirect_uri: callbackUrl,
        }),
      });
      const tokenBody = (await tokenRes.json()) as {
        access_token?: string;
        error_description?: string;
      };
      if (!tokenBody.access_token) {
        return fail(502, tokenBody.error_description || 'GitHub refused the code exchange.');
      }

      const userRes = await fetch(USER_URL, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'port-scanner-edge',
        },
      });
      if (!userRes.ok) return fail(502, 'Could not read your GitHub profile.');
      const user = (await userRes.json()) as { id?: number; login?: string };
      if (!user.id || !user.login) return fail(502, 'GitHub profile was incomplete.');
      login = user.login;
      githubId = String(user.id);
    } catch {
      return fail(502, 'Could not reach GitHub. Try again in a moment.');
    }

    const account = store.upsertUser('github', githubId, login);
    if (account.status === 'blocked') {
      return fail(403, 'This account is blocked.');
    }

    const token = store.issueToken(account.id, 'signup');
    console.log(`signup → ${login} (github:${githubId}) user ${account.id}`);

    // Shown once and never recoverable — only the hash is stored.
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      page(
        'Your tunnel token',
        `<h1>You're set, ${esc(login)}</h1>
         <p>Paste this into the app's <strong>Edit Edge Config…</strong> file, then pick
         <strong>Restart Server</strong>:</p>
         <pre>EDGE_WS_URL=${esc(wsUrl)}
EDGE_TOKEN=${esc(token)}</pre>
         <p class="warn"><strong>Copy it now.</strong> Only a hash is stored, so this token
         cannot be shown again. Losing it just means signing in again for a new one.</p>
         <p class="muted">Up to ${account.maxTunnels} tunnels at once.${
           cfg.abuseContact ? ` Questions or abuse: <code>${esc(cfg.abuseContact)}</code>.` : ''
         }</p>`
      )
    );
  });
}
