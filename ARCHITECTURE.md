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

### 2. Strava Sync (`/functions/strava-sync`)

Pulls new activities from Strava API.

```
POST /strava-sync          → Syncs activities for authenticated user
                             (called on-demand or via cron)
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
