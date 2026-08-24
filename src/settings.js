const KEY = 'trailer-cert:settings';

// The install descriptions the certificates already use, seeded so they can be
// picked rather than retyped. These are equipment descriptions, not personal
// data — the electrician and customer fields start empty and are filled in on
// the phone, so nothing identifying ships in the repo.
export const DEFAULT_PRESETS = [
  "Existing 6 Poles switchboard with 3x 16A RCD's, shore power inlet, Inverter input and 1 Sub circuit to dual pole Socket outlets",
  'Existing Double pole twin outlets',
  'Existing 16A shore power Inlet connected to a Changeover Switch by a 16A RCD',
  'Existing 16A Inverter pre-wired plug connected to a Changeover switch by a 16A RCD',
];

// The test list the CCEW form offers, in the order the portal presents it.
export const TEST_OPTIONS = [
  'Earthing system integrity',
  'Insulation resistance',
  'Polarity',
  'Correct circuit connections',
  'Residual current device operation',
  'Visual check that installation is suitable for connection to supply',
  'Stand-alone power system complies with AS/NZS 4509',
];

const DEFAULTS = {
  visionApiKey: '',
  electrician: { name: '', licence: '', phone: '' },
  customer: { name: '', company: '', email: '', siteAddress: '' },
  descriptionPresets: DEFAULT_PRESETS,
  defaultInstallType: 'Caravan Trailer',
  defaultTests: TEST_OPTIONS.slice(0, 6),
};

export function get() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const stored = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...stored,
      electrician: { ...DEFAULTS.electrician, ...stored.electrician },
      customer: { ...DEFAULTS.customer, ...stored.customer },
    };
  } catch {
    // A corrupted settings blob should not stop the app from opening.
    return structuredClone(DEFAULTS);
  }
}

export function set(patch) {
  const next = { ...get(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export const hasApiKey = () => Boolean(get().visionApiKey);
