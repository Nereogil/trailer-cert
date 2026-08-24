import { getDocument, GlobalWorkerOptions } from '../vendor/pdf.mjs';

// pdf.js runs its parser in a worker. The vendored worker sits beside the main
// build, so the URL is resolved relative to this module rather than the page.
GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;

export async function extractPdfText(file) {
  const data = new Uint8Array(await file.arrayBuffer());

  let doc;
  try {
    doc = await getDocument({ data }).promise;
  } catch (cause) {
    throw new Error('That file could not be opened as a PDF.', { cause });
  }

  try {
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(' '));
    }

    const text = pages.join('\n');
    if (!text.trim()) {
      throw new Error(
        'That PDF has no text layer — it is probably a scan. The certificate downloaded from the portal does have one.'
      );
    }
    return text;
  } finally {
    await doc.destroy();
  }
}
