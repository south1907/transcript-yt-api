/**
 * YouTube transcript fetcher for MV3 service worker.
 *
 * WEB caption URLs often include exp=xpe and need PoToken → empty 200.
 * Prefer ANDROID / IOS Innertube caption URLs (no PoToken required).
 */

const INNERTUBE_API_BASE = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=';
const WATCH_URL = 'https://www.youtube.com/watch?v=';

/** Prefer mobile clients — their timedtext URLs work without PoToken. */
const CLIENTS = [
  {
    name: 'IOS',
    context: {
      client: {
        clientName: 'IOS',
        clientVersion: '20.10.4',
        deviceModel: 'iPhone16,2',
        hl: 'en',
        gl: 'US',
      },
    },
    headers: {
      'X-Youtube-Client-Name': '5',
      'X-Youtube-Client-Version': '20.10.4',
    },
  },
  {
    name: 'ANDROID',
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        hl: 'en',
        gl: 'US',
      },
    },
    headers: {
      'X-Youtube-Client-Name': '3',
      'X-Youtube-Client-Version': '20.10.38',
    },
  },
];

function normalizeCaptionUrl(baseUrl, fmt = 'json3', tlang = null) {
  if (!baseUrl || typeof baseUrl !== 'string') return '';
  let url = baseUrl.trim();
  if (url.startsWith('//')) url = 'https:' + url;
  else if (url.startsWith('/')) url = 'https://www.youtube.com' + url;
  if (url.includes('fmt=')) {
    url = url.replace(/fmt=[^&]+/, `fmt=${fmt}`);
  } else {
    url += (url.includes('?') ? '&' : '?') + `fmt=${fmt}`;
  }
  if (!/[?&]c=/.test(url)) {
    url += '&c=WEB';
  }
  // Auto-translate to target language when native track is missing
  if (tlang) {
    const tl = langBase(tlang);
    if (tl) {
      if (/[?&]tlang=/.test(url)) {
        url = url.replace(/tlang=[^&]+/, `tlang=${tl}`);
      } else {
        url += `&tlang=${tl}`;
      }
    }
  } else {
    // ensure we don't keep a stale tlang from baseUrl
    url = url.replace(/([?&])tlang=[^&]*&?/, '$1').replace(/[?&]$/, '');
  }
  return url;
}

function needsPoToken(baseUrl) {
  return typeof baseUrl === 'string' && /(?:^|[?&])exp=xpe(?:&|$)/.test(baseUrl);
}

/** en-US / a.en / en → en */
function langBase(code) {
  return String(code || '')
    .toLowerCase()
    .replace(/^a\./, '')
    .split(/[-_]/)[0];
}

function trackLangKeys(track) {
  const keys = new Set();
  const code = String(track.languageCode || '').toLowerCase();
  if (code) {
    keys.add(code);
    keys.add(langBase(code));
  }
  const vss = String(track.vssId || '').toLowerCase(); // .en-US | a.en | .zh-CN
  if (vss) {
    const cleaned = vss.replace(/^a\./, '').replace(/^\./, '');
    if (cleaned) {
      keys.add(cleaned);
      keys.add(langBase(cleaned));
    }
  }
  return keys;
}

function trackMatchesLang(track, lang) {
  const want = langBase(lang);
  if (!want) return false;
  const keys = trackLangKeys(track);
  if (keys.has(want) || keys.has(String(lang || '').toLowerCase())) return true;
  for (const k of keys) {
    if (k.startsWith(`${want}-`) || k.startsWith(`${want}_`)) return true;
  }
  return false;
}

function trackLabel(track) {
  const name = track?.name;
  if (typeof name === 'string') return name;
  if (name && typeof name.simpleText === 'string') return name.simpleText;
  if (name && Array.isArray(name.runs)) {
    return name.runs.map((r) => r.text || '').join('');
  }
  return track?.languageCode || '';
}

/**
 * Pick caption track by preferred languages.
 * - Native track if available (en matches en-US)
 * - Else: use English (or first) source + tlang=<preferred> for auto-translate
 * - Never silently return an unrelated first track when a preferred lang was requested
 */
