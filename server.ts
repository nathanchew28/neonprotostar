import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { DecodedSignature, recognizeBytes } from 'shazamio-core';
import { createServer as createViteServer } from 'vite';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

interface ChordPosition {
  frets: number[];
  fingers: number[];
  baseFret: number;
  barres: number[];
  midi?: number[];
}

interface ChordEntry {
  key: string;
  suffix: string;
  positions: ChordPosition[];
}

interface ChordsDbInstrument {
  main?: { strings?: number; fretsOnChord?: number };
  tunings?: { standard?: string[] };
  chords: Record<string, ChordEntry[]>;
}

const guitarDb = require('@tombatossals/chords-db/lib/guitar.json') as ChordsDbInstrument;
const ukuleleDb = require('@tombatossals/chords-db/lib/ukulele.json') as ChordsDbInstrument;

const GUITAR_KEY_MAP: Record<string, string> = {
  C: 'C',
  'C#': 'Csharp',
  Db: 'Csharp',
  D: 'D',
  'D#': 'Eb',
  Eb: 'Eb',
  E: 'E',
  F: 'F',
  'F#': 'Fsharp',
  Gb: 'Fsharp',
  G: 'G',
  'G#': 'Ab',
  Ab: 'Ab',
  A: 'A',
  'A#': 'Bb',
  Bb: 'Bb',
  B: 'B',
};

const UKULELE_KEY_MAP: Record<string, string> = {
  C: 'C',
  'C#': 'Db',
  Db: 'Db',
  D: 'D',
  'D#': 'Eb',
  Eb: 'Eb',
  E: 'E',
  F: 'F',
  'F#': 'Gb',
  Gb: 'Gb',
  G: 'G',
  'G#': 'Ab',
  Ab: 'Ab',
  A: 'A',
  'A#': 'Bb',
  Bb: 'Bb',
  B: 'B',
};

const CHORD_SUFFIX_MAP: Record<string, string> = {
  maj: 'major',
  major: 'major',
  m: 'minor',
  minor: 'minor',
  '7': '7',
  maj7: 'maj7',
  m7: 'm7',
  sus4: 'sus4',
};

const NOTE_PCS: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
};

function buildPowerChordPositions(instrument: 'guitar' | 'ukulele', root: string): ChordPosition[] {
  const rootPc = NOTE_PCS[root];
  if (rootPc === undefined) return [];
  const fifthPc = (rootPc + 7) % 12;

  if (instrument === 'guitar') {
    // Low-E string (E2 = midi 40, pc 4) & A string (A2 = midi 45, pc 9)
    const eFret = (rootPc - 4 + 12) % 12;
    const eBase = eFret === 0 ? 1 : eFret;
    const eShape: ChordPosition = {
      frets: eFret === 0 ? [0, 2, 2, -1, -1, -1] : [1, 3, 3, -1, -1, -1],
      fingers: eFret === 0 ? [0, 1, 2, 0, 0, 0] : [1, 3, 4, 0, 0, 0],
      baseFret: eBase,
      barres: [],
      midi: [40 + eFret, 40 + eFret + 7, 40 + eFret + 12],
    };

    const aFret = (rootPc - 9 + 12) % 12;
    const aBase = aFret === 0 ? 1 : aFret;
    const aShape: ChordPosition = {
      frets: aFret === 0 ? [-1, 0, 2, 2, -1, -1] : [-1, 1, 3, 3, -1, -1],
      fingers: aFret === 0 ? [0, 0, 1, 2, 0, 0] : [0, 1, 3, 4, 0, 0],
      baseFret: aBase,
      barres: [],
      midi: [45 + aFret, 45 + aFret + 7, 45 + aFret + 12],
    };

    return eFret <= aFret ? [eShape, aShape] : [aShape, eShape];
  }

  // Ukulele standard tuning G4(67, pc 7), C4(60, pc 0), E4(64, pc 4), A4(69, pc 9)
  const cFret = (rootPc - 0 + 12) % 12;
  const gFretForFifth = (fifthPc - 7 + 12) % 12;
  const aFretForFifth = (fifthPc - 9 + 12) % 12;
  const fretsRaw = [gFretForFifth, cFret, (rootPc - 4 + 12) % 12, aFretForFifth];
  const minNonZero = Math.min(...fretsRaw.filter((f) => f > 0), 1);
  const baseFret = Math.max(1, minNonZero);
  return [
    {
      frets: fretsRaw.map((f) => (f === 0 ? 0 : f - baseFret + 1)),
      fingers: fretsRaw.map((f) => (f === 0 ? 0 : 1)),
      baseFret,
      barres: [],
      midi: [67 + fretsRaw[0], 60 + fretsRaw[1], 64 + fretsRaw[2], 69 + fretsRaw[3]],
    },
  ];
}

