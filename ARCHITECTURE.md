# RunNote - Architecture & Implementation Plan

## Product Overview

RunNote is a micro-SaaS for serious recreational runners that provides AI-powered training analysis and race readiness insights. It answers the question runners already ask ChatGPT manually: "Am I on track for my race?"

### Two-App Strategy

1. **Strava Plugin** (Free) - Lightweight, adds a one-liner insight to activity descriptions
   - Builds trust before asking for money
   - Passive marketing (other runners see the RunNote line)
   - Funnels users to full app

2. **Full Web App** (Paid - $5/month) - Weekly AI summaries + training context
   - Replaces "screenshot → paste to ChatGPT → hope" workflow
   - Memory of training history
   - Race-aware insights

### Target User

- Serious recreational runners (sub-25 → sub-18 5K, sub-1:40 → sub-1:20 HM)
- Already training 5-7 days/week
- Uses Strava + GPS watch
- Cares about performance, not just logging miles

### Business Goals

- Side income / small one-person business
- Target: 100-400 paying users at $5/month = $500-$2,000 MRR
- Low maintenance (< 5 hrs/week after launch)

---

## Tech Stack

```
Frontend:  Angular 21 (SSR enabled for SEO on marketing pages)
Backend:   Supabase (PostgreSQL + Edge Functions)
Auth:      Supabase Auth + custom Strava OAuth
LLM:       Claude API (Haiku for classification, Sonnet for summaries)
Payments:  Stripe
Hosting:   Vercel or Netlify (Angular SSR supported)
```

### Why This Stack

| Choice | Rationale |
|--------|-----------|
| Angular 21 | Developer familiarity, signals, standalone components |
| SSR enabled | SEO for landing pages, CSR for dashboard |
| Supabase | No backend server to manage, PostgreSQL, Edge Functions |
| Claude API | High-quality reasoning for training analysis |
| Stripe | Standard for subscriptions, good Supabase integration |

---

## Angular 21 Setup

### Project Creation

```bash
ng new runnote --ssr
```

### Rendering Strategy

| Page | Rendering | Why |
|------|-----------|-----|
| Landing page | SSG (pre-rendered) | SEO, fast load |
| Pricing | SSG | SEO |
| About | SSG | SEO |
| Dashboard | CSR | Behind auth, dynamic data |
| Settings | CSR | Behind auth |

---

## Data Model

### PostgreSQL Tables (Supabase)

```sql
-- Users table (extends Supabase auth.users)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  strava_athlete_id bigint unique,
  strava_access_token text,
  strava_refresh_token text,
  strava_token_expires_at timestamp with time zone,
  race_goal_name text,           -- e.g., "Boston Marathon"
  race_goal_date date,
  race_goal_distance text,       -- e.g., "marathon", "5k", "half"
  race_goal_target_time text,    -- e.g., "3:15:00"
  subscription_status text default 'free',  -- 'free', 'active', 'canceled'
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Activities synced from Strava
create table public.activities (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles on delete cascade not null,
  strava_activity_id bigint unique not null,
  name text,
  activity_type text,            -- 'Run', 'Race', etc.
  start_date timestamp with time zone,
  distance_meters numeric,
  moving_time_seconds integer,
  elapsed_time_seconds integer,
  average_speed numeric,
  max_speed numeric,
  average_heartrate numeric,
  max_heartrate numeric,
  suffer_score integer,
  workout_type text,             -- Classified: 'easy', 'tempo', 'interval', 'long_run', 'race', 'recovery'
  quality_score numeric,         -- 0-10 score for workout execution
  quality_notes text,            -- Brief AI explanation of score
  raw_data jsonb,                -- Full Strava response for future use
  created_at timestamp with time zone default now()
);

-- Weekly summaries (AI-generated)
create table public.weekly_summaries (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles on delete cascade not null,
  week_start date not null,      -- Monday of the week
  week_end date not null,        -- Sunday of the week
  total_distance_meters numeric,
  total_time_seconds integer,
  activity_count integer,
  workout_breakdown jsonb,       -- {"easy": 3, "tempo": 1, "interval": 1, "long_run": 1}
  ai_summary text,               -- The narrative summary
  race_readiness_note text,      -- If user has race goal set
  generated_at timestamp with time zone default now(),
  unique (user_id, week_start)
);

-- Training block summaries (6-8 weeks)
create table public.block_summaries (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles on delete cascade not null,
  block_start date not null,
  block_end date not null,
  ai_summary text,
  strengths text[],
  areas_to_improve text[],
  race_readiness_estimate text,  -- e.g., "18:30-18:50 5K shape"
  generated_at timestamp with time zone default now()
);

-- Row Level Security
alter table public.profiles enable row level security;
alter table public.activities enable row level security;
alter table public.weekly_summaries enable row level security;
alter table public.block_summaries enable row level security;

-- Users can only access their own data
create policy "Users can view own profile" on public.profiles
  for select using (auth.uid() = id);

create policy "Users can update own profile" on public.profiles
  for update using (auth.uid() = id);

create policy "Users can view own activities" on public.activities
  for select using (auth.uid() = user_id);

create policy "Users can view own weekly summaries" on public.weekly_summaries
  for select using (auth.uid() = user_id);

create policy "Users can view own block summaries" on public.block_summaries
  for select using (auth.uid() = user_id);
```

