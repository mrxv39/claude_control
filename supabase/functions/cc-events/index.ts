// cc-events — batch insert telemetry events (max 100 per call).
// Client whitelists types on its side; we whitelist again here as defence-in-depth.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type'
};

const ALLOWED_TYPES = new Set([
  'app_start', 'app_stop', 'panel_toggle', 'panel_tab_view',
  'skill_run', 'skill_enqueue', 'scheduler_pause', 'scheduler_resume',
  'session_focus', 'session_idle', 'update_available', 'update_applied', 'error'
]);

const MAX_BATCH = 100;
const MAX_PAYLOAD_BYTES = 8_192;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const machineId = typeof body?.machineId === 'string' ? body.machineId.trim() : '';
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : null;
  const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_BATCH) : [];
  if (!machineId) return json({ error: 'machineId required' }, 400);
  if (events.length === 0) return json({ inserted: 0 });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );

  const rows = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (typeof ev.type !== 'string' || !ALLOWED_TYPES.has(ev.type)) continue;
    const payloadStr = JSON.stringify(ev.payload || {});
    if (payloadStr.length > MAX_PAYLOAD_BYTES) continue;
    const ts = typeof ev.timestamp === 'string' ? ev.timestamp : new Date().toISOString();
    rows.push({
      machine_id: machineId,
      session_id: sessionId,
      type: ev.type,
      payload: ev.payload || {},
      created_at: ts
    });
  }

  if (rows.length === 0) return json({ inserted: 0 });

  const { error } = await supabase.from('cc_events').insert(rows);
  if (error) return json({ error: error.message }, 500);
  return json({ inserted: rows.length });
});
