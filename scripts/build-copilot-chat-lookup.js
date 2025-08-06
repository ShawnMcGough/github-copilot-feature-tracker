// scripts/build-copilot-chat-lookup.js
// Node 20+; uses node-fetch@3 installed by the workflow.
// Purpose: Produce data/lookups/copilot-chat-versions.json from GitHub Releases,
//          keeping ONLY stable (non-draft, non-prerelease) releases, going back
//          at least two years (configurable via env).

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';

const OWNER = 'microsoft';
const REPO = 'vscode-copilot-chat';
const OUT = path.join('data', 'lookups', 'copilot-chat-versions.json');

// Use the REST API base (not the website host).
// In GitHub Actions, GITHUB_API_URL is usually https://api.github.com
const API_BASE = process.env.GITHUB_API_URL || 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

// How far back to collect releases. Default: 2 years (≈730 days).
const YEARS_BACK = Number(process.env.YEARS_BACK || 2);
const DAYS_BACK = Math.max(1, Math.floor(YEARS_BACK * 365));
const FROM_TS = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;

const HEADERS = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'copilot-feature-tracker/lookup-script',
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

function normalize(release) {
    const tag = release.tag_name || release.name || '';
    const released_at = release.published_at || release.created_at || null;
    return {
        version: String(tag).replace(/^v/, ''),
        tag: tag,
        released_at,
        channel: 'stable',
        anchors: [
            `https://github.com/${OWNER}/${REPO}/releases/tag/${encodeURIComponent(tag)}`
        ]
    };
}

async function getStableReleasesSince(fromTs) {
    const out = [];
    let page = 1;

    while (true) {
        const { data, link } = await gh('/releases', page, 100);
        if (!Array.isArray(data) || data.length === 0) break;

        // Releases are returned newest-first. Keep only stable (non-draft, non-prerelease).
        for (const rel of data) {
            if (rel.draft || rel.prerelease) continue; // stable only
            const ts = Date.parse(rel.published_at || rel.created_at || '');
            if (!Number.isNaN(ts)) {
                // Collect as long as release is on/after fromTs.
                if (ts >= fromTs) out.push(rel);
            }
        }

        // If the oldest release on this page is already older than fromTs,
        // we can stop paging (since subsequent pages are even older).
        const oldest = data[data.length - 1];
        const oldestTs = Date.parse(oldest?.published_at || oldest?.created_at || '');
        const reachedThreshold = !Number.isNaN(oldestTs) && oldestTs < fromTs;

        if (reachedThreshold || !hasNext(link)) break;
        page += 1;
    }

    return out;
}

async function main() {
    const stable = await getStableReleasesSince(FROM_TS);

    const entries = stable
        .filter(r => !!(r.tag_name || r.name))
        .map(normalize)
        .filter(r => !!r.released_at)
        .sort((a, b) => new Date(a.released_at) - new Date(b.released_at));

    const out = {
        schema_version: '0.1',
        source: `https://github.com/${OWNER}/${REPO}/releases`,
        last_updated_utc: new Date().toISOString(),
        notes: `Generated from GitHub Releases. Stable-only (draft=false, prerelease=false). Window: last ${DAYS_BACK} days.`,
        versions: entries
    };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    console.log(`Wrote ${OUT} with ${entries.length} stable versions (last ${DAYS_BACK} days).`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
