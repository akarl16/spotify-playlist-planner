import "./styles.css";
import React, { useState, useEffect, useMemo, Fragment } from "react";
import MaterialReactTable from "material-react-table";
import SpotifyPlayer from "react-spotify-web-playback";

import PlayCircleFilledIcon from '@mui/icons-material/PlayCircleFilled';
import RefreshIcon from '@mui/icons-material/Refresh';
import MenuIcon from '@mui/icons-material/Menu';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { icon } from '@fortawesome/fontawesome-svg-core/import.macro';

import AppBar from "@mui/material/AppBar";
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Backdrop from "@mui/material/Backdrop";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button"
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Stack from '@mui/material/Stack';

import "json.date-extensions";
import * as spotify from "./spotify.js";
import * as database from "./database.js";

function App() {
  const [trackLibrary, setTrackLibrary] = useState([]);
  const [libraryPlaylists, setLibraryPlaylists] = useState([]);
  const [classPlaylists, setClassPlaylists] = useState([]);
  const [isSpotifyAuthorized, setIsSpotifyAuthorized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [playlistToPlan, setPlaylistToPlan] = useState();
  const [loadState, setLoadState] = useState({
    playlistHeaderCount: 0,
    playlistHeaderTotal: 0,
    playlistDetailsCount: 0,
    playlistDetailsTotal: 0,
    isLoading: false,
    loadMessage: ""
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [playTrackUri, setPlayTrackUri] = useState([]);



  const millisToMinutesAndSeconds = (millis) => {
    var minutes = Math.floor(millis / 60000);
    var seconds = ((millis % 60000) / 1000).toFixed(0);
    return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));


  const durationToMillis = (duration) => {
    const durationParts = duration.split(":");
    const millis = durationParts[0] * 60000 + durationParts[1] * 1000;
    console.debug("millis", millis);
    return millis;
  };

  const getPlaylistHeaders = async () => {
    let playlistHeaders = [];

    playlistHeaders = await database.getPlaylists();

    if (playlistHeaders && playlistHeaders.length > 0) {
      console.debug("Found playlists in local storage");
    } else {
      console.debug("No playlists in storage");
      playlistHeaders = await retrievePlaylistHeaders();
      database.setPlaylists(playlistHeaders);
    }

    return playlistHeaders;
  };

  async function retrievePlaylistHeaders() {
    let playlistHeaders = [];
    var offset = 0;
    var more = true;

    while (more) {
      const spotifyApi = await spotify.getSpotifyApi();
      const _playlistsResult = await spotifyApi.getUserPlaylists({
        limit: 50,
        offset: offset
      });

      playlistHeaders.push(..._playlistsResult.items);
      more = _playlistsResult.next !== null;
      offset = offset + _playlistsResult.items.length;
      loadState.playlistHeaderCount = playlistHeaders.length;
      loadState.playlistHeaderTotal = _playlistsResult.total;
      loadState.isLoading = true;
      loadState.loadMessage = `${loadState.playlistHeaderCount}/${loadState.playlistHeaderTotal} Playlist headers`;
      setLoadState({ ...loadState });
    }
    loadState.isLoading = false;
    setLoadState({ ...loadState });
    return playlistHeaders;
  }

  const getPlaylistTracks = async (_playlistHeaders) => {
    var loaded = 0;
    loadState.playlistDetailsCount = loaded;
    loadState.playlistDetailsTotal = _playlistHeaders.length;
    loadState.isLoading = true;
    loadState.loadMessage = `${loadState.playlistDetailsCount}/${loadState.playlistDetailsTotal} Playlist details`;
    setLoadState({ ...loadState });
    const playlists = await Promise.all(
      _playlistHeaders.map(async (playlistHeader) => {
        if (!playlistHeader.trackList) {
          console.debug(`Populating tracklist for playlist ${playlistHeader.id}`);
          playlistHeader.trackList = await retrievePlaylistTracks(playlistHeader.id);
          database.setPlaylist(playlistHeader);
        }
        loadState.playlistDetailsCount = ++loaded;
        loadState.playlistDetailsTotal = _playlistHeaders.length;
        loadState.isLoading = true;
        loadState.loadMessage = `${loadState.playlistDetailsCount}/${loadState.playlistDetailsTotal} Playlist details`;
        setLoadState({ ...loadState });
        return playlistHeader;
      })
    );
    return playlists;
  };

  const retrievePlaylistTracks = async (_playlistId) => {
    console.debug("Retrieving tracks");
    const tracks = [];
    var more = true;
    var offset = 0;

    const spotifyApi = await spotify.getSpotifyApi();
    while (more) {
      try {
        const tracksResult = await spotifyApi.getPlaylistTracks(_playlistId, {
          limit: 50,
          offset: offset
        });
        tracks.push(...tracksResult.items);
        more = tracksResult.next !== null;
        offset = offset + tracksResult.items.length;
      } catch (e) {
        console.warn("Error retrieving playlist tracks");

        if (e.status === 429) {
          console.warn("Rate limit exceeded");
          await sleep(6000);
          continue; //Retry
        } else {
          console.error(e);
          break;
        }
      }
    }
    return tracks.map((entry) => {
      return {
        id: entry.track.id,
        added_at: new Date(entry.added_at),
        name: entry.track.name,
        artists: entry.track.artists,
        duration_ms: entry.track.duration_ms
      };
    });
  };

  const getTracksAudioFeatures = async (trackIds) => {
    const audioFeaturesMap = new Map();
    const retrieveTrackIds = [];
    for (const trackId of trackIds) {
      const trackAudioFeatures = await database.getTrackAudioFeatures(trackId);
      if (!trackAudioFeatures) {
        retrieveTrackIds.push(trackId);
      } else {
        audioFeaturesMap.set(trackAudioFeatures.id, trackAudioFeatures);
      }
    }
    if (retrieveTrackIds.length > 0) {
      const retrievedTracksAudioFeatures = await retrieveTracksAudioFeatures(retrieveTrackIds);
      for (const trackAudioFeatures of retrievedTracksAudioFeatures) {
        database.putTrackAudioFeatures(trackAudioFeatures);
        audioFeaturesMap.set(trackAudioFeatures.id, trackAudioFeatures);
      }
    }
    return audioFeaturesMap;
  }

  const retrieveTracksAudioFeatures = async (trackIds) => {
    console.debug(`Retrieving tracks ${trackIds}`);
    const batchSize = 100;
    const spotifyApi = await spotify.getSpotifyApi();
    const tracks = [];
    for (let i = 0; i < trackIds.length; i += batchSize) {
      const batch = trackIds.slice(i, i += batchSize);
      const getResult = await spotifyApi.getAudioFeaturesForTracks(batch);
      if (getResult.audio_features && getResult.audio_features.length > 0) {
        tracks.push(...getResult.audio_features);
      } else {
        console.error(`Error retrieving tracks for ${trackIds}`);
        console.error(getResult);
      }
    }
    return tracks;
  }

  const buildTrackLibrary = async (libraryPlaylists, classPlaylists) => {
    const today = new Date().getTime();
    const todayMinus7 = today - 7 * 1000 * 60 * 60 * 24;
    const todayMinus30 = today - 30 * 1000 * 60 * 60 * 24;
    const todayMinus90 = today - 90 * 1000 * 60 * 60 * 24;
    const todayMinus180 = today - 180 * 1000 * 60 * 60 * 24;
    const trackMap = new Map();

    //Add class play details
    for (const libraryPlaylist of libraryPlaylists) {
      for (const libraryTrack of libraryPlaylist.trackList) {
        var track = libraryTrack;
        if (trackMap.has(libraryTrack.id)) {
          track = trackMap.get(libraryTrack.id);
          track.lists += "," + libraryPlaylist.name;
        } else {
          track.recencyScore = 0;
          track.plays = [];
          track.lists = libraryPlaylist.name;
          trackMap.set(track.id, track);
        }
      }
    }

    const trackList = Array.from(trackMap.values());

    //Calculate recency score
    for (const track of trackList) {
      for (const classPlaylist of classPlaylists) {
        const playlistTracks = classPlaylist.trackList.filter(
          (playlistTrack) => playlistTrack.id === track.id
        );
        for (const playlistTrack of playlistTracks) {
          track.plays.push(playlistTrack);
          const playDate = playlistTrack.added_at.getTime();
          if (playDate > todayMinus7) {
            track.recencyScore += 10;
            playlistTrack.recencyScore = 10;
          } else if (playDate > todayMinus30) {
            track.recencyScore += 5;
            playlistTrack.recencyScore = 5;
          } else if (playDate > todayMinus90) {
            track.recencyScore += 2;
            playlistTrack.recencyScore = 2;
          } else if (playDate > todayMinus180) {
            track.recencyScore += 1;
            playlistTrack.recencyScore = 1;
          } else {
            track.recencyScore += 0;
            playlistTrack.recencyScore = 0;
          }
        }
      }
    }

    //Add track audio details
    const tracksAudioDetails = await getTracksAudioFeatures(trackList.map(track => track.id));
    for (const track of trackList) {
      track.audio_features = tracksAudioDetails.get(track.id);
    }

    trackList.sort(
      (a, b) => (a.recencyScore - b.recencyScore || b.added_at - a.added_at)
    );
    return trackList;
  };

  const refreshData = async () => {
    database.setPlaylists(await retrievePlaylistHeaders());
    setTrackLibrary(null);
    await getData();
  };

  const refreshAuthorization = async () => {
    spotify.authorizeSpotify();
  }

  const playTrack = async (trackId) => {
    console.debug(`PLAYING TRACK ${trackId}`);
    const spotifyApi = await spotify.getSpotifyApi();
    await spotifyApi.play({
      uris: [`spotify:track:${trackId}`]
    });
    // setPlayTrackUri(`spotify:track:${trackId}`);
    // setIsPlaying(true);
  };

  const addTrack = async (trackId) => {
    console.debug(`ADDING TRACK ${trackId} TO PLAYLIST ${playlistToPlan.name}`);
    
    const track = trackLibrary.find((track) => track.id === trackId);
    const duration_string = "0:" + millisToMinutesAndSeconds(track.duration_ms);
    navigator.clipboard.writeText(`${track.name}\t${duration_string}`);

    const spotifyApi = await spotify.getSpotifyApi();
    await spotifyApi.addTracksToPlaylist(playlistToPlan.id, [`spotify:track:${trackId}`]);
  };

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

  const getData = async () => {
    setIsLoading(true);
    const _dateRegex = /([12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))/;
    const _libraryRegex = /\[LIBRARY\]/;

    const _playlistHeaders = await getPlaylistHeaders();
    console.debug("GOT PLAYLIST HEADERS");

    _playlistHeaders.sort((a, b) => a.name - b.name);
    for (const cpl of _playlistHeaders) {
      cpl.isClassPlaylist = _dateRegex.test(cpl.name);
    }

    const _libraryPlaylistHeaders = _playlistHeaders.filter(
      (playlist) =>
        _libraryRegex.test(playlist.name) ||
        _libraryRegex.test(playlist.description)
    );

    const _classPlaylistHeaders = _playlistHeaders.filter((playlist) =>
      _dateRegex.test(playlist.name)
    );

    const _libraryPlaylists = await getPlaylistTracks(_libraryPlaylistHeaders);
    _libraryPlaylists.sort((a, b) => a.name.localeCompare(b.name));
    const _classPlaylists = await getPlaylistTracks(_classPlaylistHeaders);
    _classPlaylists.sort((a, b) => b.name.localeCompare(a.name));

    console.debug("Library playlists");
    console.debug(_libraryPlaylistHeaders);
    console.debug("Class playlists");
    console.debug(_classPlaylistHeaders);

    const _trackLibrary = await buildTrackLibrary(_libraryPlaylists, _classPlaylists);
    console.debug("Track library");
    console.debug(_trackLibrary);

    setClassPlaylists(_classPlaylists);
    setLibraryPlaylists(_libraryPlaylists);
    setTrackLibrary(_trackLibrary);
    setIsLoading(false);
  };

  const Tracks = (props) => {
    if (!props.tracks) {
      return <div />;
    }
    return (
      <div style={{ display: "flex", height: "100%" }}>
        <div style={{ flexGrow: 1 }}>
          <MaterialReactTable
            columns={matColumns}
            data={props.tracks}
            initialState={{
              pagination: { pageSize: 100 },
              density: "compact",
              showColumnFilters: true
            }}
          />
        </div>
      </div>
    );
  };

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

  useEffect(() => {
    async function fetchData() {
      console.log('fetching data');
      await getData();
      setIsLoading(false);
    }
    if (isSpotifyAuthorized) {
      fetchData();
    }
  }, [isSpotifyAuthorized])

  const matColumns = useMemo(
    () => [
      {
        id: "blah",
        header: "Actions",
        size: 40,
        Cell: ({ renderedCellValue, row }) => (
          <Fragment>
            <IconButton onClick={async () => await playTrack(row.original.id)}>
              <PlayCircleFilledIcon />
            </IconButton>
            <IconButton onClick={async () => await addTrack(row.original.id)}>
              <PlaylistAddIcon />
            </IconButton>
          </Fragment>
        )
      },
      {
        accessorKey: "name",
        header: "Track Name",
        size: 100,
        enableClickToCopy: true,
        maxSize: 200
      },
      {
        accessorFn: (row) => row.artists.map((artist) => artist.name).join(", "),
        accessorKey: "artists",
        header: "Artist(s)",
        size: 100,
        maxSize: 100
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
        }
      },
      {
        accessorKey: "audio_features.tempo",
        header: "Tempo",
        size: 20
      },
      {
        accessorKey: "audio_features.energy",
        header: "Energy",
        size: 20
      },
      {

        accessorFn: (row) => row.plays,
        header: "Plays",
        enableColumnFilter: false,
        size: 20,
        Cell: ({ cell, row }) => (
          <Box sx={{textAlign: "center"}}>
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
        Cell: ({ cell }) => cell.getValue()?.toLocaleDateString(),
        header: "Added On",
        sortingFn: "datetime",
        size: 20
      },
      {
        accessorKey: "recencyScore",
        header: "Recency",
        size: 20
      },
      {
        accessorKey: "lists",
        header: "Lists",
        filterVariant: "select",
        filterFn: "contains",
        filterSelectOptions: Array.from(
          libraryPlaylists?.map((libraryPlaylist) => libraryPlaylist.name)
        )
      }
    ],
    [libraryPlaylists]
  );

  return (
    <div className="App" style={{ height: "100%" }}>
      {console.debug("Render")}
      {isLoading ? (
        <Backdrop open={true} sx={{ color: "#fff" }}>
          <CircularProgress color="inherit" />
        </Backdrop>
      )
        : isSpotifyAuthorized ? (
          <Box sx={{ display: "flex", marginTop: 10 }}>
            {/* <CssBaseline /> */}
            <AppBar
              position="fixed"
              color="primary"
              sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}
            >
              <Toolbar>
                <IconButton color="inherit" aria-label="menu">
                  <MenuIcon />
                </IconButton>
                <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
                  Playlist Planner
                </Typography>
                <IconButton
                  size="large"
                  color="inherit"
                  aria-label="Authorize"
                  onClick={async () => await refreshAuthorization()}
                >
                  <VpnKeyIcon />
                </IconButton>
                <IconButton
                  size="large"
                  color="inherit"
                  aria-label="Refresh"
                  onClick={async () => await refreshData()}
                >
                  <RefreshIcon />
                </IconButton>
              </Toolbar>
            </AppBar>
            <Box component="main" sx={{ flexGrow: 1, mb: '10px' }}>
              <Stack direction="row">
                <Autocomplete
                  id="planning-playlist-selector"
                  sx={{ width: 300 }}
                  options={classPlaylists}
                  autoHighlight
                  onChange={(_event, newValue) => {
                    setPlaylistToPlan(newValue);
                    playlistToPlan = newValue; //Redundant but necessary since the state won't update until re-render
                    console.log("playlistToPlan", playlistToPlan);
                  }}
                  getOptionLabel={(option) => option.name}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Choose a playlist to plan"
                      inputProps={{
                        ...params.inputProps,
                        autoComplete: 'new-password', // disable autocomplete and autofill
                      }}
                    />
                  )}
                />
                <IconButton aria-label="new playlist" onClick={addPlaylist}>
                  <AddCircleOutlineIcon />
                </IconButton>
              </Stack>
              <Tracks tracks={trackLibrary} />
            </Box>
            <AppBar position="fixed" sx={{ top: 'auto', bottom: 0 }} color='default'>
              <Toolbar><SpotifyPlayer
                token={spotify.getAccessToken()}
                syncExternalDevice={true}
                callback={(state) => {
                  if (!state.isPlaying) setIsPlaying(false);
                }}
                play={isPlaying}
                uris={playTrackUri}
              /></Toolbar>
            </AppBar>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignContent: 'center', height: '100%', alignItems: 'center' }}>
            <Button size="large" color="success" sx={{ backgroundColor: '#1DB954', fontSize: '1.5em' }} variant="contained" startIcon={<FontAwesomeIcon fontSize="inherit" icon={icon({ name: 'spotify', style: 'brands' })} />} onClick={spotify.authorizeSpotify}>Authorize Spotify access</Button>
          </Box>
        )}
    </div>
  );
}

export default App;