function lookupChordData(instrumentParam: string, root: string, quality: string) {
  const instrument: 'guitar' | 'ukulele' = instrumentParam === 'ukulele' ? 'ukulele' : 'guitar';
  const db = instrument === 'ukulele' ? ukuleleDb : guitarDb;
  const tuning = db.tunings?.standard || (instrument === 'ukulele' ? ['G4', 'C4', 'E4', 'A4'] : ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']);

  if (quality === '5') {
    return {
      instrument,
      tuning,
      key: root,
      suffix: '5',
      positions: buildPowerChordPositions(instrument, root),
    };
  }

  const keyMap = instrument === 'ukulele' ? UKULELE_KEY_MAP : GUITAR_KEY_MAP;
  const dbKey = keyMap[root] || 'C';
  const dbSuffix = CHORD_SUFFIX_MAP[quality] || 'major';
  const entries = db.chords?.[dbKey] || [];
  const matched = entries.find((entry) => entry.suffix === dbSuffix);

  return {
    instrument,
    tuning,
    key: dbKey,
    suffix: dbSuffix,
    positions: matched ? matched.positions.slice(0, 4) : [],
  };
}

interface ShazamMetadataItem {
  title?: string;
  text?: string;
}

interface ShazamAction {
  type?: string;
  uri?: string;
  id?: string;
}

interface ShazamSection {
  type?: string;
  metadata?: ShazamMetadataItem[];
  actions?: ShazamAction[];
  youtubeurl?: {
    caption?: string;
    image?: { url?: string };
    actions?: ShazamAction[];
  };
}

interface ShazamTrack {
  title?: string;
  subtitle?: string;
  url?: string;
  genres?: { primary?: string };
  images?: { coverarthq?: string; coverart?: string };
  hub?: {
    actions?: ShazamAction[];
    options?: Array<{ actions?: ShazamAction[] }>;
  };
  sections?: ShazamSection[];
}

interface ShazamResponse {
  track?: ShazamTrack;
  matches?: Array<{ id?: string }>;
}

function isYoutubeUri(uri?: string): uri is string {
  if (!uri || typeof uri !== 'string') return false;
  return /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(uri);
}

function extractYoutubeUrl(track: ShazamTrack): { youtubeUrl: string | null; youtubeThumbnail: string | null } {
  let youtubeUrl: string | null = null;
  let youtubeThumbnail: string | null = null;

  for (const section of track.sections || []) {
    if (section.youtubeurl?.actions) {
      for (const action of section.youtubeurl.actions) {
        if (isYoutubeUri(action.uri)) {
          youtubeUrl = action.uri;
          youtubeThumbnail = section.youtubeurl.image?.url || null;
          break;
        }
      }
    }
    if (youtubeUrl) break;

    if (Array.isArray(section.actions)) {
      for (const action of section.actions) {
        if (isYoutubeUri(action.uri)) {
          youtubeUrl = action.uri;
          break;
        }
      }
    }
    if (youtubeUrl) break;
  }

  if (!youtubeUrl && track.hub) {
    for (const action of track.hub.actions || []) {
      if (isYoutubeUri(action.uri)) {
        youtubeUrl = action.uri;
        break;
      }
    }
    if (!youtubeUrl) {
      for (const option of track.hub.options || []) {
        for (const action of option.actions || []) {
          if (isYoutubeUri(action.uri)) {
            youtubeUrl = action.uri;
            break;
          }
        }
        if (youtubeUrl) break;
      }
    }
  }

  return { youtubeUrl, youtubeThumbnail };
}

function parseSongDetails(data: ShazamResponse) {
  const track = data.track;
  if (!track || !track.title) {
    return null;
  }

  let album = '';
  let releaseDate = '';
  for (const section of track.sections || []) {
    if (section.type === 'SONG' && Array.isArray(section.metadata)) {
      for (const item of section.metadata) {
        if (item.title === 'Album' && item.text) album = item.text;
        if (item.title === 'Released' && item.text) releaseDate = item.text;
      }
    }
  }

  const artist = track.subtitle || 'Unknown Artist';
  const genre = track.genres?.primary || '';
  const details = [
    album ? `Album: ${album}` : null,
    genre ? `Genre: ${genre}` : null,
  ]
    .filter(Boolean)
    .join(' • ');

  const { youtubeUrl, youtubeThumbnail } = extractYoutubeUrl(track);
  const youtubeSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(
    `${track.title} ${artist === 'Unknown Artist' ? '' : artist}`.trim()
  )}`;

  return {
    title: track.title,
    artist,
    date: releaseDate || 'Unknown Release',
    album: album || null,
    genre: genre || null,
    coverArt: track.images?.coverarthq || track.images?.coverart || youtubeThumbnail || null,
    songLink: track.url || null,
    youtubeUrl,
    youtubeSearchUrl,
    description: details || 'Identified via open-source Shazamio signature matching',
  };
}

interface SheetMusicSearchResult {
  title: string;
  url: string;
}

async function searchImslpScores(query: string): Promise<SheetMusicSearchResult[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const url =
      `https://imslp.org/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(query)}&srlimit=4&srnamespace=0&format=json`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'NeonProtostar/1.0 (Open-Source Music Visualizer)',
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      query?: { search?: Array<{ title?: string }> };
    };
    const items = data.query?.search || [];
    return items
      .filter((item): item is { title: string } => typeof item.title === 'string' && item.title.length > 0)
      .map((item) => ({
        title: item.title,
        url: `https://imslp.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

async function queryShazamSignature(uri: string, samplems: number): Promise<ShazamResponse> {
  const uuid1 = crypto.randomUUID().toUpperCase();
  const uuid2 = crypto.randomUUID().toUpperCase();
  const endpoint =
    `https://amp.shazam.com/discovery/v5/en/US/android/-/tag/${uuid1}/${uuid2}` +
    `?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7 Build/TD1A.220804.031)',
        'X-Shazam-Platform': 'ANDROID',
        'X-Shazam-AppVersion': '14.1.0',
        'Accept-Language': 'en-US',
      },
      body: JSON.stringify({
        timezone: 'UTC',
        signature: { uri, samplems },
        timestamp: Date.now(),
        context: {},
        geolocation: { altitude: 300, latitude: 45, longitude: 2 },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Recognition service returned HTTP ${response.status}`);
    }

    return (await response.json()) as ShazamResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function startServer() {
  const app = express();

  app.post(
    '/api/identify',
    express.raw({ type: ['application/octet-stream', 'audio/*'], limit: '8mb' }),
    async (req, res) => {
      try {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.byteLength < 1024) {
          res.status(400).json({ error: 'Audio sample is empty or too short.' });
          return;
        }

        const contentType = String(req.headers['content-type'] || '');
        const sampleRateHeader = Number(req.headers['x-sample-rate'] || req.query.sampleRate || 16000);
        const sampleRate =
          Number.isFinite(sampleRateHeader) && sampleRateHeader >= 8000 && sampleRateHeader <= 96000
            ? Math.round(sampleRateHeader)
            : 16000;

        let uri = '';
        let samplems = 0;

        if (contentType.startsWith('audio/')) {
          const signatures = recognizeBytes(new Uint8Array(body));
          try {
            if (!signatures.length) {
              res.json({ matched: false, message: 'Could not extract audio fingerprint from sample.' });
              return;
            }
            const first = signatures[0];
            uri = first.uri;
            samplems = first.samplems;
          } finally {
            for (const sig of signatures) {
              sig.free();
            }
          }
        } else {
          const floatCount = Math.floor(body.byteLength / 4);
          const f32 = new Float32Array(floatCount);
          new Uint8Array(f32.buffer).set(body.subarray(0, floatCount * 4));

          const sig = DecodedSignature.new(f32, sampleRate, 1);
          try {
            uri = sig.uri;
            samplems = sig.samplems;
          } finally {
            sig.free();
          }
        }

        const shazamData = await queryShazamSignature(uri, samplems);
        const song = parseSongDetails(shazamData);

        if (!song) {
          res.json({
            matched: false,
            message: 'No matching song detected. Play the track louder or closer to the mic and try again.',
          });
          return;
        }

        res.json({ matched: true, song });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Song identification failed.';
        console.error('[/api/identify] Error:', message);
        res.status(502).json({ error: message });
      }
    }
  );

  app.get('/api/sheet-music', async (req, res) => {
    const title = String(req.query.title || '').trim();
    const artist = String(req.query.artist || '').trim();
    const rawQuery = String(req.query.q || '').trim();
    const combinedQuery = rawQuery || [title, artist === 'Unknown Artist' ? '' : artist].filter(Boolean).join(' ');

    if (!combinedQuery) {
      res.status(400).json({ error: 'Missing query or song title.' });
      return;
    }

    let imslpMatches = await searchImslpScores(combinedQuery);
    if (imslpMatches.length === 0 && title && title !== combinedQuery) {
      imslpMatches = await searchImslpScores(title);
    }
    const encodedFull = encodeURIComponent(combinedQuery);
    const encodedTitle = encodeURIComponent(title || combinedQuery);

    res.json({
      query: combinedQuery,
      imslpMatches,
      sources: [
        {
          name: 'IMSLP (Petrucci)',
          badge: 'Free PDFs',
          url: `https://imslp.org/index.php?title=Special:Search&search=${encodedTitle}`,
        },
        {
          name: 'Mutopia Project',
          badge: 'Open LilyPond',
          url: `https://www.mutopiaproject.org/cgibin/make-table.cgi?searchingfor=${encodedTitle}`,
        },
        {
          name: 'Musopen',
          badge: 'Public Domain',
          url: `https://musopen.org/music/?q=${encodedFull}`,
        },
        {
          name: 'Wikimedia Scores',
          badge: 'Open Commons',
          url: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(`${combinedQuery} sheet music`)}&title=Special:MediaSearch&type=other`,
        },
      ],
    });
  });

  app.get('/api/chords', (req, res) => {
    const instrument = String(req.query.instrument || 'guitar').toLowerCase();
    const root = String(req.query.root || 'C').trim();
    const quality = String(req.query.quality || 'maj').trim();
    const result = lookupChordData(instrument, root, quality);
    res.json(result);
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, HOST, () => {
    console.log(`Neon Protostar server running on http://${HOST}:${PORT}`);
  });
}

startServer();
