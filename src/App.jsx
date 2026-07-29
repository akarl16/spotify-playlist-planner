import "./styles.css";
import React, { useState, useEffect, useMemo, useCallback, Fragment } from "react";
import { MaterialReactTable } from 'material-react-table';
import SpotifyPlayer from "react-spotify-web-playback";
import { ThemeProvider, createTheme } from '@mui/material/styles';

import PlayCircleFilledIcon from '@mui/icons-material/PlayCircleFilled';
import RefreshIcon from '@mui/icons-material/Refresh';
import MenuIcon from '@mui/icons-material/Menu';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSpotify } from '@fortawesome/free-brands-svg-icons';

import AppBar from "@mui/material/AppBar";
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button"
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Stack from '@mui/material/Stack';
import Drawer from '@mui/material/Drawer';
import useScrollTrigger from '@mui/material/useScrollTrigger';
import CssBaseline from '@mui/material/CssBaseline';
import Fade from '@mui/material/Fade';
import Fab from '@mui/material/Fab';

import "json.date-extensions";
import * as spotify from "./spotify.js";
import * as database from "./database.js";
import { runSync } from './sync/syncEngine.js';
import { initialTelemetry, reduceTelemetry } from './sync/telemetry.js';
import { buildTrackLibrary } from './trackLibrary.js';
import SyncBackdrop from './components/SyncBackdrop.jsx';

// Create a dark theme for Material-UI
const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#1DB954',
    },
    secondary: {
      main: '#1ed760',
    },
    background: {
      default: '#121212',
      paper: '#282828',
    },
    text: {
      primary: '#FFFFFF',
      secondary: 'rgba(255, 255, 255, 0.7)',
    },
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
  },
});

