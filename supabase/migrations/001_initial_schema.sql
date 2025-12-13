-- RunNote Initial Schema
-- Run this in Supabase SQL Editor or via CLI migrations

-- ============================================
-- 1. PROFILES TABLE (extends Supabase auth.users)
-- ============================================
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  strava_athlete_id bigint unique,
  strava_access_token text,
  strava_refresh_token text,
  strava_token_expires_at timestamp with time zone,
  race_goal_name text,
  race_goal_date date,
  race_goal_distance text,
  race_goal_target_time text,
  subscription_status text default 'free',
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

comment on table public.profiles is 'User profiles with Strava tokens and subscription info';
comment on column public.profiles.strava_athlete_id is 'Strava athlete ID - unique identifier from Strava';
comment on column public.profiles.subscription_status is 'free, active, canceled, past_due';

-- ============================================
-- 2. ACTIVITIES TABLE (synced from Strava)
-- ============================================
create table public.activities (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles on delete cascade not null,
  strava_activity_id bigint unique not null,
  name text,
  activity_type text,
  start_date timestamp with time zone,
  distance_meters numeric,
  moving_time_seconds integer,
  elapsed_time_seconds integer,
  average_speed numeric,
  max_speed numeric,
  average_heartrate numeric,
  max_heartrate numeric,
  suffer_score integer,
  workout_type text,
  quality_score numeric,
  quality_notes text,
  raw_data jsonb,
  created_at timestamp with time zone default now()
);

comment on table public.activities is 'Running activities synced from Strava';
comment on column public.activities.workout_type is 'Classified: easy, tempo, interval, long_run, race, recovery';
comment on column public.activities.quality_score is '0-10 AI-generated score for workout execution';
comment on column public.activities.raw_data is 'Full Strava API response for future use';

-- ============================================
-- 3. WEEKLY SUMMARIES TABLE (AI-generated)
-- ============================================
create table public.weekly_summaries (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles on delete cascade not null,
  week_start date not null,
  week_end date not null,
  total_distance_meters numeric,
  total_time_seconds integer,
  activity_count integer,
  workout_breakdown jsonb,
  ai_summary text,
  race_readiness_note text,
  generated_at timestamp with time zone default now(),
  unique (user_id, week_start)
);

comment on table public.weekly_summaries is 'AI-generated weekly training summaries';
comment on column public.weekly_summaries.workout_breakdown is 'JSON: {"easy": 3, "tempo": 1, "interval": 1, "long_run": 1}';

-- ============================================
-- 4. BLOCK SUMMARIES TABLE (6-8 week summaries)
-- ============================================
create table public.block_summaries (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles on delete cascade not null,
  block_start date not null,
  block_end date not null,
  ai_summary text,
  strengths text[],
  areas_to_improve text[],
  race_readiness_estimate text,
  generated_at timestamp with time zone default now()
);

comment on table public.block_summaries is 'AI-generated training block summaries (6-8 weeks)';
comment on column public.block_summaries.race_readiness_estimate is 'e.g., "18:30-18:50 5K shape"';

-- ============================================
-- 5. OAUTH STATES TABLE (CSRF protection)
-- ============================================
create table public.oauth_states (
  state text primary key,
  created_at timestamp with time zone default now()
);

comment on table public.oauth_states is 'Temporary OAuth states for CSRF protection (10 min expiry)';

-- ============================================
-- 6. INDEXES
-- ============================================
create index idx_activities_user_date on public.activities (user_id, start_date desc);
create index idx_activities_strava_id on public.activities (strava_activity_id);
create index idx_weekly_summaries_user_week on public.weekly_summaries (user_id, week_start desc);
create index idx_profiles_strava_athlete on public.profiles (strava_athlete_id);
create index idx_oauth_states_created on public.oauth_states (created_at);

-- ============================================
-- 7. ROW LEVEL SECURITY (RLS)
-- ============================================
alter table public.profiles enable row level security;
alter table public.activities enable row level security;
alter table public.weekly_summaries enable row level security;
alter table public.block_summaries enable row level security;
alter table public.oauth_states enable row level security;

-- Profiles: users can read/update their own
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Activities: users can read their own
create policy "Users can view own activities"
  on public.activities for select
  using (auth.uid() = user_id);

-- Weekly summaries: users can read their own
create policy "Users can view own weekly summaries"
  on public.weekly_summaries for select
  using (auth.uid() = user_id);

-- Block summaries: users can read their own
create policy "Users can view own block summaries"
  on public.block_summaries for select
  using (auth.uid() = user_id);

-- OAuth states: service role only (no user access needed)
-- Edge functions use service_role key which bypasses RLS

-- ============================================
-- 8. SERVICE ROLE POLICIES (for Edge Functions)
-- ============================================
-- These allow Edge Functions (using service_role key) to insert/update/delete
-- Service role bypasses RLS by default, but explicit policies help document intent

-- Profiles: service role can insert (for new OAuth connections)
create policy "Service role can insert profiles"
  on public.profiles for insert
  with check (true);

-- Activities: service role can insert/update (for Strava sync)
create policy "Service role can insert activities"
  on public.activities for insert
  with check (true);

create policy "Service role can update activities"
  on public.activities for update
  using (true);

-- Weekly summaries: service role can insert/update (for AI generation)
create policy "Service role can insert weekly summaries"
  on public.weekly_summaries for insert
  with check (true);

create policy "Service role can update weekly summaries"
  on public.weekly_summaries for update
  using (true);

-- Block summaries: service role can insert/update
create policy "Service role can insert block summaries"
  on public.block_summaries for insert
  with check (true);

-- OAuth states: service role can manage
create policy "Service role can manage oauth states"
  on public.oauth_states for all
  using (true);

-- ============================================
-- 9. HELPER FUNCTIONS
-- ============================================

-- Function to auto-update updated_at timestamp
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Trigger for profiles updated_at
create trigger on_profiles_updated
  before update on public.profiles
  for each row
  execute function public.handle_updated_at();

-- Function to clean up expired OAuth states (call via pg_cron or manually)
create or replace function public.cleanup_expired_oauth_states()
returns integer as $$
declare
  deleted_count integer;
begin
  delete from public.oauth_states
  where created_at < now() - interval '10 minutes';

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$ language plpgsql;

comment on function public.cleanup_expired_oauth_states is 'Removes OAuth states older than 10 minutes. Call periodically.';

-- ============================================
-- 10. OPTIONAL: Auto-create profile on user signup
-- ============================================
-- This trigger creates a profile row when a new user signs up via Supabase Auth
-- Useful if you add email/password auth later

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, created_at, updated_at)
  values (new.id, new.email, now(), now());
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
