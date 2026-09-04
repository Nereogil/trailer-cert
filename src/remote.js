// The Supabase-shaped half of sync. sync.js does not import this directly - it
// is handed in - which is what lets the reconciliation logic be tested against
// a fake table instead of a project.

import { selectRows, upsertRows } from './supabase.js';

export const jobsRemote = {
  upsertJobs(rows) {
    return upsertRows('jobs', rows);
  },

  // Ordered by the server clock and filtered by it, so the cursor advances
  // through the rows in the same order they were written. RLS already limits
  // this to the signed-in account, which is why there is no owner in the query:
  // asking for it here would only be a second opinion on something the database
  // has already decided.
  fetchJobsSince(cursor) {
    const parts = ['select=*', 'order=server_updated_at.asc'];
    if (cursor) parts.push(`server_updated_at=gt.${encodeURIComponent(cursor)}`);
    return selectRows('jobs', { query: parts.join('&') });
  },
};
