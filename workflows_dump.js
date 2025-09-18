#!/usr/bin/env node
/**
 * Okta Workflows DUMP (Node.js, CommonJS)
 * - Auth: WF_AUTH_TOKEN -> Chrome cookies -> Playwright persistent profile
 * - Exports per-group .folder bundles and table CSVs
 * - Writes a manifest JSON (workflows_dump.json by default)
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { URL } = require("url");

// ========================= CONFIG =========================
const HOSTNAME = (process.env.WF_HOST || "").trim();
const ENV_BASE = (process.env.WF_BASE || "https://ooo.workflows.oktapreview.com").trim();
const OUT_JSON = path.resolve(process.env.WF_OUT_JSON || "workflows_dump.json");
const OUT_DIR = path.resolve(process.env.WF_OUT_DIR || "exports");
const TIMEOUT = parseInt(process.env.WF_TIMEOUT || "60", 10) * 1000;
const SLEEP_BETWEEN = parseFloat(process.env.WF_SLEEP || "0.15") * 1000;
const GROUP_FILTER = (process.env.WF_GROUP_FILTER || "").trim().toLowerCase();
const ENV_AUTH_TOKEN = (process.env.WF_AUTH_TOKEN || "").trim();
const DEBUG = process.env.WF_DEBUG === "1";
const USE_PLAYWRIGHT = (process.env.WF_USE_PLAYWRIGHT || "1") === "1";
const MAX_WORKERS = parseInt(process.env.WF_MAX_WORKERS || "8", 10);
const DROP_STASH_COLS = new Set(["stashId", "system"]);

// persistent profile for Playwright
const WF_PW_PROFILE_DIR =
  process.env.WF_PW_PROFILE_DIR || path.join(os.homedir(), ".okta-workflows-pw");
// ==========================================================

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sanitizeName(name) {
  name = (name || "").trim().replace(/ /g, "_");
  return (name.replace(/[^A-Za-z0-9._\\-]+/g, "_").slice(0, 200) || "unnamed");
}

function normalizeCookieValue(raw) {
  if (!raw) return "";
  let val = raw;
  // If it looks percent-encoded, decode once, then re-encode exactly once.
  const pctCount = (val.match(/%[0-9A-Fa-f]{2}/g) || []).length;
  if (pctCount >= 3 || val.includes("%25")) {
    try { val = decodeURIComponent(val); } catch (_) {}
  }
  try { return encodeURIComponent(val); } catch { return val; }
}

function extractWorkflowsBaseFromUrl(anyOktaUrl) {
  const parsed = new URL(anyOktaUrl);
  const host = parsed.hostname || "";
  const parts = host.split(".");
  if (parts.length < 2) throw new Error(`Cannot parse hostname from URL: ${anyOktaUrl}`);
  const sub = parts.length > 2 ? parts[0] : null;
  if (!sub) throw new Error(`Could not find Okta subdomain in: ${anyOktaUrl}`);
  const env = parts.includes("oktapreview") ? "oktapreview" : "okta";
  const hostname = `${sub}.workflows.${env}.com`;
  const base = `https://${hostname}`;
  return { base, hostname };
}

// -------------------- HTTP helpers (Node 18+ fetch) --------------------
async function httpGetJson(url, headers = {}) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), TIMEOUT);
  const res = await fetch(url, { headers, signal: ctl.signal, redirect: "follow" });
  clearTimeout(id);
  if (res.status === 401 || res.status === 403) {
    console.error("[ERROR] Unauthorized/Forbidden. Headers used:");
    console.error(headers);
    throw new Error("Unauthorized or forbidden.");
  }
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  return text.trim().startsWith("{") ? JSON.parse(text) : {};
}

async function httpGetBlob(url, headers = {}) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), TIMEOUT);
  const res = await fetch(url, { headers, signal: ctl.signal, redirect: "follow" });
  clearTimeout(id);
  if (res.status === 401 || res.status === 403) {
    console.error("[ERROR] Unauthorized during export. Headers used:");
    console.error(headers);
    throw new Error("Unauthorized/Forbidden during export.");
  }
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

// -------------------- Auth helpers --------------------
async function getAuthTokenFromChrome(hostname) {
  try {
    const ccs = require("chrome-cookies-secure"); // CJS
    const domain = `https://${hostname}`;
    const cookiesObj = await new Promise((resolve, reject) => {
      ccs.getCookies(domain, "object", (err, cookies) => (err ? reject(err) : resolve(cookies || {})));
    });
    const tok = cookiesObj["auth_token"];
    return tok ? normalizeCookieValue(tok) : "";
  } catch (e) {
    if (DEBUG) log(`[DEBUG] chrome-cookies-secure not available or failed: ${e.message}`);
    return "";
  }
}

async function waitForAuthCookie(ctx, base, attempts = 60, delayMs = 250) {
  for (let i = 0; i < attempts; i++) {
    const cookies = await ctx.cookies(base).catch(() => []);
    const tok = (cookies.find(c => c.name === "auth_token") || {}).value;
    if (tok) return tok;
    await sleep(delayMs);
  }
  return "";
}

async function getAuthTokenViaPlaywright(base) {
  if (!USE_PLAYWRIGHT) return "";
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch (e) { if (DEBUG) log(`[DEBUG] Playwright not available: ${e.message}`); return ""; }

  // Try headless with persistent profile
  try {
    if (DEBUG) log(`[DEBUG] Trying Playwright headless with profile dir: ${WF_PW_PROFILE_DIR}`);
    const ctx = await chromium.launchPersistentContext(WF_PW_PROFILE_DIR, {
      headless: true,
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/app/`, { waitUntil: "load" }).catch(() => {});
    const tok = await waitForAuthCookie(ctx, base, 60, 250);
    await ctx.close();
    if (tok) {
      if (DEBUG) log("[DEBUG] Headless Playwright found auth_token.");
      return normalizeCookieValue(tok);
    }
  } catch (e) {
    if (DEBUG) log(`[DEBUG] Headless PW attempt failed: ${e.message}`);
  }

  // Interactive fallback
  try {
    log("Opening browser to complete login/MFA (one-time). A window will appear…");
    const ctx = await chromium.launchPersistentContext(WF_PW_PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 900 },
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/app/`, { waitUntil: "load" }).catch(() => {});
    const tok = await waitForAuthCookie(ctx, base, 480, 500);
    await ctx.close();
    if (tok) {
      log("Captured auth_token. Future runs should work headless.");
      return normalizeCookieValue(tok);
    }
  } catch (e) {
    if (DEBUG) log(`[DEBUG] Interactive PW attempt failed: ${e.message}`);
  }
  return "";
}

async function obtainAuthToken(hostname, base) {
  if (ENV_AUTH_TOKEN) {
    if (DEBUG) log("[DEBUG] Using WF_AUTH_TOKEN from env");
    return normalizeCookieValue(ENV_AUTH_TOKEN);
  }
  const chromeTok = await getAuthTokenFromChrome(hostname);
  if (chromeTok) {
    if (DEBUG) log("[DEBUG] Using auth_token from Chrome cookie store");
    return chromeTok;
  }
  const viaPw = await getAuthTokenViaPlaywright(base);
  if (viaPw) {
    if (DEBUG) log("[DEBUG] Using Playwright-captured token");
    return viaPw;
  }
  return "";
}

function defaultHeaders(base, authToken) {
  return {
    "accept": "application/json",
    "x-requested-with": "XMLHttpRequest",
    "referer": `${base}/app/`,
    "user-agent": "okta-workflows-dump-node/1.0",
    "cookie": `auth_token=${authToken}`,
  };
}

// -------------------- API wrappers --------------------
async function fetchOrg(base, headers) {
  return httpGetJson(`${base}/app/api/org`, headers);
}

function extractOrgId(obj) {
  if (obj && typeof obj === "object") {
    for (const k of ["orgId", "org_id", "id"]) {
      if (Number.isInteger(obj[k])) return obj[k];
    }
    for (const key of ["org", "organization"]) {
      const inner = obj[key];
      if (inner && typeof inner === "object") {
        for (const kk of ["id", "orgId"]) {
          if (Number.isInteger(inner[kk])) return inner[kk];
        }
      }
    }
  }
  throw new Error("Could not determine orgId from /app/api/org response");
}

async function fetchGroups(base, orgId, headers) {
  const endpoints = [
    `${base}/app/api/group?org_id=${orgId}`,
    `${base}/app/api/groups?orgId=${orgId}`,
    `${base}/app/api/groups`,
    `${base}/app/api/org/${orgId}/groups`,
  ];
  let groups = [];
  for (const url of endpoints) {
    try {
      const data = await httpGetJson(url, headers);
      if (Array.isArray(data) && data.length) { groups = data; break; }
      if (data && typeof data === "object") {
        if (Array.isArray(data.groups)) { groups = data.groups; break; }
        const paths = [["data","groups"],["org","groups"],["organization","groups"]];
        for (const p of paths) {
          let cur = data, ok = true;
          for (const seg of p) {
            if (cur && typeof cur === "object" && seg in cur) cur = cur[seg];
            else { ok = false; break; }
          }
          if (ok && Array.isArray(cur)) { groups = cur; break; }
        }
      }
    } catch {}
    if (groups.length) break;
  }
  const norm = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const gid = g.id ?? g.groupId;
    const gname = g.name ?? g.groupName;
    if (gid != null && gname) {
      norm.push({ id: gid, name: gname });
    }
  }
  if (GROUP_FILTER) {
    return norm.filter(g => String(g.name).toLowerCase().includes(GROUP_FILTER));
  }
  return norm;
}

async function fetchStashesForGroup(base, orgId, groupId, headers) {
  const url = `${base}/app/api/stash?orgId=${orgId}&groupId=${groupId}`;
  try { return await httpGetJson(url, headers); } catch { return []; }
}

async function fetchStashRows(base, orgId, stashId, headers) {
  const urls = [
    `${base}/app/api/stash/${stashId}/row?orgId=${orgId}`,
    `${base}/app/api/stash/${stashId}/row?OrgId=${orgId}`, // case fallback
  ];
  for (const u of urls) {
    try { return await httpGetJson(u, headers); } catch {}
  }
  return {};
}

async function fetchStashMeta(base, orgId, stashId, headers) {
  const url = `${base}/app/api/stash/${stashId}?orgId=${orgId}`;
  try { return await httpGetJson(url, headers); } catch { return {}; }
}

async function downloadGroupExport(base, orgId, groupId, headers) {
  const url = `${base}/app/api/publisher/flopack/export?orgId=${orgId}&groupId=${groupId}&includeSubfolders=true`;
  return httpGetBlob(url, headers);
}

// -------------------- CSV helpers --------------------
function rowsToRecords(rowsPayload, meta) {
  const headersFromMeta = [];
  if (meta && typeof meta === "object") {
    let cols = null;
    if (Array.isArray(meta.columns)) cols = meta.columns;
    else if (meta.schema && Array.isArray(meta.schema.columns)) cols = meta.schema.columns;
    if (cols) {
      for (const c of cols) {
        const name = (c && typeof c === "object") ? c.name : String(c);
        if (name && !DROP_STASH_COLS.has(name)) headersFromMeta.push(String(name));
      }
    }
  }

  let rowsList = rowsPayload;
  if (rowsList && typeof rowsList === "object") {
    for (const k of ["rows", "data", "items", "result"]) {
      if (Array.isArray(rowsList[k])) { rowsList = rowsList[k]; break; }
    }
  }

  const records = [];
  if (Array.isArray(rowsList)) {
    if (rowsList.length && rowsList.every(r => r && typeof r === "object" && !Array.isArray(r))) {
      for (const r of rowsList) {
        const filtered = {};
        for (const [k, v] of Object.entries(r)) {
          if (!DROP_STASH_COLS.has(k)) filtered[k] = v;
        }
        records.push(filtered);
      }
    } else if (rowsList.length && rowsList.every(r => Array.isArray(r))) {
      const len = Math.max(...rowsList.map(r => r.length));
      let headers = headersFromMeta.length ? headersFromMeta.slice(0, len) : Array.from({ length: len }, (_, i) => `col${i + 1}`);
      headers = headers.filter(h => !DROP_STASH_COLS.has(h));
      for (const r of rowsList) {
        const rec = {};
        headers.forEach((h, i) => { rec[h] = (i < r.length ? r[i] : null); });
        records.push(rec);
      }
    } else {
      if (!DROP_STASH_COLS.has("value")) {
        for (const r of rowsList) records.push({ value: r });
      }
    }
  } else {
    if (!DROP_STASH_COLS.has("value")) {
      records.push({ value: rowsList });
    }
  }

  let headers;
  if (headersFromMeta.length) {
    headers = headersFromMeta.filter(h => !DROP_STASH_COLS.has(h));
  } else {
    const seen = new Set();
    headers = [];
    for (const rec of records) {
      for (const k of Object.keys(rec)) {
        if (!DROP_STASH_COLS.has(k) && !seen.has(k)) { seen.add(k); headers.push(k); }
      }
    }
    if (!headers.length && !DROP_STASH_COLS.has("value")) headers = ["value"];
  }
  headers = headers.filter(h => !DROP_STASH_COLS.has(h));
  return { headers, records };
}

async function writeCsv(csvPath, headers, rows) {
  await fsp.mkdir(path.dirname(csvPath), { recursive: true });
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [];
  lines.push(headers.map(esc).join(","));
  for (const rec of rows) {
    const line = headers.map(h => esc(rec[h]));
    lines.push(line.join(","));
  }
  await fsp.writeFile(csvPath, lines.join(os.EOL), "utf8");
}

// -------------------- tiny promise pool --------------------
async function mapPool(items, limit, worker) {
  const ret = [];
  let i = 0;
  let active = 0;
  let resolveAll, rejectAll;
  const out = new Promise((res, rej) => (resolveAll = res, rejectAll = rej));

  function runNext() {
    if (i >= items.length && active === 0) return resolveAll(ret);
    while (active < limit && i < items.length) {
      const idx = i++;
      active++;
      Promise.resolve(worker(items[idx], idx))
        .then((val) => { ret[idx] = val; })
        .catch(rejectAll)
        .finally(() => { active--; runNext(); });
    }
  }
  runNext();
  return out;
}

// -------------------- MAIN --------------------
(async function main() {
  try {
    const argUrl = process.argv[2];
    let base, hostname;
    if (ENV_BASE) {
      base = ENV_BASE;
      hostname = (new URL(ENV_BASE)).hostname || HOSTNAME || "";
    } else if (HOSTNAME) {
      hostname = HOSTNAME;
      base = `https://${hostname}`;
    } else if (argUrl) {
      ({ base, hostname } = extractWorkflowsBaseFromUrl(argUrl));
    } else {
      console.error("Provide any Okta URL or set WF_HOST or WF_BASE");
      process.exit(2);
    }

    log(`[INFO] Target base URL: ${base}`);
    log("[INFO] Obtaining auth_token…");
    const token = await obtainAuthToken(hostname, base);
    if (!token) {
      console.error("[FATAL] Could not obtain auth_token.");
      process.exit(1);
    }
    if (DEBUG) log(`[DEBUG] Got auth_token (len=${token.length})`);

    const headers = defaultHeaders(base, token);
    await fsp.mkdir(OUT_DIR, { recursive: true });

    // Org
    log("[INFO] Fetching org metadata…");
    const orgObj = await fetchOrg(base, headers);
    const orgId = extractOrgId(orgObj);
    log(`[INFO] orgId = ${orgId}`);

    // Groups
    log("[INFO] Fetching groups…");
    let groups = await fetchGroups(base, orgId, headers);
    if (!Array.isArray(groups)) groups = [];
    log(`[INFO] Found ${groups.length} group(s).`);

    // Prepare per-group directories
    const groupDirs = {};
    for (const g of groups) {
      const gdir = path.join(OUT_DIR, sanitizeName(g.name));
      await fsp.mkdir(gdir, { recursive: true });
      groupDirs[String(g.id)] = gdir;
    }

    // Export .folder bundles
    const allPacks = []; // <- FIXED: define accumulator
    log("[INFO] Exporting .folder bundles per group…");
    for (let idx = 0; idx < groups.length; idx++) {
      const g = groups[idx];
      const gid = g.id;
      const gname = g.name;
      const gdir = groupDirs[String(gid)];
      const outfilePath = path.join(gdir, `${sanitizeName(gname)}.folder`);
      log(`  -> [${idx + 1}/${groups.length}] Export '${gname}' (id=${gid}) -> ${path.basename(outfilePath)}`);
      try {
        const blob = await downloadGroupExport(base, orgId, gid, headers);
        await fsp.writeFile(outfilePath, blob);
        log("     ✓ Saved");
        allPacks.push({ groupId: gid, groupName: gname, file: outfilePath });
      } catch (e) {
        log(`     ! Export failed: ${e.message}`);
      }
      await sleep(SLEEP_BETWEEN);
    }

    // Stashes -> CSV
    log("[INFO] Backing up tables into per-group CSVs…");
    await mapPool(groups, Math.max(1, Math.min(MAX_WORKERS, 8)), async (g, i) => {
      const gid = String(g.id);
      const gname = g.name;
      const gdir = groupDirs[gid];
      const stashes = await fetchStashesForGroup(base, orgId, g.id, headers);
      if (!Array.isArray(stashes) || !stashes.length) return;

      log(`  -> Group '${gname}': ${stashes.length} table(s)`);
      for (const st of stashes) {
        const sid = String(st?.stashId ?? st?.id ?? "");
        if (!sid) continue;
        const meta = await fetchStashMeta(base, orgId, sid, headers);
        const nm = (meta && meta.name) ? meta.name : (st.name || "(unnamed_stash)");
        const rowsPayload = await fetchStashRows(base, orgId, sid, headers);
        const { headers: csvHeaders, records } = rowsToRecords(rowsPayload, meta);
        const csvName = `${sanitizeName(nm)}.csv`;
        const csvPath = path.join(gdir, csvName);
        try {
          await writeCsv(csvPath, csvHeaders, records);
          log(`     ✓ ${csvName}  (rows: ${records.length}, cols: ${csvHeaders.length})`);
        } catch (e) {
          log(`     ! Failed to write ${csvName}: ${e.message}`);
        }
        await sleep(SLEEP_BETWEEN);
      }
    });

    // Manifest JSON (replace prior undefined `outfile`)
    const manifest = {
      sourceBase: base,
      csvRoot: path.resolve(OUT_DIR),
      org: { id: orgId, raw: orgObj },
      groups_count: groups.length,
      groups,
      packs_exported: allPacks.length,
      packs: allPacks
    };

    try {
      await fsp.writeFile(OUT_JSON, JSON.stringify(manifest, null, 2), "utf8");
      log(`[INFO] Wrote JSON manifest: ${OUT_JSON}`);
    } catch (e) {
      log(`[WARN] Could not write manifest: ${e.message}`);
    }

    log("[INFO] Export complete.");
    log(
      `[SUMMARY] Groups: ${groups.length} | .folder exports: ${allPacks.length} | `
      + `CSV root: ${path.resolve(OUT_DIR)}`
    );
  } catch (e) {
    console.error(`[FATAL] ${e.message}`);
    process.exit(1);
  }
})();
