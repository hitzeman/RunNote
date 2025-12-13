# Deploying Supabase Edge Functions

## Prerequisites

1. Install Supabase CLI:
   ```bash
   npm install -g supabase
   ```

2. Login to Supabase:
   ```bash
   supabase login
   ```

3. Link to your project:
   ```bash
   cd C:\Users\hitze\source\repos\RunNote
   supabase link --project-ref YOUR_PROJECT_REF
   ```
   (Find your project ref in Supabase Dashboard → Settings → General)

## Set Environment Variables

In Supabase Dashboard → Settings → Edge Functions → Add secret:

```
STRAVA_CLIENT_ID=your_strava_client_id
STRAVA_CLIENT_SECRET=your_strava_client_secret
STRAVA_REDIRECT_URI=https://YOUR_PROJECT_REF.supabase.co/functions/v1/strava-auth/callback
STRAVA_VERIFY_TOKEN=your_webhook_verify_token
APP_URL=http://localhost:4200
```

For production, update `APP_URL` to your deployed frontend URL.

## Deploy Functions

Deploy all functions:
```bash
supabase functions deploy strava-auth
supabase functions deploy strava-webhook
supabase functions deploy strava-sync
```

Or deploy all at once:
```bash
supabase functions deploy
```

## Verify Deployment

Check function URLs in Supabase Dashboard → Edge Functions

Your endpoints will be:
- `https://YOUR_PROJECT_REF.supabase.co/functions/v1/strava-auth/login`
- `https://YOUR_PROJECT_REF.supabase.co/functions/v1/strava-auth/callback`
- `https://YOUR_PROJECT_REF.supabase.co/functions/v1/strava-webhook`
- `https://YOUR_PROJECT_REF.supabase.co/functions/v1/strava-sync`

## Update Strava App Settings

1. Go to https://www.strava.com/settings/api
2. Update Authorization Callback Domain to: `YOUR_PROJECT_REF.supabase.co`
3. For webhook subscription, use: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/strava-webhook`

## Register Strava Webhook (if not already done)

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=YOUR_CLIENT_ID \
  -F client_secret=YOUR_CLIENT_SECRET \
  -F callback_url=https://YOUR_PROJECT_REF.supabase.co/functions/v1/strava-webhook \
  -F verify_token=YOUR_VERIFY_TOKEN
```

## Test OAuth Flow

1. Visit: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/strava-auth/login`
2. Authorize on Strava
3. Should redirect to your app with `?connected=true`
4. Check `profiles` table in Supabase for your athlete record

## Test Activity Sync

```bash
curl -X POST https://YOUR_PROJECT_REF.supabase.co/functions/v1/strava-sync \
  -H "Content-Type: application/json" \
  -d '{"athlete_id": "YOUR_STRAVA_ATHLETE_ID", "weeks": 8}'
```

## Local Development

Run functions locally:
```bash
supabase start
supabase functions serve
```

Local function URLs:
- `http://localhost:54321/functions/v1/strava-auth/login`
- etc.

Note: For local OAuth testing, you'll need to update Strava's callback URL temporarily.

## Troubleshooting

### Check function logs:
```bash
supabase functions logs strava-auth
supabase functions logs strava-webhook
```

### Common issues:

1. **"Missing STRAVA_CLIENT_ID"** - Secrets not set in Dashboard
2. **"Invalid state"** - OAuth state expired or already used
3. **"Token exchange failed"** - Check client_id/client_secret match Strava app
4. **Webhook not receiving events** - Verify webhook subscription is active