function pickTrack(captionTracks, languages = ['en']) {
  if (!captionTracks || !captionTracks.length) return null;

  const prefs = (Array.isArray(languages) && languages.length ? languages : ['en'])
    .map((l) => String(l || '').trim())
    .filter(Boolean);

  const available = captionTracks.map((t) => ({
    languageCode: t.languageCode || '',
    kind: t.kind || 'manual',
    name: trackLabel(t),
    vssId: t.vssId || '',
    needsPot: needsPoToken(t.baseUrl),
  }));

  function preferenceIndex(track) {
    for (let i = 0; i < prefs.length; i++) {
      if (trackMatchesLang(track, prefs[i])) return i;
    }
    return -1;
  }

  function score(track) {
    const pref = preferenceIndex(track);
    const prefScore = pref === -1 ? 10_000 : pref * 100;
    const pot = needsPoToken(track.baseUrl) ? 10 : 0;
    const asr = track.kind === 'asr' ? 1 : 0;
    return prefScore + pot + asr;
  }

  const ranked = [...captionTracks].sort((a, b) => score(a) - score(b));
  const preferred = ranked.filter((t) => preferenceIndex(t) !== -1);

  let chosen = null;
  let tlang = null;
  let reason = '';
  let outputLanguage = '';

  if (preferred.length) {
    chosen = preferred.find((t) => !needsPoToken(t.baseUrl)) || preferred[0];
    reason = `preferred:${prefs.join(',')}`;
    outputLanguage = chosen.languageCode || prefs[0];
  } else {
    // No native track for requested language(s).
    // Prefer English as translation source, else first non-PoToken track.
    const enSource =
      ranked.find((t) => trackMatchesLang(t, 'en') && !needsPoToken(t.baseUrl)) ||
      ranked.find((t) => trackMatchesLang(t, 'en')) ||
      null;
    chosen =
      enSource ||
      ranked.find((t) => !needsPoToken(t.baseUrl)) ||
      ranked[0];

    const want = langBase(prefs[0]);
    const sourceBase = langBase(chosen?.languageCode);
    if (want && sourceBase && want !== sourceBase) {
      tlang = want; // YouTube timedtext auto-translate
      reason = `translate:${chosen.languageCode}->${want}`;
      outputLanguage = want;
    } else {
      reason = `fallback:${chosen?.languageCode || 'unknown'}(no ${prefs.join(',')})`;
      outputLanguage = chosen?.languageCode || '';
    }
  }

  if (!chosen) return null;
  const url = normalizeCaptionUrl(chosen.baseUrl, 'json3', tlang);
  if (!url) return null;

  console.log(
    '[transcript] pick',
    reason,
    '→',
    chosen.languageCode,
    tlang ? `tlang=${tlang}` : '',
    'from',
    available.map((a) => a.languageCode).join(',')
  );

  return {
    url,
    baseUrl: chosen.baseUrl,
    tlang,
    languageCode: outputLanguage,
    sourceLanguage: chosen.languageCode || '',
    kind: chosen.kind || 'manual',
    name: trackLabel(chosen),
    needsPot: needsPoToken(chosen.baseUrl),
    pickReason: reason,
    available,
  };
}

function extractInnertubeApiKey(html) {
  if (!html || typeof html !== 'string') return '';
  const patterns = [
    /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/,
    /"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/,
    /INNERTUBE_API_KEY["']?\s*:\s*["']([a-zA-Z0-9_-]+)["']/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]?.trim().length >= 10) return match[1].trim();
  }
  return '';
}

async function loadWatchHtml(videoId) {
  const watchUrl = WATCH_URL + videoId;
  const htmlRes = await fetch(watchUrl, {
    credentials: 'include',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,vi;q=0.9',
    },
  });
  if (!htmlRes.ok) throw new Error(`Failed to load video page: ${htmlRes.status}`);
  return { html: await htmlRes.text(), watchUrl };
}

async function fetchPlayerViaInnertube(videoId, html, watchUrl) {
  const apiKey = extractInnertubeApiKey(html);
  if (!apiKey) throw new Error('Could not extract INNERTUBE_API_KEY from page');

  const errors = [];

  for (const client of CLIENTS) {
    try {
      const playerRes = await fetch(INNERTUBE_API_BASE + apiKey, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.youtube.com',
          Referer: watchUrl,
          Accept: '*/*',
          'Accept-Language': 'en-US,vi;q=0.9',
          ...client.headers,
        },
        body: JSON.stringify({
          context: client.context,
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      });

      if (!playerRes.ok) {
        errors.push(`${client.name}:${playerRes.status}`);
        continue;
      }
      const data = await playerRes.json();
      const tracks =
        data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (!tracks.length) {
        errors.push(`${client.name}:no-captions`);
        continue;
      }
      const withoutPot = tracks.filter((t) => !needsPoToken(t.baseUrl)).length;
      console.log(
        '[transcript] using',
        client.name,
        'tracks=',
        tracks.length,
        'withoutPot=',
        withoutPot,
        'langs=',
        tracks.map((t) => t.languageCode).join(',')
      );
      // Return ALL tracks — pickTrack chooses language, then prefers non-PoToken
      return tracks;
    } catch (err) {
      errors.push(`${client.name}:${err.message}`);
    }
  }

  throw new Error(`Innertube caption tracks failed (${errors.join(', ')})`);
}

