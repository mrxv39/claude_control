// cc-heartbeat — add deltaSeconds to the active session and installation totals.
// The client sends this every 60s while the app is running.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type'
};

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
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  const deltaSeconds = Number.isFinite(body?.deltaSeconds) ? Math.max(0, Math.round(body.deltaSeconds)) : 0;

  if (!machineId || !sessionId) return json({ error: 'machineId and sessionId required' }, 400);
  if (deltaSeconds === 0) return json({ ok: true, noop: true });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );

  const now = new Date().toISOString();

  // Upsert session row — the first heartbeat creates it.
  const { data: existing } = await supabase
    .from('cc_sessions')
    .select('id, duration_seconds')
    .eq('id', sessionId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('cc_sessions')
      .update({ duration_seconds: (existing.duration_seconds || 0) + deltaSeconds })
      .eq('id', sessionId);
  } else {
    await supabase.from('cc_sessions').insert({
      id: sessionId,
      machine_id: machineId,
      started_at: now,
      duration_seconds: deltaSeconds
    });
    // Bump total_sessions on first heartbeat
    const { data: inst } = await supabase
      .from('cc_installations')
      .select('total_sessions')
      .eq('machine_id', machineId)
      .maybeSingle();
    if (inst) {
      await supabase
        .from('cc_installations')
        .update({ total_sessions: (inst.total_sessions || 0) + 1 })
        .eq('machine_id', machineId);
    }
  }

  // Bump total_seconds + last_seen_at on the installation
  const { data: inst2 } = await supabase
    .from('cc_installations')
    .select('total_seconds')
    .eq('machine_id', machineId)
    .maybeSingle();
  if (inst2) {
    await supabase
      .from('cc_installations')
      .update({
        total_seconds: (inst2.total_seconds || 0) + deltaSeconds,
        last_seen_at: now
      })
      .eq('machine_id', machineId);
  }

  return json({ ok: true, deltaSeconds });
});
