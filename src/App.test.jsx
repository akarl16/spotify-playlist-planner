import { render, screen, waitFor } from '@testing-library/react';
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
