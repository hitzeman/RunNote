import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method === 'GET') {
      return handleVerification(req)
    } else if (req.method === 'POST') {
      return await handleWebhookEvent(req)
    }
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  } catch (error) {
    console.error('Webhook error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

/**
 * GET /strava-webhook
 * Handles Strava webhook subscription verification
 * Strava sends: ?hub.mode=subscribe&hub.challenge=XXX&hub.verify_token=YYY
 */
function handleVerification(req: Request): Response {
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode')
  const challenge = url.searchParams.get('hub.challenge')
  const verifyToken = url.searchParams.get('hub.verify_token')

  const expectedToken = Deno.env.get('STRAVA_VERIFY_TOKEN')

  if (mode === 'subscribe' && verifyToken === expectedToken) {
    console.log('Webhook verification successful')
    return new Response(
      JSON.stringify({ 'hub.challenge': challenge }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  console.warn('Webhook verification failed')
  return new Response('Forbidden', { status: 403, headers: corsHeaders })
}

/**
 * POST /strava-webhook
 * Handles incoming Strava webhook events
 */
async function handleWebhookEvent(req: Request): Promise<Response> {
  const event = await req.json()

  console.log('Received webhook event:', JSON.stringify(event))

  // Only process activity create/update events
  if (event.object_type !== 'activity') {
    console.log(`Ignoring non-activity event: ${event.object_type}`)
    return new Response('OK', { status: 200, headers: corsHeaders })
  }

  if (event.aspect_type !== 'create' && event.aspect_type !== 'update') {
    console.log(`Ignoring event type: ${event.aspect_type}`)
    return new Response('OK', { status: 200, headers: corsHeaders })
  }

  const athleteId = String(event.owner_id)
  const activityId = String(event.object_id)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Get athlete's profile and tokens
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('strava_athlete_id', athleteId)
    .single()

  if (profileError || !profile) {
    console.log(`No profile found for athlete ${athleteId}, skipping`)
    return new Response('OK', { status: 200, headers: corsHeaders })
  }

  // Ensure valid tokens
  const tokens = await ensureValidTokens(supabase, profile)

  // Fetch full activity from Strava
  const activity = await fetchStravaActivity(activityId, tokens.strava_access_token)

  if (!activity) {
    console.error(`Failed to fetch activity ${activityId}`)
    return new Response('OK', { status: 200, headers: corsHeaders })
  }

  // Only process runs
  if (activity.type !== 'Run') {
    console.log(`Ignoring non-run activity: ${activity.type}`)
    return new Response('OK', { status: 200, headers: corsHeaders })
  }

  // Upsert activity to database
  const { error: upsertError } = await supabase
    .from('activities')
    .upsert({
      user_id: profile.id,
      strava_activity_id: activity.id,
      name: activity.name,
      activity_type: activity.type,
      start_date: activity.start_date,
      distance_meters: activity.distance,
      moving_time_seconds: activity.moving_time,
      elapsed_time_seconds: activity.elapsed_time,
      average_speed: activity.average_speed,
      max_speed: activity.max_speed,
      average_heartrate: activity.average_heartrate,
      max_heartrate: activity.max_heartrate,
      suffer_score: activity.suffer_score,
      raw_data: activity,
    }, {
      onConflict: 'strava_activity_id',
    })

  if (upsertError) {
    console.error('Failed to upsert activity:', upsertError)
  } else {
    console.log(`Synced activity ${activityId} for athlete ${athleteId}`)
  }

  // TODO: Add AI classification and description update here
  // This is where you'd call Claude to classify the workout
  // and optionally update the Strava description

  return new Response('OK', { status: 200, headers: corsHeaders })
}

/**
 * Ensures tokens are valid, refreshing if needed
 */
async function ensureValidTokens(
  supabase: ReturnType<typeof createClient>,
  profile: any
): Promise<any> {
  const expiresAt = new Date(profile.strava_token_expires_at).getTime() / 1000
  const now = Math.floor(Date.now() / 1000)

  // Check if token needs refresh (60-second buffer)
  if (expiresAt <= now + 60) {
    console.log(`Refreshing tokens for athlete ${profile.strava_athlete_id}`)
    return await refreshTokens(supabase, profile)
  }

  return profile
}

/**
 * Refreshes Strava tokens
 */
async function refreshTokens(
  supabase: ReturnType<typeof createClient>,
  profile: any
): Promise<any> {
  const response = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Deno.env.get('STRAVA_CLIENT_ID'),
      client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
      grant_type: 'refresh_token',
      refresh_token: profile.strava_refresh_token,
    }),
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`)
  }

  // Update tokens in database
  const { data: updated, error } = await supabase
    .from('profiles')
    .update({
      strava_access_token: data.access_token,
      strava_refresh_token: data.refresh_token,
      strava_token_expires_at: new Date(data.expires_at * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', profile.id)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to save refreshed tokens: ${error.message}`)
  }

  console.log(`Tokens refreshed for athlete ${profile.strava_athlete_id}`)
  return updated
}

/**
 * Fetches activity from Strava API
 */
async function fetchStravaActivity(
  activityId: string,
  accessToken: string
): Promise<any | null> {
  const response = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  )

  if (!response.ok) {
    console.error(`Strava API error: ${response.status}`)
    return null
  }

  return response.json()
}
