import React, { useState, Fragment } from 'react';
import Backdrop from '@mui/material/Backdrop';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
import { describeCause } from '../sync/telemetry.js';

const GREEN = '#1DB954';
const AMBER = '#ffaa00';
const RED = '#ff5252';

function formatElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function overallProgress(phases) {
    const total = phases.reduce((sum, phase) => sum + phase.total, 0);
    const done = phases.reduce((sum, phase) => sum + phase.done, 0);
    return total === 0 ? 0 : Math.round((done / total) * 100);
}

function PhaseIcon({ status }) {
    if (status === 'complete') return <Box component="span" sx={{ color: GREEN, width: 16 }}>✓</Box>;
    if (status === 'active') return <CircularProgress size={13} sx={{ color: GREEN }} />;
    return <Box component="span" sx={{ color: 'rgba(255,255,255,0.35)', width: 16 }}>○</Box>;
}

function FeedRow({ entry }) {
    const color = entry.status === 'error' ? RED : entry.status === 'success' ? GREEN : AMBER;
    const glyph = entry.status === 'error' ? '✕' : entry.status === 'success' ? '✓' : '⏳';

    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.5, fontSize: 12.5 }}>
            <Box component="span" sx={{ color, width: 15, textAlign: 'center' }}>{glyph}</Box>
            <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.name}
            </Box>
            <Box component="span" sx={{ fontFamily: 'monospace', fontSize: 11.5, color: 'rgba(255,255,255,0.5)' }}>
                {entry.detail}
            </Box>
        </Box>
    );
}

