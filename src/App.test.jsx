import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App.jsx';
import * as syncEngine from './sync/syncEngine.js';
import * as spotify from './spotify.js';
import * as database from './database.js';
import * as featuresLoader from './sync/featuresLoader.js';

jest.mock('./sync/syncEngine.js');
jest.mock('./spotify.js');
jest.mock('./sync/featuresLoader.js');

beforeEach(() => {
    jest.clearAllMocks();
});

test('a failed sync keeps the backdrop up with the reason, instead of showing an empty table', async () => {
    jest.spyOn(database, 'init').mockResolvedValue(undefined);
    spotify.isAuthorized.mockResolvedValue(true);
    spotify.getAccessToken.mockReturnValue('token');
    syncEngine.runSync.mockRejectedValue(
        Object.assign(new Error('Spotify API error: 403'), { kind: 'auth', status: 403 })
    );

    render(<App />);

    // `finally` running after `return` used to unmount this and reveal an empty table.
    await waitFor(() => {
        expect(screen.getByTestId('sync-fatal-error')).toBeInTheDocument();
    });
    expect(screen.getByText('Sync stopped')).toBeInTheDocument();

    // The table only ever renders once isLoading flips false, which happens on
    // the success path. If the bug regresses, isLoading is cleared here too and
    // the backdrop's modal (and its error text) disappears — the assertions
    // above are what actually catch that, but confirm the empty-table symptom
    // doesn't sneak in as well.
    expect(screen.queryByText('🎧 Playlist Planner')).not.toBeInTheDocument();
});

test('starts loading tempo in the background once the sync completes', async () => {
    jest.spyOn(database, 'init').mockResolvedValue(undefined);
    spotify.isAuthorized.mockResolvedValue(true);
    spotify.getAccessToken.mockReturnValue('token');
    syncEngine.runSync.mockResolvedValue({
        libraryPlaylists: [], classPlaylists: [], featuresById: new Map()
    });
    featuresLoader.loadTrackFeatures.mockResolvedValue({
        completed: true, batchesDone: 0, batchesTotal: 0, failedBatches: 0, added: 0
    });

    render(<App />);

    await waitFor(() => {
        expect(featuresLoader.loadTrackFeatures).toHaveBeenCalled();
    });
});

test('does not start a background load when the sync failed', async () => {
    // Nothing useful to enrich, and the backdrop is showing an error.
    jest.spyOn(database, 'init').mockResolvedValue(undefined);
    spotify.isAuthorized.mockResolvedValue(true);
    spotify.getAccessToken.mockReturnValue('token');
    syncEngine.runSync.mockRejectedValue(
        Object.assign(new Error('Spotify API error: 403'), { kind: 'auth', status: 403 })
    );

    render(<App />);

    await waitFor(() => {
        expect(screen.getByTestId('sync-fatal-error')).toBeInTheDocument();
    });
    expect(featuresLoader.loadTrackFeatures).not.toHaveBeenCalled();
});

function renderSyncedApp(result = {}) {
    jest.spyOn(database, 'init').mockResolvedValue(undefined);
    spotify.isAuthorized.mockResolvedValue(true);
    spotify.getAccessToken.mockReturnValue('token');
    syncEngine.runSync.mockResolvedValue({
        libraryPlaylists: [], classPlaylists: [], featuresById: new Map(), failures: [], ...result
    });
    featuresLoader.loadTrackFeatures.mockResolvedValue({
        completed: true, batchesDone: 0, batchesTotal: 0, failedBatches: 0, added: 0
    });
    render(<App />);
}

test('the initial load keeps the header staleness window', async () => {
    renderSyncedApp();

    await waitFor(() => expect(syncEngine.runSync).toHaveBeenCalled());
    expect(syncEngine.runSync.mock.calls[0][0].forceHeaders).toBeFalsy();
});

test('Refresh re-reads playlist headers so changed snapshots are seen', async () => {
    renderSyncedApp();
    // TopShell is declared inside App, so it remounts on every render. Let the
    // post-sync tempo-load state updates land before grabbing the button.
    await waitFor(() => expect(featuresLoader.loadTrackFeatures).toHaveBeenCalled());
    await act(async () => {});

    await userEvent.click(screen.getByLabelText('Refresh'));

    await waitFor(() => expect(syncEngine.runSync).toHaveBeenCalledTimes(2));
    expect(syncEngine.runSync.mock.calls[1][0].forceHeaders).toBe(true);
});

test('an expired session shows a reconnect prompt instead of failing silently', async () => {
    let notify;
    spotify.onSessionExpired.mockImplementation((listener) => { notify = listener; return () => {}; });
    renderSyncedApp();
    await screen.findByLabelText('Refresh');

    act(() => notify());

    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    expect(spotify.authorizeSpotify).toHaveBeenCalled();
});

test('a sync aborted by an expired session shows the reconnect prompt, not the error backdrop', async () => {
    jest.spyOn(database, 'init').mockResolvedValue(undefined);
    spotify.isAuthorized.mockResolvedValue(true);
    spotify.getAccessToken.mockReturnValue('token');
    syncEngine.runSync.mockRejectedValue(
        Object.assign(new Error('Spotify API error: 401'), { kind: 'auth', status: 401, sessionExpired: true })
    );

    render(<App />);

    expect(await screen.findByText(/session expired/i)).toBeInTheDocument();
    expect(screen.queryByTestId('sync-fatal-error')).not.toBeInTheDocument();
});

test('playlists that failed to sync are reported once the sync completes', async () => {
    renderSyncedApp({
        failures: [{ playlistId: 'p1', name: '2026-10-03', lastError: { kind: 'http', status: 404, message: 'x' } }]
    });

    expect(await screen.findByText(/1 playlist failed to sync/i)).toBeInTheDocument();
    expect(screen.getByText(/2026-10-03/)).toBeInTheDocument();
});
