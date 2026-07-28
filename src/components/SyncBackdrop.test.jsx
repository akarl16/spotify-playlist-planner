import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SyncBackdrop from './SyncBackdrop.jsx';
import { initialTelemetry, reduceTelemetry } from '../sync/telemetry.js';

const apply = (events) => events.reduce(reduceTelemetry, initialTelemetry());

const cleanRun = apply([
    { type: 'sync:start', at: 0 },
    { type: 'phase:start', phase: 'class', total: 2 },
    { type: 'item:success', phase: 'class', playlistId: 'a', name: '2026-07-15 Intervals', trackCount: 46, durationMs: 310 }
]);

const failedRun = apply([
    { type: 'sync:start', at: 0 },
    { type: 'phase:start', phase: 'class', total: 2 },
    {
        type: 'item:error', phase: 'class', playlistId: 'b', name: '2026-07-10 Recovery',
        cause: { kind: 'rate_limit', status: 429 }, storedTrackCount: 50, tracksTotal: 112
    }
]);

test('the repair row reports its queue as unverified, not damaged', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:progress', phase: 'repair', total: 570 }
    ]);
    render(<SyncBackdrop telemetry={state} />);

    // Stage 1 marks every cached playlist unverified, so this number is the whole
    // in-scope library. Calling it "queued" would read as "570 are broken".
    expect(screen.getByText(/570 unverified/)).toBeInTheDocument();
});

test('shows every phase label when collapsed', () => {
    render(<SyncBackdrop telemetry={cleanRun} />);

    expect(screen.getByText('Playlist headers')).toBeInTheDocument();
    expect(screen.getByText('Class playlists')).toBeInTheDocument();
    expect(screen.getByText('Repair incomplete playlists')).toBeInTheDocument();
});

test('a clean run shows no failure badge', () => {
    render(<SyncBackdrop telemetry={cleanRun} />);

    expect(screen.queryByTestId('phase-failures-class')).not.toBeInTheDocument();
});

test('a failed run shows a failure badge on the affected phase', () => {
    render(<SyncBackdrop telemetry={failedRun} />);

    expect(screen.getByTestId('phase-failures-class')).toHaveTextContent('1 FAILED');
});

test('details are hidden until expanded', () => {
    render(<SyncBackdrop telemetry={failedRun} />);

    expect(screen.queryByTestId('sync-details')).not.toBeInTheDocument();
});

test('expanding reveals the stats block and an incomplete callout naming the cause', async () => {
    render(<SyncBackdrop telemetry={failedRun} />);

    await userEvent.click(screen.getByRole('button', { name: /show details/i }));

    const details = screen.getByTestId('sync-details');
    expect(details).toBeInTheDocument();
    expect(within(details).getByText(/1 playlist incomplete/i)).toBeInTheDocument();
    // Scoped to the details block: the same cause text also appears in the feed,
    // which lives outside it, so an unscoped query would match twice and throw.
    expect(within(details).getByText(/rate limited · stopped at 50 of 112/i)).toBeInTheDocument();
});

test('the cause appears in both the feed and the callout', async () => {
    render(<SyncBackdrop telemetry={failedRun} />);

    await userEvent.click(screen.getByRole('button', { name: /show details/i }));

    expect(screen.getAllByText(/rate limited · stopped at 50 of 112/i)).toHaveLength(2);
});

test('expanded stats line reports api calls and rate limits', async () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'class', total: 1 },
        { type: 'api:call', phase: 'class', rateLimited: true },
        { type: 'api:call', phase: 'class', rateLimited: false }
    ]);
    render(<SyncBackdrop telemetry={state} />);

    await userEvent.click(screen.getByRole('button', { name: /show details/i }));

    expect(screen.getByTestId('stat-apiCalls')).toHaveTextContent('2');
    expect(screen.getByTestId('stat-rateLimited')).toHaveTextContent('1');
});
