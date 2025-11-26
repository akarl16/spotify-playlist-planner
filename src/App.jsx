import "./styles.css";
import React, { useState, useEffect, useMemo, useCallback, Fragment, useRef } from "react";
import { MaterialReactTable } from 'material-react-table';
import SpotifyPlayer from "react-spotify-web-playback";

import PlayCircleFilledIcon from '@mui/icons-material/PlayCircleFilled';
import RefreshIcon from '@mui/icons-material/Refresh';
import MenuIcon from '@mui/icons-material/Menu';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import FilterListOffIcon from '@mui/icons-material/FilterListOff';
import StorageIcon from '@mui/icons-material/Storage';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import BarChartIcon from '@mui/icons-material/BarChart';
import SearchIcon from '@mui/icons-material/Search';
import QueueMusicIcon from '@mui/icons-material/QueueMusic';
import CloseIcon from '@mui/icons-material/Close';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import MusicNoteIcon from '@mui/icons-material/MusicNote';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { icon } from '@fortawesome/fontawesome-svg-core';

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
import Drawer from '@mui/material/Drawer';
import useScrollTrigger from '@mui/material/useScrollTrigger';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import CssBaseline from '@mui/material/CssBaseline';
import Fade from '@mui/material/Fade';
import Fab from '@mui/material/Fab';
import Link from '@mui/material/Link';
import Divider from '@mui/material/Divider';
import LocalBarIcon from '@mui/icons-material/LocalBar';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListItemButton from '@mui/material/ListItemButton';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';

import "json.date-extensions";
import * as spotify from "./spotify.js";
import * as database from "./database.js";
import * as getsongbpm from "./getsongbpm.js";

