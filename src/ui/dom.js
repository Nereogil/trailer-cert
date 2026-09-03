// Small helpers shared by the tab modules. No framework: the app is five
// screens of forms, and hand-written DOM keeps the whole thing one file per
// screen with nothing to learn.

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    // Deliberately no innerHTML escape hatch. Everything this app renders is
    // either a literal or text that came off a plate, a certificate or the
    // user's own typing, and all of it goes through textContent.
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastTimer = null;

export function toast(message, kind = '') {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast ${kind}`.trim();
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, kind === 'bad' ? 6000 : 3000);
}

export function debounce(fn, ms = 400) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function field(labelText, input) {
  return el('label', { class: 'field' }, [el('span', { text: labelText }), input]);
}

export function textInput(value, props = {}) {
  return el('input', { type: 'text', value: value ?? '', ...props });
}

export function numberInput(value, props = {}) {
  return el('input', {
    type: 'number',
    inputmode: 'decimal',
    value: value ?? '',
    ...props,
  });
}

// A camera button with a quieter "choose an existing photo" underneath.
//
// capture="environment" sends Android straight to the camera, which is right
// when you are standing at a trailer with one hand free. It also removes any
// way to use a photo that already exists - one taken earlier, or sent over by
// someone else - and on a desktop with no camera it means nothing at all.
//
// Two inputs rather than dropping capture: the one-tap path to the camera
// stays exactly as it was, and the file picker sits beside it for everything
// else. Same handler behind both, so callers do not care which was used.
export function photoInput({ label, onFile, buttonStyle = '', style = '', chooseLabel = 'Choose an existing photo' }) {
  const pick = (input) => async () => {
    const file = input.files?.[0];
    if (!file) return;
    // Cleared before the handler runs, so picking the same file twice in a row
    // still fires a change event the second time.
    input.value = '';
    await onFile(file);
  };

  const camera = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const existing = el('input', { type: 'file', accept: 'image/*', hidden: true });

  camera.addEventListener('change', pick(camera));
  existing.addEventListener('change', pick(existing));

  return el('div', { style }, [
    el('label', { class: 'capture' }, [
      camera,
      el('span', { class: 'big-button', style: buttonStyle, text: label }),
    ]),
    el('label', { class: 'capture pick-file' }, [
      existing,
      el('span', { text: chooseLabel }),
    ]),
  ]);
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

export function todayIso() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