### Indexes

```sql
create index idx_activities_user_date on public.activities (user_id, start_date desc);
create index idx_activities_strava_id on public.activities (strava_activity_id);
create index idx_weekly_summaries_user_week on public.weekly_summaries (user_id, week_start desc);
```

---

## Supabase Edge Functions

### 1. Strava OAuth (`/functions/strava-auth`)

Handles the OAuth flow since Strava requires server-side token exchange.

```
GET  /strava-auth/login    → Redirects to Strava authorization
GET  /strava-auth/callback → Exchanges code for tokens, creates/updates profile
POST /strava-auth/refresh  → Refreshes expired access token
```

#### Implementation Notes (Adapted from Existing Azure Functions)

The existing `runnote-function` app has a working Strava OAuth implementation. Key patterns to preserve:

**CSRF Protection (from stateStore.ts):**
- Generate cryptographically secure state: `randomBytes(32).toString('hex')`
- Store state with timestamp, validate within 10 minutes
- One-time use: delete state after validation
- For Supabase: use `oauth_states` table or encode state in signed JWT

**Token Exchange (from strava.ts):**
```typescript
// This logic is portable - just change storage layer
async function exchangeCodeForToken(code: string) {
  const response = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  });
  return response.json();
}
```

**Token Refresh with Expiration Skew (from strava.ts):**
```typescript
// Check expiration with 60-second buffer
function isExpired(expires_at: number, skew = 60): boolean {
  const now = Math.floor(Date.now() / 1000);
  return expires_at <= now + skew;
}

// Always call this before Strava API requests
async function ensureValidTokens(userId: string): Promise<TokenData> {
  const profile = await getProfile(userId);
  if (isExpired(profile.strava_token_expires_at)) {
    return await refreshTokens(profile);
  }
  return profile;
}
```

**HTTPS Enforcement (from authConnect.ts):**
```typescript
// Validate redirect URI in production
const isLocalDev = redirectUri.includes('localhost') || redirectUri.includes('127.0.0.1');
if (!isLocalDev && !redirectUri.startsWith('https://')) {
  throw new Error('Redirect URI must use HTTPS in production');
}
```

#### Supabase Edge Function: strava-auth/login

```typescript
// supabase/functions/strava-auth/login.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Generate CSRF state
  const state = crypto.randomUUID();

  // Store state in database (or use signed JWT approach)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  await supabase.from('oauth_states').insert({
    state,
    created_at: new Date().toISOString(),
  });

  // Build Strava authorization URL
  const authUrl = new URL('https://www.strava.com/oauth/authorize');
  authUrl.searchParams.set('client_id', Deno.env.get('STRAVA_CLIENT_ID')!);
  authUrl.searchParams.set('redirect_uri', Deno.env.get('STRAVA_REDIRECT_URI')!);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('approval_prompt', 'auto');
  authUrl.searchParams.set('scope', 'read,activity:read_all');
  authUrl.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: { Location: authUrl.toString() },
  });
});
```

#### Supabase Edge Function: strava-auth/callback

