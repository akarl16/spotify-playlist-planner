import "./styles.css";
import React, { useState, useEffect, useMemo, Fragment } from "react";
import MaterialReactTable from "material-react-table";

import PlayCircleFilledIcon from '@mui/icons-material/PlayCircleFilled';
import RefreshIcon from '@mui/icons-material/Refresh';
import MenuIcon from '@mui/icons-material/Menu';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import VpnKeyIcon from '@mui/icons-material/VpnKey';

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

import "json.date-extensions";
import * as spotify from "./spotify.js";
import * as database from "./database.js";

function App() {
  const [trackLibrary, setTrackLibrary] = useState([]);
  const [libraryPlaylists, setLibraryPlaylists] = useState([]);
  const [classPlaylists, setClassPlaylists] = useState([]);
  const [isSpotifyAuthorized, setIsSpotifyAuthorized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [playlistToPlan, setPlaylistToPlan] = useState();

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
        enableClickToCopy: true
      },
      {
        accessorKey: "artists",
        header: "Artist(s)",
        size: 100
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
        accessorKey: "plays",
        header: "Plays",
        size: 40,
        Cell: ({ renderedCellValue, row }) => (
          <Fragment>
            <Tooltip
              title={row.original.plays
                .map((play) => {
                  return `${play.added_at.toLocaleDateString()} (${play.recencyScore
                    })`;
                })
                .join(", ")}
            >
              <Badge
                badgeContent={row.original.plays.length}
                color="primary"
              ></Badge>
            </Tooltip>
          </Fragment>
        )
      },
      {
        accessorFn: (row) => row.added_at,
        Cell: ({ cell }) => cell.getValue()?.toLocaleDateString(),
        header: "Added On",
        sortingFn: "datetime",
        size: 40
      },
      {
        accessorKey: "recencyScore",
        header: "Recency",
        size: 40
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

  const buildTrackLibrary = (libraryPlaylists, classPlaylists) => {
    const today = new Date().getTime();
    const todayMinus7 = today - 7 * 1000 * 60 * 60 * 24;
    const todayMinus30 = today - 30 * 1000 * 60 * 60 * 24;
    const todayMinus90 = today - 90 * 1000 * 60 * 60 * 24;
    const todayMinus180 = today - 180 * 1000 * 60 * 60 * 24;
    const trackMap = new Map();
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
  
    trackList.sort(
      (a, b) => a.recencyScore - b.recencyScore || b.added_at - a.added_at
    );
    return trackList;
  };
  
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
  
  const getAllTracks = async (_playlistId) => {
    console.debug("Retrieving tracks");
    const tracks = [];
    var more = true;
    var offset = 0;
  
    const spotifyApi = await spotify.getSpotifyApi();
    while (more) {
      const tracksResult = await spotifyApi.getPlaylistTracks(_playlistId, {
        limit: 50,
        offset: offset
      });
      tracks.push(...tracksResult.items);
      more = tracksResult.next !== null;
      offset = offset + tracksResult.items.length;
    }
    return tracks.map((track) => {
      return {
        id: track.track.id,
        added_at: new Date(track.added_at),
        name: track.track.name,
        duration_ms: track.track.duration_ms,
        artists: track.track.artists.map((artist) => artist.name)
      };
    });
  };
  
  const getPlaylistHeaders = async () => {
    let playlistHeaders = [];

    playlistHeaders = await database.getPlaylists();

    if (playlistHeaders && playlistHeaders.length > 0) {
      console.debug("Found playlists in local storage");
    } else {
      console.debug("No playlists in storage");
      playlistHeaders = retrievePlaylistHeaders();
      database.setPlaylists(playlistHeaders);
    }
  
    return playlistHeaders;
  };

  async function retrievePlaylistHeaders() {
    let playlistHeaders = [];
    var offset = 0;
    var more = true;

    while (more) {
      console.debug("Retrieving playlists");
      const spotifyApi = await spotify.getSpotifyApi();
      const _playlistsResult = await spotifyApi.getUserPlaylists({
        limit: 50,
        offset: offset
      });

      playlistHeaders.push(..._playlistsResult.items);
      more = _playlistsResult.next !== null;
      offset = offset + _playlistsResult.items.length;
    }
    return playlistHeaders;
  }
  
  const getPlaylists = async (_playlistHeaders) => {
    const playlists = await Promise.all(
      _playlistHeaders.map(async (playlistHeader) => {
        var playlistStorage = localStorage.getItem(
          `playlist-${playlistHeader.id}`
        );
        var playlist = null;
        if (playlistStorage && playlistStorage.length > 0) {
          playlist = JSON.parseWithDate(
            localStorage.getItem(`playlist-${playlistHeader.id}`)
          );
        } else {
          playlist = {
            id: playlistHeader.id,
            name: playlistHeader.name,
            description: playlistHeader.description,
            trackList: await getAllTracks(playlistHeader.id)
          };
        }
        localStorage.setItem(`playlist-${playlist.id}`, JSON.stringify(playlist));
        return playlist;
      })
    );
    return playlists;
  };

  const refreshData = async () => {

    database.clearPlaylists();
    database.setPlaylists(await retrievePlaylistHeaders());
    // var playlistStorage = localStorage.getItem("playlists");
    // if (playlistStorage && playlistStorage.length > 0) {
    //   console.debug("Removing playlists in local storage");
    //   const playlists = JSON.parse(playlistStorage);
    //   for (const playlist of playlists) {
    //     localStorage.removeItem(`playlist-${playlist.id}`);
    //   }
    //   localStorage.removeItem("playlists");
    // }
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
  };

  const addTrack = async (trackId) => {
    console.debug(`ADDING TRACK TO PLAYLIST ${trackId}`);
    const spotifyApi = await spotify.getSpotifyApi();
    await spotifyApi.addTracksToPlaylist(playlistToPlan.id,[`spotify:track:${trackId}`]);
    const track = trackLibrary.find((track) => track.id === trackId);
    const duration_string = "0:" + millisToMinutesAndSeconds(track.duration_ms);
    navigator.clipboard.writeText(`${track.name}\t${duration_string}`);
  };

  const getData = async () => {
    setIsLoading(true);
    const _dateRegex = /([12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))/;
    const _libraryRegex = /\[LIBRARY\]/;

    const _playlistHeaders = await getPlaylistHeaders();
    _playlistHeaders.sort((a, b) => a.name - b.name);
    for (const cpl of _playlistHeaders) {
      cpl.isClassPlaylist = _dateRegex.test(cpl.name);
    }
    console.debug("GOT PLAYLIST HEADERS");
    console.debug(
      _playlistHeaders.map((pl) => {
        return { name: pl.name, isClassPlaylist: pl.isClassPlaylist };
      })
    );
    // console.debug(_playlistHeaders);

    const _libraryPlaylistHeaders = _playlistHeaders.filter(
      (playlist) =>
        _libraryRegex.test(playlist.name) ||
        _libraryRegex.test(playlist.description)
    );
    console.debug("Library playlists");
    console.debug(_libraryPlaylistHeaders);

    const _classPlaylistHeaders = _playlistHeaders.filter((playlist) =>
      _dateRegex.test(playlist.name)
    );
    _classPlaylistHeaders.sort((a, b) => a.name - b.name);

    console.debug("Class playlists");
    console.debug(_classPlaylistHeaders);

    const _libraryPlaylists = await getPlaylists(_libraryPlaylistHeaders);
    const _classPlaylists = await getPlaylists(_classPlaylistHeaders);
    _classPlaylists.sort((a, b) => a.name - b.name);

    const _trackLibrary = buildTrackLibrary(_libraryPlaylists, _classPlaylists);

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
    if(isSpotifyAuthorized) {
      fetchData();
    }
  }, [isSpotifyAuthorized])

  return (
    <div className="App" style={{ height: "100%" }}>
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
            <Box component="main" sx={{ flexGrow: 1 }}>
              <Autocomplete
                id="planning-playlist-selector"
                sx={{ width: 300 }}
                options={classPlaylists}
                autoHighlight
                onChange={(_event,newValue) => 
                  {
                    setPlaylistToPlan(newValue);
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
              {console.debug("Render: Track Library", trackLibrary)}
              <Tracks tracks={trackLibrary} />
            </Box>
          </Box>
        ) : (
          <Button variant="contained" color="primary" onClick={spotify.authorizeSpotify}>Authorize Spotify access</Button>
        )}
    </div>
  );
}

export default App;
