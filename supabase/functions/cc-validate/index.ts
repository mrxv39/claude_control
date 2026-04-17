// cc-validate — return current license status for a machine. The client calls
// this every 6h and on startup when the cache is stale. Updates last_seen_at.

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
  if (!machineId) return json({ error: 'machineId is required' }, 400);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );

  const { data } = await supabase
    .from('cc_installations')
    .select('status, plan, revoked_reason')
    .eq('machine_id', machineId)
    .maybeSingle();

  if (!data) return json({ status: 'unknown' });

  await supabase
    .from('cc_installations')
    .update({ last_seen_at: new Date().toISOString(), app_version: body.appVersion || null })
    .eq('machine_id', machineId);

  return json({
    status: data.status,
    plan: data.plan || 'beta',
    revokedReason: data.revoked_reason || undefined
  });
});
