import "./styles.css";
import "spotify-web-api-js";
import SpotifyWebApi from "spotify-web-api-js";
import React, { useState, useEffect, Fragment } from "react";
import Backdrop from "@mui/material/Backdrop";
import CircularProgress from "@mui/material/CircularProgress";
import {
  DataGrid,
  GridToolbarContainer,
  GridToolbarQuickFilter
} from "@mui/x-data-grid";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import IconButton from "@mui/material/IconButton";
import RefreshIcon from "@mui/icons-material/Refresh";
import PlayCircleFilledIcon from "@mui/icons-material/PlayCircleFilled";
import { Badge, Tooltip, Typography } from "@mui/material";
import "json.date-extensions";

const ignorePlaylists = ["Mellow cycle", "FTP Test", "Holiday cycle"];
const spotifyApi = new SpotifyWebApi();

const getTokenFromUrl = () => {
  return window.location.hash
    .substring(1)
    .split("&")
    .reduce((initial, item) => {
      var parts = item.split("=");
      initial[parts[0]] = decodeURIComponent(parts[1]);
      return initial;
    }, {});
};

const getToken = () => {
  const hash = getTokenFromUrl();
  if (hash.access_token) {
    console.debug("Token found in URL");
    setToken(hash.access_token, hash.expires_in * 1000);
    return hash.access_token;
  }
  const tokenString = localStorage.getItem("token");
  if (!tokenString) {
    console.debug("No token found in local storage");
    return tokenString;
  } else {
    console.debug("Token found in storage");
  }
  const tokenObject = JSON.parse(tokenString);
  const now = new Date();
  if (now.getTime() > tokenObject.expiration) {
    console.debug("Token expired in local storage");
    localStorage.removeItem("token");
    return undefined;
  } else {
    console.debug("Token not expired in storage");
  }
  return tokenObject.value;
};

const setToken = (value, ttl) => {
  const now = new Date();
  const tokenObject = {
    expiration: now.getTime() + ttl,
    value: value
  };
  localStorage.setItem("token", JSON.stringify(tokenObject));
};

const findAggregatedPlaylist = (_playlists) => {
  const ag = _playlists.find(
    (playlist) => playlist.name === "Aggregated Cycle"
  );
  return ag;
};

const calculateStats = async (trackLibrary, playlists) => {
  const today = new Date().getTime();
  const todayMinus7 = today - 7 * 1000 * 60 * 60 * 24;
  const todayMinus30 = today - 30 * 1000 * 60 * 60 * 24;
  const todayMinus90 = today - 90 * 1000 * 60 * 60 * 24;
  for (const libraryTrack of trackLibrary) {
    libraryTrack.recencyScore = 0;
    libraryTrack.plays = [];
    for (const playlist of playlists) {
      const playlistTracks = playlist.trackList.filter(
        (playlistTrack) => playlistTrack.id === libraryTrack.id
      );
      for (const playlistTrack of playlistTracks) {
        libraryTrack.plays.push(playlistTrack);
        const playDate = playlistTrack.added_at.getTime();
        if (playDate > todayMinus7) {
          libraryTrack.recencyScore += 10;
          playlistTrack.recencyScore = 10;
        } else if (playDate > todayMinus30) {
          libraryTrack.recencyScore += 5;
          playlistTrack.recencyScore = 5;
        } else if (playDate > todayMinus90) {
          libraryTrack.recencyScore += 2;
          playlistTrack.recencyScore = 2;
        } else {
          libraryTrack.recencyScore += 1;
          playlistTrack.recencyScore = 1;
        }
      }
    }
  }
  trackLibrary.sort(
    (a, b) => a.recencyScore - b.recencyScore || b.added_at - a.added_at
  );
  // trackLibrary.sort((a, b) => b.added_at - a.added_at);
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

const getPlaylists = async () => {
  var playlistHeaders = [];
  const playlistHeaderStorage = localStorage.getItem("playlists");
  if (playlistHeaderStorage && playlistHeaderStorage.length > 0) {
    console.debug("Found playlists in local storage");
    playlistHeaders = JSON.parse(playlistHeaderStorage);
    //TODO Get new playlists
  } else {
    var offset = 0;
    var more = true;

    while (more) {
      console.debug("Retrieving playlists");
      const _playlistsResult = await spotifyApi.getUserPlaylists("akarl16", {
        limit: 50,
        offset: offset
      });

      playlistHeaders.push(..._playlistsResult.items);
      more = _playlistsResult.next !== null;
      offset = offset + _playlistsResult.items.length;
    }

    playlistHeaders = playlistHeaders.filter(
      (playlist) => playlist.public && !ignorePlaylists.includes(playlist.name)
    );

    localStorage.setItem("playlists", JSON.stringify(playlistHeaders));
  }

  const playlists = await Promise.all(
    playlistHeaders.map(async (playlistHeader) => {
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
          trackList: await getAllTracks(playlistHeader.id)
        };
      }
      localStorage.setItem(`playlist-${playlist.id}`, JSON.stringify(playlist));
      return playlist;
    })
  );

  return playlists;
};