async function getTranscriptUrlViaFetch(videoId, languages = ['en']) {
  const { html, watchUrl } = await loadWatchHtml(videoId);
  const tracks = await fetchPlayerViaInnertube(videoId, html, watchUrl);
  const picked = pickTrack(tracks, languages);
  if (!picked) throw new Error('No usable caption track found');
  if (picked.needsPot) {
    throw new Error('Only PoToken caption URLs available (exp=xpe)');
  }
  return picked;
}

async function fetchTranscriptBody(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      Accept: 'text/xml, application/xml, application/json, text/plain, */*',
      'Accept-Language': 'en-US,vi;q=0.9',
      Referer: 'https://www.youtube.com/',
      Origin: 'https://www.youtube.com',
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch transcript: ${res.status}`);
  return res.text();
}

function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function parseTranscriptXml(xmlText) {
  if (!xmlText || !xmlText.trim()) return [];
  const segments = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = re.exec(xmlText)) !== null) {
    const attrs = m[1];
    const startMatch = attrs.match(/\bstart="([^"]+)"/i);
    const durMatch = attrs.match(/\bdur="([^"]+)"/i);
    const start = parseFloat(startMatch?.[1] || '0');
    const dur = parseFloat(durMatch?.[1] || '0');
    const text = decodeXmlEntities(m[2].replace(/<[^>]+>/g, ''))
      .replace(/\n/g, ' ')
      .trim();
    if (text) segments.push({ c: text, s: start, dur });
  }
  return segments;
}

function parseTranscriptJson3(jsonText) {
  if (!jsonText || !jsonText.trim()) return [];
  try {
    const data = JSON.parse(jsonText);
    const events = data?.events || [];
    const segments = [];
    for (const ev of events) {
      const segs = ev.segs;
      if (!segs || !Array.isArray(segs)) continue;
      const text = segs
        .map((s) => (s.utf8 || '').trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      const s = (ev.tStartMs || 0) / 1000;
      const dur = (ev.dDurationMs || 0) / 1000;
      segments.push({ c: text, s, dur });
    }
    return segments;
  } catch {
    return [];
  }
}

function parseRawTranscript(raw) {
  if (!raw || !raw.trim()) return [];
  // Empty timedtext is often literally empty string (PoToken required)
  if (!raw.trim().startsWith('<') && !raw.trim().startsWith('{')) {
    return [];
  }
  let segments = parseTranscriptJson3(raw);
  if (!segments.length) segments = parseTranscriptXml(raw);
  return segments;
}

async function fetchAndParseCaption(baseOrUrl, tlang = null) {
  const formats = ['json3', 'srv1'];
  let lastLen = 0;
  for (const fmt of formats) {
    const url = normalizeCaptionUrl(baseOrUrl, fmt, tlang);
    const raw = await fetchTranscriptBody(url);
    lastLen = raw.length;
    console.log('[transcript] timedtext', fmt, 'tlang=', tlang, 'len=', raw.length);
    const segments = parseRawTranscript(raw);
    if (segments.length) return segments;
  }
  // If translate failed, retry source language without tlang
  if (tlang) {
    console.warn('[transcript] tlang failed, retry without translate');
    return fetchAndParseCaption(baseOrUrl, null);
  }
  if (lastLen === 0) {
    throw new Error('timedtext returned empty body (likely PoToken / WEB track)');
  }
  return [];
}

/**
 * @param {string} videoId
 * @param {string[]} [languages]
 * @returns {Promise<{segments: {c:string,s:number,dur?:number}[], language: string, kind: string, available: object[]}>}
 */
export async function getTranscriptFromClient(videoId, languages = ['en']) {
  const info = await getTranscriptUrlViaFetch(videoId, languages);
  console.log(
    '[transcript] track',
    info.languageCode,
    'source=',
    info.sourceLanguage,
    'tlang=',
    info.tlang,
    'reason=',
    info.pickReason,
    'available=',
    (info.available || []).map((a) => a.languageCode).join(',')
  );

  const segments = await fetchAndParseCaption(info.baseUrl || info.url, info.tlang || null);
  if (!segments.length) {
    throw new Error('Empty transcript after parse');
  }
  return {
    segments,
    language: info.languageCode || '',
    sourceLanguage: info.sourceLanguage || info.languageCode || '',
    kind: info.kind || 'manual',
    name: info.name || '',
    pickReason: info.pickReason || '',
    available: info.available || [],
  };
}
