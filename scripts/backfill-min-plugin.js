import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join('data', 'features');
const LOOKUP = JSON.parse(fs.readFileSync(path.join('data', 'lookups', 'copilot-chat-versions.json'), 'utf8'));
const WINDOW_DAYS = 7;

const versions = LOOKUP.versions
    .map(v => ({ ...v, ts: v.released_at ? Date.parse(v.released_at) : NaN }))
    .filter(v => !Number.isNaN(v.ts))
    .sort((a, b) => a.ts - b.ts);

function pickVersion(startDate) {
    if (!startDate) return null;
    const ms = Date.parse(startDate);
    if (Number.isNaN(ms)) return null;
    const window = WINDOW_DAYS * 24 * 60 * 60 * 1000;

    // Candidates not later than (startDate + 7d)
    const candidates = versions.filter(v => v.ts <= (ms + window));
    if (candidates.length === 0) return null;

    // Choose the one with max ts (closest at or before +7d)
    const best = candidates[candidates.length - 1];
    return best.version;
}

function processFile(file) {
    const p = path.join(DATA_DIR, file);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    let changed = false;

    (j.surfaces || []).forEach(s => {
        if (s.surface !== 'VS Code') return;
        (s.milestones || []).forEach(m => {
            if (!m.min_plugin_version) {
                const v = pickVersion(m.start_date);
                if (v) {
                    m.min_plugin_version = v;
                    changed = true;
                }
            }
        });
    });

    if (changed) {
        fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
        console.log('Updated:', file);
    }
}

for (const f of fs.readdirSync(DATA_DIR)) {
    if (f.endsWith('.json')) processFile(f);
}
