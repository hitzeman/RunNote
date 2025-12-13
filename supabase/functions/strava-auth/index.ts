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

  const url = new URL(req.url)
  const path = url.pathname.split('/').pop()

  try {
    switch (path) {
      case 'login':
        return await handleLogin(req)
      case 'callback':
        return await handleCallback(req)
      case 'refresh':
        return await handleRefresh(req)
      default:
        return new Response('Not found', { status: 404, headers: corsHeaders })
    }
  } catch (error) {
    console.error('Strava auth error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

/**
 * GET /strava-auth/login
 * Initiates OAuth flow - redirects to Strava authorization page
 */
async function handleLogin(_req: Request): Promise<Response> {
  const clientId = Deno.env.get('STRAVA_CLIENT_ID')
  const redirectUri = Deno.env.get('STRAVA_REDIRECT_URI')

  if (!clientId || !redirectUri) {
    throw new Error('Missing STRAVA_CLIENT_ID or STRAVA_REDIRECT_URI')
  }

  // Validate HTTPS in production
  const isLocalDev = redirectUri.includes('localhost') || redirectUri.includes('127.0.0.1')
  if (!isLocalDev && !redirectUri.startsWith('https://')) {
    throw new Error('STRAVA_REDIRECT_URI must use HTTPS in production')
  }

  // Generate CSRF state
  const state = crypto.randomUUID()

  // Store state in database
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { error: stateError } = await supabase.from('oauth_states').insert({
    state,
    created_at: new Date().toISOString(),
  })

  if (stateError) {
    console.error('Failed to save state:', stateError)
    throw new Error('Failed to initiate OAuth flow')
  }

  // Build Strava authorization URL
  const authUrl = new URL('https://www.strava.com/oauth/authorize')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('approval_prompt', 'auto')
  authUrl.searchParams.set('scope', 'read,activity:read_all,activity:write')
  authUrl.searchParams.set('state', state)

  console.log(`OAuth login initiated, redirecting to Strava`)

  return new Response(null, {
    status: 302,
    headers: { ...corsHeaders, Location: authUrl.toString() },
  })
}

/**
 * GET /strava-auth/callback
 * Handles OAuth callback from Strava - exchanges code for tokens
 */
async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  // Handle user denial
  if (error) {
    console.warn('User denied OAuth:', error)
    const appUrl = Deno.env.get('APP_URL') || 'http://localhost:4200'
    return new Response(null, {
      status: 302,
      headers: { Location: `${appUrl}?error=access_denied` },
    })
  }

  if (!code || !state) {
    return new Response('Missing code or state parameter', {
      status: 400,
      headers: corsHeaders,
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Validate and consume state (one-time use)
  const { data: stateRecord, error: stateError } = await supabase
    .from('oauth_states')
    .select('*')
    .eq('state', state)
    .single()

  if (stateError || !stateRecord) {
    console.warn('Invalid OAuth state:', state)
    return new Response('Invalid or expired state', {
      status: 403,
      headers: corsHeaders,
    })
  }

  // Check expiration (10 minutes)
  const stateAge = Date.now() - new Date(stateRecord.created_at).getTime()
  if (stateAge > 600000) {
    await supabase.from('oauth_states').delete().eq('state', state)
    console.warn('Expired OAuth state:', state)
    return new Response('State expired', {
      status: 403,
      headers: corsHeaders,
    })
  }

  // Delete state (one-time use)
  await supabase.from('oauth_states').delete().eq('state', state)

  // Exchange code for tokens
  const tokenResponse = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Deno.env.get('STRAVA_CLIENT_ID'),
      client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
      code,
      grant_type: 'authorization_code',
    }),
  })

  const tokenData = await tokenResponse.json()

  if (!tokenResponse.ok) {
    console.error('Token exchange failed:', tokenData)
    return new Response('Token exchange failed', {
      status: 500,
      headers: corsHeaders,
    })
  }

  const athleteId = tokenData.athlete.id
  const athleteName = `${tokenData.athlete.firstname} ${tokenData.athlete.lastname}`

  // Check if profile exists for this Strava athlete
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id')
    .eq('strava_athlete_id', athleteId)
    .single()

  if (existingProfile) {
    // Update existing profile with new tokens
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        strava_access_token: tokenData.access_token,
        strava_refresh_token: tokenData.refresh_token,
        strava_token_expires_at: new Date(tokenData.expires_at * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('strava_athlete_id', athleteId)

    if (updateError) {
      console.error('Failed to update profile:', updateError)
      return new Response('Failed to save tokens', {
        status: 500,
        headers: corsHeaders,
      })
    }

    console.log(`Updated tokens for athlete ${athleteId} (${athleteName})`)
  } else {
    // Create new profile
    // Note: This creates a profile without a Supabase auth user
    // You may want to handle this differently depending on your auth strategy
    const { error: insertError } = await supabase
      .from('profiles')
      .insert({
        id: crypto.randomUUID(),
        strava_athlete_id: athleteId,
        strava_access_token: tokenData.access_token,
        strava_refresh_token: tokenData.refresh_token,
        strava_token_expires_at: new Date(tokenData.expires_at * 1000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

    if (insertError) {
      console.error('Failed to create profile:', insertError)
      return new Response('Failed to save tokens', {
        status: 500,
        headers: corsHeaders,
      })
    }

    console.log(`Created profile for athlete ${athleteId} (${athleteName})`)
  }

  // Redirect to app dashboard
  const appUrl = Deno.env.get('APP_URL') || 'http://localhost:4200'
  return new Response(null, {
    status: 302,
    headers: { Location: `${appUrl}/dashboard?connected=true` },
  })
}

/**
 * POST /strava-auth/refresh
 * Refreshes expired Strava tokens
 * Body: { athlete_id: string }
 */
async function handleRefresh(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: corsHeaders,
    })
  }

  const { athlete_id } = await req.json()

  if (!athlete_id) {
    return new Response('Missing athlete_id', {
      status: 400,
      headers: corsHeaders,
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Get current tokens
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('strava_athlete_id', athlete_id)
    .single()

  if (profileError || !profile) {
    return new Response('Profile not found', {
      status: 404,
      headers: corsHeaders,
    })
  }

  // Refresh tokens with Strava
  const tokenResponse = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Deno.env.get('STRAVA_CLIENT_ID'),
      client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
      grant_type: 'refresh_token',
      refresh_token: profile.strava_refresh_token,
    }),
  })

  const tokenData = await tokenResponse.json()

  if (!tokenResponse.ok) {
    console.error('Token refresh failed:', tokenData)
    return new Response('Token refresh failed', {
      status: 500,
      headers: corsHeaders,
    })
  }

  // Update profile with new tokens
  const { error: updateError } = await supabase
    .from('profiles')
    .update({
      strava_access_token: tokenData.access_token,
      strava_refresh_token: tokenData.refresh_token,
      strava_token_expires_at: new Date(tokenData.expires_at * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('strava_athlete_id', athlete_id)

  if (updateError) {
    console.error('Failed to update tokens:', updateError)
    return new Response('Failed to save tokens', {
      status: 500,
      headers: corsHeaders,
    })
  }

  console.log(`Refreshed tokens for athlete ${athlete_id}`)

  return new Response(
    JSON.stringify({
      success: true,
      expires_at: tokenData.expires_at,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
}
