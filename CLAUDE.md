# RunNote - AI Assistant Context

## Project Summary

RunNote is a micro-SaaS for serious recreational runners. It provides AI-powered weekly training summaries and race readiness insights, replacing the manual workflow of screenshotting workouts and pasting them to ChatGPT.

## Tech Stack

- **Frontend**: Angular 21 (SSR enabled)
- **Backend**: Supabase (PostgreSQL + Edge Functions)
- **Auth**: Supabase Auth + Strava OAuth
- **LLM**: Claude API (Haiku for classification, Sonnet for summaries)
- **Payments**: Stripe ($5/month subscription)
- **Hosting**: Vercel or Netlify

## Key Files

- `ARCHITECTURE.md` - Full architecture, data model, implementation plan
- `chatgpt-plan.txt` - Original product planning conversation

## Important Context

- This is a **solo side project** targeting $500-2,000 MRR
- Keep features minimal - the product is "judgment, not features"
- AI summaries should sound like a calm, experienced coach
- Do NOT overengineer - simple is better

## Code Style

- Angular 21 standalone components with signals
- TypeScript strict mode
- Supabase client for database queries
- Edge Functions in TypeScript/Deno for server-side logic

## When Making Changes

1. Check `ARCHITECTURE.md` for the intended design
2. Prefer editing existing files over creating new ones
3. Keep the product scope small - resist feature creep
4. AI prompts should be calm and restrained, not excited
