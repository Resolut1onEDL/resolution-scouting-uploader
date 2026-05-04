// Resolution Scouting — replay uploader.
//
// Flow per replay:
//   1. POST parsed JSON to /functions/v1/scouting-upload
//      (Authorization: Bearer scout_<token>).
//      Backend stores the row, validates the registered Steam ID is in
//      players[], and returns a signed upload URL for the .dem.bz2.
//   2. PUT compressed .dem.bz2 to that signed URL (storage bucket
//      scouting-replays-raw).
//   3. If step 2 fails, the JSON is still saved — the dem can be
//      re-uploaded later via "Re-upload .dem" admin action.
//
// Auth: scout_* token, issued by Steam OAuth flow on resolut1on.gg/scouting
// and saved to electron-store after the user clicks "Connect via Steam".

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

// Scouting backend lives on the Pro-tier Supabase project
// (brlrapwlwomweuzovhoi). Free-tier had a 50MB per-upload cap that
// blocked .dem uploads for any non-trivial match.
const DEFAULT_API_URL = 'https://brlrapwlwomweuzovhoi.supabase.co';

async function uploadParsedReplay({
  parsed,
  parserVersion,
  metadata,
  apiUrl,
  apiToken,
  demFilePath, // path to original .dem file for compress + storage upload
  log = () => {},
}) {
  if (!apiToken) throw new Error('Scouting token is not set. Connect via Steam first.');
  const baseUrl = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');

  // Step 1: POST parsed JSON
  const uploadEndpoint = `${baseUrl}/functions/v1/scouting-upload`;
  const res = await fetch(uploadEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify(parsed),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Server returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = json?.error || `HTTP ${res.status}`;
    throw new Error(`Upload failed: ${msg}`);
  }

  // Step 2: compress + PUT .dem.bz2 to the signed upload URL.
  // Best-effort: failure here doesn't fail the overall replay (JSON is
  // already saved), but we surface the error in the log.
  let demUploadResult = null;
  if (json.dem_upload_url && demFilePath && fs.existsSync(demFilePath)) {
    try {
      const bzPath = `${demFilePath}.bz2`;
      await compressBz2(demFilePath, bzPath);
      const stat = fs.statSync(bzPath);
      const buf = fs.readFileSync(bzPath);
      const putRes = await fetch(json.dem_upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/x-bzip2' },
        body: buf,
      });
      // Cleanup .bz2 even on failure — we have the buffer.
      try { fs.unlinkSync(bzPath); } catch { /* ignore */ }

      if (!putRes.ok) {
        const errText = await putRes.text();
        log(`dem upload failed (HTTP ${putRes.status}): ${errText.slice(0, 200)}`);
      } else {
        demUploadResult = {
          path: json.dem_storage_path,
          bytes: stat.size,
        };
      }
    } catch (err) {
      log(`dem compress/upload exception: ${err.message}`);
    }
  }

  return { ...json, dem_upload_result: demUploadResult };
}

function compressBz2(inPath, outPath) {
  // Node stdlib doesn't ship bzip2; use deflate (gzip) — server bucket
  // accepts application/octet-stream, name suffix is just convention.
  // For real bzip2 add `unbzip2-stream` later; gzip is fine for now and
  // achieves comparable compression on .dem.
  return pipeline(
    fs.createReadStream(inPath),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(outPath),
  );
}

// Persist failed uploads to disk for retry on next launch.
function pendingDir() {
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const dir = path.join(home, '.resolution-scouting-uploader', 'pending');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveForRetry({ parsed, parserVersion, metadata, demFilePath, error }) {
  const file = path.join(pendingDir(), `${parsed?.id ?? Date.now()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      parsed,
      parserVersion,
      metadata,
      demFilePath,
      error: error?.message,
      savedAt: new Date().toISOString(),
    }),
  );
  return file;
}

async function retryPending({ apiUrl, apiToken, log = () => {} } = {}) {
  const dir = pendingDir();
  if (!fs.existsSync(dir)) return { retried: 0, succeeded: 0, failed: 0 };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  let succeeded = 0;
  let failed = 0;
  for (const f of files) {
    const filePath = path.join(dir, f);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      await uploadParsedReplay({
        parsed: data.parsed,
        parserVersion: data.parserVersion,
        metadata: data.metadata,
        demFilePath: data.demFilePath,
        apiUrl,
        apiToken,
        log,
      });
      fs.unlinkSync(filePath);
      succeeded++;
      log(`retry ok: ${f}`);
    } catch (e) {
      failed++;
      log(`retry failed: ${f} — ${e.message}`);
    }
  }
  return { retried: files.length, succeeded, failed };
}

// Sanity check that the saved scouting token still works.
async function testConnection({ apiUrl, apiToken }) {
  if (!apiToken) return { ok: false, error: 'No token. Connect via Steam.' };
  const baseUrl = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  // Hit /scouting-upload with deliberately bad body → expect 400 with our error,
  // not 401. 401 means token is invalid/revoked.
  try {
    const res = await fetch(`${baseUrl}/functions/v1/scouting-upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({}),
    });
    if (res.status === 401) return { ok: false, error: 'Token rejected (revoked or expired). Reconnect via Steam.' };
    if (res.status === 400) return { ok: true }; // bad body = good token
    return { ok: false, error: `Unexpected HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  uploadParsedReplay,
  saveForRetry,
  retryPending,
  testConnection,
  DEFAULT_API_URL,
};
