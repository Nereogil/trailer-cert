// Google Cloud Vision, called straight from the page with the user's own API
// key. The key lives in this phone's localStorage and never reaches this repo.

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
const TIMEOUT_MS = 30000;

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // Chunked because String.fromCharCode blows the argument limit on a
  // multi-megapixel photo.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function annotatePlate(file, apiKey) {
  if (!apiKey) {
    throw new Error('No Vision API key set yet. Add one in Settings.');
  }

  const body = {
    requests: [
      {
        image: { content: await fileToBase64(file) },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['en'] },
      },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    if (cause.name === 'AbortError') {
      throw new Error('Vision took too long to answer. Check your signal and try again.');
    }
    throw new Error('Could not reach Google Vision. Check your signal and try again.', { cause });
  } finally {
    clearTimeout(timer);
  }

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const message = json?.error?.message ?? `Vision returned ${response.status}`;
    if (response.status === 400 && /API key not valid/i.test(message)) {
      throw new Error('That API key is not valid. Check it in Settings.');
    }
    // Vision needs billing switched on even to use the free monthly allowance,
    // and this is the first wall a new key hits. Say so plainly rather than
    // passing on a bare PERMISSION_DENIED.
    if (/requires billing to be enabled/i.test(message)) {
      throw new Error(
        'Google needs billing enabled on the Cloud project before Vision will answer — even for the free 1,000 images a month. Turn it on in the Google Cloud console, then try again.'
      );
    }
    if (response.status === 403) {
      throw new Error(
        `Vision refused the key: ${message} — check the Cloud Vision API is enabled and the key is not restricted away from this site.`
      );
    }
    throw new Error(message);
  }

  const first = json?.responses?.[0];
  if (first?.error) throw new Error(first.error.message);
  if (!first?.textAnnotations?.length) {
    throw new Error('No text found in that photo. Get closer to the plate and try again.');
  }

  return json;
}