function App() {
  const clientId = "c4145d13614447e9b3bcd287499086f4";
  const redirectUri = "https://h86650.csb.app/";
  const scopes = ["playlist-read-collaborative", "user-modify-playback-state"];
  const loginUrl = encodeURI(
    `https://accounts.spotify.com/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scopes.join(
      " "
    )}&response_type=token&show_dialog=true`
  );
  const [trackLibrary, setTrackLibrary] = useState();
  const apiToken = getToken();

  const columns = [
    {
      field: "name",
      headerName: "Track Name",
      flex: 1,
      renderCell: (params) => {
        return (
          <Fragment>
            <IconButton onClick={async () => await playTrack(params.row.id)}>
              <PlayCircleFilledIcon />
            </IconButton>
            {params.value}
          </Fragment>
        );
      },
      getApplyQuickFilterFn: undefined
    },
    {
      field: "artists",
      headerName: "Artist(s)",
      flex: 0.5,
      getApplyQuickFilterFn: undefined
    },
    {
      field: "duration_ms",
      headerName: "Duration",
      flex: 0.2,
      valueGetter: (params) => millisToMinutesAndSeconds(params.value),
      getApplyQuickFilterFn: (filterValue) => {
        const filterMillis = /\d+:\d{2}/.test(filterValue)
          ? durationToMillis(filterValue)
          : null;
        console.debug("filterValue", filterValue, filterMillis);
        return (params) => {
          if (filterMillis) {
            const rowMillis = params.row["duration_ms"];
            return (
              rowMillis >= filterMillis - 1000 * 5 &&
              rowMillis <= filterMillis + 1000 * 5
            );
          }
          return params.value.startsWith(filterValue);
        };
      }
    },
    {
      field: "plays",
      headerName: "Plays",
      flex: 0.1,
      renderCell: (params) => {
        return (
          <Fragment>
            <Tooltip
              title={params.value
                .map((play) => {
                  return `${play.added_at.toLocaleDateString()} (${
                    play.recencyScore
                  })`;
                })
                .join(", ")}
            >
              <Badge badgeContent={params.value.length} color="primary"></Badge>
            </Tooltip>
          </Fragment>
        );
      },
      getApplyQuickFilterFn: undefined
    },
    {
      field: "added_at",
      type: "dateTime",
      headerName: "Added On",
      flex: 0.2,
      valueFormatter: (params) =>
        `${
          params.value.getMonth() + 1
        }/${params.value.getDate()}/${params.value.getFullYear()}`,
      getApplyQuickFilterFn: undefined
    },
    {
      field: "recencyScore",
      type: "number",
      headerName: "Recency",
      flex: 0.1,
      getApplyQuickFilterFn: undefined
    }
  ];

  const refreshData = async () => {
    var playlistStorage = localStorage.getItem("playlists");
    if (playlistStorage && playlistStorage.length > 0) {
      console.debug("Removing playlists in local storage");
      const playlists = JSON.parse(playlistStorage);
      for (const playlist of playlists) {
        localStorage.removeItem(`playlist-${playlist.id}`);
      }
      localStorage.removeItem("playlists");
    }
    setTrackLibrary(null);
    await getData();
  };

  const playTrack = async (trackId) => {
    console.debug(`PLAYING TRACK ${trackId}`);
    await spotifyApi.play({
      uris: [`spotify:track:${trackId}`]
    });
    // await spotifyApi.pause();
  };

  const getData = async () => {
    const _playlists = await getPlaylists();
    console.debug("GOT PLAYLISTS");
    console.debug(_playlists);

    const _aggregatedPlaylist = findAggregatedPlaylist(_playlists);

    const _classPlaylists = _playlists.filter(
      (playlist) => playlist.id !== _aggregatedPlaylist.id
    );

    await calculateStats(_aggregatedPlaylist.trackList, _classPlaylists);
    setTrackLibrary(_aggregatedPlaylist.trackList);
  };

  const CustomToolbar = () => {
    return (
      <GridToolbarContainer>
        <GridToolbarQuickFilter placeholder="Duration" />
      </GridToolbarContainer>
    );
  };

  const Tracks = (props) => {
    if (!props.tracks) {
      return <div />;
    }

    return (
      <div style={{ display: "flex", height: "100%" }}>
        <div style={{ flexGrow: 1 }}>
          <DataGrid
            rows={props.tracks}
            columns={columns}
            autoHeight
            stickyHeader
            density="compact"
            components={{ Toolbar: CustomToolbar }}
          />
        </div>
      </div>
    );
  };

  useEffect(() => {
    window.location.hash = "";
    if (apiToken) {
      console.debug("Token");
      console.debug(apiToken);
      spotifyApi.setAccessToken(apiToken);
      getData();
    }
  }, [apiToken]);

  console.debug("Render");
  console.debug(trackLibrary);
  return (
    <div className="App" style={{ height: "100%" }}>
      {apiToken ? (
        <Fragment>
          <AppBar position="static" color="inherit">
            <Toolbar>
              <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
                Playlist Planner
              </Typography>
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
          {trackLibrary ? (
            <Tracks tracks={trackLibrary} />
          ) : (
            <Backdrop open={true} sx={{ color: "#fff" }}>
              <CircularProgress color="inherit" />
            </Backdrop>
          )}
        </Fragment>
      ) : (
        <a href={loginUrl}>Get Token</a>
      )}
    </div>
  );
}

export default App;
