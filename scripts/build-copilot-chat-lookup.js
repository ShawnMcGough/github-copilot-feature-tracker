// scripts/build-copilot-chat-lookup.js
// Node 20+; uses node-fetch@3 installed by the workflow.
// Purpose: Produce data/lookups/copilot-chat-versions.json from GitHub Releases.

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';

const OWNER = 'microsoft';
const REPO = 'vscode-copilot-chat';
const OUT = path.join('data', 'lookups', 'copilot-chat-versions.json');

// IMPORTANT: Use the API base, not the website base.
// In GitHub Actions, GITHUB_API_URL typically resolves to https://api.github.com
const API_BASE = process.env.GITHUB_API_URL || 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

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

function normalize(release) {
    const tag = release.tag_name || release.name || '';
    const isPrerelease = !!release.prerelease;
    // Prefer published_at; fallback to created_at
    const released_at = release.published_at || release.created_at || null;
    return {
        version: String(tag).replace(/^v/, ''),
        tag: tag,
        released_at,
        channel: isPrerelease ? 'pre-release' : 'stable',
        anchors: [
            `https://github.com/${OWNER}/${REPO}/releases/tag/${encodeURIComponent(tag)}`
        ]
    };
}

function hasNext(linkHeader) {
    // Parse RFC5988 Link header for rel="next"
    // Example: <https://api.github.com/...&page=2>; rel="next", <...page=5>; rel="last"
    return /<[^>]+>; rel="next"/i.test(linkHeader);
}

async function getAllReleases() {
    const all = [];
    let page = 1;
    while (true) {
        const { data, link } = await gh('/releases', page, 100);
        if (!Array.isArray(data) || data.length === 0) break;
        all.push(...data);
        if (!hasNext(link)) break;
        page += 1;
    }
    return all;
}

async function main() {
    const releases = await getAllReleases(); // authenticated if GH_TOKEN set
    const entries = releases
        .filter(r => !!(r.tag_name || r.name))
        .map(normalize)
        .filter(r => !!r.released_at)
        .sort((a, b) => new Date(a.released_at) - new Date(b.released_at));

    const out = {
        schema_version: '0.1',
        source: `https://github.com/${OWNER}/${REPO}/releases`,
        last_updated_utc: new Date().toISOString(),
        notes: 'Generated from GitHub Releases. Timestamps reflect GitHub release publish time.',
        versions: entries
    };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    console.log(`Wrote ${OUT} with ${entries.length} versions`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