```typescript
// supabase/functions/strava-auth/callback.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return new Response('Missing code or state', { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Validate and consume state (one-time use)
  const { data: stateRecord, error: stateError } = await supabase
    .from('oauth_states')
    .select('*')
    .eq('state', state)
    .single();

  if (stateError || !stateRecord) {
    return new Response('Invalid state', { status: 403 });
  }

  // Check expiration (10 minutes)
  const stateAge = Date.now() - new Date(stateRecord.created_at).getTime();
  if (stateAge > 600000) {
    await supabase.from('oauth_states').delete().eq('state', state);
    return new Response('State expired', { status: 403 });
  }

  // Delete state (one-time use)
  await supabase.from('oauth_states').delete().eq('state', state);

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
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok) {
    return new Response('Token exchange failed', { status: 500 });
  }

  // Upsert profile with Strava tokens
  const { error: upsertError } = await supabase.from('profiles').upsert({
    strava_athlete_id: tokenData.athlete.id,
    strava_access_token: tokenData.access_token,
    strava_refresh_token: tokenData.refresh_token,
    strava_token_expires_at: new Date(tokenData.expires_at * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }, {
    onConflict: 'strava_athlete_id',
  });

  if (upsertError) {
    return new Response('Failed to save tokens', { status: 500 });
  }

  // Redirect to app dashboard
  return new Response(null, {
    status: 302,
    headers: { Location: `${Deno.env.get('APP_URL')}/dashboard?connected=true` },
  });
});
```

#### OAuth States Table (Add to Schema)

```sql
-- Temporary OAuth states for CSRF protection
create table public.oauth_states (
  state text primary key,
  created_at timestamp with time zone default now()
);

-- Auto-cleanup old states (run via pg_cron or manually)
-- delete from public.oauth_states where created_at < now() - interval '10 minutes';
```

### 2. Strava Sync (`/functions/strava-sync`)

Pulls new activities from Strava API.

```
POST /strava-sync          → Syncs activities for authenticated user
                             (called on-demand or via cron)
```

#### Token Refresh Pattern

```typescript
// Reusable token refresh logic for any Strava API call
async function refreshStravaTokens(profile: Profile): Promise<Profile> {
  const response = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Deno.env.get('STRAVA_CLIENT_ID'),
      client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
      grant_type: 'refresh_token',
      refresh_token: profile.strava_refresh_token,
    }),
  });

  const data = await response.json();

  // Update tokens in database
  const { data: updated } = await supabase
    .from('profiles')
    .update({
      strava_access_token: data.access_token,
      strava_refresh_token: data.refresh_token,
      strava_token_expires_at: new Date(data.expires_at * 1000).toISOString(),
    })
    .eq('id', profile.id)
    .select()
    .single();

  return updated;
}

// Wrapper for any Strava API call with auto-refresh
async function callStravaAPI(profile: Profile, endpoint: string): Promise<any> {
  // Check if token needs refresh (60-second buffer)
  const expiresAt = new Date(profile.strava_token_expires_at).getTime() / 1000;
  const now = Math.floor(Date.now() / 1000);

  if (expiresAt <= now + 60) {
    profile = await refreshStravaTokens(profile);
  }

  const response = await fetch(`https://www.strava.com/api/v3${endpoint}`, {
    headers: { Authorization: `Bearer ${profile.strava_access_token}` },
  });

  // Handle token expiration during request (race condition)
  if (response.status === 401) {
    profile = await refreshStravaTokens(profile);
    return callStravaAPI(profile, endpoint); // Retry once
  }

  return response.json();
}
```

### 3. Generate Summary (`/functions/generate-summary`)

Calls Claude API to generate weekly/block summaries.

```
POST /generate-summary
  body: { type: "weekly" | "block", week_start?: date }
```

### 4. Stripe Webhooks (`/functions/stripe-webhook`)

Handles subscription lifecycle events.

```
POST /stripe-webhook       → Processes Stripe events (checkout.session.completed,
                             customer.subscription.updated, etc.)
```

---

## Workout Classification

### Approach: Heuristics + LLM Fallback

1. **Heuristic classification** (fast, free):
   - Parse activity name for keywords ("tempo", "intervals", "easy", "long")
   - Compare pace to user's recent average
   - Check distance for long run threshold
   - Look at HR zones if available

2. **LLM fallback** (when heuristics are uncertain):
   - Feed activity name + description + metrics to Claude Haiku
   - Quick classification call (~$0.001 per activity)

### Classification Categories

| Type | Abbreviation | Indicators |
|------|--------------|------------|
| Easy | E | Conversational pace, low HR, "easy" in name |
| Tempo | T | Sustained moderate-hard effort, "tempo" or "threshold" |
| Interval | I | Repeated hard efforts, "intervals", "repeats", "VO2" |
| Repetitions | R | Short, fast, full recovery, "strides", "200s", "400s" |
| Long Run | LR | Distance > 1.5x average, "long" in name |
| Race | Race | "race" in name or workout_type from Strava |
| Recovery | Rec | Very easy, short, day after hard effort |

---

## AI Summary Generation

### Weekly Summary Prompt Structure

```
You are an experienced running coach analyzing a week of training.

