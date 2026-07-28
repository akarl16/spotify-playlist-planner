import { render, screen, waitFor } from '@testing-library/react';
import App from './App.jsx';
import * as syncEngine from './sync/syncEngine.js';
import * as spotify from './spotify.js';
import * as database from './database.js';

jest.mock('./sync/syncEngine.js');
jest.mock('./spotify.js');

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
