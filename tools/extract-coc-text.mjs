// Dev utility: dump the text layer of a CCEW pdf so the parser can be checked
// against a real certificate.
//
//   node tools/extract-coc-text.mjs samples/coc-sample-1.pdf
//
// Input lives under samples/, which is gitignored, so no certificate is ever
// committed. pdf.js warns that Node should use its legacy build; the modern
// build is what the app loads in the browser, and it extracts text fine here.
import { getDocument, GlobalWorkerOptions } from '../vendor/pdf.mjs';
import { readFileSync } from 'node:fs';

GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/extract-coc-text.mjs <certificate.pdf>');
  process.exit(1);
}

const doc = await getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
const pages = [];
for (let p = 1; p <= doc.numPages; p++) {
  const content = await (await doc.getPage(p)).getTextContent();
  pages.push(content.items.map((i) => i.str).join(' '));
}
process.stdout.write(pages.join('\n'));