ATHLETE CONTEXT:
- Goal: {race_name} on {race_date} ({distance})
- Target time: {target_time}
- Recent training trend: {trend_summary}

THIS WEEK'S TRAINING:
{list of activities with type, distance, pace, HR, quality score}

PREVIOUS WEEK FOR COMPARISON:
{summary stats}

Generate a 4-6 sentence weekly summary that:
1. Assesses overall training quality (not just volume)
2. Notes what went well
3. Identifies any concerns (without being alarmist)
4. Relates to race goal if applicable
5. Uses calm, confident coaching tone

Do NOT:
- Overreact to one bad workout
- Use exclamation points or hype
- Suggest specific workouts (that's not your role)
- Be vague or generic
```

### Quality Score Prompt

```
Analyze this {workout_type} workout:
- Distance: {distance}
- Pace: {pace}
- Average HR: {avg_hr}
- HR drift: {drift}%
- Intended purpose: {classification}

Score 1-10 for execution quality and provide one sentence explanation.
Consider: appropriate effort level, pacing consistency, heart rate response.
```

### Cost Estimates

| Call Type | Model | Est. Cost per Call |
|-----------|-------|-------------------|
| Workout classification | Haiku | $0.001 |
| Quality score | Haiku | $0.002 |
| Weekly summary | Sonnet | $0.02-0.05 |
| Block summary | Sonnet | $0.05-0.10 |

**Per user per month** (assuming 5 runs/week):
- Classification: 20 × $0.001 = $0.02
- Quality scores: 20 × $0.002 = $0.04
- Weekly summaries: 4 × $0.03 = $0.12
- **Total LLM: ~$0.20/user/month**

Leaves healthy margin at $5/month price point.

---

## MVP Feature Scope

### Phase 1: Core MVP

1. **Landing page** (SSG)
   - Value proposition
   - Example weekly summary
   - Pricing ($5/month)
   - "Connect with Strava" CTA

2. **Strava OAuth flow**
   - Connect account
   - Pull last 8 weeks of history
   - Store tokens securely

3. **Dashboard** (CSR, authenticated)
   - Current week view with activities
   - AI-generated weekly summary
   - Quality score per activity
   - Race goal input

4. **Stripe integration**
   - Checkout for $5/month subscription
   - Customer portal for management
   - Webhook handling

### Phase 2: Enhancements

- Training block summary (6-8 week view)
- Historical weekly summaries
- Improved workout classification
- Race readiness confidence meter

### Phase 3: Strava Plugin

- Chrome extension or Strava app
- Adds RunNote line to activity descriptions
- Links back to full app

---

## Key Design Principles

### Product Tone

- **Calm, not anxious** - Don't overreact to one bad workout
- **Wise, not excited** - Sound like an experienced coach, not an app
- **Sparse, not busy** - Fewer insights, better timed
- **Honest, not flattering** - Truth builds trust

### What the App Does NOT Do

- Create training plans
- Prescribe workouts
- Send push notifications
- Diagnose injuries
- Provide power/lactate modeling
- Replace a real coach for elite athletes

### The Core Question It Answers

> "Given what I've been doing, am I on track for my race?"

---

## Development Sequence

```
1. [ ] Angular 21 project setup with SSR
2. [ ] Supabase project + database schema
3. [ ] Strava OAuth Edge Function
4. [ ] Activity sync Edge Function
5. [ ] Basic dashboard (list activities)
6. [ ] Workout classification logic
7. [ ] Claude API integration for summaries
8. [ ] Weekly summary generation + display
9. [ ] Race goal input + storage
10. [ ] Stripe integration
11. [ ] Landing page (SSG)
12. [ ] Deploy to Vercel/Netlify
```

---

## Environment Variables

```env
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Strava
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_REDIRECT_URI=

# Anthropic
ANTHROPIC_API_KEY=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_ID=

# App
APP_URL=https://runnote.app
```

---

## External API References

- [Strava API Docs](https://developers.strava.com/docs/reference/)
- [Supabase Docs](https://supabase.com/docs)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Anthropic Claude API](https://docs.anthropic.com/en/api/getting-started)
- [Stripe Subscriptions](https://stripe.com/docs/billing/subscriptions/overview)
- [Angular SSR](https://angular.dev/guide/ssr)

---

## Validation Checklist (Before Building)

- [ ] Write 3 sample weekly summaries for your own training
- [ ] Show to 5 serious runners
- [ ] Ask: "Would you pay $5/month for this automatically?"
- [ ] If 2+ say yes → proceed with build