function SyncBackdrop({ telemetry }) {
    const [expanded, setExpanded] = useState(false);
    const { phases, feed, stats, incomplete, elapsedMs } = telemetry;
    const activePhaseKey = phases.find((phase) => phase.status === 'active')?.key;

    return (
        <Backdrop
            className="Loader"
            open={true}
            sx={{ zIndex: 1300 }}
            // MUI hardcodes aria-hidden="true" on the Backdrop root, which would hide
            // the whole dialog (including the "Show details" button) from the
            // accessibility tree and break role-based queries/keyboard users. This is a
            // real, interactive dialog, so un-hide it.
            slotProps={{ root: { 'aria-hidden': false } }}
        >
            <Box sx={{ backgroundColor: '#121212', borderRadius: '10px', p: 3.5, width: 560, maxWidth: '92vw' }}>
                <Typography sx={{ fontSize: 19, fontWeight: 700 }}>Syncing your library…</Typography>
                <Typography sx={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', mb: 1.5 }}>
                    Elapsed {formatElapsed(elapsedMs)}
                </Typography>

                <LinearProgress
                    variant="determinate"
                    value={overallProgress(phases)}
                    sx={{
                        height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.10)',
                        '& .MuiLinearProgress-bar': { backgroundColor: stats.rateLimited > 0 ? AMBER : GREEN }
                    }}
                />

                <Box sx={{ mt: 1.5 }}>
                    {phases.map((phase) => (
                        <Box key={phase.key} sx={{ py: 1.25, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, fontSize: 14, fontWeight: 600 }}>
                                <PhaseIcon status={phase.status} />
                                <Box component="span" sx={{ color: phase.status === 'pending' ? 'rgba(255,255,255,0.35)' : 'inherit' }}>
                                    {phase.label}
                                </Box>

                                {phase.failed > 0 && (
                                    <Box
                                        data-testid={`phase-failures-${phase.key}`}
                                        sx={{
                                            fontSize: 10.5, fontWeight: 700, px: 0.9, py: 0.25, borderRadius: '9px',
                                            backgroundColor: 'rgba(255,82,82,0.16)', color: '#ff8a8a'
                                        }}
                                    >
                                        {phase.failed} FAILED
                                    </Box>
                                )}

                                <Box sx={{ ml: 'auto', fontFamily: 'monospace', fontSize: 12, fontWeight: 400, color: 'rgba(255,255,255,0.5)' }}>
                                    {phase.status === 'pending' && phase.total > 0
                                        // "unverified", not "damaged": the migration marks every cached
                                        // playlist unverified because a truncated one is indistinguishable
                                        // from a healthy one, so this count is the whole in-scope library,
                                        // not a damage estimate. Saying "queued" here would overstate it.
                                        ? `${phase.total} ${phase.key === 'repair' ? 'unverified' : 'queued'}`
                                        : phase.status === 'pending' ? 'pending'
                                        : `${phase.done} / ${phase.total}`}
                                    {expanded && phase.apiCalls > 0 ? ` · ${phase.apiCalls} calls` : ''}
                                </Box>
                            </Box>

                            {phase.status === 'active' && (
                                <LinearProgress
                                    variant="determinate"
                                    value={phase.total === 0 ? 0 : Math.round((phase.done / phase.total) * 100)}
                                    sx={{
                                        mt: 0.9, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.10)',
                                        '& .MuiLinearProgress-bar': { backgroundColor: stats.rateLimited > 0 ? AMBER : GREEN }
                                    }}
                                />
                            )}

                            {/* The feed nests under the ACTIVE phase so the phase list stays the spine. */}
                            {expanded && phase.key === activePhaseKey && feed.length > 0 && (
                                <Box sx={{ backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: '6px', px: 1.4, py: 0.9, mt: 1.1 }}>
                                    {feed.slice(0, 6).map((entry, index) => (
                                        <FeedRow key={`${entry.playlistId}-${index}`} entry={entry} />
                                    ))}
                                </Box>
                            )}
                        </Box>
                    ))}
                </Box>

                {expanded && (
                    <Box data-testid="sync-details">
                        {stats.rateLimited > 0 && (
                            <Box sx={{
                                backgroundColor: 'rgba(255,170,0,0.13)', borderLeft: `3px solid ${AMBER}`,
                                px: 1.4, py: 1, borderRadius: '5px', fontSize: 12.5, mt: 1.5, color: '#ffd27a'
                            }}>
                                Rate limited — {stats.rateLimited} of {stats.apiCalls} calls
                                {stats.apiCalls > 0 ? ` (${((stats.rateLimited / stats.apiCalls) * 100).toFixed(1)}%)` : ''}.
                            </Box>
                        )}

                        {incomplete.length > 0 && (
                            <Box sx={{
                                backgroundColor: 'rgba(255,82,82,0.10)', borderLeft: `3px solid ${RED}`,
                                px: 1.4, py: 1.1, borderRadius: '5px', fontSize: 12.5, mt: 1.25
                            }}>
                                <Box sx={{ color: '#ff8a8a', fontWeight: 700 }}>
                                    {incomplete.length} playlist{incomplete.length === 1 ? '' : 's'} incomplete
                                </Box>
                                {incomplete.map((entry) => (
                                    <Box key={entry.playlistId} sx={{ opacity: 0.8, mt: 0.5 }}>
                                        {entry.name} — {describeCause(entry.cause, entry.storedTrackCount, entry.tracksTotal)}
                                    </Box>
                                ))}
                                <Box sx={{ opacity: 0.65, mt: 0.6, fontSize: 11.5 }}>
                                    Marked incomplete in storage; the repair phase will re-fetch them.
                                </Box>
                            </Box>
                        )}

                        <Box sx={{
                            display: 'flex', gap: 2.25, flexWrap: 'wrap', mt: 1.75, pt: 1.6,
                            borderTop: '1px solid rgba(255,255,255,0.07)', fontFamily: 'monospace',
                            fontSize: 12, color: 'rgba(255,255,255,0.55)'
                        }}>
                            <span data-testid="stat-apiCalls"><b style={{ color: '#fff' }}>{stats.apiCalls}</b> API calls</span>
                            <span data-testid="stat-rateLimited"><b style={{ color: AMBER }}>{stats.rateLimited}</b> rate limited</span>
                            <span data-testid="stat-failed"><b style={{ color: RED }}>{stats.failed}</b> failed</span>
                            <span data-testid="stat-tracksCached"><b style={{ color: '#fff' }}>{stats.tracksCached}</b> tracks cached</span>
                        </Box>
                    </Box>
                )}

                <Button
                    fullWidth
                    onClick={() => setExpanded(!expanded)}
                    sx={{
                        mt: 2, py: 1.1, backgroundColor: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.09)', borderRadius: '7px',
                        fontSize: 12.5, color: 'rgba(255,255,255,0.75)', textTransform: 'none'
                    }}
                >
                    {expanded ? '▴ Hide details' : '▾ Show details'}
                </Button>
            </Box>
        </Backdrop>
    );
}

export default SyncBackdrop;
