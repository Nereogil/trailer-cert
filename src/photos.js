import { newId, putPhoto } from './db.js';

// Photos come off a modern phone camera at several megabytes each. Downscaling
// on capture keeps a job's worth of evidence in the tens of megabytes rather
// than the hundreds, which matters because it all lives in the phone's storage.

const MAX_EDGE = 1600;
const QUALITY = 0.8;

async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
      return await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the photo.'))),
        'image/jpeg',
        QUALITY
      );
    });
  } finally {
    bitmap.close();
  }
}

export async function capturePhoto(file, kind, jobId, caption = '') {
  let blob;
  try {
    blob = await downscale(file);
  } catch {
    // Better to keep the original than to lose the evidence over a resize.
    blob = file;
  }

  const photo = {
    id: newId(),
    jobId,
    kind,
    caption,
    blob,
    bytes: blob.size,
    takenAt: new Date().toISOString(),
  };

  await putPhoto(photo);
  return photo;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Chrome needs the URL alive until the download has actually started.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function photoFilename(vin, kind, index) {
  const stem = vin || 'unknown-vin';
  const suffix = index > 1 ? `_${index}` : '';
  return `${stem}_${kind}${suffix}.jpg`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
