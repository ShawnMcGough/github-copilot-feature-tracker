// scripts/build-copilot-chat-lookup.js
// Requires: node-fetch@3 (installed by the workflow)
// Purpose: Produce data/lookups/copilot-chat-versions.json from GitHub Releases.

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';

const OWNER = 'microsoft';
const REPO = 'vscode-copilot-chat';
const OUT = path.join('data', 'lookups', 'copilot-chat-versions.json');

const GH = process.env.GITHUB_SERVER_URL || 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN;

async function gh(pathname) {
    const res = await fetch(`${GH}/repos/${OWNER}/${REPO}${pathname}`, {
        headers: {
            'Accept': 'application/vnd.github+json',
            ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
        }
    });
    if (!res.ok) {
        throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
    }
    return res.json();
}

function normalize(release) {
    const tag = release.tag_name || release.name || '';
    const isPrerelease = !!release.prerelease;
    return {
        version: tag.replace(/^v/, ''),
        tag: tag,
        released_at: release.published_at || release.created_at || null,
        channel: isPrerelease ? 'pre-release' : 'stable',
        anchors: [`https://github.com/${OWNER}/${REPO}/releases/tag/${encodeURIComponent(tag)}`]
    };
}

async function main() {
    const releases = await gh('/releases?per_page=100'); // first page; extend if needed
    const entries = releases
        .filter(r => !!(r.tag_name || r.name))
        .map(normalize)
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
