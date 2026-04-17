// cc-register — upsert a new installation and return its current status.
// v1: auto-grants `active`. Revocation happens later via Studio.

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
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!machineId || !email) return json({ error: 'machineId and email are required' }, 400);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );

  const now = new Date().toISOString();

  // Read existing install (if any)
  const { data: existing } = await supabase
    .from('cc_installations')
    .select('machine_id, email, status, plan, first_seen_at')
    .eq('machine_id', machineId)
    .maybeSingle();

  if (existing) {
    // Don't overwrite email on re-register. Just refresh metadata.
    await supabase
      .from('cc_installations')
      .update({
        last_seen_at: now,
        app_version: body.appVersion || null,
        hostname: body.hostname || null,
        username: body.username || null,
        name: body.name || null
      })
      .eq('machine_id', machineId);
    return json({ status: existing.status, plan: existing.plan || 'beta' });
  }

  // First-time registration — auto-grant `active` in v1.
  const { error } = await supabase.from('cc_installations').insert({
    machine_id: machineId,
    email,
    name: body.name || null,
    hostname: body.hostname || null,
    username: body.username || null,
    app_version: body.appVersion || null,
    status: 'active',
    plan: 'beta',
    first_seen_at: now,
    last_seen_at: now
  });
  if (error) return json({ error: error.message }, 500);
  return json({ status: 'active', plan: 'beta' });
});
