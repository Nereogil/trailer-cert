// Turning a Google Vision response into rows of words.
//
// Shared by the compliance-plate reader and the tester-screen reader: both are
// laid out as forms, and both can be photographed with the phone turned, so
// both need the same two things - boxes rotated flat, then grouped into the
// rows a person would see.


export function tokensFromVisionResponse(response) {
  const annotations = response?.responses?.[0]?.textAnnotations ?? [];
  // annotations[0] is the entire block of text; the rest are individual words.
  const raw = annotations
    .slice(1)
    .map((a) => {
      const vertices = (a.boundingPoly?.vertices ?? []).map((v) => ({ x: v.x ?? 0, y: v.y ?? 0 }));
      if (vertices.length < 4) return null;
      return { text: a.description ?? '', vertices };
    })
    .filter((t) => t && t.text.length > 0);

  return boundsFromVertices(rotateUpright(raw));
}

// A photo taken with the phone turned sideways puts the plate's text running
// vertically down the image. Vision reads it perfectly well, but every box
// comes back in image coordinates, so grouping "words that share a y" finds
// columns instead of rows and the whole two-column layout falls apart.
//
// The fix is to measure how the text is actually lying and rotate the
// coordinates flat before any of the row logic runs. Each box's first two
// vertices are its top-left and top-right corners, so the vector between them
// is the direction the text runs.
export function textAngle(tokens) {
  const angles = tokens
    .map(({ vertices }) => {
      const [tl, tr] = vertices;
      const dx = tr.x - tl.x;
      const dy = tr.y - tl.y;
      return Math.hypot(dx, dy) < 1 ? null : Math.atan2(dy, dx);
    })
    .filter((a) => a !== null)
    .sort((a, b) => a - b);

  if (angles.length === 0) return 0;
  return angles[Math.floor(angles.length / 2)];
}

function rotateUpright(tokens) {
  const angle = textAngle(tokens);
  // Leave a nearly-straight photo alone; rotating it would only add rounding
  // noise to coordinates that are already fine.
  if (Math.abs(angle) < 0.09) return tokens; // about 5 degrees

  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  return tokens.map((token) => ({
    ...token,
    vertices: token.vertices.map(({ x, y }) => ({
      x: x * cos - y * sin,
      y: x * sin + y * cos,
    })),
  }));
}

function boundsFromVertices(tokens) {
  return tokens.map(({ text, vertices }) => {
    const xs = vertices.map((v) => v.x);
    const ys = vertices.map((v) => v.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    return {
      text,
      x0, y0, x1, y1,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      h: y1 - y0,
    };
  });
}

export function groupIntoLines(tokens) {
  if (tokens.length === 0) return [];

  // Tolerance scales with the type size so the same code copes with a photo
  // taken close up or from arm's length.
  const heights = tokens.map((t) => t.h).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10;
  const tolerance = medianHeight * 0.6;

  const sorted = [...tokens].sort((a, b) => a.cy - b.cy);
  const lines = [];
  let current = [sorted[0]];
  let reference = sorted[0].cy;

  for (const token of sorted.slice(1)) {
    if (Math.abs(token.cy - reference) <= tolerance) {
      current.push(token);
    } else {
      lines.push(current);
      current = [token];
      reference = token.cy;
    }
  }
  lines.push(current);

  return lines.map((line) => line.sort((a, b) => a.x0 - b.x0));
}