function App() {
  // #region React hooks
  const [trackLibrary, setTrackLibrary] = useState([]);
  const [libraryPlaylists, setLibraryPlaylists] = useState([]);
  const [classPlaylists, setClassPlaylists] = useState([]);
  const [isSpotifyAuthorized, setIsSpotifyAuthorized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [playlistToPlan, setPlaylistToPlan] = useState();
  const [telemetry, setTelemetry] = useState(initialTelemetry());
  const [isPlaying, setIsPlaying] = useState(false);
  // eslint-disable-next-line no-unused-vars
  const [playTrackUri, setPlayTrackUri] = useState([]);
  // const scrollTrigger = useScrollTrigger({
  //   disableHysteresis: true,
  //   threshold: 0,
  //   target: window ? window() : undefined,
  // });

  useEffect(() => {
    async function checkAuth() {
      console.log('init database');
      await database.init();
      console.log('checking authorization');
      setIsSpotifyAuthorized(await spotify.isAuthorized());
    }

    checkAuth()
      .catch(console.error);;
  }, []);

  // #endregion

  // #region util functions

  const millisToMinutesAndSeconds = (millis) => {
    var minutes = Math.floor(millis / 60000);
    var seconds = ((millis % 60000) / 1000).toFixed(0);
    return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
  };

  const durationToMillis = (duration) => {
    const durationParts = duration.split(":");
    const millis = durationParts[0] * 60000 + durationParts[1] * 1000;
    console.debug("millis", millis);
    return millis;
  };

  // #endregion

  // #region data load functions
  const getData = useCallback(async () => {
    setIsLoading(true);

    // Engine events are pushed through the pure reducer; React only ever sees
    // the reduced view state.
    const emit = (event) => setTelemetry((current) => reduceTelemetry(current, event));
    const ticker = setInterval(() => emit({ type: 'tick', at: Date.now() }), 1000);

    try {
      const { libraryPlaylists: _libraryPlaylists, classPlaylists: _classPlaylists } = await runSync({ emit });

      setLibraryPlaylists(_libraryPlaylists);
      setClassPlaylists(_classPlaylists);
      setTrackLibrary(buildTrackLibrary(_libraryPlaylists, _classPlaylists, Date.now()));
      setIsLoading(false);
    } catch (error) {
      console.error('Sync failed', error);
      // Deliberately does NOT clear isLoading — the backdrop has to stay mounted
      // to carry the reason and offer a retry.
      //
      // This previously did `return` here with setIsLoading(false) in a `finally`.
      // `finally` runs even on the way out of a `return`, so the backdrop unmounted
      // regardless and a real 403 produced a silent empty table. Clearing the
      // loading flag on the success path only is what actually keeps it up.
      emit({
        type: 'sync:error',
        cause: { kind: error?.kind ?? 'http', status: error?.status ?? 0 },
        message: error?.message ?? String(error)
      });
    } finally {
      clearInterval(ticker);
    }
  }, []);

  useEffect(() => {
    if (isSpotifyAuthorized) {
      getData();
    }
  }, [isSpotifyAuthorized, getData]);

  const refreshData = async () => {
    setTrackLibrary([]);
    await getData();
  };

  const refreshAuthorization = async () => {
    spotify.authorizeSpotify();
  }
  // #endregion

  // #region runtime action functions
  const playTrack = async (trackId) => {
    console.debug(`PLAYING TRACK ${trackId}`);
    const spotifyApi = await spotify.getSpotifyApi();
    await spotifyApi.play({
      uris: [`spotify:track:${trackId}`]
    });
    // setPlayTrackUri(`spotify:track:${trackId}`);
    // setIsPlaying(true);
  };

  const addTrack = useCallback(async (trackId) => {
    console.debug(`ADDING TRACK ${trackId} TO PLAYLIST ${playlistToPlan.name}`);

    const track = trackLibrary.find((track) => track.id === trackId);
    const duration_string = "0:" + millisToMinutesAndSeconds(track.duration_ms);
    navigator.clipboard.writeText(`${track.name}\t${duration_string}`);

    await spotify.addItemsToPlaylist(playlistToPlan.id, [`spotify:track:${trackId}`]);
  }, [playlistToPlan, trackLibrary]);

  const addPlaylist = async () => {
    const date = new Date();

    const spotifyApi = await spotify.getSpotifyApi();
    const userProfile = await spotifyApi.getMe();
    const createPlaylistResponse = await spotifyApi.createPlaylist(userProfile.id, {
      name: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${date.getDate()}`,
      public: true
    });
    setClassPlaylists([createPlaylistResponse].concat(classPlaylists));
    setPlaylistToPlan(createPlaylistResponse);
  }

  // #endregion

  // #region React controls
  const matColumns = useMemo(
    () => [
      {
        id: "blah",
        header: "Actions",
        enableHiding: false,
        enableColumnActions: false,
        size: 40,
        Cell: ({ renderedCellValue, row }) => (
          <Fragment>
            <Tooltip title="Play Track">
              <IconButton 
                onClick={async () => await playTrack(row.original.id)}
                sx={{
                  '&:hover': {
                    color: '#1DB954',
                    backgroundColor: 'rgba(29, 185, 84, 0.1)',
                  }
                }}
              >
                <PlayCircleFilledIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Add to Playlist">
              <IconButton 
                onClick={async () => await addTrack(row.original.id)}
                sx={{
                  '&:hover': {
                    color: '#1DB954',
                    backgroundColor: 'rgba(29, 185, 84, 0.1)',
                  }
                }}
              >
                <PlaylistAddIcon />
              </IconButton>
            </Tooltip>
          </Fragment>
        )
      },
      {
        accessorKey: "name",
        header: "Track Name",
        size: 100,
        enableClickToCopy: true,
        enableColumnActions: false,
        maxSize: 200,
        Cell: ({ cell, row }) => (
          <Tooltip title={`Spotify ID: ${row.original.id}`} placement="top">
            <Box sx={{ fontWeight: 500 }}>
              {cell.getValue()}
            </Box>
          </Tooltip>
        )
      },
      {
        accessorFn: (row) => row.artists.map((artist) => artist.name).join(", "),
        accessorKey: "artists",
        header: "Artist(s)",
        size: 100,
        maxSize: 100,
        Cell: ({ cell }) => (
          <Box sx={{ color: 'rgba(255,255,255,0.7)' }}>
            {cell.getValue()}
          </Box>
        )
      },
      {
        accessorFn: (row) => millisToMinutesAndSeconds(row.duration_ms),
        header: "Duration",
        size: 40,
        filterFn: (row, id, filterValue) => {
          const filterMillis = /\d+:\d{2}/.test(filterValue)
            ? durationToMillis(filterValue)
            : null;
          if (filterMillis) {
            const rowMillis = row.original.duration_ms;
            return (
              rowMillis >= filterMillis - 1000 * 5 &&
              rowMillis <= filterMillis + 1000 * 5
            );
          }
          return true;
        },
        Cell: ({ cell }) => (
          <Box sx={{ fontFamily: 'monospace', color: 'rgba(255,255,255,0.8)' }}>
            {cell.getValue()}
          </Box>
        )
      },
      {

        accessorFn: (row) => row.plays,
        header: "Plays",
        enableColumnFilter: false,
        size: 20,
        Cell: ({ cell, row }) => (
          <Box sx={{ textAlign: "center" }}>
            <Tooltip
              title={row.original.plays
                .map((play) => {
                  return `${play.added_at.toLocaleDateString()} (${play.recencyScore
                    })`;
                })
                .join(", ")}
            >
              <Badge
                sx={{}}
                badgeContent={`${row.original.plays.length}`}
                color="primary"
              ></Badge>
            </Tooltip>
          </Box>
        )
      },
      {
        accessorFn: (row) => row.added_at,
        Cell: ({ cell }) => (
          <Box sx={{ color: 'rgba(255,255,255,0.7)' }}>
            {cell.getValue()?.toLocaleDateString()}
          </Box>
        ),
        header: "Added On",
        sortingFn: "datetime",
        size: 25
      },
      {
        accessorKey: "recencyScore",
        header: "Recency",
        size: 20,
        Cell: ({ cell }) => (
          <Box sx={{ 
            fontWeight: 700,
            color: cell.getValue() > 5 ? '#ff4444' : cell.getValue() > 0 ? '#ffaa00' : '#1DB954'
          }}>
            {cell.getValue()}
          </Box>
        )
      },
      {
        accessorKey: "lists",
        header: "Lists",
        filterVariant: "multi-select",
        filterFn: "contains",
        filterSelectOptions: Array.from(
          libraryPlaylists?.map((libraryPlaylist) => libraryPlaylist.name)
        ),
        Cell: ({ cell }) => (
          <Box sx={{ 
            fontSize: '0.75rem',
            color: 'rgba(255,255,255,0.6)'
          }}>
            {cell.getValue()}
          </Box>
        )
      }
    ],
    [libraryPlaylists, addTrack]
  );

  const Tracks = (props) => {
    if (!props.tracks) {
      return <Fragment />;
    }
    console.debug("RenderTracks");
    return (
      <MaterialReactTable
        className="TrackTable"
        layout="grid"
        columns={matColumns}
        enableColumnActions={false}
        enableFullScreenToggle={false}
        enableDensityToggle={false}
        enableStickyHeader={true}
        enableRowVirtualization={true}
        enablePagination={false}
        data={props.tracks}
        initialState={{
          pagination: { pageSize: 500 },
          density: "compact",
          showColumnFilters: true
        }} />
    );
  };

  // const TracksMemo = React.memo(Tracks);

  function ScrollTop(props) {
    const { children, window } = props;
    // Note that you normally won't need to set the window ref as useScrollTrigger
    // will default to window.
    // This is only being set here because the demo is in an iframe.
    const trigger = useScrollTrigger({
      target: window ? window() : undefined,
      disableHysteresis: true,
      threshold: 100,
    });

    const handleClick = (event) => {
      const anchor = (event.target.ownerDocument || document).querySelector(
        '#back-to-top-anchor',
      );

      if (anchor) {
        anchor.scrollIntoView({
          block: 'center',
        });
      }
    };

    return (
      <Fade in={trigger}>
        <Box
          onClick={handleClick}
          role="presentation"
          sx={{ position: 'fixed', bottom: 16, right: 16 }}
        >
          {children}
        </Box>
      </Fade>
    );
  }

  const TopShell = () => {
    const [drawerState, setDrawerState] = useState(false);
    function toggleDrawer(state) {
      console.debug(`toggledrawer ${state}`);
      setDrawerState(state);
    }

    return (
      <Fragment>
        <Drawer anchor={"left"} open={drawerState} onClose={() => toggleDrawer(false)}>
          <Box sx={{ width: 280, p: 3 }}>
            <Typography variant="h5" sx={{ mb: 3, fontWeight: 700, color: '#1DB954' }}>
              🎵 Menu
            </Typography>
            <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.7)' }}>
              More features coming soon...
            </Typography>
          </Box>
        </Drawer>
        
        <AppBar position="fixed" elevation={0} sx={{ backdropFilter: 'blur(10px)' }}>
          <Toolbar sx={{ py: 1 }}>
            <Tooltip title="Menu">
              <IconButton 
                color="inherit" 
                aria-label="menu" 
                onClick={() => toggleDrawer(!drawerState)}
                sx={{ mr: 2 }}
              >
                <MenuIcon />
              </IconButton>
            </Tooltip>
            <Typography 
              variant="h5" 
              component="div" 
              sx={{ 
                flexGrow: 1, 
                fontWeight: 700,
                background: 'linear-gradient(135deg, #FFFFFF 0%, #1DB954 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                letterSpacing: '-0.5px'
              }}
            >
              🎧 Playlist Planner
            </Typography>
            <Tooltip title="Refresh Authorization">
              <IconButton
                size="large"
                color="inherit"
                aria-label="Authorize"
                onClick={async () => await refreshAuthorization()}
                sx={{ mx: 1 }}
              >
                <VpnKeyIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Refresh Data">
              <IconButton
                size="large"
                color="inherit"
                aria-label="Refresh"
                onClick={async () => await refreshData()}
                sx={{ mx: 1 }}
              >
                <RefreshIcon />
              </IconButton>
            </Tooltip>
          </Toolbar>
        </AppBar>
        <Toolbar />
      </Fragment>
    )
  }

  const MainContent = (props) => {
    return (
      <Stack className="MainContent" spacing={2}>
        <Box className="playlist-selector-container" sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          <Autocomplete
            id="planning-playlist-selector"
            sx={{ 
              width: 400,
              '& .MuiInputBase-root': {
                borderRadius: '24px',
              }
            }}
            options={classPlaylists}
            autoHighlight
            value={playlistToPlan ?? null}
            onChange={(_event, newValue) => {
              setPlaylistToPlan(newValue);
            }}
            getOptionLabel={(option) => option.name}
            renderInput={(params) => (
              <TextField
                {...params}
                label="🎵 Choose a playlist to plan"
                variant="outlined"
                inputProps={{
                  ...params.inputProps,
                  autoComplete: 'new-password', // disable autocomplete and autofill
                }}
              />
            )}
          />
          <Tooltip title="Create new playlist">
            <IconButton 
              aria-label="new playlist" 
              onClick={addPlaylist}
              sx={{
                backgroundColor: 'rgba(29, 185, 84, 0.1)',
                '&:hover': {
                  backgroundColor: 'rgba(29, 185, 84, 0.2)',
                }
              }}
            >
              <AddCircleOutlineIcon fontSize="large" />
            </IconButton>
          </Tooltip>
        </Box>
        <Tracks tracks={trackLibrary} />
        <ScrollTop {...props}>
          <Fab size="medium" aria-label="scroll back to top">
            <KeyboardArrowUpIcon />
          </Fab>
        </ScrollTop>
      </Stack>
    );
  }

  // eslint-disable-next-line no-unused-vars
  const BottomShell = () => {
    const [drawerState, setDrawerState] = useState(false);
    function toggleDrawer(state) {
      console.debug(`toggledrawer ${state}`);
      setDrawerState(state);
    }

    return (
      <Fragment>
        <IconButton sx={{ position: 'fixed', bottom: 0, left: 0, zIndex: 999 }} color="inherit" aria-label="player" onClick={() => toggleDrawer(!drawerState)}>
          <PlayCircleFilledIcon />
        </IconButton>
        <Drawer anchor={"bottom"} open={drawerState} onClose={() => toggleDrawer(false)}>
          <SpotifyPlayer
            token={spotify.getAccessToken()}
            syncExternalDevice={true}
            callback={(state) => {
              if (!state.isPlaying) setIsPlaying(false);
            }}
            play={isPlaying}
            uris={playTrackUri}
          />
        </Drawer>
      </Fragment>
    );
  }
  // #endregion

  return (
    <ThemeProvider theme={darkTheme}>
      <Box component="main">
        <CssBaseline />

      <Stack className="App" spacing={1}>
        {console.debug("Render")}
        {isLoading ? (
          <SyncBackdrop telemetry={telemetry} onRetry={getData} />
        )
          : isSpotifyAuthorized ? (
            <Fragment>
              <TopShell />
              <MainContent />
              {/* <BottomShell /> */}
            </Fragment>
          ) : (
            <Box className="auth-container">
              <Box sx={{ textAlign: 'center' }}>
                <div className="auth-logo">
                  <FontAwesomeIcon icon={faSpotify} />
                </div>
                <h1 className="auth-title">Playlist Planner</h1>
                <p className="auth-subtitle">Your ultimate tool for managing Spotify playlists</p>
              </Box>
              <Button 
                size="large" 
                color="success" 
                sx={{ 
                  backgroundColor: '#1DB954',
                  fontSize: '1.25rem',
                  px: 6,
                  py: 2,
                  borderRadius: '32px',
                  boxShadow: '0 8px 24px rgba(29, 185, 84, 0.4)',
                  '&:hover': {
                    backgroundColor: '#1ed760',
                    transform: 'scale(1.05)',
                    boxShadow: '0 12px 32px rgba(29, 185, 84, 0.6)',
                  },
                  transition: 'all 0.3s ease'
                }} 
                variant="contained" 
                startIcon={<FontAwesomeIcon fontSize="inherit" icon={faSpotify} />} 
                onClick={spotify.authorizeSpotify}
              >
                Connect to Spotify
              </Button>
            </Box>
          )}
      </Stack>
      </Box>
    </ThemeProvider>
  );
}

export default App;