// Isolated BPM Fetch Indicator component - manages its own state to avoid re-rendering parent
const BpmFetchIndicator = React.memo(({ statusRef, onPause, onResume }) => {
  const [status, setStatus] = useState({ isActive: false, isPaused: false, current: 0, total: 0, currentTrack: '' });
  
  useEffect(() => {
    // Poll the ref for status updates instead of receiving state from parent
    const interval = setInterval(() => {
      if (statusRef.current) {
        setStatus({ ...statusRef.current });
      }
    }, 500); // Update UI every 500ms
    
    return () => clearInterval(interval);
  }, [statusRef]);
  
  const hasPending = status.pending > 0;
  
  if (!status.isActive && !hasPending) {
    return null;
  }
  
  return (
    <Box sx={{ 
      display: 'flex', 
      alignItems: 'center', 
      gap: 1,
      backgroundColor: 'rgba(77, 208, 225, 0.1)',
      borderRadius: '20px',
      px: 2,
      py: 0.5,
      border: '1px solid rgba(77, 208, 225, 0.3)'
    }}>
      {status.isActive && !status.isPaused && (
        <CircularProgress size={16} sx={{ color: '#4dd0e1' }} />
      )}
      {status.isPaused && (
        <MusicNoteIcon sx={{ fontSize: 16, color: '#ffc107' }} />
      )}
      {!status.isActive && hasPending && (
        <MusicNoteIcon sx={{ fontSize: 16, color: 'rgba(255,255,255,0.5)' }} />
      )}
      <Typography variant="caption" sx={{ color: '#4dd0e1', whiteSpace: 'nowrap' }}>
        {status.isActive 
          ? `BPM: ${status.current}/${status.total}`
          : `${status.pending} pending`
        }
      </Typography>
      {status.isActive && (
        <Tooltip title={status.isPaused ? "Resume" : "Pause"}>
          <IconButton
            size="small"
            onClick={onPause}
            sx={{ 
              p: 0.5,
              color: status.isPaused ? '#1DB954' : '#ffc107',
              '&:hover': { backgroundColor: 'rgba(255,255,255,0.1)' }
            }}
          >
            {status.isPaused ? <PlayArrowIcon sx={{ fontSize: 18 }} /> : <PauseIcon sx={{ fontSize: 18 }} />}
          </IconButton>
        </Tooltip>
      )}
      {!status.isActive && hasPending && (
        <Tooltip title="Resume fetching BPM data">
          <IconButton
            size="small"
            onClick={onResume}
            sx={{ 
              p: 0.5,
              color: '#1DB954',
              '&:hover': { backgroundColor: 'rgba(255,255,255,0.1)' }
            }}
          >
            <PlayArrowIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
});

function App() {
  // #region React hooks
  const [trackLibrary, setTrackLibrary] = useState([]);
  const [libraryPlaylists, setLibraryPlaylists] = useState([]);
  const [classPlaylists, setClassPlaylists] = useState([]);
  const [isSpotifyAuthorized, setIsSpotifyAuthorized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [playlistToPlan, setPlaylistToPlan] = useState(null);
  const [playlistDrawerOpen, setPlaylistDrawerOpen] = useState(false);
  const [playlistTracks, setPlaylistTracks] = useState([]);
  const [playlistTracksLoading, setPlaylistTracksLoading] = useState(false);
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
  const isFetchingBpmRef = useRef(false);
  const bpmFetchPausedRef = useRef(false);
  const bpmStatusRef = useRef({ isActive: false, isPaused: false, current: 0, total: 0, currentTrack: '', pending: 0 });
  const pendingTracksRef = useRef([]);
  // const scrollTrigger = useScrollTrigger({
  //   disableHysteresis: true,
  //   threshold: 0,
  //   target: window ? window() : undefined,
  // });

  useEffect(() => {
    // Hide the static HTML footer when React app loads
    const staticFooter = document.getElementById('static-footer');
    if (staticFooter) {
      staticFooter.style.display = 'none';
    }
    
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

  // #endregion

  // #region util functions

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

  // #endregion

  // #region data load functions
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

      playlistHeaders.push(..._playlistsResult.items.filter((playlist) => playlist != null)); //Filter out nulls since Spotify likes to send those
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

  const getTracksAudioFeatures = async (tracks) => {
    const audioFeaturesMap = new Map();
    const tracksNeedingRetrieval = [];
    
    // Check cache first
    for (const track of tracks) {
      const trackAudioFeatures = await database.getTrackAudioFeatures(track.id);
      if (!trackAudioFeatures) {
        // No record at all - needs retrieval
        tracksNeedingRetrieval.push(track);
      } else if (trackAudioFeatures.source === 'getsongbpm-notfound') {
        // Already checked but not found - don't add to map (no BPM to show)
        // and don't re-fetch
      } else {
        // Has valid audio features
        audioFeaturesMap.set(trackAudioFeatures.id, trackAudioFeatures);
      }
    }
    
    if (tracksNeedingRetrieval.length > 0) {
      // Spotify audio features API is deprecated/restricted, so skip it
      // Go directly to GetSongBPM for tracks that need audio features
      const tracksStillNeeding = tracksNeedingRetrieval;
      
      // Fetch GetSongBPM data in background (don't block UI)
      if (tracksStillNeeding.length > 0 && !isFetchingBpmRef.current) {
        console.log(`Will fetch GetSongBPM data for ${tracksStillNeeding.length} tracks in background`);
        // Don't await - let it run in background
        fetchBpmDataInBackground(tracksStillNeeding);
      }
    }
    
    return audioFeaturesMap;
  }
  
  const fetchBpmDataInBackground = async (tracks) => {
    if (isFetchingBpmRef.current) {
      console.log('BPM fetch already in progress, skipping');
      return;
    }
    
    isFetchingBpmRef.current = true;
    bpmFetchPausedRef.current = false;
    pendingTracksRef.current = [...tracks];
    bpmStatusRef.current = { isActive: true, isPaused: false, current: 0, total: tracks.length, currentTrack: '', pending: tracks.length };
    console.log(`Starting background BPM fetch for ${tracks.length} tracks`);
    let fetched = 0;
    let processed = 0;
    
    for (const track of tracks) {
      // Check if paused
      while (bpmFetchPausedRef.current) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!isFetchingBpmRef.current) {
          // Fetch was cancelled
          bpmStatusRef.current = { isActive: false, isPaused: false, current: 0, total: 0, currentTrack: '', pending: 0 };
          return;
        }
      }
      
      processed++;
      
      // Update ref directly - the BpmFetchIndicator component polls this
      bpmStatusRef.current = { 
        ...bpmStatusRef.current, 
        current: processed, 
        currentTrack: track.name,
        pending: pendingTracksRef.current.length 
      };
      
      try {
        const artistName = track.artists && track.artists[0] ? track.artists[0].name : '';
        const features = await getsongbpm.searchSong(track.name, artistName);
        
        if (features) {
          const audioFeatures = {
            id: track.id,
            tempo: features.tempo,
            energy: features.energy,
            danceability: features.danceability,
            key: features.key,
            source: 'getsongbpm'
          };
          await database.putTrackAudioFeatures(audioFeatures);
          fetched++;
          
          // Log progress every 10 tracks
          if (fetched % 10 === 0) {
            console.log(`BPM fetch progress: ${fetched} tracks fetched`);
          }
        } else {
          // Save a record indicating we checked but found nothing
          // This prevents re-checking on page refresh
          const notFoundRecord = {
            id: track.id,
            tempo: null,
            source: 'getsongbpm-notfound',
            checkedAt: new Date().toISOString()
          };
          await database.putTrackAudioFeatures(notFoundRecord);
        }
        
        // Update pending tracks
        pendingTracksRef.current = pendingTracksRef.current.filter(t => t.id !== track.id);
        bpmStatusRef.current.pending = pendingTracksRef.current.length;
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 250));
      } catch (e) {
        console.warn(`Failed to get BPM for ${track.name}:`, e);
      }
    }
    
    isFetchingBpmRef.current = false;
    bpmStatusRef.current = { isActive: false, isPaused: false, current: 0, total: 0, currentTrack: '', pending: pendingTracksRef.current.length };
    console.log(`Background BPM fetch complete: ${fetched}/${tracks.length} tracks`);
  }
  
  const toggleBpmFetchPause = () => {
    if (isFetchingBpmRef.current) {
      bpmFetchPausedRef.current = !bpmFetchPausedRef.current;
      bpmStatusRef.current = { ...bpmStatusRef.current, isPaused: bpmFetchPausedRef.current };
    }
  };
  
  const resumeBpmFetch = () => {
    if (pendingTracksRef.current.length > 0 && !isFetchingBpmRef.current) {
      fetchBpmDataInBackground(pendingTracksRef.current);
    }
  };

  const retrieveTracksAudioFeatures = async (trackIds) => {
    console.debug(`Retrieving audio features for ${trackIds.length} tracks`);
    const batchSize = 100;
    const spotifyApi = await spotify.getSpotifyApi();
    const tracks = [];
    for (let i = 0; i < trackIds.length; i += batchSize) {
      const batch = trackIds.slice(i, i + batchSize);
      try {
        const getResult = await spotifyApi.getAudioFeaturesForTracks(batch);
        if (getResult.audio_features && getResult.audio_features.length > 0) {
          tracks.push(...getResult.audio_features);
        } else {
          console.error(`Error retrieving tracks for batch starting at ${i}`);
          console.error(getResult);
        }
      } catch (e) {
        console.warn("Error retrieving audio features from Spotify (this is expected for dev mode apps)");
        // Don't log full error to avoid spam - Spotify API is restricted
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
    const tracksAudioDetails = await getTracksAudioFeatures(trackList);
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
    if (!playlistToPlan) {
      console.warn("No playlist selected");
      return;
    }
    
    console.debug(`ADDING TRACK ${trackId} TO PLAYLIST ${playlistToPlan.name}`);

    const track = trackLibrary.find((track) => track.id === trackId);
    const duration_string = "0:" + millisToMinutesAndSeconds(track.duration_ms);
    navigator.clipboard.writeText(`${track.name}\t${duration_string}`);

    const spotifyApi = await spotify.getSpotifyApi();
    await spotifyApi.addTracksToPlaylist(playlistToPlan.id, [`spotify:track:${trackId}`]);
    
    // Refresh and show the playlist drawer
    await refreshPlaylistTracks();
    setPlaylistDrawerOpen(true);
  }, [playlistToPlan, trackLibrary]);

  const refreshPlaylistTracks = async () => {
    if (!playlistToPlan) {
      setPlaylistTracks([]);
      return;
    }
    
    setPlaylistTracksLoading(true);
    try {
      const spotifyApi = await spotify.getSpotifyApi();
      const playlistData = await spotifyApi.getPlaylist(playlistToPlan.id);
      
      if (playlistData.tracks && playlistData.tracks.items) {
        const tracks = playlistData.tracks.items
          .filter(item => item.track)
          .map(item => ({
            id: item.track.id,
            name: item.track.name,
            artists: item.track.artists?.map(a => a.name).join(', ') || '',
            duration_ms: item.track.duration_ms,
            album: item.track.album?.name || ''
          }));
        setPlaylistTracks(tracks);
      }
    } catch (error) {
      console.error('Failed to refresh playlist tracks:', error);
    }
    setPlaylistTracksLoading(false);
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
        Cell: ({ cell, column, table }) => {
          const filterValue = column.getFilterValue();
          const cellValue = cell.getValue();
          
          if (filterValue && cellValue) {
            const regex = new RegExp(`(${filterValue})`, 'gi');
            const parts = cellValue.split(regex);
            return (
              <Box sx={{ fontWeight: 500 }}>
                {parts.map((part, index) =>
                  regex.test(part) ? (
                    <mark key={index}>{part}</mark>
                  ) : (
                    part
                  )
                )}
              </Box>
            );
          }
          
          return (
            <Box sx={{ fontWeight: 500 }}>
              {cellValue}
            </Box>
          );
        }
      },
      {
        accessorFn: (row) => row.artists.map((artist) => artist.name).join(", "),
        accessorKey: "artists",
        header: "Artist(s)",
        size: 100,
        maxSize: 100,
        Cell: ({ cell, column }) => {
          const filterValue = column.getFilterValue();
          const cellValue = cell.getValue();
          
          if (filterValue && cellValue) {
            const regex = new RegExp(`(${filterValue})`, 'gi');
            const parts = cellValue.split(regex);
            return (
              <Box sx={{ color: 'rgba(255,255,255,0.7)' }}>
                {parts.map((part, index) =>
                  regex.test(part) ? (
                    <mark key={index}>{part}</mark>
                  ) : (
                    part
                  )
                )}
              </Box>
            );
          }
          
          return (
            <Box sx={{ color: 'rgba(255,255,255,0.7)' }}>
              {cellValue}
            </Box>
          );
        }
      },
      {
        accessorFn: (row) => millisToMinutesAndSeconds(row.duration_ms),
        header: "Duration",
        size: 80,
        filterFn: (row, id, filterValue) => {
          if (!filterValue) return true;
          
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
        Filter: ({ column }) => (
          <TextField
            value={column.getFilterValue() || ''}
            onChange={(e) => {
              let value = e.target.value;
              // Auto-format: add colon after 2 digits
              if (value.length === 2 && !value.includes(':')) {
                value = value + ':';
              }
              column.setFilterValue(value || undefined);
            }}
            placeholder="m:ss"
            variant="outlined"
            size="small"
            inputProps={{
              maxLength: 5
            }}
            sx={{
              minWidth: '80px',
              '& .MuiInputBase-input': {
                fontFamily: 'monospace'
              }
            }}
          />
        ),
        Cell: ({ cell, column }) => {
          const filterValue = column.getFilterValue();
          const cellValue = cell.getValue();
          
          // Check if the filter matches the cell value exactly (for highlighting)
          if (filterValue && cellValue === filterValue) {
            return (
              <Box sx={{ fontFamily: 'monospace', color: 'rgba(255,255,255,0.8)' }}>
                <mark>{cellValue}</mark>
              </Box>
            );
          }
          
          return (
            <Box sx={{ fontFamily: 'monospace', color: 'rgba(255,255,255,0.8)' }}>
              {cellValue}
            </Box>
          );
        }
      },
      {
        accessorKey: "audio_features.tempo",
        header: "Tempo",
        size: 60,
        filterFn: (row, id, filterValue) => {
          const tempo = row.getValue(id);
          if (!tempo || !filterValue) return true;
          const targetTempo = parseFloat(filterValue);
          if (isNaN(targetTempo)) return true;
          // Show entries within 15 BPM of the filter value
          return Math.abs(tempo - targetTempo) <= 15;
        },
        Cell: ({ cell }) => (
          <Box sx={{ fontWeight: 600, color: '#1DB954' }}>
            {cell.getValue() ? Math.round(cell.getValue()) : '-'}
          </Box>
        )
      },
      // Energy column hidden - Spotify audio features API deprecated
      // {
      //   accessorKey: "audio_features.energy",
      //   header: "Energy",
      //   size: 60,
      //   Cell: ({ cell }) => (
      //     <Box sx={{ 
      //       fontWeight: 600,
      //       color: cell.getValue() > 0.7 ? '#ff4444' : cell.getValue() > 0.4 ? '#ffaa00' : '#1DB954'
      //     }}>
      //       {cell.getValue() ? (cell.getValue() * 100).toFixed(0) + '%' : '-'}
      //     </Box>
      //   )
      // },
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
        size: 80
      },
      {
        accessorKey: "recencyScore",
        header: "Recency",
        size: 60,
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
        filterFn: (row, id, filterValue) => {
          // If no filter is applied, show all rows
          if (!filterValue || filterValue.length === 0) {
            return true;
          }
          
          // Get the track's lists as a comma-separated string
          const trackLists = row.getValue(id);
          if (!trackLists) {
            return false;
          }
          
          // Split into an array and trim whitespace
          const trackListsArray = trackLists.split(',').map(list => list.trim());
          
          // Check if ALL filter values exist in the track's lists (order-agnostic)
          return filterValue.every(filterList => trackListsArray.includes(filterList));
        },
        filterSelectOptions: Array.from(
          libraryPlaylists?.map((libraryPlaylist) => libraryPlaylist.name)
        ),
        muiFilterTextFieldProps: {
          placeholder: ''
        },
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
        key={playlistToPlan?.id || 'no-playlist'}
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
        muiTableHeadCellProps={{
          sx: {
            '& .MuiTableSortLabel-icon': {
              color: 'rgba(255, 255, 255, 0.7) !important',
            },
            '& .MuiTableSortLabel-root.Mui-active .MuiTableSortLabel-icon': {
              color: '#1DB954 !important',
            },
          }
        }}
        renderTopToolbarCustomActions={({ table }) => (
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <Autocomplete
              id="planning-playlist-selector"
              sx={{ 
                width: 300,
                '& .MuiInputBase-root': {
                  borderRadius: '24px',
                  height: '36px',
                },
                '& .MuiInputLabel-root': {
                  top: '-6px',
                },
                '& .MuiInputLabel-shrink': {
                  top: '0px',
                }
              }}
              size="small"
              options={classPlaylists}
              value={playlistToPlan}
              autoHighlight
              onChange={(_event, newValue) => {
                setPlaylistToPlan(newValue);
                console.log("playlistToPlan", newValue);
              }}
              getOptionLabel={(option) => option?.name || ''}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="🎵 Playlist to plan"
                  variant="outlined"
                  inputProps={{
                    ...params.inputProps,
                    autoComplete: 'new-password',
                  }}
                />
              )}
            />
            <Tooltip title="Create new playlist">
              <IconButton 
                aria-label="new playlist" 
                onClick={addPlaylist}
                size="small"
                sx={{
                  backgroundColor: 'rgba(29, 185, 84, 0.1)',
                  '&:hover': {
                    backgroundColor: 'rgba(29, 185, 84, 0.2)',
                  }
                }}
              >
                <AddCircleOutlineIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="View playlist tracks">
              <IconButton 
                aria-label="view playlist" 
                onClick={() => {
                  refreshPlaylistTracks();
                  setPlaylistDrawerOpen(true);
                }}
                size="small"
                disabled={!playlistToPlan}
                sx={{
                  backgroundColor: playlistToPlan ? 'rgba(29, 185, 84, 0.1)' : 'transparent',
                  '&:hover': {
                    backgroundColor: 'rgba(29, 185, 84, 0.2)',
                  }
                }}
              >
                <QueueMusicIcon />
              </IconButton>
            </Tooltip>
            <Button
              onClick={() => table.resetColumnFilters()}
              startIcon={<FilterListOffIcon />}
              variant="outlined"
              size="small"
              sx={{
                borderColor: 'rgba(29, 185, 84, 0.5)',
                color: '#1DB954',
                '&:hover': {
                  borderColor: '#1DB954',
                  backgroundColor: 'rgba(29, 185, 84, 0.1)',
                }
              }}
            >
              Clear Filters
            </Button>
            
            {/* BPM Fetch Status Indicator - isolated component to prevent re-renders */}
            <BpmFetchIndicator 
              statusRef={bpmStatusRef}
              onPause={toggleBpmFetchPause}
              onResume={resumeBpmFetch}
            />
          </Box>
        )}
        muiTableHeadCellFilterTextFieldProps={{
          placeholder: '',
          variant: 'outlined',
          size: 'small',
          sx: {
            '& .MuiInputBase-input::placeholder': {
              opacity: 0
            }
          }
        }}
        muiFilterTextFieldProps={{
          SelectProps: {
            MenuProps: {
              BackdropProps: {
                sx: {
                  backgroundColor: 'rgba(0, 0, 0, 0.3)'
                }
              },
              PaperProps: {
                sx: {
                  backgroundColor: '#404040',
                  color: '#ffffff'
                }
              }
            },
            renderValue: (selected) => {
              if (!selected || (Array.isArray(selected) && selected.length === 0)) {
                return '';
              }
              if (Array.isArray(selected)) {
                return (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, color: '#ffffff' }}>
                    {selected.join(', ')}
                  </Box>
                );
              }
              return <Box sx={{ color: '#ffffff' }}>{selected}</Box>;
            }
          }
        }}
        muiTableBodyCellProps={{
          sx: {
            '& mark': {
              backgroundColor: 'rgba(29, 185, 84, 0.4)',
              color: '#ffffff',
              padding: '2px 0',
              fontWeight: 600
            }
          }
        }}
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
    const [statsDialogOpen, setStatsDialogOpen] = useState(false);
    const [storageStats, setStorageStats] = useState(null);
    const [statsLoading, setStatsLoading] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [clearingData, setClearingData] = useState(false);
    const [analyzingBpm, setAnalyzingBpm] = useState(false);
    const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 });
    const [analysisError, setAnalysisError] = useState(null);
    
    function toggleDrawer(state) {
      console.debug(`toggledrawer ${state}`);
      setDrawerState(state);
    }
    
    const loadStorageStats = async () => {
      setStatsLoading(true);
      try {
        const stats = await database.getStorageStats();
        setStorageStats(stats);
      } catch (error) {
        console.error('Failed to load storage stats:', error);
      }
      setStatsLoading(false);
    };
    
    const handleOpenStats = async () => {
      setStatsDialogOpen(true);
      await loadStorageStats();
    };
    
    const handleClearData = async () => {
      setClearingData(true);
      try {
        await database.clearAllData();
        await loadStorageStats();
        setClearConfirmOpen(false);
      } catch (error) {
        console.error('Failed to clear data:', error);
      }
      setClearingData(false);
    };
    
    const handleAnalyzeMissingBpm = async () => {
      if (isFetchingBpmRef.current || analyzingBpm) {
        console.log('BPM analysis already in progress');
        return;
      }
      
      // Reset API key status in case user updated the key
      getsongbpm.resetApiKeyStatus();
      setAnalysisError(null);
      setAnalyzingBpm(true);
      
      try {
        const tracksToAnalyze = await database.getTracksNeedingBpmAnalysis();
        setAnalysisProgress({ current: 0, total: tracksToAnalyze.length });
        
        if (tracksToAnalyze.length === 0) {
          console.log('All tracks already have BPM data');
          setAnalyzingBpm(false);
          return;
        }
        
        console.log(`Starting BPM analysis for ${tracksToAnalyze.length} tracks`);
        isFetchingBpmRef.current = true;
        let fetched = 0;
        
        for (const track of tracksToAnalyze) {
          // Check if API key became invalid
          const apiStatus = getsongbpm.getApiKeyStatus();
          if (!apiStatus.valid) {
            setAnalysisError(apiStatus.error);
            break;
          }
          
          try {
            const artistName = track.artists && track.artists[0] ? track.artists[0] : '';
            const features = await getsongbpm.searchSong(track.name, artistName);
            
            // Check again after request in case it failed
            const postStatus = getsongbpm.getApiKeyStatus();
            if (!postStatus.valid) {
              setAnalysisError(postStatus.error);
              break;
            }
            
            if (features) {
              const audioFeatures = {
                id: track.id,
                tempo: features.tempo,
                energy: features.energy,
                danceability: features.danceability,
                key: features.key,
                source: 'getsongbpm'
              };
              await database.putTrackAudioFeatures(audioFeatures);
              fetched++;
            }
            
            setAnalysisProgress(prev => ({ ...prev, current: prev.current + 1 }));
            
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 250));
          } catch (e) {
            console.warn(`Failed to get BPM for ${track.name}:`, e);
            setAnalysisProgress(prev => ({ ...prev, current: prev.current + 1 }));
          }
        }
        
        console.log(`BPM analysis complete: ${fetched}/${tracksToAnalyze.length} tracks found`);
        isFetchingBpmRef.current = false;
        
        // Refresh stats after analysis
        await loadStorageStats();
      } catch (error) {
        console.error('BPM analysis failed:', error);
        setAnalysisError('BPM analysis failed: ' + error.message);
      }
      
      setAnalyzingBpm(false);
    };
    
    const formatBytes = (bytes) => {
      if (!bytes) return 'Unknown';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };

    return (
      <Fragment>
        {/* Storage Stats Dialog */}
        <Dialog 
          open={statsDialogOpen} 
          onClose={() => setStatsDialogOpen(false)}
          maxWidth="sm"
          fullWidth
          PaperProps={{
            sx: {
              backgroundColor: '#1e1e1e',
              backgroundImage: 'none',
            }
          }}
        >
          <DialogTitle sx={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: 1,
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            color: '#fff',
            '& .MuiTypography-root': { color: '#fff' }
          }}>
            <StorageIcon sx={{ color: '#1DB954' }} />
            <Typography component="span" sx={{ color: '#fff', fontWeight: 500, fontSize: '1.25rem' }}>
              Storage Statistics
            </Typography>
          </DialogTitle>
          <DialogContent sx={{ pt: 3 }}>
            {statsLoading ? (
              <Box sx={{ textAlign: 'center', py: 4 }}>
                <CircularProgress size={40} sx={{ color: '#1DB954' }} />
                <Typography sx={{ mt: 2, color: 'rgba(255,255,255,0.7)' }}>
                  Loading statistics...
                </Typography>
              </Box>
            ) : storageStats ? (
              <Stack spacing={3}>
                {/* Storage Size */}
                <Box>
                  <Typography variant="subtitle2" sx={{ color: 'rgba(255,255,255,0.7)', mb: 1 }}>
                    Storage Usage
                  </Typography>
                  <Typography variant="h6" sx={{ color: '#1DB954' }}>
                    {formatBytes(storageStats.storageSize.estimated)}
                  </Typography>
                  {storageStats.storageSize.quota && (
                    <LinearProgress 
                      variant="determinate" 
                      value={(storageStats.storageSize.estimated / storageStats.storageSize.quota) * 100}
                      sx={{ 
                        mt: 1, 
                        backgroundColor: 'rgba(255,255,255,0.1)',
                        '& .MuiLinearProgress-bar': { backgroundColor: '#1DB954' }
                      }}
                    />
                  )}
                </Box>
                
                <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)' }} />
                
                {/* Playlists */}
                <Box>
                  <Typography variant="subtitle2" sx={{ color: 'rgba(255,255,255,0.7)', mb: 1 }}>
                    📋 Playlists Cached
                  </Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
                    <Box>
                      <Typography variant="h4" sx={{ fontWeight: 700, color: '#fff' }}>
                        {storageStats.playlists.count}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                        Total Playlists
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="h4" sx={{ fontWeight: 700, color: '#fff' }}>
                        {storageStats.playlists.totalTracks}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                        Total Track Entries
                      </Typography>
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 2, mt: 1 }}>
                    <Chip 
                      size="small" 
                      label={`${storageStats.playlists.libraryPlaylists} Library`}
                      sx={{ backgroundColor: 'rgba(29, 185, 84, 0.2)', color: '#1DB954' }}
                    />
                    <Chip 
                      size="small" 
                      label={`${storageStats.playlists.classPlaylists} Class`}
                      sx={{ backgroundColor: 'rgba(255, 170, 0, 0.2)', color: '#ffaa00' }}
                    />
                  </Box>
                </Box>
                
                <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)' }} />
                
                {/* Audio Features */}
                <Box>
                  <Typography variant="subtitle2" sx={{ color: 'rgba(255,255,255,0.7)', mb: 1 }}>
                    🎵 Song Metadata Cached
                  </Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, mb: 2 }}>
                    <Box>
                      <Typography variant="h4" sx={{ fontWeight: 700, color: '#fff' }}>
                        {storageStats.audioFeatures.count}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                        Tracks with Audio Data
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="h4" sx={{ fontWeight: 700, color: '#1DB954' }}>
                        {storageStats.audioFeatures.withTempo}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                        With BPM Data
                      </Typography>
                    </Box>
                  </Box>
                  
                  {/* Data Sources */}
                  <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)', display: 'block', mb: 1 }}>
                    Data Sources:
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
                    <Chip 
                      size="small" 
                      label={`${storageStats.audioFeatures.spotifySource} from Spotify`}
                      sx={{ backgroundColor: 'rgba(29, 185, 84, 0.2)', color: '#1DB954' }}
                    />
                    <Chip 
                      size="small" 
                      label={`${storageStats.audioFeatures.getsongbpmSource} from GetSongBPM`}
                      sx={{ backgroundColor: 'rgba(77, 208, 225, 0.2)', color: '#4dd0e1' }}
                    />
                  </Box>
                  
                  {/* Tempo Stats */}
                  {storageStats.audioFeatures.withTempo > 0 && (
                    <Box sx={{ mt: 2 }}>
                      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)', display: 'block', mb: 1 }}>
                        Tempo Distribution:
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
                        <Chip 
                          size="small" 
                          label={`${storageStats.audioFeatures.tempoDistribution.slow} Slow (<100)`}
                          sx={{ backgroundColor: 'rgba(76, 175, 80, 0.2)', color: '#4caf50' }}
                        />
                        <Chip 
                          size="small" 
                          label={`${storageStats.audioFeatures.tempoDistribution.medium} Medium (100-130)`}
                          sx={{ backgroundColor: 'rgba(255, 193, 7, 0.2)', color: '#ffc107' }}
                        />
                        <Chip 
                          size="small" 
                          label={`${storageStats.audioFeatures.tempoDistribution.fast} Fast (130-160)`}
                          sx={{ backgroundColor: 'rgba(255, 152, 0, 0.2)', color: '#ff9800' }}
                        />
                        <Chip 
                          size="small" 
                          label={`${storageStats.audioFeatures.tempoDistribution.veryFast} Very Fast (>160)`}
                          sx={{ backgroundColor: 'rgba(244, 67, 54, 0.2)', color: '#f44336' }}
                        />
                      </Box>
                    </Box>
                  )}
                </Box>
                
                <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)' }} />
                
                {/* Artists */}
                <Box>
                  <Typography variant="subtitle2" sx={{ color: 'rgba(255,255,255,0.7)', mb: 1 }}>
                    🎤 Artists Cached
                  </Typography>
                  <Typography variant="h4" sx={{ fontWeight: 700, color: '#fff' }}>
                    {storageStats.artists.count}
                  </Typography>
                </Box>
                
                {/* Analysis Progress */}
                {(analyzingBpm || analysisError || analysisProgress.current > 0) && (
                  <Box sx={{ mt: 2 }}>
                    <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)', mb: 2 }} />
                    
                    {analysisError ? (
                      <Alert 
                        severity="error" 
                        sx={{ 
                          backgroundColor: 'rgba(244, 67, 54, 0.1)',
                          color: '#f44336',
                          '& .MuiAlert-icon': { color: '#f44336' }
                        }}
                        onClose={() => setAnalysisError(null)}
                      >
                        {analysisError}
                      </Alert>
                    ) : (
                      <>
                        <Typography variant="subtitle2" sx={{ color: '#1DB954', mb: 1 }}>
                          {analyzingBpm ? '🔍 Analyzing BPM Data...' : '✅ Analysis Complete'}
                        </Typography>
                        <LinearProgress 
                          variant="determinate" 
                          value={analysisProgress.total > 0 ? (analysisProgress.current / analysisProgress.total) * 100 : 0}
                          sx={{ 
                            height: 8, 
                            borderRadius: 4,
                            backgroundColor: 'rgba(255,255,255,0.1)',
                            '& .MuiLinearProgress-bar': {
                              backgroundColor: '#1DB954'
                            }
                          }}
                        />
                        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)', display: 'block', mt: 1 }}>
                          {analysisProgress.current} / {analysisProgress.total} tracks processed
                        </Typography>
                      </>
                    )}
                  </Box>
                )}
              </Stack>
            ) : (
              <Alert severity="error">Failed to load statistics</Alert>
            )}
          </DialogContent>
          <DialogActions sx={{ borderTop: '1px solid rgba(255,255,255,0.1)', px: 3, py: 2, justifyContent: 'space-between' }}>
            <Button 
              onClick={() => setClearConfirmOpen(true)}
              color="error"
              startIcon={<DeleteOutlineIcon />}
              disabled={statsLoading || analyzingBpm}
            >
              Clear All Data
            </Button>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button 
                onClick={handleAnalyzeMissingBpm}
                startIcon={analyzingBpm ? <CircularProgress size={16} sx={{ color: '#fff' }} /> : <SearchIcon />}
                disabled={statsLoading || analyzingBpm || !storageStats}
                sx={{ 
                  color: '#4dd0e1',
                  '&:hover': { backgroundColor: 'rgba(77, 208, 225, 0.1)' }
                }}
              >
                {analyzingBpm ? 'Analyzing...' : 'Analyze Missing BPM'}
              </Button>
              <Button onClick={() => setStatsDialogOpen(false)} sx={{ color: '#1DB954' }}>
                Close
              </Button>
            </Box>
          </DialogActions>
        </Dialog>
        
        {/* Clear Data Confirmation Dialog */}
        <Dialog
          open={clearConfirmOpen}
          onClose={() => setClearConfirmOpen(false)}
          PaperProps={{
            sx: {
              backgroundColor: '#1e1e1e',
              backgroundImage: 'none',
            }
          }}
        >
          <DialogTitle>Clear All Cached Data?</DialogTitle>
          <DialogContent>
            <Typography sx={{ color: 'rgba(255,255,255,0.7)' }}>
              This will delete all locally cached playlists, audio features, and artist data. 
              You will need to refresh data from Spotify after clearing.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setClearConfirmOpen(false)} disabled={clearingData}>
              Cancel
            </Button>
            <Button 
              onClick={handleClearData} 
              color="error" 
              variant="contained"
              disabled={clearingData}
            >
              {clearingData ? 'Clearing...' : 'Clear All Data'}
            </Button>
          </DialogActions>
        </Dialog>
        
        <Drawer anchor={"left"} open={drawerState} onClose={() => toggleDrawer(false)}>
          <Box sx={{ width: 300, p: 3, height: '100%', display: 'flex', flexDirection: 'column' }}>
            <Typography variant="h5" sx={{ mb: 3, fontWeight: 700, color: '#1DB954' }}>
              🎵 Menu
            </Typography>
            
            <Box sx={{ flexGrow: 1 }}>
              <List>
                <ListItem disablePadding>
                  <ListItemButton onClick={handleOpenStats}>
                    <ListItemIcon>
                      <BarChartIcon sx={{ color: '#1DB954' }} />
                    </ListItemIcon>
                    <ListItemText 
                      primary="Storage Stats" 
                      secondary="View cached data & BPM statistics"
                      secondaryTypographyProps={{ sx: { color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem' }}}
                    />
                  </ListItemButton>
                </ListItem>
              </List>
            </Box>
            
            <Divider sx={{ my: 2, borderColor: 'rgba(255,255,255,0.1)' }} />
            
            {/* Credits Section */}
            <Box sx={{ mt: 'auto' }}>
              <Typography variant="overline" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block', mb: 2 }}>
                Powered By
              </Typography>
              
              {/* Spotify Credit */}
              <Link 
                href="https://www.spotify.com" 
                target="_blank" 
                rel="noopener noreferrer"
                sx={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  mb: 2,
                  textDecoration: 'none',
                  '&:hover': { opacity: 0.8 }
                }}
              >
                <Box 
                  component="img" 
                  src="https://storage.googleapis.com/pr-newsroom-wp/1/2023/05/Spotify_Full_Logo_RGB_Green.png" 
                  alt="Spotify" 
                  sx={{ height: 24, mr: 1 }} 
                />
              </Link>
              
              {/* GetSongBPM Credit */}
              <Link 
                href="https://getsongbpm.com" 
                target="_blank"
                sx={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  mb: 2,
                  textDecoration: 'none',
                  '&:hover': { opacity: 0.8 }
                }}
              >
                <Box 
                  component="img" 
                  src="/spotify-playlist-planner/logo_bpm.png" 
                  alt="GetSongBPM" 
                  sx={{ height: 28 }} 
                />
              </Link>
              
              <Divider sx={{ my: 2, borderColor: 'rgba(255,255,255,0.1)' }} />
              
              {/* Developer Credit */}
              <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.7)', mb: 1 }}>
                Made with ❤️ by Adam Karl
              </Typography>
              <Link 
                href="https://venmo.com/Adam-Karl-3?txn=pay&amount=5&note=Thanks%20for%20Playlist%20Planner!" 
                target="_blank" 
                rel="noopener noreferrer"
                sx={{ textDecoration: 'none' }}
              >
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<LocalBarIcon />}
                  sx={{
                    borderColor: '#008CFF',
                    color: '#008CFF',
                    '&:hover': {
                      borderColor: '#008CFF',
                      backgroundColor: 'rgba(0, 140, 255, 0.1)',
                    }
                  }}
                >
                  Buy me a beer 🍺
                </Button>
              </Link>
            </Box>
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

  const PlaylistDrawer = () => {
    const totalDuration = playlistTracks.reduce((sum, track) => sum + (track.duration_ms || 0), 0);
    
    return (
      <Drawer
        anchor="right"
        open={playlistDrawerOpen}
        onClose={() => setPlaylistDrawerOpen(false)}
        PaperProps={{
          sx: {
            width: 400,
            backgroundColor: '#1e1e1e',
            backgroundImage: 'none',
          }
        }}
      >
        <Box sx={{ p: 2, borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="h6" sx={{ color: '#fff', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1 }}>
              <QueueMusicIcon sx={{ color: '#1DB954' }} />
              {playlistToPlan?.name || 'No Playlist Selected'}
            </Typography>
            <IconButton onClick={() => setPlaylistDrawerOpen(false)} size="small" sx={{ color: 'rgba(255,255,255,0.7)' }}>
              <CloseIcon />
            </IconButton>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.7)' }}>
              {playlistTracks.length} tracks • {millisToMinutesAndSeconds(totalDuration)}
            </Typography>
            <Tooltip title="Refresh playlist">
              <IconButton 
                onClick={refreshPlaylistTracks} 
                size="small" 
                disabled={playlistTracksLoading}
                sx={{ color: '#1DB954' }}
              >
                {playlistTracksLoading ? <CircularProgress size={16} sx={{ color: '#1DB954' }} /> : <RefreshIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
        
        <Box sx={{ flex: 1, overflow: 'auto', p: 1 }}>
          {playlistTracksLoading && playlistTracks.length === 0 ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress sx={{ color: '#1DB954' }} />
            </Box>
          ) : playlistTracks.length === 0 ? (
            <Box sx={{ p: 4, textAlign: 'center' }}>
              <Typography sx={{ color: 'rgba(255,255,255,0.5)' }}>
                No tracks in this playlist yet
              </Typography>
            </Box>
          ) : (
            <List dense>
              {playlistTracks.map((track, index) => (
                <ListItem 
                  key={track.id + '-' + index}
                  sx={{ 
                    borderRadius: 1,
                    mb: 0.5,
                    '&:hover': { backgroundColor: 'rgba(29, 185, 84, 0.1)' }
                  }}
                >
                  <ListItemText
                    primary={
                      <Typography variant="body2" sx={{ color: '#fff', fontWeight: 500 }} noWrap>
                        {index + 1}. {track.name}
                      </Typography>
                    }
                    secondary={
                      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)' }} noWrap>
                        {track.artists} • {millisToMinutesAndSeconds(track.duration_ms)}
                      </Typography>
                    }
                  />
                </ListItem>
              ))}
            </List>
          )}
        </Box>
      </Drawer>
    );
  };

  const MainContent = (props) => {
    return (
      <Stack className="MainContent" spacing={0}>
        <Tracks tracks={trackLibrary} />
        <PlaylistDrawer />
        <ScrollTop {...props}>
          <Fab size="medium" aria-label="scroll back to top">
            <KeyboardArrowUpIcon />
          </Fab>
        </ScrollTop>
      </Stack>
    );
  }

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
    <Fragment component="main">
      <CssBaseline />

      <Stack className="App" spacing={0}>
        {console.debug("Render")}
        {isLoading ? (
          <Backdrop className="Loader" open={true}>
            <Box sx={{ textAlign: 'center' }}>
              <CircularProgress size={60} sx={{ color: '#1DB954', mb: 2 }} />
              <Typography variant="h6" sx={{ color: '#FFFFFF', fontWeight: 600 }}>
                Loading your playlists...
              </Typography>
              {loadState.loadMessage && (
                <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.7)', mt: 1 }}>
                  {loadState.loadMessage}
                </Typography>
              )}
            </Box>
          </Backdrop>
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
                  <FontAwesomeIcon icon={icon({ name: 'spotify', style: 'brands' })} />
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
                startIcon={<FontAwesomeIcon fontSize="inherit" icon={icon({ name: 'spotify', style: 'brands' })} />} 
                onClick={spotify.authorizeSpotify}
              >
                Connect to Spotify
              </Button>
              
              {/* Credits Section */}
              <Divider sx={{ my: 4, width: '100%', maxWidth: 300, borderColor: 'rgba(255,255,255,0.1)' }} />
              
              <Typography variant="overline" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block', mb: 2 }}>
                Powered By
              </Typography>
              
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, mb: 3 }}>
                <Link 
                  href="https://www.spotify.com" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  sx={{ '&:hover': { opacity: 0.8 } }}
                >
                  <Box 
                    component="img" 
                    src="https://storage.googleapis.com/pr-newsroom-wp/1/2023/05/Spotify_Full_Logo_RGB_Green.png" 
                    alt="Spotify" 
                    sx={{ height: 24 }} 
                  />
                </Link>
                <Link 
                  href="https://getsongbpm.com" 
                  target="_blank"
                  sx={{ '&:hover': { opacity: 0.8 }, textDecoration: 'none' }}
                >
                  <Box 
                    component="img" 
                    src="/spotify-playlist-planner/logo_bpm.png" 
                    alt="GetSongBPM" 
                    sx={{ height: 28 }} 
                  />
                </Link>
              </Box>
              
              <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.7)', mb: 1 }}>
                Made with ❤️ by Adam Karl
              </Typography>
              <Link 
                href="https://venmo.com/Adam-Karl-3?txn=pay&amount=5&note=Thanks%20for%20Playlist%20Planner!" 
                target="_blank" 
                rel="noopener noreferrer"
                sx={{ textDecoration: 'none' }}
              >
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<LocalBarIcon />}
                  sx={{
                    borderColor: '#008CFF',
                    color: '#008CFF',
                    '&:hover': {
                      borderColor: '#008CFF',
                      backgroundColor: 'rgba(0, 140, 255, 0.1)',
                    }
                  }}
                >
                  Buy me a beer 🍺
                </Button>
              </Link>
            </Box>
          )}
      </Stack>
    </Fragment>
  );
}

export default App;
