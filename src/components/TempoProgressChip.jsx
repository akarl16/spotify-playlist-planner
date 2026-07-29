import React from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import LinearProgress from '@mui/material/LinearProgress';

const GREEN = '#1DB954';
const AMBER = '#ffaa00';

/**
 * Background tempo-loading indicator for the app bar.
 *
 * Renders nothing when idle or when a run finished cleanly — a completed job should
 * leave no permanent chrome. It stays visible in a warning state when batches failed,
 * because the BPM column is then still incomplete and that must not be silent. Those
 * batches are retried on the next launch.
 */
function TempoProgressChip({ progress }) {
    if (!progress) return null;
    if (progress.batchesTotal === 0) return null;

    const { running, batchesDone, batchesTotal, failedBatches, added } = progress;
    if (!running && failedBatches === 0) return null;

    const pct = Math.round((batchesDone / batchesTotal) * 100);
    const label = running
        ? `Loading track tempo — ${pct}% complete, ${added} found so far`
        : `Tempo loading finished with ${failedBatches} failed batches; they will be retried next launch`;

    return (
        <Tooltip title={label}>
            <Box
                data-testid="tempo-progress"
                aria-label={label}
                sx={{
                    display: 'flex', alignItems: 'center', gap: 1,
                    px: 1.4, py: 0.6, mr: 1, borderRadius: '14px',
                    backgroundColor: 'rgba(255,255,255,0.07)',
                    fontSize: 12, whiteSpace: 'nowrap',
                    color: failedBatches > 0 ? AMBER : 'rgba(255,255,255,0.8)'
                }}
            >
                <Box component="span">♪</Box>
                <Box component="span">
                    {running ? `Tempo ${pct}%` : `Tempo · ${failedBatches} failed`}
                </Box>
                {running && (
                    <LinearProgress
                        variant="determinate"
                        value={pct}
                        sx={{
                            width: 48, height: 4, borderRadius: 2,
                            backgroundColor: 'rgba(255,255,255,0.15)',
                            '& .MuiLinearProgress-bar': { backgroundColor: GREEN }
                        }}
                    />
                )}
            </Box>
        </Tooltip>
    );
}

export default TempoProgressChip;
