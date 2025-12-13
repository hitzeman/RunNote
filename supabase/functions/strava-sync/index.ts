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

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  try {
    const { athlete_id, weeks = 8 } = await req.json()

    if (!athlete_id) {
      return new Response(
        JSON.stringify({ error: 'Missing athlete_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Get athlete's profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('strava_athlete_id', athlete_id)
      .single()

    if (profileError || !profile) {
      return new Response(
        JSON.stringify({ error: 'Profile not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Ensure valid tokens
    const tokens = await ensureValidTokens(supabase, profile)

    // Calculate date range (last N weeks)
    const now = new Date()
    const after = Math.floor(new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000).getTime() / 1000)

    // Fetch activities from Strava
    const activities = await fetchStravaActivities(tokens.strava_access_token, after)

    console.log(`Fetched ${activities.length} activities for athlete ${athlete_id}`)

    // Filter to runs only
    const runs = activities.filter((a: any) => a.type === 'Run')
    console.log(`Found ${runs.length} runs`)

    // Upsert all activities
    let synced = 0
    let failed = 0

    for (const activity of runs) {
      // Fetch full activity details (includes laps, etc.)
      const fullActivity = await fetchStravaActivity(
        String(activity.id),
        tokens.strava_access_token
      )

      if (!fullActivity) {
        failed++
        continue
      }

      const { error: upsertError } = await supabase
        .from('activities')
        .upsert({
          user_id: profile.id,
          strava_activity_id: fullActivity.id,
          name: fullActivity.name,
          activity_type: fullActivity.type,
          start_date: fullActivity.start_date,
          distance_meters: fullActivity.distance,
          moving_time_seconds: fullActivity.moving_time,
          elapsed_time_seconds: fullActivity.elapsed_time,
          average_speed: fullActivity.average_speed,
          max_speed: fullActivity.max_speed,
          average_heartrate: fullActivity.average_heartrate,
          max_heartrate: fullActivity.max_heartrate,
          suffer_score: fullActivity.suffer_score,
          raw_data: fullActivity,
        }, {
          onConflict: 'strava_activity_id',
        })

      if (upsertError) {
        console.error(`Failed to upsert activity ${fullActivity.id}:`, upsertError)
        failed++
      } else {
        synced++
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    console.log(`Sync complete: ${synced} synced, ${failed} failed`)

    return new Response(
      JSON.stringify({
        success: true,
        total_fetched: activities.length,
        runs_found: runs.length,
        synced,
        failed,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Sync error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

/**
 * Ensures tokens are valid, refreshing if needed
 */
async function ensureValidTokens(
  supabase: ReturnType<typeof createClient>,
  profile: any
): Promise<any> {
  const expiresAt = new Date(profile.strava_token_expires_at).getTime() / 1000
  const now = Math.floor(Date.now() / 1000)

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

  return updated
}

/**
 * Fetches list of activities from Strava
 */
async function fetchStravaActivities(
  accessToken: string,
  after: number
): Promise<any[]> {
  const activities: any[] = []
  let page = 1
  const perPage = 100

  while (true) {
    const url = new URL('https://www.strava.com/api/v3/athlete/activities')
    url.searchParams.set('after', String(after))
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(perPage))

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!response.ok) {
      console.error(`Strava API error: ${response.status}`)
      break
    }

    const batch = await response.json()

    if (batch.length === 0) {
      break
    }

    activities.push(...batch)
    page++

    // Safety limit
    if (page > 10) {
      console.warn('Reached pagination limit')
      break
    }
  }

  return activities
}

/**
 * Fetches single activity with full details
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
    console.error(`Strava API error fetching activity ${activityId}: ${response.status}`)
    return null
  }

  return response.json()
}
