// scripts/lookups/build-vscode-versions.js
// Node 20+ (ESM). Install deps: npm i node-fetch@3
// Purpose: Build data/lookups/vscode-versions.json from GitHub Releases.
// - Stable only (draft=false, prerelease=false)
// - At least last N years (default 2), with pagination
// - Includes published_at timestamps for accurate date mapping

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';

const OWNER = 'microsoft';
const REPO = 'vscode';
const OUT = path.join('data', 'lookups', 'vscode-versions.json');

// Use the REST API base (not the website host).
// In GitHub Actions, GITHUB_API_URL is typically https://api.github.com.
const API_BASE = process.env.GITHUB_API_URL || 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

// Collect at least this many years of history (default = 2).
const YEARS_BACK = Number(process.env.YEARS_BACK || 2);
const DAYS_BACK = Math.max(1, Math.floor(YEARS_BACK * 365));
const FROM_TS = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;

const HEADERS = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'copilot-feature-tracker/vscode-lookup',
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
};

async function gh(pathname, page = 1, perPage = 100) {
    const url = new URL(`${API_BASE}/repos/${OWNER}/${REPO}${pathname}`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));

    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`GitHub API error ${res.status}: ${body}`);
    }
    const data = await res.json();
    const link = res.headers.get('link') || '';
    return { data, link };
}

// Parse RFC 5988 Link header to detect rel="next"
function hasNext(linkHeader) {
    return /<[^>]+>; rel="next"/i.test(linkHeader);
}

// Normalize a GitHub release object into our schema item
function normalize(release) {
    const tag = release.tag_name || release.name || ''; // e.g. "1.102.1" or "v1.102.1"
    const version = String(tag).replace(/^v/i, '');
    const published = release.published_at || release.created_at || null; // ISO date-time
    return {
        version,
        released_at: published,                       // keep full ISO timestamp
        channel: 'stable',
        anchors: [release.html_url || `https://github.com/${OWNER}/${REPO}/releases/tag/${encodeURIComponent(tag)}`]
    };
}

async function getStableReleasesSince(fromTs) {
    const out = [];
    let page = 1;

    while (true) {
        const { data, link } = await gh('/releases', page, 100);
        if (!Array.isArray(data) || data.length === 0) break;

        // GitHub returns newest-first. Filter stable (no draft, no prerelease).
        const stable = data.filter(r => !r.draft && !r.prerelease);

        for (const rel of stable) {
            const ts = Date.parse(rel.published_at || rel.created_at || '');
            if (!Number.isNaN(ts)) {
                // Add all that are newer than our cutoff (or equal)
                if (ts >= fromTs) out.push(rel);
            }
        }

        // Stop if the oldest on this page is already older than cutoff
        const oldest = data[data.length - 1];
        const oldestTs = Date.parse(oldest?.published_at || oldest?.created_at || '');
        const reachedThreshold = !Number.isNaN(oldestTs) && oldestTs < fromTs;

        if (reachedThreshold || !hasNext(link)) break;
        page += 1;
    }

    return out;
}

function dedupeByVersion(entries) {
    const map = new Map();
    for (const e of entries) {
        const k = e.version;
        if (!map.has(k)) map.set(k, e);
        // If duplicate version appears, prefer the one with a published_at timestamp.
        else if (!map.get(k).released_at && e.released_at) map.set(k, e);
    }
    return Array.from(map.values());
}

async function main() {
    const stable = await getStableReleasesSince(FROM_TS);

    const normalized = stable
        .filter(r => r.tag_name || r.name)
        .map(normalize)
        .filter(e => !!e.released_at);

    const deduped = dedupeByVersion(normalized);

    // Sort ascending by release time so date lookups work logically
    const versions = deduped.sort((a, b) => {
        const ta = Date.parse(a.released_at);
        const tb = Date.parse(b.released_at);
        return ta - tb;
    });

    const out = {
        schema_version: '0.1',
        ide: 'VS Code',
        source: `https://github.com/${OWNER}/${REPO}/releases`,
        last_updated_utc: new Date().toISOString(),
        versions
    };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

    const first = versions[0]?.released_at || 'n/a';
    const last = versions[versions.length - 1]?.released_at || 'n/a';
    console.log(`Wrote ${OUT} with ${versions.length} stable releases`);
    console.log(`Range: ${first} → ${last} (last ${DAYS_BACK} days)`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
